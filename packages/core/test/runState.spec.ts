import assert from 'node:assert/strict';
import { MALFORMED_ENTRY_MARKER, normalizeStatus, parseRunStateText } from '../src/runState';

function stateText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 2,
    run_id: '20260612T201323Z-96954900',
    status: 'active',
    phase: 'implementing',
    feature: 'demo feature',
    repository: { id: '8dd906752e640877', worktree_path: '/repo', worktree_mode: 'isolated' },
    max_review_rounds: 3,
    review_round: 1,
    artifacts: { accepted_spec: 'accepted-spec.md', enhance: 'feature-spec.codex.json' },
    verification: {
      passed: false,
      checks: [{ name: 'unit', command: ['npm', 'test'], exit_code: 0 }]
    },
    reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }],
    risk: { requires_adversarial_review: true, reasons: ['security-sensitive'] },
    ...overrides
  });
}

describe('parseRunStateText (tolerant, REFERENCE §3)', () => {
  it('parses a well-formed schema_version 2 state', () => {
    const { state, diagnostics } = parseRunStateText(stateText());
    assert.ok(state);
    assert.equal(diagnostics.length, 0);
    assert.equal(state?.runId, '20260612T201323Z-96954900');
    assert.equal(state?.status, 'active');
    assert.equal(state?.schemaVersion, 2);
    assert.equal(state?.artifacts.acceptedSpec, 'accepted-spec.md');
    assert.equal(state?.risk.requiresAdversarialReview, true);
    assert.equal(state?.repository.worktreeMode, 'isolated');
    assert.equal(state?.verification.checks.length, 1);
    assert.equal(state?.reviews[0]?.verdict, 'pass');
  });

  it('returns a parse-error diagnostic and no state on invalid JSON', () => {
    const { state, diagnostics } = parseRunStateText('{ not json');
    assert.equal(state, undefined);
    assert.ok(
      diagnostics.some((d) => d.code === 'run-state-parse-error' && d.severity === 'error')
    );
  });

  it('rejects a non-object payload', () => {
    const { state, diagnostics } = parseRunStateText('[]');
    assert.equal(state, undefined);
    assert.ok(diagnostics.some((d) => d.code === 'run-state-not-object'));
  });

  it('requires a string run_id', () => {
    const { state, diagnostics } = parseRunStateText(JSON.stringify({ status: 'active' }));
    assert.equal(state, undefined);
    assert.ok(diagnostics.some((d) => d.code === 'run-state-missing-run-id'));
  });

  it('tolerates a missing status (warns, normalizes to unknown)', () => {
    const text = JSON.stringify({ run_id: 'r1' });
    const { state, diagnostics } = parseRunStateText(text);
    assert.ok(state);
    assert.equal(state?.status, 'unknown');
    assert.ok(diagnostics.some((d) => d.code === 'run-state-missing-status'));
  });

  it('accepts legacy schema "version": 1', () => {
    const { state, diagnostics } = parseRunStateText(
      JSON.stringify({ version: 1, run_id: 'r1', status: 'active' })
    );
    assert.equal(state?.schemaVersion, 1);
    assert.ok(!diagnostics.some((d) => d.code === 'run-state-unsupported-schema-version'));
  });

  it('warns on an unsupported schema version but still parses', () => {
    const { state, diagnostics } = parseRunStateText(
      JSON.stringify({ schema_version: 99, run_id: 'r1', status: 'active' })
    );
    assert.ok(state);
    assert.ok(diagnostics.some((d) => d.code === 'run-state-unsupported-schema-version'));
  });

  it('warns on an unrecognized status', () => {
    const { state, diagnostics } = parseRunStateText(
      JSON.stringify({ run_id: 'r1', status: 'frobnicating' })
    );
    assert.equal(state?.status, 'unknown');
    assert.equal(state?.rawStatus, 'frobnicating');
    assert.ok(diagnostics.some((d) => d.code === 'run-state-unknown-status'));
  });

  it('clamps max_review_rounds into 1..5 and floors review_round at 0', () => {
    const { state } = parseRunStateText(stateText({ max_review_rounds: 99, review_round: -4 }));
    assert.equal(state?.maxReviewRounds, 5);
    assert.equal(state?.reviewRound, 0);
  });

  it('normalizes a string command to a single-element array', () => {
    const { state } = parseRunStateText(
      stateText({ verification: { checks: [{ name: 'x', command: 'make test', exit_code: 0 }] } })
    );
    assert.deepEqual(state?.verification.checks[0]?.command, ['make test']);
  });

  it('preserves the raw object for forward compatibility', () => {
    const { state } = parseRunStateText(stateText({ futureField: { nested: true } }));
    assert.deepEqual((state?.raw as Record<string, unknown>)['futureField'], { nested: true });
  });

  it('redacts credentials in a remote_display before it enters the model (F-303)', () => {
    const { state } = parseRunStateText(
      stateText({
        repository: {
          id: '8dd906752e640877',
          remote_display: 'https://alice:s3cr3t@github.com/acme/repo.git'
        }
      })
    );
    assert.equal(state?.repository.remoteDisplay, 'https://<redacted>@github.com/acme/repo.git');
  });
});

