import * as vscode from 'vscode';

/**
 * In-memory registry of Claude terminals created by this extension, keyed by
 * run id. Enforces the invariant that at most one extension-created Claude
 * terminal exists per run at a time.
 *
 * Ownership rules:
 *
 * - Register a terminal via {@link register} immediately after
 *   `vscode.window.createTerminal(...)`.
 * - Read the current terminal for a run via {@link get} to decide between
 *   "Resume in Claude" and "Focus Claude terminal" — repeated clicks on the
 *   action must reuse the existing terminal, never spawn a duplicate.
 * - Terminal-close cleanup is automatic: the registry subscribes to
 *   `vscode.window.onDidCloseTerminal` and drops the entry when the exact
 *   terminal it registered closes. This is what restores the "Resume in
 *   Claude" affordance in the UI.
 *
 * The registry never sends text into a Claude terminal, never spawns
 * subprocesses, and holds no secrets. It only tracks handles.
 */
export class ClaudeTerminalRegistry implements vscode.Disposable {
  private readonly byRunId = new Map<string, vscode.Terminal>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();
  /** Fires with the run id whose terminal set has changed (registered or closed). */
  readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => this.handleClose(closed))
    );
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
