import * as vscode from 'vscode';
import type { DiscoveredRun, RunStatus } from '@semanticmatter/core';

/** A run row. */
export interface RunNode {
  readonly kind: 'run';
  readonly run: DiscoveredRun;
}

/** Persistent, self-explanatory start action shown at the top of Active Runs. */
export interface NewRunNode {
  readonly kind: 'new-run';
}

/** A child detail row under a run. */
export interface DetailNode {
  readonly kind: 'detail';
  readonly run: DiscoveredRun;
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: vscode.ThemeIcon;
}

export type TreeNode = NewRunNode | RunNode | DetailNode;

export function buildNewRunTreeItem(): vscode.TreeItem {
  const item = new vscode.TreeItem('New run…', vscode.TreeItemCollapsibleState.None);
  item.id = 'autonomousDev.newRun';
  item.description = 'Choose run mode and describe the feature';
  item.tooltip = 'Start a new autonomous-development run';
  item.iconPath = new vscode.ThemeIcon('add');
  item.contextValue = 'autonomousDev.newRun';
  item.command = {
    command: 'autonomousDev.startRun',
    title: 'Start New Run'
  };
  return item;
}

function statusIcon(status: RunStatus, hasModel: boolean): vscode.ThemeIcon {
  if (!hasModel) {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
  }
  switch (status) {
    case 'active':
      return new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.blue'));
    case 'complete':
    case 'complete_with_followups':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    case 'blocked':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
    case 'archived':
      return new vscode.ThemeIcon('archive');
    default:
      return new vscode.ThemeIcon('question');
  }
}

function runLabel(run: DiscoveredRun): string {
  const feature = run.state?.feature?.trim();
  if (feature && feature.length > 0) {
    const firstLine = feature.split('\n')[0] ?? feature;
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
  }
  return run.runId;
}

function runDescription(run: DiscoveredRun): string {
  if (!run.state) {
    return 'unreadable run-state';
  }
  const status = run.model?.status ?? run.state.status;
  const phase = run.model?.phase ?? run.state.phase;
  if (status === 'complete_with_followups') {
    return `complete · ${run.model?.completionEvaluation?.followUpCount ?? 0} follow-ups`;
  }
  const review = run.model?.review;
  if (status === 'active' && review?.hasReviews) {
    const round = review.latestRound !== undefined ? `round ${review.latestRound}` : 'review';
    const verdict = review.latestVerdict ? ` · ${displayVerdict(review.latestVerdict)}` : '';
    if (phase === 'triage') {
      return `fixing findings · ${round}${verdict}`;
    }
    if (phase === 'review' || phase === 'reviewing' || phase === 'independent-review') {
      return `re-reviewing · after ${round}${verdict}`;
    }
  }
  return phase && phase !== status ? `${status} · ${phase}` : status;
}

function displayVerdict(verdict: string): string {
  return verdict.replaceAll('_', ' ');
}

function worktreeModeLabel(mode?: string): string | undefined {
  if (mode === 'current') {
    return 'current checkout';
  }
  if (mode === 'isolated') {
    return 'isolated worktree';
  }
  return mode;
}

function runTooltip(run: DiscoveredRun): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${runLabel(run)}**\n\n`);
  md.appendMarkdown(`- Run ID: \`${run.runId}\`\n`);
  if (run.state) {
    md.appendMarkdown(`- Status: ${run.model?.status ?? run.state.status}\n`);
    md.appendMarkdown(`- Phase: ${run.state.phase}\n`);
    const repo = run.state.repository;
    md.appendMarkdown(`- Repository: ${repo.displayName ?? repo.id}\n`);
    if (repo.worktreePath) {
      md.appendMarkdown(`- Worktree: ${repo.worktreePath}\n`);
    }
    if (repo.worktreeMode) {
      md.appendMarkdown(`- Checkout mode: ${worktreeModeLabel(repo.worktreeMode)}\n`);
    }
    if (run.state.createdAt) {
      md.appendMarkdown(`- Created: ${run.state.createdAt}\n`);
    }
    if (run.state.updatedAt) {
      md.appendMarkdown(`- Updated: ${run.state.updatedAt}\n`);
    }
  }
  if (run.model) {
    const v = run.model.verification;
    md.appendMarkdown(`- Verification: ${v.passedCount}/${v.total} passing\n`);
    md.appendMarkdown(
      `- Review: round ${run.model.reviewBudget.consumed}/${run.model.reviewBudget.max}` +
        `${run.model.review.latestVerdict ? `, latest ${run.model.review.latestVerdict}` : ''}\n`
    );
    if (run.model.adversarial.required) {
      md.appendMarkdown(
        `- Adversarial review: required${run.model.adversarial.satisfied ? ' (satisfied)' : ''}\n`
      );
    }
    md.appendMarkdown(`- Unresolved gates: ${run.model.completionGateFailures.length}\n`);
    if (run.model.completionEvaluation?.followUpCount) {
      md.appendMarkdown(`- Follow-ups: ${run.model.completionEvaluation.followUpCount}\n`);
    }
    md.appendMarkdown(`- Next: ${run.model.recommendedNextAction.message || '—'}\n`);
  }
  if (run.diagnostics.length > 0) {
    md.appendMarkdown(`\n_${run.diagnostics.length} diagnostic(s)_`);
  }
  return md;
}

