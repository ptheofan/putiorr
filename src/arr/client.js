// Issue #111. The one thing putiorr cannot say over Transmission.
//
// Sonarr maps a torrent's errorString to DownloadItemStatus.Warning and no
// Transmission condition ever yields Failed, so Failed Download Handling never
// fires and a bad release sits in Activity forever. Blocklisting is a library
// concept, not a download-client one, and only exists in the *arr REST API —
// which means an API key, which is why this is opt-in per profile.
//
// Sonarr v4 and Radarr v5 both still serve /api/v3 and the queue endpoints are
// identical in shape, so one client covers both.

const DEFAULT_TIMEOUT_MS = 15_000;

export class ArrClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!baseUrl) throw new Error('*arr base URL is required');
    if (!apiKey) throw new Error('*arr API key is required');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', query } = {}) {
    const url = new URL(`${this.baseUrl}/api/v3${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }

    // Without this a hung *arr blocks the poll cycle that called it, which is
    // the same class of failure the download loop already guards against.
    const response = await this.fetch(url, {
      method,
      headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
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

  // The *arr reports downloadId as the uppercased info hash. putiorr stores it
  // however put.io returned it, so both sides are folded before comparing.
  async findQueueItemByHash(hash) {
    const wanted = String(hash ?? '').toUpperCase();
    if (!wanted) return undefined;
    const body = await this.request('/queue', {
      query: { pageSize: 1000, includeUnknownSeriesItems: true, includeUnknownMovieItems: true },
    });
    const records = Array.isArray(body) ? body : (body.records ?? []);
    return records.find((record) => String(record?.downloadId ?? '').toUpperCase() === wanted);
  }

  // blocklist=true records the release so it is never grabbed again;
  // skipRedownload=false is what makes the *arr search for a replacement, which
  // is the half that actually unblocks the queue item.
  //
  // removeFromClient=false because putiorr removes the download itself right
  // after this returns. Leaving it true has the *arr call torrent-remove back
  // into putiorr mid-rejection, racing the removal already in flight.
  async blocklistAndSearch(queueId) {
    await this.request(`/queue/${queueId}`, {
      method: 'DELETE',
      query: { removeFromClient: false, blocklist: true, skipRedownload: false },
    });
  }

  // Returns true when the *arr accepted the rejection, false when it had no
  // queue item for this hash — the caller still discards the download either
  // way, but only the first case means the *arr will search again.
  async rejectByHash(hash) {
    const item = await this.findQueueItemByHash(hash);
    if (!item) return false;
    await this.blocklistAndSearch(item.id);
    return true;
  }
}

// Only the two presets whose REST API this speaks. A custom or grab profile has
// no *arr behind it, and Lidarr/Readarr serve a v1 API this client does not
// implement — offering the fields there would promise something that fails.
export const ARR_REJECTION_PRESETS = new Set(['sonarr', 'radarr']);

export function supportsArrRejection(profile) {
  return ARR_REJECTION_PRESETS.has(String(profile?.type ?? '').toLowerCase());
}
