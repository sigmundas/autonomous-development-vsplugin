import assert from 'node:assert/strict';
import { parseRunStateText } from '../src/runState';
import {
  evaluateWorkflow,
  type EvaluatorInput,
  type LatestReviewFacts
} from '../src/workflow/evaluator';
import type { RunState } from '../src/types';

function build(overrides: Record<string, unknown> = {}): RunState {
  const text = JSON.stringify({
    schema_version: 2,
    run_id: 'R1',
    status: 'active',
    phase: 'implementing',
    feature: 'demo',
    repository: { id: 'repo1' },
    max_review_rounds: 3,
    review_round: 0,
    artifacts: { enhance: 'feature-spec.codex.json' },
    verification: { checks: [] },
    reviews: [],
    adversarial_reviews: [],
    risk: { requires_adversarial_review: false, reasons: [] },
    ...overrides
  });
  const { state } = parseRunStateText(text);
  if (!state) {
    throw new Error('fixture state failed to parse');
  }
  return state;
}

function evaluate(state: RunState, extra: Partial<Omit<EvaluatorInput, 'state'>> = {}) {
  return evaluateWorkflow({
    state,
    acceptedSpecExists: extra.acceptedSpecExists ?? false,
    acceptedPlanExists: extra.acceptedPlanExists ?? false,
    ...(extra.latestReview ? { latestReview: extra.latestReview } : {})
  });
}

const passingReview: LatestReviewFacts = { readable: true, verdict: 'pass', severeFindingCount: 0 };

