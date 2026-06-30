const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

type LogLevel = keyof typeof levels;
type LogMeta = Record<string, string | number | boolean | null | undefined | object>;

const configuredLevel = (process.env.PUTIORR_LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
const currentLevel = levels[configuredLevel] ?? levels.info;

function write(level: LogLevel, message: string, meta?: LogMeta): void {
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
  debug: (message: string, meta?: LogMeta) => write('debug', message, meta),
  info: (message: string, meta?: LogMeta) => write('info', message, meta),
  warn: (message: string, meta?: LogMeta) => write('warn', message, meta),
  error: (message: string, meta?: LogMeta) => write('error', message, meta),
};