export function buildRunTreeItem(node: RunNode): vscode.TreeItem {
  const { run } = node;
  const item = new vscode.TreeItem(runLabel(run), vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `${run.repoId}::${run.runId}`;
  item.description = runDescription(run);
  item.tooltip = runTooltip(run);
  item.iconPath = statusIcon(run.state?.status ?? 'unknown', run.model !== undefined);
  item.contextValue = `autonomousDev.run.${run.group}`;
  item.command = {
    command: 'autonomousDev.openDashboard',
    title: 'Open Workflow Dashboard',
    arguments: [node]
  };
  return item;
}

export function buildDetailTreeItem(node: DetailNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.id = `${node.run.repoId}::${node.run.runId}::${node.id}`;
  if (node.description !== undefined) {
    item.description = node.description;
  }
  item.tooltip = node.tooltip ?? node.description ?? node.label;
  if (node.icon) {
    item.iconPath = node.icon;
  }
  item.contextValue = 'autonomousDev.detail';
  return item;
}

/** Derive the child detail rows shown when a run is expanded. */
export function detailNodes(run: DiscoveredRun): DetailNode[] {
  const nodes: DetailNode[] = [];
  const push = (id: string, label: string, description?: string, icon?: vscode.ThemeIcon): void => {
    nodes.push({
      kind: 'detail',
      run,
      id,
      label,
      ...(description !== undefined ? { description } : {}),
      ...(icon ? { icon } : {})
    });
  };

  if (!run.state) {
    for (const d of run.diagnostics) {
      push(
        `diag-${nodes.length}`,
        d.message,
        d.severity,
        new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
      );
    }
    return nodes;
  }

  const model = run.model;
  push(
    'status',
    'Status',
    `${model?.status ?? run.state.status} · ${run.state.phase}`,
    new vscode.ThemeIcon('info')
  );

  const repo = run.state.repository;
  push('repository', 'Repository', repo.displayName ?? repo.id, new vscode.ThemeIcon('repo'));
  if (repo.worktreePath) {
    push('worktree', 'Worktree', repo.worktreePath, new vscode.ThemeIcon('folder'));
  }
  if (repo.worktreeMode) {
    push(
      'worktree-mode',
      'Checkout mode',
      worktreeModeLabel(repo.worktreeMode),
      new vscode.ThemeIcon('git-branch')
    );
  }

  if (model) {
    const v = model.verification;
    const vIcon =
      v.hasChecks && v.passed
        ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'))
        : v.hasChecks
          ? new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
          : new vscode.ThemeIcon('circle-outline');
    push(
      'verification',
      'Verification',
      v.hasChecks ? `${v.passedCount}/${v.total} passing` : 'no checks',
      vIcon
    );

    const verdict = model.review.latestVerdict
      ? displayVerdict(model.review.latestVerdict)
      : 'none';
    const completedRound = model.review.latestRound ?? model.reviewBudget.consumed;
    push(
      'review',
      model.review.hasReviews ? 'Latest completed review' : 'Review',
      model.review.hasReviews
        ? `round ${completedRound} · ${verdict}`
        : `not run · budget ${model.reviewBudget.max}`,
      new vscode.ThemeIcon('comment-discussion')
    );

    if (model.review.hasReviews && run.state.phase === 'triage') {
      push(
        'review-activity',
        'Current activity',
        `Claude is triaging and fixing findings from round ${completedRound}`,
        new vscode.ThemeIcon('tools')
      );
    }

    if (model.adversarial.required) {
      const adversarialDetail = [
        model.adversarial.latestRound !== undefined
          ? `round ${model.adversarial.latestRound}`
          : undefined,
        model.adversarial.latestVerdict
          ? displayVerdict(model.adversarial.latestVerdict)
          : model.adversarial.satisfied
            ? 'satisfied'
            : 'required'
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
      push(
        'adversarial',
        'Adversarial review',
        adversarialDetail,
        new vscode.ThemeIcon(
          'shield',
          new vscode.ThemeColor(model.adversarial.satisfied ? 'charts.green' : 'charts.yellow')
        )
      );
    }

    if (model.completionEvaluation?.followUpCount) {
      push(
        'follow-ups',
        'Follow-ups',
        String(model.completionEvaluation.followUpCount),
        new vscode.ThemeIcon('issues', new vscode.ThemeColor('charts.blue'))
      );
    }

    const gateCount = model.completionGateFailures.length;
    push(
      'gates',
      'Completion gates',
      gateCount === 0 ? 'all passing' : `${gateCount} unresolved`,
      gateCount === 0
        ? new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
    );

    push(
      'next',
      'Next action',
      model.recommendedNextAction.message || '—',
      new vscode.ThemeIcon('arrow-right')
    );
  }

  return nodes;
}
