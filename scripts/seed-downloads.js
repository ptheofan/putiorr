// Dev helper: insert (or clear) sample downloads so the dashboard, downloads view
// and topology map have data to show without a live put.io transfer.
//
//   node scripts/seed-downloads.js          # insert/refresh the samples
//   node scripts/seed-downloads.js --clear   # remove only the seeded samples
//
// Samples are attached to the first two RR profiles (or whatever exists) and are
// tagged with a `seed-` hash prefix so --clear can find and remove just them.

import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function buildSamples(profiles) {
  const first = profiles[0];
  const second = profiles[1] ?? profiles[0];

  return [
    {
      profile: first,
      hash: 'seed-downloading-001',
      putio_transfer_id: 920001,
      name: 'Severance.S02E05.2160p.WEB.H265-NHTFS',
      lifecycle: 'remote',
      putio_status: 'DOWNLOADING',
      percent_done: 42,
      total_size: 6 * GB,
      download_speed: 18 * MB,
      eta: 240,
      files: [],
    },
    {
      profile: first,
      hash: 'seed-completing-002',
      putio_transfer_id: 920002,
      name: 'The.Bear.S03.COMPLETE.1080p.WEB-DL',
      lifecycle: 'remote',
      putio_status: 'COMPLETING',
      percent_done: 100,
      completion_percent: 73,
      total_size: 12 * GB,
      eta: -1,
      files: [],
    },
    {
      profile: second,
      hash: 'seed-ready-003',
      putio_transfer_id: 920003,
      name: 'Dune.Part.Two.2024.2160p.UHD.BluRay.Remux',
      lifecycle: 'remote',
      putio_status: 'SEEDING',
      percent_done: 100,
      total_size: 78 * GB,
      eta: -1,
      files: [],
    },
    {
      profile: second,
      hash: 'seed-local-004',
      putio_transfer_id: 920004,
      name: 'Oppenheimer.2023.1080p.BluRay.x264',
      lifecycle: 'local',
      putio_status: 'COMPLETED',
      percent_done: 100,
      total_size: 16 * GB,
      download_speed: 24 * MB,
      eta: 90,
      files: [
        { putio_file_id: 9300401, relative_path: 'Oppenheimer.2023.1080p.mkv', size: 15.6 * GB, downloaded_bytes: 9 * GB, download_speed: 24 * MB, status: 'downloading' },
        { putio_file_id: 9300402, relative_path: 'Oppenheimer.2023.1080p.en.srt', size: 92 * 1024, downloaded_bytes: 92 * 1024, status: 'complete' },
        { putio_file_id: 9300403, relative_path: 'poster.jpg', size: 1.2 * MB, downloaded_bytes: 1.2 * MB, status: 'complete' },
      ],
    },
  ];
}

function seedHashes() {
  // Stable list so --clear works even without re-deriving from profiles.
  return ['seed-downloading-001', 'seed-completing-002', 'seed-ready-003', 'seed-local-004'];
}

function clearSamples(store) {
  let removed = 0;
  for (const hash of seedHashes()) {
    const existing = store.findTransferByHash(hash);
    if (existing) {
      store.deleteTransfer(existing.id); // transfer_files cascade away
      removed += 1;
    }
  }
  return removed;
}

function insertSamples(store, profiles) {
  const samples = buildSamples(profiles);
  for (const sample of samples) {
    const profile = sample.profile;
    const transfer = store.createOrUpdateTransfer({
      profile_id: profile?.id ?? null,
      putio_transfer_id: sample.putio_transfer_id,
      hash: sample.hash,
      name: sample.name,
      source_type: 'magnet',
      category: profile?.slug ?? '',
      download_dir: profile?.download_at ?? '',
      lifecycle: sample.lifecycle,
      putio_status: sample.putio_status,
      percent_done: sample.percent_done ?? 0,
      completion_percent: sample.completion_percent ?? 0,
      total_size: Math.round(sample.total_size ?? 0),
      downloaded_ever: Math.round((sample.total_size ?? 0) * ((sample.percent_done ?? 0) / 100)),
      download_speed: Math.round(sample.download_speed ?? 0),
      eta: sample.eta ?? -1,
    });

    // Replace this transfer's files with the sample set.
    for (const file of store.listFilesForTransfer(transfer.id)) store.deleteTransferFile(file.id);
    for (const file of sample.files ?? []) {
      store.upsertTransferFile({
        transfer_id: transfer.id,
        putio_file_id: file.putio_file_id,
        relative_path: file.relative_path,
        size: Math.round(file.size ?? 0),
        downloaded_bytes: Math.round(file.downloaded_bytes ?? 0),
        download_speed: Math.round(file.download_speed ?? 0),
        status: file.status ?? 'pending',
      });
    }
  }
  return samples.length;
}

function main() {
  const clear = process.argv.includes('--clear');
  const config = loadConfig();
  const store = new StateStore(config.statePath);
  try {
    if (clear) {
      const removed = clearSamples(store);
      console.log(`Removed ${removed} seeded download(s) from ${config.statePath}.`);
      return;
    }

    const profiles = store.listProfiles();
    if (profiles.length === 0) {
      console.error('No RR profiles found. Create at least one profile before seeding downloads.');
      process.exitCode = 1;
      return;
    }

    // Refresh: clear any previous seeds first so re-running stays idempotent.
    clearSamples(store);
    const count = insertSamples(store, profiles);
    console.log(`Seeded ${count} sample download(s) into ${config.statePath}.`);
    console.log('Reload the dashboard (or wait for the next refresh) to see them.');
  } finally {
    store.close();
  }
}

main();
