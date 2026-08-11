import assert from 'node:assert/strict';

import * as vscode from 'vscode';
import type { ClaudeRuntime } from '@semanticmatter/core';

import { ClaudeTerminalRegistry } from '../src/config/claudeTerminalRegistry';
import { autonomousClaudePermissionArgs } from '../src/config/claudeLauncher';
import {
  autonomousClaudeTerminalName,
  AUTONOMOUS_CLAUDE_TERMINAL_ENV_MARKER,
  AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX,
  buildOpenAutonomousClaudeTerminalOptions,
  newRunBootstrapPrompt,
  openAutonomousClaudeInWorkspace,
  planOpenAutonomousClaude
} from '../src/config/openAutonomousClaude';
import { parseClaudeTerminalIdentity } from '../src/config/resumeInClaude';

/**
 * The "Open Autonomous Claude" affordance replaces the previous "Start New
 * Run" button. It launches the configured Claude runtime in the selected
 * repository so the plugin loads via the launcher itself — but MUST NOT
 * create a controller run, MUST NOT send text into Claude, and MUST NOT
 * initially be attributed to any run. It is registered as an unbound
 * repository candidate and acquires a run id only from later discovery.
 *
 * These tests exercise those invariants at unit level so future edits can't
 * silently re-introduce run creation, sendText, or run-scoped terminal
 * identity for this action.
 */

const RUNTIME_ARGS = [
  '--profile',
  'anthropic',
  '--model',
  'claude-sonnet-4-5',
  '--effort',
  'high'
] as const;

const RUNTIME: ClaudeRuntime = {
  name: 'anthropic-claude',
  displayName: 'Anthropic · Claude',
  launcher: '/usr/local/bin/claude-anthropic',
  args: RUNTIME_ARGS,
  launcherExists: true,
  launcherExecutable: true
};

describe('openAutonomousClaude — terminal name identity', () => {
  it('uses a name prefix that does not collide with the run-scoped prefix', () => {
    // The Resume parser requires an encoded repository + run identity.
    // Our prefix is intentionally different so the run-indexed registry can
    // never mistake this terminal for a run's terminal.
    assert.notEqual(AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX, 'Autonomous Development · ');
    assert.equal(AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX.startsWith('Autonomous Claude'), true);
  });

  it('name without cwd is the bare prefix', () => {
    assert.equal(autonomousClaudeTerminalName(undefined), AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX);
    assert.equal(autonomousClaudeTerminalName(''), AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX);
  });

  it('name with a cwd appends the repo basename', () => {
    assert.equal(
      autonomousClaudeTerminalName('/Users/x/dev/sample-repo'),
      `${AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX} — sample-repo`
    );
    assert.equal(
      autonomousClaudeTerminalName('/Users/x/dev/my project'),
      `${AUTONOMOUS_CLAUDE_TERMINAL_NAME_PREFIX} — my project`
    );
  });

  it('the produced name is NEVER parseable as a run-scoped terminal', () => {
    // Feed a suite of realistic names into the run-id parser; every result
    // must be undefined, i.e. the run registry cannot claim any of them.
    const candidates = [
      autonomousClaudeTerminalName(undefined),
      autonomousClaudeTerminalName('/x/repo'),
      autonomousClaudeTerminalName('/x/20260806T091439Z-cafefacefade'), // adversarial basename
      autonomousClaudeTerminalName('/x/Autonomous Development · abc'),
      autonomousClaudeTerminalName('/x/my-repo')
    ];
    for (const name of candidates) {
      assert.equal(
        parseClaudeTerminalIdentity(name),
        undefined,
        `run-scoped parser must not accept: ${name}`
      );
    }
  });
});

