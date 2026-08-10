import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as vscode from 'vscode';
import {
  buildControllerCommand,
  isMutatingSubcommand,
  type ControllerContext,
  type ControllerOptions,
  type ControllerSubcommand,
  type DiscoveredRun
} from '@semanticmatter/core';

import type { ExtensionConfig } from '../config';
import { redactSecrets, type OutputLog } from '../output';
import { isWorkspaceTrusted } from '../trust';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export interface ControllerResult {
  readonly stdout: string;
  readonly stderr: string;
}

export class ControllerError extends Error {
  constructor(
    message: string,
    readonly stderr?: string
  ) {
    super(message);
    this.name = 'ControllerError';
  }
}

/**
 * Spawns the external controller via execFile with an argv array built by core
 * (never a shell string, so no command injection). Every mutating call is gated
 * on workspace trust at runtime — the package.json `when` clause is the first
 * gate, this is the authoritative second one.
 */
export class ControllerService {
  constructor(
    private readonly getConfig: () => ExtensionConfig,
    private readonly getStateHome: () => string,
    private readonly log: OutputLog
  ) {}

  isConfigured(): boolean {
    return this.getConfig().controllerPath.length > 0;
  }

  /** Resolve the project root a run is scoped to (worktree wins, then canonical). */
  projectRootFor(run: DiscoveredRun): string | undefined {
    const repo = run.state?.repository;
    return (
      repo?.worktreePath ??
      repo?.canonicalRoot ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
  }

  private contextFor(projectRoot?: string): ControllerContext {
    const config = this.getConfig();
    const stateHome = this.getStateHome();
    return {
      pythonPath: config.pythonPath,
      controllerPath: config.controllerPath,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      ...(stateHome.length > 0 ? { stateHome } : {})
    };
  }

  /** Spawn a built command line (the single execFile site). */
  private async spawn(
    sub: ControllerSubcommand,
    line: { command: string; args: readonly string[] }
  ): Promise<ControllerResult> {
    // Log argv (paths and flags only, no shell string) for auditability.
    this.log.info(`controller ${sub}: ${[line.command, ...line.args].join(' ')}`);
    try {
      const { stdout, stderr } = await execFileAsync(line.command, [...line.args], {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      });
      if (stderr && stderr.trim().length > 0) {
        this.log.warn(`controller ${sub} stderr: ${stderr.trim()}`);
      }
      return { stdout, stderr };
    } catch (err) {
      const e = err as { message?: string; stderr?: string; code?: number };
      const stderr = typeof e.stderr === 'string' ? e.stderr : undefined;
      const detail =
        stderr && stderr.trim().length > 0 ? stderr.trim() : (e.message ?? 'unknown error');
      this.log.error(`controller ${sub} failed: ${detail}`);
      throw new ControllerError(
        `Controller "${sub}" failed: ${redactSecrets(detail)}`,
        stderr !== undefined ? redactSecrets(stderr) : undefined
      );
    }
  }

  /**
   * Execute against an explicit context (used by guided setup, before the path
   * is persisted). Still enforces the trust gate for mutating subcommands.
   */
  async executeWith(
    ctx: ControllerContext,
    sub: ControllerSubcommand,
    options: ControllerOptions = {}
  ): Promise<ControllerResult> {
    if (ctx.controllerPath.length === 0) {
      throw new ControllerError('No controller path is configured. Run "Set Up Controller" first.');
    }
    if (isMutatingSubcommand(sub) && !isWorkspaceTrusted()) {
      throw new ControllerError('Controller actions require a trusted workspace.');
    }
    return this.spawn(sub, buildControllerCommand(ctx, sub, options));
  }

  /**
   * Execute a controller subcommand. `projectRoot` is required so a run-scoped
   * command can never target an ambiguous run.
   */
  async execute(
    sub: ControllerSubcommand,
    projectRoot: string,
    options: ControllerOptions = {}
  ): Promise<ControllerResult> {
    return this.executeWith(this.contextFor(projectRoot), sub, options);
  }

  /** Execute a global configuration command without repository identity. */
  async executeGlobal(
    sub: ControllerSubcommand,
    options: ControllerOptions = {}
  ): Promise<ControllerResult> {
    return this.executeWith(this.contextFor(), sub, options);
  }

  /** Convenience: run a subcommand scoped to a discovered run. */
  async executeForRun(
    sub: ControllerSubcommand,
    run: DiscoveredRun,
    options: Omit<ControllerOptions, 'runId'> = {}
  ): Promise<ControllerResult> {
    const projectRoot = this.projectRootFor(run);
    if (!projectRoot) {
      throw new ControllerError(`Cannot determine a project root for run ${run.runId}.`);
    }
    return this.execute(sub, projectRoot, { ...options, runId: run.runId });
  }
}
