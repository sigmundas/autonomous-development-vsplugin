/**
 * The shared workflow evaluator: the ONE place gate logic and next-action logic
 * live. Tree views, dashboard, status bar, and commands all consume its output
 * (docs/REFERENCE.md §6–§7). Pure and synchronous — IO happens in the caller
 * (see loadRun), which assembles the file-read facts this needs.
 */

import {
  TERMINAL_STATUSES,
  type CodexRun,
  type CumulativeAcceptanceCriterion,
  type CumulativeFinding,
  type RunState,
  type RunStatus
} from '../types';
import { evaluateGates, gatesPass, type GateFailure } from './gates';
import {
  blockingAcceptanceCriteria,
  cumulativeUnresolvedSevere,
  describeBlockingAcceptanceCriteria,
  describeBlockingFindings,
  isFindingResolved
} from './findings';
import { latestReviewRef } from './reviews';
import { deriveStages, type StageFacts, type WorkflowStage } from './stages';
import { recommendNextAction, type NextAction } from './nextAction';
import { summarizeVerification, type VerificationSummary } from './verification';

/** Facts about the latest review that require reading the review file. */
export interface LatestReviewFacts {
  readonly readable: boolean;
  /** Verdict from the review file when readable. */
  readonly verdict?: string;
  readonly severeFindingCount: number;
}

export interface EvaluatorInput {
  readonly state: RunState;
  readonly acceptedSpecExists: boolean;
  readonly acceptedPlanExists: boolean;
  /** Undefined when no reviews are recorded; otherwise facts about the latest. */
  readonly latestReview?: LatestReviewFacts;
}

export interface ReviewBudget {
  readonly originalMax: number;
  readonly max: number;
  readonly consumed: number;
  readonly remaining: number;
}

export interface ReviewSummaryModel {
  readonly hasReviews: boolean;
  readonly rounds: number;
  readonly latestRound?: number;
  /** Effective verdict (file when readable, else run-state cache). */
  readonly latestVerdict?: string;
  readonly latestReadable: boolean;
  readonly severeFindingCount: number;
}

export interface AdversarialSummaryModel {
  readonly required: boolean;
  readonly reasons: readonly string[];
  readonly hasReviews: boolean;
  readonly latestRound?: number;
  readonly latestVerdict?: string;
  readonly satisfied: boolean;
}

/** Cumulative finding-ledger summary (full-then-delta merged ledger). */
export interface CumulativeFindingsModel {
  readonly total: number;
  /** Findings still blocking completion (unresolved + severe, fail closed). */
  readonly blockingSevere: readonly CumulativeFinding[];
  readonly blockingSevereCount: number;
  /** `id [severity/category] snippet; ...` for the gate / UI. */
  readonly blockingSevereDescription: string;
  /** Findings released from blocking (resolved or non-blocking triage status). */
  readonly resolved: readonly CumulativeFinding[];
  readonly resolvedCount: number;
  /** Open (non-resolved) findings, including non-severe ones. */
  readonly openCount: number;
}

/** Cumulative acceptance-criteria summary. */
export interface AcceptanceCriteriaModel {
  readonly total: number;
  readonly satisfiedCount: number;
  /** Criteria with status != satisfied (fail closed on missing/unknown). */
  readonly blocking: readonly CumulativeAcceptanceCriterion[];
  readonly blockingCount: number;
  /** `id [status]; ...` for the gate / UI. */
  readonly blockingDescription: string;
}

/** Latest review checkpoint info (focused-full-fallback delta). */
export interface CheckpointModel {
  readonly id?: string;
  readonly reviewContextMode?: string;
  readonly changedPathsCount: number;
  /** Whether the latest review record was a delta (round 2+) review. */
  readonly isDelta: boolean;
}

/** Per-phase Codex usage plus totals across all recorded phases. */
export interface CodexUsageModel {
  readonly runs: readonly CodexRun[];
  readonly totalPromptCharacters: number;
  readonly totalOutputCharacters: number;
  readonly totalDurationSeconds: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
}

export interface WorkflowModel {
  readonly runId: string;
  readonly status: RunStatus;
  readonly rawStatus: string;
  readonly phase: string;
  readonly isTerminal: boolean;
  readonly stages: readonly WorkflowStage[];
  readonly verification: VerificationSummary;
  readonly review: ReviewSummaryModel;
  readonly reviewBudget: ReviewBudget;
  readonly adversarial: AdversarialSummaryModel;
  readonly riskClassification: {
    readonly requiresAdversarialReview: boolean;
    readonly reasons: readonly string[];
  };
  readonly completionGateFailures: readonly GateFailure[];
  readonly gatesPass: boolean;
  readonly recommendedNextAction: NextAction;
  readonly blockingReason?: string;
  /** Cumulative finding ledger (blocking/resolved counts + provenance). */
  readonly cumulativeFindings: CumulativeFindingsModel;
  /** Cumulative acceptance-criteria ledger (with blocking flags). */
  readonly acceptanceCriteria: AcceptanceCriteriaModel;
  /** Latest review checkpoint (changed-path count, context mode, delta flag). */
  readonly checkpoint?: CheckpointModel;
  /** Per-phase Codex usage summary plus totals. */
  readonly codexUsage: CodexUsageModel;
  /** Effective workflow mode (auto | lean | standard | rigorous), when recorded. */
  readonly effectiveMode?: string;
}

