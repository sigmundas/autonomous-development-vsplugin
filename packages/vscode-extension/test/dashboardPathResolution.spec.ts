import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as vscode from 'vscode';
import type { DiscoveredRun } from '@semanticmatter/core';

import { openVerificationCheckLog, resolveFindingSource } from '../src/dashboard/dashboardPanel';

function discoveredRun(runDir: string, worktree: string): DiscoveredRun {
  return {
    runId: 'run-1',
    repoId: 'repo-1',
    runDir,
    group: 'active',
    diagnostics: [],
    state: { repository: { worktreePath: worktree } }
  } as unknown as DiscoveredRun;
}

describe('dashboard path resolution', () => {
  let root: string;
  let runDir: string;
  let worktree: string;
  let run: DiscoveredRun;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autodev-dashboard-paths-'));
    runDir = join(root, 'durable-run');
    worktree = join(root, 'worktree');
    mkdirSync(join(runDir, 'verification'), { recursive: true });
    mkdirSync(join(worktree, 'verification'), { recursive: true });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    run = discoveredRun(runDir, worktree);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('opens an individual verification log from runDir even when worktree has the same path', async () => {
    const relative = 'verification/foo.log';
    writeFileSync(join(runDir, relative), 'durable');
    writeFileSync(join(worktree, relative), 'worktree shadow');
    let opened: string | undefined;

    const didOpen = await openVerificationCheckLog(run, relative, {
      openTextDocument: async (uri) => {
        opened = uri.fsPath;
        return {} as vscode.TextDocument;
      },
      showTextDocument: async () => undefined,
      showWarning: () => assert.fail('unexpected warning'),
      warn: () => assert.fail('unexpected log warning')
    });

    assert.equal(didOpen, true);
    assert.equal(opened, realpathSync(join(runDir, relative)));
  });

  it('refuses traversal outside runDir', async () => {
    const warnings: string[] = [];
    const didOpen = await openVerificationCheckLog(run, '../../foo', {
      openTextDocument: async () => assert.fail('must not open traversal'),
      showTextDocument: async () => assert.fail('must not show traversal'),
      showWarning: (message) => warnings.push(message),
      warn: () => undefined
    });

    assert.equal(didOpen, false);
    assert.match(warnings[0] ?? '', /outside the run directory/);
  });

  it('keeps finding source paths rooted in the worktree', () => {
    writeFileSync(join(worktree, 'src', 'foo.py'), 'print("ok")');
    assert.equal(
      resolveFindingSource(run, 'src/foo.py'),
      realpathSync(join(worktree, 'src', 'foo.py'))
    );
  });

  it('warns for a missing recorded log without attempting to open it', async () => {
    const warnings: string[] = [];
    const didOpen = await openVerificationCheckLog(run, 'verification/missing.log', {
      openTextDocument: async () => assert.fail('must not fabricate a missing path'),
      showTextDocument: async () => assert.fail('must not show a missing document'),
      showWarning: (message) => warnings.push(message),
      warn: () => undefined
    });

    assert.equal(didOpen, false);
    assert.match(warnings[0] ?? '', /file is not present for this run/);
  });
});
