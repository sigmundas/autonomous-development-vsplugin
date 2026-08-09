import * as vscode from 'vscode';
import type { DiscoveredRun } from '@semanticmatter/core';

import type { ExtensionConfig } from '../config';
import { ControllerService } from '../controller/controllerService';
import { DashboardPanel } from '../dashboard/dashboardPanel';
import type { OutputLog } from '../output';
import type { RunStore } from '../runStore';
import { runGuidedSetup } from '../setup';
import type { DetailNode, RunNode } from '../tree/runTreeItem';
import * as artifacts from './openArtifacts';
import * as controller from './controllerCommands';
import * as configCmds from '../config/configCommands';
import type { ConfigCommandDeps } from '../config/configCommands';
import {
  openAutonomousClaudeInWorkspace,
  type NewRunBootstrap,
  type NewRunMode
} from '../config/openAutonomousClaude';
import { resumeRunInClaude } from '../config/resumeInClaude';
import type { ClaudeTerminalRegistry } from '../config/claudeTerminalRegistry';
import { terminalIdentityForRun } from '../config/claudeTerminalIdentity';
import type { ConfigStore } from '../configStore';
import { resolveWorkspaceRepoId } from '../workspaceRepoId';

export interface CommandDeps {
  readonly context: vscode.ExtensionContext;
  readonly store: RunStore;
  readonly service: ControllerService;
  readonly log: OutputLog;
  readonly getConfig: () => ExtensionConfig;
  readonly getStateHome: () => string;
  readonly refresh: () => void;
  readonly configStore: ConfigStore;
  readonly configDeps: ConfigCommandDeps;
  readonly terminalRegistry: ClaudeTerminalRegistry;
}

type CommandArg = RunNode | DetailNode | DiscoveredRun | undefined;

export const NEW_AUTONOMOUS_SESSION_COMMAND_IDS = [
  'autonomousDev.startRun',
  'autonomousDev.openAutonomousClaude',
  'autonomousDev.launchClaude'
] as const;

export function createStartRunCommandHandler(deps: {
  readonly resolveProjectRoot: () => Promise<string | undefined>;
  readonly selectRunMode: () => Promise<NewRunMode | undefined>;
  readonly promptFeature: () => Promise<string | undefined>;
  readonly openAutonomousClaude: (
    projectRoot: string,
    bootstrap: NewRunBootstrap
  ) => Promise<unknown>;
}): () => Promise<void> {
  return async () => {
    const projectRoot = await deps.resolveProjectRoot();
    if (!projectRoot) {
      return;
    }
    const mode = await deps.selectRunMode();
    if (!mode) return;
    const feature = (await deps.promptFeature())?.trim();
    if (!feature) return;
    await deps.openAutonomousClaude(projectRoot, { mode, feature });
  };
}

async function selectRunMode(): Promise<NewRunMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'Feature branch / isolated worktree',
        description: 'Recommended',
        detail: 'Use autonomous-feature and keep changes isolated from the current checkout.',
        mode: 'feature' as const
      },
      {
        label: 'Current branch',
        detail: 'Use autonomous-current in the clean branch currently checked out.',
        mode: 'current' as const
      },
      {
        label: 'Main',
        detail: 'Use autonomous-main in the clean main or master checkout.',
        mode: 'main' as const
      }
    ],
    {
      title: 'Start new autonomous run',
      placeHolder: 'Choose where Claude should implement the feature'
    }
  );
  return picked?.mode;
}

async function promptFeature(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Start new autonomous run',
    prompt: 'Describe the feature or change for Claude to implement',
    placeHolder: 'Feature idea',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length > 0 ? undefined : 'Enter a feature description.')
  });
}

function isRun(value: unknown): value is DiscoveredRun {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runId' in value &&
    'runDir' in value &&
    'group' in value
  );
}

/** Pick a run from a QuickPick (palette fallback when no contextual target). */
async function pickRun(store: RunStore): Promise<DiscoveredRun | undefined> {
  const runs = store.allRuns;
  if (runs.length === 0) {
    void vscode.window.showInformationMessage('No autonomous-development runs were found.');
    return undefined;
  }
  const items = runs.map((run) => ({
    label: run.runId,
    description: run.model?.status ?? run.state?.status ?? 'unknown',
    detail: (run.state?.feature.split('\n')[0] ?? '').slice(0, 100),
    run
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select a run',
    matchOnDescription: true
  });
  return picked?.run;
}

/** Resolve the repository a new run should be created in (FR: scope to workspace). */
async function resolveProjectRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage(
      'Open a folder (a git repository) before starting an autonomous-development run.'
    );
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0]?.uri.fsPath;
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      path: folder.uri.fsPath
    })),
    { title: 'Select the repository to start a run in' }
  );
  return picked?.path;
}

async function resolveTarget(store: RunStore, arg: CommandArg): Promise<DiscoveredRun | undefined> {
  if (arg) {
    if (isRun(arg)) {
      return arg;
    }
    if (arg.kind === 'run' || arg.kind === 'detail') {
      return arg.run;
    }
  }
  return store.selectedRun ?? (await pickRun(store));
}

