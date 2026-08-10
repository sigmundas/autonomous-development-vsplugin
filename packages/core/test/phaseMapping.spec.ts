import assert from 'node:assert/strict';

import { deriveStages, stageForControllerPhase, type StageFacts } from '../src/workflow/stages';

/**
 * Baseline facts for a "plan just accepted, nothing implemented yet" run. The
 * controller has written phase = 'plan-accepted' and no verification/review
 * artifacts exist. The dashboard MUST show Implementing as the active stage
 * and Verification as pending.
 */
function planAcceptedFacts(): StageFacts {
  return {
    status: 'active',
    hasEnhance: true,
    acceptedSpecExists: true,
    hasPlan: true,
    acceptedPlanExists: true,
    hasChecks: false,
    verificationPassed: false,
    hasReviews: false,
    reviewPassed: false,
    severeFindingCount: 0,
    requiresAdversarial: false,
    hasAdversarial: false,
    adversarialPassed: false,
    // The evaluator would resolve this to `run-verification` because there are
    // no verification checks yet — that's the exact bug this mapping fixes:
    // the AUTHORITATIVE phase from the controller is `plan-accepted`, so the
    // active stage must be Implementing, not Verification.
    nextActionCode: 'run-verification',
    controllerPhase: 'plan-accepted'
  };
}

describe('stageForControllerPhase (explicit controller phase → stage)', () => {
  it('maps plan-accepted to Implementing', () => {
    assert.equal(stageForControllerPhase('plan-accepted', 'active'), 'implementing');
  });
  it('maps initialized to Idea Enhanced', () => {
    assert.equal(stageForControllerPhase('initialized', 'active'), 'idea-enhanced');
  });
  it('maps spec-accepted to Plan Proposed', () => {
    assert.equal(stageForControllerPhase('spec-accepted', 'active'), 'plan-proposed');
  });
  it('maps implementing to Implementing (identity)', () => {
    assert.equal(stageForControllerPhase('implementing', 'active'), 'implementing');
  });
  it('maps verification and verification-failed to Verification', () => {
    assert.equal(stageForControllerPhase('verification', 'active'), 'verification');
    assert.equal(stageForControllerPhase('verification-failed', 'active'), 'verification');
  });
  it('maps review to Independent Review', () => {
    assert.equal(stageForControllerPhase('review', 'active'), 'independent-review');
  });
  it('maps adversarial/adversarial-review to Adversarial Review', () => {
    assert.equal(stageForControllerPhase('adversarial', 'active'), 'adversarial-review');
    assert.equal(stageForControllerPhase('adversarial-review', 'active'), 'adversarial-review');
  });
  it('returns undefined for terminal statuses', () => {
    assert.equal(stageForControllerPhase('implementing', 'complete'), undefined);
    assert.equal(stageForControllerPhase('implementing', 'cancelled'), undefined);
    assert.equal(stageForControllerPhase('implementing', 'archived'), undefined);
  });
  it('returns undefined for review-budget-exhausted / blocked (no active stage)', () => {
    assert.equal(stageForControllerPhase('review-budget-exhausted', 'active'), undefined);
    assert.equal(stageForControllerPhase('blocked', 'active'), undefined);
  });
});

describe('deriveStages under plan-accepted (regression)', () => {
  const stages = deriveStages(planAcceptedFacts());
  const byId = new Map(stages.map((s) => [s.id, s]));

  it('Implementing is ACTIVE', () => {
    assert.equal(byId.get('implementing')?.status, 'active');
  });
  it('Verification is PENDING', () => {
    assert.equal(byId.get('verification')?.status, 'pending');
  });
  it('Plan Accepted (and earlier reached stages) are COMPLETE', () => {
    assert.equal(byId.get('plan-accepted')?.status, 'complete');
    assert.equal(byId.get('plan-proposed')?.status, 'complete');
    assert.equal(byId.get('spec-accepted')?.status, 'complete');
    assert.equal(byId.get('idea-enhanced')?.status, 'complete');
  });
  it('no un-reached later stage is marked complete by array-index heuristic', () => {
    assert.equal(byId.get('independent-review')?.status, 'pending');
    assert.equal(byId.get('completion-evaluation')?.status, 'pending');
  });
});

