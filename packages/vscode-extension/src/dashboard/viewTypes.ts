/**
 * Serializable view model posted to the dashboard webview. Plain interfaces with
 * no imports so both the host mapper (renderModel.ts) and the webview script
 * (webview/main.ts) can share them without coupling the webview bundle to core
 * or vscode. Every derived value (stages, gates, next action) originates from
 * @semanticmatter/core and is only passed through here.
 */

/** One semantic-summary section of a structured Codex JSON artifact (§ "Prompt and artifact evolution"). */
export interface DashboardArtifactSummarySection {
  readonly label: string;
  readonly items: readonly string[];
}

export interface DashboardArtifact {
  /** Command id suffix, e.g. "openEnhancedSpec"; the webview asks the host to run it. */
  readonly command: string;
  readonly title: string;
  readonly exists: boolean;
  readonly filename?: string;
  /** Semantic summary of a structured Codex JSON artifact, when one is available. */
  readonly sections?: readonly DashboardArtifactSummarySection[];
}

export interface DashboardStage {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly detail?: string;
  /**
   * Optional compact secondary metadata for the stage — e.g.
   * "Azure · GPT-5.6 Sol · High" for a Codex-owned stage, or
   * "Microsoft Foundry · Claude" for the Claude-owned implementation stage.
   * Only populated when the run's config_snapshot or Codex telemetry provides
   * the values verbatim; never invented.
   */
  readonly meta?: string;
  /** Tooltip for the meta line (e.g. underlying profile id). */
  readonly metaTooltip?: string;
}

export interface DashboardGate {
  readonly code: string;
  readonly message: string;
}

export interface DashboardCheck {
  readonly name: string;
  readonly command: string;
  readonly exitCode?: number;
  readonly passed: boolean;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly log?: string;
  readonly attempts: number;
}

export interface DashboardFinding {
  readonly id?: string;
  readonly severity?: string;
  readonly category?: string;
  readonly file?: string | null;
  readonly line?: number | null;
  readonly description?: string;
  readonly evidence?: string;
  readonly recommendedFix?: string;
  /** Structured disposition from a review.finding.triaged event, when present (§9). */
  readonly disposition?: string;
}

export interface DashboardAcceptanceCriterion {
  readonly id?: string;
  readonly status?: string;
  readonly evidence?: string;
}

/**
 * One entry of the cumulative finding ledger (the authoritative, full-then-delta
 * merged ledger — distinct from the per-round review findings above). Carries
 * resolution provenance so the UI can show resolved findings as released rather
 * than blocking.
 */
export interface DashboardCumulativeFinding {
  readonly id?: string;
  readonly severity?: string;
  readonly category?: string;
  readonly status?: string;
  readonly file?: string | null;
  readonly line?: number | null;
  readonly description?: string;
  readonly roundOpened?: number;
  readonly roundLastSeen?: number;
  readonly origin?: string;
  /** True when this finding is severe AND unresolved (blocks completion). */
  readonly blocking: boolean;
  /** Round a delta review resolved this finding, when applicable. */
  readonly resolvedAtRound?: number;
  /** `review-NN` that resolved it, when applicable. */
  readonly resolutionSource?: string;
}

export interface DashboardCumulativeFindings {
  readonly total: number;
  readonly blockingSevereCount: number;
  readonly resolvedCount: number;
  readonly openCount: number;
  readonly findings: readonly DashboardCumulativeFinding[];
}

/** One entry of the cumulative acceptance-criteria ledger. */
export interface DashboardCumulativeAcceptanceCriterion {
  readonly id?: string;
  readonly status?: string;
  readonly evidence?: string;
  readonly round?: number;
  /** True when status is not exactly `satisfied` (blocks completion, fail closed). */
  readonly blocking: boolean;
}

export interface DashboardAcceptanceCriteria {
  readonly total: number;
  readonly satisfiedCount: number;
  readonly blockingCount: number;
  readonly criteria: readonly DashboardCumulativeAcceptanceCriterion[];
}

/** Latest review checkpoint (changed-since-previous-review delta context). */
export interface DashboardCheckpoint {
  readonly id?: string;
  /** "focused_full_fallback" when the delta could not be computed exactly. */
  readonly reviewContextMode?: string;
  readonly changedPathsCount: number;
  /** True for a delta (round 2+) review; false for the round-1 full review. */
  readonly isDelta: boolean;
}

/** Per-phase Codex usage record (read-only telemetry from the controller). */
export interface DashboardCodexRun {
  readonly phase?: string;
  readonly model?: string;
  readonly durationSeconds?: number;
  readonly promptCharacters?: number;
  readonly outputCharacters?: number;
  readonly totalTokens?: number;
}

export interface DashboardCodexUsage {
  readonly runs: readonly DashboardCodexRun[];
  readonly totalDurationSeconds: number;
  readonly totalTokens: number;
}

export interface DashboardReviewRound {
  readonly round?: number;
  readonly path?: string;
  readonly verdict?: string;
  readonly confidence?: number;
  readonly readable: boolean;
  readonly summary?: string;
  readonly findings: readonly DashboardFinding[];
  readonly findingCountsBySeverity: Readonly<Record<string, number>>;
  readonly verificationGaps: readonly string[];
  readonly acceptanceCriteria: readonly DashboardAcceptanceCriterion[];
}

