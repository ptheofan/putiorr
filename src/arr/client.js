// Issue #111. The one thing putiorr cannot say over Transmission.
//
// Sonarr maps a torrent's errorString to DownloadItemStatus.Warning and no
// Transmission condition ever yields Failed, so Failed Download Handling never
// fires and a bad release sits in Activity forever. Blocklisting is a library
// concept, not a download-client one, and only exists in the *arr REST API —
// which means an API key, which is why this is opt-in per profile.
//
// Sonarr v4 and Radarr v5 both still serve /api/v3 and the queue endpoints are
// identical in shape, so one call covers both.

const DEFAULT_TIMEOUT_MS = 15_000;

async function request(
  { baseUrl, apiKey, fetchImpl, timeoutMs },
  path,
  { method = 'GET', query } = {},
) {
  const url = new URL(`${baseUrl}/api/v3${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value != null) url.searchParams.set(key, String(value));
  }

  // Without this a hung *arr blocks the poll cycle that called it, which is the
  // same class of failure the download loop already guards against.
  const response = await fetchImpl(url, {
    method,
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body.message ?? body.error ?? response.statusText;
    const error = new Error(`*arr ${response.status}: ${message}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

/**
 * Tells the *arr to blocklist the release with this hash and search again.
 *
 * @returns {Promise<boolean>} true when the *arr held a queue item for the hash
 *   and accepted the rejection; false when it had none, in which case the
 *   caller must leave the download alone — nothing would search for it again.
 */
export async function rejectRelease({
  baseUrl, apiKey, hash, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!baseUrl) throw new Error('*arr base URL is required');
  if (!apiKey) throw new Error('*arr API key is required');
  const wanted = String(hash ?? '').toUpperCase();
  if (!wanted) return false;

  const connection = { baseUrl, apiKey, fetchImpl, timeoutMs };
  // The *arr reports downloadId as the uppercased info hash. putiorr stores it
  // however put.io returned it, so both sides are folded before comparing.
  const body = await request(connection, '/queue', {
    query: { pageSize: 1000, includeUnknownSeriesItems: true, includeUnknownMovieItems: true },
  });
  const records = Array.isArray(body) ? body : (body.records ?? []);
  const item = records.find((record) => String(record?.downloadId ?? '').toUpperCase() === wanted);
  if (!item) return false;

  // blocklist=true records the release so it is never grabbed again;
  // skipRedownload=false is what makes the *arr search for a replacement, which
  // is the half that actually unblocks the queue item.
  //
  // removeFromClient=false because putiorr removes the download itself right
  // after this returns. Leaving it true has the *arr call torrent-remove back
  // into putiorr mid-rejection, racing the removal already in flight.
  await request(connection, `/queue/${item.id}`, {
    method: 'DELETE',
    query: { removeFromClient: false, blocklist: true, skipRedownload: false },
  });
  return true;
}
