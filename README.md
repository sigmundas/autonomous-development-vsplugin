# SemanticMatter Autonomous Development

A Visual Studio Code extension that provides an **observer and control plane**
for autonomous-development runs. It discovers and visualizes workflow state,
configures new runs, launches the skill-owned Start and exact-run Resume flows,
and exposes explicit controller actions.

Version 0.4.x requires the maintained
[`sigmundas/autonomous-development`](https://github.com/sigmundas/autonomous-development)
core **>=0.4.0 <0.5.0** for configuration, Start, Resume, and controller
actions. Both projects are derived from the original
[`quaat/autonomous-development`](https://github.com/quaat/autonomous-development)
project; its authorship, history, and MIT license are preserved.

It discovers workflow runs created by the external Python controller, visualizes
their progress and artifacts, compares prompt/specification revisions in the
native diff editor, surfaces verification and review results, and exposes safe
controller actions — without requiring you to navigate the external state
directory by hand. It works even when a run was started entirely outside VS Code.

The extension remains **observer-first**: the core controller and Claude skills
own workflow orchestration. The extension reads their state, provides bounded
configuration and lifecycle controls, and adds a typed, append-only event
protocol (`events.jsonl`). See [ROADMAP.md](ROADMAP.md).

## Features

- **Activity-bar container** with three native tree views: Active, Completed, and
  Archived runs. Each run exposes its id, feature summary, status/phase,
  repository/worktree, verification pass/fail counts, review round vs. budget,
  latest verdict, adversarial-review requirement, and unresolved completion gates.
- **Workflow dashboard** (webview) for a selected run: a stage timeline, current
  status, the prompt/artifact evolution chain, verification commands and results,
  Codex review rounds with findings, adversarial-review state, completion-gate
  failures, and the recommended next action.
- **Artifact viewing & comparison**: open the original feature, enhanced/accepted
  specs, proposed/accepted plans, latest review, and verification logs in normal
  editors; compare _original idea ↔ accepted spec_ and _proposed ↔ accepted plan_
  in the **native VS Code diff editor**. Clicking a review finding opens the file
  at the correct source line.
- **Safe controller actions**: evaluate completion gates, accept repository drift,
  cancel, and archive — each targeting an explicit run id, invoked through an
  argument array (never an interpolated shell string), confirmed before mutating,
  and **disabled in untrusted workspaces**.
- **Live refresh**: watches `run-state.json`, `events.jsonl`, and artifacts, and
  refreshes the UI (debounced) without a manual reload. A malformed or
  half-written file produces a precise diagnostic instead of crashing the view.

## Requirements

- VS Code `^1.85.0`, Node `>=18`.
- For configuration, Start, Resume, and controller actions: a local checkout of
  `sigmundas/autonomous-development` >=0.4.0 <0.5.0 and Python. Observer-only
  discovery and artifact viewing do not require the controller.
- No Claude or Codex credentials are required to run or test the extension.

## Installation

From a packaged `.vsix`:

```bash
npm install
npm run package          # → packages/vscode-extension/semanticmatter-autonomous-development.vsix
code --install-extension packages/vscode-extension/semanticmatter-autonomous-development.vsix
```

## Usage

1. Open a Git repository in VS Code and select the **Autonomous Development**
   activity-bar icon.
2. Runs are discovered from the resolved **state home** (see Configuration). Runs
   started outside VS Code appear automatically.
3. Select a run to open its dashboard; expand a run in the tree for quick details.
4. Use the run's context menu (or the dashboard buttons) to open or compare
   artifacts, inspect reviews, or run controller actions.

If no runs appear, use **Set Up Controller** (or just point
`autonomousDev.stateHome` at your state directory). Observer features work
without a controller.

## Configuration

| Setting                            | Default     | Purpose                                                          |
| ---------------------------------- | ----------- | ---------------------------------------------------------------- |
| `autonomousDev.controllerPath`     | `""`        | Absolute path to `scripts/controller.py`. Empty ⇒ observer-only. |
| `autonomousDev.stateHome`          | `""`        | Override for the state-home directory.                           |
| `autonomousDev.pythonPath`         | `python3`   | Python executable used for controller actions.                   |
| `autonomousDev.autoRefresh`        | `true`      | Refresh views when state files change.                           |
| `autonomousDev.notificationLevel`  | `important` | `all` / `important` / `none`.                                    |
| `autonomousDev.maxEventLogEntries` | `5000`      | Max `events.jsonl` entries retained per run in memory.           |
| `autonomousDev.loadCompletedRuns`  | `true`      | Load terminal runs into Completed.                               |
| `autonomousDev.loadArchivedRuns`   | `false`     | Load archived runs into Archived.                                |

**State-home precedence** (mirrors the reference project): the
`autonomousDev.stateHome` setting → `CLAUDE_AUTONOMOUS_STATE_HOME` →
platform default (`~/.local/state/claude-autonomous` on Linux,
`~/Library/Application Support/claude-autonomous` on macOS,
`%LOCALAPPDATA%/claude-autonomous` on Windows). The legacy in-repo layout
`<repo>/.ai/autonomous-development/` is detected for read-only inspection.

## Development

This is an npm-workspaces TypeScript monorepo:

```
packages/protocol/        # versioned RunEvent protocol (no vscode, no deps)
packages/core/            # state parsing + shared workflow evaluator (no vscode)
packages/vscode-extension # the VS Code UI
resources/                # prompts, schemas, skills mirrored from the reference
docs/                     # REFERENCE.md compatibility contract
```

```bash
npm install            # install all workspaces
npm run build          # build libs (tsc -b) then bundle the extension (esbuild)
npm run typecheck      # strict type-check of host + webview
npm run lint           # eslint
npm test               # protocol + core unit tests (Mocha + node:assert)
npm run test:integration  # VS Code integration tests (downloads VS Code)
npm run package        # produce the .vsix
```

The integration tests launch a real VS Code instance, so the first run downloads
it and requires a display (use `xvfb-run` on headless Linux).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — package boundaries and data flow.
- [PROTOCOL.md](PROTOCOL.md) — the RunEvent envelope and compatibility rules.
- [SECURITY.md](SECURITY.md) — trust boundaries and sensitive-data handling.
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow and coding standards.
- [ROADMAP.md](ROADMAP.md) — planned Claude Agent SDK and Codex app-server adapters.
- [docs/REFERENCE.md](docs/REFERENCE.md) — the exact `quaat/autonomous-development`
  compatibility contract this extension implements.

## License

[MIT](LICENSE).
