import assert from 'node:assert/strict';

import type { WorkflowStage } from '@semanticmatter/core';

import { refineStagesForImplementerRunning } from '../src/dashboard/renderModel';

/** Minimal 12-stage list — only ids and initial statuses matter here. */
function makeStages(overrides: Partial<Record<string, WorkflowStage['status']>>): WorkflowStage[] {
  const seed: Array<{ id: string; title: string; status: WorkflowStage['status'] }> = [
    { id: 'initialized', title: 'Initialized', status: 'complete' },
    { id: 'idea-enhanced', title: 'Idea Enhanced', status: 'complete' },
    { id: 'spec-accepted', title: 'Specification Accepted', status: 'complete' },
    { id: 'plan-proposed', title: 'Plan Proposed', status: 'complete' },
    { id: 'plan-accepted', title: 'Plan Accepted', status: 'complete' },
    { id: 'implementing', title: 'Implementing', status: 'complete' },
    { id: 'verification', title: 'Verification', status: 'active' },
    { id: 'independent-review', title: 'Independent Review', status: 'pending' },
    { id: 'triage', title: 'Finding Triage and Fixes', status: 'pending' },
    { id: 'adversarial-review', title: 'Adversarial Review', status: 'skipped' },
    { id: 'completion-evaluation', title: 'Completion Evaluation', status: 'pending' },
    { id: 'final', title: 'Complete, Blocked, or Cancelled', status: 'pending' }
  ];
  return seed.map((s) => ({
    id: s.id as WorkflowStage['id'],
    title: s.title,
    status: (overrides[s.id] ?? s.status) as WorkflowStage['status']
  }));
}

function byId(stages: WorkflowStage[]): Map<string, WorkflowStage> {
  return new Map(stages.map((s) => [s.id, s]));
}

describe('refineStagesForImplementerRunning — Rule 1 (Implementing stays active)', () => {
  it('holds Implementing at active while a Claude terminal is alive AND phase is implementing', () => {
    const canonical = makeStages({ implementing: 'complete', verification: 'active' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: true,
        controllerPhase: 'implementing',
        hasChecks: true,
        status: 'active'
      })
    );
    assert.equal(refined.get('implementing')?.status, 'active');
  });

  it('holds Implementing at active while a Claude terminal is alive AND phase is plan-accepted', () => {
    const canonical = makeStages({ implementing: 'pending', verification: 'pending' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: true,
        controllerPhase: 'plan-accepted',
        hasChecks: false,
        status: 'active'
      })
    );
    assert.equal(refined.get('implementing')?.status, 'active');
  });

  it('does NOT force Implementing active when no Claude terminal is alive', () => {
    const canonical = makeStages({ implementing: 'complete' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: false,
        controllerPhase: 'implementing',
        hasChecks: true,
        status: 'active'
      })
    );
    assert.equal(refined.get('implementing')?.status, 'complete');
  });

  it('does NOT force Implementing active after the controller has recorded completion (phase advanced)', () => {
    const canonical = makeStages({ implementing: 'complete', verification: 'active' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: true,
        controllerPhase: 'verification',
        hasChecks: true,
        status: 'active'
      })
    );
    // Impl stays as the evaluator computed — completion is recorded.
    assert.equal(refined.get('implementing')?.status, 'complete');
  });

  it('holds Implementing active even if canonical says complete (terminal alive overrides completion by artifacts)', () => {
    // Scenario: hasChecks became true (verification checks recorded) but the
    // controller's phase is STILL "implementing" — the controller has not yet
    // recorded completion. Rule 1 keeps Implementing active regardless.
    const canonical = makeStages({ implementing: 'complete' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: true,
        controllerPhase: 'implementing',
        hasChecks: true,
        status: 'active'
      })
    );
    assert.equal(refined.get('implementing')?.status, 'active');
  });
});

