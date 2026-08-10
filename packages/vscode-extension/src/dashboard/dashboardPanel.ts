import { basename, join } from 'node:path';

import * as vscode from 'vscode';
import { confineToDirectory, loadEventLog, type DiscoveredRun } from '@semanticmatter/core';

import type { ClaudeTerminalRegistry } from '../config/claudeTerminalRegistry';
import { terminalIdentityForRun } from '../config/claudeTerminalIdentity';
import type { ExtensionConfig } from '../config';
import type { OutputLog } from '../output';
import type { RunStore } from '../runStore';
import { runKey } from '../runStore';
import type { RunNode } from '../tree/runTreeItem';
import { openFileAtLine } from './openLocation';
import { toDashboardView } from './renderModel';
import { reconcileTimeline } from './timelineRetention';
import type { DashboardView, WebviewMessage } from './viewTypes';

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Owns the single reused dashboard webview. Re-rendering on store changes keeps
 * the panel live without recreating it. The webview is locked down: a strict CSP
 * with a per-load nonce, resources restricted to dist/webview, and no network or
 * inline script. It never receives raw credentials — only the serialized view.
 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private currentRunKey: string | undefined;
  /** Last rendered view per run key — source of the retained event timeline. */
  private readonly lastViewByKey = new Map<string, DashboardView>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly store: RunStore,
    private readonly getConfig: () => ExtensionConfig,
    private readonly log: OutputLog,
    private readonly terminalRegistry: ClaudeTerminalRegistry
  ) {
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.onMessage(msg),
      null,
      this.disposables
    );
    // Live updates: when discovery refreshes, re-render the selected run.
    this.store.onDidChange(() => this.render(), null, this.disposables);
    // Also re-render when a Claude terminal opens/closes for the current run
    // so the header button switches between "Resume in Claude" and
    // "Focus Claude terminal" without waiting for a store poll.
    this.terminalRegistry.onDidChange(
      (identity) => {
        const run = this.currentRun();
        if (
          run &&
          run.repoId === identity.repositoryId &&
          run.runId === identity.runId
        ) {
          this.render();
        }
      },
      null,
      this.disposables
    );
  }

  static show(
    extensionUri: vscode.Uri,
    store: RunStore,
    getConfig: () => ExtensionConfig,
    log: OutputLog,
    run: DiscoveredRun,
    terminalRegistry: ClaudeTerminalRegistry
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      DashboardPanel.current.setRun(run);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'autonomousDev.dashboard',
      'Autonomous Development',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]
      }
    );
    DashboardPanel.current = new DashboardPanel(
      panel,
      extensionUri,
      store,
      getConfig,
      log,
      terminalRegistry
    );
    DashboardPanel.current.setRun(run);
  }

  private setRun(run: DiscoveredRun): void {
    this.currentRunKey = runKey(run);
    this.store.select(run);
    this.panel.title = `Autonomous Development — ${run.runId}`;
    this.render();
  }

  private currentRun(): DiscoveredRun | undefined {
    return this.currentRunKey ? this.store.getByKey(this.currentRunKey) : undefined;
  }

  private render(): void {
    const run = this.currentRun();
    if (!run) {
      return;
    }
    const key = this.currentRunKey;
    const eventLog = loadEventLog(run.runDir, { maxEntries: this.getConfig().maxEventLogEntries });
    const continuation = this.store.allRuns.find(
      (candidate) =>
        candidate.repoId === run.repoId && candidate.state?.parentRunId === run.runId
    );
    const view = reconcileTimeline(
      key ? this.lastViewByKey.get(key) : undefined,
      toDashboardView(run, eventLog, {
        claudeTerminalOpen: this.terminalRegistry.has(terminalIdentityForRun(run)),
        ...(continuation ? { continuedByRunId: continuation.runId } : {})
      })
    );
    if (key) {
      this.lastViewByKey.set(key, view);
    }
    void this.panel.webview.postMessage({ type: 'render', view });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    const run = this.currentRun();
    switch (msg.type) {
      case 'ready':
        this.render();
        return;
      case 'command':
        if (run) {
          const node: RunNode = { kind: 'run', run };
          await vscode.commands.executeCommand(msg.command, node);
        }
        return;
      case 'openFinding':
        if (run) {
          await this.openFinding(run, msg.file, msg.line ?? undefined);
        }
        return;
      case 'openVerificationLog':
        if (run) {
          await this.openLog(run, msg.log);
        }
        return;
      case 'openRunFile':
        if (run) {
          await this.openRunFile(run, msg.file);
        }
        return;
    }
  }

  private resolveUnderRun(run: DiscoveredRun, file: string): vscode.Uri | undefined {
    if (file.length === 0) {
      return undefined;
    }
    const worktree = run.state?.repository.worktreePath;
    const bases = [worktree, run.runDir].filter((b): b is string => Boolean(b));
    for (const base of bases) {
      const resolved = confineToDirectory(base, file);
      if (resolved.path) {
        return vscode.Uri.file(resolved.path);
      }
    }
    this.log.warn(`Refused to open path outside the run/worktree: ${file}`);
    return undefined;
  }

  private async openFinding(run: DiscoveredRun, file: string, line?: number): Promise<void> {
    const uri = this.resolveUnderRun(run, file);
    if (!uri) {
      return;
    }
    try {
      await openFileAtLine(uri, line);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`openFinding failed for ${file}: ${message}`);
      void vscode.window.showWarningMessage(`Could not open ${file}: ${message}`);
    }
  }

  /** Open a read-only run-dir file (e.g. legacy triage-NN.md). Basename only. */
  private async openRunFile(run: DiscoveredRun, file: string): Promise<void> {
    if (file.length === 0 || file !== basename(file)) {
      this.log.warn(`Ignored openRunFile with non-basename path: ${file}`);
      return;
    }
    const uri = vscode.Uri.file(join(run.runDir, file));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`openRunFile failed for ${file}: ${message}`);
      void vscode.window.showWarningMessage(`Could not open ${file}: ${message}`);
    }
  }

  private async openLog(run: DiscoveredRun, log: string): Promise<void> {
    const uri = this.resolveUnderRun(run, log);
    if (!uri) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`openLog failed for ${log}: ${message}`);
      void vscode.window.showWarningMessage(`Could not open log ${log}: ${message}`);
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'styles.css')
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Autonomous Development</title>
</head>
<body>
  <main id="app" aria-live="polite">Loading…</main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
