import { basename } from 'node:path';

import * as vscode from 'vscode';
import type { ClaudeModel, ClaudeRuntime } from '@semanticmatter/core';

import type { ConfigStore } from '../configStore';
import type { OutputLog } from '../output';
import { isWorkspaceTrusted } from '../trust';
import {
  buildLauncherArgs,
  withAutonomousClaudePermissions,
  withClaudeModel
} from './claudeLauncher';
import { isKnownShellBinary, pluginDirFromControllerPath } from './resumeInClaude';
import type { ClaudeTerminalRegistry } from './claudeTerminalRegistry';

export interface OpenAutonomousClaudeDeps {
  readonly store: ConfigStore;
  readonly log: OutputLog;
  readonly getControllerPath: () => string;
  readonly registry?: ClaudeTerminalRegistry;
  /** Repository evidence captured immediately before Start launches. */
  readonly unboundRepository?: {
    readonly repositoryId: string;
    /** Sampled immediately before terminal creation, after config refresh. */
    readonly getKnownRunIds: () => readonly string[];
  };
  readonly createTerminal?: (options: vscode.TerminalOptions) => vscode.Terminal;
  readonly showInfo?: (message: string) => Thenable<string | undefined>;
  readonly showError?: (message: string) => Thenable<string | undefined>;
}

export type NewRunMode = 'feature' | 'current' | 'main';

export interface NewRunBootstrap {
  readonly mode: NewRunMode;
  readonly feature: string;
}

const START_SKILL_BY_MODE: Readonly<Record<NewRunMode, string>> = {
  feature: '/autonomous-development:autonomous-feature',
  current: '/autonomous-development:autonomous-current',
  main: '/autonomous-development:autonomous-main'
};

export function newRunBootstrapPrompt(bootstrap: NewRunBootstrap): string {
  const feature = bootstrap.feature.trim();
  if (!feature) {
    throw new Error('A feature description is required to start an autonomous run.');
  }
  return `${START_SKILL_BY_MODE[bootstrap.mode]} ${feature}`;
}

export interface OpenAutonomousClaudePlan {
  readonly runtime: ClaudeRuntime;
  readonly model?: ClaudeModel;
  readonly cwd: string;
  readonly pluginDir?: string;
  readonly launcherArgv: readonly string[];
  readonly terminalName: string;
}

export const AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX = 'Autonomous Claude';
export const AUTONOMOUS_CLAUDE_TERMINAL_ENV_MARKER = 'AUTODEV_CLAUDE_TERMINAL';

export function autonomousClaudeTerminalName(cwd: string | undefined): string {
  const base = cwd ? basename(cwd).trim() : '';
  if (base.length === 0) return AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX;
  return `${AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX} — ${base}`;
}

export function planOpenAutonomousClaude(
  runtime: ClaudeRuntime,
  cwd: string,
  controllerPath: string,
  bootstrap?: NewRunBootstrap,
  model?: ClaudeModel
): OpenAutonomousClaudePlan {
  const pluginDir = pluginDirFromControllerPath(controllerPath);
  const launcherArgv = withAutonomousClaudePermissions(
    withClaudeModel(buildLauncherArgs(runtime), model)
  );
  if (pluginDir) {
    launcherArgv.push('--plugin-dir', pluginDir);
  }
  if (bootstrap) {
    // Claude accepts a positional prompt while remaining interactive. This
    // invokes the existing skill, which continues to own controller init.
    launcherArgv.push(newRunBootstrapPrompt(bootstrap));
  }
  return {
    runtime,
    ...(model !== undefined ? { model } : {}),
    cwd,
    ...(pluginDir !== undefined ? { pluginDir } : {}),
    launcherArgv,
    terminalName: autonomousClaudeTerminalName(cwd)
  };
}

