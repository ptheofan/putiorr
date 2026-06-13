const state = {
  settings: undefined,
  profiles: [],
  downloads: [],
};

const el = {
  connectionState: document.querySelector('#connectionState'),
  connectionBadge: document.querySelector('#connectionBadge'),
  settingsForm: document.querySelector('#settingsForm'),
  putioToken: document.querySelector('#putioToken'),
  settingsMessage: document.querySelector('#settingsMessage'),
  oauthStartButton: document.querySelector('#oauthStartButton'),
  oauthPanel: document.querySelector('#oauthPanel'),
  oauthCode: document.querySelector('#oauthCode'),
  oauthLink: document.querySelector('#oauthLink'),
  oauthPollButton: document.querySelector('#oauthPollButton'),
  testConnectionButton: document.querySelector('#testConnectionButton'),
  addProfileButton: document.querySelector('#addProfileButton'),
  profilesBody: document.querySelector('#profilesBody'),
  profileRowTemplate: document.querySelector('#profileRowTemplate'),
  downloadsList: document.querySelector('#downloadsList'),
  refreshButton: document.querySelector('#refreshButton'),
  pollButton: document.querySelector('#pollButton'),
};

const oauth = {
  code: '',
  timer: undefined,
};

const updates = {
  socket: undefined,
  reconnectTimer: undefined,
  reconnectDelayMs: 1_000,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function setMessage(message, tone = 'neutral') {
  el.settingsMessage.textContent = message;
  el.settingsMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

function stopOAuthPolling() {
  if (oauth.timer) {
    clearInterval(oauth.timer);
    oauth.timer = undefined;
  }
}

function connectUpdates() {
  if (updates.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(updates.socket.readyState)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
  updates.socket = socket;

  socket.addEventListener('open', () => {
    updates.reconnectDelayMs = 1_000;
    requestStateRefresh();
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'state') {
      applyServerState(message);
    }
  });

  socket.addEventListener('close', () => {
    if (updates.socket !== socket) return;
    updates.socket = undefined;
    scheduleUpdateReconnect();
  });
}

function scheduleUpdateReconnect() {
  if (updates.reconnectTimer) return;
  updates.reconnectTimer = setTimeout(() => {
    updates.reconnectTimer = undefined;
    connectUpdates();
  }, updates.reconnectDelayMs);
  updates.reconnectDelayMs = Math.min(15_000, updates.reconnectDelayMs * 2);
}

function requestStateRefresh() {
  if (updates.socket?.readyState === WebSocket.OPEN) {
    updates.socket.send(JSON.stringify({ type: 'refresh' }));
    return true;
  }
  return false;
}

async function loadAll() {
  const [settings, profiles, downloads] = await Promise.all([
    api('/api/settings'),
    api('/api/profiles'),
    api('/api/downloads'),
  ]);
  state.settings = settings;
  state.profiles = profiles;
  state.downloads = downloads;
  render();
}

function applyServerState(message) {
  if (message.settings) state.settings = message.settings;
  if (Array.isArray(message.downloads)) state.downloads = message.downloads;
  if (Array.isArray(message.profiles)) reconcileProfiles(message.profiles);
  renderConnection();
  renderDownloads();
}

function render() {
  renderConnection();
  renderProfiles();
  renderDownloads();
}

function renderConnection() {
  const connected = Boolean(state.settings?.tokenConfigured);
  el.connectionState.textContent = connected
    ? 'A put.io token is configured. You can test or rotate it here.'
    : 'No put.io token is configured. Add one before RPC clients can add downloads.';
  el.connectionBadge.textContent = connected ? 'Connected' : 'Needs token';
  el.connectionBadge.className = `status ${connected ? 'ok' : 'warn'}`;
  if (connected) {
    stopOAuthPolling();
    el.oauthPanel.hidden = true;
  }
}

function renderProfiles() {
  el.profilesBody.replaceChildren();
  for (const profile of state.profiles) {
    el.profilesBody.appendChild(createProfileRow(profile));
  }
}

function reconcileProfiles(profiles) {
  state.profiles = profiles;

  const existingRows = Array.from(el.profilesBody.querySelectorAll('tr[data-id]'));
  const existingById = new Map(existingRows.map((row) => [String(row.dataset.id), row]));
  const seen = new Set();

  for (const profile of profiles) {
    const id = String(profile.id);
    let row = existingById.get(id);
    if (!row) {
      row = createProfileRow(profile);
    } else if (!isProfileRowDrafting(row)) {
      populateProfileRow(row, profile);
    }
    seen.add(id);
    el.profilesBody.appendChild(row);
  }

  for (const row of existingRows) {
    if (row.dataset.id && !seen.has(String(row.dataset.id))) {
      row.remove();
    }
  }
}

function createProfileRow(profile) {
  const row = el.profileRowTemplate.content.firstElementChild.cloneNode(true);
  populateProfileRow(row, profile);
  attachProfileDirtyTracking(row);

  row.querySelector('[data-action="save"]').addEventListener('click', () => saveProfile(row));
  row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteProfile(row));
  return row;
}

function populateProfileRow(row, profile) {
  row.dataset.id = profile.id || '';
  setInput(row, 'name', profile.name ?? '');
  setInput(row, 'type', profile.type ?? 'custom');
  setInput(row, 'putio_folder_name', profile.putio_folder_name ?? '');
  setInput(row, 'downloadAt', profile.downloadAt ?? profile.download_at ?? '');
  setInput(row, 'rpc_path', profile.rpc_path ?? '');
  row.querySelector('[data-field="enabled"]').checked = profile.enabled !== false;
  setProfileBaseline(row);
}

function setInput(row, field, value) {
  row.querySelector(`[data-field="${field}"]`).value = value;
}

function getProfilePayload(row) {
  return {
    name: row.querySelector('[data-field="name"]').value.trim(),
    type: row.querySelector('[data-field="type"]').value,
    slug: slugify(row.querySelector('[data-field="name"]').value),
    putio_folder_name: row.querySelector('[data-field="putio_folder_name"]').value.trim(),
    downloadAt: row.querySelector('[data-field="downloadAt"]').value.trim(),
    rpc_path: row.querySelector('[data-field="rpc_path"]').value.trim(),
    enabled: row.querySelector('[data-field="enabled"]').checked,
  };
}

function attachProfileDirtyTracking(row) {
  for (const field of row.querySelectorAll('[data-field]')) {
    field.addEventListener('input', () => updateProfileDirtyState(row));
    field.addEventListener('change', () => updateProfileDirtyState(row));
  }
}

function setProfileBaseline(row) {
  row.dataset.profileBaseline = row.dataset.id ? JSON.stringify(getProfilePayload(row)) : '';
  updateProfileDirtyState(row);
}

function updateProfileDirtyState(row) {
  const hasUnsavedChanges = !row.dataset.id
    || row.dataset.profileBaseline !== JSON.stringify(getProfilePayload(row));
  const saveButton = row.querySelector('[data-action="save"]');

  row.classList.toggle('dirty', hasUnsavedChanges);
  saveButton.classList.toggle('dirty', hasUnsavedChanges);
  saveButton.title = hasUnsavedChanges
    ? 'Save profile (unsaved changes)'
    : 'Save profile';
  saveButton.setAttribute(
    'aria-label',
    hasUnsavedChanges ? 'Save profile with unsaved changes' : 'Save profile',
  );
}

function isProfileRowDrafting(row) {
  return row.classList.contains('dirty') || row.contains(document.activeElement);
}

function upsertProfileState(profile) {
  const index = state.profiles.findIndex((existing) => String(existing.id) === String(profile.id));
  if (index >= 0) state.profiles[index] = profile;
  else state.profiles.push(profile);
}

async function saveProfile(row) {
  const id = row.dataset.id;
  const payload = getProfilePayload(row);
  if (!payload.name || !payload.putio_folder_name || !payload.downloadAt || !payload.rpc_path) {
    setMessage('Profile name, put.io folder, download folder, and RPC endpoint are required.', 'error');
    return;
  }

  let savedProfile;
  if (id) {
    savedProfile = await api(`/api/profiles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  } else {
    savedProfile = await api('/api/profiles', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
  populateProfileRow(row, savedProfile);
  upsertProfileState(savedProfile);
  setMessage('Profile saved.', 'ok');
}

async function deleteProfile(row) {
  const id = row.dataset.id;
  if (!id) {
    row.remove();
    return;
  }
  await api(`/api/profiles/${id}`, { method: 'DELETE' });
  state.profiles = state.profiles.filter((profile) => String(profile.id) !== String(id));
  row.remove();
  setMessage('Profile deleted.', 'ok');
}

function addProfileRow() {
  const name = 'New profile';
  const row = createProfileRow({
    id: '',
    name,
    type: 'custom',
    putio_folder_name: 'putiorr-new',
    downloadAt: '/downloads/new',
    rpc_path: `/${slugify(name)}/transmission/rpc`,
    enabled: true,
  });
  el.profilesBody.appendChild(row);
  row.querySelector('[data-field="name"]').focus();
}

function renderDownloads() {
  el.downloadsList.replaceChildren();
  if (state.downloads.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No active downloads yet. Once an RR client adds a release, progress will appear here.';
    el.downloadsList.appendChild(empty);
    return;
  }

  for (const download of state.downloads) {
    const putioProgress = clampPercent(download.putioProgress);
    const localProgress = clampPercent(download.localProgress);
    const combinedProgress = clampPercent(download.combinedProgress);
    const files = download.files ?? {};
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

    const row = document.createElement('article');
    row.className = 'download-row';
    row.innerHTML = `
      <div>
        <div class="download-title" data-role="download-title"></div>
        <div class="download-meta" data-role="download-location"></div>
      </div>
      <div>
        <div class="metric-label">Status</div>
        <strong data-role="download-status"></strong>
        <div class="download-meta" data-role="download-files"></div>
      </div>
      <div class="progress-group">
        ${progressLine('Put.io', putioProgress, 'putio-bar', 'putio-progress')}
        ${progressLine('Local', localProgress, 'local-bar', 'local-progress', 'local')}
      </div>
      <div>
        <div class="metric-label">Speed / ETA</div>
        <strong data-role="download-speed"></strong>
        <div class="download-meta" data-role="download-eta"></div>
      </div>
    `;
    row.querySelector('[data-role="download-title"]').textContent = download.name;
    row.querySelector('[data-role="download-location"]').textContent = `${download.profileName} · ${download.downloadAt}`;
    row.querySelector('[data-role="download-status"]').textContent = `${download.lifecycle} · ${combinedProgress}%`;
    row.querySelector('[data-role="download-files"]').textContent = download.error || `${fileText} · ${sizeText}`;
    row.querySelector('[data-role="download-speed"]').textContent = formatSpeed(download.speed);
    row.querySelector('[data-role="download-eta"]').textContent = formatEta(download.eta);
    setProgressValue(row, 'putio-bar', putioProgress);
    setProgressValue(row, 'local-bar', localProgress);
    el.downloadsList.appendChild(row);
  }
}

function progressLine(label, value, barRole, valueRole, className = '') {
  return `
    <div class="progress-line">
      <span>${label}</span>
      <span class="bar ${className}" data-role="${barRole}"><span></span></span>
      <span data-role="${valueRole}">${value}%</span>
    </div>
  `;
}

function setProgressValue(row, role, value) {
  row.querySelector(`[data-role="${role}"] > span`).style.setProperty('--value', `${value}%`);
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value ?? 0))));
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatSpeed(value) {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return 'Idle';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

function formatEta(value) {
  const seconds = Number(value ?? -1);
  if (seconds < 0) return 'ETA unavailable';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function slugify(value) {
  return String(value || 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'profile';
}

el.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = el.putioToken.value.trim();
  if (!token && !state.settings?.tokenConfigured) {
    setMessage('Paste a put.io token before saving settings.', 'error');
    return;
  }
  const payload = token ? { putioToken: token } : {};
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  el.putioToken.value = '';
  setMessage('Settings saved.', 'ok');
  if (!requestStateRefresh()) await loadAll();
});

el.testConnectionButton.addEventListener('click', async () => {
  try {
    const token = el.putioToken.value.trim();
    const result = await api('/api/putio/test', {
      method: 'POST',
      body: JSON.stringify(token ? { putioToken: token } : {}),
    });
    setMessage(`Connected to put.io${result.username ? ` as ${result.username}` : ''}.`, 'ok');
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

el.oauthStartButton.addEventListener('click', async () => {
  try {
    stopOAuthPolling();
    const result = await api('/api/oauth/start', {
      method: 'POST',
      body: '{}',
    });
    oauth.code = result.code;
    el.oauthCode.textContent = result.code;
    el.oauthLink.href = result.linkUrl || 'https://put.io/link';
    el.oauthPanel.hidden = false;
    setMessage('Enter the code at put.io/link. Waiting for authorization...', 'neutral');
    oauth.timer = setInterval(() => {
      pollOAuth(false).catch((error) => setMessage(error.message, 'error'));
    }, 5000);
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

el.oauthPollButton.addEventListener('click', () => {
  pollOAuth(true).catch((error) => setMessage(error.message, 'error'));
});

async function pollOAuth(manual) {
  if (!oauth.code) {
    setMessage('Start OAuth first to get a put.io code.', 'error');
    return;
  }
  const result = await api('/api/oauth/poll', {
    method: 'POST',
    body: JSON.stringify({ code: oauth.code }),
  });
  if (result.status === 'OK' && result.tokenConfigured) {
    stopOAuthPolling();
    el.oauthPanel.hidden = true;
    oauth.code = '';
    setMessage('Put.io OAuth connected and token saved.', 'ok');
    if (!requestStateRefresh()) await loadAll();
    return;
  }
  if (manual) {
    setMessage(`Authorization status: ${result.status}.`, 'neutral');
  }
}

el.addProfileButton.addEventListener('click', addProfileRow);
el.refreshButton.addEventListener('click', () => {
  if (!requestStateRefresh()) {
    loadAll().catch((error) => setMessage(error.message, 'error'));
  }
});
el.pollButton.addEventListener('click', async () => {
  try {
    await api('/api/poll', { method: 'POST', body: '{}' });
    if (!requestStateRefresh()) await loadAll();
    setMessage('put.io poll completed.', 'ok');
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

connectUpdates();
setTimeout(() => {
  if (!state.settings) {
    loadAll().catch((error) => setMessage(error.message, 'error'));
  }
}, 1_000);
