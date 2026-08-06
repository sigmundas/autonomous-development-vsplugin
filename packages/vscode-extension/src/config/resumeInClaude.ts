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
import { buildLauncherArgs, formatLauncherCommand } from './claudeLauncher';
import type { ClaudeTerminalRegistry } from './claudeTerminalRegistry';

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
   * Clipboard writer. Extracted for the same reason.
   */
  readonly writeClipboard?: (text: string) => Promise<void>;
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
  /** POSIX/Windows-safely quoted single-line rendering of `launcherArgv`. */
  readonly commandLine: string;
  /** Deterministic instruction to hand to Claude (clipboard/terminal). */
  readonly instruction: string;
}

const RESUME_INSTRUCTION_TEMPLATE = (runId: string): string =>
  [
    `Resume autonomous-development run ${runId}. Do not initialize a new run.`,
    'Run controller status and next-action --json, then continue from the recorded phase.'
  ].join('\n');

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
  const launcherArgv: string[] = runtime ? [...buildLauncherArgs(runtime)] : [];
  if (pluginDir && runtime) {
    launcherArgv.push('--plugin-dir', pluginDir);
  }
  return {
    run,
    runtime,
    source,
    worktreePath,
    ...(pluginDir !== undefined ? { pluginDir } : {}),
    launcherArgv,
    commandLine: runtime ? formatLauncherCommand(launcherArgv) : '',
    instruction: RESUME_INSTRUCTION_TEMPLATE(run.runId)
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

/** Prefix all extension-managed Claude terminal names share. */
export const CLAUDE_TERMINAL_NAME_PREFIX = 'Autonomous Development · ';

/** Env vars stamped onto every extension-created Claude terminal. */
export const CLAUDE_TERMINAL_ENV_MARKER = 'AUTODEV_CLAUDE_TERMINAL';
export const CLAUDE_TERMINAL_RUN_ENV = 'AUTODEV_RUN_ID';

/**
 * Compose the terminal name for a run. This is deterministic — it appears
 * verbatim in {@link vscode.Terminal.name} and is what {@link parseRunIdFromTerminalName}
 * uses to recover the run id after an extension reload.
 */
export function claudeTerminalNameFor(runId: string): string {
  return `${CLAUDE_TERMINAL_NAME_PREFIX}${runId}`;
}

/**
 * Extract the run id from a terminal name previously produced by
 * {@link claudeTerminalNameFor}. Returns `undefined` when the name does not
 * match — never guesses.
 */
export function parseRunIdFromTerminalName(name: string): string | undefined {
  if (!name.startsWith(CLAUDE_TERMINAL_NAME_PREFIX)) return undefined;
  const tail = name.slice(CLAUDE_TERMINAL_NAME_PREFIX.length).trim();
  // The controller run id shape: <UTC-timestamp>-<hex>. Match liberally so a
  // future controller schema change with a slightly different suffix still
  // recovers the run.
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$/i.test(tail)) return undefined;
  return tail;
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
 * 1. `shellPath` is the launcher binary itself (not `/bin/bash` or another
 *    interactive shell). The Python extension only injects activation into
 *    terminals whose shell it recognizes; a launcher path fails that check.
 * 2. Deterministic env markers (`AUTODEV_RUN_ID`, `AUTODEV_CLAUDE_TERMINAL=1`)
 *    let observers — and this extension's own registry recovery — identify
 *    the terminal even without cooperating shells.
 * 3. The terminal name follows a stable pattern parsed by
 *    {@link parseRunIdFromTerminalName}, so post-reload recovery works even
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
    name: claudeTerminalNameFor(plan.run.runId),
    cwd: plan.worktreePath,
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
 * - Never sends text into an interactive shell after Claude has started —
 *   the terminal's process itself IS the Claude launcher (via
 *   `shellPath`/`shellArgs`), so the Python extension's `.venv/bin/activate`
 *   command can never race into Claude's input.
 * - Only one extension-tracked Claude terminal exists per run at a time.
 *   Calling this while a tracked terminal is alive focuses that terminal
 *   instead of spawning a new one.
 */
export async function resumeRunInClaude(
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
  if (registry) {
    registry.recoverExistingTerminals();
    if (registry.has(run.runId) && registry.focus(run.runId)) {
      deps.log.info(`resumeInClaude focus existing terminal for run=${run.runId}`);
      return undefined;
    }
  }

  await deps.store.refresh();
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

  deps.log.info(
    `resumeInClaude run=${run.runId} source=${plan.source.kind} runtime=${runtime.name} launcher=${runtime.launcher}`
  );

  // Deterministic instruction: written to the clipboard so no natural-language
  // Claude prompt is ever assembled from controller-provided strings, and no
  // sendText race with the terminal's own shell activation can occur.
  const writeClipboard = deps.writeClipboard ?? ((text) => vscode.env.clipboard.writeText(text));
  try {
    await writeClipboard(plan.instruction);
  } catch (err) {
    deps.log.warn(
      `resumeInClaude: clipboard write failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const create =
    deps.createTerminal ??
    ((options: vscode.TerminalOptions) => vscode.window.createTerminal(options));
  // Launch the validated launcher as the terminal's OWN process. VS Code will
  // spawn the launcher directly with our argv — no shell activation script can
  // interpose. This is what closes the Python-source-activate race window that
  // sendText into an interactive shell suffered from.
  const terminal = create(buildTerminalOptions(plan));
  terminal.show();
  registry?.register(run.runId, terminal);

  const fallbackNote =
    plan.source.kind === 'fallback'
      ? ` (${fallbackReasonMessage(plan.source.reason, run.runId).replace(/\.$/, '')})`
      : '';
  void showInfo(
    `Resuming run ${run.runId} with ${runtime.displayName ?? runtime.name}${fallbackNote}. The deterministic resume instruction is on your clipboard — paste it into Claude and press Enter.`
  );
  return plan;
}

/** Focus an existing extension-tracked Claude terminal for a run, if any. */
export function focusClaudeTerminal(
  run: DiscoveredRun,
  registry: ClaudeTerminalRegistry
): boolean {
  return registry.focus(run.runId);
}

function terminalStatus(status: string): boolean {
  return status === 'complete' || status === 'cancelled' || status === 'archived';
}
