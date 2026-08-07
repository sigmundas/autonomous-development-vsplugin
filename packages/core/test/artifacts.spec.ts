import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { confineToDirectory, resolveArtifactPath } from '../src/artifacts';

function canonicalPath(base: string, ...segments: string[]): string {
  return resolve(realpathSync(base), ...segments);
}

describe('confineToDirectory (P0.5 filesystem confinement)', () => {
  let root: string;
  let runDir: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'confine-'));
    runDir = join(root, 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'accepted-spec.md'), '# spec');
    mkdirSync(join(runDir, 'verification'), { recursive: true });
    writeFileSync(join(runDir, 'verification', 'npm-test.log'), 'ok');
    writeFileSync(join(root, 'outside-secret.txt'), 'top secret');
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns {} for an empty reference (nothing to open)', () => {
    assert.deepEqual(confineToDirectory(runDir, ''), {});
  });

  it('resolves a run-dir-relative reference to its canonical path', () => {
    const out = confineToDirectory(runDir, 'accepted-spec.md');
    assert.equal(out.path, canonicalPath(runDir, 'accepted-spec.md'));
    assert.equal(out.escaped, undefined);
  });

  it('resolves a nested relative reference', () => {
    const out = confineToDirectory(runDir, 'verification/npm-test.log');
    assert.equal(out.path, canonicalPath(runDir, 'verification', 'npm-test.log'));
  });

  it('accepts an absolute reference that is inside the base', () => {
    const inside = join(runDir, 'accepted-spec.md');
    const out = confineToDirectory(runDir, inside);
    assert.equal(out.path, canonicalPath(runDir, 'accepted-spec.md'));
  });

  it('rejects an absolute reference outside the base', () => {
    const out = confineToDirectory(runDir, join(root, 'outside-secret.txt'));
    assert.deepEqual(out, { escaped: true });
  });

  it('rejects a system absolute path', () => {
    assert.deepEqual(confineToDirectory(runDir, '/etc/passwd'), { escaped: true });
  });

  it('rejects parent-traversal that escapes the base', () => {
    assert.deepEqual(confineToDirectory(runDir, '../outside-secret.txt'), { escaped: true });
    assert.deepEqual(confineToDirectory(runDir, '../../../../etc/passwd'), { escaped: true });
  });

  it('accepts traversal that stays inside the base after normalization', () => {
    const out = confineToDirectory(runDir, 'verification/../accepted-spec.md');
    assert.equal(out.path, canonicalPath(runDir, 'accepted-spec.md'));
  });

  it('rejects an in-base symlink that points outside the base', () => {
    const link = join(runDir, 'escape-link');
    symlinkSync(join(root, 'outside-secret.txt'), link);
    assert.deepEqual(confineToDirectory(runDir, 'escape-link'), { escaped: true });
  });

  it('canonicalizes an in-base symlink that points inside the base', () => {
    const link = join(runDir, 'inside-link');
    symlinkSync(join(runDir, 'accepted-spec.md'), link);
    const out = confineToDirectory(runDir, 'inside-link');
    assert.equal(out.path, canonicalPath(runDir, 'accepted-spec.md'));
  });

  it('does not treat a sibling whose name starts with ".." as an escape', () => {
    writeFileSync(join(runDir, '..hidden'), 'x');
    const out = confineToDirectory(runDir, '..hidden');
    assert.equal(out.path, canonicalPath(runDir, '..hidden'));
  });
});

describe('resolveArtifactPath (delegates to confinement)', () => {
  it('confines run-relative artifact references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'confine-art-'));
    try {
      const out = resolveArtifactPath(dir, 'feature-spec.codex.json');
      assert.equal(out.path, canonicalPath(dir, 'feature-spec.codex.json'));
      assert.deepEqual(resolveArtifactPath(dir, '../../../etc/hosts'), { escaped: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
