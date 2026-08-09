/**
 * The 12-stage *workflow* timeline (distinct from the protocol event timeline).
 * Derived from the same facts the evaluator uses, so the dashboard, tree, and
 * status bar never disagree about where a run is.
 */

import type { RunStatus } from '../types';
import type { NextActionCode } from './nextAction';

export type StageStatus =
  | 'complete'
  | 'active'
  | 'pending'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'skipped';

export type StageId =
  | 'initialized'
  | 'idea-enhanced'
  | 'spec-accepted'
  | 'plan-proposed'
  | 'plan-accepted'
  | 'implementing'
  | 'verification'
  | 'independent-review'
  | 'triage'
  | 'adversarial-review'
  | 'completion-evaluation'
  | 'final';

export interface WorkflowStage {
  readonly id: StageId;
  readonly title: string;
  readonly status: StageStatus;
  readonly detail?: string;
}

export interface StageFacts {
  readonly status: RunStatus;
  readonly hasEnhance: boolean;
  readonly acceptedSpecExists: boolean;
  readonly hasPlan: boolean;
  readonly acceptedPlanExists: boolean;
  readonly hasChecks: boolean;
  readonly verificationPassed: boolean;
  readonly hasReviews: boolean;
  readonly reviewPassed: boolean;
  /** Latest completed review round, when one has been recorded. */
  readonly latestReviewRound?: number;
  /** Effective verdict for the latest completed review. */
  readonly latestReviewVerdict?: string;
  readonly severeFindingCount: number;
  readonly requiresAdversarial: boolean;
  readonly hasAdversarial: boolean;
  readonly adversarialPassed: boolean;
  readonly nextActionCode: NextActionCode;
  /**
   * The controller's authoritative phase string, verbatim from run-state.json.
   * When provided, this drives the "active" stage rather than the array-index
   * heuristic — so `plan-accepted` correctly renders Implementing as active
   * even though no verification checks have run yet.
   */
  readonly controllerPhase?: string;
}

/**
 * Map the controller's authoritative phase string to the timeline stage that
 * should be marked ACTIVE for a non-terminal run. Returns `undefined` for
 * terminal statuses or when we don't recognize the phase — callers then fall
 * back to next-action-derived mapping.
 *
 * This mapping is intentionally exhaustive over the phase vocabulary the
 * controller emits today (see quaat/autonomous-development scripts/controller.py):
 *   initialized, enhance, idea-enhanced, spec-accepted, plan-proposed,
 *   plan-accepted, implementing, verification, verification-failed,
 *   review, independent-review, triage, adversarial, adversarial-review,
 *   completion-evaluation, complete, cancelled, blocked, archived,
 *   review-budget-exhausted.
 */
export function stageForControllerPhase(
  phase: string | undefined,
  status: RunStatus
): StageId | undefined {
  if (status === 'complete' || status === 'cancelled' || status === 'archived') {
    return undefined;
  }
  if (!phase || phase.length === 0) return undefined;
  switch (phase) {
    case 'initialized':
      return 'idea-enhanced';
    case 'enhance':
    case 'enhancing':
      return 'idea-enhanced';
    case 'idea-enhanced':
      return 'spec-accepted';
    case 'spec-accepted':
      return 'plan-proposed';
    case 'plan-proposed':
      return 'plan-accepted';
    case 'plan-accepted':
      // Accepted plan → Claude implements next. Verification is not active yet.
      return 'implementing';
    case 'implementing':
      return 'implementing';
    case 'verification':
    case 'verification-failed':
      return 'verification';
    case 'review':
    case 'independent-review':
    case 'reviewing':
      return 'independent-review';
    case 'triage':
      return 'triage';
    case 'adversarial':
    case 'adversarial-review':
      return 'adversarial-review';
    case 'completion-evaluation':
      return 'completion-evaluation';
    case 'review-budget-exhausted':
    case 'blocked':
      return undefined;
    default:
      return undefined;
  }
}