export function buildOpenAutonomousClaudeTerminalOptions(
  plan: OpenAutonomousClaudePlan
): vscode.TerminalOptions {
  const [shellPath, ...shellArgs] = plan.launcherArgv;
  if (isKnownShellBinary(shellPath)) {
    throw new Error(
      `Refusing to launch Claude via a known shell binary (${shellPath}). ` +
        `The runtime launcher must be a non-shell process so Python auto-activation ` +
        `cannot inject "source .../activate" into Claude's input.`
    );
  }
  const env: Record<string, string> = {
    [AUTONOMOUS_CLAUDE_TERMINAL_ENV_MARKER]: '1'
  };
  return {
    name: plan.terminalName,
    cwd: plan.cwd,
    hideFromUser: true,
    ...(shellPath !== undefined ? { shellPath } : {}),
    shellArgs,
    env
  };
}

export async function openAutonomousClaudeInWorkspace(
  cwd: string,
  deps: OpenAutonomousClaudeDeps,
  bootstrap?: NewRunBootstrap
): Promise<OpenAutonomousClaudePlan | undefined> {
  const showError = deps.showError ?? ((msg: string) => vscode.window.showErrorMessage(msg));
  const showInfo = deps.showInfo ?? ((msg: string) => vscode.window.showInformationMessage(msg));

  if (!isWorkspaceTrusted()) {
    void showError('Opening Autonomous Claude requires a trusted workspace.');
    return undefined;
  }
  if (!cwd || cwd.length === 0) {
    void showError('Open a folder before opening Autonomous Claude.');
    return undefined;
  }

  await deps.store.refresh();
  const snap = deps.store.current;
  if (!snap.controllerAvailable) {
    void showError('No controller is configured; the Claude runtime selection cannot be resolved.');
    return undefined;
  }
  const runtimeName = snap.effective?.effective.claudeRuntime;
  if (!runtimeName) {
    void showError(
      'No Claude runtime is selected. Choose one from "Autonomous Development: Configure Claude Runtime".'
    );
    return undefined;
  }
  const runtime = snap.runtimes?.claudeRuntimes.find((r) => r.name === runtimeName);
  if (!runtime) {
    void showError(
      `The selected Claude runtime "${runtimeName}" is no longer defined in the configuration.`
    );
    return undefined;
  }
  if (!runtime.launcher || runtime.launcher.length === 0) {
    void showError(`Claude runtime "${runtimeName}" does not define a launcher path.`);
    return undefined;
  }
  if (!runtime.launcherExists) {
    void showError(`Claude runtime launcher is missing: ${runtime.launcher}`);
    return undefined;
  }
  if (!runtime.launcherExecutable) {
    void showError(`Claude runtime launcher is not executable: ${runtime.launcher}`);
    return undefined;
  }

  const model = snap.effective?.effective.claudeModel;
  const plan = planOpenAutonomousClaude(runtime, cwd, deps.getControllerPath(), bootstrap, model);
  deps.log.info(
    `openAutonomousClaude cwd=${cwd} runtime=${runtime.name} model=${model?.id ?? 'default'} launcher=${runtime.launcher}`
  );

  const create =
    deps.createTerminal ??
    ((options: vscode.TerminalOptions) => vscode.window.createTerminal(options));
  const unboundRegistration =
    deps.registry && deps.unboundRepository
      ? {
          repositoryId: deps.unboundRepository.repositoryId,
          knownRunIds: deps.unboundRepository.getKnownRunIds()
        }
      : undefined;
  const terminal = create(buildOpenAutonomousClaudeTerminalOptions(plan));
  if (deps.registry && unboundRegistration) {
    deps.registry.registerUnbound({
      terminal,
      repositoryId: unboundRegistration.repositoryId,
      knownRunIds: unboundRegistration.knownRunIds
    });
  }
  terminal.show();

  void showInfo(
    bootstrap
      ? `Starting a new ${bootstrap.mode} run with ${runtime.displayName ?? runtime.name} in ${cwd}. The selected autonomous workflow was submitted automatically.`
      : `Autonomous Claude is ready with ${runtime.displayName ?? runtime.name} in ${cwd}. ` +
          'Invoke one skill to initialize the run: /autonomous-development:autonomous-feature, ' +
          '/autonomous-development:autonomous-current, or /autonomous-development:autonomous-main.'
  );
  return plan;
}
