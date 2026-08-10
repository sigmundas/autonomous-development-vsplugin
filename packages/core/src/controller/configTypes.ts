/**
 * Typed shapes for the controller's config-* JSON contract
 * (docs/config-contract.md in the controller repo).
 *
 * These types describe the WIRE format returned by controller.py. Every
 * response is validated at runtime through {@link parseControllerConfigJson}
 * before being handed to the UI, so an older or newer controller that adds or
 * omits optional fields never crashes the extension.
 *
 * Nothing here depends on the vscode API; the extension consumes these types
 * and validators from a single source of truth.
 */

import type { ControllerPhase, ControllerReasoningEffort } from './args';

/** Fixed set of reasoning-effort values the UI exposes. Mirrors the contract. */
export const REASONING_EFFORTS: readonly ControllerReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
];

/** Fixed set of phase names presented in phase configuration. */
export const CONTROLLER_PHASES: readonly ControllerPhase[] = [
  'enhance',
  'plan',
  'review',
  'adversarial'
];

/** Workflow modes accepted by presets and top-level workflow config. */
export type ControllerWorkflowMode = 'auto' | 'lean' | 'standard' | 'rigorous';

export const WORKFLOW_MODES: readonly ControllerWorkflowMode[] = [
  'auto',
  'lean',
  'standard',
  'rigorous'
];

/**
 * A Codex profile descriptor discovered under $CODEX_HOME. Descriptors never
 * carry API keys or other secrets — only the identifier, provider, model, path,
 * and validity.
 */
export interface CodexProfile {
  readonly id: string;
  readonly label?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly path?: string;
  readonly valid: boolean;
  readonly error?: string;
}

/** Response payload of `config-list-profiles`. */
export interface CodexProfileList {
  readonly codexHome?: string;
  readonly profiles: readonly CodexProfile[];
}

/** A preset descriptor as returned by `config-list-presets`. */
export interface AutonomousPreset {
  readonly name: string;
  readonly workflowMode?: ControllerWorkflowMode;
  readonly claudeRuntime?: string;
  readonly claudeModel?: string;
  readonly phases: readonly ControllerPhase[];
}

/** Response payload of `config-list-presets`. */
export interface PresetList {
  readonly configPath?: string;
  readonly activePreset?: string;
  readonly presets: readonly AutonomousPreset[];
}

/** A Claude-runtime descriptor as returned by `config-list-claude-runtimes`. */
export interface ClaudeRuntime {
  readonly name: string;
  readonly displayName?: string;
  readonly launcher?: string;
  readonly args: readonly string[];
  readonly launcherExists: boolean;
  readonly launcherExecutable: boolean;
}

/** Response payload of `config-list-claude-runtimes`. */
export interface ClaudeRuntimeList {
  readonly configPath?: string;
  readonly claudeRuntimes: readonly ClaudeRuntime[];
}

export interface ClaudeModel {
  readonly id: string;
  readonly displayName?: string;
  readonly model: string;
}

export interface ClaudeModelList {
  readonly configPath?: string;
  readonly claudeModels: readonly ClaudeModel[];
}

/** Per-phase Codex configuration snippet. */
export interface PhaseConfiguration {
  readonly profile?: string;
  readonly model?: string;
  readonly reasoningEffort?: ControllerReasoningEffort;
  readonly reasoningSummary?: string;
  readonly verbosity?: string;
}

/** Workflow-block snippet as returned inside `effective`. */
export interface WorkflowConfiguration {
  readonly maxReviewRounds?: number;
  readonly processTimeoutSeconds?: number;
  readonly workflowMode?: ControllerWorkflowMode;
}

/** Response payload of `config-show`. */
export interface EffectiveConfiguration {
  readonly configPath?: string;
  readonly configExists: boolean;
  readonly activePreset?: string;
  readonly effective: {
    readonly workflow: WorkflowConfiguration;
    readonly codex: Readonly<Record<string, PhaseConfiguration>>;
    readonly claudeRuntime?: string;
    readonly claudeModel?: ClaudeModel;
  };
  readonly presets: readonly string[];
  readonly claudeRuntimes: readonly string[];
  readonly claudeModels: readonly string[];
  readonly warnings: readonly string[];
}

