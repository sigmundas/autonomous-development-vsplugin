import { platform } from 'node:process';

import * as vscode from 'vscode';
import type { ClaudeRuntime } from '@semanticmatter/core';

import type { ConfigStore } from '../configStore';
import type { OutputLog } from '../output';
import { isWorkspaceTrusted } from '../trust';

export interface LaunchClaudeDeps {
  readonly store: ConfigStore;
  readonly log: OutputLog;
  readonly getProjectRoot: () => string | undefined;
  readonly getControllerPath: () => string;
}

/**
 * POSIX single-quote escape: any byte inside single quotes is literal except a
 * single quote itself, which must be closed, escaped, and reopened. Used for the
 * `terminal.sendText` fallback where a shell inevitably interprets the string.
 */
export function posixQuote(arg: string): string {
  if (arg.length === 0) return `''`;
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Windows cmd.exe quoting: wrap in double quotes, escape internal double quotes
 * per the argv encoding rules cmd.exe follows. This is intentionally
 * conservative — we prefer the shellIntegration/argv API when it is available.
 */
export function windowsQuote(arg: string): string {
  if (arg.length === 0) return `""`;
  if (!/[\s"^&|<>()!%]/.test(arg)) {
    return arg;
  }
  // Escape backslashes preceding a quote and the quote itself.
  let escaped = '';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      escaped += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      escaped += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  escaped += '\\'.repeat(backslashes * 2);
  return `"${escaped}"`;
}

/** Platform-specific safe quoter. */
export function quoteForShell(arg: string): string {
  return platform === 'win32' ? windowsQuote(arg) : posixQuote(arg);
}

/** Build the argument list for a Claude launcher terminal command. */
export function buildLauncherArgs(runtime: ClaudeRuntime): string[] {
  return [runtime.launcher ?? '', ...runtime.args];
}

/**
 * Format an argv array as a shell command line using the platform-appropriate
 * quoter. Intended for `terminal.sendText`, which necessarily accepts a string.
 */
export function formatLauncherCommand(argv: readonly string[]): string {
  return argv.map(quoteForShell).join(' ');
}

/**
 * Launch the configured Claude runtime in a new integrated terminal. Requires
 * a trusted workspace. Fails clearly when no runtime is selected or the
 * launcher is unavailable.
 */
export async function launchClaudeForSelectedPreset(deps: LaunchClaudeDeps): Promise<void> {
  if (!isWorkspaceTrusted()) {
    void vscode.window.showErrorMessage(
      'Launching Claude requires a trusted workspace.'
    );
    return;
  }
  const projectRoot = deps.getProjectRoot();
  if (!projectRoot) {
    void vscode.window.showErrorMessage(
      'Open a folder before launching a Claude runtime.'
    );
    return;
  }
  await deps.store.refresh();
  const snap = deps.store.current;
  if (!snap.controllerAvailable) {
    void vscode.window.showErrorMessage(
      'No controller is configured; the Claude runtime selection cannot be resolved.'
    );
    return;
  }
  const runtimeName = snap.effective?.effective.claudeRuntime;
  if (!runtimeName) {
    void vscode.window.showErrorMessage(
      'No Claude runtime is selected. Choose one from "Autonomous Development: Configure Claude Runtime".'
    );
    return;
  }
  const runtime = snap.runtimes?.claudeRuntimes.find((r) => r.name === runtimeName);
  if (!runtime) {
    void vscode.window.showErrorMessage(
      `The selected Claude runtime "${runtimeName}" is no longer defined in the configuration.`
    );
    return;
  }
  if (!runtime.launcher || runtime.launcher.length === 0) {
    void vscode.window.showErrorMessage(
      `Claude runtime "${runtimeName}" does not define a launcher path.`
    );
    return;
  }
  if (!runtime.launcherExists) {
    void vscode.window.showErrorMessage(
      `Claude runtime launcher is missing: ${runtime.launcher}`
    );
    return;
  }
  if (!runtime.launcherExecutable) {
    void vscode.window.showErrorMessage(
      `Claude runtime launcher is not executable: ${runtime.launcher}`
    );
    return;
  }

  const argv = buildLauncherArgs(runtime);
  const commandLine = formatLauncherCommand(argv);

  const controllerPath = deps.getControllerPath();
  const pluginDir = pluginDirFromControllerPath(controllerPath);
  const extraArgs: string[] = [];
  if (pluginDir) {
    extraArgs.push('--plugin-dir', pluginDir);
  }
  const finalCommand =
    extraArgs.length > 0
      ? `${commandLine} ${extraArgs.map(quoteForShell).join(' ')}`
      : commandLine;

  deps.log.info(`launchClaude runtime=${runtime.name} launcher=${runtime.launcher}`);
  const terminal = vscode.window.createTerminal({
    cwd: projectRoot,
    name: `Autonomous Development — ${runtime.displayName ?? runtime.name}`
  });
  terminal.show();
  // Execute after validation (trust, path existence, executable bit, quoting).
  // The `true` argument appends a newline that runs the command immediately in
  // the shell attached to the integrated terminal.
  terminal.sendText(finalCommand, true);
  void vscode.window.showInformationMessage(
    `Launched Claude runtime "${runtime.displayName ?? runtime.name}". This selection applies only to the new session; it does not change the provider of an already-running Claude Code session.`
  );
}

/**
 * Duplicate of the small helper in controllerCommands.ts; kept here so the
 * launcher does not need to depend on that module's other bits.
 */
function pluginDirFromControllerPath(controllerPath: string): string | undefined {
  if (controllerPath.length === 0) return undefined;
  const parts = controllerPath.split(/[\\/]+/);
  const scriptsIdx = parts.lastIndexOf('scripts');
  if (scriptsIdx <= 0 || scriptsIdx !== parts.length - 2) {
    return undefined;
  }
  return parts.slice(0, scriptsIdx).join('/');
}
