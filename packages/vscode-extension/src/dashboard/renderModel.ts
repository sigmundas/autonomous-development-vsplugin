/**
 * Map a loaded run (+ event log) into the serializable {@link DashboardView}.
 * Host-side and vscode-free so it stays unit-testable. Every workflow judgement
 * (stages, gates, next action, verification/review summaries) comes straight
 * from the core {@link WorkflowModel}; this module only reshapes and reads the
 * per-round review files for finding detail.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONVENTIONAL_ARTIFACT_NAMES,
  countFindingsBySeverity,
  detectEventLogDisagreements,
  discoverTriageFiles,
  findingDispositionsFromEvents,
  parseReviewText,
  parseFollowUpsText,
  parseRunConfigSnapshot,
  resolveArtifactPath,
  summarizeCodexArtifact,
  type AcceptanceCriteriaModel,
  type CodexRun,
  type CodexUsageModel,
  type CumulativeAcceptanceCriterion,
  type CumulativeFinding,
  type CumulativeFindingsModel,
  type DiscoveredRun,
  type FindingDisposition,
  type LoadedEventLog,
  type FollowUpItem,
  type ReviewRef,
  type RunConfigSnapshot,
  type WorkflowStage
} from '@semanticmatter/core';

import type {
  DashboardAcceptanceCriteria,
  DashboardArtifact,
  DashboardCodexUsage,
  DashboardConfigSnapshot,
  DashboardCumulativeFindings,
  DashboardDiagnostic,
  DashboardPhaseSnapshot,
  DashboardReviewRound,
  DashboardView
} from './viewTypes';

/**
 * Event-log diagnostics default to a warning; these codes are informational
 * (forward-compat / UI memory cap) rather than data problems.
 */
const INFO_EVENT_LOG_CODES = new Set(['future-schema-version', 'retention-truncated']);

