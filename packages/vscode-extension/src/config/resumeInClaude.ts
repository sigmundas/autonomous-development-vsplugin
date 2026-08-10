import * as path from 'node:path';

import * as vscode from 'vscode';
import {
  parseRunConfigSnapshot,
  type ClaudeRuntime,
  type DiscoveredRun,
  type RunConfigSnapshot
} from '@semanticmatter/core';

import type { ConfigStore } from '../configStore';
import type { OutputLog } from '../output';
import { isWorkspaceTrusted } from '../trust';
import {
  buildLauncherArgs,
  withAutonomousClaudePermissions
} from './claudeLauncher';
import {
  type ClaudeTerminalRegistry
} from './claudeTerminalRegistry';
import {
  terminalIdentityForRun,
  type ClaudeTerminalIdentity
} from './claudeTerminalIdentity';

export interface ResumeInClaudeDeps {
  readonly store: ConfigStore;
  readonly log: OutputLog;
  readonly getControllerPath: () => string;
  /**
   * Per-run terminal registry. Prevents duplicate Claude sessions per run and
   * enables the Focus-terminal affordance. Optional so pure unit tests of the
   * planning helpers can omit it.
   */
  readonly registry?: ClaudeTerminalRegistry;
  /**
   * Terminal factory. Extracted so tests can substitute a spy without spinning
   * up the real VS Code terminal API.
   */
  readonly createTerminal?: (options: vscode.TerminalOptions) => vscode.Terminal;
  /**
   * Notification adapter. Extracted for the same reason.
   */
  readonly showInfo?: (message: string) => Thenable<string | undefined>;
  readonly showError?: (message: string) => Thenable<string | undefined>;
}

/** Reasoning behind the runtime the resume command ultimately selected. */
export type RuntimeSource =
  | { readonly kind: 'snapshot'; readonly runtimeName: string }
  | { readonly kind: 'fallback'; readonly runtimeName: string; readonly reason: FallbackReason }
  | { readonly kind: 'unavailable'; readonly reason: FallbackReason };

export type FallbackReason =
  | 'legacy-run-no-snapshot'
  | 'snapshot-runtime-not-defined'
  | 'snapshot-runtime-missing'
  | 'no-global-runtime';

export interface ResumeInClaudePlan {
  readonly run: DiscoveredRun;
  readonly runtime: ClaudeRuntime | undefined;
  readonly source: RuntimeSource;
  readonly worktreePath: string;
  readonly pluginDir?: string;
  /** Argv the launcher will be spawned with (launcher first, then args, then --plugin-dir). */
  readonly launcherArgv: readonly string[];
  /** Resume-only safety contract appended to Claude's system prompt. */
  readonly instruction: string;
  /** First user prompt, which explicitly invokes the dedicated Resume skill. */
  readonly bootstrapPrompt: string;
}

const RESUME_INSTRUCTION_TEMPLATE = (runId: string): string =>
  [
    `This session was launched by an explicit Resume action for existing autonomous-development run ${runId}.`,
    'Do not call controller.py init, do not initialize or create a run, and do not use a Start skill.',
    `Use only /autonomous-development:autonomous-resume ${runId}; recover state from the plugin-root controller with that explicit run ID.`
  ].join('\n');

export const AUTONOMOUS_RESUME_SKILL = '/autonomous-development:autonomous-resume';

// Mirrors core scripts/state.py validate_run_id: safe as one path/prompt token,
// including migrated runs whose IDs predate the timestamp format.
const CONTROLLER_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export function autonomousResumeBootstrapPrompt(runId: string): string {
  if (!CONTROLLER_RUN_ID.test(runId)) {
    throw new Error(`Refusing to bootstrap Resume with an invalid controller run ID: ${runId}`);
  }
  return `${AUTONOMOUS_RESUME_SKILL} ${runId}`;
}

/**
 * Extract the config snapshot from a run's raw state. Returns undefined for
 * legacy runs that predate config-snapshotting.
 */
