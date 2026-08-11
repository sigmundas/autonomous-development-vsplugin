import {
  parseClaudeRuntimeList,
  parseClaudeModelList,
  parseConfigValidation,
  parseEffectiveConfiguration,
  parsePresetList,
  parseProfileList,
  type ClaudeRuntimeList,
  type ClaudeModelList,
  type CodexProfileList,
  type ConfigValidationResult,
  type ControllerConfigResponse,
  type ControllerPhase,
  type ControllerReasoningEffort,
  type EffectiveConfiguration,
  type PresetList
} from '@semanticmatter/core';

import { ControllerError, type ControllerService } from './controllerService';

/**
 * Typed, contract-aware wrapper around {@link ControllerService} for the
 * `config-*` subcommands. Every method spawns the controller with a safe argv
 * array, parses the JSON payload through the {@link parseEffectiveConfiguration}
 * family of validators, and throws {@link ControllerError} on any transport,
 * parsing, or contract failure.
 *
 * Configuration commands are global and deliberately carry no repository
 * identity. Run-scoped calls continue to use ControllerService.execute().
 */
export class ConfigClient {
  constructor(private readonly service: ControllerService) {}

  isConfigured(): boolean {
    return this.service.isConfigured();
  }

  private unwrap<T>(sub: string, parsed: ControllerConfigResponse<T>): T {
    if (!parsed.ok) {
      throw new ControllerError(`Controller "${sub}" returned malformed JSON: ${parsed.error}`);
    }
    return parsed.value;
  }

  private async runJson(
    sub: import('@semanticmatter/core').ControllerSubcommand,
    options: import('@semanticmatter/core').ControllerOptions = {}
  ): Promise<unknown> {
    const { stdout } = await this.service.executeGlobal(sub, options);
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      throw new ControllerError(`Controller "${sub}" produced no output.`);
    }
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new ControllerError(
        `Controller "${sub}" returned non-JSON output: ${(err as Error).message}`
      );
    }
  }

  async show(): Promise<EffectiveConfiguration> {
    const raw = await this.runJson('config-show');
    return this.unwrap('config-show', parseEffectiveConfiguration(raw));
  }

  async validate(): Promise<ConfigValidationResult> {
    try {
      const raw = await this.runJson('config-validate');
      return this.unwrap('config-validate', parseConfigValidation(raw));
    } catch (err) {
      // config-validate exits non-zero when the config is invalid but STILL
      // prints the JSON verdict on stdout. Recover a well-formed failure payload
      // from the stderr message when possible; otherwise re-throw the transport
      // error so callers can surface it.
      if (err instanceof ControllerError && err.stderr) {
        const stderr = err.stderr;
        // Try to find a JSON object inside stderr (some controller error paths
        // print structured payloads there). If none, surface the transport error.
        const jsonStart = stderr.indexOf('{');
        if (jsonStart >= 0) {
          try {
            const parsed = JSON.parse(stderr.slice(jsonStart));
            const wrapped = parseConfigValidation(parsed);
            if (wrapped.ok) {
              return wrapped.value;
            }
          } catch {
            /* fall through */
          }
        }
      }
      throw err;
    }
  }

  async listProfiles(): Promise<CodexProfileList> {
    const raw = await this.runJson('config-list-profiles');
    return this.unwrap('config-list-profiles', parseProfileList(raw));
  }

  async listPresets(): Promise<PresetList> {
    const raw = await this.runJson('config-list-presets');
    return this.unwrap('config-list-presets', parsePresetList(raw));
  }

  async listClaudeRuntimes(): Promise<ClaudeRuntimeList> {
    const raw = await this.runJson('config-list-claude-runtimes');
    return this.unwrap('config-list-claude-runtimes', parseClaudeRuntimeList(raw));
  }

  async listClaudeModels(): Promise<ClaudeModelList> {
    const raw = await this.runJson('config-list-claude-models');
    return this.unwrap('config-list-claude-models', parseClaudeModelList(raw));
  }

  async setActivePreset(name: string): Promise<void> {
    if (name.length === 0) {
      throw new ControllerError('setActivePreset requires a non-empty preset name.');
    }
    await this.service.executeGlobal('config-set-active-preset', { name });
  }

  async setClaudeRuntime(name: string): Promise<void> {
    if (name.length === 0) {
      throw new ControllerError('setClaudeRuntime requires a non-empty runtime name.');
    }
    await this.service.executeGlobal('config-set-claude-runtime', { name });
  }

  async setClaudeModel(name?: string): Promise<void> {
    await this.service.executeGlobal('config-set-claude-model', {
      ...(name !== undefined ? { name } : {})
    });
  }

  async setReviewContextReuse(enabled: boolean): Promise<void> {
    await this.service.executeGlobal('config-set-review-context-reuse', { enabled });
  }

  async setPhase(args: {
    preset: string;
    phase: ControllerPhase;
    profile?: string;
    model?: string;
    reasoningEffort?: ControllerReasoningEffort;
    reasoningSummary?: string;
    verbosity?: string;
  }): Promise<void> {
    await this.service.executeGlobal('config-set-phase', {
      configPreset: args.preset,
      phase: args.phase,
      ...(args.profile !== undefined ? { profile: args.profile } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
      ...(args.reasoningSummary !== undefined ? { reasoningSummary: args.reasoningSummary } : {}),
      ...(args.verbosity !== undefined ? { verbosity: args.verbosity } : {})
    });
  }
}