/** Merge run-state and event-log diagnostics (core + protocol) for the dashboard. */
function collectDiagnostics(run: DiscoveredRun, eventLog: LoadedEventLog): DashboardDiagnostic[] {
  const out: DashboardDiagnostic[] = run.diagnostics.map((d) => ({
    code: d.code,
    message: d.message,
    severity: d.severity
  }));
  for (const d of eventLog.diagnostics) {
    out.push({ code: d.code, message: d.message, severity: d.severity });
  }
  // Non-fatal run-state vs event-log disagreement: identity + status (accepted-plan NFR).
  for (const d of detectEventLogDisagreements(
    {
      runId: run.state?.runId ?? '',
      repositoryId: run.repoId,
      ...(run.state?.status !== undefined ? { status: run.state.status } : {})
    },
    eventLog.events
  )) {
    out.push({ code: d.code, message: d.message, severity: d.severity });
  }
  for (const d of eventLog.protocolDiagnostics) {
    const where =
      d.line !== undefined
        ? ` (line ${d.line})`
        : d.sequence !== undefined
          ? ` (sequence ${d.sequence})`
          : '';
    out.push({
      code: d.code,
      message: `events.jsonl${where}: ${d.message}`,
      severity: INFO_EVENT_LOG_CODES.has(d.code) ? 'info' : 'warning'
    });
  }
  return out;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function existsArtifact(
  runDir: string,
  ref: string | undefined,
  conventional: string
): { exists: boolean; filename: string; path: string } {
  if (ref) {
    const resolved = resolveArtifactPath(runDir, ref);
    if (resolved.path) {
      return { exists: fileExists(resolved.path), filename: ref, path: resolved.path };
    }
  }
  const path = join(runDir, conventional);
  return { exists: fileExists(path), filename: conventional, path };
}

function artifact(
  command: string,
  title: string,
  runDir: string,
  ref: string | undefined,
  conventional: string,
  summarize = false
): DashboardArtifact {
  const { exists, filename, path } = existsArtifact(runDir, ref, conventional);
  const sections = summarize && exists ? summarizeCodexArtifact(path) : [];
  return {
    command,
    title,
    exists,
    filename,
    ...(sections.length > 0 ? { sections } : {})
  };
}

function readFollowUps(runDir: string, ref: string | undefined): readonly FollowUpItem[] {
  const resolved = existsArtifact(runDir, ref, CONVENTIONAL_ARTIFACT_NAMES.followUpsJson);
  if (!resolved.exists) return [];
  try {
    return parseFollowUpsText(readFileSync(resolved.path, 'utf8')).followUps;
  } catch {
    return [];
  }
}

function reviewRound(
  runDir: string,
  ref: ReviewRef,
  dispositions: ReadonlyMap<string, FindingDisposition>
): DashboardReviewRound {
  const base: { round?: number; path?: string; verdict?: string } = {};
  if (ref.round !== undefined) base.round = ref.round;
  if (ref.path !== undefined) base.path = ref.path;
  if (ref.verdict !== undefined) base.verdict = ref.verdict;

  const unreadable: DashboardReviewRound = {
    ...base,
    readable: false,
    findings: [],
    findingCountsBySeverity: {},
    verificationGaps: [],
    acceptanceCriteria: []
  };

  if (!ref.path) {
    return unreadable;
  }
  const resolved = resolveArtifactPath(runDir, ref.path);
  if (!resolved.path) {
    return unreadable;
  }
  let text: string;
  try {
    text = readFileSync(resolved.path, 'utf8');
  } catch {
    return unreadable;
  }
  const { document } = parseReviewText(text, resolved.path);
  if (!document) {
    return unreadable;
  }
  return {
    ...base,
    // File verdict wins over the cached ref verdict when present.
    ...(document.verdict !== undefined ? { verdict: document.verdict } : {}),
    ...(document.confidence !== undefined ? { confidence: document.confidence } : {}),
    ...(document.summary !== undefined ? { summary: document.summary } : {}),
    readable: true,
    findings: document.findings.map((f) => {
      const disposition = f.id !== undefined ? dispositions.get(f.id) : undefined;
      return {
        ...(f.id !== undefined ? { id: f.id } : {}),
        ...(f.severity !== undefined ? { severity: f.severity } : {}),
        ...(f.category !== undefined ? { category: f.category } : {}),
        ...(f.file !== undefined ? { file: f.file } : {}),
        ...(f.lineStart !== undefined ? { line: f.lineStart } : {}),
        ...(f.description !== undefined ? { description: f.description } : {}),
        ...(f.evidence !== undefined ? { evidence: f.evidence } : {}),
        ...(f.recommendedFix !== undefined ? { recommendedFix: f.recommendedFix } : {}),
        ...(disposition !== undefined ? { disposition } : {})
      };
    }),
    findingCountsBySeverity: countFindingsBySeverity(document),
    verificationGaps: [...document.verificationGaps],
    acceptanceCriteria: document.acceptanceCriteriaAssessment.map((a) => ({
      ...(a.id !== undefined ? { id: a.id } : {}),
      ...(a.status !== undefined ? { status: a.status } : {}),
      ...(a.evidence !== undefined ? { evidence: a.evidence } : {})
    }))
  };
}

/**
 * Map the cumulative finding ledger. The blocking decision is NOT re-derived
 * here: a finding is blocking iff the core model placed it in `blockingSevere`
 * (reference identity, since the model returns entries from the same array).
 */
function cumulativeFindingsView(
  all: readonly CumulativeFinding[],
  model: CumulativeFindingsModel
): DashboardCumulativeFindings {
  const blockingSet = new Set(model.blockingSevere);
  return {
    total: model.total,
    blockingSevereCount: model.blockingSevereCount,
    resolvedCount: model.resolvedCount,
    openCount: model.openCount,
    findings: all.map((f) => ({
      ...(f.id !== undefined ? { id: f.id } : {}),
      ...(f.severity !== undefined ? { severity: f.severity } : {}),
      ...(f.category !== undefined ? { category: f.category } : {}),
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.lineStart !== undefined ? { line: f.lineStart } : {}),
      ...(f.description !== undefined ? { description: f.description } : {}),
      ...(f.roundOpened !== undefined ? { roundOpened: f.roundOpened } : {}),
      ...(f.roundLastSeen !== undefined ? { roundLastSeen: f.roundLastSeen } : {}),
      ...(f.origin !== undefined ? { origin: f.origin } : {}),
      blocking: blockingSet.has(f),
      ...(f.resolvedAtRound !== undefined ? { resolvedAtRound: f.resolvedAtRound } : {}),
      ...(f.resolutionSource !== undefined ? { resolutionSource: f.resolutionSource } : {}),
      ...(f.assessmentState !== undefined ? { assessmentState: f.assessmentState } : {})
    }))
  };
}

