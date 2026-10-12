import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.js';

const LOG_DIR = path.resolve(ROOT_DIR, 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

function write(level, message, extra) {
  const time = timestamp();
  const line = `[${time}] [${level}] ${message}${
    extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))
  }`;

  const stream = level === 'ERROR' ? process.stderr : process.stdout;
  stream.write(line + '\n');

  try {
    ensureLogDir();
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line + '\n');
  } catch {
    // 写日志失败不能影响主流程
  }
}

export const logger = {
  info: (msg, extra) => write('INFO', msg, extra),
  warn: (msg, extra) => write('WARN', msg, extra),
  error: (msg, extra) => write('ERROR', msg, extra),
  step: (msg) => write('STEP', `===== ${msg} =====`),
};

/** 人类可读的耗时 */
export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}
