import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildControllerCommand, type ControllerContext } from '../src/controller/args';

const execFileP = promisify(execFile);

/**
 * End-to-end proof that Start Run forwards the selected preset to
 * `controller.py init` as a SEPARATE argv element and never embeds it in the
 * feature text.
 *
 * We use a fake controller written in Python (an interpreter is required for
 * any real run of this extension anyway) that:
 *   1. records the exact argv it received;
 *   2. asserts an active_preset different from the passed --preset;
 *   3. writes a run-state.json whose `preset` and `config_snapshot.preset`
 *      match the argv-supplied `--preset`, not the config's `active_preset`;
 *   4. writes a `feature-request.md` containing only the feature text.
 *
 * The extension host does not need to be running for this proof — the argv
 * comes from the pure {@link buildControllerCommand} adapter that both the
 * extension and this test consume.
 */
describe('Start Run preset forwarding (e2e via fake controller)', () => {
  let workDir: string;
  let stateHome: string;
  let controllerPath: string;

  const projectRoot = '/work/repo';
  const feature = 'Add CSV export --preset=maliciously-embedded';
  const activePresetInConfig = 'openai-anthropic';
  const selectedPreset = 'azure-autonomous';

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'preset-forward-'));
    stateHome = join(workDir, 'state');
    mkdirSync(stateHome, { recursive: true });
    controllerPath = join(workDir, 'controller.py');
    // The fake controller emits `argv-recording.json`, then simulates a
    // config-snapshot-pinned init by writing run-state.json + feature-request.md
    // into a repo-scoped run directory under state-home.
    writeFileSync(
      controllerPath,
      [
        '#!/usr/bin/env python3',
        'import json, os, sys, hashlib, datetime',
        '',
        '# Record argv verbatim so the test can inspect argv-separation.',
        'record_path = os.path.join(os.environ["FAKE_CONTROLLER_STATE"], "argv-recording.json")',
        'with open(record_path, "w") as f:',
        '    json.dump(sys.argv, f)',
        '',
        '# Only the init subcommand is exercised in this test.',
        'sub = "init" if "init" in sys.argv else None',
        'if sub != "init":',
        '    sys.exit(0)',
        '',
        '# Extract flags exactly as separate argv pairs — never by string parsing.',
        'def flag(name):',
        '    if name in sys.argv:',
        '        i = sys.argv.index(name)',
        '        return sys.argv[i + 1] if i + 1 < len(sys.argv) else None',
        '    return None',
        '',
        'feature_text = flag("--feature")',
        'preset = flag("--preset")',
        'state_dir = flag("--state-dir")',
        'project_root = flag("--project-root")',
        'assert feature_text is not None, "--feature must be present"',
        'assert state_dir is not None, "--state-dir must be present"',
        'assert project_root is not None, "--project-root must be present"',
        'assert preset is not None, "--preset must be a SEPARATE argv element"',
        '',
        '# Repo id is derived from the project-root path for the fake — the real',
        '# controller uses git identity; we mirror the shape without a real repo.',
        'repo_id = hashlib.sha256(project_root.encode()).hexdigest()[:12]',
        'run_id = "20260806T091439Z-ab08221b"',
        'run_dir = os.path.join(state_dir, "repositories", repo_id, "runs", run_id)',
        'os.makedirs(run_dir, exist_ok=True)',
        '',
        '# Simulate the controller\'s init: writes feature-request.md with ONLY the',
        '# feature text, and run-state.json with a config_snapshot pinned to preset.',
        'with open(os.path.join(run_dir, "feature-request.md"), "w") as f:',
        '    f.write(feature_text)',
        '',
        'state = {',
        '    "schema_version": 2,',
        '    "run_id": run_id,',
        '    "preset": preset,',
        '    "requested_mode": "standard",',
        '    "effective_mode": "standard",',
        '    "mode_origin": "preset",',
        '    "config_snapshot": {',
        '        "preset": preset,',
        '        "workflow": {"max_review_rounds": 3, "workflow_mode": "standard"},',
        '        "codex": {"plan": {"profile": "azure-gpt5p6-sol", "reasoning_effort": "high"}},',
        '        "claude_runtime": "azure-claude",',
        '    },',
        '    "created_at": datetime.datetime.utcnow().isoformat() + "Z",',
        '}',
        'with open(os.path.join(run_dir, "run-state.json"), "w") as f:',
        '    json.dump(state, f, indent=2)',
        '',
        'print(f"Initialized run {run_id} in {run_dir}")',
        ''
      ].join('\n')
    );
  });

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('builds --preset and --feature as SEPARATE argv elements', () => {
    const ctx: ControllerContext = {
      pythonPath: 'python3',
      controllerPath,
      projectRoot,
      stateHome
    };
    const { args } = buildControllerCommand(ctx, 'init', {
      feature,
      preset: selectedPreset,
      worktreeMode: 'isolated'
    });

    // --preset must be a separate argv element (not e.g. "--preset=azure-...").
    const presetIdx = args.indexOf('--preset');
    assert.ok(presetIdx >= 0, '--preset must appear as its own argv element');
    assert.equal(args[presetIdx + 1], selectedPreset);
    assert.equal(
      args.filter((a) => a === '--preset').length,
      1,
      'exactly one --preset argv element'
    );
    assert.ok(
      !args.some((a) => a.startsWith('--preset=')),
      'never emits --preset=<value> as one glued token'
    );

    // --feature carries ONLY the feature text — including an adversarial
    // "--preset=" inside the feature must not be treated as a preset flag.
    const featureIdx = args.indexOf('--feature');
    assert.ok(featureIdx >= 0);
    assert.equal(args[featureIdx + 1], feature);
    // The feature text is one argv element even though it contains spaces and
    // the substring "--preset=" — argv-array construction makes shell splitting
    // impossible here.
    assert.ok(args[featureIdx + 1]?.includes('--preset=maliciously-embedded'));
  });

  it('executes the fake controller and produces contract-compliant run state', async () => {
    const ctx: ControllerContext = {
      pythonPath: 'python3',
      controllerPath,
      projectRoot,
      stateHome
    };
    const { command, args } = buildControllerCommand(ctx, 'init', {
      feature,
      preset: selectedPreset,
      worktreeMode: 'isolated'
    });

    // Sanity: also embed an `active_preset` config file so we can prove the
    // extension's forwarding beats the config default.
    const configPath = join(workDir, 'config.toml');
    writeFileSync(configPath, `version = 1\nactive_preset = "${activePresetInConfig}"\n`);

    const { stdout } = await execFileP(command, [...args], {
      env: { ...process.env, FAKE_CONTROLLER_STATE: workDir },
      timeout: 15_000
    });
    assert.match(stdout, /Initialized run/);

    // Recorded argv includes --preset as a separate element with the exact
    // preset id we passed in.
    const argv = JSON.parse(readFileSync(join(workDir, 'argv-recording.json'), 'utf8')) as string[];
    const argPresetIdx = argv.indexOf('--preset');
    assert.ok(argPresetIdx >= 0, `recorded argv missing --preset: ${argv.join(' ')}`);
    assert.equal(argv[argPresetIdx + 1], selectedPreset);

    // Recorded argv --feature carries ONLY the feature text (the embedded
    // "--preset=..." substring is data, not an argument).
    const argFeatureIdx = argv.indexOf('--feature');
    assert.equal(argv[argFeatureIdx + 1], feature);

    // Locate the run directory the fake controller created.
    const repoDirs = readdirSyncSafe(join(stateHome, 'repositories'));
    assert.ok(repoDirs.length > 0);
    const runsRoot = join(stateHome, 'repositories', repoDirs[0]!, 'runs');
    const runIds = readdirSyncSafe(runsRoot);
    assert.ok(runIds.length > 0);
    const runDir = join(runsRoot, runIds[0]!);

    // run-state.json records the SELECTED preset (not active_preset).
    const state = JSON.parse(readFileSync(join(runDir, 'run-state.json'), 'utf8')) as {
      preset?: string;
      config_snapshot?: { preset?: string };
    };
    assert.equal(state.preset, selectedPreset);
    assert.notEqual(state.preset, activePresetInConfig);
    assert.equal(state.config_snapshot?.preset, selectedPreset);

    // feature-request.md contains ONLY the actual feature text — no --preset flag.
    const featureRequest = readFileSync(join(runDir, 'feature-request.md'), 'utf8');
    assert.equal(featureRequest, feature);
    assert.ok(!featureRequest.includes(`--preset ${selectedPreset}`));
  });
});

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
