# Configuration

Autonomous Development uses its own `config.toml` for workflow choices. Codex
profiles are separate TOML files in your Codex home. A preset connects those
pieces for each new autonomous run.

The configuration panel exposes **Reuse Codex reviewer context between
rounds**. It applies to new runs and is snapshotted for reproducibility.
Regular and adversarial reviews use separate sessions; planning and enhancement
never share them. Sessions rotate after a bounded window, and disabling the
option starts every review round fresh.

Active-run dashboards provide **Continue in fresh Claude session**. The current
terminal integration has no reliable machine-readable context measurement, so
context is reported as unavailable. A live managed terminal must be closed at
a safe boundary before the extension launches the replacement for the same run.

## Quick setup

1. In VS Code, run **Autonomous Development: Set Up Controller** and select the
   controller's `scripts/controller.py` file.
2. Open **Autonomous Development: Configure**. The page shows the resolved
   location of Autonomous Development's `config.toml`. Create the file there if
   it does not exist; the [complete example](#complete-example) is a usable
   starting point.
3. Create one or more Codex profile files in `$CODEX_HOME`, or in `~/.codex` if
   `CODEX_HOME` is not set. Name each file `<profile-id>.config.toml`.
4. In Autonomous Development's `config.toml`, define a Claude runtime when you
   want VS Code to start Claude for new runs. Its launcher must be an existing,
   executable file. Optionally define the Claude models offered by your account
   or provider.
5. Define a preset that names the workflow mode, Claude runtime, optional Claude
   model, and Codex settings for the four phases.
6. Assign a Codex profile and reasoning effort to Enhance, Planning, Review,
   and Adversarial review in the preset.
7. Return to the VS Code Configuration page, click **Refresh**, and select the
   preset. You can adjust the runtime and per-phase Codex choices there.
8. Click **Re-validate** and fix any missing profile, invalid TOML, or launcher
   warning.
9. Start a new run. Configuration changes affect new runs; an active run keeps
   the configuration snapshot saved when it was created.

## Files and locations

### Autonomous Development config

This is the workflow configuration file. The current resolved path is shown at
the top of the VS Code Configuration page, which is the best path to use.

Unless a state-home or config-path override is active, the defaults are:

- macOS: `~/Library/Application Support/claude-autonomous/config.toml`
- Linux: `$XDG_STATE_HOME/claude-autonomous/config.toml`, or
  `~/.local/state/claude-autonomous/config.toml` when `XDG_STATE_HOME` is unset
- Windows: `%LOCALAPPDATA%\claude-autonomous\config.toml`

`CLAUDE_AUTONOMOUS_STATE_HOME` changes the state home, and the VS Code
`autonomousDev.stateHome` setting can override it for extension-driven actions.
An explicit controller config path can also change the location. The resolved
path in the Configuration page accounts for these choices.

This file contains workflow settings, presets, Claude-runtime definitions, and
Claude-model definitions.
Do not put API keys, tokens, or passwords in it.

### Codex profiles

The controller discovers profile files directly under `$CODEX_HOME`. If that
environment variable is not set, the normal Codex home is `~/.codex`.

The filename determines the selectable profile id:

```text
~/.codex/azure-gpt5p6-sol.config.toml
→ profile id: azure-gpt5p6-sol
```

The general rule is:

```text
<CODEX_HOME>/<profile-id>.config.toml
→ profile id: <profile-id>
```

For example, a profile file can contain the Codex settings for its provider and
model:

```toml
model = "gpt-5.6-sol"
model_provider = "azure"
```

Use values that are valid for your Codex installation and provider. Autonomous
Development reads enough metadata to list the profile, then selects it for a
phase by its id; it does not rewrite the profile.

`~/.codex/config.toml` is Codex's base configuration. It is deliberately not a
selectable autonomous profile. Only files ending in `.config.toml` with a name
before that suffix are listed. A malformed profile file remains visible as
invalid so you can find and fix it instead of having it disappear silently.

## What is a preset?

A preset is a named collection of defaults for a new autonomous run. It groups:

- the workflow mode (`auto`, `lean`, `standard`, or `rigorous`);
- the Claude runtime;
- the optional Claude model;
- the Codex profile used for each phase; and
- the reasoning effort used for each phase.

Define presets under `[presets.<name>]` in Autonomous Development's
`config.toml`. Set `active_preset` to the default name, or select another preset
from the VS Code Configuration page. Changing the active preset does not alter
an already-active run.

## What is a Claude runtime?

A Claude runtime is a named Claude setup used when VS Code starts a new
autonomous session. Define it under `[claude_runtimes.<name>]` in Autonomous
Development's `config.toml` with a display name and an absolute launcher path.
The launcher must exist and be executable.

The runtime definition identifies how to start Claude; credentials and
provider-specific secrets remain in that Claude setup, outside Autonomous
Development's config file. Changing the selected runtime affects new sessions
only.

Autonomous sessions use Claude's non-interactive `dontAsk` mode with a bounded
development-command profile. Read-only Git commands, Python, `uv`, `pytest`, and
Codex are included. Add repository-specific command prefixes and executable
search directories to the selected runtime without granting arbitrary Bash:

```toml
[claude_runtimes.anthropic]
display_name = "Anthropic · Claude"
launcher = "/Users/yourname/bin/claude-anthropic-autonomous"
allowed_commands = ["ruff", "npm run test"]
executable_paths = ["/opt/homebrew/bin", "~/.local/bin"]
```

Each `allowed_commands` entry must be a simple executable or subcommand prefix;
shell operators, shell launchers, and destructive or unbounded Git commands are
rejected. Run compound checks as separate tool calls. `executable_paths` is
prepended to the inherited PATH for both Claude and controller verification, so
`run-check -- uv --version` resolves the same tool without a login-shell wrapper.
The absolute Claude launcher directory is also prepended automatically; a
launcher at `/opt/homebrew/bin/claude` therefore exposes sibling Homebrew tools
without additional configuration.

## What is a Claude model?

A Claude model is the model requested for a Claude session, independently of
the runtime that supplies its launcher, authentication, and provider
environment. Define selectable models under `[claude_models.<id>]` with a
friendly `display_name` and the exact value your Claude Code installation
accepts for `claude --model`:

```toml
[claude_models.sonnet]
display_name = "Sonnet"
model = "sonnet"

[claude_models.opus]
display_name = "Opus"
model = "opus"

[claude_models.sonnet46-foundry]
display_name = "Sonnet 4.6 · 1M"
model = "claude-sonnet-4-6"

[claude_models.opus48-foundry]
display_name = "Opus 4.8 · 1M"
model = "claude-opus-4-8"
```

These entries are examples, not a hardcoded catalog. Use the precise model
values supported by your account/provider, including custom names when needed.
Set `claude_model = "<id>"` on a preset to select one. Choosing **Default** in
VS Code removes that preset setting and launches Claude without `--model`.
Model changes affect new runs only; an existing run resumes with its saved
model selection.

## What the Codex phases do

- **Enhance** refines the initial feature request before planning.
- **Planning** produces an independent implementation plan.
- **Review** reviews the implementation after verification.
- **Adversarial review** challenges assumptions and risks for rigorous or
  high-risk work.

Each phase can use a different profile and reasoning effort. Reusing one profile
with different effort levels is also valid.

## Complete example

Save this as Autonomous Development's resolved `config.toml`, then replace the
launcher path and ensure the referenced Codex profile exists.

```toml
version = 1
active_preset = "azure-codex-anthropic"

[workflow]
max_review_rounds = 3
workflow_mode = "standard"

[presets.azure-codex-anthropic]
workflow_mode = "standard"
claude_runtime = "anthropic"
claude_model = "sonnet"

[presets.azure-codex-anthropic.codex.enhance]
profile = "azure-gpt5p6-sol"
reasoning_effort = "medium"

[presets.azure-codex-anthropic.codex.plan]
profile = "azure-gpt5p6-sol"
reasoning_effort = "high"

[presets.azure-codex-anthropic.codex.review]
profile = "azure-gpt5p6-sol"
reasoning_effort = "xhigh"

[presets.azure-codex-anthropic.codex.adversarial]
profile = "azure-gpt5p6-sol"
reasoning_effort = "xhigh"

[claude_runtimes.anthropic]
display_name = "Anthropic · Claude"
launcher = "/Users/yourname/bin/claude-anthropic-autonomous"

[claude_models.sonnet]
display_name = "Sonnet"
model = "sonnet"

[claude_models.opus]
display_name = "Opus"
model = "opus"

[claude_models.sonnet46-foundry]
display_name = "Sonnet 4.6 · 1M"
model = "claude-sonnet-4-6"

[claude_models.opus48-foundry]
display_name = "Opus 4.8 · 1M"
model = "claude-opus-4-8"
```

The matching profile file is:

```text
~/.codex/azure-gpt5p6-sol.config.toml
```

If you use a custom `CODEX_HOME`, put the same filename there instead.

## Validate and start

After editing TOML outside VS Code, click **Refresh** before selecting values.
Then click **Re-validate**. Validation checks the preset references, profile
files, reasoning-effort values, and Claude launcher status without invoking the
launcher.

Common setup problems are:

- **No profiles in the dropdown:** check the effective Codex home shown in the
  Configuration page and the `.config.toml` filename suffix.
- **Profile is missing:** the preset's `profile` must exactly match the filename
  without `.config.toml`.
- **Profile is invalid:** open that profile and fix its TOML syntax.
- **Launcher is missing or not executable:** correct the absolute path and make
  the launcher executable before starting a session.
- **Model does not appear:** add a `[claude_models.<id>]` definition, save the
  file, and click **Refresh**.
- **Preset does not appear:** define it in Autonomous Development's
  `config.toml`, save the file, and click **Refresh**.

For the controller's full schema and API details, see the
[configuration contract](https://github.com/sigmundas/autonomous-development/blob/main/docs/config-contract.md).
