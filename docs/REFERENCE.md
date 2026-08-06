# Reference: quaat/autonomous-development compatibility contract

Reflects controller **v0.3.0** (`.claude-plugin/plugin.json` version `0.3.0`,
git revision `a72f740`).

This document records the **authoritative** state layout, schemas, controller
interface, completion-gate logic, lifecycle, and safety boundaries of the
`quaat/autonomous-development` plugin, as derived directly from its source
(`scripts/state.py`, `scripts/controller.py`, `scripts/stop_gate.py`,
`schemas/*.json`, `prompts/*.md`, `SECURITY.md`). The SemanticMatter Autonomous
Development extension must remain compatible with everything described here.
**When compatibility is uncertain, preserve the reference behavior and record the
uncertainty — never invent a new interpretation.**

> Source of truth precedence: the reference Python source > this document > UI code.
> If this document and the reference disagree, the reference wins; fix this doc.
>
> Run-state is at `schema_version` **2** (`STATE_SCHEMA_VERSION = 2`); supported
> versions are `{1, 2}`. There is **no** schema v3. The v0.3.0 fields below
> (cumulative ledgers, checkpoints, modes, codex_runs) are additive keys written
> into a v2 document; `validate_state` does not yet validate them against a
> bundled schema (run-state schema validation is deferred upstream). If a future
> upstream release freezes a run-state schema and bumps the version, treat that as
> a new dependency, not an existing feature.

## 1. State-home resolution (precedence)

1. Explicit override (CLI `--state-dir`; in the extension: the
   `autonomousDev.stateHome` setting).
2. `CLAUDE_AUTONOMOUS_STATE_HOME` environment variable.
3. Platform default:
   - **macOS** (`darwin`): `~/Library/Application Support/claude-autonomous`
   - **Windows** (`win32`): `%LOCALAPPDATA%/claude-autonomous`, else
     `~/AppData/Local/claude-autonomous`
   - **Linux/other**: `$XDG_STATE_HOME/claude-autonomous` if `XDG_STATE_HOME`
     set, else `~/.local/state/claude-autonomous`

Paths are `expanduser()`-ed and resolved. Note the Linux default base is
`~/.local/**state**` (not `.local/share`).

## 2. Directory layout

```
<state-home>/
  repositories/
    <repo-id>/
      metadata.json
      runs/
        <run-id>/
          run-state.json
          feature-request.md
          repository-context.txt
          accepted-spec.md
          accepted-plan.md
          feature-spec.codex.json             # enhance output
          implementation-plan.codex.json       # plan output
          enhance.prompt.md / plan.prompt.md / review.prompt.md / adversarial.prompt.md
          review-NN.codex.json                 # NN = zero-padded round (01..)
          review-NN.events.ndjson              # NEW: retained codex --json event stream
          adversarial-NN.codex.json
          triage-NN.md                         # Claude triage, free-form markdown
          verification/
            NN-<slug>.log                       # one per recorded check
          .run-state.lock                       # fcntl lock file (ignore in UI)
          events.jsonl                          # emitted by this project's protocol
```

- **repo-id**: 16 hex chars = `sha256(git_common_dir + "\n" + first_commit)[:16]`.
- **run-id**: `<YYYYMMDDTHHMMSSZ>-<8 hex>` (UTC), e.g. `20260612T201323Z-96954900`.
  Validated against `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`; used as a single path
  segment, so the controller refuses separators / `..` traversal.
- **Legacy layout** (read-only inspection only): `<repo>/.ai/autonomous-development/run-state.json`.
  Detected when that file exists. Deprecated; never written by this extension.

## 3. run-state.json (schema_version 2)

Written atomically (invocation-unique `.tmp` then `replace`) as
`json.dumps(indent=2, sort_keys=True) + "\n"`. Watchers must handle atomic replace
(rename) and partial writes.

Canonical shape (from `cmd_init`, mutated by other commands):