export function snapshotFor(run: DiscoveredRun): RunConfigSnapshot | undefined {
  const raw = run.state?.raw as unknown;
  return parseRunConfigSnapshot(raw);
}

/**
 * Resolve which Claude runtime a resume should use for a run. The snapshot
 * wins where available; global preset selection is only used for legacy runs
 * that lack a `config_snapshot`, and even then only when the global runtime is
 * defined in the current runtime list.
 */
export function resolveRuntimeForRun(
  run: DiscoveredRun,
  runtimes: readonly ClaudeRuntime[],
  globalRuntimeName: string | undefined
): { runtime: ClaudeRuntime | undefined; source: RuntimeSource } {
  const snap = snapshotFor(run);
  const snapshotRuntimeName = snap?.claudeRuntime;

  if (snap && snapshotRuntimeName) {
    const runtime = runtimes.find((r) => r.name === snapshotRuntimeName);
    if (runtime) {
      return {
        runtime,
        source: { kind: 'snapshot', runtimeName: snapshotRuntimeName }
      };
    }
    return {
      runtime: undefined,
      source: {
        kind: 'unavailable',
        reason: 'snapshot-runtime-not-defined'
      }
    };
  }

  // No snapshot — legacy run. Fall back only if the global preset defines a runtime.
  if (!snap) {
    if (globalRuntimeName) {
      const runtime = runtimes.find((r) => r.name === globalRuntimeName);
      if (runtime) {
        return {
          runtime,
          source: {
            kind: 'fallback',
            runtimeName: globalRuntimeName,
            reason: 'legacy-run-no-snapshot'
          }
        };
      }
    }
    return {
      runtime: undefined,
      source: { kind: 'unavailable', reason: 'no-global-runtime' }
    };
  }

  // Snapshot exists but names no runtime — treat as unavailable rather than
  // silently substituting the current global preset's runtime.
  return {
    runtime: undefined,
    source: { kind: 'unavailable', reason: 'snapshot-runtime-missing' }
  };
}

/**
 * Derive the installed plugin root from the configured controller path. See
 * commands/controllerCommands.ts for the sibling utility used elsewhere.
 */
export function pluginDirFromControllerPath(controllerPath: string): string | undefined {
  if (controllerPath.length === 0) return undefined;
  const scriptsDir = path.dirname(controllerPath);
  if (path.basename(scriptsDir) !== 'scripts') return undefined;
  return path.dirname(scriptsDir);
}

/**
 * Resolve the worktree path a resume should be rooted at. Prefer the run's
 * explicit worktree path (isolated worktree mode), then its canonical root
 * (current-checkout mode), and finally the active workspace folder.
 */
