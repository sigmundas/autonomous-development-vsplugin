# SemanticMatter Autonomous Development

An observer and visual control plane for the
[`quaat/autonomous-development`](https://github.com/quaat/autonomous-development)
autonomous feature-development workflow.

Discover workflow runs, inspect their progress and artifacts, compare prompt and
specification revisions in the native diff editor, review verification and Codex
review results, and invoke safe controller actions — without leaving VS Code, and
even when a run was started outside it.

## Features

- **Pre-run configuration** in a dedicated activity-bar entry that is available
  before any run exists — presets, per-phase Codex profile and reasoning-effort
  dropdowns, and Claude runtime selection. Every option flows through the
  controller's `config-*` subcommands; the extension never rewrites your normal
  OpenAI Codex or Claude configuration.
- **Active / Completed / Archived** run views in a dedicated activity-bar
  container, each run showing status, phase, verification pass/fail, review round
  vs. budget, latest verdict, adversarial-review requirement, and unresolved
  completion gates.
- A **workflow dashboard** per run: stage timeline, current status, the
  original-idea → enhanced → accepted spec → proposed → accepted plan chain,
  verification commands and results, Codex review rounds and findings, and the
  recommended next action — all derived from one shared workflow model.
- Open any artifact in a normal editor; **compare** original↔accepted spec and
  proposed↔accepted plan in the **native diff editor**; click a finding to jump to
  its source line.
- **Start Autonomous Run** launches one configured Claude session with bounded
  autonomous permissions; the selected skill owns controller initialization.
- **Safe controller actions** (evaluate gates, accept drift, cancel, archive)
  run via argument arrays (never a shell), confirm before mutating, and are
  disabled in untrusted workspaces.
- Live, debounced refresh on state changes; malformed artifacts produce a
  diagnostic instead of crashing the view.

## Getting started

1. Open the **Autonomous Development** activity-bar view.
2. Runs are discovered from the resolved state home — the
   `autonomousDev.stateHome` setting, else `CLAUDE_AUTONOMOUS_STATE_HOME`, else the
   platform default. The legacy `<repo>/.ai/autonomous-development/` layout is
   detected read-only.
3. Select a run to open its dashboard.

Observer features need no controller and no Claude/Codex credentials. To enable
controller actions, run **Set Up Controller** and point it at your
`quaat/autonomous-development` `scripts/controller.py`.

> **The one rule that matters:** runs are scoped to the open folder's **git
> identity**. The extension only lists runs that belong to the repository you have
> open. Always open in VS Code the _exact same folder_ the controller ran in — this
> is the usual reason a run "doesn't show up."

## Start a new project, end to end

**1. Make the project a git repository with at least one commit.** The run's
identity (and its folder under the state home) is derived from the git common-dir
and first commit, so a non-git folder produces no discoverable run.

```bash
mkdir my-project && cd my-project
git init && git commit --allow-empty -m "Initial commit"
```

**2. Start the autonomous run from inside that folder.** Either let the Claude
plugin drive the full loop:

```bash
cd my-project
claude --plugin-dir /path/to/autonomous-development
# then invoke the /autonomous-development:autonomous-feature skill and describe the feature
```

…or bootstrap a run directly with the controller (creates the run state the
extension will display):

```bash
cd my-project
python3 /path/to/autonomous-development/scripts/controller.py \
  init --feature "Describe the feature here" --mode auto
```

…or, once the folder is open in VS Code, run **Start Autonomous Run** from the
Active Runs view title (the `+` button) or the command palette. The extension
opens exactly one Claude session with the selected runtime and bounded
autonomous permission policy. Invoke `autonomous-feature`,
`autonomous-current`, or `autonomous-main` in that session and provide the
feature description. The selected skill owns `controller.py init` and stamps
`run-state.json` as it begins; the extension does not initialize a run itself.

**3. Open the same folder in VS Code** (File → Open Folder → `my-project`). It must
be the repository the controller ran in — not a parent or subfolder.

**4. Follow progress.** The **Active / Completed / Archived** views populate, and
**Open Workflow Dashboard** shows the live phase, verification results, Codex review
rounds and findings, acceptance-criteria status, adversarial-review requirement,
completion gates, and recommended next action. The view refreshes as the controller
writes state; **Refresh Runs** forces a reload.

### If the view stays empty

| Symptom                                                            | Likely cause                                                   | Fix                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| "No runs found **for this workspace**"                             | A different folder is open than where the run was created      | Open the exact repository the controller ran in                                                      |
| Empty even with the right folder                                   | The run isn't in the _Active_ group                            | Check the Completed / Archived views (and the `loadCompletedRuns` / `loadArchivedRuns` settings)     |
| No runs anywhere                                                   | State home mismatch                                            | Align `autonomousDev.stateHome` with the controller's state home (or `CLAUDE_AUTONOMOUS_STATE_HOME`) |
| Controller "not found" when driven from a sandboxed Claude session | The sandbox denies reading the plugin / writing the state home | Allow reads of the plugin dir and reads+writes of the state home in your Claude sandbox settings     |

## Pre-run configuration

The **Configuration** entry in the Autonomous Development activity-bar container
is visible immediately when you open a workspace — even before any run has been
created and before the state-home directory exists. Selecting it opens the
configuration editor: presets, per-phase Codex profiles, reasoning effort, and
the Claude runtime the extension will launch for you.

Everything the editor changes goes through the controller's JSON contract:

- `config-list-profiles` populates the per-phase Codex profile dropdowns from
  the profiles discovered under `$CODEX_HOME`. Provider and model names come
  from the controller — the extension never hard-codes them.
- `config-list-presets` populates the preset dropdown; selecting a preset calls
  `config-set-active-preset`, then reloads `config-show` and refreshes every
  displayed value from the controller response.
- `config-set-phase` writes the per-phase profile and reasoning effort. Reasoning
  effort is set independently for planning, review, and adversarial review.
- `config-list-claude-runtimes` populates the Claude runtime dropdown;
  `config-set-claude-runtime` writes the choice onto the active preset. The
  extension never rewrites Claude credentials or provider API keys — it only
  records which pre-installed launcher script to spawn.

Selecting a preset or Claude runtime changes what **new** runs use. Existing
runs continue to execute with the configuration snapshot the controller pinned
into `run-state.json` at init time, and the dashboard displays that snapshot
read-only so you can see exactly what the run was created with.

### Start Autonomous Run

**Start Autonomous Run** validates workspace trust, resolves the selected
Claude runtime, and verifies that its launcher exists and is executable. It
opens one Claude session in the selected workspace folder with the launcher's
configured arguments and the shared bounded autonomous permission policy. The
command fails clearly when:

- no controller is configured (Set Up Controller is offered),
- no Claude runtime is selected,
- the launcher path is missing, or
- the launcher is not executable.

The launcher owns the Claude provider, deployment/model, and reasoning effort;
the extension does not edit those directly. After Claude opens, invoke one of
the autonomous skills shown in the terminal notification. That skill—not the
extension—initializes and drives the controller run. The older
`autonomousDev.openAutonomousClaude` and `autonomousDev.launchClaude` command IDs
are compatibility aliases for the same Start implementation.

### Workflow mode and maximum review rounds

You can see the workflow mode and maximum review rounds in the Configuration
editor, but you can't change them from there yet. To change them, either edit
`config.toml` by hand, or pick a different preset that already has the values
you want. When we add a way to edit these directly, the panel will grow the
right controls for them.

### Selecting an autonomous Codex profile

Autonomous Codex profiles selected from this extension are used only via
`codex exec --profile <id>` when the controller invokes Codex on the
autonomous-development phases. This selection does **not** modify the normal
OpenAI Codex VS Code extension's OpenAI configuration in any way. The
extension never writes to `~/.codex/config.toml` or `~/.codex/*.config.toml`,
and it never persists Claude credentials or provider API keys.

### Troubleshooting

| Situation                                                             | Likely cause                                                       | What to do                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| "Controller not configured" in the Configuration tree                 | `autonomousDev.controllerPath` is empty                            | Run **Set Up Controller** to point at `scripts/controller.py`.            |
| Dropdowns are empty                                                   | The controller succeeded but no profiles/presets/runtimes are defined | Add them to `config.toml` (see the controller's `docs/config-contract.md`) |
| A phase profile is flagged as missing or invalid                      | `$CODEX_HOME` does not contain the selected profile                | Install / fix the Codex profile under `~/.codex/`.                        |
| "Launcher not executable" when launching Claude                       | The launcher file exists but its executable bit is not set         | `chmod +x` the launcher, then re-run **Start Autonomous Run**.            |
| Azure Codex fails on its first real phase with codex-cli 0.147.0      | Upstream Responses Lite tool serialization is incompatible with Azure | Temporarily pin codex-cli 0.146.1; see the [controller compatibility note](https://github.com/sigmundas/autonomous-development#azure-openai--codex-cli-compatibility). |

With the validated Azure profile, a large `/models` catalog-decode warning can
still appear under codex-cli 0.146.1. That warning is non-fatal when the direct
Codex invocation continues to `turn.completed` with exit code 0; it does not
indicate a VSIX preset or profile-selection failure.

## Deferred: live activity streaming

The dashboard's **Current activity** section is deliberately limited to data the
extension already has: the controller's authoritative phase, next-action
summary, the latest run-state note (if any), whether the extension is currently
tracking a Claude terminal for the run, and the run's last-update timestamp.

Detailed live activity such as:

    Reading ui/main_window.py
    Running tests/test_reference_plot.py
    Codex finding created

requires additive integrations planned for future iterations:

- **Live RunEvent emission** from the controller into the extension host
  (currently the extension polls `run-state.json` and reads `events.jsonl` at
  refresh time).
- A **Claude Agent SDK adapter** to observe Claude's tool use in real time.
- A **Codex app-server adapter** to observe Codex's per-tool events.

There is also a known Start-session association gap: the extension opens the
generic Autonomous Claude terminal before the selected skill creates a
controller run, so that terminal does not yet carry a run id. The dashboard may
therefore say **Claude terminal: not open** while the initial Claude session is
visibly running. This is a display/association limitation, not evidence that
the session stopped; terminal-to-run association requires a separate design
pass.

These are explicitly deferred from the current change. This iteration keeps the
existing snapshot/polling interface accurate and usable rather than inventing a
new live-event protocol.

## Key settings

`autonomousDev.controllerPath`, `autonomousDev.stateHome`,
`autonomousDev.pythonPath`, `autonomousDev.autoRefresh`,
`autonomousDev.notificationLevel`, `autonomousDev.maxEventLogEntries`,
`autonomousDev.loadCompletedRuns`, `autonomousDev.loadArchivedRuns`.

See the repository for architecture, protocol, and security documentation.

## Development

The extension runtime remains compatible with the Node version declared in the
manifest, but the current integration-test toolchain requires **Node 22 or
newer** (`@vscode/test-electron` 3.1.0). Use Node 22+ when installing
development dependencies or running `npm run test:integration`.

## License

MIT.