/** Map the cumulative acceptance-criteria ledger (blocking = status != satisfied). */
function acceptanceCriteriaView(
  all: readonly CumulativeAcceptanceCriterion[],
  model: AcceptanceCriteriaModel
): DashboardAcceptanceCriteria {
  const blockingSet = new Set(model.blocking);
  return {
    total: model.total,
    satisfiedCount: model.satisfiedCount,
    blockingCount: model.blockingCount,
    criteria: all.map((c) => ({
      ...(c.id !== undefined ? { id: c.id } : {}),
      ...(c.status !== undefined ? { status: c.status } : {}),
      ...(c.evidence !== undefined ? { evidence: c.evidence } : {}),
      ...(c.round !== undefined ? { round: c.round } : {}),
      ...(c.assessmentState !== undefined ? { assessmentState: c.assessmentState } : {}),
      blocking: blockingSet.has(c)
    }))
  };
}

function codexUsageView(model: CodexUsageModel): DashboardCodexUsage {
  return {
    runs: model.runs.map((r) => ({
      ...(r.phase !== undefined ? { phase: r.phase } : {}),
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.durationSeconds !== undefined ? { durationSeconds: r.durationSeconds } : {}),
      ...(r.promptCharacters !== undefined ? { promptCharacters: r.promptCharacters } : {}),
      ...(r.outputCharacters !== undefined ? { outputCharacters: r.outputCharacters } : {}),
      ...(r.tokens?.totalTokens !== undefined ? { totalTokens: r.tokens.totalTokens } : {}),
      ...(r.sessionMode !== undefined ? { sessionMode: r.sessionMode } : {}),
      ...(r.sessionFamily !== undefined ? { sessionFamily: r.sessionFamily } : {}),
      ...(r.round !== undefined ? { round: r.round } : {}),
      ...(r.sessionRotation !== undefined ? { sessionRotation: r.sessionRotation } : {}),
      ...(r.sessionFallback !== undefined ? { sessionFallback: r.sessionFallback } : {})
    })),
    totalDurationSeconds: model.totalDurationSeconds,
    totalTokens: model.totalTokens
  };
}

export interface ToDashboardViewOptions {
  /** True when the extension is currently tracking a Claude terminal for this run. */
  readonly claudeTerminalOpen?: boolean;
  /** Child run linked to this parent, derived from discovery without parent mutation. */
  readonly continuedByRunId?: string;
}

