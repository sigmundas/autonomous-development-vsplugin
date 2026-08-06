import * as path from 'node:path';

import * as vscode from 'vscode';
import type { DiscoveredRun } from '@semanticmatter/core';

import type { ConfigStore } from '../configStore';
import type { ExtensionConfig } from '../config';
import {
  buildPreflightSummary,
  formatPreflight,
  type ConfigCommandDeps
} from '../config/configCommands';
import { ControllerError, type ControllerService } from '../controller/controllerService';
import { isWorkspaceTrusted } from '../trust';

export interface ControllerCommandDeps {
  readonly service: ControllerService;
  readonly getConfig: () => ExtensionConfig;
  readonly refresh: () => void;
  readonly configStore?: ConfigStore;
  readonly configDeps?: ConfigCommandDeps;
}

async function ensureConfigured(service: ControllerService): Promise<boolean> {
  if (service.isConfigured()) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    'No controller is configured. Controller actions are unavailable in observer-only mode.',
    'Set Up Controller'
  );
  if (choice === 'Set Up Controller') {
    await vscode.commands.executeCommand('autonomousDev.setupController');
  }
  return false;
}

function reportError(err: unknown): void {
  const message =
    err instanceof ControllerError ? err.message : err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(message);
}

async function runWithProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    task
  );
}

/** POSIX single-quote a value so it is inert when typed into a shell. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Derive the installed plugin root from the configured controller path. The
 * controller always lives at `<plugin-root>/scripts/controller.py`, so the
 * plugin root is two directories up. Returns undefined when the path doesn't
 * match that shape (we then launch without `--plugin-dir` and rely on a
 * globally installed plugin).
 */
function pluginDirFromControllerPath(controllerPath: string): string | undefined {
  if (controllerPath.length === 0) {
    return undefined;
  }
  const scriptsDir = path.dirname(controllerPath);
  if (path.basename(scriptsDir) !== 'scripts') {
    return undefined;
  }
  return path.dirname(scriptsDir);
}

/**
 * Extract the `run_id` printed by `controller.py init`. The controller prints
 * a human-readable line containing the id (see docs/REFERENCE.md); we accept
 * any UTC-timestamp-shaped run id.
 */
export function parseInitRunId(stdout: string): string | undefined {
  const match = stdout.match(/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6,}/);
  return match ? match[0] : undefined;
}

/**
 * Start a new autonomous-development run.
 *
 * When a controller is configured, the extension calls `controller.py init`
 * directly with the selected preset threaded as a separate `--preset <name>`
 * argv element (never embedded in the feature text) so the run's
 * `config_snapshot` is pinned deterministically. Then Claude Code is opened
 * in an integrated terminal in the resulting worktree so the user can drive
 * the initialized run.
 *
 * If no controller is configured, we fall back to the legacy
 * skill-driven-init flow (no preset can be forwarded in that case, since the
 * skill contract takes `$ARGUMENTS` as raw feature text).
 */
export async function startRun(projectRoot: string, deps: ControllerCommandDeps): Promise<void> {
  if (!isWorkspaceTrusted()) {
    void vscode.window.showErrorMessage(
      'Starting an autonomous-development run requires a trusted workspace.'
    );
    return;
  }

  // Preflight: show the effective preset/phase/runtime resolution before init.
  let presetName: string | undefined;
  if (deps.configStore && deps.service.isConfigured()) {
    try {
      await deps.configStore.refresh();
    } catch {
      // Non-fatal: fall through to the legacy prompt.
    }
    const snap = deps.configStore.current;
    if (snap.controllerAvailable && snap.effective) {
      const preflight = buildPreflightSummary(snap.effective, snap.profiles?.profiles);
      const summary = formatPreflight(preflight);
      const choice = await vscode.window.showInformationMessage(
        `Start an autonomous-development run with:\n\n${summary}`,
        { modal: true },
        'Start',
        'Configure'
      );
      if (choice === undefined) return;
      if (choice === 'Configure') {
        await vscode.commands.executeCommand('autonomousDev.configure');
        return;
      }
      presetName = preflight.activePreset;
    }
  }

  const feature = await vscode.window.showInputBox({
    title: 'Start Autonomous Development Run',
    prompt: 'Describe the feature to implement',
    placeHolder: 'e.g. Add CSV export to the report page',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? 'A feature description is required.' : undefined
  });
  if (feature === undefined || feature.trim().length === 0) {
    return;
  }

  const controllerPath = deps.getConfig().controllerPath;

  // Deterministic path: extension calls controller.py init --preset <name>
  // --feature <text> directly. Preset is a separate argv element (verified by
  // buildControllerCommand's tests) so it can never be embedded in the feature
  // text, and the resulting `feature-request.md` contains only the actual
  // feature description.
  if (deps.service.isConfigured() && controllerPath.length > 0) {
    let runId: string | undefined;
    try {
      const result = await runWithProgress('Initializing autonomous-development run…', () =>
        deps.service.execute('init', projectRoot, {
          feature: feature.trim(),
          worktreeMode: 'isolated',
          ...(presetName && presetName.length > 0 ? { preset: presetName } : {})
        })
      );
      runId = parseInitRunId(result.stdout);
      deps.refresh();
    } catch (err) {
      reportError(err);
      return;
    }
    // Open a bare Claude terminal in the worktree/project root so the user can
    // drive the initialized run. We do NOT invoke the autonomous-feature skill
    // here: the skill's own `init` step would create a second run rather than
    // resume this one. The user (or a future skill contract that accepts a
    // structured `--run-id`) invokes the driver session directly.
    const pluginDir = pluginDirFromControllerPath(controllerPath);
    const launchParts = ['claude'];
    if (pluginDir) {
      launchParts.push('--plugin-dir', shellSingleQuote(pluginDir));
    }
    const launchLine = launchParts.join(' ');
    const terminal = vscode.window.createTerminal({
      cwd: projectRoot,
      name: 'Autonomous Development'
    });
    terminal.show();
    terminal.sendText(launchLine, false);
    void vscode.window.showInformationMessage(
      runId
        ? `Run ${runId} initialized${presetName ? ` with preset "${presetName}"` : ''}. Open the Claude terminal to drive it (skill invocation is manual so no second init occurs).`
        : `Run initialized${presetName ? ` with preset "${presetName}"` : ''}. Open the Claude terminal to drive it.`
    );
    return;
  }

  // Legacy fallback: no controller configured. Hand off to the skill without a
  // preset (the skill contract does not accept structured preset metadata).
  const pluginDir = pluginDirFromControllerPath(controllerPath);
  const launchParts = ['claude'];
  if (pluginDir) {
    launchParts.push('--plugin-dir', shellSingleQuote(pluginDir));
  }
  const launchLine = launchParts.join(' ');
  const skillCommand = `/autonomous-development:autonomous-feature ${feature.trim()}`;

  const terminal = vscode.window.createTerminal({
    cwd: projectRoot,
    name: 'Autonomous Development'
  });
  terminal.show();
  terminal.sendText(launchLine, true);
  terminal.sendText(skillCommand, false);
  void vscode.window.showInformationMessage(
    'Claude is starting in the terminal. Review the pre-filled command, then press Enter to begin the run.'
  );
}

