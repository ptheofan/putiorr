// Issue #111. Decides whether a put.io transfer that finished remotely is worth
// downloading at all. Pure: it is handed the file list put.io already returned
// in prepareTransfer() and answers before a single byte crosses the wire.
//
// The rule is deliberately NEGATIVE — reject only when nothing here could
// possibly be imported — rather than positive ("must contain a video file").
// A positive rule trashes rar'd scene releases, VIDEO_TS/BDMV rips, and every
// legitimate Lidarr or Readarr download. Getting this wrong is not symmetric:
// a wrongly blocklisted release is invisible and permanent, while a missed bad
// one costs the one manual click that already happens today.

// Anything an *arr can import, directly or after its own unpack step. Kept
// broad on purpose: a extension missing from this list is a false rejection.
const IMPORTABLE = [
  // video
  /\.(mkv|mp4|avi|m4v|ts|m2ts|mov|wmv|mpg|mpeg|webm|vob|iso|img|flv|ogm|divx|rmvb)$/i,
  // archives, including every multipart naming scheme in the wild
  /\.(rar|zip|7z|tar|gz|bz2|xz|tgz)$/i,
  /\.r\d{2}$/i,
  /\.\d{3}$/,
  // audio (lidarr)
  /\.(flac|mp3|m4a|m4b|ogg|opus|wav|aac|ape|wma|alac|dsf|dff|mka)$/i,
  // books (readarr)
  /\.(epub|mobi|azw|azw3|pdf|cbz|cbr|djvu|fb2)$/i,
];

// A disc rip's payload is inside these directories, and the files themselves
// (.BUP, .IFO, .CLPI) would not otherwise read as importable.
const DISC_STRUCTURE = /(^|\/)(VIDEO_TS|BDMV|AUDIO_TS)(\/|$)/i;

// ponytail: put.io's `size` on a transfer it only partially satisfied is not
// verified to be the full announced torrent size — if it turns out to report
// delivered bytes instead, this check is a no-op rather than a false positive,
// which is the safe direction to be wrong in. Half is far below any plausible
// legitimate shortfall, so it only fires on unambiguous junk.
export const SHORT_DELIVERY_RATIO = 0.5;

function isImportable(relativePath) {
  if (DISC_STRUCTURE.test(relativePath)) return true;
  return IMPORTABLE.some((pattern) => pattern.test(relativePath));
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
 * @returns {{reject: boolean, reason: string}} reason is empty when reject is false.
 *   It is written to be read by a human in the *arr's blocklist and in the log.
 */
export function inspectRelease({ files = [], announcedSize = 0, minSize = 0 } = {}) {
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

  if (!paths.some(isImportable)) {
    return {
      reject: true,
      reason: `no importable file in ${paths.length} file(s): ${paths.slice(0, 3).join(', ')}`,
    };
  }

  return { reject: false, reason: '' };
}