```jsonc
{
  "schema_version": 2,                  // or legacy "version"; supported: 1, 2
  "run_id": "20260612T201323Z-96954900",
  "label": "optional-slug",
  "feature": "<original feature text>",
  "status": "active",                   // active|complete|blocked|cancelled|archived
  "phase": "initialized",               // see §4
  "created_at": "ISO-8601 seconds",
  "updated_at": "ISO-8601 seconds",     // refreshed on every save
  "requested_mode": "auto",             // NEW: as requested on init (auto|lean|standard|rigorous)
  "effective_mode": "standard",         // NEW: resolved mode driving the workflow (§12)
  "mode_reasons": ["..."],              // NEW: human-readable reasons for effective_mode
  "repository": {
    "id": "8dd906752e640877",
    "canonical_root": "/abs/path",
    "git_common_dir": "/abs/path/.git",
    "worktree_path": "/abs/path",
    "worktree_mode": "isolated",        // NEW: isolated (default) or current
    "display_name": "repo-name",
    "remote_display": "https://host/org/repo"   // credentials already stripped
  },
  "baseline": {
    "commit": "<40-hex>",
    "branch": "main",
    "dirty_entries_at_init": ["?? foo", " M bar"]  // git status --short lines
  },
  "max_review_rounds": 3,               // 1..5
  "review_round": 0,
  "stop_gate_blocks": 0,
  "artifacts": {                        // values are run-dir-relative paths (or abs)
    "feature_request": "feature-request.md",
    "repository_context": "repository-context.txt",
    "enhance": "feature-spec.codex.json",        // set after codex enhance
    "accepted_spec": "accepted-spec.md",         // set after accept --kind spec
    "plan": "implementation-plan.codex.json",    // set after codex plan
    "accepted_plan": "accepted-plan.md",         // set after accept --kind plan
    "review": "review-01.codex.json",            // latest review path
    "adversarial": "adversarial-01.codex.json"
  },
  "verification": {
    "passed": false,
    "checks": [
      {
        "name": "unit-tests",
        "command": ["npm", "test"],
        "exit_code": 0,
        "log": "verification/01-unit-tests.log",
        "started_at": "ISO",
        "completed_at": "ISO"
      }
    ]
  },
  "reviews": [
    {
      "round": 1,
      "path": "review-01.codex.json",
      "verdict": "changes_required",  // pass|changes_required|blocked
      "delta": false,                 // NEW: false=full review schema, true=delta schema (rounds 2+)
      "checkpoint": {                 // NEW: worktree snapshot this round reviewed (§3.2)
        "id": "review-01",
        "captured_at": "ISO",
        "head_commit": "<40-hex>",
        "branch": "main",
        "baseline_commit": "<40-hex>|null",
        "changed_paths": ["src/a.ts"],
        "path_fingerprints": { "src/a.ts": "sha256:<hex>", "deleted.ts": null },
        "previous_checkpoint_id": "review-00|null",
        "review_context_mode": "focused_full_fallback"
      }
    }
  ],
  "adversarial_reviews": [
    { "round": 1, "path": "adversarial-01.codex.json", "verdict": "pass" }
  ],
  "cumulative_findings": [],            // NEW: full-then-delta merged finding ledger (§3.1, §6.1)
  "cumulative_acceptance_criteria": [], // NEW: id-keyed AC ledger (§3.1)
  "review_ledger": [],                 // NEW: triage dispositions keyed by fingerprint (§3.1)
  "codex_runs": [],                    // NEW: per-phase usage instrumentation (§3.3)
  "risk": { "requires_adversarial_review": false, "reasons": [] },
  "notes": ["free-form strings"],
  "completion_gate_failures": ["set by evaluate"],
  // migration-only fields:
  "migrated_from": "v1" | "<legacy dir>",
  "migrated_at": "ISO"
}
```

