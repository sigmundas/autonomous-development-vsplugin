import * as vscode from 'vscode';
import {
  CONTROLLER_PHASES,
  REASONING_EFFORTS,
  type ControllerPhase,
  type ControllerReasoningEffort
} from '@semanticmatter/core';

import type { ConfigSnapshot, ConfigStore } from '../configStore';
import { friendlyProfileLabel, friendlyRuntimeLabel, reasoningEffortLabel } from '../configStore';
import type { ConfigClient } from '../controller/configClient';
import { ControllerError } from '../controller/controllerService';
import type { OutputLog } from '../output';
import { isWorkspaceTrusted } from '../trust';

/** Messages the webview posts back to the extension host. Validated at boundary. */
type WebviewInbound =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'setPreset'; readonly name: string }
  | { readonly type: 'setClaudeRuntime'; readonly name: string }
  | {
      readonly type: 'setPhase';
      readonly preset: string;
      readonly phase: ControllerPhase;
      readonly profile?: string;
      readonly reasoningEffort?: ControllerReasoningEffort;
    }
  | { readonly type: 'validate' }
  | { readonly type: 'startRun' }
  | { readonly type: 'setupController' };

/** Serialized view sent to the webview. Never carries secrets. */
export interface ConfigView {
  readonly controllerAvailable: boolean;
  readonly error?: string;
  readonly configPath?: string;
  readonly configExists: boolean;
  readonly activePreset?: string;
  readonly workflowMode?: string;
  readonly maxReviewRounds?: number;
  readonly claudeRuntime?: {
    readonly name: string;
    readonly displayName: string;
    readonly launcher?: string;
    readonly launcherExists: boolean;
    readonly launcherExecutable: boolean;
  };
  readonly presets: readonly {
    readonly name: string;
    readonly workflowMode?: string;
    readonly claudeRuntime?: string;
  }[];
  readonly profiles: readonly {
    readonly id: string;
    readonly label: string;
    readonly provider?: string;
    readonly model?: string;
    readonly valid: boolean;
    readonly error?: string;
  }[];
  readonly claudeRuntimes: readonly {
    readonly name: string;
    readonly displayName: string;
    readonly launcher?: string;
    readonly launcherExists: boolean;
    readonly launcherExecutable: boolean;
  }[];
  readonly phases: readonly {
    readonly phase: ControllerPhase;
    readonly title: string;
    readonly profileId?: string;
    readonly profileLabel?: string;
    readonly reasoningEffort?: ControllerReasoningEffort;
    readonly effortLabel?: string;
    readonly profileMissing: boolean;
    readonly profileInvalid: boolean;
  }[];
  readonly reasoningEfforts: readonly { readonly value: string; readonly label: string }[];
  readonly validation?: {
    readonly valid: boolean;
    readonly error?: string;
    readonly warnings: readonly string[];
  };
  readonly warnings: readonly string[];
  readonly trusted: boolean;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function toView(snap: ConfigSnapshot): ConfigView {
  const effective = snap.effective;
  const activePreset = effective?.activePreset ?? snap.presets?.activePreset;
  const runtimeName = effective?.effective.claudeRuntime;
  const runtime = snap.runtimes?.claudeRuntimes.find((r) => r.name === runtimeName);

  const phases = CONTROLLER_PHASES.map((phase) => {
    const conf = effective?.effective.codex[phase];
    const profileId = conf?.profile;
    const profile = snap.profiles?.profiles.find((p) => p.id === profileId);
    const missing = profileId !== undefined && profile === undefined;
    const invalid = profile !== undefined && profile.valid === false;
    return {
      phase,
      title: phaseTitle(phase),
      ...(profileId !== undefined ? { profileId } : {}),
      ...(profile !== undefined ? { profileLabel: friendlyProfileLabel(profile) } : {}),
      ...(conf?.reasoningEffort !== undefined
        ? { reasoningEffort: conf.reasoningEffort, effortLabel: reasoningEffortLabel(conf.reasoningEffort) }
        : {}),
      profileMissing: missing,
      profileInvalid: invalid
    };
  });

  const view: ConfigView = {
    controllerAvailable: snap.controllerAvailable,
    ...(snap.error ? { error: snap.error } : {}),
    ...(effective?.configPath ? { configPath: effective.configPath } : {}),
    configExists: effective?.configExists ?? false,
    ...(activePreset ? { activePreset } : {}),
    ...(effective?.effective.workflow.workflowMode
      ? { workflowMode: effective.effective.workflow.workflowMode }
      : {}),
    ...(effective?.effective.workflow.maxReviewRounds !== undefined
      ? { maxReviewRounds: effective.effective.workflow.maxReviewRounds }
      : {}),
    ...(runtime
      ? {
          claudeRuntime: {
            name: runtime.name,
            displayName: friendlyRuntimeLabel(runtime),
            ...(runtime.launcher ? { launcher: runtime.launcher } : {}),
            launcherExists: runtime.launcherExists,
            launcherExecutable: runtime.launcherExecutable
          }
        }
      : {}),
    presets: (snap.presets?.presets ?? []).map((p) => ({
      name: p.name,
      ...(p.workflowMode ? { workflowMode: p.workflowMode } : {}),
      ...(p.claudeRuntime ? { claudeRuntime: p.claudeRuntime } : {})
    })),
    profiles: (snap.profiles?.profiles ?? []).map((p) => ({
      id: p.id,
      label: friendlyProfileLabel(p),
      ...(p.provider ? { provider: p.provider } : {}),
      ...(p.model ? { model: p.model } : {}),
      valid: p.valid,
      ...(p.error ? { error: p.error } : {})
    })),
    claudeRuntimes: (snap.runtimes?.claudeRuntimes ?? []).map((r) => ({
      name: r.name,
      displayName: friendlyRuntimeLabel(r),
      ...(r.launcher ? { launcher: r.launcher } : {}),
      launcherExists: r.launcherExists,
      launcherExecutable: r.launcherExecutable
    })),
    phases,
    reasoningEfforts: REASONING_EFFORTS.map((value) => ({
      value,
      label: reasoningEffortLabel(value)
    })),
    ...(snap.validation
      ? {
          validation: {
            valid: snap.validation.valid,
            ...(snap.validation.error ? { error: snap.validation.error } : {}),
            warnings: snap.validation.warnings
          }
        }
      : {}),
    warnings: effective?.warnings ?? [],
    trusted: isWorkspaceTrusted()
  };
  return view;
}

function phaseTitle(phase: ControllerPhase): string {
  switch (phase) {
    case 'enhance':
      return 'Enhance';
    case 'plan':
      return 'Planning';
    case 'review':
      return 'Review';
    case 'adversarial':
      return 'Adversarial review';
  }
}

/**
 * The pre-run configuration panel. Renders a lockedown webview showing the
 * active preset, claude runtime, and per-phase Codex profile / reasoning-effort
 * dropdowns. All mutations flow through {@link ConfigClient}; the webview
 * displays no state as saved until the controller confirms.
 */
export class ConfigPanel {
  private static current: ConfigPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly store: ConfigStore,
    private readonly client: ConfigClient,
    private readonly getProjectRoot: () => string | undefined,
    private readonly log: OutputLog
  ) {
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: unknown) => this.onMessage(msg),
      null,
      this.disposables
    );
    this.store.onDidChange(() => this.render(), null, this.disposables);
  }

  static show(
    extensionUri: vscode.Uri,
    store: ConfigStore,
    client: ConfigClient,
    getProjectRoot: () => string | undefined,
    log: OutputLog
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ConfigPanel.current) {
      ConfigPanel.current.panel.reveal(column);
      ConfigPanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'autonomousDev.configuration',
      'Autonomous Development — Configuration',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'configWebview')]
      }
    );
    ConfigPanel.current = new ConfigPanel(panel, extensionUri, store, client, getProjectRoot, log);
    ConfigPanel.current.render();
    void store.refresh();
  }

  private render(): void {
    const view = toView(this.store.current);
    void this.panel.webview.postMessage({ type: 'render', view });
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!isObject(msg) || typeof msg.type !== 'string') {
      return;
    }
    const parsed = msg as WebviewInbound;
    switch (parsed.type) {
      case 'ready':
      case 'refresh':
        await this.store.refresh();
        this.render();
        return;
      case 'setPreset':
        await this.setPreset(parsed.name);
        return;
      case 'setClaudeRuntime':
        await this.setClaudeRuntime(parsed.name);
        return;
      case 'setPhase':
        await this.setPhase(parsed);
        return;
      case 'validate':
        await this.store.refresh();
        this.render();
        return;
      case 'startRun':
        await vscode.commands.executeCommand('autonomousDev.startRun');
        return;
      case 'setupController':
        await vscode.commands.executeCommand('autonomousDev.setupController');
        return;
    }
  }

  private requireProjectRoot(): string | undefined {
    const root = this.getProjectRoot();
    if (!root) {
      void vscode.window.showErrorMessage('Open a folder to change autonomous-development configuration.');
    }
    return root;
  }

  private async setPreset(name: string): Promise<void> {
    if (!isWorkspaceTrusted()) {
      void vscode.window.showErrorMessage('Configuration mutations require a trusted workspace.');
      return;
    }
    const root = this.requireProjectRoot();
    if (!root) return;
    try {
      await this.client.setActivePreset(root, name);
      await this.store.refresh();
      this.render();
    } catch (err) {
      this.reportError('Set active preset', err);
    }
  }

  private async setClaudeRuntime(name: string): Promise<void> {
    if (!isWorkspaceTrusted()) {
      void vscode.window.showErrorMessage('Configuration mutations require a trusted workspace.');
      return;
    }
    const root = this.requireProjectRoot();
    if (!root) return;
    try {
      await this.client.setClaudeRuntime(root, name);
      await this.store.refresh();
      this.render();
      void vscode.window.showInformationMessage(
        'Claude runtime selection applies when launching a new session. It does not change the provider of an already-running Claude Code session.'
      );
    } catch (err) {
      this.reportError('Set Claude runtime', err);
    }
  }

  private async setPhase(msg: {
    preset: string;
    phase: ControllerPhase;
    profile?: string;
    reasoningEffort?: ControllerReasoningEffort;
  }): Promise<void> {
    if (!isWorkspaceTrusted()) {
      void vscode.window.showErrorMessage('Configuration mutations require a trusted workspace.');
      return;
    }
    const root = this.requireProjectRoot();
    if (!root) return;
    if (msg.preset.length === 0) {
      void vscode.window.showErrorMessage('Select an active preset before configuring phases.');
      return;
    }
    try {
      await this.client.setPhase(root, {
        preset: msg.preset,
        phase: msg.phase,
        ...(msg.profile !== undefined ? { profile: msg.profile } : {}),
        ...(msg.reasoningEffort !== undefined ? { reasoningEffort: msg.reasoningEffort } : {})
      });
      await this.store.refresh();
      this.render();
    } catch (err) {
      this.reportError('Set phase', err);
    }
  }

  private reportError(action: string, err: unknown): void {
    const message =
      err instanceof ControllerError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    this.log.error(`${action} failed: ${message}`);
    void this.panel.webview.postMessage({ type: 'error', message });
    void vscode.window.showErrorMessage(`${action} failed: ${message}`);
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'configWebview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'configWebview', 'styles.css')
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
  <title>Autonomous Development — Configuration</title>
</head>
<body>
  <main id="app" aria-live="polite">Loading…</main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    ConfigPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
