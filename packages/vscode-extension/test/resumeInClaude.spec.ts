import assert from 'node:assert/strict';
import * as path from 'node:path';

import type { ClaudeRuntime, DiscoveredRun } from '@semanticmatter/core';

import {
  pluginDirFromControllerPath,
  planResumeInClaude,
  resolveRuntimeForRun,
  snapshotFor,
  worktreeForRun
} from '../src/config/resumeInClaude';

const AZURE: ClaudeRuntime = {
  name: 'azure-claude',
  displayName: 'Azure · Claude',
  launcher: '/usr/local/bin/claude-azure',
  args: [],
  launcherExists: true,
  launcherExecutable: true
};
const ANTHROPIC: ClaudeRuntime = {
  name: 'anthropic-claude',
  displayName: 'Anthropic · Claude',
  launcher: '/usr/local/bin/claude-anthropic',
  args: [],
  launcherExists: true,
  launcherExecutable: true
};
const MISSING: ClaudeRuntime = {
  name: 'missing-runtime',
  launcher: '/nowhere',
  args: [],
  launcherExists: false,
  launcherExecutable: false
};

function makeRun(overrides: {
  runId?: string;
  worktreePath?: string;
  canonicalRoot?: string;
  status?: string;
  snapshot?: unknown;
}): DiscoveredRun {
  const rawState: Record<string, unknown> = {};
  if (overrides.snapshot !== undefined) rawState['config_snapshot'] = overrides.snapshot;
  return {
    runId: overrides.runId ?? '20260806T091439Z-ab08221b',
    repoId: 'repo-abc',
    runDir: '/state/repositories/repo-abc/runs/rid',
    group: 'active',
    diagnostics: [],
    state: {
      schemaVersion: 2,
      runId: overrides.runId ?? '20260806T091439Z-ab08221b',
      feature: 'x',
      status: (overrides.status as 'active' | undefined) ?? 'active',
      rawStatus: overrides.status ?? 'active',
      phase: 'implementing',
      repository: {
        id: 'repo-abc',
        ...(overrides.worktreePath !== undefined ? { worktreePath: overrides.worktreePath } : {}),
        ...(overrides.canonicalRoot !== undefined ? { canonicalRoot: overrides.canonicalRoot } : {})
      },
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
      raw: rawState as Readonly<Record<string, unknown>>
    }
  } as unknown as DiscoveredRun;
}

describe('resumeInClaude — runtime resolution', () => {
  it('prefers the snapshot runtime over the global preset', () => {
    const run = makeRun({
      snapshot: {
        preset: 'azure-autonomous',
        claude_runtime: 'azure-claude',
        codex: {}
      }
    });
    const { runtime, source } = resolveRuntimeForRun(
      run,
      [AZURE, ANTHROPIC],
      'anthropic-claude' // global preset picks anthropic
    );
    assert.equal(runtime?.name, 'azure-claude');
    assert.equal(source.kind, 'snapshot');
    if (source.kind === 'snapshot') {
      assert.equal(source.runtimeName, 'azure-claude');
    }
  });

  it('falls back to the global runtime for legacy runs without a snapshot', () => {
    const run = makeRun({}); // no snapshot at all
    const { runtime, source } = resolveRuntimeForRun(run, [AZURE, ANTHROPIC], 'anthropic-claude');
    assert.equal(runtime?.name, 'anthropic-claude');
    assert.equal(source.kind, 'fallback');
    if (source.kind === 'fallback') {
      assert.equal(source.runtimeName, 'anthropic-claude');
      assert.equal(source.reason, 'legacy-run-no-snapshot');
    }
  });

  it('reports snapshot-runtime-not-defined when snapshot names a runtime the config no longer has', () => {
    const run = makeRun({
      snapshot: { claude_runtime: 'gone-forever', codex: {} }
    });
    const { runtime, source } = resolveRuntimeForRun(run, [AZURE, ANTHROPIC], 'azure-claude');
    assert.equal(runtime, undefined);
    assert.equal(source.kind, 'unavailable');
    if (source.kind === 'unavailable') {
      assert.equal(source.reason, 'snapshot-runtime-not-defined');
    }
  });

  it('reports snapshot-runtime-missing when the snapshot is present but names no runtime', () => {
    const run = makeRun({ snapshot: { codex: {} } });
    const { runtime, source } = resolveRuntimeForRun(run, [AZURE, ANTHROPIC], 'azure-claude');
    assert.equal(runtime, undefined);
    assert.equal(source.kind, 'unavailable');
    if (source.kind === 'unavailable') {
      assert.equal(source.reason, 'snapshot-runtime-missing');
    }
  });

  it('reports no-global-runtime for a legacy run when no global runtime is set', () => {
    const run = makeRun({});
    const { runtime, source } = resolveRuntimeForRun(run, [AZURE, ANTHROPIC], undefined);
    assert.equal(runtime, undefined);
    assert.equal(source.kind, 'unavailable');
    if (source.kind === 'unavailable') {
      assert.equal(source.reason, 'no-global-runtime');
    }
  });

  it('never invents a runtime if the snapshot names a missing one AND a different global exists', () => {
    // Reasserts the invariant: snapshot precedence forbids silent substitution.
    const run = makeRun({ snapshot: { claude_runtime: 'gone', codex: {} } });
    const { runtime, source } = resolveRuntimeForRun(
      run,
      [AZURE, ANTHROPIC],
      'anthropic-claude'
    );
    assert.equal(runtime, undefined);
    assert.notEqual(source.kind, 'fallback');
    assert.equal(source.kind, 'unavailable');
  });
});

