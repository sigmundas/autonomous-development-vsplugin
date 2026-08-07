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
    const openedRoots: string[] = [];
    const handler = createStartRunCommandHandler({
      resolveProjectRoot: async () => {
        resolveCalls += 1;
        return '/work/repo';
      },
      openAutonomousClaude: async (projectRoot) => {
        openedRoots.push(projectRoot);
      }
    });

    await handler();

    assert.equal(resolveCalls, 1);
    assert.deepEqual(openedRoots, ['/work/repo']);
  });

  it('does not open a session when project-root selection is cancelled', async () => {
    let openCalls = 0;
    const handler = createStartRunCommandHandler({
      resolveProjectRoot: async () => undefined,
      openAutonomousClaude: async () => {
        openCalls += 1;
      }
    });

    await handler();

    assert.equal(openCalls, 0);
  });

  it('does not route normal Start through controllerCommands.startRun', () => {
    const commandsSource = readFileSync(
      path.resolve(__dirname, '../../src/commands/index.ts'),
      'utf8'
    );
    assert.doesNotMatch(commandsSource, /controller\.startRun\s*\(/);
    assert.match(commandsSource, /openAutonomousClaudeInWorkspace\s*\(/);
  });

  it('keeps one primary configuration action and hides the old launcher from the palette', () => {
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
    assert.equal(start?.title, 'Start Autonomous Run');
    assert.ok(
      manifest.contributes.commands.some(
        (command) => command.command === 'autonomousDev.openAutonomousClaude'
      )
    );
    const legacyLauncher = manifest.contributes.menus.commandPalette.find(
      (item) => item.command === 'autonomousDev.launchClaude'
    );
    assert.equal(legacyLauncher?.when, 'false');
  });
});
