import * as vscode from 'vscode';
import { CONTROLLER_PHASES, type ControllerPhase } from '@semanticmatter/core';

import type { ConfigSnapshot, ConfigStore } from '../configStore';
import { friendlyProfileLabel, friendlyRuntimeLabel, reasoningEffortLabel } from '../configStore';

type ConfigNodeKind =
  | 'unavailable'
  | 'error'
  | 'preset'
  | 'claude'
  | 'workflow'
  | 'phase'
  | 'validation'
  | 'openConfig';

export interface ConfigTreeNode {
  readonly kind: ConfigNodeKind;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: vscode.ThemeIcon;
  readonly command?: vscode.Command;
  readonly warning?: boolean;
}

/**
 * A persistent tree view rendered under the Autonomous Development activity bar
 * container. It is visible immediately after workspace activation — before any
 * run has been initialized — so the user can review presets, phase profiles,
 * and the selected Claude runtime pre-run.
 */
export class ConfigTreeProvider implements vscode.TreeDataProvider<ConfigTreeNode> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly store: ConfigStore) {
    store.onDidChange(() => this.onDidChangeEmitter.fire());
  }

  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  getTreeItem(node: ConfigTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    if (node.description !== undefined) {
      item.description = node.description;
    }
    item.tooltip = node.tooltip ?? node.description ?? node.label;
    if (node.icon) {
      item.iconPath = node.icon;
    }
    if (node.command) {
      item.command = node.command;
    }
    item.contextValue = `autonomousDev.config.${node.kind}`;
    return item;
  }

  getChildren(): ConfigTreeNode[] {
    const snap = this.store.current;
    if (!snap.controllerAvailable) {
      return [
        {
          kind: 'unavailable',
          label: 'Controller not configured',
          description: 'Configuration editing is unavailable',
          icon: new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')),
          command: {
            command: 'autonomousDev.setupController',
            title: 'Set Up Controller'
          },
          warning: true
        }
      ];
    }
    if (snap.error && !snap.effective) {
      return [
        {
          kind: 'error',
          label: 'Configuration unavailable',
          description: snap.error,
          tooltip: snap.error,
          icon: new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')),
          command: {
            command: 'autonomousDev.configure',
            title: 'Configure Autonomous Development'
          },
          warning: true
        }
      ];
    }

    const nodes: ConfigTreeNode[] = [];
    const effective = snap.effective;
    const activePreset = effective?.activePreset ?? snap.presets?.activePreset;

    nodes.push({
      kind: 'preset',
      label: 'Active preset',
      description: activePreset ?? '— none —',
      tooltip: activePreset
        ? `Active autonomous-development preset: ${activePreset}`
        : 'No preset has been selected.',
      icon: new vscode.ThemeIcon('star-full'),
      command: {
        command: 'autonomousDev.selectPreset',
        title: 'Select Preset'
      }
    });

    const runtimeName = effective?.effective.claudeRuntime;
    const runtime = snap.runtimes?.claudeRuntimes.find((r) => r.name === runtimeName);
    const runtimeInvalid =
      runtime !== undefined && (!runtime.launcherExists || !runtime.launcherExecutable);
    nodes.push({
      kind: 'claude',
      label: 'Claude runtime (for new runs)',
      description: runtime ? friendlyRuntimeLabel(runtime) : (runtimeName ?? '— not selected —'),
      tooltip: runtime?.launcher
        ? `${friendlyRuntimeLabel(runtime)} · launcher: ${runtime.launcher}${runtimeInvalid ? ' (unavailable)' : ''}\n\nThis runtime applies to NEW runs. Existing runs use the runtime recorded in their config_snapshot; use "Resume in Claude" from a run's tree item or dashboard to continue it with its snapshotted runtime.`
        : 'No Claude runtime has been selected for new runs.',
      icon: runtimeInvalid
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon('rocket'),
      command: {
        command: 'autonomousDev.configureClaudeRuntime',
        title: 'Configure Claude Runtime'
      },
      ...(runtimeInvalid ? { warning: true } : {})
    });

    if (effective) {
      for (const phase of CONTROLLER_PHASES) {
        nodes.push(phaseNode(phase, snap));
      }

      const wf = effective.effective.workflow;
      nodes.push({
        kind: 'workflow',
        label: 'Workflow mode',
        description: wf.workflowMode ?? '—',
        tooltip: `Max review rounds: ${wf.maxReviewRounds ?? '—'} · timeout: ${wf.processTimeoutSeconds ?? '—'}s`,
        icon: new vscode.ThemeIcon('settings-gear'),
        command: {
          command: 'autonomousDev.configure',
          title: 'Configure Autonomous Development'
        }
      });
    }

    if (snap.validation) {
      const valid = snap.validation.valid;
      nodes.push({
        kind: 'validation',
        label: 'Validation',
        description: valid ? 'valid' : (snap.validation.error ?? 'invalid'),
        tooltip: snap.validation.error ?? 'Configuration is valid.',
        icon: valid
          ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')),
        command: {
          command: 'autonomousDev.validateConfiguration',
          title: 'Validate Configuration'
        },
        ...(valid ? {} : { warning: true })
      });
    }

    nodes.push({
      kind: 'openConfig',
      label: 'Open configuration editor',
      description: 'Change presets, phase profiles, and reasoning effort',
      icon: new vscode.ThemeIcon('edit'),
      command: {
        command: 'autonomousDev.configure',
        title: 'Configure Autonomous Development'
      }
    });

    return nodes;
  }
}

