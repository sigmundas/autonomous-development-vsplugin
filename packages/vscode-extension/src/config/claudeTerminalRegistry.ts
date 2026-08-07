import * as vscode from 'vscode';

import { parseClaudeTerminalIdentity } from './resumeInClaude';
import type { ClaudeTerminalIdentity } from './claudeTerminalIdentity';
export type { ClaudeTerminalIdentity } from './claudeTerminalIdentity';

function identityKey(identity: ClaudeTerminalIdentity): string {
  return JSON.stringify([identity.repositoryId, identity.runId]);
}

export interface UnboundClaudeTerminal {
  readonly repositoryId: string;
  readonly terminal: vscode.Terminal;
  /** Complete run-id baseline observed immediately before this terminal launched. */
  readonly knownRunIds: readonly string[];
}

export interface ClaudeTerminalRunCandidate {
  readonly repositoryId: string;
  readonly runId: string;
  readonly active: boolean;
}

interface UnboundCandidate {
  readonly repositoryId: string;
  readonly terminal: vscode.Terminal;
  readonly knownRunIds: Set<string>;
  /** Retained so an ambiguous observation cannot later collapse into a guess. */
  readonly observedNewRunIds: Set<string>;
  /** Set when a run first appears while multiple same-repository terminals exist. */
  terminalAmbiguous: boolean;
}

