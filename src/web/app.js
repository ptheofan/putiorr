import { state, el } from './state.js';
import { DEFAULT_PROFILE_TYPE, PUTIO_CONNECTION_TABS } from './constants.js';
import { fieldValue } from './util.js';
import { api, connectUpdates, requestStateRefresh } from './api.js';
import {
  setMessage,
  clearMessage,
  resetPutioAccount,
  refreshPutioAccount,
  renderConnection,
  activePutioTab,
  setPutioTab,
  openPutioDialog,
  closePutioDialog,
  consumeOAuthLanding,
  promptForMissingPutioConnection,
  stopOAuthPolling,
  savePutioOAuthSettings,
  resetPutioOAuthSettings,
  refreshOAuthStatus,
} from './putio.js';
import {
  renderProfiles,
  openProfileWizard,
  closeProfileWizard,
  createDefaultProfile,
  saveAndTestClientSettings,
  deleteProfileById,
  setWizardMessage,
  setWizardHelpForField,
  updateWizardPreview,
  syncWizardDefaultsForType,
  copyClientSettings,
  WIZARD_HELP,
} from './profiles.js';
import {
  renderDownloadProfiles,
  openDownloadProfileDialog,
  closeDownloadProfileDialog,
  createDefaultDownloadProfile,
  saveDownloadProfileFromDialog,
  deleteDownloadProfileById,
  openProfileLinksDialog,
  closeProfileLinksDialog,
  saveProfileLinksFromDialog,
  updateDownloadProfileHelp,
  getDownloadProfileHelpFieldFromEvent,
  setDownloadProfileHelpForField,
  setDownloadProfileMessage,
  setProfileLinksMessage,
  DOWNLOAD_PROFILE_HELP,
} from './download-profiles.js';
import {
  renderDownloads,
  confirmPendingDelete,
  closeDeleteConfirm,
  updateDeleteConfirmButtonState,
} from './downloads.js';
import { initTheme } from './theme.js';
import { initRouter } from './router.js';

export async function loadAll() {
  const [settings, profiles, downloadProfiles, downloads] = await Promise.all([
    api('/api/settings'),
    api('/api/profiles'),
    api('/api/download-profiles'),
    api('/api/downloads'),
  ]);
  state.settings = settings;
  state.profiles = profiles;
  state.downloadProfiles = downloadProfiles;
  state.downloads = downloads;
  render();
  if (!consumeOAuthLanding()) promptForMissingPutioConnection();
}

async function loadVersion() {
  state.version = await api('/api/version');
  renderVersion();
}

function render() {
  renderVersion();
  renderConnection();
  renderProfiles();
  renderDownloadProfiles();
  renderDownloads();
}

function renderVersion() {
  const version = state.version;
  const isUpdateAvailable = Boolean(version?.updateAvailable && version.latestVersion);
  const currentVersion = version?.currentVersion ? `v${version.currentVersion}` : '';
  el.versionUpdateLink.hidden = !isUpdateAvailable && !currentVersion;
  el.versionUpdateLink.classList.toggle('is-current-version', !isUpdateAvailable);
  if (!isUpdateAvailable) {
    el.versionUpdateLink.removeAttribute('href');
    el.versionUpdateLink.removeAttribute('aria-label');
    el.versionUpdateLink.title = currentVersion ? `Current putiorr version: ${currentVersion}.` : '';
    el.versionUpdateLink.textContent = currentVersion;
    return;
  }

  const latest = `v${version.latestVersion}`;
  el.versionUpdateLink.href = version.releaseUrl || 'https://github.com/ptheofan/putiorr/releases/latest';
  el.versionUpdateLink.textContent = `${latest} available`;
  el.versionUpdateLink.title = `putiorr ${latest} is available. Current version: ${version.currentVersion}.`;
  el.versionUpdateLink.setAttribute('aria-label', `${el.versionUpdateLink.textContent}. Open putiorr releases.`);
}

el.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activePutioTab() === 'oauth') {
    await savePutioOAuthSettings().catch((error) => setMessage(error.message, 'error'));
    return;
  }
  const token = fieldValue(el.putioToken).trim();
  if (!token && !state.settings?.tokenConfigured) {
    setMessage('Paste a put.io token before saving settings.', 'error');
    return;
  }
  const payload = token ? { putioToken: token } : {};
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  state.settings = settings;
  el.putioToken.value = '';
  resetPutioAccount();
  renderConnection();
  setMessage('Token saved.', 'ok');
  if (settings.tokenConfigured) refreshPutioAccount({ force: true }).catch(() => {});
  requestStateRefresh();
});

