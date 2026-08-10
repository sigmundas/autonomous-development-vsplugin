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

const TASK_COLLAPSED_MAX_CHARS = 400;

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function checkoutLabel(mode?: string): string | undefined {
  if (!mode) return undefined;
  if (mode === 'current') return 'current checkout';
  if (mode === 'isolated') return 'isolated worktree';
  return mode;
}

function renderTaskBlock(view: DashboardView): HTMLElement {
  const text = view.feature || view.runId;
  const long = text.length > TASK_COLLAPSED_MAX_CHARS;
  const body = el('p', { class: `task-body${long ? ' collapsed' : ''}`, id: 'task-body' }, [text]);
  const wrap = el('div', { class: 'task-wrap' }, [
    el('h2', { class: 'small-label' }, ['Task']),
    body
  ]);
  if (long) {
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'link toggle-task',
        'aria-controls': 'task-body',
        'aria-expanded': 'false',
        tabindex: '0'
      },
      ['Show more']
    ) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      const expanded = body.classList.toggle('collapsed');
      // toggle returns true iff the class list contains the token afterwards —
      // classList.toggle: true means class ADDED. So "expanded" here is false.
      const isNowCollapsed = expanded;
      btn.textContent = isNowCollapsed ? 'Show more' : 'Show less';
      btn.setAttribute('aria-expanded', String(!isNowCollapsed));
    });
    btn.addEventListener('keydown', (e: Event) => {
      const key = (e as KeyboardEvent).key;
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        btn.click();
      }
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

function renderHeader(view: DashboardView): HTMLElement {
  const badges = el('div', { class: 'badges' }, [
    el('span', { class: `badge status-${view.status}` }, [view.status]),
    view.phase && el('span', { class: 'badge phase' }, [view.phase]),
    view.gatesPass
      ? el('span', { class: 'badge ok' }, ['gates pass'])
      : el('span', { class: 'badge warn' }, ['gates pending'])
  ]);

  const repoMeta: Child[] = [
    kv('Run ID', view.runId),
    kv('Repository', view.repository.displayName ?? view.repository.id)
  ];
  if (view.repository.branch) repoMeta.push(kv('Branch', view.repository.branch));
  if (view.repository.baselineCommit) {
    const short = shortSha(view.repository.baselineCommit);
    repoMeta.push(
      el('div', { class: 'kv', title: view.repository.baselineCommit }, [
        el('span', { class: 'kv-label' }, ['Baseline']),
        el('span', { class: 'kv-value monospace' }, [short])
      ])
    );
  }
  const checkout = checkoutLabel(view.repository.worktreeMode);
  if (checkout) repoMeta.push(kv('Checkout', checkout));
  if (view.repository.worktreePath) repoMeta.push(kv('Worktree', view.repository.worktreePath));
  if (view.repository.remoteDisplay) repoMeta.push(kv('Remote', view.repository.remoteDisplay));
  if (view.createdAt) repoMeta.push(kv('Created', view.createdAt));
  if (view.updatedAt) repoMeta.push(kv('Updated', view.updatedAt));
  if (view.recovery.parentRunId) repoMeta.push(kv('Continuation of', view.recovery.parentRunId));
  if (view.recovery.continuedByRunId) {
    repoMeta.push(kv('Continued by run', view.recovery.continuedByRunId));
  }

  const canResume = !view.isTerminal && !view.recovery.reviewBudgetExhausted;
  const canCancel = view.status === 'active';
  const terminalOpen = view.claudeTerminalOpen;
  const actions = el('div', { class: 'run-actions' }, [
    view.recovery.reviewBudgetExhausted &&
    (view.status === 'active' || view.status === 'blocked')
      ? button(
          view.recovery.continuedByRunId
            ? `Resume review continuation ${view.recovery.continuedByRunId}`
            : 'Allow one more review',
          () => command('autonomousDev.authorizeReview'), {
          class: 'primary',
          title:
            view.status === 'blocked'
              ? 'Create or reuse a linked continuation, authorize +1 review there, and resume it without mutating the terminal parent.'
              : 'Explicitly authorize +1 review for this run and resume it without changing its snapshotted or global configuration.'
          }
        )
      : null,
    view.status === 'blocked'
      ? button(
          view.nextAction.code === 'resume-adversarial'
            ? 'Resume missing adversarial review'
            : view.recovery.continuedByRunId
              ? `Resume continuation ${view.recovery.continuedByRunId}`
              : 'Continue blocked run…',
          () => command('autonomousDev.continueBlockedRun'), {
          class: 'primary',
          title: 'Create a linked follow-up on the same checkout with preserved context and evidence.'
          }
        )
      : null,
    canResume
      ? terminalOpen
        ? button('Focus Claude terminal', () => command('autonomousDev.focusClaudeTerminal'), {
            class: 'primary',
            title:
              'An extension-tracked Claude terminal is already open for this run. Clicking will reveal it — a new session will not be spawned.'
          })
        : button('▶ Resume in Claude', () => command('autonomousDev.resumeInClaude'), {
            class: 'primary',
            title:
              "Launch the run's snapshotted Claude runtime rooted at its worktree and continue from the recorded phase."
          })
      : null,
    canCancel
      ? button('Cancel run', () => command('autonomousDev.cancelRun'), { class: 'danger' })
      : null,
    view.status === 'blocked'
      ? button('Archive', () => command('autonomousDev.archiveRun'))
      : null
  ]);

  return el('header', { class: 'card header' }, [
    renderTaskBlock(view),
    badges,
    view.blockingReason
      ? el('p', { class: 'blocking' }, [`Blocked: ${view.blockingReason}`])
      : null,
    view.recovery.reviewBudgetExhausted || view.status === 'blocked'
      ? el('p', { class: 'muted' }, [
          view.recovery.reviewBudgetExhausted
            ? 'Progress stopped because the snapshotted review-round budget was exhausted. '
            : `Progress stopped because the run is blocked${view.blockingReason ? `: ${view.blockingReason}` : ''}. `,
          `Work ${view.recovery.workPreserved ? 'is' : 'may be'} preserved; verification ${
            view.recovery.verificationPreserved ? 'is recorded' : 'has not been recorded'
          }. Required gates remain pending until they are reassessed.`
        ])
      : null,
    el('div', { class: 'meta' }, repoMeta),
    actions
  ]);
}

function renderCurrentActivity(view: DashboardView): HTMLElement | null {
  const activity = view.currentActivity;
  if (!activity) return null;
  const cells: Child[] = [
    kv('Phase', activity.phase || '—'),
    kv('Next', activity.nextActionMessage || '—')
  ];
  if (view.review.hasReviews) {
    const round =
      view.review.latestRound !== undefined ? `Round ${view.review.latestRound}` : 'Completed';
    const verdict = view.review.latestVerdict?.replaceAll('_', ' ');
    cells.push(kv('Latest Codex review', verdict ? `${round} · ${verdict}` : round));
    if (activity.phase === 'triage') {
      cells.push(kv('Now', 'Codex review finished; Claude is triaging and fixing findings'));
    } else if (
      activity.phase === 'review' ||
      activity.phase === 'reviewing' ||
      activity.phase === 'independent-review'
    ) {
      cells.push(kv('Now', 'Earlier review finished; Codex re-review is in progress'));
    }
  }
  if (activity.latestNote) cells.push(kv('Latest note', activity.latestNote));
  cells.push(
    kv('Claude terminal', activity.claudeTerminalOpen ? 'open (this extension)' : 'not open')
  );
  if (activity.updatedAt) cells.push(kv('Updated', activity.updatedAt));
  return section(
    'Current activity',
    el('div', { class: 'status-grid' }, cells),
    el('p', { class: 'muted small' }, [
      'Detailed live activity (files being read, tests running, Codex tool events) requires the planned Claude Agent SDK and Codex app-server adapters and is deferred.'
    ])
  );
}

/**
 * Best-known artifact / log command for each pipeline stage. Stages without an
 * associated command render as plain (non-clickable) list items.
 */
const STAGE_COMMANDS: Readonly<Record<string, string>> = {
  'idea-enhanced': 'autonomousDev.openEnhancedSpec',
  'spec-accepted': 'autonomousDev.openAcceptedSpec',
  'plan-proposed': 'autonomousDev.openProposedPlan',
  'plan-accepted': 'autonomousDev.openAcceptedPlan',
  verification: 'autonomousDev.openVerificationLog',
  'independent-review': 'autonomousDev.openLatestReview',
  'adversarial-review': 'autonomousDev.openLatestReview'
};

function renderStages(stages: readonly DashboardStage[]): HTMLElement {
  const items = stages.map((s) => {
    const cmd = STAGE_COMMANDS[s.id];
    const clickable = cmd !== undefined && (s.status === 'complete' || s.status === 'failed');
    const titleRow = el('div', { class: 'stage-title-row' }, [
      el('span', { class: 'stage-title' }, [s.title]),
      el('span', { class: 'stage-status' }, [s.status])
    ]);
    const contents: Child[] = [el('span', { class: 'stage-dot' }, []), titleRow];
    if (s.meta) {
      contents.push(
        el(
          'span',
          {
            class: 'stage-meta',
            title: s.metaTooltip ? `${s.meta}\n${s.metaTooltip}` : s.meta
          },
          [s.meta]
        )
      );
    }
    if (s.detail) {
      contents.push(el('span', { class: 'stage-detail' }, [s.detail]));
    }
    const li = el(
      'li',
      {
        class: `stage stage-${s.status}${clickable ? ' clickable' : ''}`,
        title: clickable ? `Open the artifact for ${s.title}` : (s.detail ?? s.status),
        ...(clickable ? { role: 'button', tabindex: '0' } : {})
      },
      contents
    );
    if (clickable && cmd) {
      li.addEventListener('click', () => command(cmd));
      li.addEventListener('keydown', (e: Event) => {
        const key = (e as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') {
          e.preventDefault();
          command(cmd);
        }
      });
    }
    return li;
  });
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
        + (view.reviewBudget.max > view.reviewBudget.originalMax
          ? `; original limit ${view.reviewBudget.originalMax}, +${view.reviewBudget.max - view.reviewBudget.originalMax} authorized`
          : '')
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
  if (f.assessmentState === 'needs_reassessment') provenance.push('needs reassessment');
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
          c.assessmentState === 'needs_reassessment'
            ? `${c.status ?? 'unknown'} (needs reassessment)`
            : c.status ?? 'unknown'
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
  if (!snap) {
    // Legacy run without a config_snapshot — call this out explicitly so users
    // understand Resume in Claude will fall back to the global runtime.
    return section(
      'Run configuration',
      el('p', { class: 'muted' }, [
        'This run predates config-snapshot pinning. Resume in Claude will fall back to the currently configured Claude runtime for new runs.'
      ])
    );
  }
  const rows: Child[] = [
    kv('Preset used (this run)', snap.preset ?? '—'),
    kv('Claude runtime (this run)', snap.claudeRuntime ?? '—'),
    kv('Workflow mode (this run)', snap.workflowMode ?? '—'),
    kv(
      'Maximum review rounds (this run)',
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
  const note = el('p', { class: 'muted' }, [
    'These values were snapshotted when the run was initialized. They are what "Resume in Claude" will use. They do NOT reflect the current global preset — change the global preset only for new runs.'
  ]);
  return section('Run configuration (snapshot)', note, ...rows);
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
    renderCurrentActivity(view),
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
