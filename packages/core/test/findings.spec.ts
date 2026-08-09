import assert from 'node:assert/strict';
import { parseRunStateText } from '../src/runState';
import type { RunState } from '../src/types';
import {
  blockingAcceptanceCriteria,
  cumulativeUnresolvedSevere,
  describeBlockingAcceptanceCriteria,
  describeBlockingFindings,
  isFindingResolved,
  isSevereCumulativeFinding
} from '../src/workflow/findings';

/** Build a RunState carrying the given cumulative ledgers (mirrors controller output). */
function stateWith(overrides: Record<string, unknown>): RunState {
  const text = JSON.stringify({
    schema_version: 2,
    run_id: 'R1',
    status: 'active',
    feature: 'demo',
    repository: { id: 'repo1' },
    risk: { requires_adversarial_review: false, reasons: [] },
    ...overrides
  });
  const { state } = parseRunStateText(text);
  if (!state) {
    throw new Error('fixture failed to parse');
  }
  return state;
}

describe('cumulativeUnresolvedSevere (controller.py parity, ~1135-1153)', () => {
  it('an open critical finding blocks', () => {
    const state = stateWith({
      cumulative_findings: [
        { id: 'F-1', severity: 'critical', status: 'open', category: 'security' }
      ]
    });
    const severe = cumulativeUnresolvedSevere(state);
    assert.equal(severe.length, 1);
    assert.equal(severe[0]?.id, 'F-1');
  });

  it('an open high finding blocks', () => {
    const state = stateWith({
      cumulative_findings: [{ id: 'F-1', severity: 'high', status: 'open' }]
    });
    assert.equal(cumulativeUnresolvedSevere(state).length, 1);
  });

  it('a resolved critical finding does NOT block', () => {
    const state = stateWith({
      cumulative_findings: [{ id: 'F-1', severity: 'critical', status: 'resolved' }]
    });
    assert.deepEqual(cumulativeUnresolvedSevere(state), []);
  });

  it('a stale resolved critical finding needs reassessment and blocks', () => {
    const state = stateWith({
      cumulative_findings: [
        {
          id: 'F-1',
          severity: 'critical',
          status: 'resolved',
          assessment_state: 'needs_reassessment'
        }
      ]
    });
    assert.equal(cumulativeUnresolvedSevere(state).length, 1);
  });

  it('a non-blocking triage status (rejected_with_evidence) does NOT block', () => {
    const state = stateWith({
      cumulative_findings: [{ id: 'F-1', severity: 'critical', status: 'rejected_with_evidence' }]
    });
    assert.deepEqual(cumulativeUnresolvedSevere(state), []);
  });

  it('every non-blocking triage status releases a severe finding', () => {
    for (const status of [
      'rejected',
      'rejected_with_evidence',
      'already_resolved',
      'out_of_scope_but_recorded',
      'resolved'
    ]) {
      const state = stateWith({
        cumulative_findings: [{ id: 'F-1', severity: 'critical', status }]
      });
      assert.deepEqual(cumulativeUnresolvedSevere(state), [], `status ${status} should release`);
    }
  });

  it('a blocking triage status (requires_human_decision) still blocks (fail closed)', () => {
    const state = stateWith({
      cumulative_findings: [{ id: 'F-1', severity: 'critical', status: 'requires_human_decision' }]
    });
    assert.equal(cumulativeUnresolvedSevere(state).length, 1);
  });

  it('a severe finding with a missing status blocks (fail closed)', () => {
    // {"id":"F-1","severity":"critical"} — no status must NOT be read as released.
    const state = stateWith({ cumulative_findings: [{ id: 'F-1', severity: 'critical' }] });
    assert.equal(cumulativeUnresolvedSevere(state).length, 1);
  });

  it('a severe finding with an unknown severity blocks (fail closed)', () => {
    const state = stateWith({ cumulative_findings: [{ id: 'F-1', status: 'open' }] });
    assert.equal(cumulativeUnresolvedSevere(state).length, 1);
  });

  it('a non-object ledger entry counts as blocking (fail closed)', () => {
    const state = stateWith({ cumulative_findings: ['not-a-dict'] });
    assert.equal(cumulativeUnresolvedSevere(state).length, 1);
  });

  it('a non-array ledger CONTAINER counts as blocking (fail closed, controller scan parity)', () => {
    // The controller scans a truthy-but-malformed ledger container and flags it.
    // A corrupt container must not read as "no findings".
    const state = stateWith({ cumulative_findings: 'corrupt' });
    assert.equal(cumulativeUnresolvedSevere(state).length, 1);
  });

  it('medium and low severities are never severe', () => {
    const state = stateWith({
      cumulative_findings: [
        { id: 'F-1', severity: 'medium', status: 'open' },
        { id: 'F-2', severity: 'low', status: 'open' }
      ]
    });
    assert.deepEqual(cumulativeUnresolvedSevere(state), []);
    assert.equal(isSevereCumulativeFinding({ severity: 'medium', raw: {} }), false);
    assert.equal(isSevereCumulativeFinding({ severity: 'low', raw: {} }), false);
    assert.equal(isSevereCumulativeFinding({ severity: 'critical', raw: {} }), true);
    assert.equal(isSevereCumulativeFinding({ raw: {} }), true);
  });

  it('isFindingResolved is true for a released finding, false for malformed', () => {
    const state = stateWith({
      cumulative_findings: [{ id: 'F-1', severity: 'critical', status: 'resolved' }, 99]
    });
    assert.equal(isFindingResolved(state.cumulativeFindings[0]!), true);
    assert.equal(isFindingResolved(state.cumulativeFindings[1]!), false);
  });
});

