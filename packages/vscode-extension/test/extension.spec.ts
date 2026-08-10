import assert from 'node:assert/strict';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';
import { detectLegacyRun, type DiscoveredRun } from '@semanticmatter/core';

import type { AutonomousDevApi } from '../src/extension';
import { openFileAtLine } from '../src/dashboard/openLocation';
import { resolveWorkspaceRepoId } from '../src/workspaceRepoId';
import { buildFixtures, type Fixtures } from './fixtures';

const EXT_ID = 'semanticmatter.semanticmatter-autonomous-development';

const CONTRIBUTED_COMMANDS = [
  'openDashboard',
  'refreshRuns',
  'openOriginalFeature',
  'openEnhancedSpec',
  'openAcceptedSpec',
  'openProposedPlan',
  'openAcceptedPlan',
  'openLatestReview',
  'openVerificationLog',
  'compareSpec',
  'comparePlan',
  'evaluateGates',
  'acceptDrift',
  'cancelRun',
  'archiveRun',
  'authorizeReview',
  'continueBlockedRun',
  'revealRunDirectory',
  'setupController',
  'configure',
  'selectPreset',
  'configurePlanningAgent',
  'configureReviewAgent',
  'configureAdversarialReviewer',
  'configureClaudeRuntime',
  'showEffectiveConfiguration',
  'validateConfiguration',
  'launchClaude',
  'refreshConfiguration',
  'openAutonomousClaude',
  'startRun'
].map((c) => `autonomousDev.${c}`);

let fixtures: Fixtures;
let api: AutonomousDevApi;

function run(runId: string): DiscoveredRun {
  const found = api.getRuns().find((r) => r.runId === runId);
  assert.ok(found, `run ${runId} was not discovered`);
  return found;
}

