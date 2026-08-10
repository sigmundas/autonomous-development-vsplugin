/**
 * Pure construction of controller.py argv arrays (docs/REFERENCE.md §10;
 * config subcommands per docs/config-contract.md in the controller repo).
 *
 * NEVER build a shell string — the extension spawns via execFile with these
 * arrays. Run-scoped commands REQUIRE an explicit run id; we never rely on the
 * controller's "single active run" fallback.
 */

export type ControllerSubcommand =
  | 'doctor'
  | 'init'
  | 'list-runs'
  | 'show-run'
  | 'status'
  | 'evaluate'
  | 'accept-drift'
  | 'authorize-review'
  | 'continue-run'
  | 'start-followup-run'
  | 'cancel'
  | 'archive-run'
  | 'config-show'
  | 'config-validate'
  | 'config-list-profiles'
  | 'config-list-presets'
  | 'config-list-claude-runtimes'
  | 'config-list-claude-models'
  | 'config-set-active-preset'
  | 'config-set-phase'
  | 'config-set-claude-runtime'
  | 'config-set-claude-model';

/** Workflow rigor modes accepted by `controller.py init --mode`. */
export type ControllerInitMode = 'auto' | 'lean' | 'standard' | 'rigorous';

/** Phase identifiers accepted by `config-set-phase --phase`. */
export type ControllerPhase = 'enhance' | 'plan' | 'review' | 'adversarial';

/** Reasoning-effort levels accepted by `config-set-phase --reasoning-effort`. */
export type ControllerReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ControllerRecoveryIntent =
  | 'allow-one-more-review'
  | 'resume-adversarial'
  | 'continue-blocked';

const MUTATING: ReadonlySet<ControllerSubcommand> = new Set([
  'init',
  'evaluate',
  'accept-drift',
  'authorize-review',
  'continue-run',
  'start-followup-run',
  'cancel',
  'archive-run',
  'config-set-active-preset',
  'config-set-phase',
  'config-set-claude-runtime',
  'config-set-claude-model'
]);

/** Commands that must be scoped to an explicit --run-id. */
const RUN_SCOPED: ReadonlySet<ControllerSubcommand> = new Set([
  'show-run',
  'status',
  'evaluate',
  'accept-drift',
  'authorize-review',
  'continue-run',
  'start-followup-run',
  'cancel',
  'archive-run'
]);

/**
 * Config subcommands read/write global files and do not require repository
 * identity or a project root.
 */
const CONFIG_SUBCOMMANDS: ReadonlySet<ControllerSubcommand> = new Set([
  'config-show',
  'config-validate',
  'config-list-profiles',
  'config-list-presets',
  'config-list-claude-runtimes',
  'config-list-claude-models',
  'config-set-active-preset',
  'config-set-phase',
  'config-set-claude-runtime',
  'config-set-claude-model'
]);

export function isMutatingSubcommand(sub: ControllerSubcommand): boolean {
  return MUTATING.has(sub);
}

export function isConfigSubcommand(sub: ControllerSubcommand): boolean {
  return CONFIG_SUBCOMMANDS.has(sub);
}

export interface ControllerContext {
  /** Python executable (e.g. "python3"); becomes the spawned program. */
  readonly pythonPath: string;
  /** Absolute path to scripts/controller.py. */
  readonly controllerPath: string;
  /** Absolute repository root. Required for non-config subcommands. */
  readonly projectRoot?: string;
  /** Optional explicit state home (--state-dir). */
  readonly stateHome?: string;
}

export interface ControllerOptions {
  /** Required for run-scoped subcommands; ignored otherwise. */
  readonly runId?: string;
  /** list-runs: include archived/terminal runs (--all). */
  readonly all?: boolean;
  /** cancel: optional reason. */
  readonly reason?: string;
  /** continue-run: recovery action carried into the linked child. */
  readonly recoveryIntent?: ControllerRecoveryIntent;
  /** start-followup-run: selected durable FU-NNN ids. */
  readonly followUpIds?: readonly string[];
  /** Append --json (list-runs/show-run/status). Config-* commands always emit JSON. */
  readonly json?: boolean;
  /** init: required feature description (--feature). */
  readonly feature?: string;
  /** init: workflow rigor mode (--mode). */
  readonly mode?: ControllerInitMode;
  /** init: repository execution mode (--worktree-mode). */
  readonly worktreeMode?: 'isolated' | 'current';
  /** init: allow current-checkout mode on main/master (--allow-main). */
  readonly allowMain?: boolean;
  /** init: human-readable label stored in state (--label). */
  readonly label?: string;
  /** init: review-round budget 1–5 (--max-review-rounds). */
  readonly maxReviewRounds?: number;
  /** init: preset override (--preset NAME). */
  readonly preset?: string;
  /** config-set-active-preset / config-set-claude-runtime: positional NAME. */
  readonly name?: string;
  /** config-set-phase: --preset target. */
  readonly configPreset?: string;
  /** config-set-phase: --phase. */
  readonly phase?: ControllerPhase;
  /** config-set-phase: --profile. */
  readonly profile?: string;
  /** config-set-phase: --model. */
  readonly model?: string;
  /** config-set-phase: --reasoning-effort. */
  readonly reasoningEffort?: ControllerReasoningEffort;
  /** config-set-phase: --reasoning-summary. */
  readonly reasoningSummary?: string;
  /** config-set-phase: --verbosity. */
  readonly verbosity?: string;
}