/** Build the dashboard view for a run. Returns a diagnostics-only shell when unparsed. */
export function toDashboardView(
  run: DiscoveredRun,
  eventLog: LoadedEventLog,
  options: ToDashboardViewOptions = {}
): DashboardView {
  const claudeTerminalOpen = options.claudeTerminalOpen === true;
  const diagnostics = collectDiagnostics(run, eventLog);
  const timeline = eventLog.timeline.map((e) => ({
    sequence: e.sequence,
    timestamp: e.timestamp,
    phase: e.phase,
    type: e.type,
    source: e.source,
    summary: e.summary
  }));

  const state = run.state;
  const model = run.model;
  if (!state || !model) {
    return {
      runId: run.runId,
      repoId: run.repoId,
      feature: '',
      status: 'unknown',
      phase: '',
      isTerminal: false,
      claudeTerminalOpen,
      repository: { id: run.repoId },
      stages: [],
      reviewBudget: { originalMax: 0, max: 0, consumed: 0, remaining: 0 },
      recovery: {
        reviewBudgetExhausted: false,
        awaitingHumanDecision: false,
        workPreserved: false,
        verificationPreserved: false,
        ...(options.continuedByRunId !== undefined
          ? { continuedByRunId: options.continuedByRunId }
          : {})
      },
      completion: { followUpCount: 0 },
      followUps: [],
      verification: {
        hasChecks: false,
        passed: false,
        passedCount: 0,
        failedCount: 0,
        total: 0,
        checks: []
      },
      review: { hasReviews: false, severeFindingCount: 0, rounds: [], triageFiles: [] },
      adversarial: { required: false, satisfied: true, reasons: [], rounds: [] },
      risk: { requiresAdversarialReview: false, reasons: [] },
      cumulativeFindings: {
        total: 0,
        blockingSevereCount: 0,
        resolvedCount: 0,
        openCount: 0,
        findings: []
      },
      acceptanceCriteria: { total: 0, satisfiedCount: 0, blockingCount: 0, criteria: [] },
      codexUsage: { runs: [], totalDurationSeconds: 0, totalTokens: 0 },
      gateFailures: [],
      gatesPass: false,
      nextAction: { code: 'none', message: '' },
      artifacts: [],
      timeline,
      truncatedTimeline: eventLog.truncatedTail,
      diagnostics,
      currentActivity: {
        phase: '',
        nextActionMessage: '',
        claudeTerminalOpen
      }
    };
  }

  const runDir = run.runDir;
  const dispositions = findingDispositionsFromEvents(eventLog.events);
  const artifacts: DashboardArtifact[] = [
    artifact(
      'autonomousDev.openOriginalFeature',
      'Original feature idea',
      runDir,
      state.artifacts.featureRequest,
      CONVENTIONAL_ARTIFACT_NAMES.featureRequest
    ),
    artifact(
      'autonomousDev.openEnhancedSpec',
      'Codex-enhanced specification',
      runDir,
      state.artifacts.enhance,
      CONVENTIONAL_ARTIFACT_NAMES.enhance,
      true
    ),
    artifact(
      'autonomousDev.openAcceptedSpec',
      'Claude-accepted specification',
      runDir,
      state.artifacts.acceptedSpec,
      CONVENTIONAL_ARTIFACT_NAMES.acceptedSpec
    ),
    artifact(
      'autonomousDev.openProposedPlan',
      'Codex-proposed plan',
      runDir,
      state.artifacts.plan,
      CONVENTIONAL_ARTIFACT_NAMES.plan,
      true
    ),
    artifact(
      'autonomousDev.openAcceptedPlan',
      'Claude-accepted plan',
      runDir,
      state.artifacts.acceptedPlan,
      CONVENTIONAL_ARTIFACT_NAMES.acceptedPlan
    )
  ];
  const followUps = readFollowUps(runDir, state.artifacts.followUpsJson);
  if (followUps.length > 0 || state.artifacts.followUpsMarkdown || state.artifacts.followUpsJson) {
    artifacts.push(
      artifact(
        'autonomousDev.openFollowUps',
        'Deferred follow-ups',
        runDir,
        state.artifacts.followUpsMarkdown,
        CONVENTIONAL_ARTIFACT_NAMES.followUpsMarkdown
      )
    );
  }

  const checks = model.verification.latest.map((c) => ({
    name: c.name,
    command: c.command.join(' '),
    ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}),
    passed: c.exitCode === 0,
    ...(c.startedAt !== undefined ? { startedAt: c.startedAt } : {}),
    ...(c.completedAt !== undefined ? { completedAt: c.completedAt } : {}),
    ...(c.log !== undefined ? { log: c.log } : {}),
    attempts: model.verification.attemptsByName[c.name]?.length ?? 1
  }));

  const latestNote = state.notes.length > 0 ? state.notes[state.notes.length - 1] : undefined;

  return {
    runId: state.runId,
    repoId: run.repoId,
    feature: state.feature,
    ...(state.label !== undefined ? { label: state.label } : {}),
    status: model.status,
    phase: model.phase,
    isTerminal: model.isTerminal,
    claudeTerminalOpen,
    ...(model.blockingReason !== undefined ? { blockingReason: model.blockingReason } : {}),
    repository: {
      id: state.repository.id,
      ...(state.repository.displayName !== undefined
        ? { displayName: state.repository.displayName }
        : {}),
      ...(state.repository.worktreePath !== undefined
        ? { worktreePath: state.repository.worktreePath }
        : {}),
      ...(state.repository.worktreeMode !== undefined
        ? { worktreeMode: state.repository.worktreeMode }
        : {}),
      ...(state.repository.remoteDisplay !== undefined
        ? { remoteDisplay: state.repository.remoteDisplay }
        : {}),
      ...(state.baseline?.branch ? { branch: state.baseline.branch } : {}),
      ...(state.baseline?.commit ? { baselineCommit: state.baseline.commit } : {})
    },
    ...(state.createdAt !== undefined ? { createdAt: state.createdAt } : {}),
    ...(state.updatedAt !== undefined ? { updatedAt: state.updatedAt } : {}),
    stages: refineStagesForImplementerRunning(model.stages, {
      claudeTerminalOpen,
      controllerPhase: state.phase,
      hasChecks: model.verification.hasChecks,
      status: state.status
    }).map((s) => {
      const meta = stageMetaFor(s.id, run, state.codexRuns);
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        ...(s.detail !== undefined ? { detail: s.detail } : {}),
        ...(meta.line !== undefined ? { meta: meta.line } : {}),
        ...(meta.tooltip !== undefined ? { metaTooltip: meta.tooltip } : {})
      };
    }),
    reviewBudget: model.reviewBudget,
    recovery: {
      reviewBudgetExhausted: state.reviewBudgetExhausted === true,
      awaitingHumanDecision: state.awaitingHumanDecision === true,
      workPreserved:
        state.status === 'blocked' ||
        state.reviewBudgetExhausted ||
        state.parentRunId !== undefined,
      verificationPreserved: model.verification.hasChecks,
      ...(state.parentRunId !== undefined ? { parentRunId: state.parentRunId } : {}),
      ...(options.continuedByRunId !== undefined
        ? { continuedByRunId: options.continuedByRunId }
        : {}),
      ...(state.awaitingHumanDecisionReason !== undefined
        ? { humanDecisionReason: state.awaitingHumanDecisionReason }
        : {}),
      ...(state.awaitingHumanDecisionPhase !== undefined
        ? { humanDecisionPhase: state.awaitingHumanDecisionPhase }
        : {})
    },
    completion: {
      ...(model.completionEvaluation?.result !== undefined
        ? { result: model.completionEvaluation.result }
        : {}),
      ...(model.completionEvaluation?.summary !== undefined
        ? { summary: model.completionEvaluation.summary }
        : {}),
      followUpCount: followUps.length || model.completionEvaluation?.followUpCount || 0
    },
    followUps: followUps.map((item) => ({
      id: item.id,
      title: item.title,
      ...(item.severity !== undefined ? { severity: item.severity } : {}),
      ...(item.category !== undefined ? { category: item.category } : {}),
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.whyDeferred !== undefined ? { whyDeferred: item.whyDeferred } : {}),
      ...(item.provenance !== undefined ? { provenance: item.provenance } : {})
    })),
    verification: {
      hasChecks: model.verification.hasChecks,
      passed: model.verification.passed,
      passedCount: model.verification.passedCount,
      failedCount: model.verification.failedCount,
      total: model.verification.total,
      checks
    },
    review: {
      hasReviews: model.review.hasReviews,
      ...(model.review.latestVerdict !== undefined
        ? { latestVerdict: model.review.latestVerdict }
        : {}),
      ...(model.review.latestRound !== undefined ? { latestRound: model.review.latestRound } : {}),
      severeFindingCount: model.review.severeFindingCount,
      rounds: state.reviews.map((r) => reviewRound(runDir, r, dispositions)),
      triageFiles: discoverTriageFiles(runDir).map((filename) => ({ filename }))
    },
    adversarial: {
      required: model.adversarial.required,
      satisfied: model.adversarial.satisfied,
      reasons: model.adversarial.reasons,
      rounds: state.adversarialReviews.map((r) => reviewRound(runDir, r, dispositions)),
      ...(model.adversarial.latestRound !== undefined
        ? { latestRound: model.adversarial.latestRound }
        : {}),
      ...(model.adversarial.latestVerdict !== undefined
        ? { latestVerdict: model.adversarial.latestVerdict }
        : {})
    },
    risk: model.riskClassification,
    ...(model.effectiveMode !== undefined ? { effectiveMode: model.effectiveMode } : {}),
    cumulativeFindings: cumulativeFindingsView(state.cumulativeFindings, model.cumulativeFindings),
    acceptanceCriteria: acceptanceCriteriaView(
      state.cumulativeAcceptanceCriteria,
      model.acceptanceCriteria
    ),
    ...(model.checkpoint !== undefined
      ? {
          checkpoint: {
            ...(model.checkpoint.id !== undefined ? { id: model.checkpoint.id } : {}),
            ...(model.checkpoint.reviewContextMode !== undefined
              ? { reviewContextMode: model.checkpoint.reviewContextMode }
              : {}),
            changedPathsCount: model.checkpoint.changedPathsCount,
            isDelta: model.checkpoint.isDelta
          }
        }
      : {}),
    codexUsage: codexUsageView(model.codexUsage),
    gateFailures: model.completionGateFailures.map((g) => ({ code: g.code, message: g.message })),
    gatesPass: model.gatesPass,
    nextAction: model.recommendedNextAction,
    artifacts,
    timeline,
    truncatedTimeline: eventLog.truncatedTail,
    diagnostics,
    ...(buildConfigSnapshotView(state.raw)
      ? { configSnapshot: buildConfigSnapshotView(state.raw) as DashboardConfigSnapshot }
      : {}),
    currentActivity: {
      phase: model.phase,
      nextActionMessage: model.recommendedNextAction.message,
      ...(latestNote !== undefined ? { latestNote } : {}),
      ...(state.updatedAt !== undefined ? { updatedAt: state.updatedAt } : {}),
      claudeTerminalOpen
    }
  };
}

