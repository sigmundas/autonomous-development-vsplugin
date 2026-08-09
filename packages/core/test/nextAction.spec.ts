import assert from 'node:assert/strict';
import { recommendNextAction, type NextActionFacts } from '../src/workflow/nextAction';

function ready(overrides: Partial<NextActionFacts> = {}): NextActionFacts {
  // A run that satisfies every stop_gate step ⇒ step 8 (evaluate + report).
  return {
    status: 'active',
    hasEnhance: true,
    acceptedSpecExists: true,
    acceptedPlanExists: true,
    hasChecks: true,
    verificationPassed: true,
    hasReviews: true,
    effectiveReviewVerdict: 'pass',
    requiresAdversarial: false,
    hasAdversarial: false,
    ...overrides
  };
}

const code = (f: NextActionFacts): string => recommendNextAction(f).code;

describe('recommendNextAction (stop_gate.py:reason_for parity, REFERENCE §7)', () => {
  it('step 1: missing accepted-spec ⇒ reconcile-spec', () => {
    assert.equal(code(ready({ acceptedSpecExists: false })), 'reconcile-spec');
  });

  it('step 2: missing accepted-plan ⇒ reconcile-plan', () => {
    assert.equal(code(ready({ acceptedPlanExists: false })), 'reconcile-plan');
  });

  it('step 3: no verification checks ⇒ run-verification', () => {
    assert.equal(code(ready({ hasChecks: false, verificationPassed: false })), 'run-verification');
  });

  it('step 4: failing checks ⇒ fix-verification', () => {
    assert.equal(code(ready({ verificationPassed: false })), 'fix-verification');
  });

  it('step 5: no reviews ⇒ run-review', () => {
    assert.equal(
      code(ready({ hasReviews: false, effectiveReviewVerdict: undefined })),
      'run-review'
    );
  });

  it('step 6: latest review not pass ⇒ triage-findings', () => {
    assert.equal(code(ready({ effectiveReviewVerdict: 'changes_required' })), 'triage-findings');
  });

  it('step 7: adversarial required and missing ⇒ adversarial-review', () => {
    assert.equal(
      code(ready({ requiresAdversarial: true, hasAdversarial: false })),
      'adversarial-review'
    );
  });

  it('step 7: adversarial required and not pass ⇒ adversarial-review', () => {
    assert.equal(
      code(
        ready({
          requiresAdversarial: true,
          hasAdversarial: true,
          latestAdversarialVerdict: 'changes_required'
        })
      ),
      'adversarial-review'
    );
  });

  it('step 8: everything satisfied ⇒ evaluate-report', () => {
    assert.equal(code(ready()), 'evaluate-report');
    assert.equal(
      code(
        ready({ requiresAdversarial: true, hasAdversarial: true, latestAdversarialVerdict: 'pass' })
      ),
      'evaluate-report'
    );
  });

  it('parity nuance: verdict==pass + severe findings still yields step 8 (stop_gate keys on verdict only)', () => {
    // severeFindingCount is NOT a nextAction input; the gate handles it separately.
    assert.equal(code(ready({ effectiveReviewVerdict: 'pass' })), 'evaluate-report');
  });

  it('ordering: earliest unmet step wins', () => {
    // spec AND plan AND reviews all missing ⇒ spec (step 1) wins.
    assert.equal(
      code(ready({ acceptedSpecExists: false, acceptedPlanExists: false, hasReviews: false })),
      'reconcile-spec'
    );
  });
});

describe('recommendNextAction defensive front-extensions (REFERENCE §7)', () => {
  it('cancelled ⇒ none', () => {
    assert.equal(code(ready({ status: 'cancelled', acceptedSpecExists: false })), 'none');
  });

  it('archived ⇒ none', () => {
    assert.equal(code(ready({ status: 'archived' })), 'none');
  });

  it('complete ⇒ none', () => {
    assert.equal(code(ready({ status: 'complete' })), 'none');
  });

  it('blocked ⇒ linked continuation guidance', () => {
    assert.equal(code(ready({ status: 'blocked' })), 'continue-blocked');
  });

  it('active review-budget exhaustion ⇒ explicit +1 authorization', () => {
    assert.equal(
      code(ready({ status: 'active', phase: 'review-budget-exhausted' })),
      'allow-review'
    );
  });

  it('rigorous mode + no enhance artifact ⇒ run-enhance (precedes reconcile-spec)', () => {
    assert.equal(
      code(ready({ effectiveMode: 'rigorous', hasEnhance: false, acceptedSpecExists: false })),
      'run-enhance'
    );
  });

  it('terminal precedence beats unmet steps', () => {
    // cancelled wins even though spec/plan are missing.
    assert.equal(
      code(ready({ status: 'cancelled', acceptedSpecExists: false, acceptedPlanExists: false })),
      'none'
    );
  });
});

describe('recommendNextAction mode awareness (controller.py compute_next_action)', () => {
  it('rigorous mode + no spec + no enhance ⇒ run-enhance', () => {
    assert.equal(
      code(ready({ effectiveMode: 'rigorous', acceptedSpecExists: false, hasEnhance: false })),
      'run-enhance'
    );
  });

  it('rigorous mode + no spec but enhance already present ⇒ reconcile-spec', () => {
    assert.equal(
      code(ready({ effectiveMode: 'rigorous', acceptedSpecExists: false, hasEnhance: true })),
      'reconcile-spec'
    );
  });

  it('standard mode + no spec ⇒ reconcile-spec (NOT enhance), even without an enhance artifact', () => {
    assert.equal(
      code(ready({ effectiveMode: 'standard', acceptedSpecExists: false, hasEnhance: false })),
      'reconcile-spec'
    );
  });

  it('lean mode + no spec ⇒ reconcile-spec', () => {
    assert.equal(
      code(ready({ effectiveMode: 'lean', acceptedSpecExists: false, hasEnhance: false })),
      'reconcile-spec'
    );
  });

  it('absent mode + no spec ⇒ reconcile-spec (default is not rigorous)', () => {
    assert.equal(code(ready({ acceptedSpecExists: false, hasEnhance: false })), 'reconcile-spec');
  });

  it('step 5: pass review but cumulativeUnresolvedSevere ⇒ triage-findings', () => {
    assert.equal(
      code(ready({ effectiveReviewVerdict: 'pass', cumulativeUnresolvedSevere: true })),
      'triage-findings'
    );
  });

  it('step 5: pass review + no cumulative severe ⇒ proceeds past review', () => {
    assert.equal(
      code(ready({ effectiveReviewVerdict: 'pass', cumulativeUnresolvedSevere: false })),
      'evaluate-report'
    );
  });
});
