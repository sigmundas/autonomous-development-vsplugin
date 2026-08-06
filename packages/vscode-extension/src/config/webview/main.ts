/**
 * Configuration webview client. Runs inside the panel's sandboxed frame and
 * exchanges typed messages with {@link ConfigPanel} in the extension host.
 *
 * All controller-provided text is escaped through `renderText` / `renderOption`
 * before being inserted into the DOM. No inline event handlers are used; every
 * interaction is wired through `addEventListener` in code below.
 */

// The VS Code webview messaging API is provided at runtime by the host.
declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

interface ConfigView {
  controllerAvailable: boolean;
  error?: string;
  configPath?: string;
  configExists: boolean;
  activePreset?: string;
  workflowMode?: string;
  maxReviewRounds?: number;
  claudeRuntime?: {
    name: string;
    displayName: string;
    launcher?: string;
    launcherExists: boolean;
    launcherExecutable: boolean;
  };
  presets: { name: string; workflowMode?: string; claudeRuntime?: string }[];
  profiles: {
    id: string;
    label: string;
    provider?: string;
    model?: string;
    valid: boolean;
    error?: string;
  }[];
  claudeRuntimes: {
    name: string;
    displayName: string;
    launcher?: string;
    launcherExists: boolean;
    launcherExecutable: boolean;
  }[];
  phases: {
    phase: 'enhance' | 'plan' | 'review' | 'adversarial';
    title: string;
    profileId?: string;
    profileLabel?: string;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    effortLabel?: string;
    profileMissing: boolean;
    profileInvalid: boolean;
  }[];
  reasoningEfforts: { value: string; label: string }[];
  validation?: { valid: boolean; error?: string; warnings: string[] };
  warnings: string[];
  trusted: boolean;
}

const vscode = acquireVsCodeApi();
let latestView: ConfigView | undefined;
let saving = false;

window.addEventListener('message', (event) => {
  const msg = event.data as { type?: string; view?: ConfigView; message?: string } | undefined;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'render' && msg.view) {
    latestView = msg.view;
    saving = false;
    render(msg.view);
  } else if (msg.type === 'error' && typeof msg.message === 'string') {
    saving = false;
    showError(msg.message);
    if (latestView) render(latestView);
  }
});

function post(msg: unknown): void {
  if (saving) return;
  vscode.postMessage(msg);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function showError(message: string): void {
  const app = document.getElementById('app');
  if (!app) return;
  const banner = app.querySelector('.error-banner');
  if (banner) banner.remove();
  const div = el('div', { class: 'error-banner', role: 'alert' }, message);
  app.prepend(div);
}

function render(view: ConfigView): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '';

  if (!view.controllerAvailable) {
    app.appendChild(renderUnavailable());
    return;
  }
  if (view.error && view.presets.length === 0 && view.profiles.length === 0) {
    const wrap = el('section', { class: 'panel' });
    wrap.appendChild(el('h2', {}, 'Configuration unavailable'));
    wrap.appendChild(el('p', {}, view.error));
    const btn = el('button', { type: 'button' }, 'Set Up Controller') as HTMLButtonElement;
    btn.addEventListener('click', () => post({ type: 'setupController' }));
    wrap.appendChild(btn);
    app.appendChild(wrap);
    return;
  }

  app.appendChild(renderHeader(view));
  app.appendChild(renderGeneral(view));
  app.appendChild(renderClaude(view));
  app.appendChild(renderPhases(view));
  app.appendChild(renderValidation(view));
  app.appendChild(renderFooter(view));
}

function renderUnavailable(): HTMLElement {
  const wrap = el('section', { class: 'panel' });
  wrap.appendChild(el('h2', {}, 'Autonomous Development — Configuration'));
  wrap.appendChild(
    el(
      'p',
      {},
      'The autonomous-development controller is not configured. Observer features continue to work; configuration editing is unavailable until the controller path is set.'
    )
  );
  const btn = el('button', { type: 'button', class: 'primary' }, 'Set Up Controller') as HTMLButtonElement;
  btn.addEventListener('click', () => post({ type: 'setupController' }));
  wrap.appendChild(btn);
  return wrap;
}

