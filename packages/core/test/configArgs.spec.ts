import assert from 'node:assert/strict';
import {
  buildControllerCommand,
  isConfigSubcommand,
  isMutatingSubcommand,
  type ControllerContext
} from '../src/controller/args';

const ctx: ControllerContext = {
  pythonPath: 'python3',
  controllerPath: '/opt/autodev/scripts/controller.py',
  projectRoot: '/work/repo',
  stateHome: '/state'
};

describe('buildControllerCommand — config subcommands', () => {
  it('config-show emits --json and is read-only', () => {
    const { args, mutating } = buildControllerCommand(ctx, 'config-show');
    assert.equal(mutating, false);
    assert.deepEqual(args, [
      '/opt/autodev/scripts/controller.py',
      '--state-dir',
      '/state',
      'config-show',
      '--json'
    ]);
    assert.equal(isConfigSubcommand('config-show'), true);
    assert.equal(isMutatingSubcommand('config-show'), false);
  });

  it('builds global config commands without repository identity', () => {
    const globalCtx: ControllerContext = {
      pythonPath: 'python3',
      controllerPath: '/opt/autodev/scripts/controller.py',
      stateHome: '/state'
    };
    const { args } = buildControllerCommand(globalCtx, 'config-show');
    assert.ok(!args.includes('--project-root'));
    assert.throws(
      () => buildControllerCommand(globalCtx, 'list-runs'),
      /requires an explicit projectRoot/
    );
  });

  it('config list commands all pass --json', () => {
    for (const sub of [
      'config-list-profiles',
      'config-list-presets',
      'config-list-claude-runtimes',
      'config-list-claude-models'
    ] as const) {
      const { args } = buildControllerCommand(ctx, sub);
      assert.ok(args.includes('--json'), `${sub} should include --json`);
    }
  });

  it('config-set-claude-model supports a configured id and Default', () => {
    assert.deepEqual(
      buildControllerCommand(ctx, 'config-set-claude-model', { name: 'sonnet' }).args.slice(-2),
      ['config-set-claude-model', 'sonnet']
    );
    assert.equal(
      buildControllerCommand(ctx, 'config-set-claude-model').args.at(-1),
      'config-set-claude-model'
    );
  });

  it('config-validate is read-only and JSON', () => {
    const { args, mutating } = buildControllerCommand(ctx, 'config-validate');
    assert.equal(mutating, false);
    assert.ok(args.includes('--json'));
  });

  it('config-set-active-preset requires a name and is mutating', () => {
    assert.throws(() => buildControllerCommand(ctx, 'config-set-active-preset'), /requires a name/);
    const { args, mutating } = buildControllerCommand(ctx, 'config-set-active-preset', {
      name: 'azure-autonomous'
    });
    assert.equal(mutating, true);
    assert.equal(args[args.length - 1], 'azure-autonomous');
  });

  it('config-set-claude-runtime requires a name and is mutating', () => {
    assert.throws(
      () => buildControllerCommand(ctx, 'config-set-claude-runtime'),
      /requires a name/
    );
    const { args, mutating } = buildControllerCommand(ctx, 'config-set-claude-runtime', {
      name: 'azure-claude'
    });
    assert.equal(mutating, true);
    assert.ok(args.includes('config-set-claude-runtime'));
    assert.equal(args[args.length - 1], 'azure-claude');
  });

  it('config-set-review-context-reuse serializes an explicit boolean', () => {
    assert.throws(
      () => buildControllerCommand(ctx, 'config-set-review-context-reuse'),
      /requires enabled/
    );
    const command = buildControllerCommand(ctx, 'config-set-review-context-reuse', {
      enabled: true
    });
    assert.equal(command.mutating, true);
    assert.deepEqual(command.args.slice(-2), ['config-set-review-context-reuse', 'true']);
  });

  it('config-set-phase requires --preset and --phase', () => {
    assert.throws(() => buildControllerCommand(ctx, 'config-set-phase'), /--preset/);
    assert.throws(
      () =>
        buildControllerCommand(ctx, 'config-set-phase', {
          configPreset: 'azure-autonomous'
        }),
      /--phase/
    );
  });

  it('config-set-phase serializes profile, reasoning effort, model, verbosity in argv order', () => {
    const { args } = buildControllerCommand(ctx, 'config-set-phase', {
      configPreset: 'azure-autonomous',
      phase: 'plan',
      profile: 'azure-gpt5p6-sol',
      reasoningEffort: 'xhigh',
      model: 'gpt-5.6-sol',
      verbosity: 'terse'
    });
    // preset and phase are required and appear first, then optional flags.
    const flags = args.filter(
      (a) =>
        a === '--preset' ||
        a === '--phase' ||
        a === '--profile' ||
        a === '--model' ||
        a === '--reasoning-effort' ||
        a === '--verbosity'
    );
    assert.deepEqual(flags, [
      '--preset',
      '--phase',
      '--profile',
      '--model',
      '--reasoning-effort',
      '--verbosity'
    ]);
    assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'xhigh');
    assert.equal(args[args.indexOf('--profile') + 1], 'azure-gpt5p6-sol');
  });

  it('init accepts --preset and threads it after other flags', () => {
    const { args } = buildControllerCommand(ctx, 'init', {
      feature: 'Add CSV export',
      preset: 'azure-autonomous'
    });
    const i = args.indexOf('--preset');
    assert.ok(i > args.indexOf('init'));
    assert.equal(args[i + 1], 'azure-autonomous');
  });

  it('init without preset does not include --preset', () => {
    const { args } = buildControllerCommand(ctx, 'init', { feature: 'x' });
    assert.ok(!args.includes('--preset'));
  });

  it('never builds a shell string — argv is a plain array', () => {
    const { args } = buildControllerCommand(ctx, 'config-list-profiles');
    for (const arg of args) {
      assert.equal(typeof arg, 'string');
      assert.doesNotMatch(arg, /["'`$]/, 'no shell metachars smuggled through');
    }
  });
});