describe('openAutonomousClaude — plan construction', () => {
  it('launches Default without --model and selected models with the exact value', () => {
    const runtimeWithoutModel = { ...RUNTIME, args: [] };
    const defaultPlan = planOpenAutonomousClaude(
      runtimeWithoutModel,
      '/work/repo',
      '/opt/controller.py'
    );
    assert.equal(defaultPlan.launcherArgv.includes('--model'), false);
    const selected = planOpenAutonomousClaude(
      runtimeWithoutModel,
      '/work/repo',
      '/opt/controller.py',
      undefined,
      { id: 'custom', displayName: 'Custom', model: 'custom/value with spaces' }
    );
    const index = selected.launcherArgv.indexOf('--model');
    assert.equal(selected.launcherArgv[index + 1], 'custom/value with spaces');
  });

  it('maps each selected run mode to the existing autonomous skill', () => {
    assert.equal(
      newRunBootstrapPrompt({ mode: 'feature', feature: 'Build a dashboard' }),
      '/autonomous-development:autonomous-feature Build a dashboard'
    );
    assert.equal(
      newRunBootstrapPrompt({ mode: 'current', feature: 'Fix timeline state' }),
      '/autonomous-development:autonomous-current Fix timeline state'
    );
    assert.equal(
      newRunBootstrapPrompt({ mode: 'main', feature: 'Update docs' }),
      '/autonomous-development:autonomous-main Update docs'
    );
  });

  it('appends the selected skill prompt without duplicating initialization logic', () => {
    const plan = planOpenAutonomousClaude(
      RUNTIME,
      '/work/repo',
      '/opt/autodev/scripts/controller.py',
      { mode: 'current', feature: 'Clarify run state' }
    );
    assert.equal(
      plan.launcherArgv.at(-1),
      '/autonomous-development:autonomous-current Clarify run state'
    );
  });

  it('cwd is threaded through as the terminal cwd', () => {
    const plan = planOpenAutonomousClaude(
      RUNTIME,
      '/work/repo',
      '/opt/autodev/scripts/controller.py'
    );
    assert.equal(plan.cwd, '/work/repo');
  });

  it('appends --plugin-dir when controller path shape allows it', () => {
    const plan = planOpenAutonomousClaude(
      RUNTIME,
      '/work/repo',
      '/opt/autodev/scripts/controller.py'
    );
    assert.equal(plan.pluginDir, '/opt/autodev');
    const idx = plan.launcherArgv.indexOf('--plugin-dir');
    assert.ok(idx >= 0, `expected --plugin-dir in argv, got: ${plan.launcherArgv.join(' ')}`);
    assert.equal(plan.launcherArgv[idx + 1], '/opt/autodev');
  });

  it('omits --plugin-dir when controller path is not scripts/controller.py', () => {
    const plan = planOpenAutonomousClaude(RUNTIME, '/work/repo', '/opt/controller.py');
    assert.equal(plan.pluginDir, undefined);
    assert.ok(!plan.launcherArgv.includes('--plugin-dir'));
  });

  it('launcher is the first argv element, followed by its own args', () => {
    const plan = planOpenAutonomousClaude(
      RUNTIME,
      '/work/repo',
      '/opt/autodev/scripts/controller.py'
    );
    // buildLauncherArgs prepends the launcher then extras; then we append plugin-dir.
    assert.deepEqual(plan.launcherArgv, [
      '/usr/local/bin/claude-anthropic',
      ...RUNTIME_ARGS,
      ...autonomousClaudePermissionArgs(),
      '--plugin-dir',
      '/opt/autodev'
    ]);
    const modeIndexes = plan.launcherArgv.flatMap((arg, index) =>
      arg === '--permission-mode' ? [index] : []
    );
    assert.equal(modeIndexes.length, 1);
    assert.equal(plan.launcherArgv[modeIndexes[0]! + 1], 'dontAsk');
    for (const flag of ['--permission-mode', '--allowedTools', '--disallowedTools']) {
      assert.equal(
        plan.launcherArgv.filter((arg) => arg === flag).length,
        1,
        `${flag} must occur exactly once`
      );
    }
  });

  it('fails closed when configured launcher args try to set a permission mode', () => {
    assert.throws(
      () =>
        planOpenAutonomousClaude(
          { ...RUNTIME, args: ['--permission-mode', 'default'] },
          '/work/repo',
          '/opt/autodev/scripts/controller.py'
        ),
      /override the autonomous Claude permission mode/
    );
  });
});