function isPass(verdict: string | undefined): boolean {
  return verdict !== undefined && verdict.trim().toLowerCase() === 'pass';
}

function blockingReasonFor(state: RunState): string | undefined {
  if (state.status !== 'blocked') {
    return undefined;
  }
  if (state.phase === 'review-budget-exhausted') {
    return 'Review-round budget exhausted';
  }
  const recorded = state.raw['blocking_reason'];
  if (typeof recorded === 'string' && recorded.trim().length > 0) {
    return recorded;
  }
  return state.phase && state.phase !== 'blocked' ? state.phase : 'Run is blocked';
}

function buildCumulativeFindingsModel(state: RunState): CumulativeFindingsModel {
  const blockingSevere = cumulativeUnresolvedSevere(state);
  const resolved = state.cumulativeFindings.filter((f) => isFindingResolved(f));
  return {
    total: state.cumulativeFindings.length,
    blockingSevere,
    blockingSevereCount: blockingSevere.length,
    blockingSevereDescription: describeBlockingFindings(blockingSevere),
    resolved,
    resolvedCount: resolved.length,
    openCount: state.cumulativeFindings.length - resolved.length
  };
}

function buildAcceptanceCriteriaModel(state: RunState): AcceptanceCriteriaModel {
  const blocking = blockingAcceptanceCriteria(state);
  const total = state.cumulativeAcceptanceCriteria.length;
  return {
    total,
    satisfiedCount: total - blocking.length,
    blocking,
    blockingCount: blocking.length,
    blockingDescription: describeBlockingAcceptanceCriteria(blocking)
  };
}

function buildCheckpointModel(state: RunState): CheckpointModel | undefined {
  // Latest review record that carries a checkpoint (controller writes one per
  // review round; scan from the end for the most recent).
  for (let i = state.reviews.length - 1; i >= 0; i--) {
    const review = state.reviews[i];
    const checkpoint = review?.checkpoint;
    if (checkpoint) {
      return {
        ...(checkpoint.id !== undefined ? { id: checkpoint.id } : {}),
        ...(checkpoint.reviewContextMode !== undefined
          ? { reviewContextMode: checkpoint.reviewContextMode }
          : {}),
        changedPathsCount: checkpoint.changedPaths.length,
        isDelta: review?.delta === true
      };
    }
  }
  return undefined;
}

function buildCodexUsageModel(state: RunState): CodexUsageModel {
  let totalPromptCharacters = 0;
  let totalOutputCharacters = 0;
  let totalDurationSeconds = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  for (const run of state.codexRuns) {
    totalPromptCharacters += run.promptCharacters ?? 0;
    totalOutputCharacters += run.outputCharacters ?? 0;
    totalDurationSeconds += run.durationSeconds ?? 0;
    totalInputTokens += run.tokens?.inputTokens ?? 0;
    totalOutputTokens += run.tokens?.outputTokens ?? 0;
    totalTokens += run.tokens?.totalTokens ?? 0;
  }
  return {
    runs: state.codexRuns,
    totalPromptCharacters,
    totalOutputCharacters,
    totalDurationSeconds,
    totalInputTokens,
    totalOutputTokens,
    totalTokens
  };
}

