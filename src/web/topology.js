import { state, el } from './state.js';
import { escapeSvgText, truncateLabel, clampPercent } from './util.js';
import { PUTIO_PHASE_LABELS } from './constants.js';
import { profileType, profileDisplayName } from './profiles.js';
import { downloadProfileDisplayName, defaultDownloadProfileId } from './download-profiles.js';

// --- Topology map: put.io -> RR profiles -> download profiles + downloads ---
export function topologyDownloadsForProfile(profile) {
  const name = profileDisplayName(profile);
  return state.downloads.filter(
    (download) => profile.id != null && download.profileId != null
      ? String(download.profileId) === String(profile.id)
      : download.profileName === name || download.profileName === profile.name,
  );
}

export function downloadTopologyVariant(download) {
  if (download.error) return 'download-error';
  if (download.lifecycle === 'local' || download.lifecycle === 'completed') return 'download-active';
  return 'download';
}

export function downloadTopologyEyebrow(download) {
  if (download.error) return 'Download · error';
  if (download.lifecycle === 'remote') {
    const phase = PUTIO_PHASE_LABELS[download.putioStatus];
    return phase ? `Download · ${phase.replace(' on Put.io', '')}` : 'Download · on put.io';
  }
  return `Download · ${download.lifecycle}`;
}

function topologyKey(prefix, value) {
  return `${prefix}-${String(value ?? 'default').replace(/[^a-z0-9_-]/gi, '-')}`;
}

function topologyRelations(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].join(' ');
}

export function topologyNode(x, y, w, h, eyebrow, title, sub, variant, key, related) {
  // Character estimates tuned per font size (title is 14px bold, eyebrow/sub are
  // ~10-11px) so labels truncate before the edge; the clipPath then hard-guarantees
  // nothing can ever paint outside the node box.
  const inner = w - 28;
  const titleCap = Math.max(6, Math.floor(inner / 8.4));
  const smallCap = Math.max(6, Math.floor(inner / 6));
  const clipId = `tc${Math.round(x)}-${Math.round(y)}`;
  const subText = sub
    ? `<text x="${x + 14}" y="${y + 48}" class="topo-sub">${escapeSvgText(truncateLabel(sub, smallCap))}</text>`
    : '';
  const accessibleLabel = topologyRelations(eyebrow, title, sub);
  return `<g class="topo-node-group" tabindex="0" data-topology-key="${key}" data-topology-related="${related}">
    <title>${escapeSvgText(accessibleLabel)}</title>
    <clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11"></rect></clipPath>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11" class="topo-node topo-node--${variant}"></rect>
    <g clip-path="url(#${clipId})">
      <text x="${x + 14}" y="${y + 19}" class="topo-eyebrow">${escapeSvgText(truncateLabel(eyebrow, smallCap))}</text>
      <text x="${x + 14}" y="${y + 35}" class="topo-node-title">${escapeSvgText(truncateLabel(title, titleCap))}</text>
      ${subText}
    </g>
  </g>`;
}

function topologyProfilePill(x, cy, w, h, title, key, related) {
  const cap = Math.max(6, Math.floor((w - 24) / 7));
  return `<g class="topo-node-group" tabindex="0" data-topology-key="${key}" data-topology-related="${related}">
    <title>${escapeSvgText(`Download profile: ${title}`)}</title>
    <rect x="${x}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2}" class="topo-profile-pill"></rect>
    <text x="${x + w / 2}" y="${cy + 4}" class="topo-profile-pill-text">${escapeSvgText(truncateLabel(title, cap))}</text>
  </g>`;
}

export function topologyEdge(x1, y1, x2, y2, cls = '', related = '') {
  const dx = Math.max(28, (x2 - x1) * 0.5);
  return `<path d="M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" class="topo-edge ${cls}" data-topology-related="${related}"></path>`;
}

function traceTopologyRoute(canvas, node) {
  traceTopologyKey(canvas, node?.dataset.topologyKey);
}

function traceTopologyKey(canvas, key) {
  const svg = canvas.querySelector('.topo-svg');
  if (!svg || !key) return;
  let found = false;
  for (const item of svg.querySelectorAll('[data-topology-related]')) {
    const highlighted = item.dataset.topologyRelated.split(' ').includes(key);
    item.classList.toggle('is-highlighted', highlighted);
    if (highlighted) found = true;
  }
  if (!found) return clearTopologyTrace(canvas);
  canvas.dataset.topologyTraceKey = key;
  svg.classList.add('is-tracing');
}

function clearTopologyTrace(canvas) {
  const svg = canvas.querySelector('.topo-svg');
  if (!svg) return;
  delete canvas.dataset.topologyTraceKey;
  svg.classList.remove('is-tracing');
  for (const item of svg.querySelectorAll('.is-highlighted')) item.classList.remove('is-highlighted');
}

function bindTopologyTracing(canvas) {
  const nodeFromEvent = (event) => event.target.closest?.('[data-topology-key]');
  canvas.onpointerover = (event) => traceTopologyRoute(canvas, nodeFromEvent(event));
  canvas.onpointerout = (event) => {
    const node = nodeFromEvent(event);
    if (!node?.contains(event.relatedTarget)) clearTopologyTrace(canvas);
  };
  canvas.onfocusin = (event) => traceTopologyRoute(canvas, nodeFromEvent(event));
  canvas.onfocusout = () => clearTopologyTrace(canvas);
}

