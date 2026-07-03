import assert from 'node:assert/strict';
import test from 'node:test';
import {
  visibleDownloadIds,
  selectedVisibleDownloads,
  selectedVisibleCount,
  toggleDownloadSelectionState,
  setAllDownloadSelectionState,
  pruneDownloadSelectionState,
} from '../src/web/download-selection.js';

function selectionState(downloadIds = [1, 2, 3, 4]) {
  return {
    downloads: downloadIds.map((id) => ({ id, name: `Download ${id}` })),
    selectedDownloadIds: new Set(),
    lastSelectedDownloadId: undefined,
  };
}

test('download selection exposes visible ids and visible selected downloads', () => {
  const state = selectionState([10, 11, 12]);
  state.selectedDownloadIds = new Set(['10', '12', '99']);

  assert.deepEqual(visibleDownloadIds(state.downloads), ['10', '11', '12']);
  assert.deepEqual(
    selectedVisibleDownloads(state.downloads, state.selectedDownloadIds).map((download) => download.id),
    [10, 12],
  );
  assert.equal(selectedVisibleCount(state.downloads, state.selectedDownloadIds), 2);
});

test('download selection toggles one row and tracks the range anchor', () => {
  const state = selectionState();

  toggleDownloadSelectionState(state, 2, true);
  assert.deepEqual([...state.selectedDownloadIds], ['2']);
  assert.equal(state.lastSelectedDownloadId, '2');

  toggleDownloadSelectionState(state, 2, false);
  assert.deepEqual([...state.selectedDownloadIds], []);
  assert.equal(state.lastSelectedDownloadId, '2');
});

test('download selection shift-click selects and clears visible ranges', () => {
  const state = selectionState();

  toggleDownloadSelectionState(state, 1, true);
  toggleDownloadSelectionState(state, 4, true, { range: true });
  assert.deepEqual([...state.selectedDownloadIds], ['1', '2', '3', '4']);
  assert.equal(state.lastSelectedDownloadId, '4');

  toggleDownloadSelectionState(state, 2, false, { range: true });
  assert.deepEqual([...state.selectedDownloadIds], ['1']);
  assert.equal(state.lastSelectedDownloadId, '2');
});

test('download selection select-all and clear update anchor predictably', () => {
  const state = selectionState([7, 8, 9]);

  setAllDownloadSelectionState(state, true);
  assert.deepEqual([...state.selectedDownloadIds], ['7', '8', '9']);
  assert.equal(state.lastSelectedDownloadId, '9');

  setAllDownloadSelectionState(state, false);
  assert.deepEqual([...state.selectedDownloadIds], []);
  assert.equal(state.lastSelectedDownloadId, undefined);
});

test('download selection prunes stale selected ids and stale range anchors', () => {
  const state = selectionState([1, 2]);
  state.selectedDownloadIds = new Set(['1', '2', '3']);
  state.lastSelectedDownloadId = '3';

  pruneDownloadSelectionState(state);
  assert.deepEqual([...state.selectedDownloadIds], ['1', '2']);
  assert.equal(state.lastSelectedDownloadId, undefined);
});