describe('resumeInClaude — plan construction', () => {
  const controllerPath = '/Users/x/autodev/scripts/controller.py';
  const expectedPluginDir = '/Users/x/autodev';

  it('uses the run worktree as the terminal cwd', () => {
    const run = makeRun({
      worktreePath: '/work/repo/.autodev-worktrees/rid',
      snapshot: { claude_runtime: 'azure-claude', codex: {} }
    });
    const plan = planResumeInClaude(
      run,
      [AZURE],
      undefined,
      controllerPath,
      run.state?.repository.worktreePath as string
    );
    assert.equal(plan.worktreePath, '/work/repo/.autodev-worktrees/rid');
  });

  it('includes --plugin-dir automatically when the controller path shape allows it', () => {
    const run = makeRun({ snapshot: { claude_runtime: 'azure-claude', codex: {} } });
    const plan = planResumeInClaude(run, [AZURE], undefined, controllerPath, '/work/repo');
    assert.equal(plan.pluginDir, expectedPluginDir);
    const idx = plan.launcherArgv.indexOf('--plugin-dir');
    assert.ok(idx >= 0, `expected --plugin-dir in argv, got: ${plan.launcherArgv.join(' ')}`);
    assert.equal(plan.launcherArgv[idx + 1], expectedPluginDir);
  });

  it('does not include --plugin-dir when the controller path does not sit under a scripts/ dir', () => {
    const run = makeRun({ snapshot: { claude_runtime: 'azure-claude', codex: {} } });
    const plan = planResumeInClaude(run, [AZURE], undefined, '/opt/controller.py', '/work/repo');
    assert.equal(plan.pluginDir, undefined);
    assert.ok(!plan.launcherArgv.includes('--plugin-dir'));
  });

  it('produces a POSIX/Windows-safe command line (quoting delegated to buildLauncherArgs/formatLauncherCommand)', () => {
    const trouble: ClaudeRuntime = {
      name: 'quirky',
      launcher: '/opt/quirky bin/claude',
      args: ['a; rm -rf $HOME'],
      launcherExists: true,
      launcherExecutable: true
    };
    const run = makeRun({ snapshot: { claude_runtime: 'quirky', codex: {} } });
    const plan = planResumeInClaude(run, [trouble], undefined, controllerPath, '/work/repo');
    // Bare token whitespace must be quoted; adversarial shell chars must be quoted.
    assert.match(plan.commandLine, /'\/opt\/quirky bin\/claude'|"\/opt\/quirky bin\/claude"/);
    assert.match(plan.commandLine, /'a; rm -rf \$HOME'|"a; rm -rf \$HOME"/);
  });

  it('includes the deterministic resume instruction with the exact run id', () => {
    const run = makeRun({
      runId: '20260806T091439Z-cafefacefade',
      snapshot: { claude_runtime: 'azure-claude', codex: {} }
    });
    const plan = planResumeInClaude(run, [AZURE], undefined, controllerPath, '/work/repo');
    assert.match(
      plan.instruction,
      /Resume autonomous-development run 20260806T091439Z-cafefacefade\. Do not initialize a new run\./
    );
    assert.match(
      plan.instruction,
      /Run controller status and next-action --json, then continue from the recorded phase\./
    );
    // The instruction MUST NOT contain a "controller.py init" invocation — the
    // extension never resumes a run by initializing. Match the *word* boundary
    // so the "initialize" that appears in "Do not initialize a new run" (the
    // negative directive) does not spuriously trigger this assertion.
    assert.doesNotMatch(plan.instruction, /\binit\b/);
    assert.doesNotMatch(plan.instruction, /controller\.py\s+init/);
  });

  it('produces an empty argv when no runtime can be resolved', () => {
    const run = makeRun({ snapshot: { claude_runtime: 'gone', codex: {} } });
    const plan = planResumeInClaude(run, [AZURE], undefined, controllerPath, '/work/repo');
    assert.equal(plan.runtime, undefined);
    assert.deepEqual(plan.launcherArgv, []);
    assert.equal(plan.commandLine, '');
  });

  it('does not build a runtime for a missing / non-executable launcher via the plan alone (guard runs at resumeRunInClaude())', () => {
    // Plan does not filter out invalid launchers — the executor does. This
    // documents the layering.
    const run = makeRun({ snapshot: { claude_runtime: 'missing-runtime', codex: {} } });
    const plan = planResumeInClaude(run, [MISSING], undefined, controllerPath, '/work/repo');
    assert.equal(plan.runtime?.launcherExists, false);
  });
});