/** Response payload of `config-validate`. */
export interface ConfigValidationResult {
  readonly configPath?: string;
  readonly configExists: boolean;
  readonly valid: boolean;
  readonly error?: string;
  readonly warnings: readonly string[];
}

/** Descriminated union so parsing errors flow through typed code paths. */
export type ControllerConfigResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// Runtime validators. Every field is optional at the boundary; missing/mistyped
// data produces a typed `ok: false` value rather than throwing.
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asWorkflowMode(value: unknown): ControllerWorkflowMode | undefined {
  return typeof value === 'string' && (WORKFLOW_MODES as readonly string[]).includes(value)
    ? (value as ControllerWorkflowMode)
    : undefined;
}

function asReasoningEffort(value: unknown): ControllerReasoningEffort | undefined {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ControllerReasoningEffort)
    : undefined;
}

function asPhase(value: unknown): ControllerPhase | undefined {
  return typeof value === 'string' && (CONTROLLER_PHASES as readonly string[]).includes(value)
    ? (value as ControllerPhase)
    : undefined;
}

function parsePhase(raw: unknown): PhaseConfiguration {
  if (!isObject(raw)) return {};
  const out: {
    profile?: string;
    model?: string;
    reasoningEffort?: ControllerReasoningEffort;
    reasoningSummary?: string;
    verbosity?: string;
  } = {};
  const profile = asString(raw['profile']);
  if (profile) out.profile = profile;
  const model = asString(raw['model']);
  if (model) out.model = model;
  const eff = asReasoningEffort(raw['reasoning_effort']);
  if (eff) out.reasoningEffort = eff;
  const summary = asString(raw['reasoning_summary']);
  if (summary) out.reasoningSummary = summary;
  const verbosity = asString(raw['verbosity']);
  if (verbosity) out.verbosity = verbosity;
  return out;
}

function parseWorkflow(raw: unknown): WorkflowConfiguration {
  if (!isObject(raw)) return {};
  const out: WorkflowConfiguration = {
    ...(asNumber(raw['max_review_rounds']) !== undefined
      ? { maxReviewRounds: asNumber(raw['max_review_rounds']) as number }
      : {}),
    ...(asNumber(raw['process_timeout_seconds']) !== undefined
      ? { processTimeoutSeconds: asNumber(raw['process_timeout_seconds']) as number }
      : {}),
    ...(asWorkflowMode(raw['workflow_mode'])
      ? { workflowMode: asWorkflowMode(raw['workflow_mode']) as ControllerWorkflowMode }
      : {})
  };
  return out;
}

/** Parse a `config-show` payload with best-effort tolerance for extras. */
export function parseEffectiveConfiguration(
  raw: unknown
): ControllerConfigResponse<EffectiveConfiguration> {
  if (!isObject(raw)) {
    return { ok: false, error: 'config-show response is not an object' };
  }
  const effectiveRaw = isObject(raw['effective']) ? raw['effective'] : {};
  const codexRaw = isObject(effectiveRaw['codex']) ? effectiveRaw['codex'] : {};
  const codex: Record<string, PhaseConfiguration> = {};
  for (const [key, value] of Object.entries(codexRaw)) {
    if (typeof key === 'string' && key.length > 0) {
      codex[key] = parsePhase(value);
    }
  }
  const value: EffectiveConfiguration = {
    ...(asString(raw['config_path']) ? { configPath: asString(raw['config_path']) as string } : {}),
    configExists: asBool(raw['config_exists']),
    ...(asString(raw['active_preset'])
      ? { activePreset: asString(raw['active_preset']) as string }
      : {}),
    effective: {
      workflow: parseWorkflow(effectiveRaw['workflow']),
      codex,
      ...(asString(effectiveRaw['claude_runtime'])
        ? { claudeRuntime: asString(effectiveRaw['claude_runtime']) as string }
        : {}),
      ...(parseClaudeModel(effectiveRaw['claude_model'])
        ? { claudeModel: parseClaudeModel(effectiveRaw['claude_model']) as ClaudeModel }
        : {})
    },
    presets: asStringArray(raw['presets']),
    claudeRuntimes: asStringArray(raw['claude_runtimes']),
    claudeModels: asStringArray(raw['claude_models']),
    warnings: asStringArray(raw['warnings'])
  };
  return { ok: true, value };
}

