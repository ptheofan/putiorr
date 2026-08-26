import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRelease } from '../src/download/release-check.js';

const MB = 1024 * 1024;

function file(relativePath, size = 700 * MB) {
  return { relativePath, size };
}

test('accepts an ordinary video release', () => {
  const verdict = inspectRelease({ files: [file('Show.S01E01.mkv')] });
  assert.equal(verdict.reject, false);
  assert.equal(verdict.reason, '');
});

// The whole reason the rule is negative rather than positive. Each of these has
// no video extension anywhere and every one of them is legitimate.
test('accepts releases with no video extension that an *arr can still import', () => {
  const legitimate = [
    ['rar\'d scene release', [file('release.rar'), file('release.r00'), file('release.r01')]],
    ['multipart numeric split', [file('release.001'), file('release.002')]],
    ['DVD rip structure', [file('Movie/VIDEO_TS/VTS_01_1.VOB'), file('Movie/VIDEO_TS/VIDEO_TS.IFO')]],
    ['Blu-ray structure', [file('Movie/BDMV/STREAM/00000.m2ts')]],
    ['lidarr album', [file('01 - Track.flac'), file('02 - Track.flac')]],
    ['readarr book', [file('Author - Title.epub')]],
  ];
  for (const [label, files] of legitimate) {
    assert.equal(inspectRelease({ files }).reject, false, `${label} must not be rejected`);
  }
});

test('rejects a release with nothing importable in it', () => {
  const verdict = inspectRelease({
    files: [file('Download me.txt', 2048), file('setup.exe', 4 * MB), file('release.nfo', 900)],
  });
  assert.equal(verdict.reject, true);
  assert.match(verdict.reason, /no importable file/);
});

test('rejects a transfer put.io finished with no files', () => {
  const verdict = inspectRelease({ files: [] });
  assert.equal(verdict.reject, true);
  assert.match(verdict.reason, /no files/);
});

test('rejects a release put.io delivered far short of what the torrent announced', () => {
  const verdict = inspectRelease({
    files: [file('Movie.mkv', 40 * MB)],
    announcedSize: 4200 * MB,
  });
  assert.equal(verdict.reject, true);
  assert.match(verdict.reason, /40 MB of the 4\.1 GB/);
});

test('a shortfall inside the ratio is not a rejection', () => {
  const verdict = inspectRelease({
    files: [file('Movie.mkv', 900 * MB)],
    announcedSize: 1000 * MB,
  });
  assert.equal(verdict.reject, false);
});

test('an unknown announced size disables the short-delivery check', () => {
  const verdict = inspectRelease({ files: [file('Movie.mkv', 1)], announcedSize: 0 });
  assert.equal(verdict.reject, false);
});

test('the size floor rejects below it and accepts at it', () => {
  const files = [file('Episode.mkv', 200 * MB)];
  assert.equal(inspectRelease({ files, minSize: 300 * MB }).reject, true);
  assert.equal(inspectRelease({ files, minSize: 200 * MB }).reject, false);
});

// The default has to be off, or upgrading silently blocklists every SD episode
// and 720p anime release in a library.
test('the size floor is off by default', () => {
  const verdict = inspectRelease({ files: [file('Episode.mkv', 1)] });
  assert.equal(verdict.reject, false);
});