function buildConfigSnapshotView(raw: unknown): DashboardConfigSnapshot | undefined {
  const snap = parseRunConfigSnapshot(raw);
  if (!snap) return undefined;
  return toDashboardConfigSnapshot(snap);
}

function toDashboardConfigSnapshot(snap: RunConfigSnapshot): DashboardConfigSnapshot {
  const phases: DashboardPhaseSnapshot[] = [];
  for (const [phase, conf] of Object.entries(snap.codex)) {
    phases.push({
      phase,
      ...(conf.profile !== undefined ? { profile: conf.profile } : {}),
      ...(conf.model !== undefined ? { model: conf.model } : {}),
      ...(conf.reasoningEffort !== undefined ? { reasoningEffort: conf.reasoningEffort } : {}),
      ...(conf.reasoningSummary !== undefined ? { reasoningSummary: conf.reasoningSummary } : {}),
      ...(conf.verbosity !== undefined ? { verbosity: conf.verbosity } : {})
    });
  }
  return {
    ...(snap.preset !== undefined ? { preset: snap.preset } : {}),
    ...(snap.workflow?.workflowMode !== undefined
      ? { workflowMode: snap.workflow.workflowMode }
      : {}),
    ...(snap.workflow?.maxReviewRounds !== undefined
      ? { maxReviewRounds: snap.workflow.maxReviewRounds }
      : {}),
    ...(snap.workflow?.reuseCodexReviewContext !== undefined
      ? { reuseCodexReviewContext: snap.workflow.reuseCodexReviewContext }
      : {}),
    ...(snap.claudeRuntime !== undefined ? { claudeRuntime: snap.claudeRuntime } : {}),
    ...(snap.claudeModel !== undefined ? { claudeModel: snap.claudeModel } : {}),
    phases
  };
}

