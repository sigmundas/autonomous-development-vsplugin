import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import {
  ClaudeTerminalRegistry,
  type ClaudeTerminalIdentity,
  type ClaudeTerminalRegistryWindow
} from '../src/config/claudeTerminalRegistry';

const identity = (runId: string, repositoryId = 'repo-a'): ClaudeTerminalIdentity => ({
  repositoryId,
  runId
});

/** Minimal fake terminal for registry unit tests (no real shell spawned). */
type FakeTerminal = vscode.Terminal & {
  readonly shownCount: number;
  readonly disposed: boolean;
  markExited(): void;
};

function fakeTerminal(name: string): FakeTerminal {
  const state: {
    shownCount: number;
    disposed: boolean;
    exitStatus: vscode.TerminalExitStatus | undefined;
  } = { shownCount: 0, disposed: false, exitStatus: undefined };
  const terminal: Record<string, unknown> = {
    name,
    processId: Promise.resolve(undefined),
    creationOptions: {} as vscode.TerminalOptions,
    state: { isInteractedWith: false, shell: undefined },
    shellIntegration: undefined,
    sendText: () => {
      /* no-op */
    },
    show: () => {
      state.shownCount += 1;
    },
    hide: () => {
      /* no-op */
    },
    dispose: () => {
      state.disposed = true;
      state.exitStatus = { code: 0, reason: 1 } as vscode.TerminalExitStatus;
    }
  };
  // Live getters ensure assertions observe mutations made by the closures above.
  Object.defineProperties(terminal, {
    shownCount: { get: () => state.shownCount, enumerable: true },
    disposed: { get: () => state.disposed, enumerable: true },
    exitStatus: { get: () => state.exitStatus, enumerable: true },
    markExited: {
      value: () => {
        state.exitStatus = { code: 0, reason: 1 } as vscode.TerminalExitStatus;
      }
    }
  });
  return terminal as unknown as FakeTerminal;
}

class FakeWindow implements ClaudeTerminalRegistryWindow {
  readonly terminalList: vscode.Terminal[] = [];
  private readonly opened = new vscode.EventEmitter<vscode.Terminal>();
  private readonly closed = new vscode.EventEmitter<vscode.Terminal>();
  readonly onDidOpenTerminal = this.opened.event;
  readonly onDidCloseTerminal = this.closed.event;
  get terminals(): readonly vscode.Terminal[] {
    return this.terminalList;
  }
  close(terminal: vscode.Terminal): void {
    this.closed.fire(terminal);
  }
}