describe('resumeInClaude — small utilities', () => {
  it('pluginDirFromControllerPath extracts the plugin root from a scripts/controller.py path', () => {
    assert.equal(
      pluginDirFromControllerPath('/Users/x/autodev/scripts/controller.py'),
      '/Users/x/autodev'
    );
  });
  it('pluginDirFromControllerPath returns undefined for a non-scripts layout', () => {
    assert.equal(pluginDirFromControllerPath('/opt/controller.py'), undefined);
    assert.equal(pluginDirFromControllerPath(''), undefined);
  });

  it('snapshotFor returns undefined for legacy runs', () => {
    const legacy = makeRun({});
    assert.equal(snapshotFor(legacy), undefined);
  });
  it('snapshotFor returns the parsed snapshot for modern runs', () => {
    const modern = makeRun({
      snapshot: { preset: 'p', claude_runtime: 'r', codex: {} }
    });
    const snap = snapshotFor(modern);
    assert.equal(snap?.preset, 'p');
    assert.equal(snap?.claudeRuntime, 'r');
  });

  it('worktreeForRun prefers isolated worktree path over canonical root', () => {
    const run = makeRun({
      worktreePath: '/work/wt-1',
      canonicalRoot: '/work/repo'
    });
    assert.equal(worktreeForRun(run), '/work/wt-1');
  });
  it('worktreeForRun falls back to canonical root when no worktree is recorded', () => {
    const run = makeRun({ canonicalRoot: '/work/repo' });
    assert.equal(worktreeForRun(run), '/work/repo');
  });
});

describe('resumeInClaude — instruction never mentions init or a new run', () => {
  it('instruction template contains "Do not initialize a new run"', () => {
    const run = makeRun({ snapshot: { claude_runtime: 'azure-claude', codex: {} } });
    const plan = planResumeInClaude(
      run,
      [AZURE],
      undefined,
      '/Users/x/autodev/scripts/controller.py',
      '/work/repo'
    );
    assert.match(plan.instruction, /Do not initialize a new run/i);
  });
});

// path is intentionally unused; keeping the import to make the small-utility
// tests self-contained if we extend them later.
void path;
