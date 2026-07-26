import { encodeCredentials } from './lib/auth.js';
import { emptyProfilesComplaint, fetchGrabProfiles } from './lib/profiles.js';
import { sanitizeProfiles } from './lib/resolve.js';
import { hostFromTabUrl, routingForHost, storableSite } from './lib/sites.js';

// The toolbar popup. It answers one question about the page in the current tab
// — which profile a grab from here would land in — and offers the one edit that
// question usually leads to: claim this site for a grab profile, without going
// to the dashboard for it.
//
// Everything it shows is read from putiorr on open. Nothing about routing is
// cached: a site claimed elsewhere a minute ago would make a cached answer a
// confident wrong one, and this popup exists to be trusted about exactly that.
// Nothing builds markup from data — profile names come from the server.

const CLAIM_TIMEOUT_MS = 15000;

const el = (id) => document.getElementById(id);

// Everything the click handlers need after the page has loaded itself. Held
// here rather than re-read on click: the tab could have navigated by then, and
// the site the user was shown is the site they meant to claim.
const page = {
  baseUrl: '',
  headers: {},
  site: '',
  choices: [],
  claiming: false,
};

// Tones, as on the options page: 'note' for a request in flight, 'ok' for news
// that landed, 'error' for a refusal. 'note' is the absence of a class. Several
// lines are one message: putiorr's advice about a site rides along with the
// confirmation that stored it, and the stylesheet renders the break.
function setStatus(message, tone = 'note') {
  const status = el('status');
  const lines = Array.isArray(message) ? message.filter(Boolean) : [message];
  status.textContent = lines.join('\n');
  status.className = tone === 'note' ? '' : tone;
}

function profileName(profile) {
  return String(profile?.name ?? '').trim() || 'A profile';
}

// The one sentence that says where a grab from this page goes today. A wildcard
// match names the entry that was actually listed: "dl.x.example is handled by
// Movies" otherwise reads like a site nobody typed. It says "covers" rather
// than "is a subdomain of", because "*.x.example" covers x.example itself as
// well. A profile that is switched off still claims what it claims — putiorr
// refuses such a grab by name rather than passing it to the next profile — so
// both halves are said.
function routingText(routing, site) {
  if (routing.kind === 'claimed') {
    const opening = routing.viaWildcard
      ? `${profileName(routing.profile)} claims ${routing.domain}, which covers ${site},`
        + ' so grabs from here go there.'
      : `${profileName(routing.profile)} claims this site; grabs from here go there.`;
    return routing.disabled
      ? `${opening} That profile is switched off, so such a grab is refused rather than routed.`
      : opening;
  }

  if (routing.kind === 'catch-all') {
    const opening = `No profile claims this site. ${profileName(routing.profile)} takes every site no`
      + ' profile claims, so grabs from here go there for now.';
    return routing.disabled
      ? `${opening} That profile is switched off, so such a grab is refused rather than routed.`
      : opening;
  }

  return 'No profile claims this site, and no profile takes the sites nobody claims:'
    + ' a grab from here is refused.';
}

// One radio per profile the user may claim for. The picked profile is read off
// these inputs at claim time rather than tracked in a variable, so what the
// popup sends is what the radio group actually shows.
function renderChoices(profiles, preferredId) {
  page.choices = profiles.map((profile, index) => {
    const row = document.createElement('label');
    row.className = 'choice-row';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'profile';
    input.value = String(profile.id);
    // The profile already taking these grabs is the one pre-picked: claiming
    // for it is the click that turns "for now" into a listed site.
    input.checked = preferredId ? profile.id === preferredId : index === 0;
    const name = document.createElement('span');
    name.className = 'choice-name';
    name.textContent = profile.name;
    row.append(input, name);
    return { profile, row, input };
  });
  el('profileChoices').replaceChildren(...page.choices.map((choice) => choice.row));
}

function showPicker(profiles, preferredId) {
  renderChoices(profiles, preferredId);
  // What will be stored, before the click and not after it: the host as it is,
  // never a guess at the registrable domain behind it.
  el('storeNote').textContent = `Claiming stores ${page.site} on the profile you pick.`
    + ' Subdomains of it match too.';
  el('claim').textContent = `Claim ${page.site}`;
  el('claim').disabled = false;
  el('picker').hidden = false;
}

// What to show in the host slot for a tab that has no site to claim. The URL is
// the only thing that explains which tab this is, and it is attacker-influenced
// and unbounded, so it is capped.
function tabLabel(tab) {
  const url = String(tab?.url ?? '').trim();
  return url ? url.slice(0, 80) : 'No page';
}

async function postClaim(profileId) {
  let endpoint;
  try {
    endpoint = new URL(`/api/profiles/${profileId}/browser-sites`, page.baseUrl);
  } catch {
    throw new Error(`putiorr URL is not valid: ${page.baseUrl}`);
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...page.headers,
        'Content-Type': 'application/json',
        // The anti-CSRF token this write requires, exactly as /api/grab does:
        // the extension is CORS-exempt through its host permissions, an
        // attacker page is not, and without it any page could hand its own
        // host to a profile and collect the grabs that followed.
        'X-Putiorr-Grab': '1',
      },
      body: JSON.stringify({ host: page.site }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`putiorr did not respond within ${CLAIM_TIMEOUT_MS / 1000}s at ${page.baseUrl}`);
    }
    throw new Error(`putiorr is unreachable at ${page.baseUrl}`);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    if (response.status === 401) {
      throw new Error('putiorr rejected the credentials; check username and password in the options');
    }
    // Relayed as putiorr worded it. The refusal that matters most here names
    // the profile that already claims the site, which this popup cannot know
    // better than putiorr does; a second copy of that sentence would be one
    // free to drift from the one that decides.
    throw new Error(body.error || `putiorr responded with ${response.status}`);
  }
  return body;
}

