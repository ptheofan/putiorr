import { state, el } from './state.js';
import { api, requestStateRefresh } from './api.js';
import { READY_PUTIO_STATUSES, PUTIO_PHASE_LABELS } from './constants.js';
import {
  clampPercent,
  formatBytes,
  formatSpeed,
  formatEta,
  statusLabel,
  setText,
  setAttribute,
  setDataValue,
  setHidden,
  placeChildAt,
} from './util.js';
import { renderTopology } from './topology.js';

export async function refreshDownloads() {
  state.downloads = await api('/api/downloads');
  renderDownloads();
  renderTopology();
}

export function applyDownloadsUpdate(message) {
  if (Array.isArray(message.downloads)) state.downloads = message.downloads;
  renderDownloads();
  renderTopology();
}

export function renderDownloads() {
  const viewportScroll = captureViewportScroll();
  rememberFileListScrollTops();
  pruneDownloadUiState();

  if (state.downloads.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No active downloads yet. Once an RR client adds a release, progress will appear here.';
    el.downloadsList.replaceChildren(empty);
    restoreViewportScroll(viewportScroll);
    return;
  }

  el.downloadsList.querySelector('.empty-state')?.remove();
  const existingRows = Array.from(el.downloadsList.querySelectorAll('.download-row[data-id]'));
  const existingById = new Map(existingRows.map((row) => [String(row.dataset.id), row]));
  const seen = new Set();

  state.downloads.forEach((download, index) => {
    const id = String(download.id);
    let row = existingById.get(id);
    if (!row) row = createDownloadRow(download);
    updateDownloadRow(row, download);
    seen.add(id);
    placeChildAt(el.downloadsList, row, index);
  });

  for (const row of existingRows) {
    if (row.dataset.id && !seen.has(String(row.dataset.id))) {
      row.remove();
    }
  }
  restoreViewportScroll(viewportScroll);
}

export function createDownloadRow(download) {
  const row = document.createElement('article');
  row.className = 'download-row';
  row.dataset.id = download.id;
  row.innerHTML = `
    <div class="download-summary">
      <div>
        <div class="download-title" data-role="download-title"></div>
        <div class="download-meta" data-role="download-location"></div>
        <button class="file-toggle" type="button" data-action="toggle-files">
          Files
          <span data-role="file-count"></span>
        </button>
      </div>
      <div>
        <div class="metric-label">Status</div>
        <strong data-role="download-status"></strong>
        <div class="download-meta" data-role="download-files"></div>
      </div>
      <div class="progress-group">
        ${progressLine('Put.io', 0, 'putio-bar', 'putio-progress')}
        ${progressLine('Local', 0, 'local-bar', 'local-progress', 'local')}
      </div>
      <div>
        <div class="download-actions">
          <div class="download-speed-metric">
            <div class="metric-label">Speed / ETA</div>
            <strong data-role="download-speed"></strong>
            <div class="download-meta" data-role="download-eta"></div>
          </div>
          <button class="button secondary compact-button start-download-button" type="button" data-action="start-download">
            <span aria-hidden="true">▶</span>
            <span data-role="start-label">Start</span>
          </button>
          <button class="icon-button danger bucket-delete-button" type="button" data-action="delete-bucket" aria-label="Delete bucket" title="Delete bucket">${trashIcon()}</button>
        </div>
      </div>
    </div>
    <div class="file-panel" data-role="file-panel" hidden>
      <div class="file-panel-head">
        <div class="file-panel-title">
          <strong>Files</strong>
          <span data-role="file-panel-summary"></span>
        </div>
        <div class="file-panel-actions">
          <label class="file-select-all">
            <input type="checkbox" data-action="select-all-files">
            <span>Select all</span>
          </label>
          <button class="button danger compact-button" type="button" data-action="delete-selected-files" disabled>Delete selected</button>
        </div>
      </div>
      <div class="file-list" data-role="file-list"></div>
    </div>
  `;
  row.querySelector('[data-action="toggle-files"]').addEventListener('click', () => {
    toggleFilePanel(row.dataset.id);
  });
  row.querySelector('[data-action="delete-bucket"]').addEventListener('click', () => {
    const download = findDownload(row.dataset.id);
    if (download) openBucketDelete(download);
  });
  row.querySelector('[data-action="start-download"]').addEventListener('click', () => {
    const download = findDownload(row.dataset.id);
    if (download) startDownload(download);
  });
  row.querySelector('[data-action="select-all-files"]').addEventListener('change', (event) => {
    const download = findDownload(row.dataset.id);
    if (download) setFileSelectionForDownload(download, event.target.checked);
  });
  row.querySelector('[data-action="delete-selected-files"]').addEventListener('click', () => {
    const download = findDownload(row.dataset.id);
    if (download) openSelectedFilesDelete(download);
  });
  const fileList = row.querySelector('[data-role="file-list"]');
  fileList.addEventListener('scroll', () => {
    state.fileListScrollTops.set(String(row.dataset.id), fileList.scrollTop);
  }, { passive: true });
  return row;
}