describe('ClaudeTerminalRegistry', () => {
  it('registering a terminal makes has() true and focus() reveal it', () => {
    const reg = new ClaudeTerminalRegistry();
    const t = fakeTerminal('r1');
    reg.register(identity('run-1'), t);
    assert.equal(reg.has(identity('run-1')), true);
    assert.equal(reg.focus(identity('run-1')), true);
    assert.equal(t.shownCount, 1);
    reg.dispose();
  });

  it('registering a second terminal for the same run disposes the previous', () => {
    const reg = new ClaudeTerminalRegistry();
    const t1 = fakeTerminal('r1');
    const t2 = fakeTerminal('r1-second');
    reg.register(identity('run-1'), t1);
    reg.register(identity('run-1'), t2);
    assert.equal(t1.disposed, true, 'the first terminal must be disposed on replacement');
    assert.equal(reg.get(identity('run-1')), t2 as unknown as vscode.Terminal);
    reg.dispose();
  });

  it('focus() returns false and reveals nothing when no terminal is tracked', () => {
    const reg = new ClaudeTerminalRegistry();
    const t = fakeTerminal('r1');
    assert.equal(reg.focus(identity('missing-run')), false);
    // Registering under a different id does not satisfy focus for our target.
    reg.register(identity('other-run'), t);
    assert.equal(reg.focus(identity('missing-run')), false);
    reg.dispose();
  });

  it('activeIdentities returns every currently tracked qualified identity', () => {
    const reg = new ClaudeTerminalRegistry();
    reg.register(identity('a'), fakeTerminal('ta'));
    reg.register(identity('b', 'repo-b'), fakeTerminal('tb'));
    assert.deepEqual(reg.activeIdentities(), [identity('a'), identity('b', 'repo-b')]);
    reg.dispose();
  });

  it('onDidChange fires for the qualified identity on register', async () => {
    const reg = new ClaudeTerminalRegistry();
    const events: ClaudeTerminalIdentity[] = [];
    reg.onDidChange((changed) => events.push(changed));
    reg.register(identity('run-1'), fakeTerminal('t'));
    assert.deepEqual(events, [identity('run-1')]);
    reg.dispose();
  });

  it('treats exitStatus as dead before the close event arrives', () => {
    const reg = new ClaudeTerminalRegistry();
    const terminal = fakeTerminal('terminal');
    reg.register(identity('run-1'), terminal);
    terminal.markExited();
    assert.equal(reg.has(identity('run-1')), false);
    assert.equal(reg.focus(identity('run-1')), false);
    reg.dispose();
  });

  it('keeps the same run id independent across repositories', () => {
    const window = new FakeWindow();
    const reg = new ClaudeTerminalRegistry(window);
    const repoA = identity('shared-run', 'repo-a');
    const repoB = identity('shared-run', 'repo-b');
    const terminalA = fakeTerminal('A');
    const terminalB = fakeTerminal('B');
    reg.register(repoA, terminalA);
    reg.register(repoB, terminalB);

    assert.strictEqual(reg.get(repoA), terminalA);
    assert.strictEqual(reg.get(repoB), terminalB);
    reg.focus(repoA);
    assert.equal(terminalA.shownCount, 1);
    assert.equal(terminalB.shownCount, 0);

    window.close(terminalA);
    assert.equal(reg.has(repoA), false);
    assert.equal(reg.has(repoB), true);
    reg.dispose();
  });
});