describe('parseRunStateText cumulative ledgers + mode + checkpoints (run-state v0.3.0)', () => {
  // A realistic schema_version 2 fixture mirroring controller output shapes.
  function richState(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schema_version: 2,
      run_id: '20260614T101010Z-deadbeef',
      status: 'active',
      phase: 'review',
      feature: 'add billing webhook idempotency',
      repository: { id: 'abc123', worktree_path: '/repo', worktree_mode: 'current' },
      requested_mode: 'auto',
      effective_mode: 'rigorous',
      mode_reasons: ['auto escalated to rigorous: detected billing'],
      max_review_rounds: 3,
      review_round: 2,
      artifacts: { accepted_spec: 'accepted-spec.md', enhance: 'feature-spec.codex.json' },
      verification: { passed: true, checks: [{ name: 'unit', command: ['t'], exit_code: 0 }] },
      reviews: [
        { round: 1, path: 'review-01.codex.json', verdict: 'changes_required', delta: false },
        {
          round: 2,
          path: 'review-02.codex.json',
          verdict: 'pass',
          delta: true,
          checkpoint: {
            id: 'review-02',
            captured_at: '2026-06-14T10:00:00Z',
            head_commit: 'cafe1234',
            branch: 'feature/x',
            baseline_commit: 'base0000',
            changed_paths: ['src/a.ts', 'src/b.ts'],
            path_fingerprints: {
              'src/a.ts': 'sha256:aaaa',
              'src/b.ts': null
            },
            previous_checkpoint_id: 'review-01',
            review_context_mode: 'focused_full_fallback'
          }
        }
      ],
      adversarial_reviews: [],
      cumulative_findings: [
        {
          id: 'F-1',
          severity: 'critical',
          category: 'security',
          status: 'open',
          round: 1,
          round_opened: 1,
          round_last_seen: 2,
          origin: 'full',
          file: 'src/a.ts',
          line_start: 42,
          description: 'unauthenticated webhook accepted',
          evidence: 'no signature check',
          recommended_fix: 'verify HMAC',
          model_specific_extra: 'preserved'
        },
        {
          id: 'F-2',
          severity: 'high',
          category: 'correctness',
          status: 'resolved',
          round: 1,
          round_opened: 1,
          round_last_seen: 2,
          origin: 'delta',
          file: null,
          line_start: null,
          description: 'duplicate processing',
          evidence: 'no idempotency key',
          recommended_fix: 'dedupe',
          resolved_at_round: 2,
          resolution_source: 'review-02'
        }
      ],
      cumulative_acceptance_criteria: [
        { id: 'AC-1', status: 'satisfied', evidence: 'covered by test', round: 2 },
        { id: 'AC-2', status: 'not_satisfied', evidence: 'missing', round: 2 }
      ],
      review_ledger: [
        {
          fingerprint: 'fp-abc',
          status: 'rejected_with_evidence',
          finding_id: 'F-3',
          resolution: 'not a real issue',
          reason: 'guarded upstream',
          ledger_extra: 'kept'
        }
      ],
      codex_runs: [
        {
          phase: 'review',
          prompt_characters: 1200,
          output_characters: 3400,
          duration_seconds: 12.5,
          model: 'gpt-x',
          reasoning_effort: 'high',
          verbosity: 'low',
          started_at: '2026-06-14T09:59:00Z',
          events_artifact: 'review-02.events.ndjson',
          output_artifact: 'review-02.codex.json',
          session_resume_capability: 'unsupported',
          session_fallback: false,
          tokens: { input_tokens: 100, output_tokens: 200, total_tokens: 300 }
        }
      ],
      risk: { requires_adversarial_review: true, reasons: ['rigorous mode selected'] },
      ...overrides
    });
  }

  it('parses requested/effective mode and mode reasons', () => {
    const { state } = parseRunStateText(richState());
    assert.equal(state?.requestedMode, 'auto');
    assert.equal(state?.effectiveMode, 'rigorous');
    assert.deepEqual(state?.modeReasons, ['auto escalated to rigorous: detected billing']);
    assert.equal(state?.repository.worktreeMode, 'current');
  });

  it('parses cumulative findings with full provenance + preserves unknown sub-fields', () => {
    const { state } = parseRunStateText(richState());
    assert.equal(state?.cumulativeFindings.length, 2);
    const f1 = state?.cumulativeFindings[0];
    assert.equal(f1?.id, 'F-1');
    assert.equal(f1?.severity, 'critical');
    assert.equal(f1?.status, 'open');
    assert.equal(f1?.roundOpened, 1);
    assert.equal(f1?.roundLastSeen, 2);
    assert.equal(f1?.origin, 'full');
    assert.equal(f1?.file, 'src/a.ts');
    assert.equal(f1?.lineStart, 42);
    assert.equal(f1?.raw['model_specific_extra'], 'preserved');
    const f2 = state?.cumulativeFindings[1];
    assert.equal(f2?.status, 'resolved');
    assert.equal(f2?.resolvedAtRound, 2);
    assert.equal(f2?.resolutionSource, 'review-02');
    assert.equal(f2?.file, null);
    assert.equal(f2?.lineStart, null);
  });

  it('parses cumulative acceptance criteria', () => {
    const { state } = parseRunStateText(richState());
    assert.equal(state?.cumulativeAcceptanceCriteria.length, 2);
    assert.equal(state?.cumulativeAcceptanceCriteria[0]?.id, 'AC-1');
    assert.equal(state?.cumulativeAcceptanceCriteria[0]?.status, 'satisfied');
    assert.equal(state?.cumulativeAcceptanceCriteria[1]?.status, 'not_satisfied');
  });

  it('parses the review ledger keyed by fingerprint + preserves unknown sub-fields', () => {
    const { state } = parseRunStateText(richState());
    assert.equal(state?.reviewLedger.length, 1);
    const entry = state?.reviewLedger[0];
    assert.equal(entry?.fingerprint, 'fp-abc');
    assert.equal(entry?.status, 'rejected_with_evidence');
    assert.equal(entry?.findingId, 'F-3');
    assert.equal(entry?.raw['ledger_extra'], 'kept');
  });

  it('parses codex runs including token usage', () => {
    const { state } = parseRunStateText(richState());
    assert.equal(state?.codexRuns.length, 1);
    const run = state?.codexRuns[0];
    assert.equal(run?.phase, 'review');
    assert.equal(run?.promptCharacters, 1200);
    assert.equal(run?.durationSeconds, 12.5);
    assert.equal(run?.tokens?.totalTokens, 300);
    assert.equal(run?.sessionResumeCapability, 'unsupported');
    assert.equal(run?.sessionFallback, false);
  });

  it('parses supported Codex session resume capability', () => {
    const { state } = parseRunStateText(
      richState({
        codex_runs: [{ phase: 'review', session_resume_capability: 'supported' }]
      })
    );
    assert.equal(state?.codexRuns[0]?.sessionResumeCapability, 'supported');
  });

  it('parses review delta flag and the latest checkpoint', () => {
    const { state } = parseRunStateText(richState());
    assert.equal(state?.reviews[0]?.delta, false);
    assert.equal(state?.reviews[1]?.delta, true);
    const cp = state?.reviews[1]?.checkpoint;
    assert.equal(cp?.id, 'review-02');
    assert.equal(cp?.reviewContextMode, 'focused_full_fallback');
    assert.deepEqual(cp?.changedPaths, ['src/a.ts', 'src/b.ts']);
    assert.equal(cp?.pathFingerprints['src/a.ts'], 'sha256:aaaa');
    assert.equal(cp?.pathFingerprints['src/b.ts'], null);
    assert.equal(cp?.previousCheckpointId, 'review-01');
  });

  it('fails closed on a non-array cumulative_findings (malformed sentinel, no throw)', () => {
    const { state, diagnostics } = parseRunStateText(richState({ cumulative_findings: 'oops' }));
    assert.ok(state);
    // A present-but-non-array ledger container is corrupt; mirror the controller's
    // fail-closed scan by emitting a single malformed sentinel that blocks the gate.
    assert.equal(state?.cumulativeFindings.length, 1);
    assert.equal(state?.cumulativeFindings[0]?.raw[MALFORMED_ENTRY_MARKER], true);
    assert.ok(!diagnostics.some((d) => d.severity === 'error'));
    assert.ok(
      diagnostics.some((d) => d.code === 'run-state-malformed-cumulative-findings'),
      'expected a malformed-container diagnostic'
    );
  });

  it('fails closed on a non-array cumulative_acceptance_criteria (malformed sentinel)', () => {
    const { state, diagnostics } = parseRunStateText(
      richState({ cumulative_acceptance_criteria: 'oops' })
    );
    assert.ok(state);
    assert.equal(state?.cumulativeAcceptanceCriteria.length, 1);
    assert.equal(
      (state?.cumulativeAcceptanceCriteria[0] as { raw: Record<string, unknown> }).raw[
        MALFORMED_ENTRY_MARKER
      ],
      true
    );
    assert.ok(!diagnostics.some((d) => d.severity === 'error'));
    assert.ok(
      diagnostics.some((d) => d.code === 'run-state-malformed-acceptance-criteria'),
      'expected a malformed-container diagnostic'
    );
  });

  it('fails closed even on a falsy non-array container (empty string), the safe direction', () => {
    // The controller would iterate a "" container zero times (incidentally not
    // blocking). We deliberately fail closed instead: an empty-string ledger is
    // corrupt, and the mission mandates fail-closed on malformed state.
    const { state } = parseRunStateText(richState({ cumulative_findings: '' }));
    assert.equal(state?.cumulativeFindings.length, 1);
    assert.equal(state?.cumulativeFindings[0]?.raw[MALFORMED_ENTRY_MARKER], true);
  });

  it('preserves a non-object cumulative finding entry with a malformed marker (fail closed)', () => {
    const { state } = parseRunStateText(
      richState({ cumulative_findings: [42, { id: 'F-1', severity: 'high', status: 'open' }] })
    );
    assert.equal(state?.cumulativeFindings.length, 2);
    // The non-object entry keeps the marker so downstream fail-closed logic sees it.
    assert.equal(state?.cumulativeFindings[0]?.raw[MALFORMED_ENTRY_MARKER], true);
    assert.equal(state?.cumulativeFindings[1]?.id, 'F-1');
  });

  it('tolerates a non-array acceptance criteria + flags non-object entries', () => {
    const { state } = parseRunStateText(
      richState({ cumulative_acceptance_criteria: [null, { id: 'AC-1', status: 'satisfied' }] })
    );
    assert.equal(state?.cumulativeAcceptanceCriteria.length, 2);
    assert.equal(
      (state?.cumulativeAcceptanceCriteria[0] as Record<string, unknown>)['raw'] !== undefined,
      true
    );
    assert.equal(state?.cumulativeAcceptanceCriteria[1]?.id, 'AC-1');
  });

  it('defaults all new collections to empty when absent', () => {
    const { state } = parseRunStateText(
      JSON.stringify({ schema_version: 2, run_id: 'r1', status: 'active' })
    );
    assert.deepEqual(state?.cumulativeFindings, []);
    assert.deepEqual(state?.cumulativeAcceptanceCriteria, []);
    assert.deepEqual(state?.reviewLedger, []);
    assert.deepEqual(state?.codexRuns, []);
    assert.deepEqual(state?.modeReasons, []);
    assert.equal(state?.effectiveMode, undefined);
  });
});

