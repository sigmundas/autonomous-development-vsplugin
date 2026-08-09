/**
 * Tolerant parsing/normalization of `run-state.json` (docs/REFERENCE.md §3).
 *
 * A malformed or partially-written file must never throw to the caller: it
 * returns diagnostics and (when at all possible) a best-effort normalized state.
 * Only `run_id` + `status` are strictly required for a usable run (§3).
 */

import { diag, type Diagnostic } from './diagnostics';
import { redactCredentials } from './redact';
import type {
  ArtifactMap,
  BaselineInfo,
  CodexRun,
  CodexRunTokens,
  CumulativeAcceptanceCriterion,
  CumulativeFinding,
  RepositoryInfo,
  ReviewCheckpoint,
  ReviewLedgerEntry,
  ReviewRef,
  RiskInfo,
  RunState,
  RunStatus,
  VerificationCheck,
  VerificationState
} from './types';

export interface RunStateParseResult {
  readonly state?: RunState;
  readonly diagnostics: readonly Diagnostic[];
}

const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === 'string');
}

/** A finite integer, or undefined. Truncates fractional numbers. */
function asInt(value: unknown): number | undefined {
  const n = asNumber(value);
  return n === undefined ? undefined : Math.trunc(n);
}

/** A string, null (preserved), or undefined. */
function asStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** An integer, null (preserved), or undefined. */
function asIntOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return asInt(value);
}

/**
 * Normalize a status string to the {@link RunStatus} union.
 *
 * Only the exact canonical `active` is treated as active, matching the
 * controller's active-mutation guard (`state.py` `_reject_non_active`), which
 * fails closed on anything that is not exactly `"active"`. The controller never
 * writes `running`/`in_progress`, so coercing those to active would fail open —
 * presenting a run as active that the controller would refuse to mutate. They
 * fall through to `unknown` (and surface an unrecognized-status diagnostic).
 * Terminal spellings (`completed`/`canceled`) are tolerated because they map to
 * a terminal state — the fail-closed direction.
 */
export function normalizeStatus(raw: string): RunStatus {
  switch (raw.trim().toLowerCase()) {
    case 'active':
      return 'active';
    case 'complete':
    case 'completed':
      return 'complete';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'archived':
      return 'archived';
    default:
      return 'unknown';
  }
}

function normalizeRepository(value: unknown): RepositoryInfo {
  if (!isPlainObject(value)) {
    return { id: '' };
  }
  const info: {
    id: string;
    canonicalRoot?: string;
    gitCommonDir?: string;
    worktreePath?: string;
    worktreeMode?: string;
    displayName?: string;
    remoteDisplay?: string;
  } = { id: asString(value['id']) ?? '' };
  const canonicalRoot = asNonEmptyString(value['canonical_root']);
  if (canonicalRoot) info.canonicalRoot = canonicalRoot;
  const gitCommonDir = asNonEmptyString(value['git_common_dir']);
  if (gitCommonDir) info.gitCommonDir = gitCommonDir;
  const worktreePath = asNonEmptyString(value['worktree_path']);
  if (worktreePath) info.worktreePath = worktreePath;
  const worktreeMode = asNonEmptyString(value['worktree_mode']);
  if (worktreeMode) info.worktreeMode = worktreeMode;
  const displayName = asNonEmptyString(value['display_name']);
  if (displayName) info.displayName = displayName;
  const remoteDisplay = asNonEmptyString(value['remote_display']);
  if (remoteDisplay) info.remoteDisplay = redactCredentials(remoteDisplay);
  return info;
}

function normalizeBaseline(value: unknown): BaselineInfo | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const baseline: { commit?: string; branch?: string; dirtyEntriesAtInit: string[] } = {
    dirtyEntriesAtInit: asStringArray(value['dirty_entries_at_init'])
  };
  const commit = asNonEmptyString(value['commit']);
  if (commit) baseline.commit = commit;
  const branch = asNonEmptyString(value['branch']);
  if (branch) baseline.branch = branch;
  return baseline;
}