export function worktreeForRun(run: DiscoveredRun): string | undefined {
  const repo = run.state?.repository;
  return (
    repo?.worktreePath ??
    repo?.canonicalRoot ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
}

/**
 * Build a fully-validated resume plan without executing anything. Returned as
 * a plain object so tests can assert every step of the resolution without a
 * running VS Code host.
 */
export function planResumeInClaude(
  run: DiscoveredRun,
  runtimes: readonly ClaudeRuntime[],
  globalRuntimeName: string | undefined,
  controllerPath: string,
  worktreePath: string
): ResumeInClaudePlan {
  const { runtime, source } = resolveRuntimeForRun(run, runtimes, globalRuntimeName);
  const pluginDir = pluginDirFromControllerPath(controllerPath);
  const instruction = RESUME_INSTRUCTION_TEMPLATE(run.runId);
  const bootstrapPrompt = autonomousResumeBootstrapPrompt(run.runId);
  const launcherArgv: string[] = runtime
    ? withAutonomousClaudePermissions(buildLauncherArgs(runtime))
    : [];
  if (pluginDir && runtime) {
    launcherArgv.push('--plugin-dir', pluginDir);
  }
  if (runtime) {
    // Claude's positional prompt is submitted automatically when the
    // interactive session starts. The system addition makes the Resume-only
    // boundary model-visible even before the dedicated skill expands.
    launcherArgv.push('--append-system-prompt', instruction, bootstrapPrompt);
  }
  return {
    run,
    runtime,
    source,
    worktreePath,
    ...(pluginDir !== undefined ? { pluginDir } : {}),
    launcherArgv,
    instruction,
    bootstrapPrompt
  };
}

function fallbackReasonMessage(reason: FallbackReason, runId: string): string {
  switch (reason) {
    case 'legacy-run-no-snapshot':
      return `Run ${runId} is a legacy run without a config_snapshot; falling back to the currently configured Claude runtime.`;
    case 'snapshot-runtime-not-defined':
      return `Run ${runId} was created with a Claude runtime that is no longer defined in the current configuration. Add it back to config.toml or choose a runtime for new runs.`;
    case 'snapshot-runtime-missing':
      return `Run ${runId} does not name a Claude runtime in its config_snapshot. Use "Launch Claude for New Runs" if you want to start a fresh unbound session instead.`;
    case 'no-global-runtime':
      return `No Claude runtime is configured. Set one via "Configure Claude Runtime" before resuming.`;
  }
}

/** Prefix all extension-managed, repository-qualified Resume terminal names share. */
export const CLAUDE_TERMINAL_NAME_PREFIX = 'Autonomous Development · ';
const CLAUDE_TERMINAL_NAME_SEPARATOR = ' · ';

/** Env vars stamped onto every extension-created Claude terminal. */
export const CLAUDE_TERMINAL_ENV_MARKER = 'AUTODEV_CLAUDE_TERMINAL';
export const CLAUDE_TERMINAL_RUN_ENV = 'AUTODEV_RUN_ID';

/**
 * Compose the terminal name for a run. This is deterministic — it appears
 * verbatim in {@link vscode.Terminal.name} and is what
 * {@link parseClaudeTerminalIdentity} uses after an extension reload.
 */
export function claudeTerminalNameFor(identity: ClaudeTerminalIdentity): string {
  return (
    CLAUDE_TERMINAL_NAME_PREFIX +
    encodeURIComponent(identity.repositoryId) +
    CLAUDE_TERMINAL_NAME_SEPARATOR +
    encodeURIComponent(identity.runId)
  );
}

/**
 * Extract the qualified identity from a terminal name previously produced by
 * {@link claudeTerminalNameFor}. Returns `undefined` when the name does not
 * match — never guesses.
 */
export function parseClaudeTerminalIdentity(
  name: string
): ClaudeTerminalIdentity | undefined {
  if (!name.startsWith(CLAUDE_TERMINAL_NAME_PREFIX)) return undefined;
  const tail = name.slice(CLAUDE_TERMINAL_NAME_PREFIX.length).trim();
  const parts = tail.split(CLAUDE_TERMINAL_NAME_SEPARATOR);
  if (parts.length !== 2) return undefined;
  try {
    const repositoryId = decodeURIComponent(parts[0] ?? '');
    const runId = decodeURIComponent(parts[1] ?? '');
    if (!repositoryId || !CONTROLLER_RUN_ID.test(runId)) return undefined;
    return { repositoryId, runId };
  } catch {
    return undefined;
  }
}

/**
 * Known interactive-shell binary names. If a terminal's `shellPath` matches
 * one of these, other extensions (notably `ms-python.python`) will consider
 * the terminal "activatable" and inject Python virtualenv-activation text via
 * {@link vscode.Terminal.sendText}. We must ensure our launcher path never
 * matches any of these so Python skips our terminals structurally — no timing
 * assumptions, no delayed sends.
 */
const KNOWN_SHELL_BINARIES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'pwsh',
  'powershell',
  'powershell.exe',
  'pwsh.exe',
  'cmd',
  'cmd.exe'
]);

export function isKnownShellBinary(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const base = candidate.split(/[\\/]/).pop() ?? candidate;
  return KNOWN_SHELL_BINARIES.has(base.toLowerCase());
}

