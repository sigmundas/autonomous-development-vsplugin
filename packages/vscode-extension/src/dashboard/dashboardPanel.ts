import { statSync } from 'node:fs';
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve repository source exclusively against the run's recorded worktree. */
export function resolveFindingSource(run: DiscoveredRun, file: string): string | undefined {
  const worktree = run.state?.repository.worktreePath ?? run.state?.repository.canonicalRoot;
  if (!worktree || file.length === 0) return undefined;
  return confineToDirectory(worktree, file).path;
}

/** Resolve controller-owned artifacts exclusively against the durable run directory. */
export function resolveRunArtifact(run: DiscoveredRun, file: string): string | undefined {
  if (file.length === 0) return undefined;
  return confineToDirectory(run.runDir, file).path;
}

export interface VerificationLogOpenDeps {
  readonly openTextDocument: (uri: vscode.Uri) => Thenable<vscode.TextDocument>;
  readonly showTextDocument: (document: vscode.TextDocument) => Thenable<unknown>;
  readonly showWarning: (message: string) => void;
  readonly warn: (message: string) => void;
}

/** Open one recorded verification log without consulting the repository worktree. */
export async function openVerificationCheckLog(
  run: DiscoveredRun,
  log: string,
  deps: VerificationLogOpenDeps
): Promise<boolean> {
  const path = resolveRunArtifact(run, log);
  if (!path) {
    const message = `Refused verification log path outside the run directory: ${log}`;
    deps.warn(message);
    deps.showWarning(`Could not open log ${log}: path is outside the run directory.`);
    return false;
  }
  if (!isFile(path)) {
    const message = `Verification log is not present at its recorded run path: ${log}`;
    deps.warn(message);
    deps.showWarning(`Could not open log ${log}: file is not present for this run.`);
    return false;
  }
  try {
    const doc = await deps.openTextDocument(vscode.Uri.file(path));
    await deps.showTextDocument(doc);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.warn(`openLog failed for ${log}: ${message}`);
    deps.showWarning(`Could not open log ${log}: ${message}`);
    return false;
  }
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
        if (run && run.repoId === identity.repositoryId && run.runId === identity.runId) {
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
      (candidate) => candidate.repoId === run.repoId && candidate.state?.parentRunId === run.runId
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

  private async openFinding(run: DiscoveredRun, file: string, line?: number): Promise<void> {
    const path = resolveFindingSource(run, file);
    if (!path) {
      this.log.warn(`Refused finding path outside the worktree: ${file}`);
      return;
    }
    try {
      await openFileAtLine(vscode.Uri.file(path), line);
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
    await openVerificationCheckLog(run, log, {
      openTextDocument: (uri) => vscode.workspace.openTextDocument(uri),
      showTextDocument: (document) => vscode.window.showTextDocument(document),
      showWarning: (message) => void vscode.window.showWarningMessage(message),
      warn: (message) => this.log.warn(message)
    });
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