before(async function () {
  this.timeout(60000);
  const extensionRoot = path.resolve(__dirname, '../..');
  const existingFolderCount = vscode.workspace.workspaceFolders?.length ?? 0;
  vscode.workspace.updateWorkspaceFolders(0, existingFolderCount, {
    uri: vscode.Uri.file(extensionRoot),
    name: 'autonomous-development-vsplugin'
  });
  const built = buildFixtures();
  const workspaceRepoId = resolveWorkspaceRepoId(extensionRoot);
  assert.ok(workspaceRepoId, 'integration test workspace must resolve as a Git repository');
  const repositories = path.join(built.stateHome, 'repositories');
  renameSync(path.join(repositories, built.repoId), path.join(repositories, workspaceRepoId));
  fixtures = {
    ...built,
    repoId: workspaceRepoId,
    runDir: (runId: string) => path.join(repositories, workspaceRepoId, 'runs', runId)
  };

  // Point the extension at the fixture state home through the real setting, then
  // activate — this also exercises the setting > env > default precedence.
  await vscode.workspace
    .getConfiguration('autonomousDev')
    .update('stateHome', fixtures.stateHome, vscode.ConfigurationTarget.Global);

  const ext = vscode.extensions.getExtension<AutonomousDevApi>(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} is not installed in the test host`);
  api = await ext.activate();
  api.refresh();
});

after(async () => {
  await vscode.workspace
    .getConfiguration('autonomousDev')
    .update('stateHome', undefined, vscode.ConfigurationTarget.Global);
  fixtures?.cleanup();
});

describe('activation', () => {
  it('returns the observer API and resolves the configured state home', () => {
    assert.equal(api.getStateHome(), fixtures.stateHome);
  });

  it('registers every contributed command', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const cmd of CONTRIBUTED_COMMANDS) {
      assert.ok(all.includes(cmd), `command not registered: ${cmd}`);
    }
  });

  it('exposes the controller-free config store as part of the observer API', () => {
    const store = api.getConfigStore();
    assert.ok(store, 'config store should be exposed for tests');
    // No controller path is set in the test host, so the snapshot must report
    // the unavailable state and NOT invent default profiles/presets.
    assert.equal(store.current.controllerAvailable, false);
    assert.deepEqual(store.current.effective, undefined);
    assert.deepEqual(store.current.presets, undefined);
    assert.deepEqual(store.current.profiles, undefined);
    assert.deepEqual(store.current.runtimes, undefined);
  });
});

describe('discovery and grouping', () => {
  it('discovers all fixture runs under the state home', () => {
    const ids = api.getRuns().map((r) => r.runId);
    for (const id of Object.values(fixtures.runIds)) {
      assert.ok(ids.includes(id), `expected run not discovered: ${id}`);
    }
  });

  it('places active and malformed runs in the active group', () => {
    const active = api.getRunsForGroup('active').map((r) => r.runId);
    for (const id of [
      'initialized',
      'currentCheckout',
      'implementing',
      'verificationFailed',
      'changesRequired',
      'adversarialRequired',
      'awaitingDecision',
      'malformed'
    ]) {
      assert.ok(active.includes(id), `active group missing: ${id}`);
    }
  });

  it('places terminal completed/blocked/cancelled runs in the completed group', () => {
    const completed = api.getRunsForGroup('completed').map((r) => r.runId);
    for (const id of ['complete', 'completeWithFollowups', 'blocked', 'cancelled']) {
      assert.ok(completed.includes(id), `completed group missing: ${id}`);
    }
  });

  it('honors loadArchivedRuns=false yet still discovers the archived run', () => {
    assert.deepEqual(api.getRunsForGroup('archived'), []);
    assert.ok(api.getRuns().some((r) => r.runId === 'archived'));
  });
});

describe('per-scenario workflow model (single shared evaluator)', () => {
  it('initialized (standard mode) → reconcile-spec', () => {
    // Default mode is "standard"; enhance is a rigorous-only phase
    // (controller.py compute_next_action), so a fresh run reconciles the spec.
    assert.equal(run('initialized').model?.recommendedNextAction.code, 'reconcile-spec');
  });

  it('enhanceRigorous (rigorous mode, no enhance artifact) → run-enhance', () => {
    assert.equal(run('enhanceRigorous').model?.recommendedNextAction.code, 'run-enhance');
  });

  it('implementing → run-verification', () => {
    assert.equal(run('implementing').model?.recommendedNextAction.code, 'run-verification');
  });

  it('verificationFailed → fix-verification + verification-failing gate', () => {
    const model = run('verificationFailed').model;
    assert.equal(model?.recommendedNextAction.code, 'fix-verification');
    assert.ok(model?.completionGateFailures.some((g) => g.code === 'verification-failing'));
  });

  it('changesRequired → triage-findings with review-not-pass + severe-findings gates', () => {
    const model = run('changesRequired').model;
    assert.equal(model?.recommendedNextAction.code, 'triage-findings');
    assert.ok(model?.completionGateFailures.some((g) => g.code === 'review-not-pass'));
    assert.ok(model?.completionGateFailures.some((g) => g.code === 'severe-findings'));
    assert.equal(model?.review.severeFindingCount, 1);
  });

  it('adversarialRequired → adversarial-review, required but unsatisfied', () => {
    const model = run('adversarialRequired').model;
    assert.equal(model?.recommendedNextAction.code, 'adversarial-review');
    assert.equal(model?.adversarial.required, true);
    assert.equal(model?.adversarial.satisfied, false);
    assert.ok(model?.completionGateFailures.some((g) => g.code === 'adversarial-required'));
  });

  it('complete → gates pass, no further action', () => {
    const model = run('complete').model;
    assert.equal(model?.status, 'complete');
    assert.equal(model?.gatesPass, true);
    assert.equal(model?.recommendedNextAction.code, 'none');
  });

  it('complete_with_followups → successful terminal with deferred adversarial history', () => {
    const model = run('completeWithFollowups').model;
    assert.equal(model?.status, 'complete_with_followups');
    assert.equal(model?.isTerminal, true);
    assert.equal(model?.gatesPass, true);
    assert.equal(model?.recommendedNextAction.code, 'none');
    assert.equal(model?.completionEvaluation?.followUpCount, 3);
    assert.equal(model?.adversarial.latestRound, 8);
    assert.equal(model?.adversarial.latestVerdict, 'changes_required');
  });

  it('awaiting adversarial human decision keeps the workflow cursor on adversarial', () => {
    const model = run('awaitingDecision').model;
    assert.equal(model?.recommendedNextAction.code, 'await-human-decision');
    assert.equal(model?.stages.find((stage) => stage.id === 'triage')?.status, 'complete');
    assert.equal(
      model?.stages.find((stage) => stage.id === 'adversarial-review')?.status,
      'active'
    );
  });

  it('blocked → blockingReason + continuation action', () => {
    const model = run('blocked').model;
    assert.equal(model?.status, 'blocked');
    assert.equal(model?.blockingReason, 'Review-round budget exhausted');
    assert.equal(model?.recommendedNextAction.code, 'continue-blocked');
  });

  it('cancelled → no further action', () => {
    assert.equal(run('cancelled').model?.recommendedNextAction.code, 'none');
  });
});

describe('malformed tolerance', () => {
  it('surfaces a diagnostic and no model without crashing the extension', () => {
    const bad = run('malformed');
    assert.equal(bad.state, undefined);
    assert.equal(bad.model, undefined);
    assert.ok(bad.diagnostics.some((d) => d.code === 'run-state-parse-error'));
  });

  it('retains the last valid state/model when a good run is corrupted mid-write', () => {
    const statePath = path.join(fixtures.runDir('implementing'), 'run-state.json');
    const original = readFileSync(statePath, 'utf8');
    try {
      writeFileSync(statePath, '{ truncated mid-write ');
      api.refresh();

      const reloaded = run('implementing');
      // The previously parsed state and derived model survive the bad reload…
      assert.equal(reloaded.state?.phase, 'implementing');
      assert.equal(reloaded.model?.recommendedNextAction.code, 'run-verification');
      // …while the fresh parse failure is still surfaced as a diagnostic.
      assert.ok(reloaded.diagnostics.some((d) => d.code === 'run-state-parse-error'));
    } finally {
      writeFileSync(statePath, original);
      api.refresh();
    }
  });
});

describe('legacy run inspection', () => {
  it('detects an in-repo .ai/autonomous-development run read-only', () => {
    const legacy = detectLegacyRun(fixtures.legacyRepoRoot);
    assert.ok(legacy, 'legacy run not detected');
    assert.equal(legacy.repoId, 'legacy');
    assert.equal(legacy.runId, 'legacy-run');
    assert.ok(legacy.model, 'legacy run should still derive a model');
  });
});

describe('opening artifacts and comparisons', () => {
  it('opens the original feature artifact in place (no copy into the repo)', async () => {
    await vscode.commands.executeCommand('autonomousDev.openOriginalFeature', run('complete'));
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'no active text editor after open');
    assert.ok(
      editor.document.uri.fsPath.endsWith(path.join('complete', 'feature-request.md')),
      `unexpected editor path: ${editor.document.uri.fsPath}`
    );
  });

  it('compares original idea vs accepted spec in the native diff editor', async () => {
    await vscode.commands.executeCommand('autonomousDev.compareSpec', run('complete'));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(
      tab?.input instanceof vscode.TabInputTextDiff,
      'active tab is not a native diff editor'
    );
  });

  it('opens a finding location on its 1-based source line', async () => {
    // The dashboard routes finding clicks through openFileAtLine; line 3 → 0-based 2.
    const uri = vscode.Uri.file(path.join(fixtures.runDir('complete'), 'accepted-plan.md'));
    const editor = await openFileAtLine(uri, 3);
    assert.equal(editor.selection.active.line, 2);
  });
});
