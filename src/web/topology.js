import { state, el } from './state.js';
import { escapeSvgText, truncateLabel, clampPercent } from './util.js';
import { PUTIO_PHASE_LABELS } from './constants.js';
import { profileType, profileDisplayName } from './profiles.js';
import { downloadProfileDisplayName, defaultDownloadProfileId } from './download-profiles.js';

// --- Topology map: put.io -> RR profiles -> download profiles + downloads ---
export function topologyDownloadsForProfile(profile) {
  const name = profileDisplayName(profile);
  return state.downloads.filter(
    (download) => download.profileName === name || download.profileName === profile.name,
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

export function topologyNode(x, y, w, h, eyebrow, title, sub, variant) {
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
  return `<g>
    <clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11"></rect></clipPath>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="11" class="topo-node topo-node--${variant}"></rect>
    <g clip-path="url(#${clipId})">
      <text x="${x + 14}" y="${y + 19}" class="topo-eyebrow">${escapeSvgText(truncateLabel(eyebrow, smallCap))}</text>
      <text x="${x + 14}" y="${y + 35}" class="topo-node-title">${escapeSvgText(truncateLabel(title, titleCap))}</text>
      ${subText}
    </g>
  </g>`;
}

export function topologyEdge(x1, y1, x2, y2, cls = '') {
  const dx = Math.max(28, (x2 - x1) * 0.5);
  return `<path d="M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" class="topo-edge ${cls}"></path>`;
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
  const DP_GAP = 16;
  const PUTIO = { x: 24, w: 184 };
  const RR = { x: 280, w: 224 };
  const DP = { x: 572, w: 248 };
  const DL = { x: 892, w: 256 };

  // RR profile bands, each tall enough for its own downloads (placed in the DL column).
  let cursor = 24;
  let hasDownloads = false;
  const rrNodes = profiles.map((profile) => {
    const downloads = topologyDownloadsForProfile(profile);
    if (downloads.length) hasDownloads = true;
    const height = Math.max(NODE_H, downloads.length * (DL_H + DL_GAP) - DL_GAP);
    const top = cursor;
    cursor += height + BAND_GAP;
    const dpId = profile.download_profile_id ?? profile.downloadProfileId ?? defaultDownloadProfileId();
    return { profile, downloads, top, cy: top + height / 2, dpKey: String(dpId ?? ''), dpName: downloadProfileDisplayName(dpId) };
  });

  // One node per unique download profile, vertically centred on the profiles using it.
  const dpMap = new Map();
  for (const rr of rrNodes) {
    if (!dpMap.has(rr.dpKey)) dpMap.set(rr.dpKey, { key: rr.dpKey, name: rr.dpName, users: [] });
    dpMap.get(rr.dpKey).users.push(rr);
  }
  const dpNodes = [...dpMap.values()].map((dp) => ({
    ...dp,
    cy: dp.users.reduce((sum, user) => sum + user.cy, 0) / dp.users.length,
  }));
  dpNodes.sort((a, b) => a.cy - b.cy);
  let prevBottom = -Infinity;
  for (const dp of dpNodes) {
    const top = Math.max(dp.cy - NODE_H / 2, prevBottom + DP_GAP);
    dp.top = top;
    dp.cy = top + NODE_H / 2;
    prevBottom = top + NODE_H;
  }

  const rrBottom = cursor - BAND_GAP + 24;
  const dpBottom = dpNodes.length ? dpNodes[dpNodes.length - 1].top + NODE_H + 24 : 0;
  const totalHeight = Math.max(rrBottom, dpBottom, NODE_H + 48);
  const putioY = totalHeight / 2 - NODE_H / 2;
  const putioCy = putioY + NODE_H / 2;
  const putioRight = PUTIO.x + PUTIO.w;

  const edges = [];
  const nodes = [];
  const connected = Boolean(state.settings?.tokenConfigured);

  for (const rr of rrNodes) {
    edges.push(topologyEdge(putioRight, putioCy, RR.x, rr.cy, connected ? '' : 'topo-edge--muted'));
    const dp = dpNodes.find((node) => node.key === rr.dpKey);
    if (dp) edges.push(topologyEdge(RR.x + RR.w, rr.cy, DP.x, dp.cy, 'topo-edge--dprofile'));
    let dy = rr.top;
    for (const download of rr.downloads) {
      edges.push(topologyEdge(RR.x + RR.w, rr.cy, DL.x, dy + DL_H / 2, 'topo-edge--download'));
      dy += DL_H + DL_GAP;
    }
  }

  const account = state.putioAccount?.username || (connected ? 'Put.io account' : 'Not connected');
  nodes.push(topologyNode(
    PUTIO.x, putioY, PUTIO.w, NODE_H,
    'Put.io', account, connected ? 'Connected' : 'No token configured',
    connected ? 'putio' : 'putio-off',
  ));

  for (const rr of rrNodes) {
    const profile = rr.profile;
    nodes.push(topologyNode(
      RR.x, rr.cy - NODE_H / 2, RR.w, NODE_H,
      profileType(profile.type).label, profileDisplayName(profile),
      profile.enabled === false ? 'Disabled' : 'Enabled',
      profile.enabled === false ? 'rr-off' : 'rr',
    ));
    let dy = rr.top;
    for (const download of rr.downloads) {
      nodes.push(topologyNode(
        DL.x, dy, DL.w, DL_H,
        downloadTopologyEyebrow(download), download.name,
        `${clampPercent(download.combinedProgress)}% complete`,
        downloadTopologyVariant(download),
      ));
      dy += DL_H + DL_GAP;
    }
  }

  for (const dp of dpNodes) {
    const count = dp.users.length;
    nodes.push(topologyNode(
      DP.x, dp.top, DP.w, NODE_H,
      'Download profile', dp.name,
      count === 1 ? 'Used by 1 RR profile' : `Used by ${count} RR profiles`,
      'dprofile',
    ));
  }

  const width = (hasDownloads ? DL.x + DL.w : DP.x + DP.w) + 24;
  canvas.innerHTML = `<svg viewBox="0 0 ${width} ${totalHeight}" class="topo-svg" role="img" aria-label="Topology of put.io connection, RR profiles, download profiles and downloads">${edges.join('')}${nodes.join('')}</svg>`;
}