function renderHeader(view: ConfigView): HTMLElement {
  const wrap = el('header', { class: 'header' });
  wrap.appendChild(el('h1', {}, 'Autonomous Development'));
  const sub = el(
    'p',
    { class: 'muted' },
    'Changes apply to new runs. Existing runs continue using their configuration snapshot.'
  );
  wrap.appendChild(sub);
  if (view.configPath) {
    wrap.appendChild(el('p', { class: 'muted small' }, `Config: ${view.configPath}${view.configExists ? '' : ' (not yet created)'}`));
  }
  if (!view.trusted) {
    wrap.appendChild(
      el(
        'p',
        { class: 'warning', role: 'alert' },
        'Workspace is not trusted. Configuration is read-only until you enable workspace trust.'
      )
    );
  }
  return wrap;
}

function renderGeneral(view: ConfigView): HTMLElement {
  const wrap = el('section', { class: 'panel' });
  wrap.appendChild(el('h2', {}, 'General'));

  const grid = el('div', { class: 'grid' });

  // Active preset (editable)
  grid.appendChild(el('label', { for: 'preset-select', class: 'field-label' }, 'Active preset'));
  const presetSelect = document.createElement('select');
  presetSelect.id = 'preset-select';
  presetSelect.disabled = !view.trusted;
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '— none —';
  if (!view.activePreset) emptyOpt.selected = true;
  presetSelect.appendChild(emptyOpt);
  for (const preset of view.presets) {
    const opt = document.createElement('option');
    opt.value = preset.name;
    opt.textContent = preset.workflowMode
      ? `${preset.name}  ·  ${preset.workflowMode}`
      : preset.name;
    if (preset.name === view.activePreset) opt.selected = true;
    presetSelect.appendChild(opt);
  }
  presetSelect.addEventListener('change', () => {
    if (presetSelect.value.length > 0) {
      saving = true;
      vscode.postMessage({ type: 'setPreset', name: presetSelect.value });
    }
  });
  grid.appendChild(presetSelect);

  // Workflow mode (read-only summary; controlled by preset and top-level
  // [workflow] TOML block. Not editable from the extension: the controller
  // config contract does not yet expose a mutating command for these fields.)
  grid.appendChild(el('span', { class: 'field-label' }, 'Workflow mode'));
  grid.appendChild(
    el('span', { class: 'value muted' }, `${view.workflowMode ?? '—'} · read-only`)
  );

  // Max review rounds (same rationale as workflow mode)
  grid.appendChild(el('span', { class: 'field-label' }, 'Maximum review rounds'));
  grid.appendChild(
    el(
      'span',
      { class: 'value muted' },
      `${view.maxReviewRounds !== undefined ? String(view.maxReviewRounds) : '—'} · read-only`
    )
  );

  wrap.appendChild(grid);
  wrap.appendChild(
    el(
      'p',
      { class: 'muted small' },
      "These settings can't be edited here yet. To change them, open your config.toml file and edit them there, then click Refresh — or use “Show Effective Configuration” to open the file directly."
    )
  );
  return wrap;
}

