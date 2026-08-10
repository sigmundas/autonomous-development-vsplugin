import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import {
  CONVENTIONAL_ARTIFACT_NAMES,
  parseFollowUpsText,
  resolveArtifactPath,
  type DiscoveredRun
} from '@semanticmatter/core';

import type { ExtensionConfig } from '../config';
import { ControllerError, type ControllerService } from '../controller/controllerService';

export interface ControllerCommandDeps {
  readonly service: ControllerService;
  readonly getConfig: () => ExtensionConfig;
  readonly refresh: () => void;
}

export type RecoveryIntent = 'allow-one-more-review' | 'resume-adversarial' | 'continue-blocked';

export interface RecoveryCommandDeps extends ControllerCommandDeps {
  readonly getRun: (repoId: string, runId: string) => DiscoveredRun | undefined;
  readonly surfaceRun: (run: DiscoveredRun) => void;
  readonly resumeRun: (run: DiscoveredRun) => Promise<void>;
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

function parseContinuationRunId(stdout: string): string {
  const line = stdout
    .trim()
    .split('\n')
    .filter((item) => item.trim().length > 0)
    .at(-1);
  if (!line) throw new ControllerError('Controller returned no new-run identity.');
  try {
    const parsed = JSON.parse(line) as { run_id?: unknown };
    if (typeof parsed.run_id === 'string' && parsed.run_id.length > 0) return parsed.run_id;
  } catch {
    // Fall through to the stable controller-contract error below.
  }
  throw new ControllerError('Controller returned an invalid new-run identity.');
}

async function refreshResolveSurfaceAndResume(
  source: DiscoveredRun,
  runId: string,
  deps: RecoveryCommandDeps
): Promise<DiscoveredRun> {
  deps.refresh();
  const continuation = deps.getRun(source.repoId, runId);
  if (!continuation) {
    throw new ControllerError(
      `Continuation ${runId} was created but was not found after run discovery refreshed.`
    );
  }
  deps.surfaceRun(continuation);
  await deps.resumeRun(continuation);
  return continuation;
}

export async function recoverBlockedRun(
  parent: DiscoveredRun,
  intent: RecoveryIntent,
  deps: RecoveryCommandDeps
): Promise<{ continuation: DiscoveredRun; reused: boolean }> {
  const result = await runWithProgress(`Preparing continuation for ${parent.runId}…`, () =>
    deps.service.executeForRun('continue-run', parent, { recoveryIntent: intent })
  );
  const runId = parseContinuationRunId(result.stdout);
  let payload: { reused?: unknown } = {};
  try {
    payload = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      reused?: unknown;
    };
  } catch {
    // The run id was already validated; reuse metadata is only informational.
  }
  deps.refresh();
  let continuation = deps.getRun(parent.repoId, runId);
  if (!continuation) {
    throw new ControllerError(
      `Continuation ${runId} was created but was not found after run discovery refreshed.`
    );
  }
  if (intent === 'allow-one-more-review') {
    const authorizationTarget = continuation;
    await runWithProgress(`Authorizing one review for ${authorizationTarget.runId}…`, () =>
      deps.service.executeForRun('authorize-review', authorizationTarget)
    );
  }
  continuation = await refreshResolveSurfaceAndResume(parent, runId, deps);
  return { continuation, reused: payload.reused === true };
}

