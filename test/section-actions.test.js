import assert from 'node:assert/strict';
import test from 'node:test';

import { splitSectionActions } from '../src/web/section-action-split.js';

test('section actions keep two visible and overflow the rest', () => {
  const actions = ['one', 'two', 'three', 'four'];

  assert.deepEqual(splitSectionActions(actions), {
    visible: ['one', 'two'],
    overflow: ['three', 'four'],
  });
});