export function renderTopology() {
  const canvas = el.topologyCanvas;
  if (!canvas) return;
  const profiles = state.profiles ?? [];

  if (profiles.length === 0) {
    canvas.innerHTML = '<div class="empty-state">No RR profiles yet. Create one and the map will draw itself.</div>';
    return;
  }

  const NODE_H = 58;
  const DL_H = 54;
  const DL_GAP = 12;
  const BAND_GAP = 26;
  const PUTIO = { x: 24, w: 184 };
  const RR = { x: 280, w: 224 };
  const DP = { x: 630, w: 136, h: 30 };
  const DL = { x: 892, w: 256 };

  // RR profile bands, each tall enough for its own downloads (placed in the DL column).
  let cursor = 24;
  let hasDownloads = false;
  const putioKey = 'putio';
  const rrNodes = profiles.map((profile, profileIndex) => {
    const downloads = topologyDownloadsForProfile(profile);
    if (downloads.length) hasDownloads = true;
    const height = Math.max(NODE_H, downloads.length * (DL_H + DL_GAP) - DL_GAP);
    const top = cursor;
    cursor += height + BAND_GAP;
    const dpId = profile.download_profile_id ?? profile.downloadProfileId ?? defaultDownloadProfileId();
    const dpKey = String(dpId ?? 'default');
    const rrKey = topologyKey('rr', profile.id ?? profileIndex);
    const downloadNodes = downloads.map((download, downloadIndex) => {
      const downloadKey = topologyKey('download', download.id ?? `${profileIndex}-${downloadIndex}`);
      return {
        download,
        cy: top + downloadIndex * (DL_H + DL_GAP) + DL_H / 2,
        key: downloadKey,
        profileKey: topologyKey('download-profile', `${dpKey}-${downloadKey}`),
      };
    });
    return {
      profile,
      cy: top + height / 2,
      key: rrKey,
      dpName: downloadProfileDisplayName(dpId),
      downloadNodes,
    };
  });

  const rrBottom = cursor - BAND_GAP + 24;
  const totalHeight = Math.max(rrBottom, NODE_H + 48);
  const putioY = totalHeight / 2 - NODE_H / 2;
  const putioCy = putioY + NODE_H / 2;
  const putioRight = PUTIO.x + PUTIO.w;

  const edges = [];
  const nodes = [];
  const connected = Boolean(state.settings?.tokenConfigured);
  const rrRelations = (rr) => topologyRelations(
    putioKey,
    rr.key,
    rr.downloadNodes.flatMap((download) => [download.profileKey, download.key]),
  );
  const downloadRelations = (rr, download) => topologyRelations(
    putioKey,
    rr.key,
    download.profileKey,
    download.key,
  );
  const allRelations = topologyRelations(putioKey, rrNodes.map(rrRelations));

  for (const rr of rrNodes) {
    const related = rrRelations(rr);
    edges.push(topologyEdge(putioRight, putioCy, RR.x, rr.cy, connected ? '' : 'topo-edge--muted', related));
    for (const download of rr.downloadNodes) {
      const route = downloadRelations(rr, download);
      edges.push(topologyEdge(RR.x + RR.w, rr.cy, DP.x, download.cy, 'topo-edge--dprofile', route));
      edges.push(topologyEdge(
        DP.x + DP.w,
        download.cy,
        DL.x,
        download.cy,
        'topo-edge--download',
        route,
      ));
    }
  }

  const account = state.putioAccount?.username || (connected ? 'Put.io account' : 'Not connected');
  nodes.push(topologyNode(
    PUTIO.x, putioY, PUTIO.w, NODE_H,
    'Put.io', account, connected ? 'Connected' : 'No token configured',
    connected ? 'putio' : 'putio-off',
    putioKey, allRelations,
  ));

  for (const rr of rrNodes) {
    const profile = rr.profile;
    nodes.push(topologyNode(
      RR.x, rr.cy - NODE_H / 2, RR.w, NODE_H,
      profileType(profile.type).label, profileDisplayName(profile),
      profile.enabled === false ? 'Disabled' : 'Enabled',
      profile.enabled === false ? 'rr-off' : 'rr',
      rr.key, rrRelations(rr),
    ));
    for (const downloadNode of rr.downloadNodes) {
      const download = downloadNode.download;
      nodes.push(topologyNode(
        DL.x, downloadNode.cy - DL_H / 2, DL.w, DL_H,
        downloadTopologyEyebrow(download), download.name,
        `${clampPercent(download.combinedProgress)}% complete`,
        downloadTopologyVariant(download),
        downloadNode.key,
        downloadRelations(rr, downloadNode),
      ));
      nodes.push(topologyProfilePill(
        DP.x, downloadNode.cy, DP.w, DP.h,
        rr.dpName, downloadNode.profileKey, downloadRelations(rr, downloadNode),
      ));
    }
  }

  const width = (hasDownloads ? DL.x + DL.w : RR.x + RR.w) + 24;
  canvas.innerHTML = `<svg viewBox="0 0 ${width} ${totalHeight}" class="topo-svg" role="img" aria-label="Topology of put.io connection, RR profiles, download profiles and downloads">${edges.join('')}${nodes.join('')}</svg>`;
  traceTopologyKey(canvas, canvas.dataset.topologyTraceKey);
  bindTopologyTracing(canvas);
}
