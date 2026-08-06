import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { ClaudeTerminalRegistry } from '../src/config/claudeTerminalRegistry';

/** Minimal fake terminal for registry unit tests (no real shell spawned). */
function fakeTerminal(name: string): vscode.Terminal & { shownCount: number; disposed: boolean } {
  const state: { shownCount: number; disposed: boolean } = { shownCount: 0, disposed: false };
  const terminal = {
    name,
    processId: Promise.resolve(undefined),
    creationOptions: {} as vscode.TerminalOptions,
    exitStatus: undefined,
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
    }
  };
  return Object.assign(terminal, state) as unknown as vscode.Terminal & {
    shownCount: number;
    disposed: boolean;
  };
}

describe('ClaudeTerminalRegistry', () => {
  it('registering a terminal makes has() true and focus() reveal it', () => {
    const reg = new ClaudeTerminalRegistry();
    const t = fakeTerminal('r1');
    reg.register('run-1', t);
    assert.equal(reg.has('run-1'), true);
    assert.equal(reg.focus('run-1'), true);
    assert.equal(t.shownCount, 1);
    reg.dispose();
  });

  it('registering a second terminal for the same run disposes the previous', () => {
    const reg = new ClaudeTerminalRegistry();
    const t1 = fakeTerminal('r1');
    const t2 = fakeTerminal('r1-second');
    reg.register('run-1', t1);
    reg.register('run-1', t2);
    assert.equal(t1.disposed, true, 'the first terminal must be disposed on replacement');
    assert.equal(reg.get('run-1'), t2 as unknown as vscode.Terminal);
    reg.dispose();
  });

  it('focus() returns false and reveals nothing when no terminal is tracked', () => {
    const reg = new ClaudeTerminalRegistry();
    const t = fakeTerminal('r1');
    assert.equal(reg.focus('missing-run'), false);
    // Registering under a different id does not satisfy focus for our target.
    reg.register('other-run', t);
    assert.equal(reg.focus('missing-run'), false);
    reg.dispose();
  });

  it('activeRunIds returns every currently tracked run id', () => {
    const reg = new ClaudeTerminalRegistry();
    reg.register('a', fakeTerminal('ta'));
    reg.register('b', fakeTerminal('tb'));
    const ids = new Set(reg.activeRunIds());
    assert.equal(ids.has('a'), true);
    assert.equal(ids.has('b'), true);
    reg.dispose();
  });

  it('onDidChange fires for the run id on register', async () => {
    const reg = new ClaudeTerminalRegistry();
    const events: string[] = [];
    reg.onDidChange((runId) => events.push(runId));
    reg.register('run-1', fakeTerminal('t'));
    assert.deepEqual(events, ['run-1']);
    reg.dispose();
  });
});