el.settingsMessageClose.addEventListener('click', clearMessage);

el.togglePutioAdvancedButton.addEventListener('click', () => {
  state.putioAdvancedOpen = !state.putioAdvancedOpen;
  renderConnection();
  if (state.putioAdvancedOpen) el.putioOAuthRelayUrl.focus();
});

el.savePutioOAuthSettingsButton.addEventListener('click', () => {
  savePutioOAuthSettings().catch((error) => setMessage(error.message, 'error'));
});

el.resetPutioOAuthSettingsButton.addEventListener('click', () => {
  resetPutioOAuthSettings().catch((error) => setMessage(error.message, 'error'));
});

el.testConnectionButton.addEventListener('click', async () => {
  try {
    const token = fieldValue(el.putioToken).trim();
    const result = await api('/api/putio/test', {
      method: 'POST',
      body: JSON.stringify(token ? { putioToken: token } : {}),
    });
    state.putioAccount = {
      status: 'ok',
      username: result.username || '',
      error: '',
    };
    renderConnection();
    setMessage(`Connected to put.io${result.username ? ` as ${result.username}` : ''}.`, 'ok');
  } catch (error) {
    state.putioAccount = {
      status: 'error',
      username: '',
      error: error.message,
    };
    renderConnection();
    setMessage(error.message, 'error');
  }
});

el.putioDisconnectButton.addEventListener('click', async () => {
  try {
    stopOAuthPolling();
    const settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ putioToken: '' }),
    });
    state.settings = settings;
    el.putioToken.value = '';
    el.oauthPanel.hidden = true;
    resetPutioAccount();
    renderConnection();
    setPutioTab('oauth', { focus: false });
    setMessage(
      settings.tokenConfigured
        ? 'Stored token removed, but an environment token is still configured.'
        : 'Put.io disconnected.',
      settings.tokenConfigured ? 'warn' : 'ok',
    );
    requestStateRefresh();
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

el.oauthStartButton.addEventListener('click', async () => {
  stopOAuthPolling();
  try {
    const result = await api('/api/oauth/start', {
      method: 'POST',
      body: '{}',
    });
    el.oauthCode.textContent = 'OAuth';
    el.oauthLink.href = result.authUrl;
    el.oauthCallbackUrl.textContent = result.putioRedirectUri || result.redirectUri || '';
    el.oauthPanel.hidden = false;
    setMessage('Redirecting to put.io authorization...', 'neutral');
    window.location.assign(result.authUrl);
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

el.oauthPollButton.addEventListener('click', () => {
  refreshOAuthStatus(true).catch((error) => setMessage(error.message, 'error'));
});

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== 'putiorr:putio-oauth-complete') return;
  refreshOAuthStatus(true).catch((error) => setMessage(error.message, 'error'));
});

