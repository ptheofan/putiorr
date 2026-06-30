import { state, el } from './state.js';
import { api, requestStateRefresh } from './api.js';
import { PUTIO_CONNECTION_TABS } from './constants.js';
import { fieldValue } from './util.js';
import { renderTopology } from './topology.js';

export const oauth = {
  timer: undefined,
  popup: undefined,
};

export function setMessage(message, tone = 'neutral') {
  if (!message) {
    el.settingsMessage.textContent = '';
    el.settingsMessageBox.hidden = true;
    return;
  }
  el.settingsMessage.textContent = message;
  el.settingsMessageBox.dataset.tone = tone;
  el.settingsMessageBox.hidden = false;
}

export function clearMessage() {
  setMessage('');
}

export function stopOAuthPolling() {
  if (oauth.timer) {
    clearInterval(oauth.timer);
    oauth.timer = undefined;
  }
  oauth.popup = undefined;
}

export function resetPutioAccount() {
  state.putioAccount = {
    status: 'idle',
    username: '',
    error: '',
  };
}

export function putioAccountName() {
  if (state.putioAccount.status === 'ok') {
    return state.putioAccount.username || 'Put.io account';
  }
  if (state.putioAccount.status === 'error') {
    return 'Connected, account unavailable';
  }
  return 'Checking account...';
}

export function putioConnectionSummary() {
  if (!state.settings?.tokenConfigured) {
    return 'No put.io token is configured. Connect with OAuth or paste a token before RPC clients can add downloads.';
  }
  if (state.putioAccount.status === 'ok') {
    return `${putioAccountName()} is connected.`;
  }
  if (state.putioAccount.status === 'error') {
    return 'Put.io token is configured, but account details could not be loaded.';
  }
  return 'Put.io token is configured. Checking account...';
}

export async function refreshPutioAccount({ force = false } = {}) {
  if (!state.settings?.tokenConfigured) {
    resetPutioAccount();
    renderConnection();
    return;
  }
  if (
    !force
    && ['loading', 'ok'].includes(state.putioAccount.status)
  ) {
    return;
  }
  state.putioAccount = {
    status: 'loading',
    username: '',
    error: '',
  };
  renderConnection();
  try {
    const result = await api('/api/putio/test', {
      method: 'POST',
      body: '{}',
    });
    state.putioAccount = {
      status: 'ok',
      username: result.username || '',
      error: '',
    };
  } catch (error) {
    state.putioAccount = {
      status: 'error',
      username: '',
      error: error.message,
    };
  }
  renderConnection();
}

export function renderConnection() {
  const connected = Boolean(state.settings?.tokenConfigured);
  const putioOAuth = state.settings?.putioOAuth ?? {};
  const putioRedirectUri = putioOAuth.putioRedirectUri ?? putioOAuth.redirectUri ?? '';
  if (!connected && state.putioAccount.status !== 'idle') resetPutioAccount();
  el.connectionState.textContent = putioConnectionSummary();
  const stateName = connected ? 'connected' : 'needs-token';
  for (const button of el.putioStatusButtons) {
    button.dataset.state = stateName;
    button.title = connected ? 'Put.io connected' : 'Put.io needs a token';
    button.setAttribute('aria-label', connected ? 'Put.io connected. Open connection settings.' : 'Put.io needs a token. Open connection settings.');
  }
  if (connected) {
    stopOAuthPolling();
    el.oauthPanel.hidden = true;
  }
  el.putioOauthStepLabel.textContent = connected ? 'Connected' : 'Connect';
  el.putioConnectPanel.hidden = connected;
  el.putioConnectedPanel.hidden = !connected;
  el.putioConnectedAccount.textContent = putioAccountName();
  el.testConnectionButton.disabled = !connected;
  el.putioDisconnectButton.hidden = !connected;
  el.putioDisconnectButton.disabled = !connected;
  el.putioOAuthRelayUrl.value = putioOAuth.relayUrl ?? putioOAuth.defaultRelayUrl ?? '';
  el.putioOAuthAppId.value = putioOAuth.appId ?? putioOAuth.defaultAppId ?? '';
  el.resetPutioOAuthSettingsButton.disabled = !putioOAuth.overridesConfigured;
  el.putioAdvancedSummary.textContent = putioOAuth.overridesConfigured
    ? 'Using custom OAuth settings'
    : putioOAuth.relayUrl
      ? 'Using default OAuth relay settings'
      : 'Using default self-hosted OAuth settings';
  el.putioAdvancedPanel.hidden = !state.putioAdvancedOpen;
  el.togglePutioAdvancedButton.textContent = state.putioAdvancedOpen
    ? 'hide OAuth settings'
    : 'change OAuth settings';
  if (putioRedirectUri) {
    el.oauthCallbackUrl.textContent = putioRedirectUri;
  }
  el.oauthStartButton.disabled = Boolean(putioOAuth.requiresCustomApp);
  el.oauthStartButton.title = putioOAuth.requiresCustomApp
    ? 'Change the Put.io OAuth App Id under Advanced first.'
    : '';
  if (putioOAuth.requiresCustomApp) {
    el.oauthSetupHint.textContent = `OAuth redirect needs your own put.io app. App id ${putioOAuth.appId} is put.io's Swagger test API. Register ${putioRedirectUri} as the callback URL, then change App Id under Advanced or set PUTIORR_PUTIO_APP_ID.`;
  } else if (putioOAuth.mode === 'hosted-relay') {
    el.oauthSetupHint.textContent = `Hosted relay mode. Register ${putioRedirectUri} as the put.io callback URL. After put.io authorizes, the relay returns to ${putioOAuth.redirectUri}.`;
  } else {
    el.oauthSetupHint.textContent = `Self-hosted redirect mode. Register ${putioRedirectUri} as the put.io callback URL.`;
  }
  el.oauthSetupHint.hidden = !putioRedirectUri;
  if (connected && state.putioAccount.status === 'idle') {
    refreshPutioAccount().catch(() => {});
  }
  renderTopology();
}

