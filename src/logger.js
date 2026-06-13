const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel = levels[(process.env.PUTIORR_LOG_LEVEL ?? 'info').toLowerCase()] ?? levels.info;

function write(level, message, meta) {
  if (levels[level] < currentLevel) return;
  const payload = {
    level,
    time: new Date().toISOString(),
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