/** A read-only legacy triage markdown file (no fabricated dispositions; §9). */
export interface DashboardTriageFile {
  readonly filename: string;
}

export interface DashboardTimelineEntry {
  readonly sequence: number;
  readonly timestamp: string;
  readonly phase: string;
  readonly type: string;
  readonly source: string;
  readonly summary: string;
}

export interface DashboardDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: string;
}

/**
 * Config-snapshot pinned into a run at init time (schema_version 2). Rendered
 * read-only in the dashboard so the user can see the exact preset, Claude
 * runtime, and per-phase Codex profile/effort the run was created with —
 * independent of the current global config.
 */
export interface DashboardPhaseSnapshot {
  readonly phase: string;
  readonly profile?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly reasoningSummary?: string;
  readonly verbosity?: string;
}

export interface DashboardConfigSnapshot {
  readonly preset?: string;
  readonly workflowMode?: string;
  readonly maxReviewRounds?: number;
  readonly claudeRuntime?: string;
  readonly phases: readonly DashboardPhaseSnapshot[];
}

export interface DashboardView {
  readonly runId: string;
  readonly repoId: string;
  readonly feature: string;
  readonly label?: string;
  readonly status: string;
  readonly phase: string;
  readonly isTerminal: boolean;
  readonly blockingReason?: string;
  /**
   * True iff an extension-tracked Claude terminal exists for this run. Rendered
   * to switch the header button between "Resume in Claude" and
   * "Focus Claude terminal", and to suppress duplicate session creation.
   */
  readonly claudeTerminalOpen: boolean;
  readonly repository: {
    readonly id: string;
    readonly displayName?: string;
    readonly worktreePath?: string;
    readonly worktreeMode?: string;
    readonly remoteDisplay?: string;
    /** Current git branch as recorded at init. */
    readonly branch?: string;
    /** Baseline commit sha as recorded at init (full sha; abbreviate in UI). */
    readonly baselineCommit?: string;
  };
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly stages: readonly DashboardStage[];
  readonly reviewBudget: {
    readonly max: number;
    readonly consumed: number;
    readonly remaining: number;
  };
  readonly verification: {
    readonly hasChecks: boolean;
    readonly passed: boolean;
    readonly passedCount: number;
    readonly failedCount: number;
    readonly total: number;
    readonly checks: readonly DashboardCheck[];
  };
  readonly review: {
    readonly hasReviews: boolean;
    readonly latestVerdict?: string;
    readonly latestRound?: number;
    readonly severeFindingCount: number;
    readonly rounds: readonly DashboardReviewRound[];
    readonly triageFiles: readonly DashboardTriageFile[];
  };
  readonly adversarial: {
    readonly required: boolean;
    readonly satisfied: boolean;
    readonly reasons: readonly string[];
    readonly rounds: readonly DashboardReviewRound[];
  };
  readonly risk: {
    readonly requiresAdversarialReview: boolean;
    readonly reasons: readonly string[];
  };
  /** Effective workflow mode (auto-resolved), when the controller recorded one. */
  readonly effectiveMode?: string;
  /** Authoritative cumulative finding ledger (blocking vs resolved). */
  readonly cumulativeFindings: DashboardCumulativeFindings;
  /** Cumulative acceptance-criteria ledger (every criterion must be satisfied). */
  readonly acceptanceCriteria: DashboardAcceptanceCriteria;
  /** Latest review checkpoint, when one was captured. */
  readonly checkpoint?: DashboardCheckpoint;
  /** Per-phase Codex usage telemetry. */
  readonly codexUsage: DashboardCodexUsage;
  readonly gateFailures: readonly DashboardGate[];
  readonly gatesPass: boolean;
  readonly nextAction: { readonly code: string; readonly message: string };
  readonly artifacts: readonly DashboardArtifact[];
  readonly timeline: readonly DashboardTimelineEntry[];
  readonly truncatedTimeline: boolean;
  readonly diagnostics: readonly DashboardDiagnostic[];
  /** Config-snapshot recorded at init (schema_version 2 runs only). */
  readonly configSnapshot?: DashboardConfigSnapshot;
  /**
   * Compact "current activity" summary computed from existing controller data
   * only — phase, next-action summary, last controller note (if any), whether
   * an extension-created Claude terminal is currently open for this run, and
   * the run's last-update timestamp. This is deliberately NOT a live-stream
   * proxy: token streaming, Claude tool-event capture, and Codex app-server
   * integration are DEFERRED to a later iteration.
   */
  readonly currentActivity: DashboardCurrentActivity;
}

/** Currently observable activity, from data the extension already has. */
export interface DashboardCurrentActivity {
  readonly phase: string;
  readonly nextActionMessage: string;
  readonly latestNote?: string;
  readonly updatedAt?: string;
  /** Whether an extension-created Claude terminal is currently alive for this run. */
  readonly claudeTerminalOpen: boolean;
}

/** Messages the webview sends to the host. */
export type WebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'command'; readonly command: string }
  | { readonly type: 'openFinding'; readonly file: string; readonly line?: number | null }
  | { readonly type: 'openVerificationLog'; readonly log: string }
  | { readonly type: 'openRunFile'; readonly file: string };
