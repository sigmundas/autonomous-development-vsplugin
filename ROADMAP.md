# Roadmap

The extension remains an **observer + protocol foundation**, with bounded
configuration and explicit Start, Resume, Cancel, and controller controls.
Workflow orchestration remains owned by the autonomous-development controller
and Claude skills; the extension launches and observes those workflows rather
than reimplementing their state machine.

## Shipped (v0.4)

Requires `sigmundas/autonomous-development` **>=0.4.0 <0.5.0** for the 0.4
configuration and lifecycle controls. Run-state remains at `schema_version` 2
(versions 1 and 2 supported). The pinned `quaat/autonomous-development`
revision remains the preserved upstream compatibility baseline.

## Shipped (v0.2)

Historical compatibility target: original upstream controller **v0.3.0**,
run-state `schema_version` 2 (1 and 2 supported). See
[docs/REFERENCE.md](docs/REFERENCE.md) and the pinned
[resources/reference-lock.json](resources/reference-lock.json).

- Cumulative review ledger with resolution provenance, acceptance-criteria matrix
  (fail-closed: only `satisfied` is non-blocking), review checkpoints / delta
  context, Codex token usage, and mode-aware next action — all from the shared
  core evaluator.
- Completion gates fail closed, including a `pass` verdict that coexists with
  blocking findings or unsatisfied criteria.
- Compatibility guard: mirrored authoritative schemas, checksum-pinned and
  verified by `npm run verify:reference`.

## Shipped (v0.1)

- Read-only discovery and visualization of active/completed/archived runs.
- Workflow dashboard: stages, status, artifact chain, verification, reviews,
  adversarial-review state, gates, and the recommended next action — all from the
  shared core evaluator.
- Native-diff comparisons and finding-to-source navigation.
- Safe, trust-gated controller actions invoked via argv arrays.
- The versioned, forward-compatible `events.jsonl` protocol
  ([PROTOCOL.md](PROTOCOL.md)) with tolerant parsing and timeline reconstruction.
- Type-only adapter contracts for future live integrations
  (`packages/core/src/adapters`): `RunEventSource`, `RunEventSink`,
  `ClaudeAgentAdapter`, `CodexAppServerAdapter`, and their descriptors.

## Next: live event emission

Extend a thin adapter around the existing controller to **emit `RunEvent`s** as a
run progresses, so the dashboard timeline updates live instead of being
reconstructed only from `run-state.json` snapshots. This is purely additive to the
protocol (new event instances, not new envelope semantics).

## Later: Claude Agent SDK adapter

Implement `ClaudeAgentAdapter` against the Claude Agent SDK to surface
agent-message and tool events (`agent.message.completed`, `tool.started`,
`tool.completed`) through the same `RunEventSink`. Planning and review remain
read-only; orchestration stays inside the existing workflow's safety boundaries.

## Later: Codex app-server adapter

Implement `CodexAppServerAdapter` against the Codex app-server to stream review
rounds and findings (`review.started`, `review.finding.created`,
`review.completed`) as structured events rather than post-hoc file reads.

## Explicit non-goals

Out of scope for the foreseeable roadmap (and entirely for this release):

- Rewriting the Python controller in TypeScript.
- Embedding or managing Claude/Codex credentials, billing, or accounts.
- Cloud sync of state or multi-user collaboration.
- Automatically modifying the target repository, or creating commits, branches,
  PRs, pushes, merges, or deployments.
- Exposing hidden model reasoning / chain-of-thought.

Each live adapter will preserve the boundaries in [SECURITY.md](SECURITY.md):
read-only planning/review, no push/merge/deploy, no credential exposure, and full
workspace-trust gating.
