import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseRunStateText } from '../src/runState';

// resources/ lives at the repo root; compiled tests run from packages/core/out/test.
const REPO_ROOT = resolve(__dirname, '../../../..');

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  uniqueItems?: boolean;
  items?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
}

const schemaPath = (name: string) => resolve(REPO_ROOT, 'resources/schemas', name);
const readSchema = (name: string) =>
  JSON.parse(readFileSync(schemaPath(name), 'utf8')) as JsonSchema;
const lock = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'resources/reference-lock.json'), 'utf8')
) as Record<string, unknown>;

/**
 * A deliberately small JSON-Schema validator covering only the constructs the
 * mirrored controller schemas actually use (type, enum, const, properties,
 * required, additionalProperties, items, pattern, minimum/maximum, minLength,
 * uniqueItems, and union `type` arrays). It exists so the bundled fixtures can be
 * proven to be realistic controller output without taking on a runtime JSON
 * Schema dependency. It is intentionally NOT a general-purpose validator.
 */
function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  const typeOk = (t: string, v: unknown): boolean => {
    switch (t) {
      case 'object':
        return typeof v === 'object' && v !== null && !Array.isArray(v);
      case 'array':
        return Array.isArray(v);
      case 'string':
        return typeof v === 'string';
      case 'number':
        return typeof v === 'number';
      case 'integer':
        return typeof v === 'number' && Number.isInteger(v);
      case 'boolean':
        return typeof v === 'boolean';
      case 'null':
        return v === null;
      default:
        return false;
    }
  };

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t: string) => typeOk(t, value))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${typeName(value)}`);
      return errors; // further checks assume the type matched
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${value}" does not match /${schema.pattern}/`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${path}: items are not unique`);
    }
    const itemSchema = schema.items;
    if (itemSchema) {
      value.forEach((item, i) => errors.push(...validate(itemSchema, item, `${path}[${i}]`)));
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validate(sub, obj[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
  return errors;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

describe('schema contract: mirrored controller schemas (REFERENCE §8)', () => {
  it('pins the review verdict enum to pass|changes_required|blocked across all review schemas', () => {
    for (const name of [
      'review.schema.json',
      'review-delta.schema.json',
      'adversarial-review.schema.json'
    ]) {
      assert.deepEqual(
        readSchema(name).properties?.verdict?.enum,
        ['pass', 'changes_required', 'blocked'],
        `${name} verdict enum`
      );
    }
  });

  it('pins the finding severity and category enums and the F-id pattern', () => {
    const finding = readSchema('review.schema.json').properties?.findings?.items;
    assert.deepEqual(finding?.properties?.severity?.enum, ['critical', 'high', 'medium', 'low']);
    assert.deepEqual(finding?.properties?.category?.enum, [
      'correctness',
      'security',
      'reliability',
      'performance',
      'maintainability',
      'testing',
      'compatibility',
      'documentation'
    ]);
    assert.equal(finding?.properties?.id?.pattern, '^F-[0-9]+$');
  });

  it('pins the acceptance-criterion status enum (only "satisfied" is non-blocking, §6)', () => {
    const ac = readSchema('review.schema.json').properties?.acceptance_criteria_assessment?.items;
    assert.deepEqual(ac?.properties?.status?.enum, [
      'satisfied',
      'partially_satisfied',
      'not_satisfied',
      'not_verifiable'
    ]);
  });

  it('keeps codex artifact schemas closed (additionalProperties:false)', () => {
    for (const name of [
      'review.schema.json',
      'review-delta.schema.json',
      'adversarial-review.schema.json'
    ]) {
      assert.equal(readSchema(name).additionalProperties, false, `${name} should be closed`);
    }
  });

  it('pins the triage disposition status enum and required fingerprint (§3.1, §9)', () => {
    const item = readSchema('triage.schema.json').items;
    assert.deepEqual(item?.required, ['fingerprint', 'status']);
    assert.equal(item?.properties?.fingerprint?.minLength, 1);
    assert.deepEqual(item?.properties?.status?.enum, [
      'accepted',
      'resolved',
      'rejected',
      'rejected_with_evidence',
      'already_resolved',
      'out_of_scope_but_recorded',
      'requires_human_decision',
      'open'
    ]);
    assert.equal(item?.properties?.finding_id?.pattern, '^F-[0-9]+$');
  });

  it('delta review requires unique resolved-finding ids (fail-closed merge, §6.1)', () => {
    const resolved = readSchema('review-delta.schema.json').properties?.resolved_findings;
    assert.equal(resolved?.uniqueItems, true);
    assert.equal(resolved?.items?.pattern, '^F-[0-9]+$');
  });

  it('mirrors the four authoritative completion dispositions', () => {
    const finding = readSchema('completion-disposition.schema.json').properties?.findings?.items;
    assert.deepEqual(finding?.properties?.disposition?.enum, [
      'MUST_FIX_NOW',
      'FIX_LATER',
      'ACCEPTED_WITH_EVIDENCE',
      'HUMAN_DECISION_REQUIRED'
    ]);
  });
});

describe('schema contract: realistic fixtures validate against the mirror', () => {
  it('a full round-1 review validates against review.schema.json', () => {
    const fixture = {
      verdict: 'changes_required',
      summary: 'One blocking correctness issue and an unverified criterion.',
      findings: [
        {
          id: 'F-1',
          severity: 'high',
          category: 'correctness',
          file: 'packages/core/src/workflow/gates.ts',
          line_start: 42,
          description: 'Gate accepts a pass verdict alongside an open severe finding.',
          evidence: 'evaluate() returns complete despite F-1 open.',
          recommended_fix: 'Reject pass when severe findings remain.'
        }
      ],
      verification_gaps: ['no test covers the pass-inconsistency branch'],
      acceptance_criteria_assessment: [
        { id: 'AC-1', status: 'satisfied', evidence: 'covered by gates.spec.ts' },
        { id: 'AC-2', status: 'not_satisfied', evidence: 'no coverage' }
      ],
      confidence: 0.8
    };
    assert.deepEqual(validate(readSchema('review.schema.json'), fixture), []);
  });

  it('a delta round-2 review validates against review-delta.schema.json', () => {
    const fixture = {
      verdict: 'pass',
      summary: 'F-1 resolved; no new findings.',
      resolved_findings: ['F-1'],
      new_findings: [],
      regressions: [],
      affected_acceptance_criteria: [{ id: 'AC-2', status: 'satisfied', evidence: 'now covered' }],
      confidence: 0.9
    };
    assert.deepEqual(validate(readSchema('review-delta.schema.json'), fixture), []);
  });

  it('a triage ledger validates against triage.schema.json', () => {
    const fixture = [
      {
        fingerprint: 'gates.ts:evaluate:pass-inconsistency',
        status: 'resolved',
        finding_id: 'F-1',
        resolution: 'fixed in gates.ts',
        evidence: 'gates.spec.ts now asserts the rejection'
      },
      {
        fingerprint: 'reviews.ts:delta:noise',
        status: 'rejected_with_evidence',
        reason: 'cosmetic'
      }
    ];
    assert.deepEqual(validate(readSchema('triage.schema.json'), fixture), []);
  });

  it('an adversarial review validates against adversarial-review.schema.json', () => {
    const fixture = {
      verdict: 'pass',
      summary: 'No new threat vectors introduced.',
      threats: [
        {
          severity: 'low',
          area: 'privacy',
          scenario: 'Webview receives only a serialized view model.',
          evidence: 'renderModel.ts maps to DashboardView; no handles cross the boundary.',
          mitigation: 'Keep the serialization boundary.'
        }
      ],
      failure_scenarios: ['none identified'],
      required_actions: [],
      confidence: 0.85
    };
    assert.deepEqual(validate(readSchema('adversarial-review.schema.json'), fixture), []);
  });

  it('the validator actually rejects a malformed fixture (guards against a no-op validator)', () => {
    const bad = {
      verdict: 'changes_requested', // wrong enum value (must be changes_required)
      summary: 'x',
      findings: [{ id: 'bad-id', severity: 'sev', category: 'c' }],
      verification_gaps: [],
      acceptance_criteria_assessment: [],
      confidence: 2
    };
    const errors = validate(readSchema('review.schema.json'), bad);
    assert.ok(
      errors.some((e) => e.includes('verdict')),
      'should reject the verdict enum'
    );
    assert.ok(
      errors.some((e) => e.includes('confidence')),
      'should reject confidence > 1'
    );
    assert.ok(
      errors.some((e) => e.includes('id')),
      'should reject the bad finding id'
    );
  });
});

describe('reference-lock pins the supported state-schema versions to the parser (§3)', () => {
  it('records schema_version 2 and supported {1,2}', () => {
    assert.equal(lock['stateSchemaVersion'], 2);
    assert.deepEqual(lock['supportedStateSchemaVersions'], [1, 2]);
  });

  it('a recorded supported version parses without an unsupported-version diagnostic', () => {
    for (const version of lock['supportedStateSchemaVersions'] as number[]) {
      const { diagnostics } = parseRunStateText(
        JSON.stringify({ schema_version: version, run_id: 'r1', status: 'active' })
      );
      assert.ok(
        !diagnostics.some((d) => /unsupported schema_version/i.test(d.message)),
        `version ${version} should be supported`
      );
    }
  });

  it('a version beyond the lock is diagnosed as unsupported (no v3 upstream)', () => {
    const beyond = Math.max(...(lock['supportedStateSchemaVersions'] as number[])) + 1;
    const { diagnostics } = parseRunStateText(
      JSON.stringify({ schema_version: beyond, run_id: 'r1', status: 'active' })
    );
    assert.ok(
      diagnostics.some((d) => /unsupported schema_version/i.test(d.message)),
      `version ${beyond} should be unsupported`
    );
  });
});