/**
 * Build the {@link vscode.TerminalOptions} used to launch (or focus) a Claude
 * runtime for a run. Extracted for tests — we assert on shellPath/shellArgs/cwd
 * without ever spawning a real terminal.
 *
 * The options set here structurally block Python auto-activation from ever
 * reaching Claude:
 *
 * 1. `hideFromUser` is set at creation time. VS Code's Python environment
 *    extensions treat that creation option as an explicit activation opt-out,
 *    so they do not call `Terminal.sendText` with an activation command. We
 *    still reveal the terminal immediately after creation; the immutable
 *    creation option remains available to activation listeners.
 * 2. `shellPath` is the launcher binary itself (not `/bin/bash` or another
 *    interactive shell). The Python extension only injects activation into
 *    terminals whose shell it recognizes; a launcher path fails that check.
 * 3. Deterministic env markers (`AUTODEV_RUN_ID`, `AUTODEV_CLAUDE_TERMINAL=1`)
 *    let observers — and this extension's own registry recovery — identify
 *    the terminal even without cooperating shells.
 * 4. The terminal name follows a stable repository-qualified pattern parsed by
 *    {@link parseClaudeTerminalIdentity}, so post-reload recovery works even
 *    when the in-memory registry is empty.
 */
export function buildTerminalOptions(plan: ResumeInClaudePlan): vscode.TerminalOptions {
  const [shellPath, ...shellArgs] = plan.launcherArgv;
  if (isKnownShellBinary(shellPath)) {
    throw new Error(
      `Refusing to launch Claude via a known shell binary (${shellPath}). ` +
        `The runtime launcher must be a non-shell process so Python auto-activation ` +
        `cannot inject "source .../activate" into Claude's input.`
    );
  }
  const env: Record<string, string> = {
    [CLAUDE_TERMINAL_ENV_MARKER]: '1',
    [CLAUDE_TERMINAL_RUN_ENV]: plan.run.runId
  };
  return {
    name: claudeTerminalNameFor(terminalIdentityForRun(plan.run)),
    cwd: plan.worktreePath,
    hideFromUser: true,
    ...(shellPath !== undefined ? { shellPath } : {}),
    shellArgs,
    env
  };
}

/**
 * Resume a specific run in Claude Code by launching the run's snapshotted
 * Claude runtime rooted at the run's worktree.
 *
 * Semantics:
 *
 * - Never invokes `controller init`. Never creates a second controller run.
 * - Never sends text into an interactive shell after Claude has started. The
 *   terminal is created with Python's activation opt-out and its process is
 *   the Claude launcher itself (via `shellPath`/`shellArgs`).
 * - Only one extension-tracked Claude terminal exists per run at a time.
 *   Calling this while a tracked terminal is alive focuses that terminal
 *   instead of spawning a new one.
 */
export async function resumeRunInClaude(
  run: DiscoveredRun,
  deps: ResumeInClaudeDeps
): Promise<ResumeInClaudePlan | undefined> {
  const identity = terminalIdentityForRun(run);
  if (deps.registry) {
    return deps.registry.withRunLock(identity, () => runResumeInClaude(run, deps));
  }
  return runResumeInClaude(run, deps);
}