export function updateDownloadRow(row, download) {
  const putioProgress = clampPercent(download.putioProgress);
  const localProgress = clampPercent(download.localProgress);
  const files = download.files ?? {};
  const fileItems = Array.isArray(files.items) ? files.items : [];
  const completeFiles = Number(files.complete ?? 0);
  const totalFiles = Number(files.total ?? 0);
  const downloadedSize = Number(download.downloadedSize ?? 0);
  const totalSize = Number(download.totalSize ?? 0);
  const fileText = totalFiles > 0
    ? `${completeFiles}/${totalFiles} files`
    : 'Files pending';
  const sizeText = totalSize > 0
    ? `${formatBytes(downloadedSize)} / ${formatBytes(totalSize)}`
    : `${formatBytes(downloadedSize)} copied`;

  setDataValue(row, 'id', download.id);
  row.dataset.error = download.error ? 'true' : 'false';
  setText(row.querySelector('[data-role="download-title"]'), download.name);
  setText(
    row.querySelector('[data-role="download-location"]'),
    `${download.profileName} · ${download.downloadProfileName || 'Default'} · ${download.downloadAt}`,
  );
  setText(row.querySelector('[data-role="download-status"]'), downloadStatusText(download));
  setText(row.querySelector('[data-role="download-files"]'), download.error || `${fileText} · ${sizeText}`);
  setText(row.querySelector('[data-role="download-speed"]'), formatSpeed(download.speed));
  setText(row.querySelector('[data-role="download-eta"]'), formatEta(download.eta));
  setText(row.querySelector('[data-role="file-count"]'), totalFiles > 0 ? String(totalFiles) : '0');
  const startButton = row.querySelector('[data-action="start-download"]');
  const starting = state.startingDownloads.has(String(download.id));
  startButton.hidden = !canStartDownload(download);
  startButton.disabled = starting;
  startButton.title = starting ? 'Starting local download' : 'Start local download from put.io';
  setText(startButton.querySelector('[data-role="start-label"]'), starting ? 'Starting' : 'Start');
  setProgressValue(row, 'putio-bar', 'putio-progress', putioProgress);
  setProgressValue(row, 'local-bar', 'local-progress', localProgress);
  populateFilePanel(row, download, fileItems);
}

export async function startDownload(download) {
  const id = String(download.id);
  state.startingDownloads.add(id);
  renderDownloads();
  try {
    const result = await api(`/api/downloads/${id}/start`, {
      method: 'POST',
      body: '{}',
    });
    if (Array.isArray(result.downloads)) state.downloads = result.downloads;
    else await refreshDownloads();
  } catch (error) {
    const current = findDownload(id);
    if (current) current.error = error.message;
  } finally {
    state.startingDownloads.delete(id);
    renderDownloads();
    requestStateRefresh();
  }
}

