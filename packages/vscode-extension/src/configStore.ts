import * as vscode from 'vscode';
import type {
  ClaudeRuntime,
  ClaudeRuntimeList,
  CodexProfile,
  CodexProfileList,
  ConfigValidationResult,
  EffectiveConfiguration,
  PresetList
} from '@semanticmatter/core';

import { ConfigClient } from './controller/configClient';
import { ControllerError } from './controller/controllerService';
import type { OutputLog } from './output';

export interface ConfigSnapshot {
  readonly effective?: EffectiveConfiguration;
  readonly presets?: PresetList;
  readonly profiles?: CodexProfileList;
  readonly runtimes?: ClaudeRuntimeList;
  readonly validation?: ConfigValidationResult;
  readonly loadedAt?: string;
  readonly error?: string;
  readonly controllerAvailable: boolean;
}

/**
 * In-memory cache of controller `config-*` responses. The webview and the
 * activity-bar Configuration tree both render from this snapshot, and both
 * refresh through {@link ConfigStore.refresh} after every mutation so the UI
 * never runs ahead of what the controller has actually persisted.
 */
export class ConfigStore implements vscode.Disposable {
  private snapshot: ConfigSnapshot = { controllerAvailable: false };
  private readonly onDidChangeEmitter = new vscode.EventEmitter<ConfigSnapshot>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private refreshInFlight?: Promise<ConfigSnapshot>;

  constructor(
    private readonly client: ConfigClient,
    private readonly log: OutputLog
  ) {}

  get current(): ConfigSnapshot {
    return this.snapshot;
  }

  private emit(next: ConfigSnapshot): void {
    this.snapshot = next;
    this.onDidChangeEmitter.fire(next);
  }

  /**
   * Fetch every config surface in parallel and update the cached snapshot.
   * A single in-flight refresh is coalesced so concurrent tree/webview
   * activation does not spawn duplicate controller processes.
   */
  async refresh(): Promise<ConfigSnapshot> {
    if (!this.client.isConfigured()) {
      const next: ConfigSnapshot = {
        controllerAvailable: false,
        loadedAt: new Date().toISOString()
      };
      this.emit(next);
      return next;
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    const promise = this.doRefresh();
    this.refreshInFlight = promise;
    try {
      return await promise;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async doRefresh(): Promise<ConfigSnapshot> {
    const partial: {
      controllerAvailable: true;
      loadedAt: string;
      effective?: EffectiveConfiguration;
      presets?: PresetList;
      profiles?: CodexProfileList;
      runtimes?: ClaudeRuntimeList;
      validation?: ConfigValidationResult;
      error?: string;
    } = {
      controllerAvailable: true,
      loadedAt: new Date().toISOString()
    };
    const errors: string[] = [];

    const [showRes, presetsRes, profilesRes, runtimesRes, validationRes] = await Promise.allSettled(
      [
        this.client.show(),
        this.client.listPresets(),
        this.client.listProfiles(),
        this.client.listClaudeRuntimes(),
        this.client.validate()
      ]
    );

    const record = <T>(
      res: PromiseSettledResult<T>,
      label: string,
      apply: (value: T) => void
    ): void => {
      if (res.status === 'fulfilled') {
        apply(res.value);
      } else {
        const message =
          res.reason instanceof ControllerError
            ? res.reason.message
            : res.reason instanceof Error
              ? res.reason.message
              : String(res.reason);
        this.log.warn(`config refresh: ${label} failed: ${message}`);
        errors.push(`${label}: ${message}`);
      }
    };

    record(showRes, 'config-show', (value) => (partial.effective = value));
    record(presetsRes, 'config-list-presets', (value) => (partial.presets = value));
    record(profilesRes, 'config-list-profiles', (value) => (partial.profiles = value));
    record(runtimesRes, 'config-list-claude-runtimes', (value) => (partial.runtimes = value));
    record(validationRes, 'config-validate', (value) => (partial.validation = value));

    if (errors.length > 0 && !partial.effective) {
      partial.error = errors[0];
    }
    this.emit(partial);
    return partial;
  }

  /** Force a state where the controller is not configured (used during teardown/config change). */
  reset(): void {
    this.emit({ controllerAvailable: false });
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

/** Convenience: derive a friendly profile label from controller metadata. */
export function friendlyProfileLabel(
  profile: Pick<CodexProfile, 'label' | 'provider' | 'model' | 'id'>
): string {
  if (profile.label && profile.label.trim().length > 0) {
    return profile.label.trim();
  }
  const parts: string[] = [];
  if (profile.provider) parts.push(titleCase(profile.provider));
  if (profile.model) parts.push(profile.model);
  if (parts.length > 0) {
    return parts.join(' · ');
  }
  return profile.id;
}

/** Convenience: derive a friendly runtime label. */
export function friendlyRuntimeLabel(runtime: Pick<ClaudeRuntime, 'displayName' | 'name'>): string {
  return runtime.displayName && runtime.displayName.trim().length > 0
    ? runtime.displayName.trim()
    : runtime.name;
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  if (/^[A-Z][a-z]/.test(trimmed)) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Reasoning effort label shown in dropdowns. */
export function reasoningEffortLabel(effort: string): string {
  switch (effort) {
    case 'minimal':
      return 'Minimal';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'XHigh';
    default:
      return effort;
  }
}
