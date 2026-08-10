import assert from 'node:assert/strict';

import type { ClaudeRuntime, DiscoveredRun } from '@semanticmatter/core';

import {
  CLAUDE_TERMINAL_ENV_MARKER,
  CLAUDE_TERMINAL_NAME_PREFIX,
  CLAUDE_TERMINAL_RUN_ENV,
  buildTerminalOptions,
  claudeTerminalNameFor,
  isKnownShellBinary,
  parseClaudeTerminalIdentity,
  planResumeInClaude
} from '../src/config/resumeInClaude';

const RUN_ID = '20260806T091439Z-cafefacefade';
const IDENTITY = { repositoryId: 'repo', runId: RUN_ID };
const RUNTIME: ClaudeRuntime = {
  name: 'azure-claude',
  displayName: 'Azure · Claude',
  launcher: '/usr/local/bin/claude-azure',
  args: ['--profile', 'azure'],
  launcherExists: true,
  launcherExecutable: true
};

function makeRun(): DiscoveredRun {
  return {
    runId: RUN_ID,
    repoId: 'repo',
    runDir: '/x',
    group: 'active',
    diagnostics: [],
    state: {
      schemaVersion: 2,
      runId: RUN_ID,
      feature: '',
      status: 'active',
      rawStatus: 'active',
      phase: 'implementing',
      repository: { id: 'repo', worktreePath: '/work/wt' },
      maxReviewRounds: 3,
      reviewRound: 0,
      stopGateBlocks: 0,
      artifacts: { raw: {} },
      verification: { checks: [] },
      reviews: [],
      adversarialReviews: [],
      risk: { requiresAdversarialReview: false, reasons: [] },
      notes: [],
      completionGateFailures: [],
      cumulativeFindings: [],
      cumulativeAcceptanceCriteria: [],
      reviewLedger: [],
      codexRuns: [],
      modeReasons: [],
      raw: { config_snapshot: { claude_runtime: 'azure-claude', codex: {} } }
    }
  } as unknown as DiscoveredRun;
}

describe('claudeTerminalNameFor / parseClaudeTerminalIdentity', () => {
  it('round-trips a deterministic repository-qualified identity', () => {
    const name = claudeTerminalNameFor(IDENTITY);
    assert.equal(name, `${CLAUDE_TERMINAL_NAME_PREFIX}repo · ${RUN_ID}`);
    assert.deepEqual(parseClaudeTerminalIdentity(name), IDENTITY);
  });
  it('round-trips only for names produced by claudeTerminalNameFor', () => {
    assert.equal(parseClaudeTerminalIdentity('bash'), undefined);
    assert.equal(parseClaudeTerminalIdentity('Task - build'), undefined);
    assert.equal(
      parseClaudeTerminalIdentity(`${CLAUDE_TERMINAL_NAME_PREFIX}not-a-run-id`),
      undefined
    );
    assert.equal(
      parseClaudeTerminalIdentity(`${CLAUDE_TERMINAL_NAME_PREFIX}repo · bad/run/id`),
      undefined
    );
  });
});

describe('isKnownShellBinary', () => {
  it('recognizes common interactive shells (basename match)', () => {
    for (const p of [
      '/bin/bash',
      '/usr/local/bin/zsh',
      '/bin/sh',
      '/opt/homebrew/bin/fish',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'powershell.exe',
      'PWSH'
    ]) {
      assert.equal(isKnownShellBinary(p), true, `should recognize ${p}`);
    }
  });
  it('does NOT recognize a launcher path as a shell', () => {
    assert.equal(isKnownShellBinary('/usr/local/bin/claude-azure'), false);
    assert.equal(isKnownShellBinary('/opt/claude/claude'), false);
    assert.equal(isKnownShellBinary(undefined), false);
  });
});

describe('buildTerminalOptions — Python auto-activation defenses', () => {
  it('opts out of Python activation injection before the terminal is revealed', () => {
    const run = makeRun();
    const plan = planResumeInClaude(run, [RUNTIME], undefined, '', '/work/wt');
    const options = buildTerminalOptions(plan);
    assert.equal(options.hideFromUser, true);
  });

  it('stamps deterministic env markers on every terminal', () => {
    const run = makeRun();
    const plan = planResumeInClaude(run, [RUNTIME], undefined, '', '/work/wt');
    const options = buildTerminalOptions(plan);
    const env = options.env as Record<string, string>;
    assert.equal(env[CLAUDE_TERMINAL_ENV_MARKER], '1');
    assert.equal(env[CLAUDE_TERMINAL_RUN_ENV], RUN_ID);
  });

  it('names the terminal so post-reload recovery can find it by name', () => {
    const run = makeRun();
    const plan = planResumeInClaude(run, [RUNTIME], undefined, '', '/work/wt');
    const options = buildTerminalOptions(plan);
    assert.equal(options.name, `${CLAUDE_TERMINAL_NAME_PREFIX}repo · ${RUN_ID}`);
    assert.deepEqual(parseClaudeTerminalIdentity(String(options.name)), IDENTITY);
  });

  it('refuses to launch via a known interactive shell (structural block on Python auto-activation)', () => {
    const shellRuntime: ClaudeRuntime = {
      name: 'sh-wrapper',
      launcher: '/bin/bash',
      args: ['-c', 'exec claude'],
      launcherExists: true,
      launcherExecutable: true
    };
    const run = makeRun();
    // Replace snapshot claude_runtime so the plan resolves shellRuntime.
    (run.state as { raw: Record<string, unknown> }).raw = {
      config_snapshot: { claude_runtime: 'sh-wrapper', codex: {} }
    };
    const plan = planResumeInClaude(run, [shellRuntime], undefined, '', '/work/wt');
    assert.throws(
      () => buildTerminalOptions(plan),
      /Refusing to launch Claude via a known shell/i
    );
  });

  it('shellPath is never a shell → Python\'s activator will not target it', () => {
    const run = makeRun();
    const plan = planResumeInClaude(run, [RUNTIME], undefined, '', '/work/wt');
    const options = buildTerminalOptions(plan);
    assert.equal(isKnownShellBinary(String(options.shellPath)), false);
  });

  it('no shellArgs element carries an activation-source command', () => {
    // Regression against a broken world where we tried to send `source
    // .venv/bin/activate` before Claude — the current architecture never puts
    // any such text in shellArgs.
    const run = makeRun();
    const plan = planResumeInClaude(run, [RUNTIME], undefined, '', '/work/wt');
    const options = buildTerminalOptions(plan);
    for (const arg of options.shellArgs ?? []) {
      assert.doesNotMatch(arg, /(^|\s)(source|\.)\s+/);
      assert.doesNotMatch(arg, /activate(\.\w+)?$/);
    }
  });
});
