import assert from 'node:assert/strict';

import { ConfigStore, friendlyProfileLabel, reasoningEffortLabel } from '../src/configStore';
import { toView } from '../src/config/configPanel';
import type { ConfigClient } from '../src/controller/configClient';
import type { OutputLog } from '../src/output';
import { discoverRunsForRepositories } from '../src/runStore';
import { buildFixtures } from './fixtures';

describe('friendlyProfileLabel', () => {
  it('prefers the controller-provided label when present', () => {
    assert.equal(
      friendlyProfileLabel({
        id: 'azure-gpt5p6-sol',
        label: 'Azure · GPT-5.6 Sol',
        provider: 'azure',
        model: 'gpt-5.6-sol'
      }),
      'Azure · GPT-5.6 Sol'
    );
  });

  it('derives a provider · model label when no explicit label is present', () => {
    assert.equal(
      friendlyProfileLabel({ id: 'azure-gpt5p6-sol', provider: 'azure', model: 'gpt-5.6-sol' }),
      'Azure · gpt-5.6-sol'
    );
  });

  it('falls back to the id when neither label nor provider/model is present', () => {
    assert.equal(friendlyProfileLabel({ id: 'unlabeled' }), 'unlabeled');
  });
});

describe('reasoningEffortLabel', () => {
  it('maps controller effort ids to display labels', () => {
    assert.equal(reasoningEffortLabel('minimal'), 'Minimal');
    assert.equal(reasoningEffortLabel('low'), 'Low');
    assert.equal(reasoningEffortLabel('medium'), 'Medium');
    assert.equal(reasoningEffortLabel('high'), 'High');
    assert.equal(reasoningEffortLabel('xhigh'), 'XHigh');
  });

  it('returns the input verbatim for unknown values (forward compatible)', () => {
    assert.equal(reasoningEffortLabel('turbo'), 'turbo');
  });
});

describe('global configuration outside a repository', () => {
  it('loads all configuration surfaces without a workspace project root', async () => {
    const calls: string[] = [];
    const client = {
      isConfigured: () => true,
      show: async () => {
        calls.push('show');
        return {
          configPath: '/state/config.toml',
          configExists: true,
          activePreset: 'global',
          effective: {
            workflow: { workflowMode: 'standard', maxReviewRounds: 3 },
            claudeRuntime: 'local',
            claudeModel: { id: 'custom', displayName: 'Custom Model', model: 'custom/exact' },
            codex: {}
          },
          origin: {},
          warnings: [],
          presets: ['global'],
          claudeRuntimes: ['local'],
          claudeModels: ['custom']
        };
      },
      listPresets: async () => {
        calls.push('presets');
        return {
          configPath: '/state/config.toml',
          activePreset: 'global',
          presets: [{ name: 'global', phases: [] }]
        };
      },
      listProfiles: async () => {
        calls.push('profiles');
        return {
          codexHome: '/codex',
          profiles: [{ id: 'azure', valid: true }]
        };
      },
      listClaudeRuntimes: async () => {
        calls.push('runtimes');
        return {
          configPath: '/state/config.toml',
          claudeRuntimes: [
            {
              name: 'local',
              launcher: '/bin/sh',
              args: [],
              launcherExists: true,
              launcherExecutable: true
            }
          ]
        };
      },
      listClaudeModels: async () => {
        calls.push('models');
        return {
          configPath: '/state/config.toml',
          claudeModels: [{ id: 'custom', displayName: 'Custom Model', model: 'custom/exact' }]
        };
      },
      validate: async () => {
        calls.push('validate');
        return {
          configPath: '/state/config.toml',
          configExists: true,
          valid: true,
          warnings: []
        };
      }
    } as unknown as ConfigClient;
    const log = { warn: () => undefined } as unknown as OutputLog;
    const store = new ConfigStore(client, log);

    const snapshot = await store.refresh();
    const view = toView(snapshot);

    assert.deepEqual(calls.sort(), [
      'models',
      'presets',
      'profiles',
      'runtimes',
      'show',
      'validate'
    ]);
    assert.equal(view.activePreset, 'global');
    assert.equal(view.presets[0]?.name, 'global');
    assert.equal(view.profiles[0]?.id, 'azure');
    assert.equal(view.claudeRuntimes[0]?.name, 'local');
    assert.equal(view.claudeModels[0]?.displayName, 'Custom Model');
    assert.equal(view.claudeModel?.model, 'custom/exact');
    store.dispose();
  });
});

describe('repository-scoped run discovery', () => {
  it('shows no unrelated runs when no repository resolves or a different repository is open', () => {
    const fixtures = buildFixtures();
    try {
      assert.deepEqual(discoverRunsForRepositories(fixtures.stateHome, new Set()), []);
      assert.deepEqual(
        discoverRunsForRepositories(fixtures.stateHome, new Set(['repository-b'])),
        []
      );
      assert.ok(
        discoverRunsForRepositories(fixtures.stateHome, new Set([fixtures.repoId])).length > 0
      );
    } finally {
      fixtures.cleanup();
    }
  });
});
