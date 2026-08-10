import assert from 'node:assert/strict';

import {
  AUTONOMOUS_CLAUDE_ALLOWED_TOOLS,
  AUTONOMOUS_CLAUDE_DISALLOWED_TOOLS,
  AUTONOMOUS_CLAUDE_PERMISSION_MODE,
  autonomousClaudePermissionArgs,
  buildLauncherArgs,
  withAutonomousClaudePermissions,
  withClaudeModel
} from '../src/config/claudeLauncher';

describe('claudeLauncher argv and permission policy', () => {
  it('buildLauncherArgs prepends the launcher then extra args', () => {
    const argv = buildLauncherArgs({
      name: 'azure-claude',
      displayName: 'Azure · Claude',
      launcher: '/usr/local/bin/claude-azure',
      args: ['--profile', 'azure'],
      launcherExists: true,
      launcherExecutable: true
    });
    assert.deepEqual(argv, ['/usr/local/bin/claude-azure', '--profile', 'azure']);
  });

  it('adds the exact configured model as argv and leaves Default unchanged', () => {
    const base = ['/usr/local/bin/claude'];
    assert.deepEqual(withClaudeModel(base, undefined), base);
    assert.deepEqual(
      withClaudeModel(base, {
        id: 'custom',
        displayName: 'Custom',
        model: 'provider/custom model;not-a-shell'
      }),
      ['/usr/local/bin/claude', '--model', 'provider/custom model;not-a-shell']
    );
  });

  it('renders one canonical bounded permission policy for autonomous sessions', () => {
    assert.deepEqual(autonomousClaudePermissionArgs(), [
      '--permission-mode',
      AUTONOMOUS_CLAUDE_PERMISSION_MODE,
      '--allowedTools',
      AUTONOMOUS_CLAUDE_ALLOWED_TOOLS.join(','),
      '--disallowedTools',
      AUTONOMOUS_CLAUDE_DISALLOWED_TOOLS.join(',')
    ]);
    const sharedTools = AUTONOMOUS_CLAUDE_ALLOWED_TOOLS as readonly string[];
    assert.equal(AUTONOMOUS_CLAUDE_PERMISSION_MODE, 'dontAsk');
    assert.equal(
      autonomousClaudePermissionArgs().filter((arg) => arg === '--permission-mode').length,
      1
    );
    assert.ok(!sharedTools.includes('EnterWorktree'));
    assert.ok(!sharedTools.includes('ExitWorktree'));
    assert.ok(sharedTools.includes('Bash(python3 *)'));
    for (const avoidableWrapper of [
      'Bash(echo *)',
      'Bash(tail *)',
      'Bash(cat *)',
      'Bash(tee *)',
      'Bash(grep *)'
    ]) {
      assert.ok(!sharedTools.includes(avoidableWrapper));
    }
  });

  it('appends the session policy without enabling bypass permissions', () => {
    const argv = withAutonomousClaudePermissions(['/usr/local/bin/claude', '--profile', 'safe']);
    assert.deepEqual(argv, [
      '/usr/local/bin/claude',
      '--profile',
      'safe',
      ...autonomousClaudePermissionArgs()
    ]);
    assert.equal(
      argv.some((arg) => /bypasspermissions|yolo|dangerously-skip/i.test(arg)),
      false
    );
  });

  it('rejects unrestricted permission flags supplied by a configured runtime', () => {
    for (const unsafeArgs of [
      ['--dangerously-skip-permissions'],
      ['--allow-dangerously-skip-permissions'],
      ['--yolo'],
      ['--permission-mode', 'bypassPermissions'],
      ['--permission-mode=bypassPermissions']
    ]) {
      assert.throws(
        () => withAutonomousClaudePermissions(['/usr/local/bin/claude', ...unsafeArgs]),
        /unrestricted permission argument|override the autonomous Claude permission mode/
      );
    }
  });

  it('rejects every configured permission-mode override, including dontAsk duplicates', () => {
    for (const overrideArgs of [
      ['--permission-mode', 'dontAsk'],
      ['--permission-mode', 'default'],
      ['--permission-mode', 'acceptEdits'],
      ['--permission-mode=dontAsk'],
      ['--permission-mode=default']
    ]) {
      assert.throws(
        () => withAutonomousClaudePermissions(['/usr/local/bin/claude', ...overrideArgs]),
        /override the autonomous Claude permission mode/
      );
    }
  });
});
