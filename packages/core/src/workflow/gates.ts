/**
 * Legacy completion-gate projection plus authoritative disposition integration.
 * The persisted controller result releases review/adversarial concerns only for
 * `ready` states; this module never reclassifies individual findings. Runs that
 * predate completion evaluation retain the established fail-closed projection.
 *
 * Severe findings come from the cumulative finding ledger when it is non-empty
 * (`cumulative_unresolved_severe`, fail closed), otherwise from the latest
 * review file's raw severe findings. The gate never consults triage dispositions
 * directly — the controller folds those into the cumulative ledger before this
 * runs. Ordered within the review block: review-not-pass, severe-findings,
 * acceptance-criteria-unsatisfied, then the pass+blocking contradiction.
 */

export type GateFailureCode =
  | 'missing-accepted-spec'
  | 'missing-accepted-plan'
  | 'no-verification'
  | 'verification-failing'
  | 'no-reviews'
  | 'review-not-pass'
  | 'severe-findings'
  | 'acceptance-criteria-unsatisfied'
  | 'review-inconsistent-pass'
  | 'adversarial-required'
  | 'disposition-must-fix'
  | 'disposition-human-decision';

export interface GateFailure {
  readonly code: GateFailureCode;
  readonly message: string;
}

export interface GateFacts {
  readonly acceptedSpecExists: boolean;
  readonly acceptedPlanExists: boolean;
  readonly hasChecks: boolean;
  readonly verificationPassed: boolean;
  readonly hasReviews: boolean;
  readonly latestReviewReadable: boolean;
  readonly latestReviewVerdict?: string;
  /** Severe-finding count from the latest review file (back-compat fallback). */
  readonly severeFindingCount: number;
  /**
   * When true, use {@link cumulativeSevereFindingCount} for the severe-findings
   * gate instead of {@link severeFindingCount} (the controller prefers the
   * cumulative ledger when `cumulative_findings` is non-empty).
   */
  readonly hasCumulativeFindings?: boolean;
  /** Count from `cumulative_unresolved_severe` (used when the ledger exists). */
  readonly cumulativeSevereFindingCount?: number;
  /** `id [severity/category] snippet; ...` for the severe-findings message. */
  readonly severeFindingsDescription?: string;
  /** Count from `blocking_acceptance_criteria` (status != satisfied). */
  readonly blockingAcceptanceCriteriaCount?: number;
  /** `id [status]; ...` for the acceptance-criteria message. */
  readonly blockingAcceptanceCriteriaDescription?: string;
  readonly requiresAdversarial: boolean;
  readonly hasAdversarial: boolean;
  readonly latestAdversarialVerdict?: string;
  /** Canonical controller disposition result. Absent for legacy runs. */
  readonly completionEvaluationResult?: string;
}

function isPass(verdict: string | undefined): boolean {
  return verdict !== undefined && verdict.trim().toLowerCase() === 'pass';
}

/** Ordered completion-gate failures (empty ⇒ gate passes ⇒ run may complete). */
export function evaluateGates(f: GateFacts): GateFailure[] {
  const failures: GateFailure[] = [];
  const dispositionReleasesReview =
    f.completionEvaluationResult === 'ready' ||
    f.completionEvaluationResult === 'ready_with_followups';

  if (!f.acceptedSpecExists) {
    failures.push({
      code: 'missing-accepted-spec',
      message: 'Accepted specification (accepted-spec.md) is missing'
    });
  }
  if (!f.acceptedPlanExists) {
    failures.push({
      code: 'missing-accepted-plan',
      message: 'Accepted plan (accepted-plan.md) is missing'
    });
  }
  if (!f.hasChecks) {
    failures.push({
      code: 'no-verification',
      message: 'No verification checks have been recorded'
    });
  } else if (!f.verificationPassed) {
    failures.push({
      code: 'verification-failing',
      message: 'One or more verification checks are failing'
    });
  }
  if (!f.hasReviews) {
    failures.push({ code: 'no-reviews', message: 'No independent review has been recorded' });
  } else {
    const verdictIsPass = isPass(f.latestReviewVerdict);
    if (!f.latestReviewReadable || (!verdictIsPass && !dispositionReleasesReview)) {
      failures.push({
        code: 'review-not-pass',
        message: f.latestReviewReadable
          ? `Latest review verdict is "${f.latestReviewVerdict ?? 'unknown'}", not "pass"`
          : 'Latest review could not be read'
      });
    }
    // Prefer the cumulative ledger count when the ledger exists; otherwise fall
    // back to the latest review file's raw severe count (controller.py ~2526).
    const severeCount = f.hasCumulativeFindings
      ? (f.cumulativeSevereFindingCount ?? 0)
      : f.severeFindingCount;
    if (severeCount > 0 && !dispositionReleasesReview) {
      const describe =
        f.severeFindingsDescription && f.severeFindingsDescription.length > 0
          ? `: ${f.severeFindingsDescription}`
          : '';
      failures.push({
        code: 'severe-findings',
        message: f.hasCumulativeFindings
          ? `${severeCount} unresolved critical/high finding(s) in review ledger${describe}`
          : `Latest review has ${severeCount} unresolved critical/high finding(s)`
      });
    }
    // Completion requires every acceptance criterion to be satisfied (fail
    // closed): not_satisfied / partially_satisfied / not_verifiable (and any
    // missing/unknown status) block (controller.py ~2538).
    const blockingAcCount = f.blockingAcceptanceCriteriaCount ?? 0;
    if (blockingAcCount > 0) {
      const describe =
        f.blockingAcceptanceCriteriaDescription &&
        f.blockingAcceptanceCriteriaDescription.length > 0
          ? `: ${f.blockingAcceptanceCriteriaDescription}`
          : '';
      failures.push({
        code: 'acceptance-criteria-unsatisfied',
        message: `${blockingAcCount} acceptance criteria not satisfied${describe}`
      });
    }
    // Reject an internally-inconsistent review: a `pass` verdict cannot coexist
    // with unresolved blocking findings or unsatisfied acceptance criteria
    // (controller.py ~2548).
    if (verdictIsPass && ((severeCount > 0 && !dispositionReleasesReview) || blockingAcCount > 0)) {
      failures.push({
        code: 'review-inconsistent-pass',
        message:
          `Latest review verdict is 'pass' but ${severeCount} blocking finding(s) ` +
          `and ${blockingAcCount} unsatisfied acceptance criteria remain (inconsistent review)`
      });
    }
  }
  if (
    f.requiresAdversarial &&
    (!f.hasAdversarial || (!isPass(f.latestAdversarialVerdict) && !dispositionReleasesReview))
  ) {
    failures.push({
      code: 'adversarial-required',
      message: f.hasAdversarial
        ? 'Adversarial review is required and its latest verdict is not "pass"'
        : 'Adversarial review is required but none has been recorded'
    });
  }
  if (f.completionEvaluationResult === 'must_fix_now') {
    failures.push({
      code: 'disposition-must-fix',
      message: 'Completion evaluation records one or more MUST_FIX_NOW findings'
    });
  }
  if (f.completionEvaluationResult === 'human_decision_required') {
    failures.push({
      code: 'disposition-human-decision',
      message: 'Completion evaluation requires a human product or authority decision'
    });
  }

  return failures;
}

export function gatesPass(failures: readonly GateFailure[]): boolean {
  return failures.length === 0;
}