const STAGE_ORDER: ReadonlyArray<{ id: StageId; title: string }> = [
  { id: 'initialized', title: 'Initialized' },
  { id: 'idea-enhanced', title: 'Idea Enhanced' },
  { id: 'spec-accepted', title: 'Specification Accepted' },
  { id: 'plan-proposed', title: 'Plan Proposed' },
  { id: 'plan-accepted', title: 'Plan Accepted' },
  { id: 'implementing', title: 'Implementing' },
  { id: 'verification', title: 'Verification' },
  { id: 'independent-review', title: 'Independent Review' },
  { id: 'triage', title: 'Finding Triage and Fixes' },
  { id: 'adversarial-review', title: 'Adversarial Review' },
  { id: 'completion-evaluation', title: 'Completion Evaluation' },
  { id: 'final', title: 'Complete, Blocked, or Cancelled' }
];

/** Stage that the recommended next action targets (the "active" stage). */
const NEXT_ACTION_STAGE: Readonly<Record<NextActionCode, StageId>> = {
  'run-enhance': 'idea-enhanced',
  'reconcile-spec': 'spec-accepted',
  'reconcile-plan': 'plan-accepted',
  'run-verification': 'verification',
  'fix-verification': 'verification',
  'run-review': 'independent-review',
  'triage-findings': 'triage',
  'adversarial-review': 'adversarial-review',
  'evaluate-report': 'completion-evaluation',
  'allow-review': 'independent-review',
  'continue-blocked': 'final',
  'resume-adversarial': 'adversarial-review',
  blocked: 'final',
  none: 'final'
};

/** Evidence that each stage's primary deliverable is complete. */
function reached(id: StageId, f: StageFacts): boolean {
  switch (id) {
    case 'initialized':
      return true;
    case 'idea-enhanced':
      return f.hasEnhance;
    case 'spec-accepted':
      return f.acceptedSpecExists;
    case 'plan-proposed':
      return f.hasPlan;
    case 'plan-accepted':
      return f.acceptedPlanExists;
    case 'implementing':
      // Implementation is "done enough" once verification has been attempted.
      return f.hasChecks;
    case 'verification':
      return f.hasChecks && f.verificationPassed;
    case 'independent-review':
      // A review remains historical fact even when its verdict requires fixes.
      // Whether another review is needed is represented by the active state and
      // detail below, not by pretending the completed round never happened.
      return f.hasReviews;
    case 'triage':
      return f.hasReviews && f.reviewPassed && f.severeFindingCount === 0;
    case 'adversarial-review':
      return !f.requiresAdversarial || (f.hasAdversarial && f.adversarialPassed);
    case 'completion-evaluation':
      return f.status === 'complete';
    case 'final':
      return f.status === 'complete';
  }
}

function indexOf(id: StageId): number {
  return STAGE_ORDER.findIndex((s) => s.id === id);
}

