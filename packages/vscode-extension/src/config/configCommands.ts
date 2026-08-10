import * as vscode from 'vscode';
import {
  CONTROLLER_PHASES,
  REASONING_EFFORTS,
  type AutonomousPreset,
  type ClaudeRuntime,
  type CodexProfile,
  type ControllerPhase,
  type ControllerReasoningEffort,
  type EffectiveConfiguration,
  type PhaseConfiguration
} from '@semanticmatter/core';

import { ConfigPanel } from './configPanel';
import type { ConfigStore } from '../configStore';
import { friendlyProfileLabel, friendlyRuntimeLabel, reasoningEffortLabel } from '../configStore';
import type { ConfigClient } from '../controller/configClient';
import { ControllerError } from '../controller/controllerService';
import type { OutputLog } from '../output';
import { isWorkspaceTrusted } from '../trust';

export interface ConfigCommandDeps {
  readonly context: vscode.ExtensionContext;
  readonly store: ConfigStore;
  readonly client: ConfigClient;
  readonly log: OutputLog;
}

function reportError(action: string, err: unknown): void {
  const message =
    err instanceof ControllerError ? err.message : err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`${action}: ${message}`);
}

async function ensureReady(deps: ConfigCommandDeps): Promise<boolean> {
  if (!deps.client.isConfigured()) {
    const choice = await vscode.window.showWarningMessage(
      'No autonomous-development controller is configured. Configuration is unavailable until you set up the controller.',
      'Set Up Controller'
    );
    if (choice === 'Set Up Controller') {
      await vscode.commands.executeCommand('autonomousDev.setupController');
    }
    return false;
  }
  if (!isWorkspaceTrusted()) {
    void vscode.window.showErrorMessage(
      'Autonomous-development configuration requires a trusted workspace.'
    );
    return false;
  }
  return true;
}

/** Configure command: opens the full webview. */
export async function openConfigPanel(deps: ConfigCommandDeps): Promise<void> {
  if (!deps.client.isConfigured()) {
    const choice = await vscode.window.showWarningMessage(
      'The autonomous-development controller is not configured. Configuration editing is unavailable.',
      'Set Up Controller'
    );
    if (choice === 'Set Up Controller') {
      await vscode.commands.executeCommand('autonomousDev.setupController');
    }
    return;
  }
  ConfigPanel.show(deps.context.extensionUri, deps.store, deps.client, deps.log);
}

