import assert from 'node:assert/strict';
import {
  buildControllerCommand,
  isMutatingSubcommand,
  type ControllerContext
} from '../src/controller/args';

const ctx: ControllerContext = {
  pythonPath: 'python3',
  controllerPath: '/opt/autodev/scripts/controller.py',
  projectRoot: '/work/repo',
  stateHome: '/state'
};

describe('buildControllerCommand (REFERENCE §10 adapter contract)', () => {
  it('spawns the python executable, never a shell', () => {
    const cmd = buildControllerCommand(ctx, 'doctor');
    assert.equal(cmd.command, 'python3');
    assert.equal(cmd.args[0], '/opt/autodev/scripts/controller.py');
    // argv array — no interpolated shell string anywhere.
    assert.ok(Array.isArray(cmd.args));
  });

  it('always passes --project-root and --state-dir globally', () => {
    const { args } = buildControllerCommand(ctx, 'list-runs');
    assert.deepEqual(args, [
      '/opt/autodev/scripts/controller.py',
      '--project-root',
      '/work/repo',
      '--state-dir',
      '/state',
      'list-runs',
      '--json'
    ]);
  });

  it('omits --state-dir when no state home is configured', () => {
    const { args } = buildControllerCommand({ ...ctx, stateHome: undefined }, 'doctor');
    assert.ok(!args.includes('--state-dir'));
  });

  it('list-runs --all includes archived/terminal', () => {
    const { args } = buildControllerCommand(ctx, 'list-runs', { all: true });
    assert.ok(args.includes('--all'));
  });

  it('passes a global --run-id for run-scoped commands', () => {
    const { args } = buildControllerCommand(ctx, 'show-run', { runId: 'RID' });
    const i = args.indexOf('--run-id');
    assert.ok(i >= 0);
    assert.equal(args[i + 1], 'RID');
    // exactly one --run-id (no duplicate subcommand-level flag).
    assert.equal(args.filter((a) => a === '--run-id').length, 1);
    // global flag precedes the subcommand.
    assert.ok(i < args.indexOf('show-run'));
  });

  it('throws if a run-scoped command is missing a runId (no single-active fallback)', () => {
    for (const sub of [
      'show-run',
      'status',
      'evaluate',
      'accept-drift',
      'cancel',
      'archive-run'
    ] as const) {
      assert.throws(() => buildControllerCommand(ctx, sub), /requires an explicit runId/, sub);
    }
  });

  it('does not require a runId for doctor / list-runs', () => {
    assert.doesNotThrow(() => buildControllerCommand(ctx, 'doctor'));
    assert.doesNotThrow(() => buildControllerCommand(ctx, 'list-runs'));
  });

  it('cancel passes an optional --reason', () => {
    const { args } = buildControllerCommand(ctx, 'cancel', { runId: 'RID', reason: 'superseded' });
    const i = args.indexOf('--reason');
    assert.ok(i >= 0);
    assert.equal(args[i + 1], 'superseded');
  });

  it('tags mutating vs read-only subcommands', () => {
    assert.equal(buildControllerCommand(ctx, 'evaluate', { runId: 'R' }).mutating, true);
    assert.equal(buildControllerCommand(ctx, 'doctor').mutating, false);
    assert.equal(isMutatingSubcommand('archive-run'), true);
    assert.equal(isMutatingSubcommand('show-run'), false);
  });

  it('scopes recovery mutations to the selected run', () => {
    for (const sub of ['authorize-review', 'continue-run'] as const) {
      const cmd = buildControllerCommand(ctx, sub, { runId: 'R-parent' });
      assert.equal(cmd.mutating, true);
      assert.deepEqual(cmd.args.slice(-3), ['--run-id', 'R-parent', sub]);
      assert.throws(() => buildControllerCommand(ctx, sub), /requires an explicit runId/);
    }
  });

  it('carries the selected recovery intent into continue-run', () => {
    const cmd = buildControllerCommand(ctx, 'continue-run', {
      runId: 'R-parent',
      recoveryIntent: 'resume-adversarial'
    });
    assert.deepEqual(cmd.args.slice(-5), [
      '--run-id',
      'R-parent',
      'continue-run',
      '--intent',
      'resume-adversarial'
    ]);
  });

  it('init builds --feature and is mutating, run-id-free', () => {
    const cmd = buildControllerCommand(ctx, 'init', { feature: 'Add CSV export' });
    assert.equal(cmd.mutating, true);
    assert.deepEqual(cmd.args, [
      '/opt/autodev/scripts/controller.py',
      '--project-root',
      '/work/repo',
      '--state-dir',
      '/state',
      'init',
      '--feature',
      'Add CSV export'
    ]);
    // init creates a new run; it must never carry a --run-id.
    assert.ok(!cmd.args.includes('--run-id'));
    assert.equal(isMutatingSubcommand('init'), true);
  });

  it('init appends optional --label, --mode, --max-review-rounds in order', () => {
    const { args } = buildControllerCommand(ctx, 'init', {
      feature: 'F',
      label: 'My run',
      mode: 'rigorous',
      maxReviewRounds: 3
    });
    const at = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    assert.equal(at('--label'), 'My run');
    assert.equal(at('--mode'), 'rigorous');
    assert.equal(at('--max-review-rounds'), '3');
  });

  it('init appends --worktree-mode and --allow-main when requested', () => {
    const { args } = buildControllerCommand(ctx, 'init', {
      feature: 'F',
      worktreeMode: 'current',
      allowMain: true
    });
    const i = args.indexOf('--worktree-mode');
    assert.ok(i >= 0);
    assert.equal(args[i + 1], 'current');
    assert.ok(args.includes('--allow-main'));
  });

  it('init throws without a feature description', () => {
    assert.throws(() => buildControllerCommand(ctx, 'init'), /requires a feature description/);
    assert.throws(
      () => buildControllerCommand(ctx, 'init', { feature: '' }),
      /requires a feature description/
    );
  });
});