export function deriveStages(f: StageFacts): WorkflowStage[] {
  const terminalBlocked = f.status === 'blocked';
  const terminalCancelled = f.status === 'cancelled';
  const terminalArchived = f.status === 'archived';
  const isComplete = f.status === 'complete';
  const halted = terminalBlocked || terminalCancelled;

  // Active-stage resolution: reconcile the controller's authoritative phase
  // (from run-state.json) with the evaluator's next-action code. Both are
  // authoritative for different questions — the phase reports where the
  // controller thinks the run is; next-action reports what the workflow gate
  // logic says should happen next given the artifacts on disk. When the two
  // disagree (e.g. controller wrote phase = "implementing" as an initial default
  // but no enhance artifact exists yet), the EARLIER stage wins: forward
  // progress requires every earlier stage's evidence, so we must not paint the
  // timeline as ahead of the actual artifacts.
  //
  // Never infer the active stage by "everything before this index is done" —
  // the completion of each stage is decided independently by reached().
  let activeStageId: StageId | undefined;
  if (!(halted || isComplete || terminalArchived)) {
    const phaseStage = stageForControllerPhase(f.controllerPhase, f.status);
    const nextActionStage: StageId | undefined = NEXT_ACTION_STAGE[f.nextActionCode];
    if (phaseStage && nextActionStage) {
      const phaseIdx = indexOf(phaseStage);
      const nextIdx = indexOf(nextActionStage);
      // Earlier stage wins so the UI never overtakes the actual evidence.
      activeStageId = phaseIdx <= nextIdx ? phaseStage : nextActionStage;
    } else {
      activeStageId = phaseStage ?? nextActionStage;
    }
  }
  const activeIndex = activeStageId !== undefined ? indexOf(activeStageId) : -1;

  // Stop point for halted runs: the first incomplete, non-skipped stage.
  let haltIndex = STAGE_ORDER.length - 1;
  if (halted) {
    for (let i = 0; i < STAGE_ORDER.length; i++) {
      const stage = STAGE_ORDER[i];
      if (!stage) continue;
      if (stage.id === 'adversarial-review' && !f.requiresAdversarial) continue;
      if (stage.id === 'final') continue;
      if (!reached(stage.id, f)) {
        haltIndex = i;
        break;
      }
    }
  }

  return STAGE_ORDER.map((stage, i): WorkflowStage => {
    const base = { id: stage.id, title: stage.title };

    if (stage.id === 'idea-enhanced' && !f.hasEnhance && f.acceptedSpecExists) {
      return { ...base, status: 'skipped', detail: 'Not run' };
    }

    if (stage.id === 'adversarial-review' && !f.requiresAdversarial) {
      return { ...base, status: 'skipped', detail: 'Not required by risk gate' };
    }

    if (stage.id === 'final') {
      if (isComplete) return { ...base, status: 'complete' };
      if (terminalBlocked) return { ...base, status: 'blocked' };
      if (terminalCancelled) return { ...base, status: 'cancelled' };
      if (terminalArchived) {
        return { ...base, status: reached('completion-evaluation', f) ? 'complete' : 'skipped' };
      }
      return { ...base, status: 'pending' };
    }

    if (stage.id === 'independent-review' && f.hasReviews) {
      const round = f.latestReviewRound;
      const verdict = displayVerdict(f.latestReviewVerdict);
      const history = [round !== undefined ? `Round ${round}` : 'Review completed', verdict]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
      if (i === activeIndex) {
        const suffix =
          f.controllerPhase === 'review' || f.controllerPhase === 'reviewing'
            ? 're-review in progress'
            : 're-review required';
        return { ...base, status: 'active', detail: `${history} · ${suffix}` };
      }
      return { ...base, status: 'complete', detail: history };
    }

    if (stage.id === 'triage' && i === activeIndex && f.hasReviews) {
      const round = f.latestReviewRound;
      const verdict = displayVerdict(f.latestReviewVerdict);
      const detail = [round !== undefined ? `After round ${round}` : undefined, verdict]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
      return { ...base, status: 'active', ...(detail ? { detail } : {}) };
    }

    if (reached(stage.id, f)) {
      return { ...base, status: 'complete' };
    }

    if (isComplete) {
      // Complete run with an un-evidenced earlier stage: treat as complete.
      return { ...base, status: 'complete' };
    }

    if (terminalArchived) {
      return { ...base, status: 'skipped' };
    }

    if (halted) {
      if (i === haltIndex) {
        return { ...base, status: terminalBlocked ? 'blocked' : 'cancelled' };
      }
      return { ...base, status: 'skipped' };
    }

    // Verification is a special call-out: whenever checks have been run and
    // did not all pass, the timeline should show it as failed regardless of
    // whether it is the currently "active" stage — the failing state is what
    // the user needs to see.
    if (stage.id === 'verification' && f.hasChecks && !f.verificationPassed) {
      return { ...base, status: 'failed' };
    }

    // Active (non-terminal) run — the "active" stage is decided above by the
    // phase + next-action reconciliation; every other unreached stage stays
    // pending.
    if (i === activeIndex) {
      return { ...base, status: 'active' };
    }
    return { ...base, status: 'pending' };
  });
}

function displayVerdict(verdict: string | undefined): string | undefined {
  const value = verdict?.trim();
  return value ? value.replaceAll('_', ' ') : undefined;
}