const KNOWN_ARTIFACT_KEYS: ReadonlyArray<[keyof Omit<ArtifactMap, 'raw'>, string]> = [
  ['featureRequest', 'feature_request'],
  ['repositoryContext', 'repository_context'],
  ['enhance', 'enhance'],
  ['acceptedSpec', 'accepted_spec'],
  ['plan', 'plan'],
  ['acceptedPlan', 'accepted_plan'],
  ['review', 'review'],
  ['adversarial', 'adversarial']
];

function normalizeArtifacts(value: unknown): ArtifactMap {
  const raw: Record<string, string> = {};
  if (isPlainObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      const s = asNonEmptyString(v);
      if (s) {
        raw[key] = s;
      }
    }
  }
  const known: Partial<Record<keyof Omit<ArtifactMap, 'raw'>, string>> = {};
  for (const [camel, snake] of KNOWN_ARTIFACT_KEYS) {
    const s = raw[snake];
    if (s) {
      known[camel] = s;
    }
  }
  return { ...known, raw };
}

function normalizeCheck(value: unknown): VerificationCheck | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const name = asString(value['name']);
  if (name === undefined) {
    return undefined;
  }
  const rawCommand = value['command'];
  const command = Array.isArray(rawCommand)
    ? rawCommand.filter((v): v is string => typeof v === 'string')
    : typeof rawCommand === 'string'
      ? [rawCommand]
      : [];
  const check: {
    name: string;
    command: string[];
    exitCode?: number;
    log?: string;
    startedAt?: string;
    completedAt?: string;
  } = { name, command };
  const exitCode = asNumber(value['exit_code']);
  if (exitCode !== undefined) check.exitCode = exitCode;
  const log = asNonEmptyString(value['log']);
  if (log) check.log = log;
  const startedAt = asNonEmptyString(value['started_at']);
  if (startedAt) check.startedAt = startedAt;
  const completedAt = asNonEmptyString(value['completed_at']);
  if (completedAt) check.completedAt = completedAt;
  return check;
}

function normalizeVerification(value: unknown): VerificationState {
  if (!isPlainObject(value)) {
    return { checks: [] };
  }
  const checks: VerificationCheck[] = [];
  const rawChecks = value['checks'];
  if (Array.isArray(rawChecks)) {
    for (const entry of rawChecks) {
      const check = normalizeCheck(entry);
      if (check) {
        checks.push(check);
      }
    }
  }
  const state: { passedFlag?: boolean; checks: VerificationCheck[] } = { checks };
  if (typeof value['passed'] === 'boolean') {
    state.passedFlag = value['passed'];
  }
  return state;
}

function normalizeCheckpoint(value: unknown): ReviewCheckpoint | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const pathFingerprints: Record<string, string | null> = {};
  const rawFps = value['path_fingerprints'];
  if (isPlainObject(rawFps)) {
    for (const [key, v] of Object.entries(rawFps)) {
      if (typeof v === 'string') {
        pathFingerprints[key] = v;
      } else if (v === null) {
        pathFingerprints[key] = null;
      }
    }
  }
  const checkpoint: {
    id?: string;
    capturedAt?: string;
    headCommit?: string;
    branch?: string;
    baselineCommit?: string | null;
    changedPaths: string[];
    pathFingerprints: Record<string, string | null>;
    previousCheckpointId?: string | null;
    reviewContextMode?: string;
  } = {
    changedPaths: asStringArray(value['changed_paths']),
    pathFingerprints
  };
  const id = asNonEmptyString(value['id']);
  if (id) checkpoint.id = id;
  const capturedAt = asNonEmptyString(value['captured_at']);
  if (capturedAt) checkpoint.capturedAt = capturedAt;
  const headCommit = asNonEmptyString(value['head_commit']);
  if (headCommit) checkpoint.headCommit = headCommit;
  const branch = asNonEmptyString(value['branch']);
  if (branch) checkpoint.branch = branch;
  const baselineCommit = asStringOrNull(value['baseline_commit']);
  if (baselineCommit !== undefined) checkpoint.baselineCommit = baselineCommit;
  const previousCheckpointId = asStringOrNull(value['previous_checkpoint_id']);
  if (previousCheckpointId !== undefined) checkpoint.previousCheckpointId = previousCheckpointId;
  const reviewContextMode = asNonEmptyString(value['review_context_mode']);
  if (reviewContextMode) checkpoint.reviewContextMode = reviewContextMode;
  return checkpoint;
}