describe('deriveStages under fresh initialized run (no artifacts)', () => {
  const facts: StageFacts = {
    ...planAcceptedFacts(),
    hasEnhance: false,
    acceptedSpecExists: false,
    hasPlan: false,
    acceptedPlanExists: false,
    nextActionCode: 'run-enhance',
    controllerPhase: 'initialized'
  };
  const byId = new Map(deriveStages(facts).map((s) => [s.id, s]));
  it('Idea Enhanced is active', () => {
    assert.equal(byId.get('idea-enhanced')?.status, 'active');
  });
  it('Verification/Implementing stay pending', () => {
    assert.equal(byId.get('implementing')?.status, 'pending');
    assert.equal(byId.get('verification')?.status, 'pending');
  });
});

describe('deriveStages under verification (checks failed)', () => {
  const facts: StageFacts = {
    ...planAcceptedFacts(),
    hasChecks: true,
    verificationPassed: false,
    nextActionCode: 'fix-verification',
    controllerPhase: 'verification-failed'
  };
  const byId = new Map(deriveStages(facts).map((s) => [s.id, s]));
  it('Verification is FAILED (not active) when checks ran but did not pass', () => {
    assert.equal(byId.get('verification')?.status, 'failed');
  });
});

describe('deriveStages when controllerPhase is unknown (fallback)', () => {
  // Legacy runs may have an unknown / missing controllerPhase — the evaluator's
  // nextAction mapping must still drive the active stage. Construct a run where
  // artifacts prove we are between plan-proposed and plan-accepted (proposed
  // plan exists but not yet accepted) so reconcile-plan is the natural next
  // action and the target stage isn't already 'reached'.
  const facts: StageFacts = {
    ...planAcceptedFacts(),
    acceptedPlanExists: false,
    controllerPhase: undefined,
    nextActionCode: 'reconcile-plan'
  };
  const byId = new Map(deriveStages(facts).map((s) => [s.id, s]));
  it('falls back to next-action mapping (reconcile-plan → Plan Accepted active)', () => {
    assert.equal(byId.get('plan-accepted')?.status, 'active');
  });
  it('Plan Proposed is complete (proposed plan exists)', () => {
    assert.equal(byId.get('plan-proposed')?.status, 'complete');
  });
});

describe('deriveStages review history', () => {
  it('keeps a completed changes-required review complete while triage is active', () => {
    const facts: StageFacts = {
      ...planAcceptedFacts(),
      hasChecks: true,
      verificationPassed: true,
      hasReviews: true,
      reviewPassed: false,
      latestReviewRound: 2,
      latestReviewVerdict: 'changes_required',
      severeFindingCount: 1,
      controllerPhase: 'triage',
      nextActionCode: 'triage-findings'
    };
    const byId = new Map(deriveStages(facts).map((stage) => [stage.id, stage]));
    assert.deepEqual(byId.get('independent-review'), {
      id: 'independent-review',
      title: 'Independent Review',
      status: 'complete',
      detail: 'Round 2 · changes required'
    });
    assert.deepEqual(byId.get('triage'), {
      id: 'triage',
      title: 'Finding Triage and Fixes',
      status: 'active',
      detail: 'After round 2 · changes required'
    });
  });

  it('shows a repeated review as active without erasing the prior round', () => {
    const facts: StageFacts = {
      ...planAcceptedFacts(),
      hasChecks: true,
      verificationPassed: true,
      hasReviews: true,
      reviewPassed: false,
      latestReviewRound: 2,
      latestReviewVerdict: 'changes_required',
      severeFindingCount: 1,
      controllerPhase: 'review',
      nextActionCode: 'triage-findings'
    };
    const review = deriveStages(facts).find((stage) => stage.id === 'independent-review');
    assert.equal(review?.status, 'active');
    assert.equal(review?.detail, 'Round 2 · changes required · re-review in progress');
  });
});

describe('deriveStages skipped enhancement', () => {
  it('marks enhancement not run when an accepted specification proves the workflow advanced', () => {
    const facts: StageFacts = { ...planAcceptedFacts(), hasEnhance: false };
    const enhancement = deriveStages(facts).find((stage) => stage.id === 'idea-enhanced');
    assert.deepEqual(enhancement, {
      id: 'idea-enhanced',
      title: 'Idea Enhanced',
      status: 'skipped',
      detail: 'Not run'
    });
  });
});
