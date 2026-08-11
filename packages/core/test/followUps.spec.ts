import assert from 'node:assert/strict';

import { parseFollowUpsText } from '../src/followUps';

describe('parseFollowUpsText', () => {
  it('preserves compact provenance needed to start a future run', () => {
    const parsed = parseFollowUpsText(
      JSON.stringify({
        source_run_id: 'R1',
        follow_ups: [
          {
            id: 'FU-001',
            title: 'Crash recovery',
            source_phase: 'adversarial',
            source_round: 8,
            original_finding_id: 'A-8-T-2',
            severity: 'medium',
            category: 'data_loss',
            why_deferred: 'Additional hardening',
            relevant_acceptance_criteria: ['AC-1'],
            relevant_files: ['db.py'],
            recommended_verification: ['crash injection'],
            provenance: 'adversarial-08#2'
          }
        ]
      })
    );
    assert.equal(parsed.sourceRunId, 'R1');
    assert.equal(parsed.followUps[0]?.id, 'FU-001');
    assert.equal(parsed.followUps[0]?.originalFindingId, 'A-8-T-2');
    assert.equal(parsed.followUps[0]?.provenance, 'adversarial-08#2');
  });

  it('fails tolerant on malformed legacy/missing artifacts', () => {
    assert.deepEqual(parseFollowUpsText('{bad'), { followUps: [] });
  });
});
