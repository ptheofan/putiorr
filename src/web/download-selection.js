export function visibleDownloadIds(downloads) {
  return downloads.map((download) => String(download.id));
}

export function selectedVisibleDownloads(downloads, selectedIds) {
  return downloads.filter((download) => selectedIds.has(String(download.id)));
}

export function selectedVisibleCount(downloads, selectedIds) {
  return visibleDownloadIds(downloads).filter((id) => selectedIds.has(id)).length;
}

export function toggleDownloadSelectionState(selectionState, downloadId, selected, { range = false } = {}) {
  const id = String(downloadId);
  const visibleIds = visibleDownloadIds(selectionState.downloads);
  const start = visibleIds.indexOf(String(selectionState.lastSelectedDownloadId));
  const end = visibleIds.indexOf(id);

  if (range && start >= 0 && end >= 0) {
    const [from, to] = start < end ? [start, end] : [end, start];
    for (const rangeId of visibleIds.slice(from, to + 1)) {
      if (selected) selectionState.selectedDownloadIds.add(rangeId);
      else selectionState.selectedDownloadIds.delete(rangeId);
    }
  } else if (selected) {
    selectionState.selectedDownloadIds.add(id);
  } else {
    selectionState.selectedDownloadIds.delete(id);
  }

  selectionState.lastSelectedDownloadId = id;
}

export function setAllDownloadSelectionState(selectionState, selected) {
  if (!selected) {
    selectionState.selectedDownloadIds.clear();
    selectionState.lastSelectedDownloadId = undefined;
    return;
  }

  const visibleIds = visibleDownloadIds(selectionState.downloads);
  for (const id of visibleIds) selectionState.selectedDownloadIds.add(id);
  selectionState.lastSelectedDownloadId = visibleIds.at(-1);
}

export function pruneDownloadSelectionState(selectionState) {
  const ids = new Set(visibleDownloadIds(selectionState.downloads));
  for (const id of selectionState.selectedDownloadIds) {
    if (!ids.has(id)) selectionState.selectedDownloadIds.delete(id);
  }
  if (selectionState.lastSelectedDownloadId && !ids.has(String(selectionState.lastSelectedDownloadId))) {
    selectionState.lastSelectedDownloadId = undefined;
  }
}