async function pickPreset(
  presets: readonly AutonomousPreset[],
  activePreset: string | undefined
): Promise<string | undefined> {
  if (presets.length === 0) {
    void vscode.window.showInformationMessage(
      'No presets are defined in the autonomous-development config file.'
    );
    return undefined;
  }
  const items = presets.map((preset) => ({
    label: preset.name,
    description: [preset.workflowMode, preset.claudeRuntime].filter(Boolean).join(' · '),
    detail: preset.name === activePreset ? 'currently active' : undefined,
    preset: preset.name
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select Active Preset',
    placeHolder: activePreset ?? 'No preset is currently active'
  });
  return picked?.preset;
}

export async function selectPreset(deps: ConfigCommandDeps): Promise<void> {
  if (!(await ensureReady(deps))) return;
  try {
    const snap = await deps.store.refresh();
    const list = snap.presets;
    if (!list) return;
    const picked = await pickPreset(list.presets, list.activePreset);
    if (!picked) return;
    await deps.client.setActivePreset(picked);
    await deps.store.refresh();
    void vscode.window.showInformationMessage(
      `Active preset set to "${picked}". Changes apply to new runs; existing runs continue using their configuration snapshot.`
    );
  } catch (err) {
    reportError('Select preset', err);
  }
}

function profileQuickPickItems(
  profiles: readonly CodexProfile[],
  current?: string
): (vscode.QuickPickItem & { profile?: string })[] {
  const items: (vscode.QuickPickItem & { profile?: string })[] = [];
  items.push({
    label: '— inherit / default —',
    description: 'Let the controller resolve the model normally',
    detail: current === undefined ? 'currently selected' : undefined,
    profile: undefined
  });
  for (const p of profiles) {
    const label = friendlyProfileLabel(p);
    items.push({
      label: p.valid ? label : `$(warning) ${label}`,
      description: p.id,
      detail:
        (p.id === current ? 'currently selected' : '') +
        (p.valid ? '' : ` ${p.error ? '· ' + p.error : '· invalid profile'}`),
      profile: p.id
    });
  }
  return items;
}

function effortQuickPickItems(current?: ControllerReasoningEffort): (vscode.QuickPickItem & {
  effort: ControllerReasoningEffort | undefined;
})[] {
  const items: (vscode.QuickPickItem & { effort: ControllerReasoningEffort | undefined })[] = [];
  items.push({
    label: '— default —',
    description: 'Use the phase default',
    detail: current === undefined ? 'currently selected' : undefined,
    effort: undefined
  });
  for (const value of REASONING_EFFORTS) {
    items.push({
      label: reasoningEffortLabel(value),
      description: value,
      detail: value === current ? 'currently selected' : undefined,
      effort: value
    });
  }
  return items;
}

async function configurePhase(deps: ConfigCommandDeps, phase: ControllerPhase): Promise<void> {
  if (!(await ensureReady(deps))) return;
  try {
    const snap = await deps.store.refresh();
    const effective = snap.effective;
    if (!effective) return;
    const activePreset = effective.activePreset;
    if (!activePreset) {
      const choice = await vscode.window.showWarningMessage(
        'No active preset is set. Select a preset before configuring a phase.',
        'Select Preset'
      );
      if (choice === 'Select Preset') {
        await vscode.commands.executeCommand('autonomousDev.selectPreset');
      }
      return;
    }
    const current = effective.effective.codex[phase] ?? ({} as PhaseConfiguration);

    const profilePick = await vscode.window.showQuickPick(
      profileQuickPickItems(snap.profiles?.profiles ?? [], current.profile),
      {
        title: `Configure ${phaseTitle(phase)} — Codex profile`,
        placeHolder: 'Choose a profile discovered under $CODEX_HOME'
      }
    );
    if (!profilePick) return;

    const effortPick = await vscode.window.showQuickPick(
      effortQuickPickItems(current.reasoningEffort),
      {
        title: `Configure ${phaseTitle(phase)} — Reasoning effort`
      }
    );
    if (!effortPick) return;

    await deps.client.setPhase({
      preset: activePreset,
      phase,
      profile: profilePick.profile ?? '',
      ...(effortPick.effort !== undefined ? { reasoningEffort: effortPick.effort } : {})
    });
    await deps.store.refresh();
    void vscode.window.showInformationMessage(
      `${phaseTitle(phase)} configuration updated. Changes apply to new runs.`
    );
  } catch (err) {
    reportError(`Configure ${phaseTitle(phase)}`, err);
  }
}

export const configurePlanningAgent = (deps: ConfigCommandDeps): Promise<void> =>
  configurePhase(deps, 'plan');
export const configureReviewAgent = (deps: ConfigCommandDeps): Promise<void> =>
  configurePhase(deps, 'review');
export const configureAdversarialReviewer = (deps: ConfigCommandDeps): Promise<void> =>
  configurePhase(deps, 'adversarial');
export const configureEnhance = (deps: ConfigCommandDeps): Promise<void> =>
  configurePhase(deps, 'enhance');

function runtimeQuickPickItems(
  runtimes: readonly ClaudeRuntime[],
  current?: string
): (vscode.QuickPickItem & { name: string })[] {
  return runtimes.map((rt) => {
    const label = friendlyRuntimeLabel(rt);
    const trouble = !rt.launcherExists
      ? 'launcher missing'
      : !rt.launcherExecutable
        ? 'launcher not executable'
        : '';
    return {
      label: trouble.length > 0 ? `$(warning) ${label}` : label,
      description: rt.name,
      detail:
        (rt.name === current ? 'currently selected' : '') +
        (trouble.length > 0 ? ` · ${trouble}` : rt.launcher ? ` · ${rt.launcher}` : ''),
      name: rt.name
    };
  });
}

export async function configureClaudeRuntime(deps: ConfigCommandDeps): Promise<void> {
  if (!(await ensureReady(deps))) return;
  try {
    const snap = await deps.store.refresh();
    const runtimes = snap.runtimes?.claudeRuntimes ?? [];
    if (runtimes.length === 0) {
      void vscode.window.showInformationMessage(
        'No Claude runtimes are defined in the autonomous-development config file.'
      );
      return;
    }
    if (!snap.effective?.activePreset) {
      void vscode.window.showWarningMessage(
        'Select an active preset before choosing a Claude runtime — the runtime is stored on the active preset.'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      runtimeQuickPickItems(runtimes, snap.effective.effective.claudeRuntime),
      {
        title: 'Configure Claude Runtime',
        placeHolder: 'Selection applies to newly launched Claude Code sessions'
      }
    );
    if (!picked) return;
    await deps.client.setClaudeRuntime(picked.name);
    await deps.store.refresh();
    void vscode.window.showInformationMessage(
      `Claude runtime set to "${picked.name}". This applies when launching a new session; it does not change the provider of an already-running Claude Code session.`
    );
  } catch (err) {
    reportError('Configure Claude runtime', err);
  }
}

export async function configureClaudeModel(deps: ConfigCommandDeps): Promise<void> {
  if (!(await ensureReady(deps))) return;
  try {
    const snap = await deps.store.refresh();
    if (!snap.effective?.activePreset) {
      void vscode.window.showWarningMessage(
        'Select an active preset before choosing a Claude model.'
      );
      return;
    }
    const current = snap.effective.effective.claudeModel?.id;
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Default', description: 'Do not pass --model', id: undefined, picked: !current },
        ...(snap.models?.claudeModels ?? []).map((model) => ({
          label: model.displayName ?? model.id,
          description: model.model,
          id: model.id,
          picked: model.id === current
        }))
      ],
      { title: 'Configure Claude Model', placeHolder: 'Selection applies to new runs only' }
    );
    if (!picked) return;
    await deps.client.setClaudeModel(picked.id);
    await deps.store.refresh();
  } catch (err) {
    reportError('Configure Claude model', err);
  }
}

