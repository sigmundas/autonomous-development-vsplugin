/**
 * Programmatic fixtures: write a throwaway state home covering every run
 * lifecycle the dashboard must render. Used by the VS Code integration tests so
 * discovery, grouping, model derivation, and artifact opening run against real
 * on-disk layouts (REFERENCE.md §2–§3) without any network or controller.
 *
 * snake_case is deliberate — these files mirror what quaat/autonomous-development
 * actually writes; core normalizes them to the camelCase domain types.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type Scenario =
  | 'initialized'
  | 'currentCheckout'
  | 'implementing'
  | 'verificationFailed'
  | 'changesRequired'
  | 'adversarialRequired'
  | 'complete'
  | 'blocked'
  | 'cancelled'
  | 'archived'
  | 'malformed'
  | 'cumulativeLedger'
  | 'enhanceRigorous';

export interface Fixtures {
  /** Resolved state home (`<root>/state`), to point `autonomousDev.stateHome` at. */
  readonly stateHome: string;
  /** A repo root holding a legacy in-repo `.ai/autonomous-development` run. */
  readonly legacyRepoRoot: string;
  /** runId for each scenario (equal to the scenario key for easy assertions). */
  readonly runIds: Record<Scenario, string>;
  readonly repoId: string;
  /** Absolute path to a run directory. */
  runDir(runId: string): string;
  cleanup(): void;
}

const REPO_ID = 'demo-repo';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function passingReview(): string {
  return JSON.stringify({
    verdict: 'pass',
    confidence: 0.92,
    summary: 'No blocking issues found.',
    findings: [
      {
        id: 'F-LOW',
        severity: 'low',
        category: 'style',
        file: 'src/app.ts',
        line_start: 7,
        description: 'Nit.'
      }
    ]
  });
}

/** Write one run under `<stateHome>/repositories/<repoId>/runs/<runId>/`. */
function writeRun(
  stateHome: string,
  runId: string,
  state: Record<string, unknown> | string,
  files: Record<string, string> = {}
): void {
  const runDir = join(stateHome, 'repositories', REPO_ID, 'runs', runId);
  write(
    join(runDir, 'run-state.json'),
    typeof state === 'string' ? state : JSON.stringify(state, null, 2)
  );
  for (const [name, content] of Object.entries(files)) {
    write(join(runDir, name), content);
  }
}

function baseState(runId: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: runId,
    status: 'active',
    phase: 'initialized',
    feature: `Feature for ${runId}`,
    label: runId,
    created_at: '2026-06-12T10:00:00Z',
    updated_at: '2026-06-12T11:00:00Z',
    repository: {
      id: REPO_ID,
      display_name: 'Demo Repo',
      worktree_path: '/work/demo',
      worktree_mode: 'isolated'
    },
    max_review_rounds: 3,
    review_round: 0,
    artifacts: {},
    verification: { checks: [] },
    reviews: [],
    adversarial_reviews: [],
    risk: { requires_adversarial_review: false, reasons: [] },
    ...overrides
  };
}

const FEATURE_MD = '# Original feature\n\nBuild the thing.\n';
const ENHANCE_JSON = JSON.stringify({
  title: 'The thing',
  problem_statement: 'Users cannot do the thing.',
  functional_requirements: ['Render the thing', 'Persist the thing'],
  acceptance_criteria: [
    { id: 'AC-1', criterion: 'The thing renders' },
    { id: 'AC-2', criterion: 'The thing persists' }
  ],
  assumptions: ['a1'],
  open_questions: [],
  risks: ['It might break'],
  non_goals: ['Not rebuilding everything']
});
const SPEC_MD = '# Accepted specification\n\nThe thing, reconciled.\n';
const PLAN_JSON = JSON.stringify({
  summary: 'Implement the thing in three steps.',
  implementation_steps: ['Step one', 'Step two'],
  files_expected_to_change: ['src/app.ts', 'src/thing.ts'],
  test_strategy: { unit: 'cover the thing', integration: 'open the dashboard' },
  rollback_strategy: ['Revert the commit'],
  risks: ['Plan risk'],
  non_goals: ['No plan rewrite']
});
const PLAN_MD = '# Accepted plan\n\n1. Do s1\n2. Do s2\n';

