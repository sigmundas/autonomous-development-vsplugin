export interface ContinuationContext {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly feature?: string;
  readonly acceptedScopeSummary?: string;
  readonly phase?: string;
  readonly status?: string;
  readonly humanDecision?: string;
  readonly latestVerification?: Readonly<Record<string, unknown>>;
  readonly regularReview?: Readonly<Record<string, unknown>>;
  readonly adversarialReview?: Readonly<Record<string, unknown>>;
  readonly openMustFixNow: readonly Readonly<Record<string, unknown>>[];
  readonly deferredFollowUps: readonly Readonly<Record<string, unknown>>[];
  readonly staleOrUnsatisfiedAcceptanceCriteria: readonly Readonly<Record<string, unknown>>[];
  readonly reviewBudget?: Readonly<Record<string, unknown>>;
  readonly recommendedNextAction?: Readonly<Record<string, unknown>>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(object).filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
}

/** Parse the controller's bounded continuation-context JSON response. */
export function parseContinuationContextText(value: string): ContinuationContext | undefined {
  try {
    const raw = object(JSON.parse(value));
    const runId = raw ? text(raw['run_id']) : undefined;
    if (!raw || !runId) return undefined;
    return {
      runId,
      ...(text(raw['parent_run_id']) ? { parentRunId: text(raw['parent_run_id']) } : {}),
      ...(text(raw['feature']) ? { feature: text(raw['feature']) } : {}),
      ...(text(raw['accepted_scope_summary'])
        ? { acceptedScopeSummary: text(raw['accepted_scope_summary']) }
        : {}),
      ...(text(raw['phase']) ? { phase: text(raw['phase']) } : {}),
      ...(text(raw['status']) ? { status: text(raw['status']) } : {}),
      ...(text(raw['human_decision']) ? { humanDecision: text(raw['human_decision']) } : {}),
      ...(object(raw['latest_verification'])
        ? { latestVerification: object(raw['latest_verification']) }
        : {}),
      ...(object(raw['regular_review']) ? { regularReview: object(raw['regular_review']) } : {}),
      ...(object(raw['adversarial_review'])
        ? { adversarialReview: object(raw['adversarial_review']) }
        : {}),
      openMustFixNow: objects(raw['open_must_fix_now']),
      deferredFollowUps: objects(raw['deferred_follow_ups']),
      staleOrUnsatisfiedAcceptanceCriteria: objects(
        raw['stale_or_unsatisfied_acceptance_criteria']
      ),
      ...(object(raw['review_budget']) ? { reviewBudget: object(raw['review_budget']) } : {}),
      ...(object(raw['recommended_next_action'])
        ? { recommendedNextAction: object(raw['recommended_next_action']) }
        : {})
    };
  } catch {
    return undefined;
  }
}
