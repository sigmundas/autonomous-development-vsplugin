import * as vscode from 'vscode';
import type { DiscoveredRun, RunGroup } from '@semanticmatter/core';

import { registerCommands } from './commands';
import { CONFIG_SECTION, readConfig, type ExtensionConfig } from './config';
import { ClaudeTerminalRegistry } from './config/claudeTerminalRegistry';
import { ConfigStore } from './configStore';
import { ConfigClient } from './controller/configClient';
import { ControllerService } from './controller/controllerService';
import { RunNotifier } from './notifications';
import { OutputLog } from './output';
import { RunStore } from './runStore';
import { RunStatusBar } from './statusBar';
import { ConfigTreeProvider, type ConfigTreeNode } from './tree/configTreeProvider';
import { RunTreeProvider } from './tree/runTreeProvider';
import type { RunNode, TreeNode } from './tree/runTreeItem';
import { registerTrustContext } from './trust';
import { StateWatcher } from './watcher';
import type { ConfigCommandDeps } from './config/configCommands';

/**
 * Read-only surface returned from {@link activate} so integration tests can
 * observe discovery and grouping without reaching into private internals. Not
 * part of any public contributed API.
 */
export interface AutonomousDevApi {
  readonly getRuns: () => readonly DiscoveredRun[];
  readonly getRunsForGroup: (group: RunGroup) => readonly DiscoveredRun[];
  readonly getStateHome: () => string;
  readonly refresh: () => void;
  readonly getConfigStore: () => ConfigStore;
  readonly refreshConfig: () => Promise<void>;
}

function resolveProjectRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): AutonomousDevApi {
  let config: ExtensionConfig = readConfig();
  const getConfig = (): ExtensionConfig => config;

  const log = new OutputLog();
  context.subscriptions.push(log);
  log.info('Autonomous Development extension activated.');

  registerTrustContext(context);

  const store = new RunStore(config, log);
  context.subscriptions.push(store);

  const service = new ControllerService(getConfig, () => store.activeStateHome, log);
  const configClient = new ConfigClient(service);
  const configStore = new ConfigStore(configClient, resolveProjectRoot, log);
  context.subscriptions.push(configStore);
  const terminalRegistry = new ClaudeTerminalRegistry();
  context.subscriptions.push(terminalRegistry);
  // Run discovery is the first point where a Start terminal's skill-owned run
  // id exists. Reconcile against the launch-time repository baseline before
  // dashboards and commands consume registry truth.
  store.onDidChange(
    () =>
      terminalRegistry.reconcileRuns(
        store.allRuns.map((run) => ({
          repositoryId: run.repoId,
          runId: run.runId,
          active: run.group === 'active'
        }))
      ),
    null,
    context.subscriptions
  );
  // Rebuild registry state from currently open terminals BEFORE any command
  // that might spawn a duplicate. This keeps "Focus Claude terminal"
  // available after a window reload for pre-existing extension-owned
  // terminals.
  const recovered = terminalRegistry.recoverExistingTerminals();
  if (recovered.length > 0) {
    log.info(`Recovered ${recovered.length} Claude terminal(s) after activation.`);
  }

  const configDeps: ConfigCommandDeps = {
    context,
    store: configStore,
    client: configClient,
    log,
    getProjectRoot: resolveProjectRoot
  };

  const statusBar = new RunStatusBar(store);
  const notifier = new RunNotifier(store, getConfig);
  context.subscriptions.push(statusBar, notifier);

  // Three tree views over the one store.
  const activeProvider = new RunTreeProvider(store, 'active');
  const completedProvider = new RunTreeProvider(store, 'completed');
  const archivedProvider = new RunTreeProvider(store, 'archived');
  const configProvider = new ConfigTreeProvider(configStore);
  context.subscriptions.push(activeProvider, completedProvider, archivedProvider);

  const wireRunView = (id: string, provider: RunTreeProvider): void => {
    const view = vscode.window.createTreeView<TreeNode>(id, {
      treeDataProvider: provider,
      showCollapseAll: true
    });
    view.onDidChangeSelection((e) => {
      const node = e.selection[0];
      if (node && node.kind === 'run') {
        store.select((node as RunNode).run);
      }
    });
    context.subscriptions.push(view);
  };
  wireRunView('autonomousDev.activeRuns', activeProvider);
  wireRunView('autonomousDev.completedRuns', completedProvider);
  wireRunView('autonomousDev.archivedRuns', archivedProvider);

  const configView = vscode.window.createTreeView<ConfigTreeNode>('autonomousDev.configuration', {
    treeDataProvider: configProvider,
    showCollapseAll: false
  });
  context.subscriptions.push(configView);

  store.onDidChange(
    () => {
      activeProvider.refresh();
      completedProvider.refresh();
      archivedProvider.refresh();
    },
    null,
    context.subscriptions
  );

  registerCommands({
    context,
    store,
    service,
    log,
    getConfig,
    getStateHome: () => store.activeStateHome,
    refresh: () => store.refresh(),
    configStore,
    configDeps,
    terminalRegistry
  });

  // File watching → debounced refresh (respecting the autoRefresh setting).
  const watcher = new StateWatcher();
  context.subscriptions.push(watcher);
  watcher.reconfigure(store.activeStateHome);
  watcher.onDidChange(
    () => {
      if (getConfig().autoRefresh) {
        store.refresh();
      }
    },
    null,
    context.subscriptions
  );

  // React to configuration changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      config = readConfig();
      store.updateConfig(config);
      notifier.updateConfig(getConfig);
      watcher.reconfigure(store.activeStateHome);
      store.refresh();
      void configStore.refresh();
    })
  );

  // React to workspace folder changes (legacy run detection + legacy watchers).
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watcher.reconfigure(store.activeStateHome);
      store.refresh();
      void configStore.refresh();
    })
  );

  // Initial population.
  store.refresh();
  // Kick off a config load in the background so the tree renders as soon as
  // the controller responds. Errors surface via the store's cached error field.
  void configStore.refresh().catch((err) => {
    log.warn(
      `initial config refresh failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });

  return {
    getRuns: () => store.allRuns,
    getRunsForGroup: (group) => store.runsForGroup(group),
    getStateHome: () => store.activeStateHome,
    refresh: () => store.refresh(),
    getConfigStore: () => configStore,
    refreshConfig: async () => {
      await configStore.refresh();
    }
  };
}

export function deactivate(): void {
  // All disposables are registered on the extension context.
}