Required for validity: `status` (string) and `run_id` (string, matching the run
ID pattern). `schema_version` (or `version`) must be in {1, 2} if present.

### 3.1 v0.3.0 ledger fields

**`cumulative_findings[]`** — the canonical per-finding shape, built by
`_cumulative_finding` / `_finalize_cumulative`; every entry is normalized to all
of these keys (evidence stored inline so the gate/audit/delta-reviewer never
re-open `review-NN.codex.json`):

| field               | meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `id`                | canonical `F-<n>` id (remapped on collision; see `source_id`/`legacy_id`)      |
| `severity`          | `critical`/`high`/`medium`/`low` (or null/unknown — treated as severe, §6.1)   |
| `category`          | review category (see §8) or null                                               |
| `status`            | `open` (default), or a triage disposition (`resolved`, `rejected`, …)          |
| `round`             | round the finding was opened (back-compat alias of `round_opened`)             |
| `round_opened`      | round the finding was first opened                                             |
| `round_last_seen`   | last round a reviewer actually reported it (delta reviews report only changes) |
| `origin`            | provenance: `full` \| `delta` \| `regression` \| `legacy`                      |
| `file`              | path or null                                                                   |
| `line_start`        | 1-based line or null                                                           |
| `description`       | inline evidence (default `""`)                                                 |
| `evidence`          | inline evidence (default `""`)                                                 |
| `recommended_fix`   | inline evidence (default `""`)                                                 |
| `source_id`         | present only when the model's original id was remapped (collision/dup)         |
| `legacy_id`         | present only on entries migrated from legacy synthetic ids                     |
| `resolved_at_round` | round a delta review resolved it (resolution provenance)                       |
| `resolution_source` | resolving round label, e.g. `review-03`                                        |

**`cumulative_acceptance_criteria[]`** — id-keyed ledger merged from a full
review's `acceptance_criteria_assessment` and each delta's
`affected_acceptance_criteria`; latest disposition per id: `{ id, status,
evidence, round }`. `status` ∈ {`satisfied`, `partially_satisfied`,
`not_satisfied`, `not_verifiable`} (or missing/unknown). Only `satisfied` does
not block completion (§6).

**`review_ledger[]`** — triage dispositions, keyed by `fingerprint`. Each entry:
`fingerprint` (required, non-empty — every gate-affecting closure must be
auditable), `status` (one of `accepted`, `resolved`, `rejected`,
`rejected_with_evidence`, `already_resolved`, `out_of_scope_but_recorded`,
`requires_human_decision`, `open`), and optional `finding_id` (`^F-[0-9]+$`),
`resolution`, `reason`, `evidence`, `justification`. The `triage` command merges
this ledger _and_ applies dispositions into `cumulative_findings` (see §6.1).

### 3.2 Review checkpoints (`reviews[].checkpoint`)

Each recorded review stores a `checkpoint` snapshot of the worktree it reviewed,
so a later round can detect what changed. There is **no** exact review-to-review
patch: the delta reviewer reviews the full current feature diff against the
baseline, focusing on the changed paths — hence `review_context_mode =
"focused_full_fallback"`. Fields: `id`, `captured_at`, `head_commit`, `branch`,
`baseline_commit` (or null), `changed_paths[]` (feature diff vs baseline ∪ git
status), `path_fingerprints` (`{path: "sha256:<hex>"}`, or `null` when the file is
deleted/unreadable), `previous_checkpoint_id` (or null), `review_context_mode`.
`adversarial_reviews[]` carry only `{round, path, verdict}` (no checkpoint).

### 3.3 Token instrumentation (`codex_runs[]`)

`codex` phases run `codex exec --json`, retain the NDJSON event stream
(`review-NN.events.ndjson`), and append a per-phase usage record:
`phase`, `prompt_characters`, `output_characters`, `duration_seconds`, `model`,
`reasoning_effort`, `verbosity`, `started_at`, `events_artifact` (relative path),
`output_artifact` (relative path), and `tokens` (present only when parsed) with
`{input_tokens, output_tokens, total_tokens}`. Surfaced by `usage-report`.