export function activePutioTab() {
  return PUTIO_CONNECTION_TABS.includes(el.putioDialog.dataset.activeTab)
    ? el.putioDialog.dataset.activeTab
    : 'oauth';
}

export function focusPutioTab(tab = activePutioTab()) {
  if (tab === 'token') {
    el.putioToken.focus();
    return;
  }
  if (state.settings?.tokenConfigured) {
    el.testConnectionButton.focus();
    return;
  }
  el.oauthStartButton.focus();
}

export function setPutioTab(tab, { focus = true } = {}) {
  const activeTab = PUTIO_CONNECTION_TABS.includes(tab) ? tab : 'oauth';
  el.putioDialog.dataset.activeTab = activeTab;
  for (const button of el.putioTabButtons) {
    const selected = button.dataset.putioTab === activeTab;
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of el.putioTabPanels) {
    panel.hidden = panel.dataset.putioPanel !== activeTab;
  }
  el.savePutioTokenButton.hidden = activeTab !== 'token';
  if (focus) focusPutioTab(activeTab);
}

export function openPutioDialog(tab = activePutioTab()) {
  renderConnection();
  setPutioTab(tab, { focus: false });
  if (!el.putioDialog.open) el.putioDialog.open = true;
  focusPutioTab(activePutioTab());
}

export function promptForMissingPutioConnection() {
  if (state.putioConnectionPromptShown || state.settings?.tokenConfigured) return;
  state.putioConnectionPromptShown = true;
  openPutioDialog('oauth');
  if (state.settings?.putioOAuth?.requiresCustomApp) {
    setMessage('Put.io OAuth needs your own put.io app id. Direct token still works.', 'warn');
    return;
  }
  setMessage('Put.io not connected. Connect with OAuth or paste a token.', 'warn');
}

export function consumeOAuthLanding() {
  const params = new URLSearchParams(window.location.search);
  const marker = params.get('putioOAuth');
  let stored = {};
  try {
    stored = JSON.parse(window.sessionStorage.getItem('putiorr:oauth-result') || '{}');
  } catch {
    stored = {};
  }
  if (!marker && !stored.status) return false;
  window.sessionStorage.removeItem('putiorr:oauth-result');
  if (window.history?.replaceState) {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.hash);
  }
  openPutioDialog('oauth');
  if (stored.status === 'error' || marker === 'error') {
    setMessage(stored.message || 'Put.io OAuth did not complete.', 'error');
    return true;
  }
  if (state.settings?.tokenConfigured) {
    setMessage('Put.io OAuth connected and token saved.', 'ok');
    return true;
  }
  setMessage('Put.io OAuth returned, but no token is configured. Check the put.io redirect URI and try again.', 'error');
  return true;
}

export function closePutioDialog() {
  if (el.putioDialog.open) el.putioDialog.open = false;
}

export async function savePutioOAuthSettings() {
  const appId = fieldValue(el.putioOAuthAppId).trim();
  const relayUrl = fieldValue(el.putioOAuthRelayUrl).trim();
  if (!appId) {
    setMessage('Put.io OAuth App Id is required.', 'error');
    el.putioOAuthAppId.focus();
    return;
  }
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      putioOAuth: {
        appId,
        relayUrl,
      },
    }),
  });
  state.settings = settings;
  renderConnection();
  setMessage('OAuth settings saved.', 'ok');
}

export async function resetPutioOAuthSettings() {
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      putioOAuth: {
        reset: true,
      },
    }),
  });
  state.settings = settings;
  renderConnection();
  setMessage('OAuth settings reset to baked defaults.', 'ok');
}

export async function refreshOAuthStatus(manual) {
  const settings = await api('/api/settings');
  state.settings = settings;
  if (settings.tokenConfigured) {
    stopOAuthPolling();
    el.oauthPanel.hidden = true;
    resetPutioAccount();
    renderConnection();
    setMessage('Put.io OAuth connected and token saved.', 'ok');
    refreshPutioAccount({ force: true }).catch(() => {});
    requestStateRefresh();
    return;
  }
  if (manual) {
    setMessage('Still waiting for put.io authorization.', 'neutral');
  }
}