async function runResumeInClaude(
  run: DiscoveredRun,
  deps: ResumeInClaudeDeps
): Promise<ResumeInClaudePlan | undefined> {
  const showError = deps.showError ?? ((msg: string) => vscode.window.showErrorMessage(msg));
  const showInfo = deps.showInfo ?? ((msg: string) => vscode.window.showInformationMessage(msg));

  if (!isWorkspaceTrusted()) {
    void showError('Resuming a run in Claude requires a trusted workspace.');
    return undefined;
  }
  if (run.state?.status && terminalStatus(run.state.status)) {
    void showError(
      `Run ${run.runId} is ${run.state.status} and cannot be resumed. Start a new run instead.`
    );
    return undefined;
  }

  // Focus-existing wins over spawn-new so repeated clicks never duplicate.
  // Recover first: this catches terminals that were opened before the current
  // extension activation (window reload) OR by another code path that went
  // straight through vscode.window.createTerminal without the registry.
  const registry = deps.registry;
  const identity = terminalIdentityForRun(run);
  if (registry) {
    registry.recoverExistingTerminals();
    if (registry.has(identity) && registry.focus(identity)) {
      deps.log.info(`resumeInClaude focus existing terminal for run=${run.runId}`);
      return undefined;
    }
  }

  await deps.store.refresh();
  // While config refresh is in flight, the run-store watcher can discover and
  // late-bind the original Start terminal. Re-check before spawning.
  if (registry?.has(identity) && registry.focus(identity)) {
    deps.log.info(`resumeInClaude focus terminal bound during refresh for run=${run.runId}`);
    return undefined;
  }
  const snap = deps.store.current;
  if (!snap.controllerAvailable) {
    void showError(
      'No controller is configured; the Claude runtime for this run cannot be resolved.'
    );
    return undefined;
  }
  const worktreePath = worktreeForRun(run);
  if (!worktreePath) {
    void showError(
      `Cannot determine a worktree for run ${run.runId}. Open the repository folder in VS Code and try again.`
    );
    return undefined;
  }

  const runtimes = snap.runtimes?.claudeRuntimes ?? [];
  const globalRuntime = snap.effective?.effective.claudeRuntime;
  const plan = planResumeInClaude(
    run,
    runtimes,
    globalRuntime,
    deps.getControllerPath(),
    worktreePath
  );

  if (!plan.runtime) {
    if (plan.source.kind === 'unavailable') {
      void showError(fallbackReasonMessage(plan.source.reason, run.runId));
    } else {
      void showError(`Unable to resolve a Claude runtime for run ${run.runId}.`);
    }
    return plan;
  }
  const runtime = plan.runtime;
  if (!runtime.launcher || runtime.launcher.length === 0) {
    void showError(`Claude runtime "${runtime.name}" does not define a launcher path.`);
    return plan;
  }
  if (!runtime.launcherExists) {
    void showError(`Claude runtime launcher is missing: ${runtime.launcher}`);
    return plan;
  }
  if (!runtime.launcherExecutable) {
    void showError(`Claude runtime launcher is not executable: ${runtime.launcher}`);
    return plan;
  }
  if (!plan.pluginDir) {
    void showError(
      'The configured controller path must point to the plugin scripts/controller.py so the autonomous-resume skill can be loaded.'
    );
    return plan;
  }

  deps.log.info(
    `resumeInClaude run=${run.runId} source=${plan.source.kind} runtime=${runtime.name} launcher=${runtime.launcher}`
  );

  const create =
    deps.createTerminal ??
    ((options: vscode.TerminalOptions) => vscode.window.createTerminal(options));
  // Launch the validated launcher as the terminal's OWN process. The creation
  // options also carry hideFromUser=true, which Python checks on terminal-open
  // before deciding whether to inject activation text. Calling show() here
  // reveals the terminal without changing that immutable creation option.
  const terminal = create(buildTerminalOptions(plan));
  terminal.show();
  registry?.register(identity, terminal);

  const fallbackNote =
    plan.source.kind === 'fallback'
      ? ` (${fallbackReasonMessage(plan.source.reason, run.runId).replace(/\.$/, '')})`
      : '';
  void showInfo(
    `Resuming run ${run.runId} with ${runtime.displayName ?? runtime.name}${fallbackNote}. The autonomous-resume workflow was submitted automatically.`
  );
  return plan;
}

/** Focus an existing extension-tracked Claude terminal for a run, if any. */
export function focusClaudeTerminal(
  run: DiscoveredRun,
  registry: ClaudeTerminalRegistry
): boolean {
  return registry.focus(terminalIdentityForRun(run));
}

function terminalStatus(status: string): boolean {
  return status === 'complete' || status === 'cancelled' || status === 'archived';
}
