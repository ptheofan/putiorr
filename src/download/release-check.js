// Issue #111. Decides whether a put.io transfer that finished remotely is worth
// downloading at all. Pure: it is handed the file list put.io already returned
// in prepareTransfer() and answers before a single byte crosses the wire.
//
// The rule is NEGATIVE — reject only when nothing here could be imported by the
// app that asked for it — rather than positive ("must contain a video file").
// A positive rule would trash VIDEO_TS/BDMV rips and every legitimate Lidarr or
// Readarr download. Getting this wrong is not symmetric: a wrongly blocklisted
// release is invisible and permanent, while a missed bad one costs the one
// manual click that already happens today, so every ambiguity resolves toward
// downloading.
//
// "Could be imported" is per preset, because it genuinely differs: a rar'd
// release is a normal delivery to a Lidarr and dead weight to a Sonarr, which
// cannot unpack it.

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|m2ts|mov|wmv|mpg|mpeg|webm|vob|iso|img|flv|ogm|divx|rmvb)$/i;
const AUDIO = /\.(flac|mp3|m4a|m4b|ogg|opus|wav|aac|ape|wma|alac|dsf|dff|mka)$/i;
const BOOK = /\.(epub|mobi|azw|azw3|pdf|cbz|cbr|djvu|fb2)$/i;
// Every multipart naming scheme in the wild.
const ARCHIVE = [
  /\.(rar|zip|7z|tar|gz|bz2|xz|tgz)$/i,
  /\.r\d{2}$/i,
  /\.\d{3}$/,
];

// What each preset can actually import.
//
// Sonarr and Radarr do NOT extract archives from a torrent download — that is a
// usenet client's job, and for torrents it needs an external unpacker. A rar'd
// release handed to either of them is precisely what produces "no files found
// are eligible for import", so it is junk by the same standard as a folder of
// .exe and is rejected here.
//
// A preset with no entry is checked against everything, archives included. That
// permissive fallback is the safe direction: a preset nobody has written a rule
// for must not start rejecting every release.
const IMPORTABLE_BY_PRESET = {
  sonarr: [VIDEO],
  radarr: [VIDEO],
};

const IMPORTABLE_ANY = [VIDEO, ...ARCHIVE, AUDIO, BOOK];

const ANY_ARCHIVE = (relativePath) => ARCHIVE.some((pattern) => pattern.test(relativePath));

// A disc rip's payload is inside these directories, and the files themselves
// (.BUP, .IFO, .CLPI) would not otherwise read as importable.
const DISC_STRUCTURE = /(^|\/)(VIDEO_TS|BDMV|AUDIO_TS)(\/|$)/i;

function importablePatterns(preset) {
  return IMPORTABLE_BY_PRESET[String(preset ?? '').trim().toLowerCase()] ?? IMPORTABLE_ANY;
}

// The blocklist reason is read by a human in the *arr, so it names the app that
// could not import the release rather than saying "importable" and leaving them
// to work out for what.
function presetLabel(preset) {
  const value = String(preset ?? '').trim().toLowerCase();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'this app';
}

// ponytail: put.io's `size` on a transfer it only partially satisfied is not
// verified to be the full announced torrent size — if it turns out to report
// delivered bytes instead, this check is a no-op rather than a false positive,
// which is the safe direction to be wrong in. Half is far below any plausible
// legitimate shortfall, so it only fires on unambiguous junk.
export const SHORT_DELIVERY_RATIO = 0.5;

function isImportable(relativePath, patterns) {
  if (DISC_STRUCTURE.test(relativePath)) return true;
  return patterns.some((pattern) => pattern.test(relativePath));
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes ?? 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * @param {object} input
 * @param {Array<{relativePath?: string, name?: string, size?: number}>} input.files
 *   What put.io lists for the transfer.
 * @param {number} [input.announcedSize] The torrent's own size, as put.io reported
 *   it on the transfer. 0 or missing skips the short-delivery check.
 * @param {number} [input.minSize] Per-profile floor in bytes. 0 disables it.
 * @param {string} [input.preset] The owning profile's app preset, which decides
 *   what counts as importable. An unknown preset is checked against everything.
 * @returns {{reject: boolean, reason: string}} reason is empty when reject is false.
 *   It is written to be read by a human in the *arr's blocklist and in the log.
 */
export function inspectRelease({
  files = [], announcedSize = 0, minSize = 0, preset = '',
} = {}) {
  const paths = files.map((file) => String(file?.relativePath ?? file?.name ?? ''));
  const deliveredSize = files.reduce((total, file) => total + Number(file?.size ?? 0), 0);

  if (paths.length === 0) {
    return { reject: true, reason: 'put.io finished this transfer with no files in it' };
  }

  const announced = Number(announcedSize ?? 0);
  if (announced > 0 && deliveredSize < announced * SHORT_DELIVERY_RATIO) {
    return {
      reject: true,
      reason: `put.io delivered ${formatBytes(deliveredSize)} of the ${formatBytes(announced)} this torrent announced`,
    };
  }

  const floor = Number(minSize ?? 0);
  if (floor > 0 && deliveredSize < floor) {
    return {
      reject: true,
      reason: `release is ${formatBytes(deliveredSize)}, below this profile's ${formatBytes(floor)} minimum`,
    };
  }

  const patterns = importablePatterns(preset);
  if (!paths.some((relativePath) => isImportable(relativePath, patterns))) {
    // Worth naming, because "nothing importable" reads like putiorr is broken
    // when the folder plainly holds the release. It holds it in a form this app
    // cannot open, and the fix is a tool putiorr is not.
    const archivesOnly = paths.some(ANY_ARCHIVE);
    return {
      reject: true,
      reason: archivesOnly
        ? `${presetLabel(preset)} cannot extract archives, and this release is packed: ${paths.slice(0, 3).join(', ')}`
        : `nothing ${presetLabel(preset)} can import in ${paths.length} file(s): ${paths.slice(0, 3).join(', ')}`,
    };
  }

  return { reject: false, reason: '' };
}
