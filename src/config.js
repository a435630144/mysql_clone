import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export const ROOT_DIR = path.resolve(process.cwd());

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

export const config = {
  // sync   = 增量同步（推荐，只同步有变化的行）
  // stream = 全量覆盖（每次推倒重来）
  // dump   = 用 mysqldump / mysql 客户端全量覆盖
  engine: (process.env.CLONE_ENGINE || 'sync').toLowerCase(),

  source: {
    host: process.env.SOURCE_HOST || '',
    port: int(process.env.SOURCE_PORT, 3306),
    user: process.env.SOURCE_USER || '',
    password: process.env.SOURCE_PASSWORD || '',
    database: process.env.SOURCE_DATABASE || '',
  },

  target: {
    host: process.env.TARGET_HOST || '',
    port: int(process.env.TARGET_PORT, 3306),
    user: process.env.TARGET_USER || '',
    password: process.env.TARGET_PASSWORD || '',
    // 留空则与源库同名
    database: process.env.TARGET_DATABASE || process.env.SOURCE_DATABASE || '',
  },

  // 破坏性操作开关
  allowOverwrite: bool(process.env.ALLOW_OVERWRITE, false),

  dumpDir: path.resolve(ROOT_DIR, process.env.DUMP_DIR || './dumps'),
  keepDumps: int(process.env.KEEP_DUMPS, 7),
  dumpExtraOptions: (process.env.DUMP_EXTRA_OPTIONS || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean),
  mysqlBinDir: process.env.MYSQL_BIN_DIR || '',

  // 增量同步时，是否清理目标库里源库已经没有的东西
  dropExtraTables: bool(process.env.SYNC_DROP_EXTRA_TABLES, true),
  dropExtraColumns: bool(process.env.SYNC_DROP_EXTRA_COLUMNS, true),
  dropExtraRows: bool(process.env.SYNC_DROP_EXTRA_ROWS, true),

  // 邮件告警（只在程序解决不了的问题上发）
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  },
  mailTo: process.env.MAIL_TO || '',
  mailOnSuccess: bool(process.env.MAIL_ON_SUCCESS, false),

  // 只复制/排除哪些表（逗号分隔），留空表示全部
  tablesInclude: (process.env.TABLES_INCLUDE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  tablesExclude: (process.env.TABLES_EXCLUDE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  verifyMode: (process.env.VERIFY_MODE || 'count').toLowerCase(),

  notifyWebhook: process.env.NOTIFY_WEBHOOK || '',

  lockTimeoutHours: int(process.env.LOCK_TIMEOUT_HOURS, 6),
};

/** 校验必填项，返回错误信息数组（空数组代表通过） */
export function validateConfig() {
  const errors = [];
  const need = (cond, msg) => {
    if (!cond) errors.push(msg);
  };

  need(
    ['dump', 'stream', 'sync'].includes(config.engine),
    `CLONE_ENGINE 只能是 sync / stream / dump，当前是 ${config.engine}`,
  );

  for (const side of ['source', 'target']) {
    const c = config[side];
    need(!!c.host, `${side}.host 未配置`);
    need(!!c.user, `${side}.user 未配置`);
    need(!!c.password, `${side}.password 未配置`);
  }
  need(!!config.source.database, 'SOURCE_DATABASE 未配置');
  need(!!config.target.database, 'TARGET_DATABASE 未配置');

  if (!config.allowOverwrite) {
    errors.push('ALLOW_OVERWRITE 未设为 true。克隆会覆盖目标库的表，确认无误后请在 .env 中显式开启。');
  }

  need(
    ['count', 'estimate', 'off'].includes(config.verifyMode),
    `VERIFY_MODE 只能是 count / estimate / off，当前是 ${config.verifyMode}`,
  );

  return errors;
}

/** 确保导出目录存在 */
export function ensureDumpDir() {
  fs.mkdirSync(config.dumpDir, { recursive: true });
}