describe('evaluateWorkflow (integration)', () => {
  it('consumes authoritative deferred dispositions instead of requiring adversarial pass', () => {
    const completion = {
      result: 'ready_with_followups',
      source_review_round: 3,
      source_adversarial_round: 1,
      findings: [
        {
          source_phase: 'adversarial',
          source_round: 8,
          source_id: 'A-8-T-1',
          title: 'Legacy identity',
          disposition: 'FIX_LATER',
          relevant_acceptance_criteria: ['AC-1'],
          relevant_files: ['db.py'],
          recommended_verification: ['legacy test']
        },
        {
          source_phase: 'adversarial',
          source_round: 8,
          source_id: 'A-8-T-2',
          title: 'Crash recovery',
          disposition: 'FIX_LATER',
          relevant_acceptance_criteria: ['AC-1'],
          relevant_files: ['db.py'],
          recommended_verification: ['crash test']
        },
        {
          source_phase: 'adversarial',
          source_round: 8,
          source_id: 'A-8-T-3',
          title: 'Concurrent duplicates',
          disposition: 'FIX_LATER',
          relevant_acceptance_criteria: ['AC-1'],
          relevant_files: ['db.py'],
          recommended_verification: ['concurrency test']
        }
      ]
    };
    const active = build({
      phase: 'completion-evaluation',
      review_round: 3,
      verification: { checks: [{ name: 'focused', command: ['pytest'], exit_code: 0 }] },
      reviews: [{ round: 3, path: 'review-03.codex.json', verdict: 'pass' }],
      adversarial_reviews: [
        { round: 8, path: 'adversarial-08.codex.json', verdict: 'changes_required' }
      ],
      risk: { requires_adversarial_review: true, reasons: ['persistence'] },
      cumulative_acceptance_criteria: [
        { id: 'AC-1', status: 'satisfied', evidence: 'green', round: 3 }
      ],
      completion_evaluation: completion
    });
    const activeModel = evaluate(active, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: passingReview
    });
    assert.equal(activeModel.gatesPass, true);
    assert.equal(activeModel.recommendedNextAction.code, 'evaluate-report');
    assert.equal(activeModel.adversarial.latestRound, 8);
    assert.equal(activeModel.adversarial.latestVerdict, 'changes_required');
    assert.equal(activeModel.adversarial.satisfied, true);
    assert.equal(activeModel.completionEvaluation?.followUpCount, 3);

    const terminal = evaluate(
      build({
        ...JSON.parse(JSON.stringify(active.raw)),
        status: 'complete_with_followups',
        phase: 'complete_with_followups'
      }),
      { acceptedSpecExists: true, acceptedPlanExists: true, latestReview: passingReview }
    );
    assert.equal(terminal.status, 'complete_with_followups');
    assert.equal(terminal.isTerminal, true);
    assert.equal(terminal.gatesPass, true);
    assert.equal(terminal.recommendedNextAction.code, 'none');
  });

  it('derives a completion-ready run: gates pass, next action is evaluate-report', () => {
    const state = build({
      artifacts: { enhance: 'feature-spec.codex.json' },
      verification: { checks: [{ name: 'unit', command: ['t'], exit_code: 0 }] },
      reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }]
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: passingReview
    });
    assert.equal(model.gatesPass, true);
    assert.deepEqual(model.completionGateFailures, []);
    assert.equal(model.recommendedNextAction.code, 'evaluate-report');
    assert.equal(model.verification.passed, true);
    assert.equal(model.review.latestVerdict, 'pass');
  });

  it('parity nuance: verdict==pass + severe findings ⇒ gate fails (severe), next action stays evaluate-report', () => {
    const state = build({
      verification: { checks: [{ name: 'unit', command: ['t'], exit_code: 0 }] },
      reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }]
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: { readable: true, verdict: 'pass', severeFindingCount: 2 }
    });
    assert.equal(model.gatesPass, false);
    // A pass verdict + severe findings also trips the pass+blocking
    // contradiction (controller.py ~2548), even on the review-file fallback path.
    assert.deepEqual(
      model.completionGateFailures.map((f) => f.code),
      ['severe-findings', 'review-inconsistent-pass']
    );
    // next-action keys on verdict only (no cumulative ledger) ⇒ step 8.
    assert.equal(model.recommendedNextAction.code, 'evaluate-report');
  });

  it('computes review budget (consumed/remaining)', () => {
    const model = evaluate(build({ max_review_rounds: 3, review_round: 2 }));
    assert.deepEqual(model.reviewBudget, {
      originalMax: 3,
      max: 3,
      consumed: 2,
      remaining: 1
    });
  });

  it('adds only explicit per-run review authorizations to the effective budget', () => {
    const model = evaluate(
      build({
        max_review_rounds: 3,
        review_round: 3,
        review_round_authorizations: [{ additional_rounds: 1 }]
      })
    );
    assert.deepEqual(model.reviewBudget, {
      originalMax: 3,
      max: 4,
      consumed: 3,
      remaining: 1
    });
  });

  it('falls back to the run-state cached verdict for next-action when the review file is unreadable', () => {
    const state = build({
      verification: { checks: [{ name: 'unit', command: ['t'], exit_code: 0 }] },
      reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }]
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: { readable: false, severeFindingCount: 0 } // file unreadable
    });
    // Gate #6 strictly fails on unreadable...
    assert.ok(model.completionGateFailures.some((f) => f.code === 'review-not-pass'));
    // ...but next-action uses the cached "pass" verdict ⇒ evaluate-report.
    assert.equal(model.recommendedNextAction.code, 'evaluate-report');
  });

  it('marks a blocked run terminal with a blocking reason', () => {
    const model = evaluate(build({ status: 'blocked', phase: 'review-budget-exhausted' }));
    assert.equal(model.isTerminal, true);
    assert.equal(model.blockingReason, 'Review-round budget exhausted');
    assert.equal(model.recommendedNextAction.code, 'continue-blocked');
  });

  it('makes active review-budget exhaustion recoverable by explicit authorization', () => {
    const model = evaluate(build({ status: 'active', phase: 'review-budget-exhausted' }));
    assert.equal(model.isTerminal, false);
    assert.equal(model.recommendedNextAction.code, 'allow-review');
  });

  it('surfaces required adversarial review state', () => {
    const state = build({
      verification: { checks: [{ name: 'unit', command: ['t'], exit_code: 0 }] },
      reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }],
      risk: { requires_adversarial_review: true, reasons: ['security'] }
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: passingReview
    });
    assert.equal(model.adversarial.required, true);
    assert.equal(model.adversarial.satisfied, false);
    assert.equal(model.recommendedNextAction.code, 'adversarial-review');
    assert.ok(model.completionGateFailures.some((f) => f.code === 'adversarial-required'));
  });
});