describe('refineStagesForImplementerRunning — Rule 2 (Verification only active with all three conditions)', () => {
  const need3 = { status: 'active' as const };

  it('Verification stays pending when the controller has not transitioned to verification', () => {
    const canonical = makeStages({ verification: 'active' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: false,
        controllerPhase: 'implementing',
        hasChecks: false,
        ...need3
      })
    );
    assert.equal(refined.get('verification')?.status, 'pending');
  });

  it('Verification stays pending when phase = verification but no check has started (hasChecks=false)', () => {
    const canonical = makeStages({ verification: 'active' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: false,
        controllerPhase: 'verification',
        hasChecks: false,
        ...need3
      })
    );
    assert.equal(refined.get('verification')?.status, 'pending');
  });

  it('Verification becomes active when all three conditions hold', () => {
    const canonical = makeStages({ verification: 'active' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: false,
        controllerPhase: 'verification',
        hasChecks: true,
        ...need3
      })
    );
    assert.equal(refined.get('verification')?.status, 'active');
  });

  it('verification-failed phase counts as "transitioned to verification"', () => {
    const canonical = makeStages({ verification: 'active' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: false,
        controllerPhase: 'verification-failed',
        hasChecks: true,
        ...need3
      })
    );
    assert.equal(refined.get('verification')?.status, 'active');
  });

  it('Verification=failed is preserved (orthogonal to the active rule)', () => {
    const canonical = makeStages({ verification: 'failed' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: false,
        // Even if the impl hasn't "completed" per phase and no checks yet,
        // a failed marker on Verification must survive — it reflects the last
        // recorded verification attempt.
        controllerPhase: 'implementing',
        hasChecks: true,
        status: 'active'
      })
    );
    assert.equal(refined.get('verification')?.status, 'failed');
  });
});

describe('refineStagesForImplementerRunning — combined rules', () => {
  it('terminal alive + phase=implementing + hasChecks=true: Impl=active, Verification=pending', () => {
    const canonical = makeStages({ implementing: 'complete', verification: 'active' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: true,
        controllerPhase: 'implementing',
        hasChecks: true,
        status: 'active'
      })
    );
    assert.equal(refined.get('implementing')?.status, 'active');
    assert.equal(refined.get('verification')?.status, 'pending');
  });

  it('terminal alive + phase=plan-accepted + hasChecks=false: Impl=active, Verification=pending', () => {
    const canonical = makeStages({ implementing: 'pending', verification: 'pending' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: true,
        controllerPhase: 'plan-accepted',
        hasChecks: false,
        status: 'active'
      })
    );
    assert.equal(refined.get('implementing')?.status, 'active');
    assert.equal(refined.get('verification')?.status, 'pending');
  });

  it('terminal alive + phase=verification + hasChecks=true: Impl unchanged, Verification=active', () => {
    const canonical = makeStages({ implementing: 'complete', verification: 'active' });
    const refined = byId(
      refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: true,
        controllerPhase: 'verification',
        hasChecks: true,
        status: 'active'
      })
    );
    // Impl is not forced (controller has recorded completion by advancing phase).
    assert.equal(refined.get('implementing')?.status, 'complete');
    // All three verification conditions hold → active permitted.
    assert.equal(refined.get('verification')?.status, 'active');
  });
});

describe('refineStagesForImplementerRunning — terminal statuses are passthrough', () => {
  for (const status of ['complete', 'complete_with_followups', 'cancelled', 'archived'] as const) {
    it(`does not refine a ${status} run`, () => {
      const canonical = makeStages({ implementing: 'complete', verification: 'complete' });
      const refined = refineStagesForImplementerRunning(canonical, {
        claudeTerminalOpen: true,
        controllerPhase: 'implementing', // deliberately inconsistent with terminal status
        hasChecks: false,
        status
      });
      // Passthrough — an already-complete run's canonical stages are authoritative.
      assert.equal(refined.find((s) => s.id === 'implementing')?.status, 'complete');
      assert.equal(refined.find((s) => s.id === 'verification')?.status, 'complete');
    });
  }
});