export function toggleFilePanel(downloadId) {
  rememberFileListScrollTops();
  const key = String(downloadId);
  if (state.expandedDownloads.has(key)) {
    state.expandedDownloads.delete(key);
  } else {
    state.expandedDownloads.add(key);
  }
  renderDownloads();
}

export function populateFilePanel(row, download, fileItems) {
  const key = String(download.id);
  const expanded = state.expandedDownloads.has(key);
  const button = row.querySelector('[data-action="toggle-files"]');
  const panel = row.querySelector('[data-role="file-panel"]');
  const list = row.querySelector('[data-role="file-list"]');
  const summary = row.querySelector('[data-role="file-panel-summary"]');
  const selectAll = row.querySelector('[data-action="select-all-files"]');
  const deleteSelected = row.querySelector('[data-action="delete-selected-files"]');

  setAttribute(button, 'aria-expanded', String(expanded));
  button.classList.toggle('open', expanded);
  setHidden(panel, !expanded);

  const selectedIds = selectedFileIdsForDownload(download.id);
  const visibleIds = new Set(fileItems.map((file) => String(file.id)));
  const selectedVisibleCount = [...selectedIds].filter((id) => visibleIds.has(id)).length;
  selectAll.checked = fileItems.length > 0 && selectedVisibleCount === fileItems.length;
  selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < fileItems.length;
  selectAll.disabled = fileItems.length === 0;
  deleteSelected.disabled = selectedVisibleCount === 0;
  setText(
    deleteSelected,
    selectedVisibleCount > 0 ? `Delete selected (${selectedVisibleCount})` : 'Delete selected',
  );

  const completed = fileItems.filter((file) => file.status === 'complete').length;
  const downloading = fileItems.filter((file) => file.status === 'downloading').length;
  const failed = fileItems.filter((file) => file.status === 'failed').length;
  const pending = Math.max(0, fileItems.length - completed - downloading - failed);
  setText(
    summary,
    fileItems.length > 0
      ? `${completed} complete · ${downloading} active · ${pending} pending${failed > 0 ? ` · ${failed} failed` : ''}`
      : 'Waiting for put.io file list',
  );

  if (!expanded) return;

  if (fileItems.length === 0) {
    renderEmptyFileList(list);
    return;
  }

  list.querySelector('.file-empty')?.remove();
  const existingRows = Array.from(list.querySelectorAll('.file-row[data-id]'));
  const existingById = new Map(existingRows.map((fileRow) => [String(fileRow.dataset.id), fileRow]));
  const seen = new Set();

  fileItems.forEach((file, index) => {
    const id = String(file.id);
    let fileRow = existingById.get(id);
    if (!fileRow) fileRow = createFileRow(file);
    updateFileRow(fileRow, file, download);
    seen.add(id);
    placeChildAt(list, fileRow, index);
  });

  for (const fileRow of existingRows) {
    if (fileRow.dataset.id && !seen.has(String(fileRow.dataset.id))) {
      fileRow.remove();
    }
  }
}

export function renderEmptyFileList(list) {
  if (list.querySelector('.file-empty')) return;
  list.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'file-empty';
  empty.textContent = 'File details appear after put.io finishes preparing the transfer.';
  list.appendChild(empty);
}

export function createFileRow(file) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.id = file.id;
  row.innerHTML = `
    <label class="file-select">
      <input type="checkbox" data-action="select-file">
      <span class="sr-only">Select file</span>
    </label>
    <div class="file-main">
      <div class="file-name" data-role="file-name"></div>
      <div class="download-meta" data-role="file-size"></div>
    </div>
    <span class="file-status" data-role="file-status"></span>
    <div class="file-progress">
      <span class="bar local" data-role="file-bar"><span></span></span>
      <span data-role="file-progress"></span>
    </div>
    <button class="icon-button danger file-delete-button" type="button" data-action="delete-file" aria-label="Delete file" title="Delete file">${trashIcon()}</button>
  `;
  row.querySelector('[data-action="select-file"]').addEventListener('change', (event) => {
    const downloadId = row.closest('.download-row')?.dataset.id;
    if (downloadId) toggleFileSelection(downloadId, row.dataset.id, event.target.checked);
  });
  row.querySelector('[data-action="delete-file"]').addEventListener('click', () => {
    const download = findDownload(row.closest('.download-row')?.dataset.id);
    const currentFile = findDownloadFile(download, row.dataset.id);
    if (download && currentFile) openSingleFileDelete(download, currentFile);
  });
  return row;
}

