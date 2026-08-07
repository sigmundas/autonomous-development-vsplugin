import assert from 'node:assert/strict';

import { friendlyProfileLabel, reasoningEffortLabel } from '../src/configStore';

describe('friendlyProfileLabel', () => {
  it('prefers the controller-provided label when present', () => {
    assert.equal(
      friendlyProfileLabel({
        id: 'azure-gpt5p6-sol',
        label: 'Azure · GPT-5.6 Sol',
        provider: 'azure',
        model: 'gpt-5.6-sol'
      }),
      'Azure · GPT-5.6 Sol'
    );
  });

  it('derives a provider · model label when no explicit label is present', () => {
    assert.equal(
      friendlyProfileLabel({ id: 'azure-gpt5p6-sol', provider: 'azure', model: 'gpt-5.6-sol' }),
      'Azure · gpt-5.6-sol'
    );
  });

  it('falls back to the id when neither label nor provider/model is present', () => {
    assert.equal(friendlyProfileLabel({ id: 'unlabeled' }), 'unlabeled');
  });
});

describe('reasoningEffortLabel', () => {
  it('maps controller effort ids to display labels', () => {
    assert.equal(reasoningEffortLabel('minimal'), 'Minimal');
    assert.equal(reasoningEffortLabel('low'), 'Low');
    assert.equal(reasoningEffortLabel('medium'), 'Medium');
    assert.equal(reasoningEffortLabel('high'), 'High');
    assert.equal(reasoningEffortLabel('xhigh'), 'XHigh');
  });

  it('returns the input verbatim for unknown values (forward compatible)', () => {
    assert.equal(reasoningEffortLabel('turbo'), 'turbo');
  });
});
