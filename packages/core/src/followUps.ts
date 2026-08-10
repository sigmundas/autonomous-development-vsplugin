import type { FollowUpItem, FollowUpsArtifact } from './types';

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function item(value: unknown): FollowUpItem | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const id = text(raw['id']);
  const title = text(raw['title']);
  if (!id || !title) return undefined;
  return {
    id,
    title,
    ...(text(raw['source_run_id']) ? { sourceRunId: text(raw['source_run_id']) } : {}),
    ...(text(raw['source_phase']) ? { sourcePhase: text(raw['source_phase']) } : {}),
    ...(number(raw['source_round']) !== undefined
      ? { sourceRound: number(raw['source_round']) }
      : {}),
    ...(text(raw['original_finding_id'])
      ? { originalFindingId: text(raw['original_finding_id']) }
      : {}),
    ...(text(raw['severity']) ? { severity: text(raw['severity']) } : {}),
    ...(text(raw['category']) ? { category: text(raw['category']) } : {}),
    ...(text(raw['description']) ? { description: text(raw['description']) } : {}),
    ...(text(raw['why_deferred']) ? { whyDeferred: text(raw['why_deferred']) } : {}),
    relevantAcceptanceCriteria: strings(raw['relevant_acceptance_criteria']),
    relevantFiles: strings(raw['relevant_files']),
    ...(text(raw['suggested_future_scope'])
      ? { suggestedFutureScope: text(raw['suggested_future_scope']) }
      : {}),
    recommendedVerification: strings(raw['recommended_verification']),
    ...(typeof raw['human_input_eventually_required'] === 'boolean'
      ? { humanInputEventuallyRequired: raw['human_input_eventually_required'] }
      : {}),
    ...(text(raw['provenance']) ? { provenance: text(raw['provenance']) } : {})
  };
}

/** Tolerant parser for the controller-owned follow-ups.json artifact. */
export function parseFollowUpsText(textValue: string): FollowUpsArtifact {
  try {
    const raw = object(JSON.parse(textValue));
    if (!raw) return { followUps: [] };
    const entries = Array.isArray(raw['follow_ups']) ? raw['follow_ups'] : [];
    return {
      ...(text(raw['source_run_id']) ? { sourceRunId: text(raw['source_run_id']) } : {}),
      followUps: entries.map(item).filter((entry): entry is FollowUpItem => entry !== undefined)
    };
  } catch {
    return { followUps: [] };
  }
}
