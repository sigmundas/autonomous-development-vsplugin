import * as vscode from 'vscode';
import {
  discoverRuns,
  detectLegacyRun,
  type DiscoveredRun,
  type RunGroup
} from '@semanticmatter/core';

import type { ExtensionConfig } from './config';
import type { OutputLog } from './output';
import { resolveActiveStateHome } from './stateHomeContext';
import { resolveWorkspaceRepoId } from './workspaceRepoId';

export function discoverRunsForRepositories(
  stateHome: string,
  repoIds: ReadonlySet<string>
): DiscoveredRun[] {
  return [...repoIds].flatMap((id) => discoverRuns(stateHome, id));
}

/** Stable identity for a run across repositories (runId alone may collide). */
export function runKey(run: { repoId: string; runId: string }): string {
  return `${run.repoId}::${run.runId}`;
}

/**
 * Central, VS Code-facing data store. Owns run discovery against the resolved
 * state home, the run map every command/tree/dashboard reads from, and the
 * "selected run" used by the status bar. All workflow semantics come from
 * @semanticmatter/core — this layer only does IO orchestration and caching.
 */
export class RunStore implements vscode.Disposable {
  private config: ExtensionConfig;
  private stateHome: string;
  private runs: DiscoveredRun[] = [];
  private byKey = new Map<string, DiscoveredRun>();
  private lastValid = new Map<string, DiscoveredRun>();
  /** Memoized workspace-folder → repo-id (only successful resolutions cached). */
  private readonly repoIdByFolder = new Map<string, string>();
  private selectedKey: string | undefined;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires after a refresh replaces the run set. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly onDidChangeSelectionEmitter = new vscode.EventEmitter<
    DiscoveredRun | undefined
  >();
  readonly onDidChangeSelection = this.onDidChangeSelectionEmitter.event;

  constructor(
    config: ExtensionConfig,
    private readonly log: OutputLog
  ) {
    this.config = config;
    this.stateHome = resolveActiveStateHome(config);
  }

  /** Current resolved state home (recomputed whenever config changes). */
  get activeStateHome(): string {
    return this.stateHome;
  }

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.stateHome = resolveActiveStateHome(config);
  }

  /**
   * Resolve the repo-ids of the open workspace folders (FR-3). An empty set means
   * no repository-scoped runs may be shown.
   */
  private workspaceRepoIds(): Set<string> {
    const ids = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = folder.uri.fsPath;
      let id = this.repoIdByFolder.get(key);
      if (id === undefined) {
        id = resolveWorkspaceRepoId(key);
        if (id !== undefined) {
          this.repoIdByFolder.set(key, id);
        }
      }
      if (id !== undefined) {
        ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Re-discover runs under the state home, scoped to open workspace repositories,
   * plus any legacy in-repo run.
   */
  refresh(): void {
    let discovered: DiscoveredRun[] = [];
    try {
      const repoIds = this.workspaceRepoIds();
      discovered = discoverRunsForRepositories(this.stateHome, repoIds);
    } catch (err) {
      this.log.error(`Run discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      discovered = [];
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const legacy = detectLegacyRun(folder.uri.fsPath);
        if (legacy) {
          discovered.push(legacy);
        }
      } catch (err) {
        this.log.warn(
          `Legacy run detection failed for ${folder.uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    for (const fresh of discovered) {
      if (fresh.state && fresh.model) {
        this.lastValid.set(runKey(fresh), fresh);
      }
    }
    const projected = discovered.map((r) => this.projectRun(r));

    this.runs = projected;
    this.byKey = new Map(projected.map((r) => [runKey(r), r]));
    if (this.selectedKey && !this.byKey.has(this.selectedKey)) {
      this.selectedKey = undefined;
    }
    this.onDidChangeEmitter.fire();
  }

  /**
   * When a run's current on-disk state is unparseable (e.g. an atomic mid-write),
   * keep showing the last successfully parsed state/model so the view doesn't
   * blank out. The fresh parse diagnostic is still surfaced, and discovery
   * identity (runDir) follows the fresh read; grouping follows the retained
   * model so the run stays in its real lane rather than defaulting to active.
   */
  private projectRun(fresh: DiscoveredRun): DiscoveredRun {
    if (fresh.state && fresh.model) {
      return fresh;
    }
    const prior = this.lastValid.get(runKey(fresh));
    if (!prior) {
      return fresh;
    }
    return {
      ...prior,
      runDir: fresh.runDir,
      group: prior.group,
      diagnostics: [...fresh.diagnostics, ...prior.diagnostics]
    };
  }

  get allRuns(): readonly DiscoveredRun[] {
    return this.runs;
  }

  /** Runs in a tree group, honoring the load-completed / load-archived settings. */
  runsForGroup(group: RunGroup): DiscoveredRun[] {
    if (group === 'completed' && !this.config.loadCompletedRuns) {
      return [];
    }
    if (group === 'archived' && !this.config.loadArchivedRuns) {
      return [];
    }
    return this.runs.filter((r) => r.group === group);
  }

  getByKey(key: string): DiscoveredRun | undefined {
    return this.byKey.get(key);
  }

  /** Find a run by runId (first match); prefer getByKey when the repo is known. */
  getByRunId(runId: string): DiscoveredRun | undefined {
    return this.runs.find((r) => r.runId === runId);
  }

  get selectedRun(): DiscoveredRun | undefined {
    return this.selectedKey ? this.byKey.get(this.selectedKey) : undefined;
  }

  select(run: DiscoveredRun | undefined): void {
    this.selectedKey = run ? runKey(run) : undefined;
    this.onDidChangeSelectionEmitter.fire(run);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    this.onDidChangeSelectionEmitter.dispose();
  }
}
