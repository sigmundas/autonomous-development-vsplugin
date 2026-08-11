import assert from 'node:assert/strict';

import type { ClaudeRuntime, DiscoveredRun } from '@semanticmatter/core';

import { autonomousClaudePermissionArgs } from '../src/config/claudeLauncher';
import { buildTerminalOptions, planResumeInClaude } from '../src/config/resumeInClaude';

const RUNTIME: ClaudeRuntime = {
  name: 'azure-claude',
  displayName: 'Azure · Claude',
  launcher: '/usr/local/bin/claude-azure',
  args: ['--profile', 'azure'],
  launcherExists: true,
  launcherExecutable: true
};

function makeRun(snapshot: unknown, worktreePath: string): DiscoveredRun {
  return {
    runId: '20260806T091439Z-cafefacefade',
    repoId: 'repo',
    runDir: '/x',
    group: 'active',
    diagnostics: [],
    state: {
      schemaVersion: 2,
      runId: '20260806T091439Z-cafefacefade',
      feature: 'x',
      status: 'active',
      rawStatus: 'active',
      phase: 'implementing',
      repository: { id: 'repo', worktreePath },
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
      raw: { config_snapshot: snapshot } as Readonly<Record<string, unknown>>
    }
  } as unknown as DiscoveredRun;
}

