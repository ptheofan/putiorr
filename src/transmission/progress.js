export const TRANSMISSION_STATUS = {
  stopped: 0,
  checkWait: 1,
  check: 2,
  downloadWait: 3,
  download: 4,
  seedWait: 5,
  seed: 6,
};

export function mapPutioStatus(status) {
  switch (status) {
    case 'IN_QUEUE':
    case 'WAITING':
    case 'PREPARING':
      return TRANSMISSION_STATUS.downloadWait;
    case 'DOWNLOADING':
    case 'COMPLETING':
      return TRANSMISSION_STATUS.download;
    case 'COMPLETED':
    case 'SEEDING':
      return TRANSMISSION_STATUS.seed;
    case 'ERROR':
      return TRANSMISSION_STATUS.stopped;
    default:
      return TRANSMISSION_STATUS.stopped;
  }
}

export function calculateTransmissionProgress(transfer, fileStats) {
  const remotePercent = clampPercent(transfer.percent_done ?? 0);
  const remoteProgress = remotePercent / 200;
  const transferSize = Number(transfer.total_size ?? 0);

  const totalSize = Number(fileStats?.total_size ?? 0);
  const downloadedSize = Number(fileStats?.downloaded_size ?? 0);
  const totalFiles = Number(fileStats?.total_files ?? 0);
  const completedFiles = Number(fileStats?.completed_files ?? 0);
  const reportableSize = totalSize > 0 ? totalSize : transferSize;

  if (transfer.lifecycle === 'processed') {
    return {
      percentDone: 1,
      leftUntilDone: 0,
      status: TRANSMISSION_STATUS.seed,
    };
  }

  if (totalFiles > 0) {
    const localProgress = totalSize > 0
      ? (downloadedSize / totalSize) * 0.5
      : (completedFiles / totalFiles) * 0.5;
    const percentDone = clampUnit(remoteProgress + localProgress);
    return {
      percentDone,
      leftUntilDone: remainingFromProgress(reportableSize, percentDone),
      status: transfer.lifecycle === 'downloading'
        ? TRANSMISSION_STATUS.download
        : mapPutioStatus(transfer.putio_status),
    };
  }

  if (transfer.putio_status === 'COMPLETED' || transfer.putio_status === 'SEEDING') {
    const percentDone = transfer.lifecycle === 'remote' ? 0.5 : 1;
    return {
      percentDone,
      leftUntilDone: remainingFromProgress(reportableSize, percentDone),
      status: transfer.lifecycle === 'remote'
        ? TRANSMISSION_STATUS.download
        : TRANSMISSION_STATUS.seed,
    };
  }

  const percentDone = remoteProgress;
  return {
    percentDone,
    leftUntilDone: remainingFromProgress(reportableSize, percentDone),
    status: mapPutioStatus(transfer.putio_status),
  };
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function remainingFromProgress(size, percentDone) {
  return Math.max(0, Math.round(Number(size ?? 0) * (1 - clampUnit(percentDone))));
}
