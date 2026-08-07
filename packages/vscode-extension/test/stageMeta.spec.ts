import assert from 'node:assert/strict';

import type { CodexRun, DiscoveredRun } from '@semanticmatter/core';

import { stageMetaFor } from '../src/dashboard/renderModel';

function makeRun(rawState: Record<string, unknown>): DiscoveredRun {
  return {
    runId: 'RID',
    repoId: 'repo',
    runDir: '/x',
    group: 'active',
    diagnostics: [],
    state: {
      schemaVersion: 2,
      runId: 'RID',
      feature: '',
      status: 'active',
      rawStatus: 'active',
      phase: 'implementing',
      repository: { id: 'repo' },
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

describe('stageMetaFor — Codex phases from config_snapshot', () => {
  it('plan-proposed shows profile-model + reasoning effort from snapshot', () => {
    const run = makeRun({
      config_snapshot: {
        codex: {
          plan: {
            profile: 'azure-gpt5p6-sol',
            reasoning_effort: 'high'
          }
        }
      }
    });
    const meta = stageMetaFor('plan-proposed', run, []);
    // No concrete model in snapshot → fall back to profile id as the display.
    assert.equal(meta.line, 'azure-gpt5p6-sol · High');
    assert.equal(meta.tooltip, 'Profile: azure-gpt5p6-sol');
  });

  it('independent-review reads from snapshot codex.review', () => {
    const run = makeRun({
      config_snapshot: {
        codex: {
          review: { profile: 'azure-gpt5p6-sol', reasoning_effort: 'xhigh' }
        }
      }
    });
    const meta = stageMetaFor('independent-review', run, []);
    assert.equal(meta.line, 'azure-gpt5p6-sol · XHigh');
  });

  it('adversarial-review reads from snapshot codex.adversarial', () => {
    const run = makeRun({
      config_snapshot: {
        codex: {
          adversarial: { profile: 'p', reasoning_effort: 'medium' }
        }
      }
    });
    const meta = stageMetaFor('adversarial-review', run, []);
    assert.equal(meta.line, 'p · Medium');
  });

  it('idea-enhanced reads from snapshot codex.enhance', () => {
    const run = makeRun({
      config_snapshot: {
        codex: {
          enhance: { profile: 'e', reasoning_effort: 'minimal' }
        }
      }
    });
    const meta = stageMetaFor('idea-enhanced', run, []);
    assert.equal(meta.line, 'e · Minimal');
  });
});

describe('stageMetaFor — concrete Codex telemetry wins over snapshot', () => {
  it('uses codex_runs telemetry model when present', () => {
    const run = makeRun({
      config_snapshot: {
        codex: {
          plan: { profile: 'azure-gpt5p6-sol', reasoning_effort: 'high' }
        }
      }
    });
    const codexRuns: CodexRun[] = [
      { phase: 'plan', model: 'gpt-5.6-sol-2025-08-06', reasoningEffort: 'high' }
    ];
    const meta = stageMetaFor('plan-proposed', run, codexRuns);
    // Concrete model wins as the display value.
    assert.equal(meta.line, 'gpt-5.6-sol-2025-08-06 · High');
    // Profile id is still available as tooltip.
    assert.equal(meta.tooltip, 'Profile: azure-gpt5p6-sol');
  });
});

describe('stageMetaFor — Claude runtime on Implementing', () => {
  it('shows the snapshotted Claude runtime name for implementing', () => {
    const run = makeRun({
      config_snapshot: { codex: {}, claude_runtime: 'foundry-claude' }
    });
    const meta = stageMetaFor('implementing', run, []);
    assert.equal(meta.line, 'foundry-claude');
  });
  it('does not invent a runtime when snapshot omits claude_runtime', () => {
    const run = makeRun({ config_snapshot: { codex: {} } });
    const meta = stageMetaFor('implementing', run, []);
    assert.deepEqual(meta, {});
  });
});

describe('stageMetaFor — legacy runs (no config_snapshot)', () => {
  it('emits "configuration unavailable" for a Codex stage on a legacy run', () => {
    const run = makeRun({});
    const meta = stageMetaFor('plan-proposed', run, []);
    assert.equal(meta.line, 'configuration unavailable');
    assert.equal(meta.tooltip, undefined);
  });
  it('emits nothing for the implementing stage on a legacy run', () => {
    const run = makeRun({});
    const meta = stageMetaFor('implementing', run, []);
    assert.deepEqual(meta, {});
  });
});

describe('stageMetaFor — stages without a Codex mapping', () => {
  it('returns empty for spec-accepted / triage / verification (not Codex-owned)', () => {
    const run = makeRun({ config_snapshot: { codex: {} } });
    assert.deepEqual(stageMetaFor('spec-accepted', run, []), {});
    assert.deepEqual(stageMetaFor('triage', run, []), {});
    assert.deepEqual(stageMetaFor('verification', run, []), {});
  });
});