function normalizeReviewRefs(value: unknown): ReviewRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: ReviewRef[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const ref: {
      round?: number;
      path?: string;
      verdict?: string;
      delta?: boolean;
      checkpoint?: ReviewCheckpoint;
    } = {};
    const round = asNumber(entry['round']);
    if (round !== undefined) ref.round = round;
    const path = asNonEmptyString(entry['path']);
    if (path) ref.path = path;
    const verdict = asNonEmptyString(entry['verdict']);
    if (verdict) ref.verdict = verdict;
    if (typeof entry['delta'] === 'boolean') ref.delta = entry['delta'];
    const checkpoint = normalizeCheckpoint(entry['checkpoint']);
    if (checkpoint) ref.checkpoint = checkpoint;
    refs.push(ref);
  }
  return refs;
}

function normalizeRisk(value: unknown): RiskInfo {
  if (!isPlainObject(value)) {
    return { requiresAdversarialReview: false, reasons: [] };
  }
  return {
    requiresAdversarialReview: value['requires_adversarial_review'] === true,
    reasons: asStringArray(value['reasons'])
  };
}

/**
 * Marker key, set on a normalized {@link CumulativeFinding} / acceptance
 * criterion when the source array element was NOT a JSON object. The fail-closed
 * gate helpers (workflow/findings.ts) treat such an entry as blocking, mirroring
 * the reference, which fail-closes on non-dict ledger entries.
 */
export const MALFORMED_ENTRY_MARKER = '__semanticmatter_malformed__';

const FINDING_KNOWN_KEYS = new Set([
  'id',
  'severity',
  'category',
  'status',
  'round',
  'round_opened',
  'round_last_seen',
  'origin',
  'file',
  'line_start',
  'description',
  'evidence',
  'recommended_fix',
  'source_id',
  'resolved_at_round',
  'resolution_source',
  'legacy_id',
  'assessment_state'
]);

function normalizeCumulativeFinding(value: unknown): CumulativeFinding {
  if (!isPlainObject(value)) {
    // Preserve the non-object signal so the gate fails closed on it.
    return { raw: { [MALFORMED_ENTRY_MARKER]: true, value } };
  }
  // Preserve any unknown sub-fields verbatim for forward compatibility.
  const extraRaw: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!FINDING_KNOWN_KEYS.has(key)) {
      extraRaw[key] = v;
    }
  }
  const finding: {
    id?: string;
    severity?: string;
    category?: string;
    status?: string;
    round?: number;
    roundOpened?: number;
    roundLastSeen?: number;
    origin?: string;
    file?: string | null;
    lineStart?: number | null;
    description?: string;
    evidence?: string;
    recommendedFix?: string;
    sourceId?: string;
    resolvedAtRound?: number;
    resolutionSource?: string;
    legacyId?: string;
    assessmentState?: string;
    raw: Record<string, unknown>;
  } = { raw: extraRaw };
  const id = asNonEmptyString(value['id']);
  if (id) finding.id = id;
  const severity = asNonEmptyString(value['severity']);
  if (severity) finding.severity = severity;
  const category = asNonEmptyString(value['category']);
  if (category) finding.category = category;
  const status = asNonEmptyString(value['status']);
  if (status) finding.status = status;
  const round = asInt(value['round']);
  if (round !== undefined) finding.round = round;
  const roundOpened = asInt(value['round_opened']);
  if (roundOpened !== undefined) finding.roundOpened = roundOpened;
  const roundLastSeen = asInt(value['round_last_seen']);
  if (roundLastSeen !== undefined) finding.roundLastSeen = roundLastSeen;
  const origin = asNonEmptyString(value['origin']);
  if (origin) finding.origin = origin;
  const file = asStringOrNull(value['file']);
  if (file !== undefined) finding.file = file;
  const lineStart = asIntOrNull(value['line_start']);
  if (lineStart !== undefined) finding.lineStart = lineStart;
  const description = asString(value['description']);
  if (description !== undefined) finding.description = description;
  const evidence = asString(value['evidence']);
  if (evidence !== undefined) finding.evidence = evidence;
  const recommendedFix = asString(value['recommended_fix']);
  if (recommendedFix !== undefined) finding.recommendedFix = recommendedFix;
  const sourceId = asNonEmptyString(value['source_id']);
  if (sourceId) finding.sourceId = sourceId;
  const resolvedAtRound = asInt(value['resolved_at_round']);
  if (resolvedAtRound !== undefined) finding.resolvedAtRound = resolvedAtRound;
  const resolutionSource = asNonEmptyString(value['resolution_source']);
  if (resolutionSource) finding.resolutionSource = resolutionSource;
  const legacyId = asNonEmptyString(value['legacy_id']);
  if (legacyId) finding.legacyId = legacyId;
  const assessmentState = asNonEmptyString(value['assessment_state']);
  if (assessmentState) finding.assessmentState = assessmentState;
  return finding;
}

