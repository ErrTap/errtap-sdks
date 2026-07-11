import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from './core.js';

describe('sdk core helpers', () => {
  it('mergeContext deep-merges nested objects', () => {
    const merged = __test.mergeContext(
      { user: { id: '1', plan: 'free' }, extra: 'a' },
      { user: { email: 'a@b.c' }, tags: { x: 1 } },
    );
    assert.deepEqual(merged.user, { id: '1', plan: 'free', email: 'a@b.c' });
    assert.equal(merged.extra, 'a');
    assert.deepEqual(merged.tags, { x: 1 });
  });

  it('mergeTags combines sources left-to-right', () => {
    assert.deepEqual(__test.mergeTags({ a: '1' }, { b: '2' }, { a: '3' }), { a: '3', b: '2' });
  });
});
