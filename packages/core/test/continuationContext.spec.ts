import assert from 'node:assert/strict';

import { parseContinuationContextText } from '../src/continuationContext';

describe('parseContinuationContextText', () => {
  it('preserves the bounded resume fields without requiring review history', () => {
    const parsed = parseContinuationContextText(
      JSON.stringify({
        run_id: 'R1',
        parent_run_id: 'P1',
        feature: 'Feature',
        accepted_scope_summary: 'Early scope',
        phase: 'completion-evaluation',
        status: 'active',
        latest_verification: { total: 2, passed: 2 },
        regular_review: { round: 3, verdict: 'pass' },
        adversarial_review: { round: 8, verdict: 'changes_required' },
        open_must_fix_now: [],
        deferred_follow_ups: [{ id: 'FU-001' }],
        stale_or_unsatisfied_acceptance_criteria: [],
        review_budget: { consumed: 3, snapshotted: 3, effective: 3 },
        recommended_next_action: { phase: 'completion-evaluation' }
      })
    );
    assert.equal(parsed?.runId, 'R1');
    assert.equal(parsed?.adversarialReview?.['round'], 8);
    assert.equal(parsed?.deferredFollowUps.length, 1);
  });

  it('rejects malformed or identity-free responses', () => {
    assert.equal(parseContinuationContextText('{bad'), undefined);
    assert.equal(parseContinuationContextText('{}'), undefined);
  });
});