export function updateFileRow(row, file, download) {
  const progress = clampPercent(file.progress);
  const status = file.status || 'pending';
  const speed = Number(file.speed ?? 0);
  const fileSizeText = `${formatBytes(file.downloadedSize)} / ${formatBytes(file.size)}`;
  const sizeText = file.error
    || (status === 'downloading' && speed > 0
      ? `${fileSizeText} · ${formatSpeed(speed)}`
      : fileSizeText);
  const statusBadge = row.querySelector('[data-role="file-status"]');

  setDataValue(row, 'id', file.id);
  const checkbox = row.querySelector('[data-action="select-file"]');
  checkbox.checked = selectedFileIdsForDownload(download.id).has(String(file.id));
  checkbox.setAttribute('aria-label', `Select ${file.relativePath || 'file'}`);
  setText(row.querySelector('[data-role="file-name"]'), file.relativePath || 'Unknown file');
  setText(row.querySelector('[data-role="file-size"]'), sizeText);
  setText(statusBadge, statusLabel(file.status));
  setDataValue(statusBadge, 'status', status);
  setProgressValue(row, 'file-bar', 'file-progress', progress);
}

export function findDownload(downloadId) {
  return state.downloads.find((download) => String(download.id) === String(downloadId));
}

export function downloadFileItems(download) {
  return Array.isArray(download?.files?.items) ? download.files.items : [];
}

export function findDownloadFile(download, fileId) {
  return downloadFileItems(download).find((file) => String(file.id) === String(fileId));
}

export function selectedFileIdsForDownload(downloadId) {
  return state.selectedFilesByDownload.get(String(downloadId)) ?? new Set();
}

export function editableSelectedFileIdsForDownload(downloadId) {
  const key = String(downloadId);
  let selected = state.selectedFilesByDownload.get(key);
  if (!selected) {
    selected = new Set();
    state.selectedFilesByDownload.set(key, selected);
  }
  return selected;
}

export function toggleFileSelection(downloadId, fileId, selected) {
  const key = String(downloadId);
  const selectedIds = editableSelectedFileIdsForDownload(key);
  if (selected) selectedIds.add(String(fileId));
  else selectedIds.delete(String(fileId));
  if (selectedIds.size === 0) state.selectedFilesByDownload.delete(key);
  renderDownloads();
}

export function setFileSelectionForDownload(download, selected) {
  const key = String(download.id);
  if (!selected) {
    state.selectedFilesByDownload.delete(key);
    renderDownloads();
    return;
  }
  state.selectedFilesByDownload.set(
    key,
    new Set(downloadFileItems(download).map((file) => String(file.id))),
  );
  renderDownloads();
}

export function selectedVisibleFiles(download) {
  const selectedIds = selectedFileIdsForDownload(download.id);
  return downloadFileItems(download).filter((file) => selectedIds.has(String(file.id)));
}

export function openBucketDelete(download) {
  const files = downloadFileItems(download);
  openDeleteConfirm({
    type: 'bucket',
    downloadId: String(download.id),
    fileIds: files.map((file) => Number(file.id)),
  });
}

export function openSingleFileDelete(download, file) {
  const files = downloadFileItems(download);
  if (files.length === 1) {
    openBucketDelete(download);
    return;
  }
  openDeleteConfirm({
    type: 'files',
    downloadId: String(download.id),
    fileIds: [Number(file.id)],
  });
}