describe('evaluateWorkflow cumulative ledger wiring (run-state v0.3.0)', () => {
  function ledgerState(overrides: Record<string, unknown> = {}): RunState {
    return build({
      verification: { checks: [{ name: 'unit', command: ['t'], exit_code: 0 }] },
      reviews: [{ round: 2, path: 'review-02.codex.json', verdict: 'pass', delta: true }],
      ...overrides
    });
  }

  it('a pass review with an open critical cumulative finding fails the gate AND routes to triage', () => {
    const state = ledgerState({
      cumulative_findings: [
        {
          id: 'F-1',
          severity: 'critical',
          category: 'security',
          status: 'open',
          description: 'unauthenticated webhook'
        }
      ]
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: { readable: true, verdict: 'pass', severeFindingCount: 0 }
    });
    const gateCodes = model.completionGateFailures.map((f) => f.code);
    assert.ok(gateCodes.includes('severe-findings'));
    assert.ok(gateCodes.includes('review-inconsistent-pass'));
    // cumulativeUnresolvedSevere overrides the pass verdict for next-action.
    assert.equal(model.recommendedNextAction.code, 'triage-findings');
    assert.equal(model.cumulativeFindings.blockingSevereCount, 1);
    assert.equal(model.cumulativeFindings.openCount, 1);
    assert.equal(model.cumulativeFindings.resolvedCount, 0);
    assert.ok(
      model.cumulativeFindings.blockingSevereDescription.startsWith('F-1 [critical/security]')
    );
  });

  it('a resolved cumulative finding does not block; provenance is surfaced', () => {
    const state = ledgerState({
      cumulative_findings: [
        {
          id: 'F-1',
          severity: 'critical',
          status: 'resolved',
          resolved_at_round: 2,
          resolution_source: 'review-02'
        }
      ],
      cumulative_acceptance_criteria: [{ id: 'AC-1', status: 'satisfied' }]
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: { readable: true, verdict: 'pass', severeFindingCount: 0 }
    });
    assert.equal(model.gatesPass, true);
    assert.deepEqual(model.completionGateFailures, []);
    assert.equal(model.recommendedNextAction.code, 'evaluate-report');
    assert.equal(model.cumulativeFindings.resolvedCount, 1);
    assert.equal(model.cumulativeFindings.resolved[0]?.resolutionSource, 'review-02');
    assert.equal(model.acceptanceCriteria.satisfiedCount, 1);
    assert.equal(model.acceptanceCriteria.blockingCount, 0);
  });

  it('a not_satisfied cumulative AC fails the gate with the AC code', () => {
    const state = ledgerState({
      cumulative_acceptance_criteria: [
        { id: 'AC-1', status: 'satisfied' },
        { id: 'AC-2', status: 'not_satisfied' }
      ]
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: { readable: true, verdict: 'pass', severeFindingCount: 0 }
    });
    const gateCodes = model.completionGateFailures.map((f) => f.code);
    assert.ok(gateCodes.includes('acceptance-criteria-unsatisfied'));
    assert.ok(gateCodes.includes('review-inconsistent-pass'));
    assert.equal(model.acceptanceCriteria.blockingCount, 1);
    assert.ok(model.acceptanceCriteria.blockingDescription.includes('AC-2 [not_satisfied]'));
  });

  it('surfaces the latest checkpoint (changed-path count, context mode, delta) and codex usage totals', () => {
    const state = ledgerState({
      effective_mode: 'rigorous',
      reviews: [
        {
          round: 2,
          path: 'review-02.codex.json',
          verdict: 'pass',
          delta: true,
          checkpoint: {
            id: 'review-02',
            changed_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
            path_fingerprints: {},
            review_context_mode: 'focused_full_fallback'
          }
        }
      ],
      codex_runs: [
        {
          phase: 'review',
          prompt_characters: 1000,
          output_characters: 2000,
          duration_seconds: 5,
          tokens: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
        },
        {
          phase: 'plan',
          prompt_characters: 500,
          output_characters: 700,
          duration_seconds: 2.5,
          tokens: { input_tokens: 5, output_tokens: 7, total_tokens: 12 }
        }
      ]
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: passingReview
    });
    assert.equal(model.checkpoint?.id, 'review-02');
    assert.equal(model.checkpoint?.changedPathsCount, 3);
    assert.equal(model.checkpoint?.reviewContextMode, 'focused_full_fallback');
    assert.equal(model.checkpoint?.isDelta, true);
    assert.equal(model.effectiveMode, 'rigorous');
    assert.equal(model.codexUsage.totalPromptCharacters, 1500);
    assert.equal(model.codexUsage.totalOutputCharacters, 2700);
    assert.equal(model.codexUsage.totalDurationSeconds, 7.5);
    assert.equal(model.codexUsage.totalTokens, 42);
    assert.equal(model.codexUsage.runs.length, 2);
  });

  it('a malformed (non-object) cumulative finding blocks the gate (fail closed)', () => {
    const state = ledgerState({ cumulative_findings: ['corrupt-entry'] });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: { readable: true, verdict: 'pass', severeFindingCount: 0 }
    });
    assert.ok(model.completionGateFailures.some((f) => f.code === 'severe-findings'));
    assert.equal(model.cumulativeFindings.blockingSevereCount, 1);
  });
});