async function claim() {
  // A popup is small and its button is easy to hit twice. The second click is
  // dropped rather than queued: it would be a second identical request, and
  // the first one's answer is what the page is waiting to show.
  if (page.claiming) return;
  const picked = page.choices.find((choice) => choice.input.checked) ?? page.choices[0];
  if (!picked) return;

  page.claiming = true;
  el('claim').disabled = true;
  setStatus(`Claiming ${page.site} for ${picked.profile.name}…`);

  let result;
  try {
    result = await postClaim(picked.profile.id);
  } catch (error) {
    setStatus(error.message, 'error');
    page.claiming = false;
    el('claim').disabled = false;
    return;
  }

  // The reply names the profile that answered, and says whether the site was
  // appended or was already handled by it. Offering the claim again would be
  // offering to do what was just done, so the picker goes away either way.
  const name = String(result.profile?.name ?? '').trim() || picked.profile.name;
  el('picker').hidden = true;
  el('routing').textContent = `${name} claims this site; grabs from here go there.`;
  // putiorr's advice about what was just stored — a single-label site is a rule
  // over everything ending in it — is shown with the confirmation. Dropping it
  // would leave the confirmation looking complete when it is not.
  const warnings = Array.isArray(result.browser_domain_warnings) ? result.browser_domain_warnings : [];
  setStatus([
    result.added ? `${name} now claims ${page.site}` : `${name} already claims ${page.site}`,
    ...warnings.map((warning) => String(warning ?? '')),
  ], 'ok');
}

async function start() {
  el('picker').hidden = true;

  const sync = await chrome.storage.sync.get({ baseUrl: '' });
  const local = await chrome.storage.local.get({ username: '', password: '' });
  page.baseUrl = String(sync.baseUrl ?? '').trim();
  if (local.username || local.password) {
    page.headers.Authorization = `Basic ${encodeCredentials(local.username, local.password)}`;
  }
  // Nowhere to go without a URL, and the button would open about:blank.
  el('openDashboard').hidden = !page.baseUrl;

  const [tab] = (await chrome.tabs.query({ active: true, currentWindow: true })) ?? [];
  page.site = storableSite(hostFromTabUrl(tab?.url));
  el('host').textContent = page.site || tabLabel(tab);

  // A chrome:// page, about:blank, a local file, a tab that is not there: none
  // has a hostname a profile could ever match, so there is nothing to ask
  // putiorr and nothing to offer.
  if (!page.site) {
    el('routing').textContent = 'Browser sites are matched against a page\'s hostname.';
    setStatus('This tab has no site to claim: only a page served over http or https has one.', 'error');
    return;
  }

  if (!page.baseUrl) {
    el('routing').textContent = 'The extension does not know where putiorr is yet.';
    setStatus('Set the putiorr URL in the extension options first', 'error');
    return;
  }

  setStatus('Contacting putiorr…');
  let rows;
  try {
    rows = await fetchGrabProfiles(page.baseUrl, page.headers);
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }

  // Routing is answered from every row, disabled ones included, because that is
  // the set putiorr resolves a grab against. The picker is offered from the
  // enabled ones only: claiming for a profile that accepts no work would be a
  // claim that changes nothing about a grab from here.
  const enabledRows = rows.filter((row) => row?.enabled);
  const offerable = sanitizeProfiles(enabledRows);
  const routing = routingForHost(rows, page.site);
  el('routing').textContent = routingText(routing, page.site);

  if (routing.kind === 'claimed') {
    // Refuse-and-name rather than offer to move it: a move is two profiles
    // changing at once from a popup that shows one of them, and a site added
    // behind an existing claim would route nothing — resolution stops at the
    // first profile that matches. The dashboard is where that edit can be seen
    // whole, and both buttons below lead out of here.
    setStatus('');
    return;
  }

  if (!offerable.length) {
    setStatus(`putiorr at ${page.baseUrl} ${emptyProfilesComplaint(rows, enabledRows)}`, 'error');
    return;
  }

  setStatus('');
  showPicker(offerable, routing.kind === 'catch-all' ? Number(routing.profile?.id) : undefined);
}

el('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
el('openDashboard').addEventListener('click', () => {
  // A popup closes the moment focus leaves it, so the dashboard opens in a tab
  // rather than in here.
  Promise.resolve(chrome.tabs.create({ url: page.baseUrl }))
    .catch((error) => setStatus(error.message, 'error'));
});
el('claim').addEventListener('click', () => {
  claim().catch((error) => setStatus(error.message, 'error'));
});

// An unhandled rejection here would leave the popup blank with no explanation,
// which is the one outcome worse than any answer it could give. Two different
// reads can fail — the stored settings and the current tab — so the message
// carries what actually failed rather than naming one of them and being wrong
// half the time.
start().catch((error) => setStatus(`The popup could not read what it needs: ${error.message}`, 'error'));