## 4. Phase strings & lifecycle (who sets what)

| Controller action                | status        | phase                        |
| -------------------------------- | ------------- | ---------------------------- |
| `init`                           | active        | `initialized`                |
| `codex --phase enhance`          | active        | `idea-enhanced`              |
| `accept --kind spec`             | active        | `spec-accepted`              |
| `codex --phase plan`             | active        | `plan-proposed`              |
| `accept --kind plan`             | active        | `plan-accepted`              |
| `set-phase --phase implementing` | active        | `implementing` (free-form)   |
| `run-check` (all latest pass)    | active        | `verified`                   |
| `run-check` (any latest fails)   | active        | `verification-failed`        |
| `codex --phase review`           | active        | `reviewed`                   |
| review budget exceeded           | **blocked**   | `review-budget-exhausted`    |
| `codex --phase adversarial`      | active        | `adversarially-reviewed`     |
| `evaluate` (gates fail)          | active        | `completion-gates-failed`    |
| `evaluate` (gates pass)          | **complete**  | `complete`                   |
| `cancel`                         | **cancelled** | `cancelled`                  |
| `block`                          | **blocked**   | `blocked`                    |
| `archive-run`                    | **archived**  | (unchanged)                  |
| stop-gate budget exhausted       | **blocked**   | `stop-gate-budget-exhausted` |

`phase` is free-form (set-phase accepts anything), so the extension must **derive**
its stage model defensively from `status` + `phase` + artifacts + reviews +
verification + risk, never assume an exact phase string.

Terminal statuses: `{complete, blocked, cancelled, archived}` (`TERMINAL_STATUSES`).

### 4.1 Terminal-state & mutation-integrity rules

The controller separates run access into three contracts and the extension must
not bypass them:

- **Inspection** (`resolve_run_for_inspection`) — read-only; may resolve terminal
  runs (and falls back to the most-recently-created run when none is active).
- **Active mutation** (`resolve_run_for_active_mutation`) — refuses any
  non-`active` run, _even with an explicit `--run-id`_. "Not terminal" is not
  enough: an unknown/garbage/partial-write status fails closed
  (`_reject_non_active`). Terminal runs are immutable and cannot be resurrected.
- **Transition** (`resolve_run_for_transition`) — lifecycle commands that must read
  a terminal run (e.g. archive a completed run); the transition table
  (`TRANSITION_POLICY`) is enforced under the lock: `cancel`/`block` only from
  `active`; `archive-run` only from `{complete, blocked, cancelled}`.

Run-identity invariants are re-asserted under the lock: `run_id` must equal the
run directory name and `repository.id` must match the current repo
(`verify_loaded_run_identity`), and mutating commands re-check the status under the
lock immediately before publishing (`require_active_run_state`, the TOCTOU guard).

## 5. Verification "latest effective" rule

`latest_verification_checks`: iterate `checks` in order; for each `name`, the
**last** entry with that name is the effective result; ordering preserves
first-seen. `verification.passed = checks_nonempty AND all(effective.exit_code == 0)`.
The UI must show the latest effective result per logical name while still letting
earlier attempts be inspected.

## 6. Completion-gate logic (replicate exactly — `cmd_evaluate`)

Gate FAILS (status stays `active`, phase `completion-gates-failed`,
`completion_gate_failures` = the reason list) if **any** check fails. Computed
under the run lock against freshly-loaded state and current filesystem state. The
reasons accumulate in this order:

1. `accepted-spec.md` missing.
2. `accepted-plan.md` missing.
3. No verification checks recorded (uses the latest-effective set, §5).
4. Any **latest-effective** check has `exit_code != 0`.
5. No reviews recorded.