const FULL_ARTIFACTS = {
  feature_request: 'feature-request.md',
  enhance: 'feature-spec.codex.json',
  accepted_spec: 'accepted-spec.md',
  plan: 'implementation-plan.codex.json',
  accepted_plan: 'accepted-plan.md'
};

const FULL_ARTIFACT_FILES: Record<string, string> = {
  'feature-request.md': FEATURE_MD,
  'feature-spec.codex.json': ENHANCE_JSON,
  'accepted-spec.md': SPEC_MD,
  'implementation-plan.codex.json': PLAN_JSON,
  'accepted-plan.md': PLAN_MD
};

function passingVerification(): Record<string, unknown> {
  return {
    passed: true,
    checks: [
      {
        name: 'unit',
        command: ['npm', 'test'],
        exit_code: 0,
        log: 'verification/unit.log',
        started_at: '2026-06-12T10:30:00Z',
        completed_at: '2026-06-12T10:31:00Z'
      }
    ]
  };
}

export function buildFixtures(): Fixtures {
  const root = mkdtempSync(join(tmpdir(), 'autodev-fixtures-'));
  const stateHome = join(root, 'state');

  // 1. initialized — created, no accepted spec. Default (standard) mode routes
  //    straight to the specification step (controller.py compute_next_action
  //    ~3124: enhance is a rigorous-only phase) → next: reconcile-spec.
  writeRun(
    stateHome,
    'initialized',
    baseState('initialized', {
      phase: 'initialized',
      artifacts: { feature_request: 'feature-request.md' }
    }),
    { 'feature-request.md': FEATURE_MD }
  );

  // 1a. currentCheckout — current-checkout mode on a clean feature branch.
  writeRun(
    stateHome,
    'currentCheckout',
    baseState('currentCheckout', {
      phase: 'initialized',
      repository: {
        id: REPO_ID,
        display_name: 'Demo Repo',
        worktree_path: '/work/current',
        worktree_mode: 'current'
      },
      artifacts: { feature_request: 'feature-request.md' }
    }),
    { 'feature-request.md': FEATURE_MD }
  );

  // 1b. enhanceRigorous — rigorous mode with no enhance artifact yet → the only
  //     path that routes to the enhance phase (controller.py ~3125).
  writeRun(
    stateHome,
    'enhanceRigorous',
    baseState('enhanceRigorous', {
      phase: 'initialized',
      effective_mode: 'rigorous',
      artifacts: { feature_request: 'feature-request.md' }
    }),
    { 'feature-request.md': FEATURE_MD }
  );

  // 2. implementing — spec+plan accepted, no checks yet → next: run-verification.
  writeRun(
    stateHome,
    'implementing',
    baseState('implementing', {
      phase: 'implementing',
      artifacts: FULL_ARTIFACTS
    }),
    FULL_ARTIFACT_FILES
  );

  // 3. verificationFailed — checks recorded and failing → next: fix-verification.
  writeRun(
    stateHome,
    'verificationFailed',
    baseState('verificationFailed', {
      phase: 'verification',
      artifacts: FULL_ARTIFACTS,
      verification: {
        passed: false,
        checks: [
          {
            name: 'unit',
            command: ['npm', 'test'],
            exit_code: 1,
            log: 'verification/unit.log',
            started_at: '2026-06-12T10:30:00Z',
            completed_at: '2026-06-12T10:31:00Z'
          }
        ]
      }
    }),
    { ...FULL_ARTIFACT_FILES, 'verification/unit.log': 'FAIL: 1 test failed\n' }
  );

  // 4. changesRequired — review verdict not pass, severe finding with file+line.
  writeRun(
    stateHome,
    'changesRequired',
    baseState('changesRequired', {
      phase: 'review',
      review_round: 1,
      artifacts: { ...FULL_ARTIFACTS, review: 'review-01.codex.json' },
      verification: passingVerification(),
      reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'changes_required' }]
    }),
    {
      ...FULL_ARTIFACT_FILES,
      'verification/unit.log': 'ok\n',
      'review-01.codex.json': JSON.stringify({
        verdict: 'changes_required',
        confidence: 0.7,
        summary: 'One correctness issue.',
        findings: [
          {
            id: 'F-1',
            severity: 'high',
            category: 'correctness',
            file: 'src/app.ts',
            line_start: 42,
            description: 'Off-by-one in the loop bound.',
            evidence: 'for (i <= n) iterates one past the end',
            recommended_fix: 'Use i < n.'
          }
        ],
        verification_gaps: ['No integration test covers the retry path.'],
        acceptance_criteria_assessment: [
          {
            id: 'AC-1',
            status: 'partially_satisfied',
            evidence: 'Happy path covered; error path unverified.'
          }
        ]
      }),
      // Legacy free-form triage note — surfaced read-only, never parsed for dispositions.
      'triage-01.md': '# Triage round 1\n\n- F-1: accepted — will fix the off-by-one.\n',
      // A malformed interior line must surface as a precise, non-fatal diagnostic.
      'events.jsonl':
        [
          JSON.stringify({
            schemaVersion: 1,
            sequence: 1,
            timestamp: '2026-06-12T10:40:00Z',
            runId: 'changesRequired',
            repositoryId: REPO_ID,
            phase: 'review',
            source: 'controller',
            type: 'review.started',
            payload: {}
          }),
          '{ this line is not valid JSON',
          JSON.stringify({
            schemaVersion: 1,
            sequence: 2,
            timestamp: '2026-06-12T10:41:00Z',
            runId: 'changesRequired',
            repositoryId: REPO_ID,
            phase: 'review',
            source: 'controller',
            type: 'review.completed',
            payload: { verdict: 'changes_required' }
          }),
          // Structured disposition for F-1 — surfaced on the finding "when present"
          // (§9), distinct from the read-only triage-01.md markdown above.
          JSON.stringify({
            schemaVersion: 1,
            sequence: 3,
            timestamp: '2026-06-12T10:42:00Z',
            runId: 'changesRequired',
            repositoryId: REPO_ID,
            phase: 'review',
            source: 'controller',
            type: 'review.finding.triaged',
            payload: { findingId: 'F-1', disposition: 'accepted' }
          })
        ].join('\n') + '\n'
    }
  );

  // 5. adversarialRequired — review pass, no severe findings, risk gate set.
  writeRun(
    stateHome,
    'adversarialRequired',
    baseState('adversarialRequired', {
      phase: 'adversarial-review',
      review_round: 1,
      artifacts: { ...FULL_ARTIFACTS, review: 'review-01.codex.json' },
      verification: passingVerification(),
      reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }],
      adversarial_reviews: [],
      risk: { requires_adversarial_review: true, reasons: ['Touches authentication'] }
    }),
    {
      ...FULL_ARTIFACT_FILES,
      'verification/unit.log': 'ok\n',
      'review-01.codex.json': passingReview()
    }
  );

  // 6. complete — every gate satisfied; carries an event log + both compare sides.
  writeRun(
    stateHome,
    'complete',
    baseState('complete', {
      status: 'complete',
      phase: 'complete',
      review_round: 1,
      artifacts: { ...FULL_ARTIFACTS, review: 'review-01.codex.json' },
      verification: passingVerification(),
      reviews: [{ round: 1, path: 'review-01.codex.json', verdict: 'pass' }]
    }),
    {
      ...FULL_ARTIFACT_FILES,
      'verification/unit.log': 'ok\n',
      'review-01.codex.json': passingReview(),
      'events.jsonl':
        [
          JSON.stringify({
            schemaVersion: 1,
            sequence: 1,
            timestamp: '2026-06-12T10:00:00Z',
            runId: 'complete',
            repositoryId: REPO_ID,
            phase: 'initialized',
            source: 'controller',
            type: 'run.created',
            payload: { label: 'complete' }
          }),
          JSON.stringify({
            schemaVersion: 1,
            sequence: 2,
            timestamp: '2026-06-12T10:31:00Z',
            runId: 'complete',
            repositoryId: REPO_ID,
            phase: 'verification',
            source: 'controller',
            type: 'verification.completed',
            payload: { name: 'unit', exitCode: 0 }
          })
        ].join('\n') + '\n'
    }
  );

  // 7. blocked — review budget exhausted → blockingReason set.
  writeRun(
    stateHome,
    'blocked',
    baseState('blocked', {
      status: 'blocked',
      phase: 'review-budget-exhausted',
      review_round: 3,
      artifacts: FULL_ARTIFACTS
    }),
    FULL_ARTIFACT_FILES
  );

  // 8. cancelled.
  writeRun(
    stateHome,
    'cancelled',
    baseState('cancelled', { status: 'cancelled', phase: 'cancelled' })
  );

  // 9. archived.
  writeRun(stateHome, 'archived', baseState('archived', { status: 'archived', phase: 'archived' }));

  // 10. malformed — invalid JSON must yield a diagnostic, not a crash.
  writeRun(stateHome, 'malformed', '{ this is not valid json ');

  // 12. cumulativeLedger — exercises the v0.3.0 cumulative ledger surface:
  //   * a resolved severe finding (released — must NOT show as blocking),
  //   * an open critical finding (blocking), an open low finding (non-severe),
  //   * mixed acceptance-criteria statuses (only `satisfied` is non-blocking),
  //   * per-phase Codex usage with tokens, an effective workflow mode, and a
  //     delta (round-2) review carrying a focused_full_fallback checkpoint.
  // Completion must fail closed: 1 critical open + 2 unsatisfied criteria.
  writeRun(
    stateHome,
    'cumulativeLedger',
    baseState('cumulativeLedger', {
      phase: 'review',
      review_round: 2,
      requested_mode: 'auto',
      effective_mode: 'rigorous',
      mode_reasons: ['Touches authentication'],
      artifacts: { ...FULL_ARTIFACTS, review: 'review-02.codex.json' },
      verification: passingVerification(),
      reviews: [
        {
          round: 1,
          path: 'review-01.codex.json',
          verdict: 'changes_required',
          delta: false,
          checkpoint: {
            id: 'review-01',
            head_commit: 'aaaa1111',
            branch: 'feature/thing',
            baseline_commit: 'base0000',
            changed_paths: ['src/app.ts'],
            path_fingerprints: { 'src/app.ts': 'sha256:dead' }
          }
        },
        {
          round: 2,
          path: 'review-02.codex.json',
          verdict: 'changes_required',
          delta: true,
          checkpoint: {
            id: 'review-02',
            head_commit: 'bbbb2222',
            branch: 'feature/thing',
            baseline_commit: 'base0000',
            changed_paths: ['src/app.ts', 'src/thing.ts'],
            path_fingerprints: { 'src/app.ts': 'sha256:beef', 'src/thing.ts': 'sha256:cafe' },
            previous_checkpoint_id: 'review-01',
            review_context_mode: 'focused_full_fallback'
          }
        }
      ],
      cumulative_findings: [
        {
          id: 'F-1',
          severity: 'high',
          category: 'correctness',
          status: 'resolved',
          round_opened: 1,
          round_last_seen: 2,
          origin: 'full',
          file: 'src/app.ts',
          line_start: 42,
          description: 'Off-by-one in the loop bound.',
          resolved_at_round: 2,
          resolution_source: 'review-02'
        },
        {
          id: 'F-2',
          severity: 'critical',
          category: 'security',
          status: 'open',
          round_opened: 2,
          round_last_seen: 2,
          origin: 'delta',
          file: 'src/thing.ts',
          line_start: 7,
          description: 'Unvalidated input reaches the query builder.'
        },
        {
          id: 'F-3',
          severity: 'low',
          category: 'style',
          status: 'open',
          round_opened: 1,
          round_last_seen: 2,
          origin: 'full',
          description: 'Minor naming nit.'
        }
      ],
      cumulative_acceptance_criteria: [
        { id: 'AC-1', status: 'satisfied', evidence: 'Covered by unit test.', round: 2 },
        { id: 'AC-2', status: 'not_satisfied', evidence: 'No persistence test.', round: 2 },
        { id: 'AC-3', status: 'partially_satisfied', evidence: 'Happy path only.', round: 2 }
      ],
      codex_runs: [
        {
          phase: 'enhance',
          model: 'gpt-5-codex',
          duration_seconds: 12.5,
          prompt_characters: 1000,
          output_characters: 2000,
          tokens: { input_tokens: 500, output_tokens: 800, total_tokens: 1300 }
        },
        {
          phase: 'review',
          model: 'gpt-5-codex',
          duration_seconds: 8.25,
          prompt_characters: 1500,
          output_characters: 900,
          tokens: { input_tokens: 700, output_tokens: 400, total_tokens: 1100 }
        }
      ]
    }),
    {
      ...FULL_ARTIFACT_FILES,
      'verification/unit.log': 'ok\n',
      'review-01.codex.json': JSON.stringify({
        verdict: 'changes_required',
        confidence: 0.6,
        summary: 'Round 1 found a correctness issue.',
        findings: [
          {
            id: 'F-1',
            severity: 'high',
            category: 'correctness',
            file: 'src/app.ts',
            line_start: 42,
            description: 'Off-by-one in the loop bound.'
          }
        ]
      }),
      'review-02.codex.json': JSON.stringify({
        verdict: 'changes_required',
        confidence: 0.55,
        summary: 'Round 2 resolved F-1 but found a security issue.',
        findings: [
          {
            id: 'F-2',
            severity: 'critical',
            category: 'security',
            file: 'src/thing.ts',
            line_start: 7,
            description: 'Unvalidated input reaches the query builder.'
          }
        ]
      })
    }
  );

  // 11. legacy — in-repo `.ai/autonomous-development` with markdown-only triage.
  const legacyRepoRoot = join(root, 'legacy-repo');
  const legacyDir = join(legacyRepoRoot, '.ai', 'autonomous-development');
  write(
    join(legacyDir, 'run-state.json'),
    JSON.stringify(
      baseState('legacy-run', {
        phase: 'review',
        artifacts: { ...FULL_ARTIFACTS, review: 'review-01.codex.json' },
        verification: passingVerification(),
        reviews: [{ round: 1, verdict: 'changes_required' }]
      }),
      null,
      2
    )
  );
  write(join(legacyDir, 'triage-01.md'), '# Triage round 1\n\n- F-1: accepted\n');

  return {
    stateHome,
    legacyRepoRoot,
    repoId: REPO_ID,
    runIds: {
      initialized: 'initialized',
      currentCheckout: 'currentCheckout',
      implementing: 'implementing',
      verificationFailed: 'verificationFailed',
      changesRequired: 'changesRequired',
      adversarialRequired: 'adversarialRequired',
      complete: 'complete',
      blocked: 'blocked',
      cancelled: 'cancelled',
      archived: 'archived',
      malformed: 'malformed',
      cumulativeLedger: 'cumulativeLedger',
      enhanceRigorous: 'enhanceRigorous'
    },
    runDir: (runId: string) => join(stateHome, 'repositories', REPO_ID, 'runs', runId),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}
