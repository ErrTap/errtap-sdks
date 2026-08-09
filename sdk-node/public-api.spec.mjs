import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sdk from './index.js';

test('does not export SDK internals', () => {
  assert.equal('configure' in sdk, false);
  assert.equal('__test' in sdk, false);
});