If reviews exist, the latest review is read and these checks accumulate in order.
"Latest review" is the **array tail** (`reviews[-1]`) — the last entry the
controller appended — not the highest-numbered `round`; the extension mirrors
this exactly so the gate and next-action read the same review the controller does:

6. Latest review unreadable, OR latest review `verdict != "pass"`.
7. **Severe findings.** Source: if `cumulative_findings` is non-empty, use
   `cumulative_unresolved_severe(state)` (§6.1); otherwise fall back to the latest
   review file's raw severe findings (`unresolved_severe_findings`). Any severe,
   unblocked finding fails the gate. The reason names the blocking findings
   (id, `[severity/category]`, and a short description snippet).
8. **Acceptance criteria — NOT informational.** Every cumulative acceptance
   criterion with `status != "satisfied"` (incl. `partially_satisfied`,
   `not_satisfied`, `not_verifiable`, and any missing/unknown value) BLOCKS
   completion (fail closed, `blocking_acceptance_criteria`). The reason names the
   blocking criteria (id, `[status]`).
9. **Pass inconsistency.** If `verdict == "pass"` AND (severe findings OR
   unsatisfied criteria) exist, that is itself a failure — a `pass` that coexists
   with blocking findings/criteria is rejected as internally inconsistent.

Finally:

10. If `risk.requires_adversarial_review`: no adversarial review recorded, OR
    latest adversarial `verdict != "pass"`.

All pass ⇒ status `complete`, phase `complete`, `completion_gate_failures = []`.

> The gate does **not** consult `review_ledger` directly; triage dispositions are
> already folded into `cumulative_findings` by the `triage` command (§6.1) before
> the gate scans the ledger. The core evaluator
> (`packages/core/src/workflow/gates.ts`) reproduces gate codes in this order:
> `missing-accepted-spec`, `missing-accepted-plan`, `no-verification`,
> `verification-failing`, `no-reviews`, `review-not-pass`, `severe-findings`,
> `acceptance-criteria-unsatisfied`, `review-inconsistent-pass`,
> `adversarial-required`.

### 6.1 Cumulative finding ledger semantics (replicate exactly)

The ledger is built **full-then-delta**: round 1 seeds it from the full
`review.schema.json` (`merge_full_review`); rounds 2+ merge a compact
`review-delta.schema.json` (`merge_delta_review`). `merge_acceptance_criteria`
maintains the AC ledger in parallel.

- **Severity is fail-closed.** A finding is "severe" iff
  `severity ∉ {low, medium}` (`NON_SEVERE_SEVERITIES`). A missing or unknown
  severity is therefore **severe**. A non-dict ledger entry is also counted as a
  severe, unresolved finding.
- **Release from blocking is explicit.** A severe finding still blocks the gate
  unless its `status` is in `NON_BLOCKING_TRIAGE_STATUSES` = {`rejected`,
  `rejected_with_evidence`, `already_resolved`, `out_of_scope_but_recorded`,
  `resolved`}. A missing/unknown status is **not** read as released. `open` and
  `requires_human_decision` keep blocking.
- **Triage folds into the ledger.** `apply_triage_to_cumulative` matches an entry's
  `finding_id` to a cumulative finding and sets its `status`. Blocking-intent
  statuses (`open`, `requires_human_decision`) reopen a finding (fail-safe
  direction, so a later round can re-block). Closing a **severe** finding requires
  a recorded rationale (`reason`/`evidence`/`resolution`/`justification`); without
  one the disposition is ignored. This is why the gate reads the cumulative ledger
  rather than triage directly — dispositions are already reflected there.
- **Resolution provenance.** A delta review's `resolved_findings` set the finding's
  `status` and record `resolved_at_round` + `resolution_source` (the resolving
  round label).
- **Delta resolution fails closed.** `merge_delta_review` raises (does not silently
  drop) when `resolved_findings` contains a duplicate id within the round, an
  unknown id (not in the cumulative ledger), or an id also reported as a new
  finding/regression that round. The schema enforces `uniqueItems: true`.