describe('blockingAcceptanceCriteria (controller.py parity, ~1163-1172)', () => {
  it('all four non-satisfied statuses block', () => {
    for (const status of [
      'not_satisfied',
      'partially_satisfied',
      'not_verifiable',
      'something_unknown'
    ]) {
      const state = stateWith({ cumulative_acceptance_criteria: [{ id: 'AC-1', status }] });
      assert.equal(blockingAcceptanceCriteria(state).length, 1, `status ${status} should block`);
    }
  });

  it('satisfied does not block', () => {
    const state = stateWith({
      cumulative_acceptance_criteria: [{ id: 'AC-1', status: 'satisfied' }]
    });
    assert.deepEqual(blockingAcceptanceCriteria(state), []);
  });

  it('a stale satisfied criterion needs reassessment and blocks', () => {
    const state = stateWith({
      cumulative_acceptance_criteria: [
        { id: 'AC-1', status: 'satisfied', assessment_state: 'needs_reassessment' }
      ]
    });
    assert.equal(blockingAcceptanceCriteria(state).length, 1);
  });

  it('a missing status blocks (fail closed)', () => {
    const state = stateWith({ cumulative_acceptance_criteria: [{ id: 'AC-1' }] });
    assert.equal(blockingAcceptanceCriteria(state).length, 1);
  });

  it('a non-object entry blocks (fail closed)', () => {
    const state = stateWith({ cumulative_acceptance_criteria: ['oops'] });
    assert.equal(blockingAcceptanceCriteria(state).length, 1);
  });

  it('a non-array CONTAINER blocks (fail closed, controller scan parity)', () => {
    const state = stateWith({ cumulative_acceptance_criteria: 'corrupt' });
    assert.equal(blockingAcceptanceCriteria(state).length, 1);
  });

  it('counts only the unsatisfied ones when mixed', () => {
    const state = stateWith({
      cumulative_acceptance_criteria: [
        { id: 'AC-1', status: 'satisfied' },
        { id: 'AC-2', status: 'not_satisfied' },
        { id: 'AC-3', status: 'partially_satisfied' }
      ]
    });
    assert.deepEqual(
      blockingAcceptanceCriteria(state).map((c) => c.id),
      ['AC-2', 'AC-3']
    );
  });
});

describe('describeBlockingFindings (controller.py _describe_blocking_findings)', () => {
  it('formats id [severity/category] with a description snippet', () => {
    const state = stateWith({
      cumulative_findings: [
        {
          id: 'F-1',
          severity: 'critical',
          category: 'security',
          status: 'open',
          description: 'unauthenticated webhook accepted'
        }
      ]
    });
    assert.equal(
      describeBlockingFindings(cumulativeUnresolvedSevere(state)),
      'F-1 [critical/security] unauthenticated webhook accepted'
    );
  });

  it('truncates a long description to <=80 chars with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const state = stateWith({
      cumulative_findings: [{ id: 'F-1', severity: 'high', status: 'open', description: long }]
    });
    const out = describeBlockingFindings(cumulativeUnresolvedSevere(state));
    // 79 chars of body + ellipsis, after the "F-1 [high] " label.
    assert.ok(out.endsWith('…'));
    assert.ok(out.includes('F-1 [high] '));
    const body = out.slice('F-1 [high] '.length);
    assert.equal(body.length, 80); // 79 chars + the ellipsis glyph
  });

  it('omits the category fragment when absent and renders (malformed) for non-objects', () => {
    const state = stateWith({
      cumulative_findings: [{ id: 'F-1', severity: 'high', status: 'open' }, 42]
    });
    const out = describeBlockingFindings(cumulativeUnresolvedSevere(state));
    assert.ok(out.includes('F-1 [high]'));
    assert.ok(out.includes('(malformed)'));
  });

  it('caps the list at 5 and appends a (+N more) suffix', () => {
    const findings = Array.from({ length: 7 }, (_, i) => ({
      id: `F-${i + 1}`,
      severity: 'critical',
      status: 'open'
    }));
    const state = stateWith({ cumulative_findings: findings });
    const out = describeBlockingFindings(cumulativeUnresolvedSevere(state));
    assert.ok(out.endsWith('(+2 more)'));
  });
});

describe('describeBlockingAcceptanceCriteria (controller.py parity)', () => {
  it('formats id [status]', () => {
    const state = stateWith({
      cumulative_acceptance_criteria: [
        { id: 'AC-1', status: 'not_satisfied' },
        { id: 'AC-2', status: 'partially_satisfied' }
      ]
    });
    assert.equal(
      describeBlockingAcceptanceCriteria(blockingAcceptanceCriteria(state)),
      'AC-1 [not_satisfied]; AC-2 [partially_satisfied]'
    );
  });

  it('renders the malformed sentinel for a non-object entry', () => {
    const state = stateWith({ cumulative_acceptance_criteria: ['oops'] });
    assert.equal(
      describeBlockingAcceptanceCriteria(blockingAcceptanceCriteria(state)),
      '(malformed) [(unknown)]'
    );
  });
});
