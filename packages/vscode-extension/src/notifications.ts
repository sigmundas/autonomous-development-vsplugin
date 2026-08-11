import * as vscode from 'vscode';
import type { WorkflowModel } from '@semanticmatter/core';

import type { ExtensionConfig, NotificationLevel } from './config';
import type { RunStore } from './runStore';
import { runKey } from './runStore';

interface Snapshot {
  readonly status: string;
  readonly phase: string;
  readonly failedChecks: number;
  readonly blockingReason?: string;
}

/**
 * Emits run notifications by diffing per-run snapshots across refreshes. The
 * first observation of a run never notifies (avoids a burst on activation); only
 * subsequent transitions do. The notification level gates which transitions are
 * surfaced.
 */
export class RunNotifier implements vscode.Disposable {
  private snapshots = new Map<string, Snapshot>();
  private readonly disposable: vscode.Disposable;

  constructor(
    private readonly store: RunStore,
    private getConfig: () => ExtensionConfig
  ) {
    this.disposable = this.store.onDidChange(() => this.diff());
    this.prime();
  }

  updateConfig(getConfig: () => ExtensionConfig): void {
    this.getConfig = getConfig;
  }

  /** Seed snapshots without notifying (called on construction). */
  private prime(): void {
    for (const run of this.store.allRuns) {
      if (run.model) {
        this.snapshots.set(runKey(run), this.snapshotOf(run.model));
      }
    }
  }

  private snapshotOf(model: WorkflowModel): Snapshot {
    return {
      status: model.status,
      phase: model.phase,
      failedChecks: model.verification.failedCount,
      ...(model.blockingReason !== undefined ? { blockingReason: model.blockingReason } : {})
    };
  }

  private allow(level: NotificationLevel, important: boolean): boolean {
    if (level === 'none') return false;
    if (level === 'important') return important;
    return true;
  }

  private diff(): void {
    const level = this.getConfig().notificationLevel;
    if (level === 'none') {
      // Still refresh snapshots so re-enabling later doesn't replay history.
      this.prime();
      return;
    }
    for (const run of this.store.allRuns) {
      const model = run.model;
      if (!model) continue;
      const key = runKey(run);
      const prev = this.snapshots.get(key);
      const next = this.snapshotOf(model);
      this.snapshots.set(key, next);
      if (!prev) {
        continue;
      }

      if (
        next.status !== prev.status &&
        (next.status === 'complete' || next.status === 'complete_with_followups')
      ) {
        if (this.allow(level, true)) {
          const suffix =
            next.status === 'complete_with_followups'
              ? ` with ${run.model?.completionEvaluation?.followUpCount ?? 0} follow-up(s)`
              : '';
          void vscode.window.showInformationMessage(
            `Run ${run.runId} completed successfully${suffix}.`
          );
        }
        continue;
      }
      if (next.status !== prev.status && next.status === 'blocked') {
        if (this.allow(level, true)) {
          void vscode.window.showWarningMessage(
            `Run ${run.runId} is blocked: ${next.blockingReason ?? 'see dashboard'}.`
          );
        }
        continue;
      }
      if (next.failedChecks > 0 && prev.failedChecks === 0) {
        if (this.allow(level, true)) {
          void vscode.window.showWarningMessage(
            `Run ${run.runId} has failing verification checks.`
          );
        }
      }
      if (next.phase !== prev.phase) {
        if (this.allow(level, false)) {
          void vscode.window.showInformationMessage(
            `Run ${run.runId}: ${prev.phase} → ${next.phase}`
          );
        }
      }
    }
  }

  dispose(): void {
    this.disposable.dispose();
  }
}
