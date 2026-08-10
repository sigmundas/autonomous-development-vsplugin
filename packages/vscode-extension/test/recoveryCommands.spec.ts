import assert from 'node:assert/strict';

import type { DiscoveredRun } from '@semanticmatter/core';

import {
  authorizeRecoverableRun,
  recoverBlockedRun,
  type RecoveryCommandDeps
} from '../src/commands/controllerCommands';

function run(runId: string, status: 'active' | 'blocked', parentRunId?: string): DiscoveredRun {
  return {
    runId,
    repoId: 'repo',
    runDir: `/runs/${runId}`,
    group: status === 'blocked' ? 'completed' : 'active',
    diagnostics: [],
    state: {
      runId,
      status,
      parentRunId,
      repository: { id: 'repo', worktreePath: '/work/repo' }
    }
  } as unknown as DiscoveredRun;
}

function harness(parent: DiscoveredRun, child: DiscoveredRun, reused = false): {
  deps: RecoveryCommandDeps;
  calls: Array<{ sub: string; runId: string; intent?: string }>;
  surfaced: string[];
  resumed: string[];
  refreshes: { count: number };
} {
  const calls: Array<{ sub: string; runId: string; intent?: string }> = [];
  const surfaced: string[] = [];
  const resumed: string[] = [];
  const refreshes = { count: 0 };
  const service = {
    isConfigured: () => true,
    executeForRun: async (
      sub: string,
      target: DiscoveredRun,
      options: { recoveryIntent?: string } = {}
    ) => {
      calls.push({
        sub,
        runId: target.runId,
        ...(options.recoveryIntent ? { intent: options.recoveryIntent } : {})
      });
      if (sub === 'continue-run') {
        return {
          stdout: JSON.stringify({
            run_id: child.runId,
            parent_run_id: parent.runId,
            reused
          }),
          stderr: ''
        };
      }
      return { stdout: JSON.stringify({ run_id: target.runId }), stderr: '' };
    }
  };
  return {
    deps: {
      service: service as unknown as RecoveryCommandDeps['service'],
      getConfig: () => ({}) as never,
      refresh: () => {
        refreshes.count += 1;
      },
      getRun: (_repoId, runId) => (runId === child.runId ? child : undefined),
      surfaceRun: (target) => surfaced.push(target.runId),
      resumeRun: async (target) => {
        resumed.push(target.runId);
      }
    },
    calls,
    surfaced,
    resumed,
    refreshes
  };
}

describe('blocked-run recovery orchestration', () => {
  it('terminal Allow one more review creates/reuses a child and never authorizes the parent', async () => {
    const parent = run('parent', 'blocked');
    const child = run('child', 'active', parent.runId);
    const h = harness(parent, child);

    const result = await recoverBlockedRun(parent, 'allow-one-more-review', h.deps);

    assert.equal(result.continuation.runId, child.runId);
    assert.deepEqual(h.calls, [
      { sub: 'continue-run', runId: parent.runId, intent: 'allow-one-more-review' },
      { sub: 'authorize-review', runId: child.runId }
    ]);
    assert.ok(!h.calls.some((call) => call.sub === 'authorize-review' && call.runId === parent.runId));
    assert.deepEqual(h.surfaced, [child.runId]);
    assert.deepEqual(h.resumed, [child.runId]);
    assert.equal(h.refreshes.count, 2);
  });

  it('terminal missing adversarial review resumes the exact continuation without parent mutation', async () => {
    const parent = run('parent', 'blocked');
    const child = run('child', 'active', parent.runId);
    const h = harness(parent, child);

    await recoverBlockedRun(parent, 'resume-adversarial', h.deps);

    assert.deepEqual(h.calls, [
      { sub: 'continue-run', runId: parent.runId, intent: 'resume-adversarial' }
    ]);
    assert.deepEqual(h.surfaced, [child.runId]);
    assert.deepEqual(h.resumed, [child.runId]);
  });

  it('repeated recovery clicks reuse and resume the same discovered continuation', async () => {
    const parent = run('parent', 'blocked');
    const child = run('child', 'active', parent.runId);
    const h = harness(parent, child, true);

    const first = await recoverBlockedRun(parent, 'continue-blocked', h.deps);
    const second = await recoverBlockedRun(parent, 'continue-blocked', h.deps);

    assert.equal(first.continuation.runId, child.runId);
    assert.equal(second.continuation.runId, child.runId);
    assert.deepEqual(h.resumed, [child.runId, child.runId]);
    assert.deepEqual(h.surfaced, [child.runId, child.runId]);
  });

  it('non-terminal recoverable +1 authorizes and resumes that same run directly', async () => {
    const active = run('recoverable', 'active');
    const h = harness(active, active);

    await authorizeRecoverableRun(active, h.deps);

    assert.deepEqual(h.calls, [
      { sub: 'authorize-review', runId: active.runId }
    ]);
    assert.deepEqual(h.surfaced, [active.runId]);
    assert.deepEqual(h.resumed, [active.runId]);
    assert.equal(h.refreshes.count, 1);
  });
});