/** Parse a `config-validate` payload. */
export function parseConfigValidation(
  raw: unknown
): ControllerConfigResponse<ConfigValidationResult> {
  if (!isObject(raw)) {
    return { ok: false, error: 'config-validate response is not an object' };
  }
  const value: ConfigValidationResult = {
    ...(asString(raw['config_path']) ? { configPath: asString(raw['config_path']) as string } : {}),
    configExists: asBool(raw['config_exists']),
    valid: asBool(raw['valid']),
    ...(asString(raw['error']) ? { error: asString(raw['error']) as string } : {}),
    warnings: asStringArray(raw['warnings'])
  };
  return { ok: true, value };
}

/** Parse a `config-list-profiles` payload. */
export function parseProfileList(raw: unknown): ControllerConfigResponse<CodexProfileList> {
  if (!isObject(raw)) {
    return { ok: false, error: 'config-list-profiles response is not an object' };
  }
  const arr = Array.isArray(raw['profiles']) ? raw['profiles'] : [];
  const profiles: CodexProfile[] = [];
  for (const entry of arr) {
    if (!isObject(entry)) continue;
    const id = asString(entry['id']);
    if (!id) continue;
    profiles.push({
      id,
      ...(asString(entry['label']) ? { label: asString(entry['label']) as string } : {}),
      ...(asString(entry['provider']) ? { provider: asString(entry['provider']) as string } : {}),
      ...(asString(entry['model']) ? { model: asString(entry['model']) as string } : {}),
      ...(asString(entry['path']) ? { path: asString(entry['path']) as string } : {}),
      valid: asBool(entry['valid'], true),
      ...(asString(entry['error']) ? { error: asString(entry['error']) as string } : {})
    });
  }
  const value: CodexProfileList = {
    ...(asString(raw['codex_home']) ? { codexHome: asString(raw['codex_home']) as string } : {}),
    profiles
  };
  return { ok: true, value };
}

/** Parse a `config-list-presets` payload. */
export function parsePresetList(raw: unknown): ControllerConfigResponse<PresetList> {
  if (!isObject(raw)) {
    return { ok: false, error: 'config-list-presets response is not an object' };
  }
  const arr = Array.isArray(raw['presets']) ? raw['presets'] : [];
  const presets: AutonomousPreset[] = [];
  for (const entry of arr) {
    if (!isObject(entry)) continue;
    const name = asString(entry['name']);
    if (!name) continue;
    const phases: ControllerPhase[] = [];
    if (Array.isArray(entry['phases'])) {
      for (const p of entry['phases']) {
        const parsed = asPhase(p);
        if (parsed && !phases.includes(parsed)) {
          phases.push(parsed);
        }
      }
    }
    presets.push({
      name,
      ...(asWorkflowMode(entry['workflow_mode'])
        ? { workflowMode: asWorkflowMode(entry['workflow_mode']) as ControllerWorkflowMode }
        : {}),
      ...(asString(entry['claude_runtime'])
        ? { claudeRuntime: asString(entry['claude_runtime']) as string }
        : {}),
      ...(asString(entry['claude_model'])
        ? { claudeModel: asString(entry['claude_model']) as string }
        : {}),
      phases
    });
  }
  const value: PresetList = {
    ...(asString(raw['config_path']) ? { configPath: asString(raw['config_path']) as string } : {}),
    ...(asString(raw['active_preset'])
      ? { activePreset: asString(raw['active_preset']) as string }
      : {}),
    presets
  };
  return { ok: true, value };
}

