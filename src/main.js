import { loadConfig, ensureRuntimeDirs } from './config.js';
import { logger } from './logger.js';
import { DownloadManager } from './download/manager.js';
import { StateStore } from './state/store.js';
import { TransferService } from './transfer/service.js';
import { TransmissionRpcServer } from './transmission/server.js';

async function main() {
  const config = loadConfig();
  ensureRuntimeDirs(config);

  const store = new StateStore(config.statePath);
  store.seedFromConfig(config);

  const service = new TransferService({
    config,
    store,
  });

  const downloadManager = new DownloadManager({
    config,
    store,
    service,
  });

  const server = new TransmissionRpcServer({
    config,
    service,
  });

  await downloadManager.start();
  await server.start();

  logger.info('putiorr started', {
    endpoint: `http://${config.listenHost}:${config.listenPort}/transmission/rpc`,
    targetDir: config.targetDir,
    statePath: config.statePath,
    profiles: store.listProfiles({ includeDisabled: true }).length,
    putioConnected: Boolean(service.getPutioToken()),
  });

  const shutdown = async (signal) => {
    logger.info('shutdown requested', { signal });
    await server.stop();
    await downloadManager.stop();
    store.close();
  };

  process.once('SIGINT', () => {
    shutdown('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM').finally(() => process.exit(0));
  });
}

main().catch((error) => {
  logger.error('fatal startup error', { error: error.message, stack: error.stack });
  process.exit(1);
});