export function evaluateWorkflow(input: EvaluatorInput): WorkflowModel {
  const { state } = input;

  const verification = summarizeVerification(state.verification.checks);

  const hasReviews = state.reviews.length > 0;
  const latestRef = latestReviewRef(state.reviews);
  const cachedReviewVerdict = latestRef?.verdict;
  const latestReadable = input.latestReview?.readable ?? false;
  const severeFindingCount = input.latestReview?.severeFindingCount ?? 0;
  // Effective verdict: prefer the file when readable, else the run-state cache.
  const effectiveReviewVerdict = latestReadable ? input.latestReview?.verdict : cachedReviewVerdict;

  const adversarialLatest = latestReviewRef(state.adversarialReviews);
  const hasAdversarial = state.adversarialReviews.length > 0;
  const latestAdversarialVerdict = adversarialLatest?.verdict;
  const requiresAdversarial = state.risk.requiresAdversarialReview;

  // Cumulative ledgers (fail closed). The gate prefers the cumulative finding
  // count when the ledger is non-empty, matching controller.py ~2526.
  const cumulativeFindingsModel = buildCumulativeFindingsModel(state);
  const acceptanceCriteriaModel = buildAcceptanceCriteriaModel(state);
  const hasCumulativeFindings = state.cumulativeFindings.length > 0;
  const cumulativeSevere = hasCumulativeFindings && cumulativeFindingsModel.blockingSevereCount > 0;

  const completionGateFailures = evaluateGates({
    acceptedSpecExists: input.acceptedSpecExists,
    acceptedPlanExists: input.acceptedPlanExists,
    hasChecks: verification.hasChecks,
    verificationPassed: verification.passed,
    hasReviews,
    latestReviewReadable: latestReadable,
    ...(input.latestReview?.verdict !== undefined
      ? { latestReviewVerdict: input.latestReview.verdict }
      : {}),
    severeFindingCount,
    hasCumulativeFindings,
    cumulativeSevereFindingCount: cumulativeFindingsModel.blockingSevereCount,
    ...(cumulativeFindingsModel.blockingSevereDescription.length > 0
      ? { severeFindingsDescription: cumulativeFindingsModel.blockingSevereDescription }
      : {}),
    blockingAcceptanceCriteriaCount: acceptanceCriteriaModel.blockingCount,
    ...(acceptanceCriteriaModel.blockingDescription.length > 0
      ? { blockingAcceptanceCriteriaDescription: acceptanceCriteriaModel.blockingDescription }
      : {}),
    requiresAdversarial,
    hasAdversarial,
    ...(latestAdversarialVerdict !== undefined ? { latestAdversarialVerdict } : {})
  });

  const recommendedNextAction = recommendNextAction({
    status: state.status,
    phase: state.phase,
    hasEnhance: state.artifacts.enhance !== undefined,
    acceptedSpecExists: input.acceptedSpecExists,
    acceptedPlanExists: input.acceptedPlanExists,
    hasChecks: verification.hasChecks,
    verificationPassed: verification.passed,
    hasReviews,
    ...(effectiveReviewVerdict !== undefined ? { effectiveReviewVerdict } : {}),
    ...(state.effectiveMode !== undefined ? { effectiveMode: state.effectiveMode } : {}),
    cumulativeUnresolvedSevere: cumulativeSevere,
    blockingAcceptanceCriteria: acceptanceCriteriaModel.blockingCount > 0,
    requiresAdversarial,
    hasAdversarial,
    ...(latestAdversarialVerdict !== undefined ? { latestAdversarialVerdict } : {})
  });

  const stageFacts: StageFacts = {
    status: state.status,
    hasEnhance: state.artifacts.enhance !== undefined,
    acceptedSpecExists: input.acceptedSpecExists,
    hasPlan: state.artifacts.plan !== undefined,
    acceptedPlanExists: input.acceptedPlanExists,
    hasChecks: verification.hasChecks,
    verificationPassed: verification.passed,
    hasReviews,
    reviewPassed: isPass(effectiveReviewVerdict),
    ...(latestRef?.round !== undefined ? { latestReviewRound: latestRef.round } : {}),
    ...(effectiveReviewVerdict !== undefined
      ? { latestReviewVerdict: effectiveReviewVerdict }
      : {}),
    severeFindingCount,
    requiresAdversarial,
    hasAdversarial,
    adversarialPassed: isPass(latestAdversarialVerdict),
    nextActionCode: recommendedNextAction.code,
    ...(state.phase && state.phase.length > 0 ? { controllerPhase: state.phase } : {})
  };
  const stages = deriveStages(stageFacts);

  const reviewBudget: ReviewBudget = {
    originalMax: state.maxReviewRounds,
    max: state.maxReviewRounds + (state.additionalReviewRounds ?? 0),
    consumed: state.reviewRound,
    remaining: Math.max(
      0,
      state.maxReviewRounds + (state.additionalReviewRounds ?? 0) - state.reviewRound
    )
  };

  const review: ReviewSummaryModel = {
    hasReviews,
    rounds: state.reviews.length,
    ...(latestRef?.round !== undefined ? { latestRound: latestRef.round } : {}),
    ...(effectiveReviewVerdict !== undefined ? { latestVerdict: effectiveReviewVerdict } : {}),
    latestReadable,
    severeFindingCount
  };

  const adversarial: AdversarialSummaryModel = {
    required: requiresAdversarial,
    reasons: state.risk.reasons,
    hasReviews: hasAdversarial,
    ...(adversarialLatest?.round !== undefined ? { latestRound: adversarialLatest.round } : {}),
    ...(latestAdversarialVerdict !== undefined ? { latestVerdict: latestAdversarialVerdict } : {}),
    satisfied: !requiresAdversarial || (hasAdversarial && isPass(latestAdversarialVerdict))
  };

  const blockingReason = blockingReasonFor(state);
  const checkpoint = buildCheckpointModel(state);
  const codexUsage = buildCodexUsageModel(state);

  return {
    runId: state.runId,
    status: state.status,
    rawStatus: state.rawStatus,
    phase: state.phase,
    isTerminal: TERMINAL_STATUSES.includes(state.status),
    stages,
    verification,
    review,
    reviewBudget,
    adversarial,
    riskClassification: {
      requiresAdversarialReview: requiresAdversarial,
      reasons: state.risk.reasons
    },
    completionGateFailures,
    gatesPass: gatesPass(completionGateFailures),
    recommendedNextAction,
    ...(blockingReason !== undefined ? { blockingReason } : {}),
    cumulativeFindings: cumulativeFindingsModel,
    acceptanceCriteria: acceptanceCriteriaModel,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    codexUsage,
    ...(state.effectiveMode !== undefined ? { effectiveMode: state.effectiveMode } : {})
  };
}
