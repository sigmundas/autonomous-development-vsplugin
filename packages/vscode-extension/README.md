# SemanticMatter Autonomous Development

An observer and control plane for the autonomous-development workflow. Version
0.4.x requires the maintained
[`sigmundas/autonomous-development`](https://github.com/sigmundas/autonomous-development)
core **>=0.4.0 <0.5.0** for configuration, Start, Resume, and controller
actions. The controller and this extension are derived from the original
[`quaat/autonomous-development`](https://github.com/quaat/autonomous-development)
project with its authorship, history, and MIT license preserved.

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
- **New Run…** guides you through repository, checkout mode, and feature
  description, then launches one configured Claude session with bounded
  autonomous permissions. The selected skill still owns controller initialization.
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
controller actions, run **Set Up Controller** and point it at the maintained
core 0.4.x `scripts/controller.py`.

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

…or, once the folder is open in VS Code, select **New run…** at the top of Active
Runs (or from the command palette). Choose isolated feature worktree, current
branch, or main, then enter the feature description. The extension opens one
Claude session and submits `autonomous-feature`, `autonomous-current`, or
`autonomous-main` for the chosen mode. The selected skill owns `controller.py
init` and stamps `run-state.json`; the extension does not initialize a run itself.

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

New users should start with the
[Configuration guide](https://github.com/sigmundas/autonomous-development-vsplugin/blob/main/docs/CONFIGURATION.md),
which covers the required files, profile naming, presets, runtimes, and the
four Codex phases without requiring knowledge of the controller API.

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
  effort is set independently for enhance, planning, review, and adversarial
  review.
- `config-list-claude-runtimes` populates the Claude runtime dropdown;
  `config-set-claude-runtime` writes the choice onto the active preset. The
  extension never rewrites Claude credentials or provider API keys — it only
  records which pre-installed launcher script to spawn.

Selecting a preset or Claude runtime changes what **new** runs use. Existing
runs continue to execute with the configuration snapshot the controller pinned
into `run-state.json` at init time, and the dashboard displays that snapshot
read-only so you can see exactly what the run was created with.

### New Run

**New Run…** asks for a run mode and feature description, validates workspace
trust, resolves the selected Claude runtime, and verifies that its launcher
exists and is executable. It opens one Claude session in the selected workspace
folder with the launcher's configured arguments and the shared bounded
autonomous permission policy. The command fails clearly when:

- no controller is configured (Set Up Controller is offered),
- no Claude runtime is selected,
- the launcher path is missing, or
- the launcher is not executable.

The launcher owns the Claude provider, deployment/model, and reasoning effort;
the extension does not edit those directly. The extension submits the selected
autonomous skill as Claude's initial prompt. That skill—not the extension—
initializes and drives the controller run. The older
`autonomousDev.openAutonomousClaude` and `autonomousDev.launchClaude` command IDs
are compatibility aliases for the same Start implementation.

Once the selected skill creates its run, the extension associates that original
terminal with the new run using the repository identity and the run IDs observed
before launch. If the evidence is ambiguous, it leaves the terminal unbound
rather than guessing. The run action then becomes **Focus Claude Terminal** and
reuses the same live terminal.

If that terminal exits while the controller run remains active, the action
becomes **Resume in Claude**. Resume opens one replacement session and submits
`/autonomous-development:autonomous-resume <run-id>` automatically. That
dedicated skill recovers the exact existing run from controller state; it never
calls `init`, invokes a Start skill, or depends on the previous conversation.
The user does not type `continue` or invoke a Start skill again.
`AUTODEV_RUN_ID` is still set as terminal identity metadata, but the explicit
skill argument is the model-visible workflow identity. Resume uses the
configured absolute plugin/controller root and the same bounded `dontAsk`
permission policy as Start. The full safety and recovery contract lives in the
controller plugin's `skills/autonomous-resume/SKILL.md`.

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

| Situation                                                        | Likely cause                                                          | What to do                                                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Controller not configured" in the Configuration tree            | `autonomousDev.controllerPath` is empty                               | Run **Set Up Controller** to point at `scripts/controller.py`.                                                                                                         |
| Dropdowns are empty                                              | The controller succeeded but no profiles/presets/runtimes are defined | Follow the [Configuration guide](https://github.com/sigmundas/autonomous-development-vsplugin/blob/main/docs/CONFIGURATION.md) to create them.                         |
| A phase profile is flagged as missing or invalid                 | `$CODEX_HOME` does not contain the selected profile                   | Install / fix the Codex profile under `~/.codex/`.                                                                                                                     |
| "Launcher not executable" when launching Claude                  | The launcher file exists but its executable bit is not set            | `chmod +x` the launcher, then re-run **Start Autonomous Run**.                                                                                                         |
| Azure Codex fails on its first real phase with codex-cli 0.147.0 | Upstream Responses Lite tool serialization is incompatible with Azure | Temporarily pin codex-cli 0.146.1; see the [controller compatibility note](https://github.com/sigmundas/autonomous-development#azure-openai--codex-cli-compatibility). |

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

The extension still uses the existing snapshot/polling interface for workflow
activity. Terminal association is intentionally narrower: it observes only
repository-scoped, baseline-aware run discovery and never infers live tool
events from the terminal.

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
