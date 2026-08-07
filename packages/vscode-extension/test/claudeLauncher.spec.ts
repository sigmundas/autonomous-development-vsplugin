import assert from 'node:assert/strict';

import {
  AUTONOMOUS_CLAUDE_ALLOWED_TOOLS,
  AUTONOMOUS_CLAUDE_DISALLOWED_TOOLS,
  AUTONOMOUS_CLAUDE_PERMISSION_MODE,
  autonomousClaudePermissionArgs,
  buildLauncherArgs,
  formatLauncherCommand,
  posixQuote,
  withAutonomousClaudePermissions,
  windowsQuote
} from '../src/config/claudeLauncher';

describe('claudeLauncher argument quoting', () => {
  it('posixQuote handles bare identifiers without quoting', () => {
    assert.equal(posixQuote('claude'), 'claude');
    assert.equal(posixQuote('/usr/local/bin/claude-azure'), '/usr/local/bin/claude-azure');
  });

  it('posixQuote wraps whitespace and shell metacharacters', () => {
    assert.equal(posixQuote('with space'), `'with space'`);
    assert.equal(posixQuote(''), `''`);
    assert.equal(posixQuote(`a$b`), `'a$b'`);
    assert.equal(posixQuote(`a;rm -rf /`), `'a;rm -rf /'`);
  });

  it('posixQuote closes and reopens quotes for embedded single quotes', () => {
    assert.equal(posixQuote(`it's fine`), `'it'\\''s fine'`);
  });

  it('windowsQuote leaves bare identifiers alone', () => {
    assert.equal(windowsQuote('claude'), 'claude');
  });

  it('windowsQuote wraps whitespace and escapes internal quotes', () => {
    assert.equal(windowsQuote('a b'), '"a b"');
    assert.equal(windowsQuote('a"b'), '"a\\"b"');
    assert.equal(windowsQuote('a\\"b'), '"a\\\\\\"b"');
  });

  it('formatLauncherCommand joins argv without interpolation', () => {
    const argv = ['/usr/local/bin/claude-azure', '--flag', 'value with space'];
    const line = formatLauncherCommand(argv);
    assert.ok(line.startsWith('/usr/local/bin/claude-azure --flag '));
    // Space-containing argument must be quoted, not spliced raw.
    assert.match(line, /'value with space'|"value with space"/);
  });

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
    assert.equal(argv.some((arg) => /bypasspermissions|yolo|dangerously-skip/i.test(arg)), false);
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

  it('never allows unsanitized shell metacharacters through the join', () => {
    const dangerous = ['/bin/echo', 'a; rm -rf $HOME', 'b`whoami`'];
    const line = formatLauncherCommand(dangerous);
    // The shell would interpret the raw semicolon, backticks, or $HOME —
    // quoting must neutralize them.
    for (const chunk of ['rm', 'whoami', '$HOME']) {
      // The literal chunk still appears (we're not stripping content) but only
      // inside quotes; the joined line must never end up with an unquoted ';' or '`'.
      assert.ok(line.includes(chunk));
    }
    // Assert every non-first argv token is quoted when it needs to be.
    assert.match(line, /'a; rm -rf \$HOME'|"a; rm -rf \$HOME"/);
    assert.match(line, /'b`whoami`'|"b`whoami`"/);
  });
});