export async function showEffectiveConfiguration(deps: ConfigCommandDeps): Promise<void> {
  if (!deps.client.isConfigured()) {
    void vscode.window.showWarningMessage(
      'The autonomous-development controller is not configured. Configuration display is unavailable.'
    );
    return;
  }
  try {
    await deps.store.refresh();
    const effective = deps.store.current.effective;
    if (!effective) {
      void vscode.window.showWarningMessage(
        deps.store.current.error ?? 'Unable to load autonomous-development configuration.'
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(effective, null, 2)
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err) {
    reportError('Show effective configuration', err);
  }
}

export async function validateConfiguration(deps: ConfigCommandDeps): Promise<void> {
  if (!deps.client.isConfigured()) {
    void vscode.window.showWarningMessage(
      'The autonomous-development controller is not configured; validation is unavailable.'
    );
    return;
  }
  try {
    await deps.store.refresh();
    const validation = deps.store.current.validation;
    if (!validation) {
      void vscode.window.showWarningMessage('Validation did not return a result.');
      return;
    }
    if (validation.valid) {
      const warn =
        validation.warnings.length > 0 ? ` (${validation.warnings.length} warning(s))` : '';
      void vscode.window.showInformationMessage(
        `Autonomous-development configuration is valid${warn}.`
      );
    } else {
      void vscode.window.showErrorMessage(
        validation.error ?? 'Autonomous-development configuration is invalid.'
      );
    }
  } catch (err) {
    reportError('Validate configuration', err);
  }
}

/** Preflight summary shown before {@link controllerInitStartRun}. */
export interface PreflightSummary {
  readonly activePreset?: string;
  readonly claudeRuntime?: string;
  readonly claudeModel?: string;
  readonly workflowMode?: string;
  readonly maxReviewRounds?: number;
  readonly phaseSummaries: readonly {
    readonly phase: ControllerPhase;
    readonly title: string;
    readonly profileLabel: string;
    readonly effortLabel: string;
  }[];
}

export function buildPreflightSummary(
  effective: EffectiveConfiguration | undefined,
  profiles: readonly CodexProfile[] | undefined
): PreflightSummary {
  if (!effective) return { phaseSummaries: [] };
  const wf = effective.effective.workflow;
  const phaseSummaries = CONTROLLER_PHASES.filter(
    (p) => p !== 'enhance' || effective.effective.codex[p]
  ).map((phase) => {
    const conf = effective.effective.codex[phase];
    const profile = profiles?.find((prof) => prof.id === conf?.profile);
    return {
      phase,
      title: phaseTitle(phase),
      profileLabel: profile ? friendlyProfileLabel(profile) : (conf?.profile ?? 'default'),
      effortLabel: conf?.reasoningEffort ? reasoningEffortLabel(conf.reasoningEffort) : '—'
    };
  });
  return {
    ...(effective.activePreset ? { activePreset: effective.activePreset } : {}),
    ...(effective.effective.claudeRuntime
      ? { claudeRuntime: effective.effective.claudeRuntime }
      : {}),
    ...(effective.effective.claudeModel
      ? {
          claudeModel:
            effective.effective.claudeModel.displayName ?? effective.effective.claudeModel.id
        }
      : {}),
    ...(wf.workflowMode ? { workflowMode: wf.workflowMode } : {}),
    ...(wf.maxReviewRounds !== undefined ? { maxReviewRounds: wf.maxReviewRounds } : {}),
    phaseSummaries
  };
}

export function formatPreflight(summary: PreflightSummary): string {
  const lines: string[] = [];
  lines.push(`Preset: ${summary.activePreset ?? '— none —'}`);
  lines.push(`Claude: ${summary.claudeRuntime ?? '— none —'}`);
  lines.push(`Claude model: ${summary.claudeModel ?? 'Default'}`);
  for (const phase of summary.phaseSummaries) {
    lines.push(`${phase.title}: ${phase.profileLabel} — ${phase.effortLabel}`);
  }
  lines.push(`Workflow mode: ${summary.workflowMode ?? 'default'}`);
  lines.push(`Maximum review rounds: ${summary.maxReviewRounds ?? '—'}`);
  return lines.join('\n');
}

function phaseTitle(phase: ControllerPhase): string {
  switch (phase) {
    case 'enhance':
      return 'Enhance';
    case 'plan':
      return 'Planning';
    case 'review':
      return 'Review';
    case 'adversarial':
      return 'Adversarial';
  }
}
