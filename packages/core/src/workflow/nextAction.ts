/**
 * Recommended next action — the single derivation consumed by tree, dashboard,
 * status bar, and commands (docs/REFERENCE.md §7).
 *
 * Mirrors `controller.py:compute_next_action` (mode-aware, ~lines 3103-3202),
 * first match wins. The front of the list is extended defensively for
 * terminal/early states that stop_gate never sees but that the extension must
 * still render; these never contradict the controller.
 *
 * Mode awareness: when no accepted spec exists, the controller only routes to
 * `enhance` when `effective_mode == "rigorous"` AND no enhance artifact exists;
 * every other mode goes straight to the specification step. Step 5 additionally
 * routes to review when the cumulative ledger still has unresolved severe
 * findings, even if the latest verdict is `pass`.
 */

import type { RunStatus } from '../types';

export type NextActionCode =
  | 'none'
  | 'blocked'
  | 'allow-review'
  | 'continue-blocked'
  | 'resume-adversarial'
  | 'run-enhance'
  | 'reconcile-spec'
  | 'reconcile-plan'
  | 'run-verification'
  | 'fix-verification'
  | 'run-review'
  | 'triage-findings'
  | 'adversarial-review'
  | 'completion-disposition'
  | 'await-human-decision'
  | 'evaluate-report';

export interface NextAction {
  readonly code: NextActionCode;
  readonly message: string;
}

const MESSAGES: Readonly<Record<NextActionCode, string>> = {
  none: '',
  blocked: 'Review the blocking reason and preserve or archive the run',
  'allow-review': 'Allow one additional confirmation review for this run',
  'continue-blocked': 'Continue remaining findings in a linked follow-up run',
  'resume-adversarial': 'Continue in a linked follow-up and run the missing adversarial review',
  'run-enhance': 'Run Codex enhance',
  'reconcile-spec': 'Reconcile the Codex proposal and create accepted-spec.md',
  'reconcile-plan': 'Reconcile the Codex plan and create accepted-plan.md',
  'run-verification': 'Run and record relevant verification checks',
  'fix-verification': 'Fix the failing verification checks and rerun them',
  'run-review': 'Run the independent Codex code review',
  'triage-findings': 'Triage the latest Codex findings, fix valid issues, verify, and re-review',
  'adversarial-review': 'Complete the required adversarial review and address valid risks',
  'completion-disposition': 'Disposition every remaining review and adversarial finding',
  'await-human-decision': 'Await the recorded human product or authority decision',
  'evaluate-report':
    'Run the controller completion-gate evaluation and provide the final implementation report'
};

export function nextAction(code: NextActionCode): NextAction {
  return { code, message: MESSAGES[code] };
}

export interface NextActionFacts {
  readonly status: RunStatus;
  readonly phase?: string;
  readonly hasEnhance: boolean;
  readonly acceptedSpecExists: boolean;
  readonly acceptedPlanExists: boolean;
  readonly hasChecks: boolean;
  readonly verificationPassed: boolean;
  readonly hasReviews: boolean;
  /** Verdict used for step 5: file verdict when readable, else run-state cache. */
  readonly effectiveReviewVerdict?: string;
  /**
   * Effective workflow mode (auto | lean | standard | rigorous). Only `rigorous`
   * routes a missing spec to the `enhance` step; everything else (and an absent
   * mode) goes straight to the specification step (controller.py ~3106, ~3125).
   */
  readonly effectiveMode?: string;
  /**
   * Whether the cumulative ledger still has unresolved severe (critical/high)
   * findings. Routes to review even when the latest verdict is `pass`
   * (controller.py ~3176).
   */
  readonly cumulativeUnresolvedSevere?: boolean;
  readonly blockingAcceptanceCriteria?: boolean;
  readonly requiresAdversarial: boolean;
  readonly hasAdversarial: boolean;
  readonly latestAdversarialVerdict?: string;
  readonly completionEvaluationResult?: string;
  readonly awaitingHumanDecision?: boolean;
}

function isPass(verdict: string | undefined): boolean {
  return verdict !== undefined && verdict.trim().toLowerCase() === 'pass';
}

export function recommendNextAction(f: NextActionFacts): NextAction {
  // Defensive front extensions (no controller equivalent; never contradict it).
  if (
    f.status === 'cancelled' ||
    f.status === 'archived' ||
    f.status === 'complete' ||
    f.status === 'complete_with_followups'
  ) {
    return nextAction('none');
  }
  if (f.phase === 'review-budget-exhausted' && f.status === 'active') {
    return nextAction('allow-review');
  }
  if (f.status === 'blocked') {
    if (f.requiresAdversarial && (!f.hasAdversarial || !isPass(f.latestAdversarialVerdict))) {
      return nextAction('resume-adversarial');
    }
    if (f.cumulativeUnresolvedSevere || f.blockingAcceptanceCriteria) {
      return nextAction('continue-blocked');
    }
    return nextAction('continue-blocked');
  }
  if (f.awaitingHumanDecision) {
    return nextAction('await-human-decision');
  }

  const dispositionReleasesReview =
    f.completionEvaluationResult === 'ready' ||
    f.completionEvaluationResult === 'ready_with_followups';
  if (f.completionEvaluationResult === 'must_fix_now') {
    return nextAction('triage-findings');
  }
  if (f.phase === 'completion-evaluation' && !dispositionReleasesReview) {
    return nextAction('completion-disposition');
  }

  // controller.py:compute_next_action — first match wins.
  if (!f.acceptedSpecExists) {
    // Only rigorous mode (with no enhance artifact yet) routes to enhance;
    // every other mode reconciles the spec directly.
    if (f.effectiveMode === 'rigorous' && !f.hasEnhance) {
      return nextAction('run-enhance');
    }
    return nextAction('reconcile-spec');
  }
  if (!f.acceptedPlanExists) {
    return nextAction('reconcile-plan');
  }
  if (!f.hasChecks) {
    return nextAction('run-verification');
  }
  if (!f.verificationPassed) {
    return nextAction('fix-verification');
  }
  if (!f.hasReviews) {
    return nextAction('run-review');
  }
  if (
    (!isPass(f.effectiveReviewVerdict) || f.cumulativeUnresolvedSevere === true) &&
    !dispositionReleasesReview
  ) {
    return nextAction('triage-findings');
  }
  if (f.requiresAdversarial && (!f.hasAdversarial || !isPass(f.latestAdversarialVerdict))) {
    if (f.hasAdversarial && f.phase === 'adversarially-reviewed') {
      return nextAction('completion-disposition');
    }
    if (!dispositionReleasesReview) return nextAction('adversarial-review');
  }
  return nextAction('evaluate-report');
}
