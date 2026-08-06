# SemanticMatter Autonomous Development

A read-only observer and visual control plane for the
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
- **Safe controller actions** (start run, evaluate gates, accept drift, cancel,
  archive) that run via argument arrays (never a shell), confirm before mutating,
  and are disabled in untrusted workspaces.
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

…or, once the folder is open in VS Code, run **Start Run** from the Active Runs
view title (the `+` button) or the command palette. It prompts for a feature
description, then opens an integrated terminal in the repository, launches
`claude --plugin-dir …`, and pre-fills the
`/autonomous-development:autonomous-feature` skill command — you review it and
press **Enter** to start the run (trusted workspaces only). This launches the
Claude driver itself, so there is no separate `controller.py init` step and no
orphan run; the skill stamps `run-state.json` under
`<state-home>/repositories/<repo-id>/runs/<run-id>/` as it begins.

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

### Start Run preflight

**Start Run** shows a modal preflight summary — active preset, Claude runtime,
per-phase Codex profile and reasoning effort, workflow mode, and the maximum
review-round budget — with three choices: Start, Configure, Cancel.

When a controller is configured, the extension itself calls
`controller.py init --preset <name> --feature <text> --worktree-mode isolated`
via a safe argv array. `--preset` is a separate argv element — never embedded
in the feature text, never assembled by natural-language prompting. This is
what pins the run's `config_snapshot` deterministically to the selected preset.
After a successful init, the extension opens an integrated terminal with a bare
`claude --plugin-dir <root>` line in the initialized worktree so the user can
drive the run manually; the extension does **not** invoke the
`autonomous-feature` skill in that terminal because the skill's own `init`
would create a second run rather than resume the one just initialized. A future
skill contract with a structured `--run-id` argument would allow the extension
to invoke the skill directly against the initialized run.

If no controller is configured, Start Run falls back to the legacy
skill-driven-init flow. In that mode the preset cannot be forwarded — the skill
takes `$ARGUMENTS` as raw feature text — so the extension does not attempt to
pass one.

### Launch Claude for Selected Preset

The **Launch Claude for Selected Preset** command validates workspace trust,
that a runtime is selected, and that its launcher path both exists and is
executable, then opens a new integrated terminal in the workspace folder and
**executes** the launcher via a safe argv array built by the extension's
platform-appropriate quoter (POSIX single-quoting or Windows argv encoding).
No shell interpolation is ever applied to controller-provided values. The
command fails clearly when:

- no controller is configured (Set Up Controller is offered),
- no Claude runtime is selected,
- the launcher path is missing, or
- the launcher is not executable.

The selection chooses which pre-installed **launcher script** the extension
spawns. The launcher owns the Claude provider, deployment/model, and reasoning
effort — this version of the extension does not edit those directly. Selection
applies only to **newly launched** Claude Code sessions; it never changes the
provider of an already-running session.

### Workflow mode and maximum review rounds

Workflow mode and `max_review_rounds` are shown in the Configuration editor
read-only. The controller config contract does not currently expose mutating
commands for these fields — they are edited by hand in `config.toml` (or by
selecting a different preset whose `workflow_mode` differs). If a future
`config-set-workflow` command is added, the extension will consume it and
expose editable controls in the same panel.

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
| "Launcher not executable" when launching Claude                       | The launcher file exists but its executable bit is not set         | `chmod +x` the launcher, then re-run **Launch Claude for Selected Preset**. |

## Key settings

`autonomousDev.controllerPath`, `autonomousDev.stateHome`,
`autonomousDev.pythonPath`, `autonomousDev.autoRefresh`,
`autonomousDev.notificationLevel`, `autonomousDev.maxEventLogEntries`,
`autonomousDev.loadCompletedRuns`, `autonomousDev.loadArchivedRuns`.

See the repository for architecture, protocol, and security documentation.

## License

MIT.