function normalizeCumulativeFindings(
  value: unknown,
  diagnostics: Diagnostic[]
): CumulativeFinding[] {
  if (Array.isArray(value)) {
    return value.map(normalizeCumulativeFinding);
  }
  if (value === undefined || value === null) {
    return [];
  }
  // Present but not a list. The controller scans a truthy-but-malformed ledger
  // container and flags its contents (fail closed). Mirror that here by emitting
  // a malformed sentinel so the shared evaluator keeps the run blocking instead
  // of reading a corrupt container as "no findings".
  diagnostics.push(
    diag(
      'run-state-malformed-cumulative-findings',
      '"cumulative_findings" is not a JSON array; treating as a blocking malformed ledger',
      'warning',
      'cumulative_findings'
    )
  );
  return [{ raw: { [MALFORMED_ENTRY_MARKER]: true, value } } as CumulativeFinding];
}

function normalizeAcceptanceCriterion(value: unknown): CumulativeAcceptanceCriterion {
  if (!isPlainObject(value)) {
    return { raw: { [MALFORMED_ENTRY_MARKER]: true, value } } as CumulativeAcceptanceCriterion;
  }
  const criterion: {
    id?: string;
    status?: string;
    evidence?: string;
    round?: number;
    assessmentState?: string;
  } = {};
  const id = asNonEmptyString(value['id']);
  if (id) criterion.id = id;
  const status = asNonEmptyString(value['status']);
  if (status) criterion.status = status;
  const evidence = asString(value['evidence']);
  if (evidence !== undefined) criterion.evidence = evidence;
  const round = asInt(value['round']);
  if (round !== undefined) criterion.round = round;
  const assessmentState = asNonEmptyString(value['assessment_state']);
  if (assessmentState) criterion.assessmentState = assessmentState;
  return criterion;
}

function normalizeAcceptanceCriteria(
  value: unknown,
  diagnostics: Diagnostic[]
): CumulativeAcceptanceCriterion[] {
  if (Array.isArray(value)) {
    return value.map(normalizeAcceptanceCriterion);
  }
  if (value === undefined || value === null) {
    return [];
  }
  // Present but not a list: fail closed like the controller's gate, which treats
  // a malformed acceptance-criteria container as blocking rather than satisfied.
  diagnostics.push(
    diag(
      'run-state-malformed-acceptance-criteria',
      '"cumulative_acceptance_criteria" is not a JSON array; treating as a blocking malformed criterion',
      'warning',
      'cumulative_acceptance_criteria'
    )
  );
  return [{ raw: { [MALFORMED_ENTRY_MARKER]: true, value } } as CumulativeAcceptanceCriterion];
}

const LEDGER_KNOWN_KEYS = new Set([
  'fingerprint',
  'status',
  'finding_id',
  'resolution',
  'reason',
  'evidence',
  'justification'
]);

