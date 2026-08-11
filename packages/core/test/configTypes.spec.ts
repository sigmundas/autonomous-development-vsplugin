import assert from 'node:assert/strict';
import {
  parseClaudeRuntimeList,
  parseClaudeModelList,
  parseConfigValidation,
  parseEffectiveConfiguration,
  parsePresetList,
  parseProfileList,
  parseRunConfigSnapshot
} from '../src/controller/configTypes';

describe('parseEffectiveConfiguration (config-show contract)', () => {
  it('parses a well-formed payload and normalises snake-case keys', () => {
    const raw = {
      config_path: '/tmp/config.toml',
      config_exists: true,
      active_preset: 'azure-autonomous',
      effective: {
        workflow: {
          max_review_rounds: 3,
          process_timeout_seconds: 3600,
          workflow_mode: 'standard',
          reuse_codex_review_context: true
        },
        codex: {
          plan: { profile: 'azure-gpt5p6-sol', reasoning_effort: 'high' },
          review: { profile: 'azure-gpt5p6-sol', reasoning_effort: 'xhigh' }
        },
        claude_runtime: 'azure-claude',
        claude_model: { id: 'sonnet', display_name: 'Sonnet', model: 'sonnet-exact' }
      },
      presets: ['azure-autonomous', 'openai-anthropic'],
      claude_runtimes: ['azure-claude', 'anthropic-claude'],
      warnings: ['Unknown key ignored']
    };
    const parsed = parseEffectiveConfiguration(raw);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.activePreset, 'azure-autonomous');
      assert.equal(parsed.value.effective.workflow.workflowMode, 'standard');
      assert.equal(parsed.value.effective.workflow.maxReviewRounds, 3);
      assert.equal(parsed.value.effective.workflow.reuseCodexReviewContext, true);
      assert.equal(parsed.value.effective.codex.plan?.reasoningEffort, 'high');
      assert.equal(parsed.value.effective.claudeRuntime, 'azure-claude');
      assert.deepEqual(parsed.value.presets, ['azure-autonomous', 'openai-anthropic']);
    }
  });

  it('drops invalid reasoning_effort values (fail-safe defaults)', () => {
    const parsed = parseEffectiveConfiguration({
      effective: {
        codex: { plan: { profile: 'a', reasoning_effort: 'warp-9' } },
        workflow: {}
      }
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.effective.codex.plan?.reasoningEffort, undefined);
      assert.equal(parsed.value.effective.codex.plan?.profile, 'a');
    }
  });

  it('rejects a non-object payload', () => {
    const parsed = parseEffectiveConfiguration('nope');
    assert.equal(parsed.ok, false);
  });
});

describe('parseClaudeModelList', () => {
  it('accepts user-defined model ids and exact CLI values', () => {
    const parsed = parseClaudeModelList({
      claude_models: [{ id: 'custom-opus', display_name: 'My Opus', model: 'provider/custom-opus' }]
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.value.claudeModels[0], {
        id: 'custom-opus',
        displayName: 'My Opus',
        model: 'provider/custom-opus'
      });
    }
  });
});

describe('parseProfileList', () => {
  it('drops malformed profile entries and preserves valid ones', () => {
    const parsed = parseProfileList({
      codex_home: '/home/x/.codex',
      profiles: [
        {
          id: 'azure-gpt5p6-sol',
          label: 'Azure · gpt-5.6-sol',
          provider: 'azure',
          model: 'gpt-5.6-sol',
          path: '/home/x/.codex/azure-gpt5p6-sol.config.toml',
          valid: true
        },
        {
          id: 'broken',
          path: '/home/x/.codex/broken.config.toml',
          valid: false,
          error: 'Invalid statement (at line 3, column 6)'
        },
        // Missing id — dropped.
        { label: 'nameless' },
        // Not an object — dropped.
        'nope'
      ]
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.profiles.length, 2);
      const [good, bad] = parsed.value.profiles;
      assert.equal(good?.id, 'azure-gpt5p6-sol');
      assert.equal(bad?.valid, false);
      assert.equal(bad?.error, 'Invalid statement (at line 3, column 6)');
      // No secret keys smuggled through.
      const anyGood = good as unknown as Record<string, unknown>;
      assert.equal(anyGood['api_key'], undefined);
      assert.equal(anyGood['token'], undefined);
    }
  });
});

