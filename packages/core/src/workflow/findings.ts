/**
 * Cumulative finding-ledger and acceptance-criteria gate helpers — exact parity
 * with the reference fail-closed helpers in controller.py:
 *   * `cumulative_unresolved_severe`        (~lines 1135-1153)
 *   * `blocking_acceptance_criteria`        (~lines 1163-1172)
 *   * `_describe_blocking_findings`         (~lines 1192-1222)
 *   * `_describe_blocking_acceptance_criteria` (~lines 1175-1189)
 *
 * Both directions FAIL CLOSED: a malformed (non-object) ledger entry, and a
 * severe finding whose status is not an explicitly-released status, count as
 * blocking. An acceptance criterion blocks unless its status is exactly
 * `satisfied`.
 */

import {
  NON_BLOCKING_TRIAGE_STATUSES,
  NON_SEVERE_SEVERITIES,
  SATISFIED_ACCEPTANCE_STATUS,
  type CumulativeAcceptanceCriterion,
  type CumulativeFinding,
  type RunState
} from '../types';
import { MALFORMED_ENTRY_MARKER } from '../runState';

/**
 * A normalized entry that the parser flagged as a non-object source element. The
 * marker lives on the entry's `raw` bag when present (findings carry `raw`;
 * malformed acceptance criteria are constructed with a `raw` bag too).
 */
function isMalformed(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const raw = (entry as { raw?: unknown }).raw;
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as Record<string, unknown>)[MALFORMED_ENTRY_MARKER] === true
  );
}

/**
 * A finding is "severe" iff its severity is NOT one of the non-severe buckets
 * (controller.py `NON_SEVERE_SEVERITIES`). A missing/unknown severity is severe
 * (fail closed).
 */
export function isSevereCumulativeFinding(finding: CumulativeFinding): boolean {
  const severity = finding.severity;
  return severity === undefined || !NON_SEVERE_SEVERITIES.includes(severity);
}

/**
 * A finding is "released" (no longer blocking) iff its status is one of the
 * non-blocking triage statuses (which includes `resolved`). A missing/unknown
 * status is NOT released (fail closed).
 */
export function isFindingReleased(finding: CumulativeFinding): boolean {
  const status = finding.status;
  return (
    finding.assessmentState !== 'needs_reassessment' &&
    status !== undefined &&
    NON_BLOCKING_TRIAGE_STATUSES.includes(status)
  );
}

/** Convenience: whether a cumulative finding is resolved/released from blocking. */
export function isFindingResolved(finding: CumulativeFinding): boolean {
  return isMalformed(finding) ? false : isFindingReleased(finding);
}

/**
 * Cumulative findings that remain unresolved AND severe — the blocking set
 * (controller.py `cumulative_unresolved_severe`). Fail closed in two directions:
 *   * a non-object entry has no readable status/severity, so it is treated as an
 *     unresolved severe finding rather than silently skipped; and
 *   * a severe finding blocks unless it carries an explicitly-released status.
 */
export function cumulativeUnresolvedSevere(state: RunState): CumulativeFinding[] {
  const severe: CumulativeFinding[] = [];
  for (const finding of state.cumulativeFindings) {
    if (isMalformed(finding)) {
      severe.push(finding);
      continue;
    }
    if (isSevereCumulativeFinding(finding) && !isFindingReleased(finding)) {
      severe.push(finding);
    }
  }
  return severe;
}

/**
 * Cumulative acceptance criteria that are not `satisfied` (controller.py
 * `blocking_acceptance_criteria`). A non-object entry, or a missing/unknown
 * status, blocks (fail closed).
 */
export function blockingAcceptanceCriteria(state: RunState): CumulativeAcceptanceCriterion[] {
  const blocking: CumulativeAcceptanceCriterion[] = [];
  for (const criterion of state.cumulativeAcceptanceCriteria) {
    if (isMalformed(criterion)) {
      blocking.push(criterion);
      continue;
    }
    if (
      criterion.status !== SATISFIED_ACCEPTANCE_STATUS ||
      criterion.assessmentState === 'needs_reassessment'
    ) {
      blocking.push(criterion);
    }
  }
  return blocking;
}

const DESCRIBE_LIMIT = 5;
const DESCRIPTION_SNIPPET = 80;

/**
 * Summarize blocking findings for the gate failure reason
 * (controller.py `_describe_blocking_findings`): `id [severity/category]` plus a
 * ≤80-char description snippet (truncated with a trailing ellipsis). Pure
 * reporting — the block/pass decision is unchanged.
 */
export function describeBlockingFindings(
  severe: readonly CumulativeFinding[],
  limit: number = DESCRIBE_LIMIT
): string {
  const parts: string[] = [];
  for (const finding of severe.slice(0, limit)) {
    if (isMalformed(finding)) {
      parts.push('(malformed)');
      continue;
    }
    const fid = finding.id ?? '(no id)';
    const severity = finding.severity ?? '(no severity)';
    let label = `${fid} [${severity}`;
    if (finding.category) {
      label += `/${finding.category}`;
    }
    label += ']';
    const description = finding.description;
    if (typeof description === 'string' && description.trim().length > 0) {
      let text = description.trim();
      if (text.length > DESCRIPTION_SNIPPET) {
        text = text.slice(0, DESCRIPTION_SNIPPET - 1).replace(/\s+$/u, '') + '…';
      }
      label += ` ${text}`;
    }
    parts.push(label);
  }
  if (severe.length > limit) {
    parts.push(`(+${severe.length - limit} more)`);
  }
  return parts.join('; ');
}

/**
 * Summarize blocking acceptance criteria for the gate failure reason
 * (controller.py `_describe_blocking_acceptance_criteria`): `id [status]`.
 */
export function describeBlockingAcceptanceCriteria(
  blocking: readonly CumulativeAcceptanceCriterion[],
  limit: number = DESCRIBE_LIMIT
): string {
  const parts: string[] = [];
  for (const criterion of blocking.slice(0, limit)) {
    if (isMalformed(criterion)) {
      // Mirror the reference sentinels: id "(malformed)", status "(unknown)".
      parts.push('(malformed) [(unknown)]');
      continue;
    }
    const cid = criterion.id ?? '(no id)';
    const status = criterion.status ?? '(no status)';
    parts.push(`${cid} [${status}]`);
  }
  if (blocking.length > limit) {
    parts.push(`(+${blocking.length - limit} more)`);
  }
  return parts.join('; ');
}
