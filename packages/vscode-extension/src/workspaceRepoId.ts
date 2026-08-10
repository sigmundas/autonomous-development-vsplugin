/**
 * Resolve the reference repo-id for an open workspace folder by replicating the
 * controller's `resolve_repository` (docs/REFERENCE.md §2, scripts/state.py).
 * Used to scope run discovery to the current repository (FR-3). Returns
 * `undefined` whenever git is unavailable or the folder is not a git repo.
 *
 * Git is invoked with an argv array via execFileSync (never a shell string), and
 * each call mirrors the reference's tolerant `_run_git`: a failed command yields
 * the empty string rather than throwing, so every reference branch is preserved.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { computeRepoId } from '@semanticmatter/core';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    }).trim();
  } catch {
    return '';
  }
}

/** Best-effort realpath that degrades to plain normalization when the path is absent. */
function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function resolveWorkspaceRepoId(folderPath: string): string | undefined {
  const cwd = realpathOrResolve(folderPath);

  const toplevel = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!toplevel) {
    return undefined;
  }
  const canonicalRoot = realpathOrResolve(toplevel);

  const rawCommon = git(canonicalRoot, ['rev-parse', '--git-common-dir']);
  // Verbatim, stripped output: may hold several newline-separated root commits,
  // or be empty for a commitless repo. Both feed the hash exactly as upstream.
  const firstCommit = git(canonicalRoot, ['rev-list', '--max-parents=0', 'HEAD']);

  if (rawCommon) {
    const joined = isAbsolute(rawCommon) ? rawCommon : join(canonicalRoot, rawCommon);
    return computeRepoId(realpathOrResolve(joined), firstCommit);
  }
  return computeRepoId(canonicalRoot, firstCommit);
}
