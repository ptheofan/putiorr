// Pure validation for the options form. Every function here exists so that a
// setting the extension would otherwise rewrite or drop in silence is reported
// back to the user instead. No chrome.* or DOM APIs, so node can import it.

// The single definition of what lives in chrome.storage.sync: the options page
// writes exactly these keys and the service worker reads them with these
// defaults, so a key added on one side only cannot go unnoticed. Credentials are
// deliberately absent — they belong in storage.local, which is not synchronized
// to the user's Google account. `rules` was retired when browser sites moved
// onto putiorr's profiles: neither side reads it, and the options page removes
// it once the user has seen what it held.
export const SYNC_DEFAULTS = {
  baseUrl: '',
  defaultProfileId: 0,
  autoCapture: true,
  profiles: [],
};

// What the user most likely meant when they typed a bare host, with or without
// a port: only these get the "write http:// in front" hint, so a "data:" URL or
// a mistyped "http:/nas" is not answered with "write http://http:/nas".
const HOSTISH = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d+)?$/i;

// The stored baseUrl is only ever used as `new URL('/api/grab', baseUrl)`, which
// resolves against the origin. Anything past the host is therefore discarded,
// and a URL that cannot be parsed at all turns every grab into a failure the
// user first sees on a link click, far away from this form.
export function validateBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter the putiorr URL, for example http://nas:9091' };

  if (!raw.includes('://')) {
    return {
      ok: false,
      error: HOSTISH.test(raw)
        ? `"${raw}" has no scheme: write http://${raw} instead`
        : `"${raw}" is not a full URL: putiorr needs one starting with http:// or https://`,
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `"${raw}" is not a valid URL` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `putiorr URL must start with http:// or https://, not ${url.protocol}//` };
  }

  if (url.username || url.password) {
    return { ok: false, error: 'Put the username and password in the fields below, not in the URL' };
  }

  const beyondHost = `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
  if (beyondHost) {
    return {
      ok: false,
      // putiorr is not subpath-deployable, so this is a refusal rather than a
      // normalization: "https://nas/putiorr" would silently become "https://nas".
      error: `putiorr must be at the root of the host: "${beyondHost}" would be ignored and every grab would go to ${url.protocol}//${url.host}/api/grab`,
    };
  }

  // The root dot of a fully qualified name is dropped here as putiorr drops it
  // from a browser site, so "https://nas./" and "https://nas" are one setting.
  const host = `${url.hostname.replace(/\.$/, '')}${url.port ? `:${url.port}` : ''}`;
  return { ok: true, baseUrl: `${url.protocol}//${host}` };
}