/**
 * Compact secondary metadata for a stage in the workflow timeline. For
 * Codex-owned stages this pulls provider/model + reasoning-effort from the
 * config_snapshot and prefers the concrete model reported by Codex telemetry
 * when present. For the Claude-owned implementation stage it uses the
 * snapshotted Claude runtime name. When neither is available, it returns
 * empty fields — the webview then skips the meta line for that stage.
 *
 * Nothing here is invented: we only surface values that are already present in
 * the run's state, config_snapshot, or codex_runs telemetry.
 */
export function stageMetaFor(
  stageId: string,
  run: DiscoveredRun,
  codexRuns: readonly CodexRun[]
): { line?: string; tooltip?: string } {
  const snap = parseRunConfigSnapshot(run.state?.raw);
  if (stageId === 'implementing') {
    if (!snap) return {};
    if (!snap.claudeRuntime) return {};
    const model = snap.claudeModel?.displayName ?? snap.claudeModel?.id;
    return { line: [snap.claudeRuntime, model].filter(Boolean).join(' · ') };
  }
  const phaseKey = codexPhaseForStage(stageId);
  if (!phaseKey) return {};
  const conf = snap?.codex[phaseKey];
  const telemetry = codexRuns.find((r) => r.phase === phaseKey);
  const reportedModel = meaningfulTelemetryValue(telemetry?.model);
  const snapshotModel = meaningfulTelemetryValue(conf?.model);
  const model = reportedModel ?? snapshotModel;
  const effort = telemetry?.reasoningEffort ?? conf?.reasoningEffort;
  const profileId = conf?.profile;
  const parts: string[] = [];
  if (model) parts.push(model);
  else if (profileId) parts.push(profileId);
  if (effort) parts.push(formatEffort(effort));
  if (parts.length === 0) {
    return snap === undefined ? { line: 'configuration unavailable' } : {};
  }
  const line = parts.join(' · ');
  const tooltip = profileId ? `Profile: ${profileId}` : undefined;
  return tooltip !== undefined ? { line, tooltip } : { line };
}

function meaningfulTelemetryValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === '(default)' || trimmed.toLowerCase() === 'default') {
    return undefined;
  }
  return trimmed;
}

function codexPhaseForStage(stageId: string): string | undefined {
  switch (stageId) {
    case 'idea-enhanced':
      return 'enhance';
    case 'plan-proposed':
    case 'plan-accepted':
      return 'plan';
    case 'independent-review':
      return 'review';
    case 'adversarial-review':
      return 'adversarial';
    default:
      return undefined;
  }
}

function formatEffort(effort: string): string {
  switch (effort) {
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'XHigh';
    default:
      return effort;
  }
}

/**
 * Controller phases at which implementation is actively underway. Terminal
 * liveness alone is not workflow evidence: Claude remains alive while it
 * orchestrates specification and planning work.
 */
const IMPLEMENTATION_ACTIVE_PHASES: ReadonlySet<string> = new Set([
  'plan-accepted',
  'implementing'
]);

/**
 * Phases at which the controller has explicitly transitioned to verification.
 * Only these count for the "controller state has transitioned to verification"
 * condition of the Verification-active rule.
 */
const VERIFICATION_PHASES: ReadonlySet<string> = new Set(['verification', 'verification-failed']);

export interface ImplementerRefinementFacts {
  /** True iff an extension-managed Claude terminal is currently alive for the run. */
  readonly claudeTerminalOpen: boolean;
  /** The controller's authoritative phase, verbatim from run-state.json. */
  readonly controllerPhase: string;
  /** True iff at least one verification action has started or been recorded. */
  readonly hasChecks: boolean;
  /** Normalised run status (used to short-circuit for terminal statuses). */
  readonly status: string;
}

/**
 * Post-pass refinement of the canonical stages returned by the core evaluator.
 * Enforces two run-scoped invariants that require VS Code-host awareness
 * (specifically, whether an extension-managed Claude terminal is alive for the
 * run):
 *
 * 1. While an extension-managed Claude terminal is alive AND the controller
 *    records an implementation phase, Implementing remains active. Earlier
 *    specification and planning phases remain authoritative.
 *
 * 2. Verification may become active only when BOTH conditions hold:
 *    (a) the controller state has transitioned to verification (phase is
 *        `verification` or `verification-failed`), and
 *    (b) at least one verification action has started or been recorded
 *        (hasChecks is true).
 *    Otherwise Verification remains pending — never promoted to active by an
 *    earlier heuristic. Verification=failed continues to be shown when checks
 *    have run but did not all pass; that is orthogonal to the active rule.
 */
export function refineStagesForImplementerRunning(
  stages: readonly WorkflowStage[],
  facts: ImplementerRefinementFacts
): WorkflowStage[] {
  // Terminal statuses: no refinement — the canonical stages already encode the
  // right story (complete / blocked / cancelled / archived).
  if (
    facts.status === 'complete' ||
    facts.status === 'complete_with_followups' ||
    facts.status === 'cancelled' ||
    facts.status === 'archived'
  ) {
    return [...stages];
  }

  const implementationIsActive = IMPLEMENTATION_ACTIVE_PHASES.has(facts.controllerPhase);
  const verificationCanBeActive = VERIFICATION_PHASES.has(facts.controllerPhase) && facts.hasChecks;

  return stages.map((stage): WorkflowStage => {
    if (stage.id === 'implementing') {
      // Rule 1: hold Implementing at active while Claude is still working.
      if (facts.claudeTerminalOpen && implementationIsActive) {
        return { ...stage, status: 'active' };
      }
      return stage;
    }
    if (stage.id === 'verification') {
      // Rule 2: Verification may be active only when both conditions hold.
      if (stage.status === 'active' && !verificationCanBeActive) {
        return { ...stage, status: 'pending' };
      }
      return stage;
    }
    return stage;
  });
}