- **Duplicate finding ids fail closed.** The schema enforces id _format_
  (`^F-[0-9]+$`) but not uniqueness; a collision is remapped to a fresh canonical
  `F-<n>` (referenceable by triage), preserving the model's id under `source_id`.
  A delta never overwrites an existing finding of any status.

## 7. Recommended next action (derived, single source)

Derived in `packages/core` from the same inputs as the gate, **mode-aware**, to
mirror the controller's `compute_next_action` (controller.py ~line 3103;
`mode = state.effective_mode or "standard"`). This logic lives in exactly one
place; tree/dashboard/status bar/commands all consume it. The controller returns
the first matching phase (verification uses the latest-effective check per name,
§5):

1. Terminal status (`complete`/`blocked`/`cancelled`/`archived`) ⇒ phase = status,
   "no further action".
2. No accepted spec:
   - if `mode == "rigorous"` **and** `enhance` not in artifacts ⇒ phase
     **`enhance`** ("Run `codex --phase enhance`, then reconcile…").
   - otherwise ⇒ phase **`specification`**. In `lean` mode the action is "inspect
     the repository and write a concise accepted spec"; every other mode (and
     absent mode) is "reconcile requirements into an accepted spec". The phase is
     `specification` in all of these cases.
3. No accepted plan ⇒ phase **`planning`** (lean: write a concise plan from
   inspection; otherwise run `codex --phase plan` then reconcile).
4. Verification not all-pass (latest-effective) ⇒ phase **`verification`**.
5. `not latest_pass OR cumulative_unresolved_severe(state)` ⇒ phase **`review`**.
   The review step fires when the latest review verdict is not `pass` **or** when
   any severe, unblocked cumulative finding remains — even if the verdict is
   `pass`. (This differs from `stop_gate.py`, which keys only on verdict; see §7.1.)
6. `risk.requires_adversarial_review` AND (no adversarial OR latest adversarial
   `verdict != "pass"`) ⇒ phase **`adversarial`**.
7. Otherwise ⇒ phase **`evaluate`** ("Run `controller.py evaluate`").

### 7.1 stop_gate.py parity note

The skill-scoped Stop hook `reason_for` checks the same precedence but is **not**
mode-aware (it always writes spec/plan directly) and keys its review step on
**verdict only** — it does not separately test for severe findings. The completion
gate (§6) and `compute_next_action` (§7 step 5) DO consider severe cumulative
findings. The extension's next-action follows `compute_next_action`. For
terminal/early states with no stop_gate equivalent the extension extends the
front of the list defensively (status blocked ⇒ "review the blocking reason";
status complete/cancelled/archived ⇒ none) without contradicting the controller.

## 8. Codex artifact JSON schemas

- **feature-spec.codex.json** (`enhanced-idea.schema.json`): `title`,
  `problem_statement`, `user_outcomes[]`, `functional_requirements[]`
  `{id:FR-N, requirement, priority:must|should|could, evidence}`,
  `non_functional_requirements[]`, `acceptance_criteria[]`
  `{id:AC-N, criterion, verification}`, `assumptions[]`, `open_questions[]`
  `{question, recommended_default, blocking}`, `risks[]`
  `{risk, severity, mitigation}`, `non_goals[]`.
- **implementation-plan.codex.json** (`implementation-plan.schema.json`):
  `summary`, `current_state[]`, `architecture_decisions[]`
  `{decision, rationale, alternatives_rejected[]}`, `implementation_steps[]`
  `{order, description, files[], dependencies[], validation}`,
  `files_expected_to_change[]` `{path, change, confidence:0..1}`,
  `data_and_api_changes{public_api[], data_model[], migration[], compatibility[]}`,
  `test_strategy{unit[], integration[], end_to_end[], static_checks[], manual_or_runtime[]}`,
  `rollback_strategy[]`, `risks[]`, `non_goals[]`, `definition_of_done[]`.