function renderClaude(view: ConfigView): HTMLElement {
  const wrap = el('section', { class: 'panel' });
  wrap.appendChild(el('h2', {}, 'Claude runtime'));
  wrap.appendChild(
    el(
      'p',
      { class: 'muted small' },
      'This selection chooses which pre-installed launcher script the extension spawns when you press "Launch Claude for Selected Preset". The launcher owns the Claude provider, deployment/model, and reasoning effort — this version of the extension does not edit those directly.'
    )
  );
  wrap.appendChild(
    el(
      'p',
      { class: 'muted small' },
      'Selection applies to newly launched Claude Code sessions only. It does not change the provider of an already-running session.'
    )
  );

  const grid = el('div', { class: 'grid' });
  grid.appendChild(el('label', { for: 'claude-select', class: 'field-label' }, 'Selected runtime'));
  const select = document.createElement('select');
  select.id = 'claude-select';
  select.disabled = !view.trusted || !view.activePreset;
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '— none —';
  if (!view.claudeRuntime) empty.selected = true;
  select.appendChild(empty);
  for (const rt of view.claudeRuntimes) {
    const opt = document.createElement('option');
    opt.value = rt.name;
    let label = rt.displayName;
    if (!rt.launcherExists) label += ' · launcher missing';
    else if (!rt.launcherExecutable) label += ' · launcher not executable';
    opt.textContent = label;
    if (view.claudeRuntime && rt.name === view.claudeRuntime.name) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    if (select.value.length > 0) {
      saving = true;
      vscode.postMessage({ type: 'setClaudeRuntime', name: select.value });
    }
  });
  grid.appendChild(select);

  if (view.claudeRuntime) {
    grid.appendChild(el('span', { class: 'field-label' }, 'Runtime id'));
    grid.appendChild(el('span', { class: 'value monospace' }, view.claudeRuntime.name));
    if (view.claudeRuntime.launcher) {
      grid.appendChild(el('span', { class: 'field-label' }, 'Launcher'));
      grid.appendChild(el('span', { class: 'value monospace' }, view.claudeRuntime.launcher));
    }
    grid.appendChild(el('span', { class: 'field-label' }, 'Availability'));
    const status =
      view.claudeRuntime.launcherExists && view.claudeRuntime.launcherExecutable
        ? 'launcher exists and is executable'
        : !view.claudeRuntime.launcherExists
          ? 'launcher missing'
          : 'launcher not executable';
    grid.appendChild(
      el(
        'span',
        {
          class:
            view.claudeRuntime.launcherExists && view.claudeRuntime.launcherExecutable
              ? 'value'
              : 'value warning'
        },
        status
      )
    );
  }
  wrap.appendChild(grid);

  const launch = el(
    'button',
    {
      type: 'button',
      class: 'primary',
      title:
        'Launch a fresh Claude Code session using the currently selected runtime. This starts an unbound session — to continue an existing run, use "Resume in Claude" from the Active Runs view.'
    },
    'Launch Claude for New Runs'
  ) as HTMLButtonElement;
  launch.disabled =
    !view.trusted ||
    !view.claudeRuntime ||
    !view.claudeRuntime.launcherExists ||
    !view.claudeRuntime.launcherExecutable;
  launch.addEventListener('click', () => post({ type: 'launchClaude' }));
  wrap.appendChild(launch);
  return wrap;
}

function renderPhases(view: ConfigView): HTMLElement {
  const wrap = el('section', { class: 'panel' });
  wrap.appendChild(el('h2', {}, 'Codex phases'));
  const preset = view.activePreset ?? '';
  for (const phase of view.phases) {
    wrap.appendChild(renderPhaseCard(view, phase, preset));
  }
  return wrap;
}