function phaseNode(phase: ControllerPhase, snap: ConfigSnapshot): ConfigTreeNode {
  const effective = snap.effective?.effective;
  const codex = effective?.codex ?? {};
  const conf = codex[phase];
  const profileId = conf?.profile;
  const profile = snap.profiles?.profiles.find((p) => p.id === profileId);
  const profileLabel = profile ? friendlyProfileLabel(profile) : (profileId ?? '—');
  const effort = conf?.reasoningEffort ? reasoningEffortLabel(conf.reasoningEffort) : '—';
  const missingProfile = profileId !== undefined && profile === undefined;
  const invalidProfile = profile !== undefined && profile.valid === false;
  const warning = missingProfile || invalidProfile;
  const command: vscode.Command = {
    command: commandForPhase(phase),
    title: `Configure ${phaseTitle(phase)}`
  };
  return {
    kind: 'phase',
    label: phaseTitle(phase),
    description: `${profileLabel} · ${effort}`,
    tooltip: buildPhaseTooltip(phase, profileId, profileLabel, effort, warning),
    icon: warning
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
      : phaseIcon(phase),
    command,
    ...(warning ? { warning: true } : {})
  };
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
      return 'Adversarial review';
  }
}

function phaseIcon(phase: ControllerPhase): vscode.ThemeIcon {
  switch (phase) {
    case 'enhance':
      return new vscode.ThemeIcon('sparkle');
    case 'plan':
      return new vscode.ThemeIcon('list-tree');
    case 'review':
      return new vscode.ThemeIcon('comment-discussion');
    case 'adversarial':
      return new vscode.ThemeIcon('shield');
  }
}

function commandForPhase(phase: ControllerPhase): string {
  switch (phase) {
    case 'plan':
      return 'autonomousDev.configurePlanningAgent';
    case 'review':
      return 'autonomousDev.configureReviewAgent';
    case 'adversarial':
      return 'autonomousDev.configureAdversarialReviewer';
    case 'enhance':
    default:
      return 'autonomousDev.configure';
  }
}

function buildPhaseTooltip(
  phase: ControllerPhase,
  profileId: string | undefined,
  profileLabel: string,
  effort: string,
  warning: boolean
): string {
  const parts = [`${phaseTitle(phase)} phase`];
  if (profileId) {
    parts.push(`Profile: ${profileLabel} (${profileId})`);
  } else {
    parts.push('Profile: — (controller will resolve the default model)');
  }
  parts.push(`Reasoning effort: ${effort}`);
  if (warning) {
    parts.push('Warning: the selected profile is missing or invalid.');
  }
  return parts.join('\n');
}