describe('parsePresetList', () => {
  it('deduplicates and drops unknown phases', () => {
    const parsed = parsePresetList({
      config_path: '/tmp/config.toml',
      active_preset: 'azure-autonomous',
      presets: [
        {
          name: 'azure-autonomous',
          workflow_mode: 'standard',
          claude_runtime: 'azure-claude',
          phases: ['plan', 'plan', 'review', 'adversarial', 'nonsense']
        }
      ]
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.activePreset, 'azure-autonomous');
      const preset = parsed.value.presets[0];
      assert.equal(preset?.workflowMode, 'standard');
      assert.deepEqual(preset?.phases, ['plan', 'review', 'adversarial']);
    }
  });
});

describe('parseClaudeRuntimeList', () => {
  it('reads best-effort availability flags', () => {
    const parsed = parseClaudeRuntimeList({
      config_path: '/tmp/config.toml',
      claude_runtimes: [
        {
          name: 'azure-claude',
          display_name: 'Azure · Claude',
          launcher: '/usr/local/bin/claude-azure',
          args: ['--flag'],
          allowed_commands: ['ruff'],
          executable_paths: ['/opt/homebrew/bin'],
          launcher_exists: true,
          launcher_executable: true
        },
        {
          name: 'missing',
          launcher: '/nowhere',
          launcher_exists: false,
          launcher_executable: false
        }
      ]
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.claudeRuntimes.length, 2);
      const [first, second] = parsed.value.claudeRuntimes;
      assert.equal(first?.launcherExists, true);
      assert.equal(first?.launcherExecutable, true);
      assert.deepEqual(first?.args, ['--flag']);
      assert.deepEqual(first?.allowedCommands, ['ruff']);
      assert.deepEqual(first?.executablePaths, ['/opt/homebrew/bin']);
      assert.equal(second?.launcherExists, false);
      assert.equal(second?.launcherExecutable, false);
    }
  });
});

describe('parseConfigValidation', () => {
  it('captures both success and error verdicts', () => {
    const okRes = parseConfigValidation({ config_exists: true, valid: true, warnings: [] });
    assert.equal(okRes.ok, true);
    if (okRes.ok) assert.equal(okRes.value.valid, true);
    const badRes = parseConfigValidation({
      config_exists: true,
      valid: false,
      error: 'presets.p.codex.plan.reasoning_effort invalid'
    });
    assert.equal(badRes.ok, true);
    if (badRes.ok) {
      assert.equal(badRes.value.valid, false);
      assert.match(badRes.value.error ?? '', /reasoning_effort/);
    }
  });
});

describe('parseRunConfigSnapshot', () => {
  it('reads a config_snapshot embedded in run-state.json', () => {
    const snap = parseRunConfigSnapshot({
      config_snapshot: {
        preset: 'azure-autonomous',
        workflow: { max_review_rounds: 3, workflow_mode: 'standard' },
        codex: {
          plan: { profile: 'azure-gpt5p6-sol', reasoning_effort: 'high', model: 'gpt-init' }
        },
        claude_runtime: 'azure-claude',
        claude_runtime_snapshot: {
          name: 'azure-claude',
          display_name: 'Azure · Claude',
          launcher: '/usr/local/bin/claude-azure',
          args: ['--profile', 'initial'],
          allowed_commands: ['ruff', 'npm run test'],
          executable_paths: ['/opt/homebrew/bin', '~/.local/bin']
        },
        claude_model: { id: 'sonnet', display_name: 'Sonnet', model: 'sonnet-exact' }
      }
    });
    assert.ok(snap, 'snapshot should be parsed');
    if (snap) {
      assert.equal(snap.preset, 'azure-autonomous');
      assert.equal(snap.workflow?.workflowMode, 'standard');
      assert.equal(snap.codex.plan?.profile, 'azure-gpt5p6-sol');
      assert.equal(snap.codex.plan?.reasoningEffort, 'high');
      assert.equal(snap.claudeRuntime, 'azure-claude');
      assert.deepEqual(snap.claudeRuntimeSnapshot?.args, ['--profile', 'initial']);
      assert.deepEqual(snap.claudeRuntimeSnapshot?.allowedCommands, ['ruff', 'npm run test']);
      assert.deepEqual(snap.claudeRuntimeSnapshot?.executablePaths, [
        '/opt/homebrew/bin',
        '~/.local/bin'
      ]);
      assert.equal(snap.claudeModel?.model, 'sonnet-exact');
    }
  });

  it('returns undefined when the snapshot is absent (legacy runs)', () => {
    assert.equal(parseRunConfigSnapshot({}), undefined);
    assert.equal(parseRunConfigSnapshot(null), undefined);
    assert.equal(parseRunConfigSnapshot('nope'), undefined);
  });
});