/** Parse a `config-list-claude-runtimes` payload. */
export function parseClaudeRuntimeList(raw: unknown): ControllerConfigResponse<ClaudeRuntimeList> {
  if (!isObject(raw)) {
    return { ok: false, error: 'config-list-claude-runtimes response is not an object' };
  }
  const arr = Array.isArray(raw['claude_runtimes']) ? raw['claude_runtimes'] : [];
  const runtimes: ClaudeRuntime[] = [];
  for (const entry of arr) {
    if (!isObject(entry)) continue;
    const name = asString(entry['name']);
    if (!name) continue;
    runtimes.push({
      name,
      ...(asString(entry['display_name'])
        ? { displayName: asString(entry['display_name']) as string }
        : {}),
      ...(asString(entry['launcher']) ? { launcher: asString(entry['launcher']) as string } : {}),
      args: asStringArray(entry['args']),
      launcherExists: asBool(entry['launcher_exists']),
      launcherExecutable: asBool(entry['launcher_executable'])
    });
  }
  const value: ClaudeRuntimeList = {
    ...(asString(raw['config_path']) ? { configPath: asString(raw['config_path']) as string } : {}),
    claudeRuntimes: runtimes
  };
  return { ok: true, value };
}

export function parseClaudeModelList(raw: unknown): ControllerConfigResponse<ClaudeModelList> {
  if (!isObject(raw)) {
    return { ok: false, error: 'config-list-claude-models response is not an object' };
  }
  const models = (Array.isArray(raw['claude_models']) ? raw['claude_models'] : [])
    .map(parseClaudeModel)
    .filter((model): model is ClaudeModel => model !== undefined);
  return {
    ok: true,
    value: {
      ...(asString(raw['config_path'])
        ? { configPath: asString(raw['config_path']) as string }
        : {}),
      claudeModels: models
    }
  };
}

function parseClaudeModel(raw: unknown): ClaudeModel | undefined {
  if (!isObject(raw)) return undefined;
  const id = asString(raw['id']);
  const model = asString(raw['model']);
  if (!id || !model) return undefined;
  return {
    id,
    model,
    ...(asString(raw['display_name'])
      ? { displayName: asString(raw['display_name']) as string }
      : {})
  };
}

/**
 * Config-snapshot pinned into a run's run-state.json at init time. Provided
 * separately so the dashboard can display it read-only regardless of the
 * current global config.
 */
export interface RunConfigSnapshot {
  readonly preset?: string;
  readonly workflow?: WorkflowConfiguration;
  readonly codex: Readonly<Record<string, PhaseConfiguration>>;
  readonly claudeRuntime?: string;
  readonly claudeModel?: ClaudeModel;
}

/** Extract a config_snapshot from an arbitrary run-state object. */
export function parseRunConfigSnapshot(raw: unknown): RunConfigSnapshot | undefined {
  if (!isObject(raw)) return undefined;
  const snap = raw['config_snapshot'];
  if (!isObject(snap)) return undefined;
  const codexRaw = isObject(snap['codex']) ? snap['codex'] : {};
  const codex: Record<string, PhaseConfiguration> = {};
  for (const [key, value] of Object.entries(codexRaw)) {
    if (typeof key === 'string' && key.length > 0) {
      codex[key] = parsePhase(value);
    }
  }
  return {
    ...(asString(snap['preset']) ? { preset: asString(snap['preset']) as string } : {}),
    ...(isObject(snap['workflow']) ? { workflow: parseWorkflow(snap['workflow']) } : {}),
    codex,
    ...(asString(snap['claude_runtime'])
      ? { claudeRuntime: asString(snap['claude_runtime']) as string }
      : {}),
    ...(parseClaudeModel(snap['claude_model'])
      ? { claudeModel: parseClaudeModel(snap['claude_model']) as ClaudeModel }
      : {})
  };
}