describe('buildTerminalOptions — direct launcher process (no shell interposition)', () => {
  it('pins allowed commands, executable paths, and model for resume and fresh-session plans', () => {
    const snapshot = {
      claude_runtime: 'azure-claude',
      claude_runtime_snapshot: {
        name: 'azure-claude',
        display_name: 'Snapshot runtime',
        launcher: '/snapshot/bin/claude',
        args: ['--profile', 'snapshot'],
        allowed_commands: ['ruff', 'npm run test'],
        executable_paths: ['/opt/homebrew/bin', '~/.local/bin']
      },
      claude_model: { id: 'sonnet46', model: 'claude-sonnet-4-6' },
      codex: {}
    };
    const run = makeRun(snapshot, '/work/wt');
    const changedGlobal: ClaudeRuntime = {
      ...RUNTIME,
      args: ['--profile', 'changed-global'],
      allowedCommands: ['pytest'],
      executablePaths: ['/changed/bin']
    };

    const initial = planResumeInClaude(
      run,
      [RUNTIME],
      'azure-claude',
      '/opt/autodev/scripts/controller.py',
      '/work/wt'
    );
    const fresh = planResumeInClaude(
      run,
      [changedGlobal],
      'azure-claude',
      '/opt/autodev/scripts/controller.py',
      '/work/wt'
    );

    assert.deepEqual(initial.runtime?.allowedCommands, ['ruff', 'npm run test']);
    assert.deepEqual(fresh.runtime?.allowedCommands, initial.runtime?.allowedCommands);
    assert.deepEqual(initial.runtime?.executablePaths, ['/opt/homebrew/bin', '~/.local/bin']);
    assert.deepEqual(fresh.runtime?.executablePaths, initial.runtime?.executablePaths);
    assert.deepEqual(fresh.launcherArgv, initial.launcherArgv);
    assert.equal(
      fresh.launcherArgv[fresh.launcherArgv.indexOf('--model') + 1],
      'claude-sonnet-4-6'
    );
    const allowedTools = fresh.launcherArgv[fresh.launcherArgv.indexOf('--allowedTools') + 1];
    assert.match(allowedTools ?? '', /Bash\(ruff:\*\)/);
    assert.match(allowedTools ?? '', /Bash\(npm run test:\*\)/);
    const terminal = buildTerminalOptions(fresh);
    const launchedPath = terminal.env?.['PATH'];
    assert.match(launchedPath ?? '', /\/opt\/homebrew\/bin/);
    assert.match(launchedPath ?? '', /\.local\/bin/);
    assert.doesNotMatch(launchedPath ?? '', /\/changed\/bin/);
  });

  it('uses only the snapshotted model and keeps legacy snapshots model-free', () => {
    const selected = makeRun(
      {
        claude_runtime: 'azure-claude',
        claude_model: { id: 'sonnet', display_name: 'Sonnet', model: 'sonnet-exact' },
        codex: {}
      },
      '/work/wt'
    );
    const selectedPlan = planResumeInClaude(
      selected,
      [RUNTIME],
      undefined,
      '/opt/controller.py',
      '/work/wt'
    );
    const modelIndex = selectedPlan.launcherArgv.indexOf('--model');
    assert.equal(selectedPlan.launcherArgv[modelIndex + 1], 'sonnet-exact');

    const legacy = makeRun({ claude_runtime: 'azure-claude', codex: {} }, '/work/wt');
    const legacyPlan = planResumeInClaude(
      legacy,
      [RUNTIME],
      undefined,
      '/opt/controller.py',
      '/work/wt'
    );
    assert.equal(legacyPlan.launcherArgv.includes('--model'), false);
  });

  it('uses the launcher as shellPath and passes launcher args as shellArgs', () => {
    const run = makeRun({ claude_runtime: 'azure-claude', codex: {} }, '/work/wt');
    const plan = planResumeInClaude(
      run,
      [RUNTIME],
      undefined,
      '/opt/autodev/scripts/controller.py',
      '/work/wt'
    );
    const options = buildTerminalOptions(plan);
    assert.equal(options.shellPath, '/usr/local/bin/claude-azure');
    // shellArgs must include the runtime's own args AND the auto-appended
    // --plugin-dir followed by the derived plugin root.
    assert.deepEqual(options.shellArgs, [
      '--profile',
      'azure',
      ...autonomousClaudePermissionArgs(),
      '--plugin-dir',
      '/opt/autodev',
      '--append-system-prompt',
      plan.instruction,
      plan.bootstrapPrompt
    ]);
    // cwd is the run worktree.
    assert.equal(options.cwd, '/work/wt');
    // Python's terminal-open hook skips terminals created with hideFromUser.
    // terminal.show() may reveal it afterward without changing creationOptions.
    assert.equal(options.hideFromUser, true);
    // Terminal name includes the run id so multiple runs stay distinguishable.
    assert.match(String(options.name), /20260806T091439Z-cafefacefade/);
  });

  it('omits --plugin-dir when the controller path does not sit under scripts/', () => {
    const run = makeRun({ claude_runtime: 'azure-claude', codex: {} }, '/work/wt');
    const plan = planResumeInClaude(run, [RUNTIME], undefined, '/opt/controller.py', '/work/wt');
    const options = buildTerminalOptions(plan);
    assert.deepEqual(options.shellArgs, [
      '--profile',
      'azure',
      ...autonomousClaudePermissionArgs(),
      '--append-system-prompt',
      plan.instruction,
      plan.bootstrapPrompt
    ]);
  });

  it('never carries a `sendText`-style command line into the shell', () => {
    // Regression: prior implementation called terminal.sendText(cmd, true) into
    // an interactive shell, letting Python's activation command race in first.
    // The direct-shell design in buildTerminalOptions removes that vector — no
    // shell script is spawned to receive text, only the launcher itself.
    const run = makeRun({ claude_runtime: 'azure-claude', codex: {} }, '/work/wt');
    const plan = planResumeInClaude(
      run,
      [RUNTIME],
      undefined,
      '/opt/autodev/scripts/controller.py',
      '/work/wt'
    );
    const options = buildTerminalOptions(plan);
    // We do NOT expose a `sendText` field on TerminalOptions in this design.
    // Assert that neither shellPath nor shellArgs contains a shell binary that
    // would then interpret sourced activation scripts.
    assert.doesNotMatch(String(options.shellPath), /\/(ba|z|)sh$/);
    for (const arg of options.shellArgs ?? []) {
      assert.doesNotMatch(arg, /(^|\s)source\s+/);
      assert.doesNotMatch(arg, /activate/);
    }
  });
});

describe('planResumeInClaude — worktree cwd for resume', () => {
  it('uses the run worktree path as the terminal cwd', () => {
    const run = makeRun(
      { claude_runtime: 'azure-claude', codex: {} },
      '/work/repo/.autodev-worktrees/rid'
    );
    const plan = planResumeInClaude(
      run,
      [RUNTIME],
      undefined,
      '/opt/autodev/scripts/controller.py',
      run.state?.repository.worktreePath as string
    );
    const options = buildTerminalOptions(plan);
    assert.equal(options.cwd, '/work/repo/.autodev-worktrees/rid');
  });
});
