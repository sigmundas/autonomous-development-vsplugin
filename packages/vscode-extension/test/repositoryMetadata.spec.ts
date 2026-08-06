import assert from 'node:assert/strict';

import type { DiscoveredRun, LoadedEventLog } from '@semanticmatter/core';

import { toDashboardView } from '../src/dashboard/renderModel';

function emptyEventLog(): LoadedEventLog {
  return {
    path: '/nonexistent/events.jsonl',
    exists: false,
    events: [],
    timeline: [],
    diagnostics: [],
    protocolDiagnostics: [],
    preserved: [],
    totalLines: 0,
    truncatedTail: false
  } as unknown as LoadedEventLog;
}

function makeRun(baseline: {
  commit?: string;
  branch?: string;
  worktreePath?: string;
  worktreeMode?: string;
}): DiscoveredRun {
  return {
    runId: 'RID',
    repoId: 'repo',
    runDir: '/x',
    group: 'active',
    diagnostics: [],
    state: {
      schemaVersion: 2,
      runId: 'RID',
      feature: 'Add CSV export',
      status: 'active',
      rawStatus: 'active',
      phase: 'implementing',
      repository: {
        id: 'repo',
        displayName: 'sporely-py',
        ...(baseline.worktreePath !== undefined
          ? { worktreePath: baseline.worktreePath }
          : {}),
        ...(baseline.worktreeMode !== undefined
          ? { worktreeMode: baseline.worktreeMode }
          : {})
      },
      baseline: {
        dirtyEntriesAtInit: [],
        ...(baseline.commit !== undefined ? { commit: baseline.commit } : {}),
        ...(baseline.branch !== undefined ? { branch: baseline.branch } : {})
      },
      maxReviewRounds: 3,
      reviewRound: 0,
      stopGateBlocks: 0,
      artifacts: { raw: {} },
      verification: { checks: [] },
      reviews: [],
      adversarialReviews: [],
      risk: { requiresAdversarialReview: false, reasons: [] },
      notes: [],
      completionGateFailures: [],
      cumulativeFindings: [],
      cumulativeAcceptanceCriteria: [],
      reviewLedger: [],
      codexRuns: [],
      modeReasons: [],
      raw: {}
    },
    model: {
      status: 'active',
      phase: 'implementing',
      isTerminal: false,
      stages: [],
      reviewBudget: { max: 3, consumed: 0, remaining: 3 },
      verification: {
        hasChecks: false,
        passed: false,
        passedCount: 0,
        failedCount: 0,
        total: 0,
        latest: [],
        attemptsByName: {}
      },
      review: { hasReviews: false, severeFindingCount: 0 },
      adversarial: { required: false, satisfied: true, reasons: [] },
      riskClassification: { requiresAdversarialReview: false, reasons: [] },
      cumulativeFindings: { total: 0, blockingSevereCount: 0, resolvedCount: 0, openCount: 0, blockingSevere: [] },
      acceptanceCriteria: { total: 0, satisfiedCount: 0, blockingCount: 0 },
      codexUsage: { runs: [], totalDurationSeconds: 0, totalTokens: 0 },
      completionGateFailures: [],
      gatesPass: false,
      recommendedNextAction: { code: 'none', message: '' },
      modeReasons: []
    }
  } as unknown as DiscoveredRun;
}

describe('DashboardView.repository — branch and baseline metadata', () => {
  it('exposes branch and full baseline commit from the run state', () => {
    const view = toDashboardView(
      makeRun({
        branch: 'feat/reference-plots-desktop-slice',
        commit: '108db20abcdef1234567890',
        worktreePath: '/Users/x/sporely-py',
        worktreeMode: 'current'
      }),
      emptyEventLog()
    );
    assert.equal(view.repository.branch, 'feat/reference-plots-desktop-slice');
    assert.equal(view.repository.baselineCommit, '108db20abcdef1234567890');
    assert.equal(view.repository.worktreeMode, 'current');
    assert.equal(view.repository.worktreePath, '/Users/x/sporely-py');
    // Display name still exposed as before.
    assert.equal(view.repository.displayName, 'sporely-py');
  });

  it('omits branch/baseline gracefully for older runs missing those fields', () => {
    const view = toDashboardView(makeRun({}), emptyEventLog());
    assert.equal(view.repository.branch, undefined);
    assert.equal(view.repository.baselineCommit, undefined);
  });
});