describe('openAutonomousClaude — terminal options', () => {
  it('sets hideFromUser (Python auto-activation opt-out) and shellPath = launcher', () => {
    const plan = planOpenAutonomousClaude(
      RUNTIME,
      '/work/repo',
      '/opt/autodev/scripts/controller.py'
    );
    const options = buildOpenAutonomousClaudeTerminalOptions(plan);
    assert.equal(options.hideFromUser, true);
    assert.equal(options.shellPath, RUNTIME.launcher);
    assert.deepEqual(options.shellArgs, [
      ...RUNTIME_ARGS,
      ...autonomousClaudePermissionArgs(),
      '--plugin-dir',
      '/opt/autodev'
    ]);
    assert.equal(options.cwd, '/work/repo');
  });

  it('env carries AUTODEV_CLAUDE_TERMINAL but MUST NOT carry AUTODEV_RUN_ID', () => {
    // AUTODEV_RUN_ID is the marker used by run-indexed identity. The unassociated
    // "Open Autonomous Claude" terminal must never carry a run association.
    const plan = planOpenAutonomousClaude(RUNTIME, '/work/repo', '');
    const options = buildOpenAutonomousClaudeTerminalOptions(plan);
    const env = (options.env ?? {}) as Record<string, string>;
    assert.equal(env[AUTONOMOUS_CLAUDE_TERMINAL_ENV_MARKER], '1');
    assert.equal(env['AUTODEV_RUN_ID'], undefined);
  });

  it('terminal name is Autonomous Claude — <repo>', () => {
    const plan = planOpenAutonomousClaude(RUNTIME, '/work/sample-repo', '');
    const options = buildOpenAutonomousClaudeTerminalOptions(plan);
    assert.equal(String(options.name), 'Autonomous Claude — sample-repo');
  });

  it('refuses to spawn when the launcher is a shell binary (defence in depth)', () => {
    const shellRuntime: ClaudeRuntime = { ...RUNTIME, launcher: '/bin/bash' };
    const plan = planOpenAutonomousClaude(shellRuntime, '/work/repo', '');
    assert.throws(() => buildOpenAutonomousClaudeTerminalOptions(plan), /known shell binary/);
  });
});

/**
 * Minimal fake terminal so tests can assert that sendText was never invoked
 * during the "open" flow. Any call to sendText increments the counter — the
 * test asserts it stays zero.
 */
function makeFakeTerminal(): {
  terminal: vscode.Terminal;
  sendTextCalls: number;
  shownCount: number;
} {
  const state = { sendTextCalls: 0, shownCount: 0 };
  const terminal = {
    name: 'x',
    processId: Promise.resolve(undefined),
    creationOptions: {} as vscode.TerminalOptions,
    exitStatus: undefined,
    state: { isInteractedWith: false, shell: undefined },
    shellIntegration: undefined,
    sendText: () => {
      state.sendTextCalls += 1;
    },
    show: () => {
      state.shownCount += 1;
    },
    hide: () => {
      /* no-op */
    },
    dispose: () => {
      /* no-op */
    }
  };
  return {
    terminal: terminal as unknown as vscode.Terminal,
    get sendTextCalls(): number {
      return state.sendTextCalls;
    },
    get shownCount(): number {
      return state.shownCount;
    }
  };
}

/**
 * Fake ConfigStore that returns a configured snapshot. Enough surface to drive
 * `openAutonomousClaudeInWorkspace` without spinning up the real ConfigStore
 * (which needs a controller process).
 */
function makeFakeConfigStore(overrides: {
  controllerAvailable?: boolean;
  runtimeName?: string;
  runtime?: ClaudeRuntime;
}): {
  refresh: () => Promise<void>;
  current: {
    controllerAvailable: boolean;
    effective?: { effective: { claudeRuntime?: string } };
    runtimes?: { claudeRuntimes: readonly ClaudeRuntime[] };
  };
} {
  const store = {
    refresh: async (): Promise<void> => undefined,
    current: {
      controllerAvailable: overrides.controllerAvailable ?? true,
      ...(overrides.runtimeName
        ? { effective: { effective: { claudeRuntime: overrides.runtimeName } } }
        : {}),
      ...(overrides.runtime ? { runtimes: { claudeRuntimes: [overrides.runtime] } } : {})
    }
  };
  return store;
}

