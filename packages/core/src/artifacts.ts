/**
 * Filesystem confinement for paths recorded in run-state or review findings.
 *
 * Artifact pointers and finding source paths are controller-generated and must
 * stay inside their owning directory (reference state.py:resolve_artifact_path).
 * A crafted or legacy run-state could otherwise aim a pointer at an arbitrary
 * local file and exfiltrate its contents. We mirror the reference: resolve the
 * reference (absolute OR relative), canonicalize symlinks, and require the
 * result to remain inside the canonical base directory — rejecting both
 * absolute-outside references and `..` traversal, and following symlinks so an
 * in-base symlink that points outside is also rejected.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface ArtifactResolution {
  /** Absolute, symlink-canonicalized path on disk, or undefined if unsafe. */
  readonly path?: string;
  /** Set when resolution was rejected (reference escapes the base directory). */
  readonly escaped?: boolean;
}

/**
 * Canonicalize a path, following symlinks. For a path that does not yet exist,
 * canonicalize the nearest existing ancestor and lexically append the missing
 * tail — matching Python's `Path.resolve(strict=False)`, so symlinks in the
 * existing prefix are still resolved and cannot be used to escape.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) {
      return p;
    }
    return resolve(canonicalize(parent), basename(p));
  }
}

/**
 * Resolve `reference` against `baseDir` and confine the result to it.
 * - Empty reference -> `{}` (nothing to open).
 * - Absolute and relative references are both resolved, canonicalized, and
 *   required to stay inside the canonical `baseDir`.
 * - On escape -> `{ escaped: true }` (the caller disables the open/diff action).
 */
export function confineToDirectory(baseDir: string, reference: string): ArtifactResolution {
  if (reference.length === 0) {
    return {};
  }
  const candidateRaw = isAbsolute(reference) ? resolve(reference) : resolve(baseDir, reference);
  const canonicalBase = canonicalize(resolve(baseDir));
  const canonicalCandidate = canonicalize(candidateRaw);
  if (canonicalCandidate === canonicalBase) {
    return { path: canonicalCandidate };
  }
  const rel = relative(canonicalBase, canonicalCandidate);
  const firstSegment = rel.split(sep)[0];
  if (rel !== '' && firstSegment !== '..' && !isAbsolute(rel)) {
    return { path: canonicalCandidate };
  }
  return { escaped: true };
}

/**
 * Resolve an artifact reference against a run directory, confined to it.
 * Artifact references are run-dir-relative or absolute (docs/REFERENCE.md §3);
 * either way the resolved path must stay inside the run directory.
 */
export function resolveArtifactPath(runDir: string, reference: string): ArtifactResolution {
  return confineToDirectory(runDir, reference);
}

/** Conventional run-dir-relative names used when an artifact key is absent. */
export const CONVENTIONAL_ARTIFACT_NAMES = {
  featureRequest: 'feature-request.md',
  repositoryContext: 'repository-context.txt',
  enhance: 'feature-spec.codex.json',
  acceptedSpec: 'accepted-spec.md',
  plan: 'implementation-plan.codex.json',
  acceptedPlan: 'accepted-plan.md',
  followUpsJson: 'follow-ups.json',
  followUpsMarkdown: 'follow-ups.md'
} as const;