- **review-NN.codex.json** — **round 1** (`review.schema.json`):
  `verdict ∈ {pass, changes_required, blocked}`, `summary`, `findings[]`
  `{id:F-N, severity:critical|high|medium|low,
category:correctness|security|reliability|performance|maintainability|testing|compatibility|documentation,
file:string|null, line_start:int|null, description, evidence, recommended_fix}`,
  `verification_gaps[]`, `acceptance_criteria_assessment[]`
  `{id, status:satisfied|partially_satisfied|not_satisfied|not_verifiable, evidence}`,
  `confidence:0..1`. All listed keys are `required` and `additionalProperties` is
  false.
- **review-NN.codex.json** — **rounds 2+** (`review-delta.schema.json`):
  `verdict ∈ {pass, changes_required, blocked}`, `summary`,
  `resolved_findings[]` (`^F-[0-9]+$`, `uniqueItems`), `new_findings[]`,
  `regressions[]` (both same finding shape as round 1),
  `affected_acceptance_criteria[]` (same `{id, status, evidence}` shape),
  `confidence:0..1`.
- **adversarial-NN.codex.json** (`adversarial-review.schema.json`):
  `verdict ∈ {pass, changes_required, blocked}`, `summary`, `threats[]`
  `{severity:critical|high|medium|low,
area:authorization|authentication|data_loss|migration|concurrency|retries|privacy|availability|rollback|external_api|supply_chain|other,
scenario, evidence, mitigation}`, `failure_scenarios[]` (strings),
  `required_actions[]` (strings), `confidence:0..1`.
- **triage ledger** (`triage.schema.json`): a JSON **array** of
  `{fingerprint (required), status (required, see §3.1), finding_id?, resolution?,
reason?, evidence?, justification?}`.
- **reconciliation decisions** (`accept-decisions.schema.json`): object with
  `accept[]` (ids), `reject[]` `{id, reason}`, `modify[]` `{id, replacement}`,
  `add[]` (objects).

> The review verdict enum is `pass | changes_required | blocked` across the full,
> delta, and adversarial schemas. (`changes_required`, **not** `changes_requested`.)

`file`/`line_start` may be null; when both present, "open finding location" opens
`<worktree>/<file>:<line_start>`.

## 9. Triage dispositions (UI semantics)

Structured dispositions recognised by the triage schema and ledger: `accepted`,
`resolved`, `rejected`, `rejected_with_evidence`, `already_resolved`,
`out_of_scope_but_recorded`, `requires_human_decision`, `open`. Of these,
`{rejected, rejected_with_evidence, already_resolved, out_of_scope_but_recorded,
resolved}` release a finding from blocking (§6.1). Render the cumulative
`finding_id` alongside a disposition so it is traceable to the finding it
dispositioned. Legacy runs may only have `triage-NN.md` (free-form markdown) —
show them read-only; never fabricate a structured disposition.

## 10. Controller CLI (adapter contract)

Global: `--project-root <dir>`, `--state-dir <dir>`, `--run-id <id>`. The full
v0.3.0 subcommand surface (always invoked as an **argv array**, never a shell
string):