describe('ClaudeTerminalRegistry — Start late binding', () => {
  it('registers Start unbound, then binds one newly observed run in the same repository', () => {
    const reg = new ClaudeTerminalRegistry(new FakeWindow());
    const terminal = fakeTerminal('Autonomous Claude — repo-a');
    reg.registerUnbound({ repositoryId: 'repo-a', terminal, knownRunIds: ['older'] });
    assert.equal(reg.isUnbound(terminal), true);
    assert.equal(reg.activeIdentities().length, 0);

    reg.reconcileRuns([
      { repositoryId: 'repo-a', runId: 'older', active: true },
      { repositoryId: 'repo-a', runId: 'new-run', active: true }
    ]);
    assert.equal(reg.isUnbound(terminal), false);
    assert.strictEqual(reg.get(identity('new-run')), terminal);
    reg.dispose();
  });

  it('does not guess between two unbound terminals in one repository', () => {
    const reg = new ClaudeTerminalRegistry(new FakeWindow());
    const first = fakeTerminal('first');
    const second = fakeTerminal('second');
    reg.registerUnbound({ repositoryId: 'repo-a', terminal: first, knownRunIds: [] });
    reg.registerUnbound({ repositoryId: 'repo-a', terminal: second, knownRunIds: [] });
    reg.reconcileRuns([{ repositoryId: 'repo-a', runId: 'new-run', active: true }]);
    assert.equal(reg.has(identity('new-run')), false);
    assert.equal(reg.isUnbound(first), true);
    assert.equal(reg.isUnbound(second), true);
    first.markExited();
    reg.reconcileRuns([{ repositoryId: 'repo-a', runId: 'new-run', active: true }]);
    assert.equal(reg.has(identity('new-run')), false, 'the earlier ambiguity must not collapse into a guess');
    reg.dispose();
  });

  it('does not guess between two newly observed runs, even if one later disappears', () => {
    const reg = new ClaudeTerminalRegistry(new FakeWindow());
    const terminal = fakeTerminal('candidate');
    reg.registerUnbound({ repositoryId: 'repo-a', terminal, knownRunIds: [] });
    reg.reconcileRuns([
      { repositoryId: 'repo-a', runId: 'new-1', active: true },
      { repositoryId: 'repo-a', runId: 'new-2', active: true }
    ]);
    reg.reconcileRuns([{ repositoryId: 'repo-a', runId: 'new-1', active: true }]);
    assert.equal(reg.has(identity('new-1')), false);
    assert.equal(reg.has(identity('new-2')), false);
    assert.equal(reg.isUnbound(terminal), true);
    reg.dispose();
  });

  it('never cross-binds a run from another repository', () => {
    const reg = new ClaudeTerminalRegistry(new FakeWindow());
    const terminal = fakeTerminal('candidate');
    reg.registerUnbound({ repositoryId: 'repo-a', terminal, knownRunIds: [] });
    reg.reconcileRuns([{ repositoryId: 'repo-b', runId: 'new-run', active: true }]);
    assert.equal(reg.has(identity('new-run', 'repo-b')), false);
    assert.equal(reg.isUnbound(terminal), true);
    reg.dispose();
  });

  it('late-binds equal run ids independently in two repositories', () => {
    const reg = new ClaudeTerminalRegistry(new FakeWindow());
    const terminalA = fakeTerminal('repo-a');
    const terminalB = fakeTerminal('repo-b');
    reg.registerUnbound({ repositoryId: 'repo-a', terminal: terminalA, knownRunIds: [] });
    reg.registerUnbound({ repositoryId: 'repo-b', terminal: terminalB, knownRunIds: [] });
    reg.reconcileRuns([
      { repositoryId: 'repo-a', runId: 'shared-run', active: true },
      { repositoryId: 'repo-b', runId: 'shared-run', active: true }
    ]);

    assert.strictEqual(reg.get(identity('shared-run', 'repo-a')), terminalA);
    assert.strictEqual(reg.get(identity('shared-run', 'repo-b')), terminalB);
    reg.dispose();
  });

  it('drops a candidate that exits before its run appears', () => {
    const reg = new ClaudeTerminalRegistry(new FakeWindow());
    const terminal = fakeTerminal('candidate');
    reg.registerUnbound({ repositoryId: 'repo-a', terminal, knownRunIds: [] });
    terminal.markExited();
    reg.reconcileRuns([{ repositoryId: 'repo-a', runId: 'new-run', active: true }]);
    assert.equal(reg.isUnbound(terminal), false);
    assert.equal(reg.has(identity('new-run')), false);
    reg.dispose();
  });

  it('fails safe on reload: generic terminals are not reconstructed without a baseline', () => {
    const window = new FakeWindow();
    window.terminalList.push(fakeTerminal('Autonomous Claude — repo-a'));
    const reg = new ClaudeTerminalRegistry(window);
    assert.deepEqual(reg.recoverExistingTerminals(), []);
    reg.reconcileRuns([{ repositoryId: 'repo-a', runId: 'new-run', active: true }]);
    assert.equal(reg.has(identity('new-run')), false);
    reg.dispose();
  });

  it('serializes concurrent work for the same run', async () => {
    const reg = new ClaudeTerminalRegistry(new FakeWindow());
    let active = 0;
    let peak = 0;
    const task = () =>
      reg.withRunLock(identity('run-1'), async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });
    await Promise.all([task(), task(), task()]);
    assert.equal(peak, 1);
    reg.dispose();
  });

  it('does not serialize equal run ids from different repositories', async () => {
    const reg = new ClaudeTerminalRegistry(new FakeWindow());
    let active = 0;
    let peak = 0;
    const task = (repositoryId: string) =>
      reg.withRunLock(identity('shared-run', repositoryId), async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });
    await Promise.all([task('repo-a'), task('repo-b')]);
    assert.equal(peak, 2);
    reg.dispose();
  });
});
