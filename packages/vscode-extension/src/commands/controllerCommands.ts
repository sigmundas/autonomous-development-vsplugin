import * as vscode from 'vscode';
import type { DiscoveredRun } from '@semanticmatter/core';

import type { ExtensionConfig } from '../config';
import { ControllerError, type ControllerService } from '../controller/controllerService';

export interface ControllerCommandDeps {
  readonly service: ControllerService;
  readonly getConfig: () => ExtensionConfig;
  readonly refresh: () => void;
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