export interface ControllerCommandLine {
  /** Program to spawn (the Python executable). */
  readonly command: string;
  /** Argument array (controller.py first). */
  readonly args: readonly string[];
  readonly mutating: boolean;
}

/**
 * Build an execFile-ready command line for a controller subcommand.
 * @throws if a run-scoped subcommand is requested without a runId.
 */
export function buildControllerCommand(
  ctx: ControllerContext,
  sub: ControllerSubcommand,
  options: ControllerOptions = {}
): ControllerCommandLine {
  if (!CONFIG_SUBCOMMANDS.has(sub) && (!ctx.projectRoot || ctx.projectRoot.length === 0)) {
    throw new Error(`Controller subcommand "${sub}" requires an explicit projectRoot`);
  }
  if (RUN_SCOPED.has(sub) && (!options.runId || options.runId.length === 0)) {
    throw new Error(`Controller subcommand "${sub}" requires an explicit runId`);
  }
  if (sub === 'init' && (!options.feature || options.feature.length === 0)) {
    throw new Error('Controller subcommand "init" requires a feature description');
  }
  if (
    (sub === 'config-set-active-preset' || sub === 'config-set-claude-runtime') &&
    (!options.name || options.name.length === 0)
  ) {
    throw new Error(`Controller subcommand "${sub}" requires a name`);
  }
  if (sub === 'config-set-phase') {
    if (!options.configPreset || options.configPreset.length === 0) {
      throw new Error('Controller subcommand "config-set-phase" requires --preset');
    }
    if (!options.phase) {
      throw new Error('Controller subcommand "config-set-phase" requires --phase');
    }
  }

  const args: string[] = [ctx.controllerPath];
  if (!CONFIG_SUBCOMMANDS.has(sub) && ctx.projectRoot) {
    args.push('--project-root', ctx.projectRoot);
  }
  if (ctx.stateHome && ctx.stateHome.length > 0) {
    args.push('--state-dir', ctx.stateHome);
  }
  if (RUN_SCOPED.has(sub) && options.runId) {
    args.push('--run-id', options.runId);
  }

  args.push(sub);

  switch (sub) {
    case 'init':
      args.push('--feature', options.feature as string);
      if (options.label && options.label.length > 0) args.push('--label', options.label);
      if (options.mode) args.push('--mode', options.mode);
      if (options.worktreeMode) args.push('--worktree-mode', options.worktreeMode);
      if (options.allowMain) args.push('--allow-main');
      if (options.maxReviewRounds !== undefined) {
        args.push('--max-review-rounds', String(options.maxReviewRounds));
      }
      if (options.preset && options.preset.length > 0) {
        args.push('--preset', options.preset);
      }
      break;
    case 'list-runs':
      if (options.json !== false) args.push('--json');
      if (options.all) args.push('--all');
      break;
    case 'show-run':
    case 'status':
      if (options.json !== false) args.push('--json');
      break;
    case 'cancel':
      if (options.reason && options.reason.length > 0) args.push('--reason', options.reason);
      break;
    case 'continue-run':
      if (options.recoveryIntent) args.push('--intent', options.recoveryIntent);
      break;
    case 'start-followup-run':
      if (!options.followUpIds || options.followUpIds.length === 0) {
        throw new Error('Controller subcommand "start-followup-run" requires followUpIds');
      }
      for (const id of options.followUpIds) args.push('--follow-up-id', id);
      if (options.label && options.label.length > 0) args.push('--label', options.label);
      break;
    case 'config-show':
    case 'config-validate':
    case 'config-list-profiles':
    case 'config-list-presets':
    case 'config-list-claude-runtimes':
    case 'config-list-claude-models':
      args.push('--json');
      break;
    case 'config-set-active-preset':
    case 'config-set-claude-runtime':
      args.push(options.name as string);
      break;
    case 'config-set-claude-model':
      if (options.name) args.push(options.name);
      break;
    case 'config-set-phase':
      args.push('--preset', options.configPreset as string);
      args.push('--phase', options.phase as string);
      if (options.profile && options.profile.length > 0) args.push('--profile', options.profile);
      if (options.model && options.model.length > 0) args.push('--model', options.model);
      if (options.reasoningEffort) {
        args.push('--reasoning-effort', options.reasoningEffort);
      }
      if (options.reasoningSummary && options.reasoningSummary.length > 0) {
        args.push('--reasoning-summary', options.reasoningSummary);
      }
      if (options.verbosity && options.verbosity.length > 0) {
        args.push('--verbosity', options.verbosity);
      }
      break;
    default:
      break;
  }

  return { command: ctx.pythonPath, args, mutating: MUTATING.has(sub) };
}