export function openSelectedFilesDelete(download) {
  const files = downloadFileItems(download);
  const selected = selectedVisibleFiles(download);
  if (selected.length === 0) return;
  if (selected.length === files.length) {
    openBucketDelete(download);
    return;
  }
  openDeleteConfirm({
    type: 'files',
    downloadId: String(download.id),
    fileIds: selected.map((file) => Number(file.id)),
  });
}

export function openDeleteConfirm(pendingDelete) {
  const download = findDownload(pendingDelete.downloadId);
  if (!download) return;
  const count = pendingDelete.type === 'bucket'
    ? downloadFileItems(download).length
    : pendingDelete.fileIds.length;
  const fileWord = count === 1 ? 'file' : 'files';
  state.pendingDelete = pendingDelete;
  el.deleteFromPutio.checked = true;
  el.deleteLocalFiles.checked = false;
  setDeleteConfirmMessage('');

  if (pendingDelete.type === 'bucket') {
    setText(el.deleteConfirmTitle, 'Delete bucket');
    setText(
      el.deleteConfirmIntro,
      `This will delete "${download.name}" and all ${count} ${fileWord} from putiorr.`,
    );
    setText(el.deleteFromPutioLabel, 'Also delete this bucket from put.io');
    setText(el.deleteLocalFilesLabel, 'Also delete the downloaded files from disk');
  } else {
    setText(el.deleteConfirmTitle, `Delete ${count} ${fileWord}`);
    setText(
      el.deleteConfirmIntro,
      `This will delete ${count} selected ${fileWord} from "${download.name}" in putiorr.`,
    );
    setText(el.deleteFromPutioLabel, count === 1
      ? 'Also delete this file from put.io'
      : 'Also delete these files from put.io');
    setText(el.deleteLocalFilesLabel, count === 1
      ? 'Also delete the downloaded file from disk'
      : 'Also delete the downloaded files from disk');
  }

  updateDeleteConfirmButtonState();
  if (!el.deleteConfirmDialog.open) el.deleteConfirmDialog.open = true;
}

export function closeDeleteConfirm() {
  state.pendingDelete = undefined;
  setDeleteConfirmMessage('');
  if (el.deleteConfirmDialog.open) el.deleteConfirmDialog.open = false;
}

export function updateDeleteConfirmButtonState() {
  const anyChecked = el.deleteFromPutio.checked || el.deleteLocalFiles.checked;
  el.deleteConfirmButton.disabled = !anyChecked;
}

