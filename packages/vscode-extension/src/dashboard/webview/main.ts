/**
 * Dashboard webview entry. Runs in the sandboxed webview (no Node, no vscode
 * module, strict CSP). It only renders the {@link DashboardView} it is sent and
 * posts intent messages back to the host — it performs no IO and holds no
 * secrets. All dynamic text goes through textContent (never innerHTML) so a
 * malicious artifact value cannot inject markup.
 */

import type {
  DashboardArtifact,
  DashboardCheck,
  DashboardCumulativeFinding,
  DashboardReviewRound,
  DashboardStage,
  DashboardView,
  WebviewMessage
} from '../viewTypes';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

type Child = Node | string | null | undefined | false;

function el(tag: string, props: Record<string, string> = {}, children: Child[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') {
      node.className = v;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function section(title: string, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card' }, [el('h2', {}, [title]), ...children]);
}

function kv(label: string, value: string): HTMLElement {
  return el('div', { class: 'kv' }, [
    el('span', { class: 'kv-label' }, [label]),
    el('span', { class: 'kv-value' }, [value])
  ]);
}

function button(
  label: string,
  onClick: () => void,
  props: Record<string, string> = {}
): HTMLElement {
  const b = el('button', { type: 'button', ...props }, [label]) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

function command(commandId: string): void {
  vscode.postMessage({ type: 'command', command: commandId });
}

function renderHeader(view: DashboardView): HTMLElement {
  const featureLine = (view.feature.split('\n')[0] ?? view.feature) || view.runId;
  const badges = el('div', { class: 'badges' }, [
    el('span', { class: `badge status-${view.status}` }, [view.status]),
    view.phase && el('span', { class: 'badge phase' }, [view.phase]),
    view.gatesPass
      ? el('span', { class: 'badge ok' }, ['gates pass'])
      : el('span', { class: 'badge warn' }, ['gates pending'])
  ]);
  const meta: Child[] = [
    kv('Run ID', view.runId),
    kv('Repository', view.repository.displayName ?? view.repository.id)
  ];
  if (view.repository.worktreePath) meta.push(kv('Worktree', view.repository.worktreePath));
  if (view.repository.worktreeMode) {
    meta.push(
      kv(
        'Checkout mode',
        view.repository.worktreeMode === 'current'
          ? 'current checkout'
          : view.repository.worktreeMode === 'isolated'
            ? 'isolated worktree'
            : view.repository.worktreeMode
      )
    );
  }
  if (view.repository.remoteDisplay) meta.push(kv('Remote', view.repository.remoteDisplay));
  if (view.createdAt) meta.push(kv('Created', view.createdAt));
  if (view.updatedAt) meta.push(kv('Updated', view.updatedAt));

  return el('header', { class: 'card header' }, [
    el('h1', {}, [featureLine]),
    badges,
    view.blockingReason
      ? el('p', { class: 'blocking' }, [`Blocked: ${view.blockingReason}`])
      : null,
    el('div', { class: 'meta' }, meta)
  ]);
}

function renderStages(stages: readonly DashboardStage[]): HTMLElement {
  const items = stages.map((s) =>
    el('li', { class: `stage stage-${s.status}`, title: s.detail ?? s.status }, [
      el('span', { class: 'stage-dot' }, []),
      el('span', { class: 'stage-title' }, [s.title]),
      el('span', { class: 'stage-status' }, [s.status])
    ])
  );
  return section('Workflow timeline', el('ol', { class: 'stages' }, items));
}

function renderStatus(view: DashboardView): HTMLElement {
  const gateList = view.gateFailures.length
    ? el(
        'ul',
        { class: 'gates' },
        view.gateFailures.map((g) => el('li', { class: 'gate' }, [g.message]))
      )
    : el('p', { class: 'ok' }, ['All completion gates pass.']);

  const statusCells: Child[] = [
    kv('Phase', view.phase || '—'),
    kv('Status', view.status),
    kv(
      'Review budget',
      `${view.reviewBudget.consumed}/${view.reviewBudget.max} used (${view.reviewBudget.remaining} left)`
    ),
    kv(
      'Verification',
      view.verification.hasChecks
        ? `${view.verification.passedCount}/${view.verification.total} passing`
        : 'no checks'
    ),
    kv('Latest review', view.review.latestVerdict ?? 'none'),
    kv(
      'Risk',
      view.risk.requiresAdversarialReview
        ? `adversarial required (${view.risk.reasons.join(', ') || 'unspecified'})`
        : 'standard'
    )
  ];
  if (view.effectiveMode) {
    statusCells.push(kv('Workflow mode', view.effectiveMode));
  }
  if (view.checkpoint) {
    const fallback = view.checkpoint.reviewContextMode === 'focused_full_fallback';
    statusCells.push(
      kv(
        'Review delta',
        view.checkpoint.isDelta
          ? `${view.checkpoint.changedPathsCount} changed path(s)${fallback ? ' (full-context fallback)' : ''}`
          : 'full review (round 1)'
      )
    );
  }

  return section(
    'Current status',
    el('div', { class: 'status-grid' }, statusCells),
    el('h3', {}, ['Completion gates']),
    gateList,
    el('div', { class: 'next-action' }, [
      el('strong', {}, ['Recommended next action: ']),
      view.nextAction.message || '—'
    ])
  );
}

function renderCumulativeFinding(f: DashboardCumulativeFinding): HTMLElement {
  const head = el('div', { class: 'finding-head' }, [
    el('span', { class: `sev sev-${(f.severity ?? 'unknown').toLowerCase()}` }, [
      f.severity ?? 'unknown'
    ]),
    f.category ? el('span', { class: 'cat' }, [f.category]) : null,
    f.id ? el('span', { class: 'fid' }, [f.id]) : null,
    f.blocking
      ? el('span', { class: 'badge warn' }, ['blocking'])
      : el('span', { class: 'badge ok' }, [f.status ?? 'released']),
    f.file
      ? button(
          `${f.file}${f.line ? `:${f.line}` : ''}`,
          () =>
            vscode.postMessage({
              type: 'openFinding',
              file: f.file as string,
              line: f.line ?? null
            }),
          { class: 'link' }
        )
      : null
  ]);
  const provenance: string[] = [];
  if (f.roundOpened !== undefined) provenance.push(`opened r${f.roundOpened}`);
  if (f.roundLastSeen !== undefined) provenance.push(`last seen r${f.roundLastSeen}`);
  if (f.origin) provenance.push(f.origin);
  if (f.resolvedAtRound !== undefined) provenance.push(`resolved r${f.resolvedAtRound}`);
  if (f.resolutionSource) provenance.push(`via ${f.resolutionSource}`);
  const body: Child[] = [];
  if (f.description) body.push(el('p', { class: 'finding-desc' }, [f.description]));
  if (provenance.length)
    body.push(el('p', { class: 'finding-prov muted' }, [provenance.join(' · ')]));
  return el('div', { class: `finding ${f.blocking ? 'blocking' : 'released'}` }, [head, ...body]);
}

function renderCumulativeFindings(view: DashboardView): HTMLElement | null {
  const cf = view.cumulativeFindings;
  if (cf.total === 0) {
    return null;
  }
  const summary = el('div', { class: 'ledger-summary' }, [
    kv('Total', String(cf.total)),
    kv('Blocking (critical/high)', String(cf.blockingSevereCount)),
    kv('Open', String(cf.openCount)),
    kv('Resolved', String(cf.resolvedCount))
  ]);
  return section(
    'Cumulative findings ledger',
    summary,
    el('div', { class: 'findings' }, cf.findings.map(renderCumulativeFinding))
  );
}

function renderAcceptanceCriteria(view: DashboardView): HTMLElement | null {
  const ac = view.acceptanceCriteria;
  if (ac.total === 0) {
    return null;
  }
  const rows = ac.criteria.map((c) =>
    el('tr', { class: c.blocking ? 'ac-blocking' : 'ac-satisfied' }, [
      el('td', {}, [c.id ?? '—']),
      el('td', {}, [
        el('span', { class: `ac-status ac-${(c.status ?? 'unknown').toLowerCase()}` }, [
          c.status ?? 'unknown'
        ])
      ]),
      el('td', {}, [c.blocking ? 'blocking' : 'satisfied']),
      el('td', {}, [c.evidence ?? ''])
    ])
  );
  const head = el(
    'tr',
    {},
    ['Criterion', 'Status', 'Gate', 'Evidence'].map((h) => el('th', {}, [h]))
  );
  return section(
    'Acceptance criteria',
    el('p', { class: ac.blockingCount > 0 ? 'warn' : 'ok' }, [
      `${ac.satisfiedCount}/${ac.total} satisfied` +
        (ac.blockingCount > 0 ? ` — ${ac.blockingCount} blocking completion` : '')
    ]),
    el('table', { class: 'checks' }, [el('thead', {}, [head]), el('tbody', {}, rows)])
  );
}

function renderCodexUsage(view: DashboardView): HTMLElement | null {
  const usage = view.codexUsage;
  if (usage.runs.length === 0) {
    return null;
  }
  const rows = usage.runs.map((r) =>
    el('tr', {}, [
      el('td', {}, [r.phase ?? '—']),
      el('td', {}, [r.model ?? '']),
      el('td', {}, [r.durationSeconds !== undefined ? `${r.durationSeconds.toFixed(1)}s` : '']),
      el('td', {}, [r.totalTokens !== undefined ? String(r.totalTokens) : '']),
      el('td', {}, [r.promptCharacters !== undefined ? String(r.promptCharacters) : '']),
      el('td', {}, [r.outputCharacters !== undefined ? String(r.outputCharacters) : ''])
    ])
  );
  const head = el(
    'tr',
    {},
    ['Phase', 'Model', 'Duration', 'Tokens', 'Prompt chars', 'Output chars'].map((h) =>
      el('th', {}, [h])
    )
  );
  const totals = el('p', { class: 'muted' }, [
    `Total: ${usage.totalDurationSeconds.toFixed(1)}s` +
      (usage.totalTokens > 0 ? `, ${usage.totalTokens} tokens` : '')
  ]);
  return section(
    'Codex usage',
    el('table', { class: 'checks' }, [el('thead', {}, [head]), el('tbody', {}, rows)]),
    totals
  );
}

function renderArtifactSummary(a: DashboardArtifact): HTMLElement | null {
  const sections = a.sections ?? [];
  if (sections.length === 0) {
    return null;
  }
  const total = sections.reduce((sum, s) => sum + s.items.length, 0);
  return el('details', { class: 'artifact-summary' }, [
    el('summary', {}, [`Semantic summary (${total})`]),
    ...sections.map((s) =>
      el('div', { class: 'summary-section' }, [
        el('h4', {}, [`${s.label} (${s.items.length})`]),
        el(
          'ul',
          { class: 'summary-list' },
          s.items.map((item) => el('li', {}, [item]))
        )
      ])
    )
  ]);
}

function renderArtifacts(view: DashboardView): HTMLElement {
  const rows = view.artifacts.map((a: DashboardArtifact) =>
    el('li', { class: `artifact ${a.exists ? 'present' : 'absent'}` }, [
      el('div', { class: 'artifact-row' }, [
        button(
          a.title,
          () => command(a.command),
          a.exists ? {} : { disabled: 'true', title: `${a.filename ?? ''} not found` }
        ),
        el('span', { class: 'artifact-file' }, [a.exists ? (a.filename ?? '') : 'not present'])
      ]),
      renderArtifactSummary(a)
    ])
  );
  const compare = el('div', { class: 'compare-actions' }, [
    button('Compare idea ↔ accepted spec', () => command('autonomousDev.compareSpec')),
    button('Compare proposed ↔ accepted plan', () => command('autonomousDev.comparePlan'))
  ]);
  return section('Prompt & artifact evolution', el('ol', { class: 'artifacts' }, rows), compare);
}

function renderVerification(view: DashboardView): HTMLElement {
  if (!view.verification.hasChecks) {
    return section(
      'Verification',
      el('p', { class: 'muted' }, ['No verification checks have been recorded.'])
    );
  }
  const rows = view.verification.checks.map((c: DashboardCheck) => {
    const status = c.passed ? 'pass' : 'fail';
    const cells: Child[] = [
      el('td', {}, [c.name]),
      el('td', { class: 'mono' }, [c.command]),
      el('td', { class: `check-${status}` }, [c.passed ? 'pass' : `exit ${c.exitCode ?? '?'}`]),
      el('td', {}, [c.attempts > 1 ? `${c.attempts} attempts` : '1 attempt']),
      el('td', {}, [c.completedAt ?? c.startedAt ?? ''])
    ];
    const logCell = el('td', {}, [
      c.log
        ? button(
            'log',
            () => vscode.postMessage({ type: 'openVerificationLog', log: c.log as string }),
            { class: 'link' }
          )
        : ''
    ]);
    cells.push(logCell);
    return el('tr', {}, cells);
  });
  const head = el(
    'tr',
    {},
    ['Check', 'Command', 'Result', 'Attempts', 'Completed', 'Log'].map((h) => el('th', {}, [h]))
  );
  return section(
    'Verification',
    el('table', { class: 'checks' }, [el('thead', {}, [head]), el('tbody', {}, rows)])
  );
}

function renderFinding(round: DashboardReviewRound): HTMLElement[] {
  return round.findings.map((f) => {
    const head = el('div', { class: 'finding-head' }, [
      el('span', { class: `sev sev-${(f.severity ?? 'unknown').toLowerCase()}` }, [
        f.severity ?? 'unknown'
      ]),
      f.category ? el('span', { class: 'cat' }, [f.category]) : null,
      f.id ? el('span', { class: 'fid' }, [f.id]) : null,
      f.file
        ? button(
            `${f.file}${f.line ? `:${f.line}` : ''}`,
            () =>
              vscode.postMessage({
                type: 'openFinding',
                file: f.file as string,
                line: f.line ?? null
              }),
            { class: 'link' }
          )
        : null,
      f.disposition
        ? el('span', { class: `disp disp-${f.disposition}` }, [f.disposition.replace(/_/g, ' ')])
        : null
    ]);
    const body: Child[] = [];
    if (f.description) body.push(el('p', { class: 'finding-desc' }, [f.description]));
    if (f.evidence)
      body.push(
        el('details', {}, [
          el('summary', {}, ['Evidence']),
          el('pre', { class: 'mono' }, [f.evidence])
        ])
      );
    if (f.recommendedFix)
      body.push(
        el('details', {}, [el('summary', {}, ['Recommended fix']), el('p', {}, [f.recommendedFix])])
      );
    return el('div', { class: 'finding' }, [head, ...body]);
  });
}

function renderReviewRounds(title: string, rounds: readonly DashboardReviewRound[]): HTMLElement {
  if (rounds.length === 0) {
    return section(title, el('p', { class: 'muted' }, ['None recorded.']));
  }
  const blocks = rounds.map((r) => {
    const counts = Object.entries(r.findingCountsBySeverity)
      .map(([sev, n]) => `${n} ${sev}`)
      .join(', ');
    const header = el('div', { class: 'round-head' }, [
      el('span', { class: 'round-num' }, [`Round ${r.round ?? '?'}`]),
      el('span', { class: `verdict verdict-${(r.verdict ?? 'unknown').toLowerCase()}` }, [
        r.verdict ?? (r.readable ? 'no verdict' : 'unreadable')
      ]),
      r.confidence !== undefined
        ? el('span', { class: 'conf' }, [`confidence ${r.confidence}`])
        : null,
      counts ? el('span', { class: 'counts' }, [counts]) : null
    ]);
    const body = r.readable
      ? r.findings.length
        ? el('div', { class: 'findings' }, renderFinding(r))
        : el('p', { class: 'ok' }, ['No findings.'])
      : el('p', { class: 'muted' }, [
          'This review file could not be read; showing cached verdict only.'
        ]);
    return el('div', { class: 'round' }, [
      header,
      r.summary ? el('p', { class: 'round-summary' }, [r.summary]) : null,
      body,
      ...renderReviewMetadata(r)
    ]);
  });
  return section(title, ...blocks);
}

function renderReviewMetadata(round: DashboardReviewRound): Child[] {
  const extras: Child[] = [];
  if (round.acceptanceCriteria.length > 0) {
    extras.push(
      el('details', { class: 'ac' }, [
        el('summary', {}, [`Acceptance criteria (${round.acceptanceCriteria.length})`]),
        el(
          'ul',
          { class: 'ac-list' },
          round.acceptanceCriteria.map((a) =>
            el('li', { class: `ac-item ac-${(a.status ?? 'unknown').toLowerCase()}` }, [
              el('span', { class: 'ac-id' }, [a.id ?? '—']),
              el('span', { class: 'ac-status' }, [a.status ?? 'unknown']),
              a.evidence ? el('span', { class: 'ac-evidence' }, [a.evidence]) : null
            ])
          )
        )
      ])
    );
  }
  if (round.verificationGaps.length > 0) {
    extras.push(
      el('details', { class: 'gaps' }, [
        el('summary', {}, [`Verification gaps (${round.verificationGaps.length})`]),
        el(
          'ul',
          { class: 'gap-list' },
          round.verificationGaps.map((g) => el('li', {}, [g]))
        )
      ])
    );
  }
  return extras;
}

function renderTriage(view: DashboardView): HTMLElement | null {
  const files = view.review.triageFiles;
  if (files.length === 0) {
    return null;
  }
  return section(
    'Finding triage',
    el('p', { class: 'muted' }, [
      'Legacy triage notes, shown read-only. No structured disposition is inferred from them.'
    ]),
    el(
      'ul',
      { class: 'triage' },
      files.map((t) =>
        el('li', { class: 'triage-file' }, [
          button(t.filename, () => vscode.postMessage({ type: 'openRunFile', file: t.filename }), {
            class: 'link'
          })
        ])
      )
    )
  );
}

function renderTimeline(view: DashboardView): HTMLElement | null {
  if (view.timeline.length === 0) {
    return null;
  }
  const items = view.timeline.map((e) =>
    el('li', { class: 'event' }, [
      el('span', { class: 'event-seq' }, [`#${e.sequence}`]),
      el('span', { class: 'event-time' }, [e.timestamp]),
      el('span', { class: 'event-type' }, [e.type]),
      el('span', { class: 'event-summary' }, [e.summary])
    ])
  );
  return section(
    'Event log',
    view.truncatedTimeline
      ? el('p', { class: 'muted' }, ['The final log line was truncated and skipped.'])
      : null,
    el('ol', { class: 'events' }, items)
  );
}

function renderConfigSnapshot(view: DashboardView): HTMLElement | null {
  const snap = view.configSnapshot;
  if (!snap) return null;
  const rows: Child[] = [
    kv('Preset used', snap.preset ?? '—'),
    kv('Claude runtime', snap.claudeRuntime ?? '—'),
    kv('Workflow mode', snap.workflowMode ?? '—'),
    kv(
      'Maximum review rounds',
      snap.maxReviewRounds !== undefined ? String(snap.maxReviewRounds) : '—'
    )
  ];
  for (const phase of snap.phases) {
    const detail = [phase.profile ?? '— default —', phase.reasoningEffort ?? '—']
      .filter(Boolean)
      .join(' · ');
    const model = phase.model ? ` (model: ${phase.model})` : '';
    rows.push(kv(phaseSnapshotLabel(phase.phase), `${detail}${model}`));
  }
  const note = el(
    'p',
    { class: 'muted' },
    ['This is the configuration snapshot recorded when the run was initialized. It does not reflect the current global preset.']
  );
  return section('Configuration snapshot', note, ...rows);
}

function phaseSnapshotLabel(phase: string): string {
  switch (phase) {
    case 'enhance':
      return 'Enhance profile/effort';
    case 'plan':
      return 'Plan profile/effort';
    case 'review':
      return 'Review profile/effort';
    case 'adversarial':
      return 'Adversarial profile/effort';
    default:
      return `${phase} profile/effort`;
  }
}

function renderDiagnostics(view: DashboardView): HTMLElement | null {
  if (view.diagnostics.length === 0) {
    return null;
  }
  return section(
    'Diagnostics',
    el(
      'ul',
      { class: 'diagnostics' },
      view.diagnostics.map((d) =>
        el('li', { class: `diag diag-${d.severity}` }, [`${d.severity}: ${d.message}`])
      )
    )
  );
}

function render(view: DashboardView): void {
  const app = document.getElementById('app');
  if (!app) {
    return;
  }
  app.textContent = '';
  const fragments: Child[] = [
    renderHeader(view),
    renderStages(view.stages),
    renderStatus(view),
    renderConfigSnapshot(view),
    renderCumulativeFindings(view),
    renderAcceptanceCriteria(view),
    renderArtifacts(view),
    renderVerification(view),
    renderReviewRounds('Independent review', view.review.rounds),
    renderTriage(view),
    view.adversarial.required
      ? renderReviewRounds('Adversarial review', view.adversarial.rounds)
      : null,
    renderCodexUsage(view),
    renderTimeline(view),
    renderDiagnostics(view)
  ];
  for (const f of fragments) {
    if (f && typeof f !== 'string') {
      app.append(f);
    }
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; view?: DashboardView };
  if (data && data.type === 'render' && data.view) {
    render(data.view);
  }
});

vscode.postMessage({ type: 'ready' });
