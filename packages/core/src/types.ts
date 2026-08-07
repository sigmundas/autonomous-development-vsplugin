/**
 * Domain types mirroring the quaat/autonomous-development `run-state.json`
 * (schema_version 2, with legacy v1 tolerated). See docs/REFERENCE.md §3.
 *
 * These are the *normalized* shapes the rest of core consumes. Raw JSON is
 * preserved on `RunState.raw` for forward compatibility.
 */

/** Normalized run status. Unknown strings collapse to `'unknown'`. */
export type RunStatus = 'active' | 'complete' | 'blocked' | 'cancelled' | 'archived' | 'unknown';

/** Terminal statuses never transition further. */
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'complete',
  'blocked',
  'cancelled',
  'archived'
];

/** Which of the three native tree views a run belongs to. */
export type RunGroup = 'active' | 'completed' | 'archived';

export interface RepositoryInfo {
  readonly id: string;
  readonly canonicalRoot?: string;
  readonly gitCommonDir?: string;
  readonly worktreePath?: string;
  readonly worktreeMode?: string;
  readonly displayName?: string;
  /** Credential-stripped remote, as recorded by the controller. */
  readonly remoteDisplay?: string;
}

export interface BaselineInfo {
  readonly commit?: string;
  readonly branch?: string;
  readonly dirtyEntriesAtInit: readonly string[];
}

/** Known artifact keys, plus the verbatim map for forward compatibility. */
export interface ArtifactMap {
  readonly featureRequest?: string;
  readonly repositoryContext?: string;
  readonly enhance?: string;
  readonly acceptedSpec?: string;
  readonly plan?: string;
  readonly acceptedPlan?: string;
  readonly review?: string;
  readonly adversarial?: string;
  readonly raw: Readonly<Record<string, string>>;
}