export async function authorizeRecoverableRun(
  run: DiscoveredRun,
  deps: RecoveryCommandDeps
): Promise<DiscoveredRun> {
  await runWithProgress(`Authorizing one review for ${run.runId}…`, () =>
    deps.service.executeForRun('authorize-review', run)
  );
  return refreshResolveSurfaceAndResume(run, run.runId, deps);
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

export async function authorizeReview(
  run: DiscoveredRun,
  deps: RecoveryCommandDeps
): Promise<void> {
  if (!(await ensureConfigured(deps.service))) return;
  if (
    run.state?.status === 'cancelled' ||
    run.state?.status === 'complete' ||
    run.state?.status === 'complete_with_followups' ||
    run.state?.status === 'archived'
  ) {
    void vscode.window.showErrorMessage(
      `Run ${run.runId} is ${run.state.status} and cannot be authorized or continued.`
    );
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    run.state?.status === 'blocked'
      ? `Create or reuse a linked continuation of terminal run ${run.runId}, authorize one additional review on that continuation, and resume it in Claude? The parent remains immutable.`
      : `Allow one additional confirmation review for ${run.runId} and resume it in Claude? This applies only to this run and is recorded in its history.`,
    { modal: true },
    'Allow One More Review'
  );
  if (confirm !== 'Allow One More Review') return;
  try {
    if (run.state?.status === 'blocked') {
      const { continuation, reused } = await recoverBlockedRun(run, 'allow-one-more-review', deps);
      void vscode.window.showInformationMessage(
        `${reused ? 'Reused' : 'Created'} continuation ${continuation.runId}, authorized one additional review there, and resumed it in Claude.`
      );
      return;
    }
    await authorizeRecoverableRun(run, deps);
    void vscode.window.showInformationMessage(
      `One additional review was authorized for ${run.runId}; the global configuration was unchanged and Claude was resumed.`
    );
  } catch (err) {
    reportError(err);
  }
}

export async function continueBlockedRun(
  run: DiscoveredRun,
  deps: RecoveryCommandDeps
): Promise<void> {
  if (!(await ensureConfigured(deps.service))) return;
  const confirm = await vscode.window.showWarningMessage(
    `Create or reuse a linked continuation of blocked run ${run.runId} and resume it in Claude? Preserved artifacts, verification, findings, and acceptance evidence will be carried forward.`,
    { modal: true },
    'Continue Blocked Run'
  );
  if (confirm !== 'Continue Blocked Run') return;
  try {
    const intent: RecoveryIntent =
      run.model?.recommendedNextAction.code === 'resume-adversarial'
        ? 'resume-adversarial'
        : 'continue-blocked';
    const { continuation, reused } = await recoverBlockedRun(run, intent, deps);
    void vscode.window.showInformationMessage(
      `${reused ? 'Reused' : 'Created'} continuation ${continuation.runId} and resumed it in Claude. Review-derived evidence is preserved and stale evidence remains marked for reassessment.`
    );
  } catch (err) {
    reportError(err);
  }
}

export async function startFollowupRun(
  run: DiscoveredRun,
  deps: RecoveryCommandDeps
): Promise<void> {
  if (!(await ensureConfigured(deps.service))) return;
  const reference = run.state?.artifacts.followUpsJson ?? CONVENTIONAL_ARTIFACT_NAMES.followUpsJson;
  const path = resolveArtifactPath(run.runDir, reference).path;
  if (!path) {
    void vscode.window.showWarningMessage('No safe follow-ups.json artifact is available.');
    return;
  }
  let followUps;
  try {
    followUps = parseFollowUpsText(readFileSync(path, 'utf8')).followUps;
  } catch {
    followUps = [];
  }
  if (followUps.length === 0) {
    void vscode.window.showInformationMessage(`Run ${run.runId} has no deferred follow-ups.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    followUps.map((item) => ({
      label: item.id,
      description: item.title,
      detail: item.whyDeferred,
      id: item.id
    })),
    {
      title: `Start follow-up run from ${run.runId}`,
      placeHolder: 'Select one or more deferred findings',
      canPickMany: true,
      ignoreFocusOut: true
    }
  );
  if (!picked || picked.length === 0) return;
  try {
    const result = await runWithProgress(`Starting follow-up run for ${run.runId}…`, () =>
      deps.service.executeForRun('start-followup-run', run, {
        followUpIds: picked.map((item) => item.id)
      })
    );
    const runId = parseContinuationRunId(result.stdout);
    deps.refresh();
    const child = deps.getRun(run.repoId, runId);
    if (!child) {
      throw new ControllerError(
        `Follow-up run ${runId} was created but was not found after discovery refreshed.`
      );
    }
    deps.surfaceRun(child);
    void vscode.window.showInformationMessage(
      `Started follow-up run ${runId} from ${picked.length} selected item(s).`
    );
  } catch (err) {
    reportError(err);
  }
}
