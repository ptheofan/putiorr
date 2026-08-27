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

// What each preset calls a search, and what it calls the thing being searched
// for. The only two presets that reach here; see ARR_REJECTION_PRESETS.
const SEARCH_COMMANDS = {
  sonarr: { command: 'EpisodeSearch', idsField: 'episodeIds', recordField: 'episodeId' },
  radarr: { command: 'MoviesSearch', idsField: 'movieIds', recordField: 'movieId' },
};

async function request(
  { baseUrl, apiKey, fetchImpl, timeoutMs },
  path,
  { method = 'GET', query, body } = {},
) {
  const url = new URL(`${baseUrl}/api/v3${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value != null) url.searchParams.set(key, String(value));
  }

  // Without this a hung *arr blocks the poll cycle that called it, which is the
  // same class of failure the download loop already guards against.
  const response = await fetchImpl(url, {
    method,
    headers: {
      'X-Api-Key': apiKey,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = parsed.message ?? parsed.error ?? response.statusText;
    const error = new Error(`*arr ${response.status}: ${message}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

/**
 * Tells the *arr to blocklist the release with this hash, then asks it to search
 * again for what that release was going to satisfy.
 *
 * putiorr issues the search itself rather than letting the *arr do it. The *arr
 * only re-searches when its own "Redownload Failed" setting is on, so relying on
 * that leaves the release blocklisted and never replaced on any install where it
 * is switched off — the queue empties, nothing is searched, and nothing says
 * why. skipRedownload=true keeps the *arr out of it, so exactly one search runs
 * whatever that setting says.
 *
 * @returns {Promise<{queued: boolean, blocklisted: boolean, searched: boolean}>}
 *   queued is false when the *arr held no queue item for this hash, in which
 *   case nothing was touched and the caller must leave the download alone.
 */
export async function rejectRelease({
  baseUrl, apiKey, hash, preset, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!baseUrl) throw new Error('*arr base URL is required');
  if (!apiKey) throw new Error('*arr API key is required');
  const wanted = String(hash ?? '').toUpperCase();
  if (!wanted) return { queued: false, blocklisted: false, searched: false, queueSize: 0 };

  const connection = { baseUrl, apiKey, fetchImpl, timeoutMs };
  // The *arr reports downloadId as the uppercased info hash. putiorr stores it
  // however put.io returned it, so both sides are folded before comparing.
  const body = await request(connection, '/queue', {
    query: { pageSize: 1000, includeUnknownSeriesItems: true, includeUnknownMovieItems: true },
  });
  const records = Array.isArray(body) ? body : (body.records ?? []);
  // A season pack is one grab spread over one queue row per episode. Removing
  // any one of them fails the whole tracked download, but the search has to
  // cover every episode that grab was meant to satisfy.
  const matching = records.filter(
    (record) => String(record?.downloadId ?? '').toUpperCase() === wanted,
  );
  if (matching.length === 0) {
    return { queued: false, blocklisted: false, searched: false, queueSize: records.length };
  }

  const search = SEARCH_COMMANDS[String(preset ?? '').trim().toLowerCase()];
  const ids = search
    ? [...new Set(matching.map((record) => record[search.recordField]).filter(Boolean))]
    : [];

  // blocklist=true records the release so it is never grabbed again.
  //
  // removeFromClient=false because putiorr removes the download itself right
  // after this returns. Leaving it true has the *arr call torrent-remove back
  // into putiorr mid-rejection, racing the removal already in flight.
  await request(connection, `/queue/${matching[0].id}`, {
    method: 'DELETE',
    query: { removeFromClient: false, blocklist: true, skipRedownload: true },
  });

  const diagnostics = {
    queued: true,
    blocklisted: true,
    queueSize: records.length,
    matchedQueueIds: matching.map((record) => record.id),
    searchIds: ids,
  };
  if (ids.length === 0) return { ...diagnostics, searched: false };

  await request(connection, '/command', {
    method: 'POST',
    body: { name: search.command, [search.idsField]: ids },
  });
  return { ...diagnostics, searched: true, searchCommand: search.command };
}
