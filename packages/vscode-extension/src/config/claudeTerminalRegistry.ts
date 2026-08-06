import * as vscode from 'vscode';

import { parseRunIdFromTerminalName } from './resumeInClaude';

/**
 * Subset of the vscode window API the registry needs. Injecting an interface
 * (rather than closing over the vscode namespace directly) means unit tests
 * can drive close/open events with fake emitters instead of a real VS Code
 * test host — a real host is unavailable in some CI environments.
 */
export interface ClaudeTerminalRegistryWindow {
  readonly terminals: readonly vscode.Terminal[];
  readonly onDidCloseTerminal: vscode.Event<vscode.Terminal>;
  readonly onDidOpenTerminal: vscode.Event<vscode.Terminal>;
}

function defaultWindow(): ClaudeTerminalRegistryWindow {
  return {
    get terminals() {
      return vscode.window.terminals;
    },
    onDidCloseTerminal: vscode.window.onDidCloseTerminal,
    onDidOpenTerminal: vscode.window.onDidOpenTerminal
  };
}

/**
 * In-memory registry of Claude terminals created by this extension, keyed by
 * run id. Enforces the invariant that at most one extension-managed Claude
 * terminal exists per run at any time.
 *
 * Ownership rules:
 *
 * - Register a terminal via {@link register} immediately after
 *   `vscode.window.createTerminal(...)`.
 * - Read the current terminal for a run via {@link get} to decide between
 *   "Resume in Claude" and "Focus Claude terminal" — repeated clicks on the
 *   action must reuse the existing terminal, never spawn a duplicate.
 * - Terminal-close cleanup is automatic via `vscode.window.onDidCloseTerminal`.
 * - Terminals that existed BEFORE the extension activated (e.g. surviving a
 *   window reload) are re-discovered via {@link recoverExistingTerminals} —
 *   the registry parses the extension-owned terminal name pattern and
 *   re-registers matching terminals. This is what keeps "Focus Claude
 *   terminal" available after a reload.
 * - Newly opened terminals we recognize (name pattern match) are auto-tracked
 *   via `vscode.window.onDidOpenTerminal`, so any spawn path that goes through
 *   the standard terminal API stays consistent.
 *
 * The registry never sends text into a Claude terminal, never spawns
 * subprocesses, and holds no secrets. It only tracks handles and cleans up.
 */
export class ClaudeTerminalRegistry implements vscode.Disposable {
  private readonly byRunId = new Map<string, vscode.Terminal>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();
  /** Fires with the run id whose terminal set has changed (registered or closed). */
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly window: ClaudeTerminalRegistryWindow = defaultWindow()) {
    this.disposables.push(
      this.window.onDidCloseTerminal((closed) => this.handleClose(closed)),
      this.window.onDidOpenTerminal((opened) => this.tryRegisterByName(opened))
    );
  }

  /**
   * Scan the current `vscode.window.terminals` list, identify every terminal
   * whose name matches the extension-owned pattern, and register it under its
   * run id. Idempotent: registering the same handle twice is a no-op.
   *
   * Must be called during extension activation. Also safe to call at any
   * later point (e.g. from a "recover terminals" command) — the registry
   * never over-writes a live registration with itself.
   */
  recoverExistingTerminals(): string[] {
    const recovered: string[] = [];
    for (const terminal of this.window.terminals) {
      const runId = this.tryRegisterByName(terminal);
      if (runId !== undefined) recovered.push(runId);
    }
    return recovered;
  }

  private tryRegisterByName(terminal: vscode.Terminal): string | undefined {
    const runId = parseRunIdFromTerminalName(terminal.name);
    if (!runId) return undefined;
    const existing = this.byRunId.get(runId);
    if (existing === terminal) return runId; // idempotent recover
    // A different handle for the same run replaces the previous handle. This
    // is the same defensive replacement rule as {@link register}.
    if (existing) {
      try {
        existing.dispose();
      } catch {
        /* ignore */
      }
    }
    this.byRunId.set(runId, terminal);
    this.onDidChangeEmitter.fire(runId);
    return runId;
  }

  /** Return the tracked terminal for a run, if any. */
  get(runId: string): vscode.Terminal | undefined {
    return this.byRunId.get(runId);
  }

  /** True iff an extension-tracked Claude terminal is currently alive for the run. */
  has(runId: string): boolean {
    return this.byRunId.has(runId);
  }

  /**
   * Register a terminal for a run id. If a previous terminal was tracked for
   * this run and is still open, it is disposed before replacement (defensive —
   * callers should have already noticed and reused it, but we never want two
   * live tracked terminals for the same run).
   */
  register(runId: string, terminal: vscode.Terminal): void {
    const existing = this.byRunId.get(runId);
    if (existing && existing !== terminal) {
      try {
        existing.dispose();
      } catch {
        /* terminal already closed — ignore */
      }
    }
    this.byRunId.set(runId, terminal);
    this.onDidChangeEmitter.fire(runId);
  }

  /**
   * Reveal an existing tracked terminal. Returns `true` when a tracked
   * terminal was focused; `false` when none was registered for the run.
   */
  focus(runId: string): boolean {
    const terminal = this.byRunId.get(runId);
    if (!terminal) return false;
    terminal.show();
    return true;
  }

  /** Return the set of run ids that currently have a tracked terminal. */
  activeRunIds(): readonly string[] {
    return Array.from(this.byRunId.keys());
  }

  private handleClose(closed: vscode.Terminal): void {
    for (const [runId, tracked] of this.byRunId.entries()) {
      if (tracked === closed) {
        this.byRunId.delete(runId);
        this.onDidChangeEmitter.fire(runId);
        return;
      }
    }
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
    this.byRunId.clear();
  }
}