describe('normalizeStatus', () => {
  it('maps known and aliased statuses', () => {
    assert.equal(normalizeStatus('ACTIVE'), 'active');
    assert.equal(normalizeStatus('completed'), 'complete');
    assert.equal(normalizeStatus('complete_with_followups'), 'complete_with_followups');
    assert.equal(normalizeStatus('canceled'), 'cancelled');
    assert.equal(normalizeStatus('archived'), 'archived');
    assert.equal(normalizeStatus('blocked'), 'blocked');
  });
  it('maps anything else to unknown', () => {
    assert.equal(normalizeStatus('weird'), 'unknown');
  });
  it('does not coerce running/in_progress to active (controller never writes them; fail closed)', () => {
    // The controller treats only the exact string "active" as active and never
    // emits running/in_progress, so these must NOT masquerade as active.
    assert.equal(normalizeStatus('running'), 'unknown');
    assert.equal(normalizeStatus('in_progress'), 'unknown');
  });
});

describe('completion disposition normalization', () => {
  it('preserves authoritative completion and follow-up metadata', () => {
    const { state } = parseRunStateText(
      JSON.stringify({
        schema_version: 2,
        run_id: 'r-followups',
        status: 'complete_with_followups',
        phase: 'complete_with_followups',
        awaiting_human_decision_phase: 'adversarial',
        artifacts: {
          follow_ups_json: 'follow-ups.json',
          follow_ups_markdown: 'follow-ups.md'
        },
        completion_evaluation: {
          result: 'ready_with_followups',
          source_review_round: 3,
          source_adversarial_round: 1,
          findings: [
            {
              source_phase: 'adversarial',
              source_round: 8,
              source_id: 'A-8-T-1',
              title: 'Crash recovery',
              disposition: 'FIX_LATER',
              relevant_acceptance_criteria: ['AC-1'],
              relevant_files: ['db.py'],
              recommended_verification: ['crash test']
            }
          ]
        }
      })
    );
    assert.equal(state?.status, 'complete_with_followups');
    assert.equal(state?.artifacts.followUpsJson, 'follow-ups.json');
    assert.equal(state?.completionEvaluation?.result, 'ready_with_followups');
    assert.equal(state?.completionEvaluation?.findings[0]?.disposition, 'FIX_LATER');
    assert.deepEqual(state?.completionEvaluation?.findings[0]?.relevantFiles, ['db.py']);
    assert.equal(state?.awaitingHumanDecisionPhase, 'adversarial');
  });
});
