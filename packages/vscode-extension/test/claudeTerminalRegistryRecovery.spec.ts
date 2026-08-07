import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import {
  ClaudeTerminalRegistry,
  type ClaudeTerminalIdentity,
  type ClaudeTerminalRegistryWindow
} from '../src/config/claudeTerminalRegistry';
import { claudeTerminalNameFor } from '../src/config/resumeInClaude';

/**
 * A test double for the vscode.window terminal APIs. Backs
 * {@link vscode.window.terminals} with a live array, and exposes emitters that
 * tests can fire to simulate open/close events.
 */
class FakeWindow implements ClaudeTerminalRegistryWindow {
  readonly terminalList: vscode.Terminal[] = [];
  readonly openEmitter = new vscode.EventEmitter<vscode.Terminal>();
  readonly closeEmitter = new vscode.EventEmitter<vscode.Terminal>();
  get terminals(): readonly vscode.Terminal[] {
    return this.terminalList;
  }
  get onDidOpenTerminal(): vscode.Event<vscode.Terminal> {
    return this.openEmitter.event;
  }
  get onDidCloseTerminal(): vscode.Event<vscode.Terminal> {
    return this.closeEmitter.event;
  }
  spawn(name: string): vscode.Terminal {
    const state = { shownCount: 0, disposed: false };
    const terminal = {
      name,
      processId: Promise.resolve(undefined),
      creationOptions: {} as vscode.TerminalOptions,
      exitStatus: undefined,
      state: { isInteractedWith: false, shell: undefined },
      shellIntegration: undefined,
      sendText: () => {
        /* forbidden in these tests */
      },
      show: () => {
        state.shownCount += 1;
      },
      hide: () => {
        /* no-op */
      },
      dispose: () => {
        state.disposed = true;
        // The registry listens for close; simulate that ordering.
        this.closeEmitter.fire(terminal as unknown as vscode.Terminal);
        const idx = this.terminalList.indexOf(terminal as unknown as vscode.Terminal);
        if (idx >= 0) this.terminalList.splice(idx, 1);
      }
    };
    const t = Object.assign(terminal, state) as unknown as vscode.Terminal;
    this.terminalList.push(t);
    this.openEmitter.fire(t);
    return t;
  }
}

const RUN_A = '20260806T091439Z-aaaaaaaaaaaa';
const RUN_B = '20260806T091439Z-bbbbbbbbbbbb';
const ID_A: ClaudeTerminalIdentity = { repositoryId: 'repo-a', runId: RUN_A };
const ID_B: ClaudeTerminalIdentity = { repositoryId: 'repo-a', runId: RUN_B };