| Subcommand             | Args                                                                                                                         | Mutating |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| `doctor`               | —                                                                                                                            | no       |
| `init`                 | `--feature` (req) `[--label]` `[--mode auto\|lean\|standard\|rigorous]` `[--worktree-mode isolated\|current]` `[--allow-main]` `[--max-review-rounds 1..5]` `[--reuse]` `[--force]` | writes   |
| `codex`                | `--phase enhance\|plan\|review\|adversarial` (req) `[--timeout N]`                                                           | writes   |
| `accept`               | `--kind spec\|plan` (req) `[--file F]` `[--source J]` `[--decisions J]`                                                      | writes   |
| `run-check`            | `--name` (req) `[--output summary\|full]` `[--failure-tail-lines N]` `[--timeout N]` `<command…>`                            | writes   |
| `set-phase`            | `--phase` (req) `[--note]`                                                                                                   | writes   |
| `set-risk`             | `--require-adversarial / --no-require-adversarial` `[--reason]`                                                              | writes   |
| `evaluate`             | —                                                                                                                            | writes   |
| `usage-report`         | `[--json]`                                                                                                                   | no       |
| `next-action`          | `[--json]`                                                                                                                   | no       |
| `triage`               | `--file` (req, JSON ledger array)                                                                                            | writes   |
| `status`               | `[--json]`                                                                                                                   | no       |
| `cancel`               | `[--reason]`                                                                                                                 | writes   |
| `block`                | `--reason` (req)                                                                                                             | writes   |
| `list-runs`            | `[--json]` `[--all]`                                                                                                         | no       |
| `show-run`             | `--run-id <id>` `[--json]`                                                                                                   | no       |
| `migrate-legacy-state` | `[--target-run-id <id>]` `[--force]` (force never overwrites)                                                                | writes   |
| `archive-run`          | —                                                                                                                            | writes   |
| `accept-drift`         | —                                                                                                                            | writes   |

Adapter rules: always pass explicit `--project-root` and (for run-scoped commands)
`--run-id`; never rely on the "single active run" fallback. Mutating commands are
disabled in untrusted workspaces and require explicit confirmation. Mutating
commands refuse terminal/non-active runs even with an explicit `--run-id` (§4.1).

`list-runs --json` / `status --json` print the run-state object(s) verbatim;
`next-action [--json]` prints the `{phase, required_action, completion_condition,
references}` object (§7). `list-runs` default excludes archived/terminal; `--all`
includes them.

## 11. Safety boundaries (must preserve)

- Codex planning/review run `codex exec --json --sandbox read-only` — never editing.
- Never push, merge, publish, deploy, rotate/expose credentials, apply
  irreversible migrations, delete unrelated changes, or weaken checks to pass.
- Disable execution/mutation commands in untrusted workspaces.
- Strict CSP + restricted local resource roots in webviews; never pass env vars
  or credentials to webview code.
- Prefer process execution with argv arrays over shells.
- Redact credential-bearing remote URLs (userinfo) — see `_strip_credentials`.
- Do not log full prompts/artifacts by default (may contain source or secrets).
- Artifact pointers are confined to the run directory (`resolve_artifact_path`
  rejects absolute paths and `..` traversal) so a crafted/legacy run-state cannot
  exfiltrate arbitrary local files into a Codex prompt.

## 12. Workflow modes

`requested_mode` is one of `auto | lean | standard | rigorous` (default `auto`,
set at `init --mode`). `effective_mode` is resolved by `select_mode` and recorded
with `mode_reasons`. `repository.worktree_mode` records whether the run was
started in `isolated` (default) or `current` checkout mode:

- **auto** — escalates conservatively to **rigorous** when `classify_feature_risk`
  detects any high-risk signal in the feature text; otherwise resolves to
  **standard**. Never downgrades an explicit mode.
- **lean** — minimal depth; `compute_next_action` writes the spec and plan
  directly from repository inspection rather than running `codex enhance`/`plan`.
- **standard** — default depth; reconcile spec/plan; no enhance phase.
- **rigorous** — full depth; the only mode that routes to the `enhance` phase when
  no spec exists, and the only mode that auto-sets
  `risk.requires_adversarial_review = true` at init (so the adversarial gate, §6
  #10, applies).

`current` checkout mode is orthogonal to workflow depth: it skips disposable
worktree creation, records the current checkout as both canonical and worktree
paths, and refuses `main`/`master` unless the caller also passes `--allow-main`.

`effective_mode` (defaulting to `standard` when absent) drives `compute_next_action`
(§7). `requested_mode` records what the user asked for; explicit non-`auto` modes
are passed through verbatim.