interface BoundTerminal {
  readonly identity: ClaudeTerminalIdentity;
  readonly terminal: vscode.Terminal;
}

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
 * canonical repository identity plus run id. Enforces at most one managed
 * Claude terminal per qualified run while allowing equal run ids in different
 * repositories.
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
  private readonly bound = new Map<string, BoundTerminal>();
  private readonly unbound = new Set<UnboundCandidate>();
  private readonly runLocks = new Map<string, Promise<unknown>>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<ClaudeTerminalIdentity>();
  /** Fires with the qualified identity whose terminal set changed. */
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
   * qualified identity. Idempotent: registering the same handle twice is a no-op.
   *
   * Must be called during extension activation. Also safe to call at any
   * later point (e.g. from a "recover terminals" command) — the registry
   * never over-writes a live registration with itself.
   */
  recoverExistingTerminals(): ClaudeTerminalIdentity[] {
    const recovered: ClaudeTerminalIdentity[] = [];
    const counts = new Map<string, number>();
    for (const terminal of this.window.terminals) {
      if (terminal.exitStatus !== undefined) continue;
      const identity = parseClaudeTerminalIdentity(terminal.name);
      if (identity) {
        const key = identityKey(identity);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    for (const terminal of this.window.terminals) {
      if (terminal.exitStatus !== undefined) continue;
      const identity = parseClaudeTerminalIdentity(terminal.name);
      if (!identity || counts.get(identityKey(identity)) !== 1) continue;
      const registered = this.tryRegisterByName(terminal);
      if (registered !== undefined) recovered.push(registered);
    }
    return recovered;
  }

  private tryRegisterByName(terminal: vscode.Terminal): ClaudeTerminalIdentity | undefined {
    const identity = parseClaudeTerminalIdentity(terminal.name);
    if (!identity || terminal.exitStatus !== undefined) return undefined;
    const key = identityKey(identity);
    const existing = this.bound.get(key);
    if (existing?.terminal === terminal) return identity; // idempotent recover
    // A different handle for the same run replaces the previous handle. This
    // is the same defensive replacement rule as {@link register}.
    if (existing) {
      try {
        existing.terminal.dispose();
      } catch {
        /* ignore */
      }
    }
    this.bound.set(key, { identity, terminal });
    this.onDidChangeEmitter.fire(identity);
    return identity;
  }

  /** Return the tracked terminal for a run, if any. */
  get(identity: ClaudeTerminalIdentity): vscode.Terminal | undefined {
    const binding = this.bound.get(identityKey(identity));
    if (!binding || this.pruneDeadBinding(binding)) return undefined;
    return binding.terminal;
  }

  /** True iff an extension-tracked Claude terminal is currently alive for the run. */
  has(identity: ClaudeTerminalIdentity): boolean {
    return this.get(identity) !== undefined;
  }

  /**
   * Track a Start-created terminal before its skill-owned controller run exists.
   * This metadata is intentionally memory-only: after reload the launch-time
   * baseline is unavailable, so generic terminal recovery would be guesswork.
   */
  registerUnbound(candidate: UnboundClaudeTerminal): void {
    this.removeUnboundTerminal(candidate.terminal);
    if (candidate.terminal.exitStatus !== undefined) return;
    const sameRepository = Array.from(this.unbound).filter(
      (existing) => existing.repositoryId === candidate.repositoryId
    );
    for (const existing of sameRepository) existing.terminalAmbiguous = true;
    this.unbound.add({
      repositoryId: candidate.repositoryId,
      terminal: candidate.terminal,
      knownRunIds: new Set(candidate.knownRunIds),
      observedNewRunIds: new Set<string>(),
      terminalAmbiguous: sameRepository.length > 0
    });
  }

  /** Test/diagnostic surface: true only while the live terminal awaits a run id. */
  isUnbound(terminal: vscode.Terminal): boolean {
    this.pruneDeadUnbound();
    for (const candidate of this.unbound) {
      if (candidate.terminal === terminal) return true;
    }
    return false;
  }

  /**
   * Late-bind Start terminals from run-discovery evidence. Binding is allowed
   * only for one live terminal and one newly observed active run in a repo.
   */
  reconcileRuns(runs: readonly ClaudeTerminalRunCandidate[]): void {
    this.pruneDeadUnbound();
    const activeByRepository = new Map<string, ClaudeTerminalRunCandidate[]>();
    for (const run of runs) {
      if (!run.active) continue;
      const current = activeByRepository.get(run.repositoryId) ?? [];
      current.push(run);
      activeByRepository.set(run.repositoryId, current);
    }

    for (const candidate of this.unbound) {
      for (const run of activeByRepository.get(candidate.repositoryId) ?? []) {
        if (!candidate.knownRunIds.has(run.runId)) {
          candidate.observedNewRunIds.add(run.runId);
        }
      }
    }

    const repositories = new Set(Array.from(this.unbound, (item) => item.repositoryId));
    for (const repositoryId of repositories) {
      const terminals = Array.from(this.unbound).filter(
        (candidate) => candidate.repositoryId === repositoryId
      );
      if (terminals.length > 1 && terminals.some((item) => item.observedNewRunIds.size > 0)) {
        for (const item of terminals) item.terminalAmbiguous = true;
      }
      if (terminals.length !== 1) continue;
      const [candidate] = terminals;
      if (!candidate || candidate.terminalAmbiguous || candidate.observedNewRunIds.size !== 1) {
        continue;
      }
      const [runId] = candidate.observedNewRunIds;
      const identity = runId ? { repositoryId, runId } : undefined;
      if (!identity || this.has(identity)) continue;
      this.unbound.delete(candidate);
      this.bound.set(identityKey(identity), { identity, terminal: candidate.terminal });
      this.onDidChangeEmitter.fire(identity);
    }
  }

  /**
   * Register a terminal for a qualified run. If a previous terminal was tracked
   * for this identity and is still open, it is disposed before replacement (defensive —
   * callers should have already noticed and reused it, but we never want two
   * live tracked terminals for the same run).
   */
  register(identity: ClaudeTerminalIdentity, terminal: vscode.Terminal): void {
    this.removeUnboundTerminal(terminal);
    const key = identityKey(identity);
    const existing = this.bound.get(key);
    if (existing && existing.terminal !== terminal) {
      try {
        existing.terminal.dispose();
      } catch {
        /* terminal already closed — ignore */
      }
    }
    this.bound.set(key, { identity, terminal });
    this.onDidChangeEmitter.fire(identity);
  }

  /**
   * Reveal an existing tracked terminal. Returns `true` when a tracked
   * terminal was focused; `false` when none was registered for the run.
   */
  focus(identity: ClaudeTerminalIdentity): boolean {
    const terminal = this.get(identity);
    if (!terminal) return false;
    terminal.show();
    return true;
  }

  /** Return qualified identities that currently have a tracked terminal. */
  activeIdentities(): readonly ClaudeTerminalIdentity[] {
    for (const binding of this.bound.values()) {
      this.pruneDeadBinding(binding);
    }
    return Array.from(this.bound.values(), (binding) => binding.identity);
  }

  /** Serialize Resume work so racing calls re-check the same run in order. */
  async withRunLock<T>(identity: ClaudeTerminalIdentity, task: () => Promise<T>): Promise<T> {
    const key = identityKey(identity);
    const previous = this.runLocks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runLocks.set(key, current);
    try {
      await previous.catch(() => undefined);
      return await task();
    } finally {
      release();
      if (this.runLocks.get(key) === current) this.runLocks.delete(key);
    }
  }

  private handleClose(closed: vscode.Terminal): void {
    this.removeUnboundTerminal(closed);
    for (const [key, binding] of this.bound.entries()) {
      if (binding.terminal === closed) {
        this.bound.delete(key);
        this.onDidChangeEmitter.fire(binding.identity);
        return;
      }
    }
  }

  private pruneDeadBinding(binding: BoundTerminal): boolean {
    if (binding.terminal.exitStatus === undefined) return false;
    const key = identityKey(binding.identity);
    if (this.bound.get(key)?.terminal === binding.terminal) {
      this.bound.delete(key);
      this.onDidChangeEmitter.fire(binding.identity);
    }
    return true;
  }

  private pruneDeadUnbound(): void {
    for (const candidate of this.unbound) {
      if (candidate.terminal.exitStatus !== undefined) this.unbound.delete(candidate);
    }
  }

  private removeUnboundTerminal(terminal: vscode.Terminal): void {
    for (const candidate of this.unbound) {
      if (candidate.terminal === terminal) this.unbound.delete(candidate);
    }
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    for (const d of this.disposables) d.dispose();
    this.bound.clear();
    this.unbound.clear();
    this.runLocks.clear();
  }
}
