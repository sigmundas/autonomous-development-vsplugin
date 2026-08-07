# Changelog

All notable changes to the SemanticMatter Autonomous Development extension are
documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Pre-run configuration surface.** A dedicated **Configuration** view in the
  Autonomous Development activity-bar container is visible immediately after
  opening a workspace — before any run exists and before the state home
  directory has been created. Opening it launches a strict-CSP webview with
  real dropdowns for the active preset, Claude runtime, and per-phase Codex
  profile and reasoning effort. Every mutation flows through the controller's
  `config-*` JSON contract: `config-show`, `config-list-profiles`,
  `config-list-presets`, `config-list-claude-runtimes`,
  `config-set-active-preset`, `config-set-phase`, `config-set-claude-runtime`,
  and `config-validate`. QuickPick-based commands
  (`autonomousDev.selectPreset`, `autonomousDev.configurePlanningAgent`,
  `autonomousDev.configureReviewAgent`,
  `autonomousDev.configureAdversarialReviewer`,
  `autonomousDev.configureClaudeRuntime`,
  `autonomousDev.showEffectiveConfiguration`,
  `autonomousDev.validateConfiguration`) are exposed from the Command Palette
  for fast changes without opening the panel.
- **Skill-owned Start flow.** **Start Autonomous Run** opens exactly one Claude
  session with the selected runtime and shared bounded permission policy. The
  user then invokes the appropriate autonomous skill, which owns controller
  initialization. The extension no longer calls `controller.py init` from the
  normal Start path. `autonomousDev.openAutonomousClaude` and the hidden legacy
  `autonomousDev.launchClaude` ID are aliases for the same implementation.
- **Run dashboard configuration snapshot.** Runs that carry a
  `config_snapshot` in their `run-state.json` now display a read-only
  configuration section — preset, Claude runtime, and per-phase profile and
  reasoning effort — so the exact configuration a run was initialized with is
  visible independently of the current global preset. Legacy runs without a
  snapshot continue rendering normally.
- Typed `ConfigClient` and runtime validators for the controller's `config-*`
  contract, exported from `@semanticmatter/core`. Malformed profile / preset /
  runtime entries never crash the UI; secret-shaped keys are refused by the
  controller and never surface in the webview.

### Changed

- **Compact workflow-stage metadata.** Profile/model and reasoning-effort text
  now renders on one secondary line beneath the stage title, never breaks
  identifiers mid-token, and ellipsizes at narrow dashboard widths. Hovering
  exposes the complete value and profile detail.

### Notes

- This extension never rewrites `~/.codex/config.toml`, `~/.codex/*.config.toml`,
  Claude credentials, or provider API keys. Selecting an autonomous Codex
  profile applies only to autonomous-development runs (via `codex exec
  --profile <id>`); the normal OpenAI Codex VS Code extension continues to use
  its own OpenAI configuration.
- Changing the Claude runtime selection applies when launching a **new**
  session; it does not change the provider of an already-running Claude Code
  session.
- A manual end-to-end smoke test validated that **Start Autonomous Run** opens
  one configured Claude session, the selected skill owns controller init,
  bounded `dontAsk` permissions remain active, Azure-backed Codex planning
  succeeds with codex-cli 0.146.1, and the workflow completes. **Cancel and
  Resume were not exercised and are not claimed as manually validated.**
- codex-cli 0.147.0 is currently incompatible with the validated Azure
  Responses profile because it sends an empty `functions` namespace
  description. The `/models` decode warning visible in both versions is not the
  fatal error. The temporary workaround is to pin 0.146.1; the authoritative
  explanation and verification command are in the
  [controller README](https://github.com/sigmundas/autonomous-development#azure-openai--codex-cli-compatibility).
- The initial generic Start terminal is created before skill-owned init assigns
  a run id, so the dashboard may show **Claude terminal: not open** while that
  terminal is running. Terminal-to-run association remains a separate follow-up
  and is unchanged in this release.

## 0.3.0

Compatibility target unchanged from 0.2.0: `quaat/autonomous-development`
**v0.3.0**, run-state `schema_version` 2 (versions 1 and 2 supported).

### Added

- **Start Run command.** Start a new autonomous-development run without leaving
  VS Code: the `+` button in the _Active Runs_ view title (and the **Autonomous
  Development: Start Run** palette command) prompts for a feature description,
  then opens an integrated terminal in the repository, launches the Claude
  driver (`claude --plugin-dir …`), and pre-fills the
  `/autonomous-development:autonomous-feature` skill command. The command is
  typed but not executed — the user presses Enter to launch, keeping a human in
  the loop. Because the skill drives its own `init`, this avoids creating an
  orphan run that nothing drives. The feature text is POSIX single-quoted before
  it reaches the shell, and no permission-bypass flags are ever passed. Available
  only in trusted workspaces, consistent with the other controller actions.

## 0.2.0

Compatibility target: `quaat/autonomous-development` **v0.3.0** (revision
`a72f740`), run-state `schema_version` 2 (versions 1 and 2 supported). The full
contract is recorded in [`docs/REFERENCE.md`](../../docs/REFERENCE.md) and pinned
by [`resources/reference-lock.json`](../../resources/reference-lock.json).

### Added

- **Cumulative review ledger.** The dashboard now renders the controller's
  cumulative findings ledger with resolution provenance (`round_opened`,
  `round_last_seen`, `resolved_at_round`, `resolution_source`). Resolved findings
  are shown as released rather than blocking; severe unresolved findings are
  flagged as blocking from the same authoritative decision the gate uses.
- **Acceptance-criteria matrix.** Every cumulative acceptance criterion is shown
  with its status; any status other than `satisfied` is surfaced as blocking
  (fail closed) — acceptance criteria are no longer treated as informational.
- **Review checkpoints / delta context.** The latest review's checkpoint, changed
  paths, and `focused_full_fallback` review context are presented so a delta
  review's scope is visible.
- **Codex token usage.** Per-phase Codex run instrumentation (duration, tokens)
  is summarized when present.
- **Workflow mode.** The resolved effective mode (`lean`/`standard`/`rigorous`)
  drives a mode-aware recommended next action with exact controller parity,
  including the rigorous-only `enhance` phase.
- **Compatibility guard.** Authoritative schemas are mirrored under
  `resources/schemas/` (now including `review-delta`, `triage`, and
  `accept-decisions`), checksum-pinned in `resources/reference-lock.json`, and
  verified by `npm run verify:reference` (run as part of `npm test`).

### Changed

- The shared workflow evaluator in `@semanticmatter/core` is the single source of
  truth for completion gates and next-action across the tree, dashboard, status
  bar, and commands. Completion now fails closed on a `pass` verdict that
  coexists with blocking findings or unsatisfied criteria.
- `docs/REFERENCE.md` rewritten to match the v0.3.0 controller (gate ordering,
  ledger semantics, terminal/mutation-integrity rules, full CLI surface).

### Security

- Artifact pointers remain confined to the run directory; mirrored schemas are
  documentation/contract resources and are not executed.

## 0.1.0

- Initial observer/control-plane release: run discovery, tree views, workflow
  dashboard, artifact navigation and diffs, status bar, notifications, and
  workspace-trust-gated controller actions.