describe('evaluateWorkflow stage timeline', () => {
  it('marks a freshly-initialized run active at idea-enhanced when enhance is absent (rigorous)', () => {
    // Mode-aware next action only routes to enhance in rigorous mode
    // (controller.py ~3125); otherwise an un-enhanced run reconciles the spec.
    const model = evaluate(
      build({ phase: 'initialized', artifacts: {}, effective_mode: 'rigorous' })
    );
    const byId = Object.fromEntries(model.stages.map((s) => [s.id, s.status]));
    assert.equal(byId['initialized'], 'complete');
    assert.equal(byId['idea-enhanced'], 'active');
    assert.equal(byId['final'], 'pending');
  });

  it('skips the adversarial stage when not required', () => {
    const model = evaluate(build());
    const adversarial = model.stages.find((s) => s.id === 'adversarial-review');
    assert.equal(adversarial?.status, 'skipped');
  });

  it('marks verification failed when checks exist but fail', () => {
    const state = build({
      verification: { checks: [{ name: 'unit', command: ['t'], exit_code: 1 }] }
    });
    const model = evaluate(state, { acceptedSpecExists: true, acceptedPlanExists: true });
    const verification = model.stages.find((s) => s.id === 'verification');
    assert.equal(verification?.status, 'failed');
  });

  it('marks every stage complete for a complete run (adversarial skipped if not required)', () => {
    const state = build({
      status: 'complete',
      phase: 'complete',
      verification: { checks: [{ name: 'unit', command: ['t'], exit_code: 0 }] },
      reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }]
    });
    const model = evaluate(state, {
      acceptedSpecExists: true,
      acceptedPlanExists: true,
      latestReview: passingReview
    });
    for (const stage of model.stages) {
      if (stage.id === 'adversarial-review') {
        assert.equal(stage.status, 'skipped');
      } else {
        assert.equal(stage.status, 'complete', `${stage.id} should be complete`);
      }
    }
  });

  it('marks the final stage cancelled for a cancelled run', () => {
    const model = evaluate(build({ status: 'cancelled', phase: 'cancelled' }));
    assert.equal(model.stages.find((s) => s.id === 'final')?.status, 'cancelled');
  });
});
