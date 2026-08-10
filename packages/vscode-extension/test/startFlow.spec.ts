import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { createStartRunCommandHandler, NEW_AUTONOMOUS_SESSION_COMMAND_IDS } from '../src/commands';

describe('normal Start flow', () => {
  it('routes primary and compatibility command IDs through one handler', () => {
    assert.deepEqual(NEW_AUTONOMOUS_SESSION_COMMAND_IDS, [
      'autonomousDev.startRun',
      'autonomousDev.openAutonomousClaude',
      'autonomousDev.launchClaude'
    ]);
  });

  it('resolves the project root and opens exactly one Autonomous Claude session', async () => {
    let resolveCalls = 0;
    const opened: { root: string; mode: string; feature: string }[] = [];
    const handler = createStartRunCommandHandler({
      resolveProjectRoot: async () => {
        resolveCalls += 1;
        return '/work/repo';
      },
      selectRunMode: async () => 'feature',
      promptFeature: async () => 'Add run history',
      openAutonomousClaude: async (projectRoot, bootstrap) => {
        opened.push({ root: projectRoot, ...bootstrap });
      }
    });

    await handler();

    assert.equal(resolveCalls, 1);
    assert.deepEqual(opened, [{ root: '/work/repo', mode: 'feature', feature: 'Add run history' }]);
  });

  it('does not open a session when project-root selection is cancelled', async () => {
    let openCalls = 0;
    const handler = createStartRunCommandHandler({
      resolveProjectRoot: async () => undefined,
      selectRunMode: async () => 'feature',
      promptFeature: async () => 'Feature',
      openAutonomousClaude: async () => {
        openCalls += 1;
      }
    });

    await handler();

    assert.equal(openCalls, 0);
  });

  it('does not launch when mode selection is cancelled', async () => {
    let openCalls = 0;
    const handler = createStartRunCommandHandler({
      resolveProjectRoot: async () => '/work/repo',
      selectRunMode: async () => undefined,
      promptFeature: async () => 'Feature',
      openAutonomousClaude: async () => {
        openCalls += 1;
      }
    });
    await handler();
    assert.equal(openCalls, 0);
  });

  it('does not launch when the feature description is cancelled', async () => {
    let openCalls = 0;
    const handler = createStartRunCommandHandler({
      resolveProjectRoot: async () => '/work/repo',
      selectRunMode: async () => 'current',
      promptFeature: async () => undefined,
      openAutonomousClaude: async () => {
        openCalls += 1;
      }
    });
    await handler();
    assert.equal(openCalls, 0);
  });

  it('has one production Start path and no controller-owned init helper', () => {
    const extensionRoot = path.resolve(__dirname, '../..');
    const commandsSource = readFileSync(path.join(extensionRoot, 'src/commands/index.ts'), 'utf8');
    const controllerCommandsSource = readFileSync(
      path.join(extensionRoot, 'src/commands/controllerCommands.ts'),
      'utf8'
    );
    const launcherSource = readFileSync(
      path.join(extensionRoot, 'src/config/claudeLauncher.ts'),
      'utf8'
    );
    assert.doesNotMatch(commandsSource, /controller\.startRun\s*\(/);
    assert.match(commandsSource, /openAutonomousClaudeInWorkspace\s*\(/);
    assert.doesNotMatch(controllerCommandsSource, /export async function startRun/);
    assert.doesNotMatch(controllerCommandsSource, /\.execute\(['"]init['"]/);
    assert.doesNotMatch(controllerCommandsSource, /\.sendText\s*\(/);
    assert.doesNotMatch(launcherSource, /launchClaudeForSelectedPreset|LaunchClaudeDeps/);
    assert.doesNotMatch(launcherSource, /\.sendText\s*\(/);
  });

  it('renders Claude runtime and model as independent selectors with Default', () => {
    const extensionRoot = path.resolve(__dirname, '../..');
    const source = readFileSync(path.join(extensionRoot, 'src/config/webview/main.ts'), 'utf8');
    assert.match(source, /id = 'claude-select'/);
    assert.match(source, /id = 'claude-model-select'/);
    assert.match(source, /defaultModel\.textContent = 'Default'/);
    assert.match(source, /type: 'setClaudeModel'/);
  });

  it('keeps one primary Start action and hides compatibility aliases from the palette', () => {
    const extensionRoot = path.resolve(__dirname, '../..');
    const webviewSource = readFileSync(
      path.join(extensionRoot, 'src/config/webview/main.ts'),
      'utf8'
    );
    const configPanelSource = readFileSync(
      path.join(extensionRoot, 'src/config/configPanel.ts'),
      'utf8'
    );
    const manifest = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as {
      contributes: {
        commands: { command: string; title: string }[];
        menus: { commandPalette: { command: string; when?: string }[] };
      };
    };

    assert.equal((webviewSource.match(/post\(\{ type: 'startRun' \}\)/g) ?? []).length, 1);
    assert.doesNotMatch(webviewSource, /Launch Claude for New Runs|type: 'launchClaude'/);
    assert.doesNotMatch(configPanelSource, /type: 'launchClaude'/);

    const start = manifest.contributes.commands.find(
      (command) => command.command === 'autonomousDev.startRun'
    );
    assert.equal(start?.title, 'New Run…');
    assert.ok(
      manifest.contributes.commands.some(
        (command) => command.command === 'autonomousDev.openAutonomousClaude'
      )
    );
    for (const command of ['autonomousDev.openAutonomousClaude', 'autonomousDev.launchClaude']) {
      const compatibilityAlias = manifest.contributes.menus.commandPalette.find(
        (item) => item.command === command
      );
      assert.equal(compatibilityAlias?.when, 'false');
    }
  });

  it('shows a persistent, descriptive New run action in Active Runs', () => {
    const extensionRoot = path.resolve(__dirname, '../..');
    const providerSource = readFileSync(
      path.join(extensionRoot, 'src/tree/runTreeProvider.ts'),
      'utf8'
    );
    const itemSource = readFileSync(path.join(extensionRoot, 'src/tree/runTreeItem.ts'), 'utf8');
    assert.match(providerSource, /this\.group === 'active'.*kind: 'new-run'/s);
    assert.match(itemSource, /new vscode\.TreeItem\('New run…'/);
    assert.match(itemSource, /command: 'autonomousDev\.startRun'/);
    assert.match(itemSource, /Choose run mode and describe the feature/);
  });

  it('offers all three supported run modes in the guided start flow', () => {
    const extensionRoot = path.resolve(__dirname, '../..');
    const commandsSource = readFileSync(path.join(extensionRoot, 'src/commands/index.ts'), 'utf8');
    assert.match(commandsSource, /Feature branch \/ isolated worktree/);
    assert.match(commandsSource, /label: 'Current branch'/);
    assert.match(commandsSource, /label: 'Main'/);
  });
});