el.addProfileButton.addEventListener('click', () => openProfileWizard(createDefaultProfile(DEFAULT_PROFILE_TYPE)));
el.linkDownloadProfilesButton.addEventListener('click', openProfileLinksDialog);
el.addDownloadProfileButton.addEventListener('click', () => openDownloadProfileDialog(createDefaultDownloadProfile()));
el.profileWizardForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveAndTestClientSettings().catch((error) => setWizardMessage(error.message, 'error'));
});
el.profileWizardClose.addEventListener('click', closeProfileWizard);
el.profileWizard.querySelector('[data-action="cancel-profile-wizard"]').addEventListener('click', closeProfileWizard);
el.profileWizard.addEventListener('click', (event) => {
  if (event.target === el.profileWizard) closeProfileWizard();
});
el.profileWizardForm.addEventListener('focusin', (event) => {
  const fieldId = event.target?.id;
  if (WIZARD_HELP[fieldId]) setWizardHelpForField(fieldId);
});
el.wizardProfileType.addEventListener('change', syncWizardDefaultsForType);
for (const input of [
  el.wizardProfileName,
  el.wizardPutioFolder,
  el.wizardDownloadAt,
  el.wizardDownloadProfile,
  el.wizardRpcPath,
  el.wizardClientHost,
  el.wizardClientPort,
  el.wizardUseSsl,
  el.wizardEnabled,
]) {
  input.addEventListener('input', updateWizardPreview);
  input.addEventListener('change', updateWizardPreview);
}
el.copyClientSettingsButton.addEventListener('click', () => {
  copyClientSettings().catch((error) => setWizardMessage(error.message, 'error'));
});
el.deleteProfileButton.addEventListener('click', () => {
  deleteProfileById().catch((error) => setWizardMessage(error.message, 'error'));
});
el.downloadProfileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveDownloadProfileFromDialog().catch((error) => setDownloadProfileMessage(error.message, 'error'));
});
el.downloadProfileForm.addEventListener('focusin', (event) => {
  const fieldId = getDownloadProfileHelpFieldFromEvent(event);
  if (DOWNLOAD_PROFILE_HELP[fieldId]) setDownloadProfileHelpForField(fieldId);
});
el.downloadProfileForm.addEventListener('click', updateDownloadProfileHelp);
for (const input of [
  el.downloadProfileName,
  el.downloadSlowSpeedThresholdDisabled,
  el.downloadSlowSpeedThresholdAmount,
  el.downloadSlowSpeedThresholdUnit,
  el.downloadSlowSpeedDurationAmount,
  el.downloadSlowSpeedDurationUnit,
  el.downloadSlowSpeedGraceAmount,
  el.downloadSlowSpeedGraceUnit,
  el.downloadSlowSpeedMinSizeDisabled,
  el.downloadSlowSpeedMinSizeAmount,
  el.downloadSlowSpeedMinSizeUnit,
]) {
  input.addEventListener('input', updateDownloadProfileHelp);
  input.addEventListener('change', updateDownloadProfileHelp);
}
el.downloadProfileDialogClose.addEventListener('click', closeDownloadProfileDialog);
el.downloadProfileDialog.querySelector('[data-action="cancel-download-profile"]').addEventListener('click', closeDownloadProfileDialog);
el.downloadProfileDialog.addEventListener('click', (event) => {
  if (event.target === el.downloadProfileDialog) closeDownloadProfileDialog();
});
el.deleteDownloadProfileButton.addEventListener('click', () => {
  deleteDownloadProfileById().catch((error) => setDownloadProfileMessage(error.message, 'error'));
});
el.profileLinksForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveProfileLinksFromDialog().catch((error) => setProfileLinksMessage(error.message, 'error'));
});
el.profileLinksClose.addEventListener('click', closeProfileLinksDialog);
el.profileLinksDialog.querySelector('[data-action="cancel-profile-links"]').addEventListener('click', closeProfileLinksDialog);
el.profileLinksDialog.addEventListener('click', (event) => {
  if (event.target === el.profileLinksDialog) closeProfileLinksDialog();
});
for (const button of el.putioTabButtons) {
  button.addEventListener('click', () => setPutioTab(button.dataset.putioTab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = PUTIO_CONNECTION_TABS.indexOf(activePutioTab());
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + direction + PUTIO_CONNECTION_TABS.length) % PUTIO_CONNECTION_TABS.length;
    setPutioTab(PUTIO_CONNECTION_TABS[nextIndex]);
  });
}
for (const button of el.putioStatusButtons) {
  button.addEventListener('click', () => openPutioDialog('oauth'));
}
document.querySelector('#helpConnectButton')?.addEventListener('click', () => openPutioDialog('oauth'));

el.putioDialogClose.addEventListener('click', closePutioDialog);
el.putioDialog.querySelector('[data-action="cancel-putio"]').addEventListener('click', closePutioDialog);
el.putioDialog.addEventListener('click', (event) => {
  if (event.target === el.putioDialog) closePutioDialog();
});
el.deleteConfirmForm.addEventListener('submit', (event) => {
  event.preventDefault();
  confirmPendingDelete();
});
el.deleteFromPutio.addEventListener('change', updateDeleteConfirmButtonState);
el.deleteLocalFiles.addEventListener('change', updateDeleteConfirmButtonState);
el.deleteConfirmClose.addEventListener('click', closeDeleteConfirm);
el.deleteConfirmDialog.querySelector('[data-action="cancel-delete"]').addEventListener('click', closeDeleteConfirm);
el.deleteConfirmDialog.addEventListener('click', (event) => {
  if (event.target === el.deleteConfirmDialog) closeDeleteConfirm();
});

initTheme();
initRouter();

loadAll().catch((error) => setMessage(error.message, 'error'));
loadVersion().catch(() => {});
connectUpdates();
