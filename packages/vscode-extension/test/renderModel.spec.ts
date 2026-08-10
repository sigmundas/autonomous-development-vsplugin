import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { discoverRuns, loadEventLog, type DiscoveredRun } from '@semanticmatter/core';

import { toDashboardView } from '../src/dashboard/renderModel';
import { ClaudeTerminalRegistry } from '../src/config/claudeTerminalRegistry';
import { terminalIdentityForRun } from '../src/config/claudeTerminalIdentity';
import { buildFixtures, type Fixtures } from './fixtures';

let fixtures: Fixtures;
let runs: DiscoveredRun[];

function find(runId: string): DiscoveredRun {
  const run = runs.find((r) => r.runId === runId);
  assert.ok(run, `run ${runId} not discovered`);
  return run;
}

function viewFor(runId: string): ReturnType<typeof toDashboardView> {
  const run = find(runId);
  return toDashboardView(run, loadEventLog(run.runDir));
}

before(() => {
  fixtures = buildFixtures();
  runs = discoverRuns(fixtures.stateHome);
});

after(() => {
  fixtures?.cleanup();
});

describe('toDashboardView', () => {
  it('reports the Claude terminal open after Start late-binding', () => {
    const run = find('implementing');
    const terminal = {
      name: 'Autonomous Claude — repo',
      exitStatus: undefined,
      dispose: () => undefined,
      show: () => undefined
    } as unknown as vscode.Terminal;
    const registry = new ClaudeTerminalRegistry();
    registry.registerUnbound({
      repositoryId: run.repoId,
      terminal,
      knownRunIds: runs.filter((item) => item.runId !== run.runId).map((item) => item.runId)
    });
    registry.reconcileRuns([{ repositoryId: run.repoId, runId: run.runId, active: true }]);
    const view = toDashboardView(run, loadEventLog(run.runDir), {
      claudeTerminalOpen: registry.has(terminalIdentityForRun(run))
    });
    assert.equal(view.claudeTerminalOpen, true);
    assert.equal(view.currentActivity.claudeTerminalOpen, true);
    registry.dispose();
  });

  it('serializes a complete run with derived gates, artifacts, and timeline', () => {
    const view = viewFor('complete');
    assert.equal(view.status, 'complete');
    assert.equal(view.gatesPass, true);
    assert.equal(view.nextAction.code, 'none');

    assert.equal(view.artifacts.length, 5);
    assert.ok(
      view.artifacts.every((a) => a.exists),
      'all five chain artifacts should exist'
    );

    assert.equal(view.verification.total, 1);
    assert.equal(view.verification.passedCount, 1);
    assert.equal(view.verification.checks[0]?.command, 'npm test');
    assert.equal(view.verification.checks[0]?.passed, true);

    // Reconstructed from events.jsonl (run.created, verification.completed).
    assert.equal(view.timeline.length, 2);
    assert.equal(view.timeline[0]?.type, 'run.created');
  });

  it('renders complete_with_followups as successful with adversarial history', () => {
    const view = viewFor('completeWithFollowups');
    assert.equal(view.status, 'complete_with_followups');
    assert.equal(view.isTerminal, true);
    assert.equal(view.gatesPass, true);
    assert.equal(view.gateFailures.length, 0);
    assert.equal(view.nextAction.code, 'none');
    assert.equal(view.completion.followUpCount, 3);
    assert.equal(view.followUps.length, 3);
    assert.equal(view.followUps[0]?.provenance, 'adversarial-08.codex.json#threats/0');
    assert.equal(view.review.latestRound, 3);
    assert.equal(view.review.latestVerdict, 'pass');
    assert.equal(view.adversarial.latestRound, 8);
    assert.equal(view.adversarial.latestVerdict, 'changes_required');
    assert.ok(view.artifacts.some((a) => a.command === 'autonomousDev.openFollowUps'));
    const triage = view.stages.find((stage) => stage.id === 'triage');
    const adversarial = view.stages.find((stage) => stage.id === 'adversarial-review');
    assert.notEqual(triage?.status, 'active');
    assert.equal(adversarial?.status, 'complete');
    assert.equal(adversarial?.detail, 'Round 8 · changes required');
  });

  it('surfaces the recorded human decision and source phase without rewinding triage', () => {
    const view = viewFor('awaitingDecision');
    assert.equal(view.recovery.awaitingHumanDecision, true);
    assert.equal(view.recovery.humanDecisionPhase, 'adversarial');
    assert.match(view.recovery.humanDecisionReason ?? '', /interpretation A or B/);
    assert.equal(view.stages.find((stage) => stage.id === 'triage')?.status, 'complete');
    assert.equal(view.stages.find((stage) => stage.id === 'adversarial-review')?.status, 'active');
  });

  it('surfaces current-checkout mode in repository metadata', () => {
    const view = viewFor('currentCheckout');
    assert.equal(view.repository.worktreeMode, 'current');
    assert.equal(view.repository.worktreePath, '/work/current');
  });

  it('surfaces the discovered continuation on its immutable parent', () => {
    const parent = find('blocked');
    const view = toDashboardView(parent, loadEventLog(parent.runDir), {
      continuedByRunId: 'continuation-1'
    });
    assert.equal(view.recovery.continuedByRunId, 'continuation-1');
  });

  it('attaches semantic summaries to the enhanced spec and proposed plan artifacts (F-301)', () => {
    const view = viewFor('complete');
    const enhance = view.artifacts.find((a) => a.command === 'autonomousDev.openEnhancedSpec');
    const enhanceLabels = (enhance?.sections ?? []).map((s) => s.label);
    assert.deepEqual(enhanceLabels, [
      'Problem statement',
      'Functional requirements',
      'Acceptance criteria',
      'Assumptions',
      'Risks',
      'Non-goals'
    ]);

    const plan = view.artifacts.find((a) => a.command === 'autonomousDev.openProposedPlan');
    const planLabels = (plan?.sections ?? []).map((s) => s.label);
    assert.deepEqual(planLabels, [
      'Summary',
      'Implementation steps',
      'Expected files',
      'Test strategy',
      'Rollback strategy',
      'Risks',
      'Non-goals'
    ]);

    // Markdown artifacts carry no structured summary.
    const acceptedSpec = view.artifacts.find((a) => a.command === 'autonomousDev.openAcceptedSpec');
    assert.equal(acceptedSpec?.sections, undefined);
  });

  it('exposes a review finding with file + 1-based line for editor navigation', () => {
    const view = viewFor('changesRequired');
    const round = view.review.rounds[0];
    assert.ok(round, 'expected one review round');
    assert.equal(round.readable, true);
    const finding = round.findings[0];
    assert.equal(finding?.file, 'src/app.ts');
    assert.equal(finding?.line, 42);
    assert.equal(finding?.severity, 'high');
    assert.equal(round.findingCountsBySeverity['high'], 1);
  });

  it('surfaces review metadata: verification gaps and acceptance-criteria assessment (F-101)', () => {
    const view = viewFor('changesRequired');
    const round = view.review.rounds[0];
    assert.ok(round, 'expected one review round');
    assert.deepEqual(round.verificationGaps, ['No integration test covers the retry path.']);
    assert.equal(round.acceptanceCriteria.length, 1);
    assert.deepEqual(round.acceptanceCriteria[0], {
      id: 'AC-1',
      status: 'partially_satisfied',
      evidence: 'Happy path covered; error path unverified.'
    });
  });

  it('surfaces legacy triage markdown read-only without fabricating dispositions (F-101)', () => {
    const view = viewFor('changesRequired');
    assert.deepEqual(view.review.triageFiles, [{ filename: 'triage-01.md' }]);
  });

  it('attaches a structured disposition from a triaged event to its finding (F-201)', () => {
    const view = viewFor('changesRequired');
    const finding = view.review.rounds[0]?.findings[0];
    assert.equal(finding?.id, 'F-1');
    assert.equal(finding?.disposition, 'accepted');
  });

  it('does not flag a disagreement when the event log matches run-state (F-203)', () => {
    const view = viewFor('changesRequired');
    assert.ok(!view.diagnostics.some((d) => d.code === 'event-log-disagreement'));
  });

  it('merges precise event-log diagnostics into the dashboard (F-102)', () => {
    const view = viewFor('changesRequired');
    const parseError = view.diagnostics.find((d) => d.code === 'parse-error');
    assert.ok(parseError, 'expected a parse-error diagnostic from the malformed interior line');
    assert.match(parseError.message, /events\.jsonl \(line 2\)/);
    assert.equal(parseError.severity, 'warning');
  });

  it('marks the adversarial requirement as required and unsatisfied', () => {
    const view = viewFor('adversarialRequired');
    assert.equal(view.adversarial.required, true);
    assert.equal(view.adversarial.satisfied, false);
    assert.deepEqual(view.adversarial.reasons, ['Touches authentication']);
  });

  it('returns a diagnostics-only shell for a malformed run', () => {
    const view = viewFor('malformed');
    assert.equal(view.status, 'unknown');
    assert.deepEqual(view.stages, []);
    assert.ok(view.diagnostics.some((d) => d.code === 'run-state-parse-error'));
  });

  describe('cumulative ledger (v0.3.0 surface)', () => {
    it('separates resolved from blocking cumulative findings with provenance', () => {
      const view = viewFor('cumulativeLedger');
      const cf = view.cumulativeFindings;
      assert.equal(cf.total, 3);
      // Only the open critical F-2 is severe + unresolved → blocking.
      assert.equal(cf.blockingSevereCount, 1);
      assert.equal(cf.resolvedCount, 1);
      assert.equal(cf.openCount, 2); // F-2 (critical) + F-3 (low) are open.

      const byId = new Map(cf.findings.map((f) => [f.id, f]));
      const resolved = byId.get('F-1');
      assert.ok(resolved, 'F-1 present');
      assert.equal(resolved.blocking, false, 'resolved finding is NOT blocking');
      assert.equal(resolved.resolvedAtRound, 2);
      assert.equal(resolved.resolutionSource, 'review-02');

      const critical = byId.get('F-2');
      assert.ok(critical, 'F-2 present');
      assert.equal(critical.blocking, true, 'open critical finding blocks');
      assert.equal(critical.roundOpened, 2);

      const low = byId.get('F-3');
      assert.ok(low, 'F-3 present');
      assert.equal(low.blocking, false, 'open low severity does not block');
    });

    it('flags every non-satisfied acceptance criterion as blocking (fail closed)', () => {
      const view = viewFor('cumulativeLedger');
      const ac = view.acceptanceCriteria;
      assert.equal(ac.total, 3);
      assert.equal(ac.satisfiedCount, 1);
      assert.equal(ac.blockingCount, 2);
      const byId = new Map(ac.criteria.map((c) => [c.id, c]));
      assert.equal(byId.get('AC-1')?.blocking, false);
      assert.equal(byId.get('AC-2')?.blocking, true);
      assert.equal(byId.get('AC-3')?.blocking, true);
    });

    it('fails completion closed on open critical + unsatisfied criteria', () => {
      const view = viewFor('cumulativeLedger');
      assert.equal(view.gatesPass, false);
      const codes = view.gateFailures.map((g) => g.code);
      assert.ok(codes.includes('severe-findings'), 'severe-findings gate fires');
      assert.ok(
        codes.includes('acceptance-criteria-unsatisfied'),
        'acceptance-criteria gate fires'
      );
    });

    it('surfaces the effective mode, latest checkpoint, and Codex usage', () => {
      const view = viewFor('cumulativeLedger');
      assert.equal(view.effectiveMode, 'rigorous');

      assert.ok(view.checkpoint, 'checkpoint present');
      assert.equal(view.checkpoint.id, 'review-02');
      assert.equal(view.checkpoint.isDelta, true);
      assert.equal(view.checkpoint.reviewContextMode, 'focused_full_fallback');
      assert.equal(view.checkpoint.changedPathsCount, 2);

      assert.equal(view.codexUsage.runs.length, 2);
      assert.equal(view.codexUsage.totalTokens, 2400);
      assert.equal(view.codexUsage.totalDurationSeconds, 20.75);
      const enhance = view.codexUsage.runs.find((r) => r.phase === 'enhance');
      assert.equal(enhance?.totalTokens, 1300);
    });
  });
});
