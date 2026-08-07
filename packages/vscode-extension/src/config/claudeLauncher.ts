import type { ClaudeRuntime } from '@semanticmatter/core';

/**
 * Session-wide permission policy shared by every autonomous Claude launcher.
 *
 * Skill `allowed-tools` / `disallowed-tools` grants clear after the user's next
 * message. Passing the common policy on Claude's command line keeps the same
 * bounded permissions across genuine human-decision turns without using an
 * unrestricted permission mode.
 *
 * EnterWorktree / ExitWorktree are deliberately absent: autonomous-feature
 * allows them, while autonomous-current and autonomous-main prohibit them.
 * Those tools therefore remain governed by the selected skill rather than a
 * shared session policy.
 */
export const AUTONOMOUS_CLAUDE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'LSP',
  'Agent',
  'Bash(git *)',
  'Bash(python3 *)',
  'Bash(codex *)'
] as const;

export const AUTONOMOUS_CLAUDE_DISALLOWED_TOOLS = ['AskUserQuestion'] as const;
export const AUTONOMOUS_CLAUDE_PERMISSION_MODE = 'dontAsk' as const;

/** Render the canonical policy as Claude CLI argv elements. */
export function autonomousClaudePermissionArgs(): string[] {
  return [
    '--permission-mode',
    AUTONOMOUS_CLAUDE_PERMISSION_MODE,
    '--allowedTools',
    AUTONOMOUS_CLAUDE_ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    AUTONOMOUS_CLAUDE_DISALLOWED_TOOLS.join(',')
  ];
}

function assertNoPermissionOverrides(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]?.toLowerCase();
    if (arg === '--permission-mode' || arg?.startsWith('--permission-mode=')) {
      throw new Error(
        `Refusing to override the autonomous Claude permission mode: ${argv[index]}`
      );
    }
    if (
      arg === '--dangerously-skip-permissions' ||
      arg === '--allow-dangerously-skip-permissions' ||
      arg === '--yolo'
    ) {
      throw new Error(
        `Refusing to launch autonomous Claude with unrestricted permission argument: ${argv[index]}`
      );
    }
  }
}

/** Append the canonical bounded policy while rejecting permission overrides. */
export function withAutonomousClaudePermissions(argv: readonly string[]): string[] {
  assertNoPermissionOverrides(argv);
  return [...argv, ...autonomousClaudePermissionArgs()];
}

/** Build the argument list for a Claude launcher terminal command. */
export function buildLauncherArgs(runtime: ClaudeRuntime): string[] {
  return [runtime.launcher ?? '', ...runtime.args];
}