export async function evaluateGates(
  run: DiscoveredRun,
  deps: ControllerCommandDeps
): Promise<void> {
  if (!(await ensureConfigured(deps.service))) {
    return;
  }
  try {
    const result = await runWithProgress(`Evaluating completion gates for ${run.runId}…`, () =>
      deps.service.executeForRun('evaluate', run)
    );
    deps.refresh();
    const summary = result.stdout.trim().split('\n').slice(-1)[0] ?? 'Evaluation complete.';
    void vscode.window.showInformationMessage(`Completion-gate evaluation finished: ${summary}`);
  } catch (err) {
    reportError(err);
  }
}

export async function acceptDrift(run: DiscoveredRun, deps: ControllerCommandDeps): Promise<void> {
  if (!(await ensureConfigured(deps.service))) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Accept repository drift for run ${run.runId}? This records the working-tree drift as intentional.`,
    { modal: true },
    'Accept Drift'
  );
  if (confirm !== 'Accept Drift') {
    return;
  }
  try {
    await runWithProgress(`Accepting drift for ${run.runId}…`, () =>
      deps.service.executeForRun('accept-drift', run)
    );
    deps.refresh();
    void vscode.window.showInformationMessage(`Recorded accepted drift for ${run.runId}.`);
  } catch (err) {
    reportError(err);
  }
}

export async function cancelRun(run: DiscoveredRun, deps: ControllerCommandDeps): Promise<void> {
  if (!(await ensureConfigured(deps.service))) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Cancel run ${run.runId}? This marks the run cancelled and cannot be undone.`,
    { modal: true },
    'Cancel Run'
  );
  if (confirm !== 'Cancel Run') {
    return;
  }
  const reason = await vscode.window.showInputBox({
    prompt: 'Optional cancellation reason',
    placeHolder: 'Why is this run being cancelled?'
  });
  // showInputBox returns undefined when dismissed with Escape — proceed without a reason only
  // if the modal confirm already happened; an explicit Escape here aborts to be safe.
  if (reason === undefined) {
    return;
  }
  try {
    await runWithProgress(`Cancelling ${run.runId}…`, () =>
      deps.service.executeForRun('cancel', run, reason.length > 0 ? { reason } : {})
    );
    deps.refresh();
    void vscode.window.showInformationMessage(`Run ${run.runId} cancelled.`);
  } catch (err) {
    reportError(err);
  }
}

export async function archiveRun(run: DiscoveredRun, deps: ControllerCommandDeps): Promise<void> {
  if (!(await ensureConfigured(deps.service))) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Archive run ${run.runId}? It will move to the Archived Runs view.`,
    { modal: true },
    'Archive Run'
  );
  if (confirm !== 'Archive Run') {
    return;
  }
  try {
    await runWithProgress(`Archiving ${run.runId}…`, () =>
      deps.service.executeForRun('archive-run', run)
    );
    deps.refresh();
    void vscode.window.showInformationMessage(`Run ${run.runId} archived.`);
  } catch (err) {
    reportError(err);
  }
}
