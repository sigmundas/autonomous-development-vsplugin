/**
 * Discover repositories and runs under a state home (docs/REFERENCE.md §2),
 * grouping each run into the active / completed / archived tree. Tolerant of
 * missing directories and unreadable runs.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { diag, type Diagnostic } from './diagnostics';
import { loadRun, type LoadedRun } from './loadRun';
import { LEGACY_LAYOUT_RELATIVE } from './stateHome';
import type { RunGroup, RunStatus } from './types';

export interface DiscoveredRun extends LoadedRun {
  readonly runId: string;
  readonly repoId: string;
  readonly group: RunGroup;
}

export interface DiscoveredRepository {
  readonly repoId: string;
  readonly dir: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly metadataDiagnostics: readonly Diagnostic[];
  readonly runs: readonly DiscoveredRun[];
}

/** Map a normalized run status to its tree group. */
export function groupForStatus(status: RunStatus): RunGroup {
  switch (status) {
    case 'complete':
    case 'complete_with_followups':
    case 'blocked':
    case 'cancelled':
      return 'completed';
    case 'archived':
      return 'archived';
    case 'active':
    case 'unknown':
    default:
      return 'active';
  }
}

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readMetadata(repoDir: string): {
  metadata?: Record<string, unknown>;
  diagnostics: Diagnostic[];
} {
  const path = join(repoDir, 'metadata.json');
  if (!existsSync(path)) {
    return { diagnostics: [] };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { metadata: parsed as Record<string, unknown>, diagnostics: [] };
    }
    return {
      diagnostics: [diag('metadata-unreadable', 'metadata.json is not an object', 'warning', path)]
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      diagnostics: [
        diag('metadata-unreadable', `Invalid metadata.json: ${message}`, 'warning', path)
      ]
    };
  }
}

function discoverRunsForRepo(repoDir: string, repoId: string): DiscoveredRun[] {
  const runsDir = join(repoDir, 'runs');
  const runs: DiscoveredRun[] = [];
  for (const runId of listDirNames(runsDir)) {
    const runDir = join(runsDir, runId);
    const loaded = loadRun(runDir);
    const status = loaded.state?.status ?? 'unknown';
    runs.push({ ...loaded, runId, repoId, group: groupForStatus(status) });
  }
  return sortRuns(runs);
}

function sortKey(run: DiscoveredRun): string {
  return run.state?.createdAt ?? run.runId;
}

function sortRuns(runs: DiscoveredRun[]): DiscoveredRun[] {
  return runs.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
}

/** Discover all repositories (and their runs) under a state home. */
export function discoverRepositories(stateHome: string): DiscoveredRepository[] {
  const reposDir = join(stateHome, 'repositories');
  const repos: DiscoveredRepository[] = [];
  for (const repoId of listDirNames(reposDir)) {
    const repoDir = join(reposDir, repoId);
    const { metadata, diagnostics } = readMetadata(repoDir);
    repos.push({
      repoId,
      dir: repoDir,
      ...(metadata !== undefined ? { metadata } : {}),
      metadataDiagnostics: diagnostics,
      runs: discoverRunsForRepo(repoDir, repoId)
    });
  }
  return repos.sort((a, b) => a.repoId.localeCompare(b.repoId));
}

/**
 * Flattened view: every run under a state home, newest first. When `repoId` is
 * given, only runs under that repository are returned (workspace scoping, FR-3);
 * omit it to enumerate all repositories.
 */
export function discoverRuns(stateHome: string, repoId?: string): DiscoveredRun[] {
  const repos = discoverRepositories(stateHome);
  const scoped = repoId !== undefined ? repos.filter((r) => r.repoId === repoId) : repos;
  return sortRuns(scoped.flatMap((r) => [...r.runs]));
}

/** Filter discovered runs by tree group. */
export function runsInGroup(runs: readonly DiscoveredRun[], group: RunGroup): DiscoveredRun[] {
  return runs.filter((r) => r.group === group);
}

const TRIAGE_FILE_RE = /^triage-\d+\.md$/i;

/**
 * Read-only legacy triage markdown (`triage-NN.md`) in a run directory, sorted by
 * name (docs/REFERENCE.md §9). Returned as basenames; the UI shows them read-only
 * and never fabricates structured dispositions from their free-form content.
 */
export function discoverTriageFiles(runDir: string): string[] {
  try {
    return readdirSync(runDir, { withFileTypes: true })
      .filter((d) => d.isFile() && TRIAGE_FILE_RE.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Detect a legacy in-repo run (`<repo>/.ai/autonomous-development/run-state.json`)
 * for read-only inspection. Returns the loaded run, or undefined if absent.
 */
export function detectLegacyRun(repoRoot: string): DiscoveredRun | undefined {
  const statePath = join(repoRoot, LEGACY_LAYOUT_RELATIVE);
  if (!existsSync(statePath)) {
    return undefined;
  }
  const runDir = join(repoRoot, '.ai', 'autonomous-development');
  const loaded = loadRun(runDir);
  const status = loaded.state?.status ?? 'unknown';
  const runId = loaded.state?.runId ?? 'legacy';
  return { ...loaded, runId, repoId: 'legacy', group: groupForStatus(status) };
}