describe('ClaudeTerminalRegistry — recovery after extension reload', () => {
  it('reconstructs registry from vscode.window.terminals on recoverExistingTerminals', () => {
    const win = new FakeWindow();
    // Simulate: terminals already exist BEFORE the registry (extension) was
    // constructed. This is the post-reload state.
    win.terminalList.push({
      name: claudeTerminalNameFor(ID_A),
      sendText: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined
    } as unknown as vscode.Terminal);
    win.terminalList.push({
      name: 'bash', // unrelated terminal — must NOT be tracked
      sendText: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined
    } as unknown as vscode.Terminal);

    const reg = new ClaudeTerminalRegistry(win);
    const recovered = reg.recoverExistingTerminals();
    assert.deepEqual(recovered, [ID_A]);
    assert.equal(reg.has(ID_A), true);
    assert.equal(reg.has({ repositoryId: 'repo-a', runId: 'other-run' }), false);
    reg.dispose();
  });

  it('re-registration is idempotent — recovering twice does not fire duplicate change events', () => {
    const win = new FakeWindow();
    win.terminalList.push({
      name: claudeTerminalNameFor(ID_A),
      sendText: () => undefined,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined
    } as unknown as vscode.Terminal);
    const reg = new ClaudeTerminalRegistry(win);
    const events: ClaudeTerminalIdentity[] = [];
    reg.onDidChange((r) => events.push(r));
    reg.recoverExistingTerminals();
    reg.recoverExistingTerminals();
    reg.recoverExistingTerminals();
    assert.equal(events.length, 1);
    reg.dispose();
  });

  it('onDidOpenTerminal auto-registers a terminal opened elsewhere with the right name', () => {
    const win = new FakeWindow();
    const reg = new ClaudeTerminalRegistry(win);
    assert.equal(reg.has(ID_B), false);
    // Simulate the terminal API firing an open event for a matching name.
    win.spawn(claudeTerminalNameFor(ID_B));
    assert.equal(reg.has(ID_B), true);
    reg.dispose();
  });

  it('recovers equal run ids into separate repository-qualified bindings', () => {
    const win = new FakeWindow();
    const repoA = { repositoryId: 'repo-a', runId: RUN_A };
    const repoB = { repositoryId: 'repo-b', runId: RUN_A };
    const terminalA = win.spawn(claudeTerminalNameFor(repoA));
    const terminalB = win.spawn(claudeTerminalNameFor(repoB));
    const reg = new ClaudeTerminalRegistry(win);

    assert.deepEqual(reg.recoverExistingTerminals(), [repoA, repoB]);
    assert.strictEqual(reg.get(repoA), terminalA);
    assert.strictEqual(reg.get(repoB), terminalB);
    reg.dispose();
  });

  it('does not recover the legacy run-id-only terminal name', () => {
    const win = new FakeWindow();
    win.spawn(`Autonomous Development · ${RUN_A}`);
    const reg = new ClaudeTerminalRegistry(win);
    assert.deepEqual(reg.recoverExistingTerminals(), []);
    assert.equal(reg.has(ID_A), false);
    reg.dispose();
  });
});

describe('ClaudeTerminalRegistry — duplicate spawn prevention', () => {
  it('two consecutive resume clicks focus the same terminal — the second must not spawn a duplicate', () => {
    const win = new FakeWindow();
    const reg = new ClaudeTerminalRegistry(win);
    let spawnCount = 0;
    const spawnOnce = (): vscode.Terminal => {
      // Look for existing registered terminal first — mirrors resumeRunInClaude.
      reg.recoverExistingTerminals();
      if (reg.has(ID_A)) {
        reg.focus(ID_A);
        return reg.get(ID_A) as vscode.Terminal;
      }
      spawnCount += 1;
      const t = win.spawn(claudeTerminalNameFor(ID_A));
      reg.register(ID_A, t);
      return t;
    };
    const first = spawnOnce();
    const second = spawnOnce();
    assert.equal(spawnCount, 1, 'second click must NOT spawn a new terminal');
    assert.strictEqual(first, second);
    reg.dispose();
  });
});

describe('ClaudeTerminalRegistry — terminal close then legitimate re-resume', () => {
  it('after the terminal closes, a fresh resume spawns a new terminal and re-tracks it', () => {
    const win = new FakeWindow();
    const reg = new ClaudeTerminalRegistry(win);
    let spawnCount = 0;
    const spawnOnce = (): vscode.Terminal => {
      reg.recoverExistingTerminals();
      if (reg.has(ID_A)) {
        reg.focus(ID_A);
        return reg.get(ID_A) as vscode.Terminal;
      }
      spawnCount += 1;
      const t = win.spawn(claudeTerminalNameFor(ID_A));
      reg.register(ID_A, t);
      return t;
    };

    const first = spawnOnce();
    assert.equal(reg.has(ID_A), true);

    // User closes the terminal — the FakeWindow.dispose fires closeEmitter,
    // and the registry drops the entry.
    first.dispose();
    assert.equal(reg.has(ID_A), false);

    // A legitimate new Resume click now spawns a fresh terminal.
    const second = spawnOnce();
    assert.equal(spawnCount, 2);
    assert.notStrictEqual(first, second);
    assert.equal(reg.has(ID_A), true);
    reg.dispose();
  });
});
