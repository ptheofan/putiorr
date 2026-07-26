// Reading putiorr's grab profiles, and saying what an empty answer meant.
// Shared by the options page and the toolbar popup: both ask putiorr the same
// question, and a second wording of these four refusals would be a second
// wording free to drift from the one the user saw last time.
//
// The DOM is never touched here and `fetch` is a global, so node can import
// this file and drive every branch below.

// A sleeping NAS accepts the connection and then says nothing; without a
// deadline the page stays on "Contacting putiorr…" forever.
export const PROFILES_TIMEOUT_MS = 15000;

// Every Putiorr Grab profile putiorr has, disabled ones included. ?type=grab is
// putiorr's filter, not one a page could apply itself: the preset vocabulary
// lives there, and only a Putiorr Grab profile can accept a grab, so listing
// any other kind would offer a pick putiorr refuses.
//
// The rows come back whole: the browser sites and the catch-all flag are on
// them, and the caller needs the disabled ones both to tell its empty states
// apart and to say which profile claims a site it cannot grab into.
export async function fetchGrabProfiles(baseUrl, headers = {}) {
  let response;
  try {
    response = await fetch(new URL('/api/profiles?type=grab', baseUrl), {
      headers,
      signal: AbortSignal.timeout(PROFILES_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`putiorr did not respond within ${PROFILES_TIMEOUT_MS / 1000}s at ${baseUrl}`);
    }
    throw new Error(`putiorr is unreachable at ${baseUrl}`);
  }

  if (response.status === 401) {
    throw new Error('putiorr rejected the credentials; check username and password');
  }
  if (!response.ok) throw new Error(`putiorr responded with ${response.status}`);

  const body = await response.json().catch(() => undefined);
  if (!Array.isArray(body)) throw new Error(`${baseUrl} did not answer with a profile list; check the URL`);
  return body;
}

// Three different answers end up with nothing to show, and only one of them is
// "create a profile". A row the page had to drop is a putiorr that answered
// with grab profiles, and a disabled row is a profile that exists: telling
// either user that none exist sends them to make a second one.
export function emptyProfilesComplaint(rows, enabledRows) {
  if (enabledRows.length) {
    return 'answered with Putiorr Grab profiles this page could not read; check that the URL points at putiorr';
  }
  if (rows.length) return 'has no enabled Putiorr Grab profiles; enable one there';
  return 'has no Putiorr Grab profiles; create one there with the Putiorr Grab preset';
}
