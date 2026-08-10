import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import type { ClaudeModel, ClaudeRuntime } from '@semanticmatter/core';

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
const AUTONOMOUS_CLAUDE_BASE_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'LSP',
  'Agent'
] as const;

export const AUTONOMOUS_CLAUDE_DEFAULT_COMMANDS = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git rev-parse',
  'git ls-files',
  'python',
  'python3',
  'uv',
  'pytest',
  'codex'
] as const;

const SAFE_COMMAND = /^[A-Za-z0-9_./+@-]+(?: [A-Za-z0-9_./+@:-]+){0,2}$/;
const SHELL_COMMANDS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh'
]);
const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files']);

export function bashPermissionRule(command: string): string {
  if (!SAFE_COMMAND.test(command)) {
    throw new Error(`Unsafe autonomous Claude command prefix: ${command}`);
  }
  const parts = command.split(' ');
  const executable = (parts[0]?.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (SHELL_COMMANDS.has(executable)) {
    throw new Error(`Autonomous Claude command prefix cannot grant a shell: ${command}`);
  }
  if (executable === 'git' && (parts.length < 2 || !SAFE_GIT_SUBCOMMANDS.has(parts[1] ?? ''))) {
    throw new Error(`Autonomous Claude command prefix cannot grant unsafe Git: ${command}`);
  }
  return `Bash(${command}:*)`;
}

export function autonomousClaudeAllowedTools(additionalCommands: readonly string[] = []): string[] {
  const commands = [...AUTONOMOUS_CLAUDE_DEFAULT_COMMANDS, ...additionalCommands];
  return [...AUTONOMOUS_CLAUDE_BASE_TOOLS, ...new Set(commands.map(bashPermissionRule))];
}

export const AUTONOMOUS_CLAUDE_ALLOWED_TOOLS = autonomousClaudeAllowedTools();

export const AUTONOMOUS_CLAUDE_DISALLOWED_TOOLS = ['AskUserQuestion'] as const;
export const AUTONOMOUS_CLAUDE_PERMISSION_MODE = 'dontAsk' as const;

/** Render the canonical policy as Claude CLI argv elements. */
export function autonomousClaudePermissionArgs(
  additionalCommands: readonly string[] = []
): string[] {
  return [
    '--permission-mode',
    AUTONOMOUS_CLAUDE_PERMISSION_MODE,
    '--allowedTools',
    autonomousClaudeAllowedTools(additionalCommands).join(','),
    '--disallowedTools',
    AUTONOMOUS_CLAUDE_DISALLOWED_TOOLS.join(',')
  ];
}

function assertNoPermissionOverrides(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]?.toLowerCase();
    if (arg === '--permission-mode' || arg?.startsWith('--permission-mode=')) {
      throw new Error(`Refusing to override the autonomous Claude permission mode: ${argv[index]}`);
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
export function withAutonomousClaudePermissions(
  argv: readonly string[],
  additionalCommands: readonly string[] = []
): string[] {
  assertNoPermissionOverrides(argv);
  return [...argv, ...autonomousClaudePermissionArgs(additionalCommands)];
}

/** Build the bounded PATH override inherited by Claude and controller checks. */
export function runtimeExecutablePathEnv(
  runtime: ClaudeRuntime,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const launcherDirectory =
    runtime.launcher && isAbsolute(runtime.launcher) ? dirname(runtime.launcher) : undefined;
  const configuredPaths = runtime.executablePaths ?? [];
  if (!launcherDirectory && configuredPaths.length === 0) return {};
  const pathKey =
    Object.keys(baseEnv).find((key) => key.toLowerCase() === 'path') ??
    (platform === 'win32' ? 'Path' : 'PATH');
  const current = baseEnv[pathKey] ?? '';
  const expanded = configuredPaths.map((entry) =>
    entry === '~' ? homedir() : entry.startsWith('~/') ? join(homedir(), entry.slice(2)) : entry
  );
  const entries = [launcherDirectory, ...expanded, ...current.split(delimiter)].filter(
    (entry): entry is string => Boolean(entry)
  );
  return { [pathKey]: [...new Set(entries)].join(delimiter) };
}

/** Build the argument list for a Claude launcher terminal command. */
export function buildLauncherArgs(runtime: ClaudeRuntime): string[] {
  return [runtime.launcher ?? '', ...runtime.args];
}

/** Append an explicitly configured model as separate, shell-safe argv elements. */
export function withClaudeModel(argv: readonly string[], model: ClaudeModel | undefined): string[] {
  if (!model) return [...argv];
  const withoutLegacyModel: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model') {
      index += 1;
      continue;
    }
    if (arg?.startsWith('--model=')) continue;
    if (arg !== undefined) withoutLegacyModel.push(arg);
  }
  return [...withoutLegacyModel, '--model', model.model];
}
