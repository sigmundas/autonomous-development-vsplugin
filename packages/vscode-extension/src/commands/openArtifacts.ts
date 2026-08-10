import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as vscode from 'vscode';
import {
  CONVENTIONAL_ARTIFACT_NAMES,
  latestReviewRef,
  resolveArtifactPath,
  type DiscoveredRun
} from '@semanticmatter/core';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve an artifact to an existing file (recorded ref, else conventional name). */
function resolveExisting(
  run: DiscoveredRun,
  ref: string | undefined,
  conventional: string
): string | undefined {
  if (ref) {
    const resolved = resolveArtifactPath(run.runDir, ref);
    if (resolved.path && isFile(resolved.path)) {
      return resolved.path;
    }
  }
  if (!conventional) {
    return undefined;
  }
  const fallback = join(run.runDir, conventional);
  return isFile(fallback) ? fallback : undefined;
}

async function open(path: string | undefined, missingLabel: string): Promise<void> {
  if (!path) {
    void vscode.window.showWarningMessage(`${missingLabel} is not present for this run.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  await vscode.window.showTextDocument(doc, { preview: true });
}

export async function openOriginalFeature(run: DiscoveredRun): Promise<void> {
  await open(
    resolveExisting(
      run,
      run.state?.artifacts.featureRequest,
      CONVENTIONAL_ARTIFACT_NAMES.featureRequest
    ),
    'Original feature request'
  );
}

export async function openEnhancedSpec(run: DiscoveredRun): Promise<void> {
  await open(
    resolveExisting(run, run.state?.artifacts.enhance, CONVENTIONAL_ARTIFACT_NAMES.enhance),
    'Enhanced specification'
  );
}

export async function openAcceptedSpec(run: DiscoveredRun): Promise<void> {
  await open(
    resolveExisting(
      run,
      run.state?.artifacts.acceptedSpec,
      CONVENTIONAL_ARTIFACT_NAMES.acceptedSpec
    ),
    'Accepted specification'
  );
}

export async function openProposedPlan(run: DiscoveredRun): Promise<void> {
  await open(
    resolveExisting(run, run.state?.artifacts.plan, CONVENTIONAL_ARTIFACT_NAMES.plan),
    'Proposed plan'
  );
}

export async function openAcceptedPlan(run: DiscoveredRun): Promise<void> {
  await open(
    resolveExisting(
      run,
      run.state?.artifacts.acceptedPlan,
      CONVENTIONAL_ARTIFACT_NAMES.acceptedPlan
    ),
    'Accepted plan'
  );
}

export async function openLatestReview(run: DiscoveredRun): Promise<void> {
  const ref = run.state
    ? (latestReviewRef(run.state.reviews)?.path ?? run.state.artifacts.review)
    : undefined;
  await open(resolveExisting(run, ref, ''), 'Latest review');
}

export async function openVerificationLog(run: DiscoveredRun): Promise<void> {
  // Prefer the most recent recorded check log; fall back to revealing the dir.
  const latest = run.model?.verification.latest ?? [];
  for (let i = latest.length - 1; i >= 0; i--) {
    const log = latest[i]?.log;
    if (log) {
      const resolved = resolveArtifactPath(run.runDir, log);
      if (resolved.path && existsSync(resolved.path)) {
        await open(resolved.path, 'Verification log');
        return;
      }
    }
  }
  const dir = join(run.runDir, 'verification');
  if (existsSync(dir)) {
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(dir));
    return;
  }
  void vscode.window.showWarningMessage('No verification logs are present for this run.');
}

export async function openFollowUps(run: DiscoveredRun): Promise<void> {
  await open(
    resolveExisting(
      run,
      run.state?.artifacts.followUpsMarkdown,
      CONVENTIONAL_ARTIFACT_NAMES.followUpsMarkdown
    ) ??
      resolveExisting(
        run,
        run.state?.artifacts.followUpsJson,
        CONVENTIONAL_ARTIFACT_NAMES.followUpsJson
      ),
    'Follow-up artifact'
  );
}

async function diff(
  leftPath: string | undefined,
  rightPath: string | undefined,
  title: string,
  missing: string
): Promise<void> {
  if (!leftPath || !rightPath) {
    void vscode.window.showWarningMessage(
      `${missing} — both artifacts must be present to compare.`
    );
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(leftPath),
    vscode.Uri.file(rightPath),
    title
  );
}

export async function compareSpec(run: DiscoveredRun): Promise<void> {
  const left = resolveExisting(
    run,
    run.state?.artifacts.featureRequest,
    CONVENTIONAL_ARTIFACT_NAMES.featureRequest
  );
  const right = resolveExisting(
    run,
    run.state?.artifacts.acceptedSpec,
    CONVENTIONAL_ARTIFACT_NAMES.acceptedSpec
  );
  await diff(
    left,
    right,
    `Original idea ↔ Accepted spec (${run.runId})`,
    'Cannot compare specification'
  );
}

export async function comparePlan(run: DiscoveredRun): Promise<void> {
  const left = resolveExisting(run, run.state?.artifacts.plan, CONVENTIONAL_ARTIFACT_NAMES.plan);
  const right = resolveExisting(
    run,
    run.state?.artifacts.acceptedPlan,
    CONVENTIONAL_ARTIFACT_NAMES.acceptedPlan
  );
  await diff(left, right, `Proposed plan ↔ Accepted plan (${run.runId})`, 'Cannot compare plan');
}

export async function revealRunDirectory(run: DiscoveredRun): Promise<void> {
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(run.runDir));
}