export interface VerificationCheck {
  readonly name: string;
  readonly command: readonly string[];
  /** Absent while a check is mid-flight. */
  readonly exitCode?: number;
  readonly log?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface VerificationState {
  /** The run-state cached `passed` flag (advisory; we recompute, §5). */
  readonly passedFlag?: boolean;
  readonly checks: readonly VerificationCheck[];
}

/**
 * Per-review checkpoint of the worktree a review round saw, so a later round can
 * identify what changed (controller.py `capture_review_checkpoint`,
 * `review_context_mode = "focused_full_fallback"`). All fields are optional at
 * the normalization boundary because a malformed/partial checkpoint must never
 * throw; the controller always writes the full set.
 */
export interface ReviewCheckpoint {
  /** e.g. "review-02". */
  readonly id?: string;
  readonly capturedAt?: string;
  readonly headCommit?: string;
  readonly branch?: string;
  readonly baselineCommit?: string | null;
  /** Feature paths changed since the baseline, sorted. */
  readonly changedPaths: readonly string[];
  /** path -> "sha256:<hex>" | null (deleted/unreadable). */
  readonly pathFingerprints: Readonly<Record<string, string | null>>;
  readonly previousCheckpointId?: string | null;
  /** Always "focused_full_fallback" when present. */
  readonly reviewContextMode?: string;
}

export interface ReviewRef {
  readonly round?: number;
  readonly path?: string;
  readonly verdict?: string;
  /** false ⇒ full review (round 1); true ⇒ delta review (round 2+). */
  readonly delta?: boolean;
  /** Worktree checkpoint this review round captured, when recorded. */
  readonly checkpoint?: ReviewCheckpoint;
}

export interface RiskInfo {
  readonly requiresAdversarialReview: boolean;
  readonly reasons: readonly string[];
}

/**
 * A merged cumulative finding (controller.py `_cumulative_finding` /
 * `_finalize_cumulative`). The ledger is self-contained: evidence is preserved
 * inline so the gate, audit trail, and delta reviewer never re-open the raw
 * review-NN.codex.json. There is intentionally NO per-finding `fingerprint`
 * (triage dispositions are keyed by fingerprint in {@link ReviewLedgerEntry}).
 */
export interface CumulativeFinding {
  /** Canonical `F-<n>` id. */
  readonly id?: string;
  /** critical | high | medium | low. */
  readonly severity?: string;
  readonly category?: string;
  /**
   * "open" initially; a non-blocking triage status (see
   * {@link NON_BLOCKING_TRIAGE_STATUSES}); or "resolved".
   */
  readonly status?: string;
  /** Round the finding was opened (legacy field; kept for back-compat). */
  readonly round?: number;
  readonly roundOpened?: number;
  readonly roundLastSeen?: number;
  /** "full" | "delta" | "regression" | "legacy". */
  readonly origin?: string;
  readonly file?: string | null;
  readonly lineStart?: number | null;
  readonly description?: string;
  readonly evidence?: string;
  readonly recommendedFix?: string;
  /** Set only when a colliding model id was remapped to a fresh canonical id. */
  readonly sourceId?: string;
  /** Round a delta review resolved this finding. */
  readonly resolvedAtRound?: number;
  /** `review-NN`, set on delta resolution. */
  readonly resolutionSource?: string;
  /** Original synthetic id preserved during migration. */
  readonly legacyId?: string;
  /** Verbatim sub-fields for forward compatibility. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * A cumulative acceptance-criterion verdict (controller.py
 * `merge_acceptance_criteria`). Only `satisfied` is non-blocking; everything
 * else — including missing/unknown — blocks the completion gate (fail closed).
 */
export interface CumulativeAcceptanceCriterion {
  readonly id?: string;
  /** satisfied | partially_satisfied | not_satisfied | not_verifiable. */
  readonly status?: string;
  readonly evidence?: string;
  readonly round?: number;
}

/**
 * A triage disposition keyed by `fingerprint` (controller.py `review_ledger`).
 * Distinct from {@link CumulativeFinding}, which is keyed by canonical id.
 */
export interface ReviewLedgerEntry {
  readonly fingerprint?: string;
  readonly status?: string;
  readonly findingId?: string;
  readonly resolution?: string;
  readonly reason?: string;
  readonly evidence?: string;
  readonly justification?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Token usage for a single Codex phase, when the NDJSON reported it. */
export interface CodexRunTokens {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** Per-phase Codex usage telemetry (controller.py `codex_runs`). */
export interface CodexRun {
  readonly phase?: string;
  readonly promptCharacters?: number;
  readonly outputCharacters?: number;
  readonly durationSeconds?: number;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly verbosity?: string;
  readonly startedAt?: string;
  readonly eventsArtifact?: string;
  readonly outputArtifact?: string;
  readonly tokens?: CodexRunTokens;
}

export interface RunState {
  /** 1 or 2 when recognized; 0 when absent/unparseable. */
  readonly schemaVersion: number;
  readonly runId: string;
  readonly label?: string;
  readonly feature: string;
  readonly status: RunStatus;
  /** Original status string before normalization (for display/debugging). */
  readonly rawStatus: string;
  readonly phase: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly repository: RepositoryInfo;
  readonly baseline?: BaselineInfo;
  readonly maxReviewRounds: number;
  readonly reviewRound: number;
  readonly stopGateBlocks: number;
  readonly artifacts: ArtifactMap;
  readonly verification: VerificationState;
  readonly reviews: readonly ReviewRef[];
  readonly adversarialReviews: readonly ReviewRef[];
  readonly risk: RiskInfo;
  readonly notes: readonly string[];
  readonly completionGateFailures: readonly string[];
  /** Merged finding ledger (full-then-delta). Empty when absent/malformed. */
  readonly cumulativeFindings: readonly CumulativeFinding[];
  /** Cumulative acceptance-criteria ledger. Empty when absent/malformed. */
  readonly cumulativeAcceptanceCriteria: readonly CumulativeAcceptanceCriterion[];
  /** Triage dispositions keyed by fingerprint. Empty when absent/malformed. */
  readonly reviewLedger: readonly ReviewLedgerEntry[];
  /** Per-phase Codex usage telemetry. Empty when absent/malformed. */
  readonly codexRuns: readonly CodexRun[];
  /** Requested workflow mode (auto | lean | standard | rigorous). */
  readonly requestedMode?: string;
  /** Effective workflow mode after `auto` resolution. */
  readonly effectiveMode?: string;
  /** Human-readable reasons for the effective mode. */
  readonly modeReasons: readonly string[];
  /** Everything as parsed, for forward compatibility / debugging. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Severity buckets the completion gate treats as "severe" (§6 #7). */
export const SEVERE_FINDING_SEVERITIES: readonly string[] = ['critical', 'high'];

/**
 * Severities the schemas treat as non-blocking (controller.py
 * `NON_SEVERE_SEVERITIES`). A finding is "severe" iff its severity is NOT one of
 * these — so a missing/unknown severity is severe (fail closed).
 */
export const NON_SEVERE_SEVERITIES: readonly string[] = ['low', 'medium'];

/**
 * Triage dispositions that release a cumulative finding from blocking
 * completion (controller.py `NON_BLOCKING_TRIAGE_STATUSES`, ~line 1026). A
 * severe finding with any other status (including a missing/unknown one) still
 * blocks the gate.
 */
export const NON_BLOCKING_TRIAGE_STATUSES: readonly string[] = [
  'rejected',
  'rejected_with_evidence',
  'already_resolved',
  'out_of_scope_but_recorded',
  'resolved'
];

/**
 * The only acceptance-criteria status that does not block completion
 * (controller.py `SATISFIED_ACCEPTANCE_STATUS`). Everything else blocks.
 */
export const SATISFIED_ACCEPTANCE_STATUS = 'satisfied';

/**
 * Structured finding dispositions the dashboard recognizes (docs/REFERENCE.md §9).
 * These are mapped from structured triage content or future live events — never
 * fabricated from free-form legacy `triage-NN.md`, which is shown read-only.
 */
export const RECOGNIZED_DISPOSITIONS: readonly string[] = [
  'accepted',
  'rejected_with_evidence',
  'already_resolved',
  'out_of_scope_but_recorded',
  'requires_human_decision'
];

export type FindingDisposition = (typeof RECOGNIZED_DISPOSITIONS)[number];

/** A single finding inside a review-NN.codex.json (subset we rely on). */
export interface ReviewFinding {
  readonly id?: string;
  readonly severity?: string;
  readonly category?: string;
  readonly file?: string | null;
  readonly lineStart?: number | null;
  readonly description?: string;
  readonly evidence?: string;
  readonly recommendedFix?: string;
}

/** One acceptance-criterion verdict from `acceptance_criteria_assessment[]` (§8). */
export interface AcceptanceCriterionAssessment {
  readonly id?: string;
  /** satisfied | partially_satisfied | not_satisfied | not_verifiable. */
  readonly status?: string;
  readonly evidence?: string;
}

export interface ReviewDocument {
  readonly verdict?: string;
  readonly summary?: string;
  readonly confidence?: number;
  readonly findings: readonly ReviewFinding[];
  /** `verification_gaps[]` — free-text gaps the reviewer could not confirm. */
  readonly verificationGaps: readonly string[];
  /** `acceptance_criteria_assessment[]` — per-criterion satisfaction verdicts. */
  readonly acceptanceCriteriaAssessment: readonly AcceptanceCriterionAssessment[];
  readonly raw: Readonly<Record<string, unknown>>;
}