function normalizeReviewLedger(value: unknown): ReviewLedgerEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: ReviewLedgerEntry[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const extraRaw: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(entry)) {
      if (!LEDGER_KNOWN_KEYS.has(key)) {
        extraRaw[key] = v;
      }
    }
    const item: {
      fingerprint?: string;
      status?: string;
      findingId?: string;
      resolution?: string;
      reason?: string;
      evidence?: string;
      justification?: string;
      raw: Record<string, unknown>;
    } = { raw: extraRaw };
    const fingerprint = asNonEmptyString(entry['fingerprint']);
    if (fingerprint) item.fingerprint = fingerprint;
    const status = asNonEmptyString(entry['status']);
    if (status) item.status = status;
    const findingId = asNonEmptyString(entry['finding_id']);
    if (findingId) item.findingId = findingId;
    const resolution = asNonEmptyString(entry['resolution']);
    if (resolution) item.resolution = resolution;
    const reason = asNonEmptyString(entry['reason']);
    if (reason) item.reason = reason;
    const evidence = asNonEmptyString(entry['evidence']);
    if (evidence) item.evidence = evidence;
    const justification = asNonEmptyString(entry['justification']);
    if (justification) item.justification = justification;
    entries.push(item);
  }
  return entries;
}

function normalizeCodexRunTokens(value: unknown): CodexRunTokens | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const tokens: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  const inputTokens = asInt(value['input_tokens']);
  if (inputTokens !== undefined) tokens.inputTokens = inputTokens;
  const outputTokens = asInt(value['output_tokens']);
  if (outputTokens !== undefined) tokens.outputTokens = outputTokens;
  const totalTokens = asInt(value['total_tokens']);
  if (totalTokens !== undefined) tokens.totalTokens = totalTokens;
  return tokens;
}

