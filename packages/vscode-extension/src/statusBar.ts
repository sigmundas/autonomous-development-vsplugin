import * as vscode from 'vscode';

import type { RunStore } from './runStore';

/**
 * Status-bar item for the selected run. Reflects phase + next action and opens
 * the dashboard on click (the command falls back to the selected run when given
 * no argument).
 */
export class RunStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: RunStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'autonomousDev.openDashboard';
    this.disposables.push(
      this.item,
      this.store.onDidChangeSelection(() => this.update()),
      this.store.onDidChange(() => this.update())
    );
    this.update();
  }

  private update(): void {
    const run = this.store.selectedRun;
    if (!run || !run.model) {
      this.item.hide();
      return;
    }
    const icon =
      run.model.status === 'complete' || run.model.status === 'complete_with_followups'
        ? '$(pass-filled)'
        : run.model.status === 'blocked'
          ? '$(error)'
          : run.model.status === 'active'
            ? '$(pulse)'
            : '$(circle-outline)';
    const followups = run.model.completionEvaluation?.followUpCount ?? 0;
    this.item.text = `${icon} ${run.runId} · ${run.model.phase}${followups > 0 ? ` · ${followups} follow-ups` : ''}`;
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**Autonomous Development run ${run.runId}**\n\n`);
    tip.appendMarkdown(`- Status: ${run.model.status}\n`);
    const worktreeMode = run.state?.repository.worktreeMode;
    if (worktreeMode) {
      tip.appendMarkdown(
        `- Checkout mode: ${
          worktreeMode === 'current'
            ? 'current checkout'
            : worktreeMode === 'isolated'
              ? 'isolated worktree'
              : worktreeMode
        }\n`
      );
    }
    tip.appendMarkdown(
      `- Gates: ${run.model.gatesPass ? 'passing' : `${run.model.completionGateFailures.length} unresolved`}\n`
    );
    tip.appendMarkdown(`- Next: ${run.model.recommendedNextAction.message || '—'}\n`);
    this.item.tooltip = tip;
    this.item.show();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
