import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRun } from '../src/loadRun';
import { loadEventLog } from '../src/events';
import { discoverRuns, groupForStatus, runsInGroup } from '../src/runDiscovery';

let root: string;

function runStateObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: 'RUN1',
    status: 'active',
    phase: 'reviewed',
    feature: 'demo',
    repository: { id: 'repo1', worktree_path: '/repo' },
    max_review_rounds: 3,
    review_round: 1,
    artifacts: {
      enhance: 'feature-spec.codex.json',
      accepted_spec: 'accepted-spec.md',
      accepted_plan: 'accepted-plan.md',
      review: 'review-01.codex.json'
    },
    verification: {
      passed: true,
      checks: [{ name: 'unit', command: ['npm', 'test'], exit_code: 0 }]
    },
    reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }],
    adversarial_reviews: [],
    risk: { requires_adversarial_review: false, reasons: [] },
    ...overrides
  };
}

function makeRun(
  runId: string,
  stateOverrides: Record<string, unknown>,
  files: Record<string, string> = {}
): string {
  const runDir = join(root, 'repositories', 'repo1', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'run-state.json'),
    JSON.stringify(runStateObject({ run_id: runId, ...stateOverrides }), null, 2)
  );
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(runDir, name), content);
  }
  return runDir;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'autodev-core-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadRun (disk IO)', () => {
  it('loads a completion-ready run and passes the gates', () => {
    const runDir = makeRun(
      'RUN1',
      {},
      {
        'accepted-spec.md': '# spec',
        'accepted-plan.md': '# plan',
        'review-01.codex.json': JSON.stringify({ verdict: 'pass', findings: [] })
      }
    );
    const loaded = loadRun(runDir);
    assert.ok(loaded.state);
    assert.ok(loaded.model);
    assert.equal(loaded.model?.gatesPass, true);
    assert.equal(loaded.model?.recommendedNextAction.code, 'evaluate-report');
    assert.equal(loaded.diagnostics.length, 0);
  });

  it('counts raw severe findings from the latest review file (gate #7)', () => {
    const runDir = makeRun(
      'RUN_SEVERE',
      {},
      {
        'accepted-spec.md': '# spec',
        'accepted-plan.md': '# plan',
        'review-01.codex.json': JSON.stringify({
          verdict: 'pass',
          findings: [
            { id: 'F-1', severity: 'high' },
            { id: 'F-2', severity: 'low' }
          ]
        })
      }
    );
    const loaded = loadRun(runDir);
    assert.equal(loaded.model?.review.severeFindingCount, 1);
    assert.equal(loaded.model?.gatesPass, false);
    assert.ok(loaded.model?.completionGateFailures.some((f) => f.code === 'severe-findings'));
  });

  it('treats a missing accepted-spec.md as a gate failure', () => {
    const runDir = makeRun(
      'RUN_NOSPEC',
      {},
      {
        'accepted-plan.md': '# plan',
        'review-01.codex.json': JSON.stringify({ verdict: 'pass', findings: [] })
      }
    );
    const loaded = loadRun(runDir);
    assert.ok(loaded.model?.completionGateFailures.some((f) => f.code === 'missing-accepted-spec'));
    assert.equal(loaded.model?.recommendedNextAction.code, 'reconcile-spec');
  });

  it('produces a diagnostic (not a throw) for malformed run-state.json', () => {
    const runDir = join(root, 'repositories', 'repo1', 'runs', 'RUN_BAD');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run-state.json'), '{ broken json');
    const loaded = loadRun(runDir);
    assert.equal(loaded.model, undefined);
    assert.ok(loaded.diagnostics.some((d) => d.code === 'run-state-parse-error'));
  });

  it('reports an unreadable review without crashing', () => {
    const runDir = makeRun(
      'RUN_BADREVIEW',
      {},
      {
        'accepted-spec.md': '# spec',
        'accepted-plan.md': '# plan',
        'review-01.codex.json': '{ not json'
      }
    );
    const loaded = loadRun(runDir);
    assert.equal(loaded.model?.review.latestReadable, false);
    assert.ok(loaded.diagnostics.some((d) => d.code === 'review-parse-error'));
  });
});

describe('discoverRuns (disk IO)', () => {
  it('discovers and groups runs by status', () => {
    makeRun(
      'RUN_DONE',
      { status: 'complete' },
      {
        'accepted-spec.md': '# spec',
        'accepted-plan.md': '# plan',
        'review-01.codex.json': JSON.stringify({ verdict: 'pass', findings: [] })
      }
    );
    makeRun('RUN_ARCH', { status: 'archived' });
    const runs = discoverRuns(root);
    assert.ok(runs.length >= 3);
    assert.ok(runsInGroup(runs, 'completed').some((r) => r.runId === 'RUN_DONE'));
    assert.ok(runsInGroup(runs, 'archived').some((r) => r.runId === 'RUN_ARCH'));
  });

  it('returns an empty list for a non-existent state home', () => {
    assert.deepEqual(discoverRuns(join(root, 'does-not-exist')), []);
  });

  it('maps statuses to the right group', () => {
    assert.equal(groupForStatus('active'), 'active');
    assert.equal(groupForStatus('complete'), 'completed');
    assert.equal(groupForStatus('complete_with_followups'), 'completed');
    assert.equal(groupForStatus('blocked'), 'completed');
    assert.equal(groupForStatus('archived'), 'archived');
  });
});

describe('loadEventLog (disk IO)', () => {
  it('reports exists=false when there is no events.jsonl', () => {
    const runDir = makeRun('RUN_NOEVENTS', {}, { 'accepted-spec.md': '# spec' });
    const log = loadEventLog(runDir);
    assert.equal(log.exists, false);
    assert.equal(log.events.length, 0);
  });

  it('parses an events.jsonl and reconstructs a timeline', () => {
    const event = (sequence: number, type: string, payload: Record<string, unknown> = {}): string =>
      JSON.stringify({
        schemaVersion: 1,
        sequence,
        timestamp: '2026-06-12T20:13:23Z',
        runId: 'RUN_EV',
        repositoryId: 'repo1',
        phase: 'implementing',
        source: 'controller',
        type,
        payload
      });
    const runDir = makeRun(
      'RUN_EV',
      {},
      {
        'events.jsonl':
          [
            event(1, 'run.created', { label: 'demo' }),
            event(2, 'phase.started', { phase: 'implementing' })
          ].join('\n') + '\n'
      }
    );
    const log = loadEventLog(runDir);
    assert.equal(log.exists, true);
    assert.equal(log.events.length, 2);
    assert.equal(log.timeline[0]?.summary, 'Run created (demo)');
  });
});