export function setDeleteConfirmMessage(message, tone = 'neutral') {
  el.deleteConfirmMessage.textContent = message;
  el.deleteConfirmMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

export async function confirmPendingDelete() {
  const pendingDelete = state.pendingDelete;
  if (!pendingDelete) return;

  el.deleteConfirmButton.disabled = true;
  setDeleteConfirmMessage('Deleting...', 'neutral');
  const deleteRemote = Boolean(el.deleteFromPutio.checked);
  const deleteLocal = Boolean(el.deleteLocalFiles.checked);

  try {
    const result = pendingDelete.type === 'bucket'
      ? await api(`/api/downloads/${pendingDelete.downloadId}/delete`, {
          method: 'POST',
          body: JSON.stringify({ deleteRemote, deleteLocal }),
        })
      : await api(`/api/downloads/${pendingDelete.downloadId}/files/delete`, {
          method: 'POST',
          body: JSON.stringify({
            fileIds: pendingDelete.fileIds,
            deleteRemote,
            deleteLocal,
          }),
        });

    if (result.bucketDeleted) {
      state.selectedFilesByDownload.delete(String(pendingDelete.downloadId));
      state.expandedDownloads.delete(String(pendingDelete.downloadId));
      state.fileListScrollTops.delete(String(pendingDelete.downloadId));
    } else {
      const selected = selectedFileIdsForDownload(pendingDelete.downloadId);
      for (const fileId of pendingDelete.fileIds) selected.delete(String(fileId));
      if (selected.size === 0) state.selectedFilesByDownload.delete(String(pendingDelete.downloadId));
    }

    closeDeleteConfirm();
    await refreshDownloads();
    requestStateRefresh();
  } catch (error) {
    setDeleteConfirmMessage(error.message, 'error');
  } finally {
    updateDeleteConfirmButtonState();
  }
}

export function progressLine(label, value, barRole, valueRole, className = '') {
  return `
    <div class="progress-line">
      <span>${label}</span>
      <span class="bar ${className}" data-role="${barRole}"><span></span></span>
      <span data-role="${valueRole}">${value}%</span>
    </div>
  `;
}

export function trashIcon() {
  return `
    <svg class="delete-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M7.2 4.2V3.4c0-.8.6-1.4 1.4-1.4h2.8c.8 0 1.4.6 1.4 1.4v.8M3.8 5h12.4M6 7.5l.5 8.2c.1.8.7 1.3 1.4 1.3h4.2c.8 0 1.4-.6 1.4-1.3l.5-8.2M8.7 8.8v5.4M11.3 8.8v5.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

export function setProgressValue(row, barRole, valueRole, value) {
  const nextValue = `${value}%`;
  const bar = row.querySelector(`[data-role="${barRole}"] > span`);
  if (bar.style.getPropertyValue('--value') !== nextValue) {
    bar.style.setProperty('--value', nextValue);
  }
  setText(row.querySelector(`[data-role="${valueRole}"]`), nextValue);
}

export function rememberFileListScrollTops() {
  for (const row of el.downloadsList.querySelectorAll('.download-row[data-id]')) {
    const panel = row.querySelector('[data-role="file-panel"]');
    const list = row.querySelector('[data-role="file-list"]');
    if (!panel || panel.hidden || !list) continue;
    state.fileListScrollTops.set(String(row.dataset.id), list.scrollTop);
  }
}

export function pruneDownloadUiState() {
  const ids = new Set(state.downloads.map((download) => String(download.id)));
  const downloadsById = new Map(state.downloads.map((download) => [String(download.id), download]));
  for (const id of state.expandedDownloads) {
    if (!ids.has(id)) state.expandedDownloads.delete(id);
  }
  for (const id of state.fileListScrollTops.keys()) {
    if (!ids.has(id)) state.fileListScrollTops.delete(id);
  }
  for (const [id, selectedFileIds] of state.selectedFilesByDownload.entries()) {
    const download = downloadsById.get(id);
    if (!download) {
      state.selectedFilesByDownload.delete(id);
      continue;
    }
    const visibleFileIds = new Set(downloadFileItems(download).map((file) => String(file.id)));
    for (const fileId of selectedFileIds) {
      if (!visibleFileIds.has(fileId)) selectedFileIds.delete(fileId);
    }
    if (selectedFileIds.size === 0) state.selectedFilesByDownload.delete(id);
  }
}

export function captureViewportScroll() {
  return {
    x: window.scrollX,
    y: window.scrollY,
  };
}

export function restoreViewportScroll({ x, y }) {
  const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo(x, Math.min(y, maxY));
}

export function canStartDownload(download) {
  return download.lifecycle === 'remote' && READY_PUTIO_STATUSES.has(download.putioStatus);
}

// While a transfer is still `remote`, the local downloader has not started yet, so the
// lifecycle word alone ("remote") reads as stalled. Surface the put.io phase instead —
// in particular COMPLETING (put.io finished the torrent and is copying it into storage),
// which reports percent_done=100 but its real progress in completion_percent.
export function downloadStatusText(download) {
  const combinedProgress = clampPercent(download.combinedProgress);
  if (download.lifecycle !== 'remote') {
    return `${download.lifecycle} · ${combinedProgress}%`;
  }
  const phase = PUTIO_PHASE_LABELS[download.putioStatus] ?? 'On Put.io';
  if (download.putioStatus === 'COMPLETING') {
    return `${phase} · ${clampPercent(download.putioCompletion)}%`;
  }
  return `${phase} · ${clampPercent(download.putioProgress)}%`;
}