function normalizeCodexRuns(value: unknown): CodexRun[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const runs: CodexRun[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const run: {
      phase?: string;
      promptCharacters?: number;
      outputCharacters?: number;
      durationSeconds?: number;
      model?: string;
      reasoningEffort?: string;
      verbosity?: string;
      startedAt?: string;
      eventsArtifact?: string;
      outputArtifact?: string;
      tokens?: CodexRunTokens;
    } = {};
    const phase = asNonEmptyString(entry['phase']);
    if (phase) run.phase = phase;
    const promptCharacters = asInt(entry['prompt_characters']);
    if (promptCharacters !== undefined) run.promptCharacters = promptCharacters;
    const outputCharacters = asInt(entry['output_characters']);
    if (outputCharacters !== undefined) run.outputCharacters = outputCharacters;
    const durationSeconds = asNumber(entry['duration_seconds']);
    if (durationSeconds !== undefined) run.durationSeconds = durationSeconds;
    const model = asNonEmptyString(entry['model']);
    if (model) run.model = model;
    const reasoningEffort = asNonEmptyString(entry['reasoning_effort']);
    if (reasoningEffort) run.reasoningEffort = reasoningEffort;
    const verbosity = asNonEmptyString(entry['verbosity']);
    if (verbosity) run.verbosity = verbosity;
    const startedAt = asNonEmptyString(entry['started_at']);
    if (startedAt) run.startedAt = startedAt;
    const eventsArtifact = asNonEmptyString(entry['events_artifact']);
    if (eventsArtifact) run.eventsArtifact = eventsArtifact;
    const outputArtifact = asNonEmptyString(entry['output_artifact']);
    if (outputArtifact) run.outputArtifact = outputArtifact;
    const tokens = normalizeCodexRunTokens(entry['tokens']);
    if (tokens) run.tokens = tokens;
    runs.push(run);
  }
  return runs;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  const i = Math.trunc(value);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** Normalize already-parsed JSON into a {@link RunState}. */
export function normalizeRunState(value: unknown): RunStateParseResult {
  const diagnostics: Diagnostic[] = [];

  if (!isPlainObject(value)) {
    diagnostics.push(diag('run-state-not-object', 'run-state.json is not a JSON object', 'error'));
    return { diagnostics };
  }

  const runId = asNonEmptyString(value['run_id']);
  if (runId === undefined) {
    diagnostics.push(
      diag('run-state-missing-run-id', 'run-state.json has no string "run_id"', 'error', 'run_id')
    );
    return { diagnostics };
  }

  const rawStatus = asString(value['status']);
  if (rawStatus === undefined) {
    diagnostics.push(
      diag('run-state-missing-status', 'run-state.json has no string "status"', 'warning', 'status')
    );
  }
  const effectiveRawStatus = rawStatus ?? '';
  const status = rawStatus === undefined ? 'unknown' : normalizeStatus(rawStatus);
  if (rawStatus !== undefined && status === 'unknown') {
    diagnostics.push(
      diag('run-state-unknown-status', `Unrecognized status "${rawStatus}"`, 'warning', 'status')
    );
  }

  const schemaRaw = asNumber(value['schema_version']) ?? asNumber(value['version']);
  const schemaVersion = schemaRaw ?? 0;
  if (schemaRaw !== undefined && !SUPPORTED_SCHEMA_VERSIONS.has(schemaRaw)) {
    diagnostics.push(
      diag(
        'run-state-unsupported-schema-version',
        `Unsupported schema_version ${schemaRaw} (supported: 1, 2). Parsed best-effort.`,
        'warning',
        'schema_version'
      )
    );
  }

  const state: RunState = {
    schemaVersion,
    runId,
    ...(asNonEmptyString(value['label']) ? { label: asNonEmptyString(value['label']) } : {}),
    feature: asString(value['feature']) ?? '',
    status,
    rawStatus: effectiveRawStatus,
    phase: asString(value['phase']) ?? '',
    ...(asNonEmptyString(value['created_at'])
      ? { createdAt: asNonEmptyString(value['created_at']) }
      : {}),
    ...(asNonEmptyString(value['updated_at'])
      ? { updatedAt: asNonEmptyString(value['updated_at']) }
      : {}),
    repository: normalizeRepository(value['repository']),
    ...((): { baseline?: BaselineInfo } => {
      const baseline = normalizeBaseline(value['baseline']);
      return baseline ? { baseline } : {};
    })(),
    maxReviewRounds: clampInt(asNumber(value['max_review_rounds']), 3, 1, 5),
    reviewRound: Math.max(0, Math.trunc(asNumber(value['review_round']) ?? 0)),
    stopGateBlocks: Math.max(0, Math.trunc(asNumber(value['stop_gate_blocks']) ?? 0)),
    awaitingHumanDecision: value['awaiting_human_decision'] === true,
    ...(asNonEmptyString(value['awaiting_human_decision_reason'])
      ? { awaitingHumanDecisionReason: asNonEmptyString(value['awaiting_human_decision_reason']) }
      : {}),
    ...(asNonEmptyString(value['parent_run_id'])
      ? { parentRunId: asNonEmptyString(value['parent_run_id']) }
      : {}),
    additionalReviewRounds: Array.isArray(value['review_round_authorizations'])
      ? value['review_round_authorizations'].reduce<number>((total, item) => {
          if (!isPlainObject(item)) return total;
          const amount = asInt(item['additional_rounds']);
          return total + (amount !== undefined && amount > 0 ? amount : 0);
        }, 0)
      : 0,
    artifacts: normalizeArtifacts(value['artifacts']),
    verification: normalizeVerification(value['verification']),
    reviews: normalizeReviewRefs(value['reviews']),
    adversarialReviews: normalizeReviewRefs(value['adversarial_reviews']),
    risk: normalizeRisk(value['risk']),
    notes: asStringArray(value['notes']),
    completionGateFailures: asStringArray(value['completion_gate_failures']),
    cumulativeFindings: normalizeCumulativeFindings(value['cumulative_findings'], diagnostics),
    cumulativeAcceptanceCriteria: normalizeAcceptanceCriteria(
      value['cumulative_acceptance_criteria'],
      diagnostics
    ),
    reviewLedger: normalizeReviewLedger(value['review_ledger']),
    codexRuns: normalizeCodexRuns(value['codex_runs']),
    ...(asNonEmptyString(value['requested_mode'])
      ? { requestedMode: asNonEmptyString(value['requested_mode']) }
      : {}),
    ...(asNonEmptyString(value['effective_mode'])
      ? { effectiveMode: asNonEmptyString(value['effective_mode']) }
      : {}),
    modeReasons: asStringArray(value['mode_reasons']),
    raw: value
  };

  return { state, diagnostics };
}

/** Parse run-state.json text (tolerant of JSON errors). */
export function parseRunStateText(text: string): RunStateParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      diagnostics: [diag('run-state-parse-error', `Invalid JSON: ${message}`, 'error')]
    };
  }
  return normalizeRunState(parsed);
}