export function registerCommands(deps: CommandDeps): void {
  const { context, store, service, log } = deps;
  const controllerDeps: controller.ControllerCommandDeps = {
    service,
    getConfig: deps.getConfig,
    refresh: deps.refresh
  };

  /** Wrap a run-scoped artifact handler with target resolution + error reporting. */
  const runScoped =
    (handler: (run: DiscoveredRun) => Promise<void> | void) =>
    async (arg: CommandArg): Promise<void> => {
      const run = await resolveTarget(store, arg);
      if (!run) {
        return;
      }
      try {
        await handler(run);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`command failed: ${message}`);
        void vscode.window.showErrorMessage(message);
      }
    };

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler as (...args: unknown[]) => unknown)
    );
  };

  register(
    'autonomousDev.openDashboard',
    runScoped((run) => {
      DashboardPanel.show(
        context.extensionUri,
        store,
        deps.getConfig,
        log,
        run,
        deps.terminalRegistry
      );
    })
  );
  register('autonomousDev.refreshRuns', () => deps.refresh());
  const startRun = createStartRunCommandHandler({
    resolveProjectRoot,
    selectRunMode,
    promptFeature,
    openAutonomousClaude: (projectRoot, bootstrap) => {
      const repositoryId = resolveWorkspaceRepoId(projectRoot);
      return openAutonomousClaudeInWorkspace(
        projectRoot,
        {
          store: deps.configStore,
          log,
          getControllerPath: () => deps.getConfig().controllerPath,
          registry: deps.terminalRegistry,
          ...(repositoryId
            ? {
                unboundRepository: {
                  repositoryId,
                  getKnownRunIds: () => {
                    // Sample immediately before terminal creation. The skill-owned
                    // run can only be created after the terminal is shown.
                    deps.refresh();
                    return store.allRuns
                      .filter((run) => run.repoId === repositoryId)
                      .map((run) => run.runId);
                  }
                }
              }
            : {})
        },
        bootstrap
      );
    }
  });
  for (const id of NEW_AUTONOMOUS_SESSION_COMMAND_IDS) {
    register(id, startRun);
  }

  register('autonomousDev.openOriginalFeature', runScoped(artifacts.openOriginalFeature));
  register('autonomousDev.openEnhancedSpec', runScoped(artifacts.openEnhancedSpec));
  register('autonomousDev.openAcceptedSpec', runScoped(artifacts.openAcceptedSpec));
  register('autonomousDev.openProposedPlan', runScoped(artifacts.openProposedPlan));
  register('autonomousDev.openAcceptedPlan', runScoped(artifacts.openAcceptedPlan));
  register('autonomousDev.openLatestReview', runScoped(artifacts.openLatestReview));
  register('autonomousDev.openVerificationLog', runScoped(artifacts.openVerificationLog));
  register('autonomousDev.compareSpec', runScoped(artifacts.compareSpec));
  register('autonomousDev.comparePlan', runScoped(artifacts.comparePlan));
  register('autonomousDev.revealRunDirectory', runScoped(artifacts.revealRunDirectory));

  register(
    'autonomousDev.evaluateGates',
    runScoped((run) => controller.evaluateGates(run, controllerDeps))
  );
  register(
    'autonomousDev.acceptDrift',
    runScoped((run) => controller.acceptDrift(run, controllerDeps))
  );
  register(
    'autonomousDev.cancelRun',
    runScoped((run) => controller.cancelRun(run, controllerDeps))
  );
  register(
    'autonomousDev.archiveRun',
    runScoped((run) => controller.archiveRun(run, controllerDeps))
  );
  register(
    'autonomousDev.authorizeReview',
    runScoped((run) => controller.authorizeReview(run, controllerDeps))
  );
  register(
    'autonomousDev.continueBlockedRun',
    runScoped((run) => controller.continueBlockedRun(run, controllerDeps))
  );

  register('autonomousDev.setupController', () =>
    runGuidedSetup({
      service,
      getConfig: deps.getConfig,
      getStateHome: deps.getStateHome,
      log,
      refresh: deps.refresh
    })
  );

  // Pre-run configuration commands.
  register('autonomousDev.configure', () => configCmds.openConfigPanel(deps.configDeps));
  register('autonomousDev.selectPreset', () => configCmds.selectPreset(deps.configDeps));
  register('autonomousDev.configurePlanningAgent', () =>
    configCmds.configurePlanningAgent(deps.configDeps)
  );
  register('autonomousDev.configureReviewAgent', () =>
    configCmds.configureReviewAgent(deps.configDeps)
  );
  register('autonomousDev.configureAdversarialReviewer', () =>
    configCmds.configureAdversarialReviewer(deps.configDeps)
  );
  register('autonomousDev.configureClaudeRuntime', () =>
    configCmds.configureClaudeRuntime(deps.configDeps)
  );
  register('autonomousDev.showEffectiveConfiguration', () =>
    configCmds.showEffectiveConfiguration(deps.configDeps)
  );
  register('autonomousDev.validateConfiguration', () =>
    configCmds.validateConfiguration(deps.configDeps)
  );
  register('autonomousDev.refreshConfiguration', async () => {
    try {
      await deps.configStore.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Refresh configuration failed: ${message}`);
    }
  });
  register(
    'autonomousDev.resumeInClaude',
    runScoped(async (run) => {
      await resumeRunInClaude(run, {
        store: deps.configStore,
        log,
        registry: deps.terminalRegistry,
        getControllerPath: () => deps.getConfig().controllerPath
      });
    })
  );
  register(
    'autonomousDev.focusClaudeTerminal',
    runScoped((run) => {
      if (!deps.terminalRegistry.focus(terminalIdentityForRun(run))) {
        void vscode.window.showInformationMessage(
          `No active Claude terminal is being tracked for run ${run.runId}.`
        );
      }
    })
  );
}