function renderPhaseCard(
  view: ConfigView,
  phase: ConfigView['phases'][number],
  preset: string
): HTMLElement {
  const card = el('div', { class: 'phase-card' });
  card.appendChild(el('h3', {}, phase.title));

  const grid = el('div', { class: 'grid' });

  // Profile dropdown
  const profileId = `profile-${phase.phase}`;
  grid.appendChild(el('label', { for: profileId, class: 'field-label' }, 'Codex profile'));
  const profileSelect = document.createElement('select');
  profileSelect.id = profileId;
  profileSelect.disabled = !view.trusted || preset.length === 0;
  const inherit = document.createElement('option');
  inherit.value = '';
  inherit.textContent = '— inherit / default —';
  if (!phase.profileId) inherit.selected = true;
  profileSelect.appendChild(inherit);
  let matched = false;
  for (const profile of view.profiles) {
    const opt = document.createElement('option');
    opt.value = profile.id;
    opt.textContent = profile.valid
      ? `${profile.label}  ·  ${profile.id}`
      : `${profile.label}  ·  ${profile.id} (invalid)`;
    if (profile.id === phase.profileId) {
      opt.selected = true;
      matched = true;
    }
    profileSelect.appendChild(opt);
  }
  if (!matched && phase.profileId) {
    const missing = document.createElement('option');
    missing.value = phase.profileId;
    missing.textContent = `${phase.profileId} (missing)`;
    missing.selected = true;
    profileSelect.appendChild(missing);
  }
  profileSelect.addEventListener('change', () => {
    saving = true;
    vscode.postMessage({
      type: 'setPhase',
      preset,
      phase: phase.phase,
      profile: profileSelect.value
    });
  });
  grid.appendChild(profileSelect);

  // Effective provider / model / id
  const currentProfile = view.profiles.find((p) => p.id === phase.profileId);
  grid.appendChild(el('span', { class: 'field-label' }, 'Effective provider'));
  grid.appendChild(el('span', { class: 'value' }, currentProfile?.provider ?? '—'));
  grid.appendChild(el('span', { class: 'field-label' }, 'Effective model'));
  grid.appendChild(el('span', { class: 'value' }, currentProfile?.model ?? '—'));
  grid.appendChild(el('span', { class: 'field-label' }, 'Profile id'));
  grid.appendChild(el('span', { class: 'value monospace' }, phase.profileId ?? '—'));

  // Reasoning effort dropdown
  const effortId = `effort-${phase.phase}`;
  grid.appendChild(el('label', { for: effortId, class: 'field-label' }, 'Reasoning effort'));
  const effortSelect = document.createElement('select');
  effortSelect.id = effortId;
  effortSelect.disabled = !view.trusted || preset.length === 0;
  const emptyEffort = document.createElement('option');
  emptyEffort.value = '';
  emptyEffort.textContent = '— default —';
  if (!phase.reasoningEffort) emptyEffort.selected = true;
  effortSelect.appendChild(emptyEffort);
  for (const eff of view.reasoningEfforts) {
    const opt = document.createElement('option');
    opt.value = eff.value;
    opt.textContent = eff.label;
    if (eff.value === phase.reasoningEffort) opt.selected = true;
    effortSelect.appendChild(opt);
  }
  effortSelect.addEventListener('change', () => {
    saving = true;
    vscode.postMessage({
      type: 'setPhase',
      preset,
      phase: phase.phase,
      reasoningEffort: effortSelect.value.length > 0 ? effortSelect.value : undefined
    });
  });
  grid.appendChild(effortSelect);

  // Status
  grid.appendChild(el('span', { class: 'field-label' }, 'Status'));
  const statusText = phase.profileMissing
    ? 'Selected profile is missing under $CODEX_HOME'
    : phase.profileInvalid
      ? 'Selected profile is invalid'
      : 'OK';
  grid.appendChild(
    el(
      'span',
      { class: phase.profileMissing || phase.profileInvalid ? 'value warning' : 'value ok' },
      statusText
    )
  );

  card.appendChild(grid);
  return card;
}

function renderValidation(view: ConfigView): HTMLElement {
  const wrap = el('section', { class: 'panel' });
  wrap.appendChild(el('h2', {}, 'Validation'));
  if (!view.validation) {
    wrap.appendChild(el('p', {}, 'Validation has not been run yet.'));
  } else if (view.validation.valid) {
    wrap.appendChild(el('p', { class: 'ok' }, 'Configuration is valid.'));
    if (view.validation.warnings.length > 0) {
      const ul = el('ul');
      for (const w of view.validation.warnings) ul.appendChild(el('li', {}, w));
      wrap.appendChild(ul);
    }
  } else {
    wrap.appendChild(el('p', { class: 'warning' }, view.validation.error ?? 'Configuration is invalid.'));
  }
  const btn = el('button', { type: 'button' }, 'Re-validate') as HTMLButtonElement;
  btn.addEventListener('click', () => post({ type: 'validate' }));
  wrap.appendChild(btn);
  return wrap;
}

function renderFooter(view: ConfigView): HTMLElement {
  const wrap = el('footer', { class: 'footer' });
  const refreshBtn = el('button', { type: 'button' }, 'Refresh') as HTMLButtonElement;
  refreshBtn.addEventListener('click', () => post({ type: 'refresh' }));
  const startBtn = el('button', { type: 'button', class: 'primary' }, 'Start Run') as HTMLButtonElement;
  startBtn.disabled = !view.trusted;
  startBtn.addEventListener('click', () => post({ type: 'startRun' }));
  wrap.appendChild(refreshBtn);
  wrap.appendChild(startBtn);
  return wrap;
}

vscode.postMessage({ type: 'ready' });
// Silence unused escapeHtml when strict linting is enabled; the helper is
// intentionally available for future controller-provided text insertion.
void escapeHtml;