function makeSilentLog(): {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
} {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

describe('openAutonomousClaudeInWorkspace — spawn behaviour', () => {
  it('launches a terminal with the configured Claude launcher in the selected repo cwd', async () => {
    const captured: vscode.TerminalOptions[] = [];
    const fake = makeFakeTerminal();
    const store = makeFakeConfigStore({ runtimeName: RUNTIME.name, runtime: RUNTIME });
    const plan = await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '/opt/autodev/scripts/controller.py',
      createTerminal: (opts) => {
        captured.push(opts);
        return fake.terminal;
      },
      showInfo: () => Promise.resolve(undefined),
      showError: () => Promise.resolve(undefined)
    });
    assert.ok(plan, 'plan should be produced');
    assert.equal(captured.length, 1);
    const [opts] = captured;
    assert.ok(opts);
    assert.equal(opts.cwd, '/work/sample-repo');
    assert.equal(opts.shellPath, RUNTIME.launcher);
    assert.deepEqual(opts.shellArgs, [
      ...RUNTIME_ARGS,
      ...autonomousClaudePermissionArgs(),
      '--plugin-dir',
      '/opt/autodev'
    ]);
    assert.equal(opts.hideFromUser, true);
    assert.equal(fake.shownCount, 1, 'the terminal must be revealed via show()');
  });

  it('submits the selected mode skill as the initial interactive prompt', async () => {
    const captured: vscode.TerminalOptions[] = [];
    const store = makeFakeConfigStore({ runtimeName: RUNTIME.name, runtime: RUNTIME });
    await openAutonomousClaudeInWorkspace(
      '/work/sample-repo',
      {
        store: store as never,
        log: makeSilentLog() as never,
        getControllerPath: () => '/opt/autodev/scripts/controller.py',
        createTerminal: (opts) => {
          captured.push(opts);
          return makeFakeTerminal().terminal;
        },
        showInfo: () => Promise.resolve(undefined),
        showError: () => Promise.resolve(undefined)
      },
      { mode: 'main', feature: 'Improve the timeline' }
    );
    assert.equal(
      (captured[0]?.shellArgs as string[] | undefined)?.at(-1),
      '/autonomous-development:autonomous-main Improve the timeline'
    );
  });

  it('tells the user which autonomous skills can initialize the run', async () => {
    const messages: string[] = [];
    const store = makeFakeConfigStore({ runtimeName: RUNTIME.name, runtime: RUNTIME });
    await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '',
      createTerminal: () => makeFakeTerminal().terminal,
      showInfo: (message) => {
        messages.push(message);
        return Promise.resolve(undefined);
      },
      showError: () => Promise.resolve(undefined)
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /Autonomous Claude is ready/);
    assert.match(messages[0] ?? '', /autonomous-development:autonomous-feature/);
    assert.match(messages[0] ?? '', /autonomous-development:autonomous-current/);
    assert.match(messages[0] ?? '', /autonomous-development:autonomous-main/);
  });

  it('never calls terminal.sendText — the plugin loads via the launcher itself', async () => {
    const fake = makeFakeTerminal();
    const store = makeFakeConfigStore({ runtimeName: RUNTIME.name, runtime: RUNTIME });
    await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '',
      createTerminal: () => fake.terminal,
      showInfo: () => Promise.resolve(undefined),
      showError: () => Promise.resolve(undefined)
    });
    assert.equal(fake.sendTextCalls, 0, 'sendText must never be called');
  });

  it('does not invent a run-indexed binding when no unbound evidence is supplied', async () => {
    const fake = makeFakeTerminal();
    const store = makeFakeConfigStore({ runtimeName: RUNTIME.name, runtime: RUNTIME });
    const registry = new ClaudeTerminalRegistry();
    const identitiesBefore = registry.activeIdentities();
    await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '',
      createTerminal: () => fake.terminal,
      showInfo: () => Promise.resolve(undefined),
      showError: () => Promise.resolve(undefined)
    });
    assert.deepEqual(registry.activeIdentities(), identitiesBefore);
    registry.dispose();
  });

  it('registers the Start terminal unbound without adding AUTODEV_RUN_ID', async () => {
    const fake = makeFakeTerminal();
    const store = makeFakeConfigStore({ runtimeName: RUNTIME.name, runtime: RUNTIME });
    const registry = new ClaudeTerminalRegistry();
    await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '',
      registry,
      unboundRepository: { repositoryId: 'repo-a', getKnownRunIds: () => ['older-run'] },
      createTerminal: () => fake.terminal,
      showInfo: () => Promise.resolve(undefined),
      showError: () => Promise.resolve(undefined)
    });
    assert.equal(registry.isUnbound(fake.terminal), true);
    assert.deepEqual(registry.activeIdentities(), []);
    registry.dispose();
  });

  it('registry auto-recovery does NOT attribute the terminal to any run', () => {
    // The registry scans vscode.window.terminals and re-registers any whose
    // name matches the run-scoped pattern. Our terminal name intentionally
    // does not match — so even if it happens to still be open when a new
    // registry activates, it must not be adopted.
    const terminalName = autonomousClaudeTerminalName('/work/sample-repo');
    const fakeWindow: {
      terminals: readonly vscode.Terminal[];
      onDidOpenTerminal: vscode.Event<vscode.Terminal>;
      onDidCloseTerminal: vscode.Event<vscode.Terminal>;
    } = {
      terminals: [{ name: terminalName, dispose: () => undefined } as unknown as vscode.Terminal],
      onDidOpenTerminal: new vscode.EventEmitter<vscode.Terminal>().event,
      onDidCloseTerminal: new vscode.EventEmitter<vscode.Terminal>().event
    };
    const reg = new ClaudeTerminalRegistry(fakeWindow);
    const recovered = reg.recoverExistingTerminals();
    assert.deepEqual(recovered, [], 'the registry must not adopt Autonomous Claude terminals');
    assert.equal(reg.activeIdentities().length, 0);
    reg.dispose();
  });

  it('surfaces a clear error and does not spawn when no controller is configured', async () => {
    const messages: string[] = [];
    const store = makeFakeConfigStore({ controllerAvailable: false });
    let created = 0;
    const plan = await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '',
      createTerminal: () => {
        created += 1;
        return makeFakeTerminal().terminal;
      },
      showInfo: () => Promise.resolve(undefined),
      showError: (m) => {
        messages.push(m);
        return Promise.resolve(undefined);
      }
    });
    assert.equal(plan, undefined);
    assert.equal(created, 0);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /No controller is configured/i);
  });

  it('surfaces a clear error when the selected runtime is not defined', async () => {
    const messages: string[] = [];
    const store = makeFakeConfigStore({
      runtimeName: 'gone',
      runtime: RUNTIME // present under a DIFFERENT name
    });
    let created = 0;
    await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '',
      createTerminal: () => {
        created += 1;
        return makeFakeTerminal().terminal;
      },
      showInfo: () => Promise.resolve(undefined),
      showError: (m) => {
        messages.push(m);
        return Promise.resolve(undefined);
      }
    });
    assert.equal(created, 0);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /"gone".*no longer defined/i);
  });

  it('surfaces a clear error when the launcher is missing', async () => {
    const messages: string[] = [];
    const missingRuntime: ClaudeRuntime = { ...RUNTIME, launcherExists: false };
    const store = makeFakeConfigStore({
      runtimeName: missingRuntime.name,
      runtime: missingRuntime
    });
    let created = 0;
    await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '',
      createTerminal: () => {
        created += 1;
        return makeFakeTerminal().terminal;
      },
      showInfo: () => Promise.resolve(undefined),
      showError: (m) => {
        messages.push(m);
        return Promise.resolve(undefined);
      }
    });
    assert.equal(created, 0);
    assert.match(messages[0] ?? '', /launcher is missing/i);
  });

  it('surfaces a clear error when the launcher is not executable', async () => {
    const messages: string[] = [];
    const notExec: ClaudeRuntime = { ...RUNTIME, launcherExecutable: false };
    const store = makeFakeConfigStore({ runtimeName: notExec.name, runtime: notExec });
    let created = 0;
    await openAutonomousClaudeInWorkspace('/work/sample-repo', {
      store: store as never,
      log: makeSilentLog() as never,
      getControllerPath: () => '',
      createTerminal: () => {
        created += 1;
        return makeFakeTerminal().terminal;
      },
      showInfo: () => Promise.resolve(undefined),
      showError: (m) => {
        messages.push(m);
        return Promise.resolve(undefined);
      }
    });
    assert.equal(created, 0);
    assert.match(messages[0] ?? '', /not executable/i);
  });
});
