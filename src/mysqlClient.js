import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

/**
 * 对 mysqldump / mysql 命令行客户端的封装（只在 CLONE_ENGINE=dump 时用到）。
 * 服务器上需要安装 MySQL 客户端，但不需要安装 MySQL 服务端。
 */

const tmpFiles = new Set();

/** 清理所有临时生成的配置文件 */
export function cleanupTmpFiles() {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* 已经删掉了就算了 */
    }
  }
  tmpFiles.clear();
}

function bin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return config.mysqlBinDir ? path.join(config.mysqlBinDir, exe) : exe;
}

function escapeValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * MySQL 客户端不能安全地通过命令行传密码（ps 能看到），
 * 所以生成一个临时的 defaults 文件，权限 600，用完即删。
 */
function makeDefaultsFile(conn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));
  const file = path.join(dir, 'client.cnf');
  const content = [
    '[client]',
    `host="${escapeValue(conn.host)}"`,
    `port=${conn.port}`,
    `user="${escapeValue(conn.user)}"`,
    `password="${escapeValue(conn.password)}"`,
    '',
    '[mysqldump]',
    'max_allowed_packet=512M',
    '',
    '[mysql]',
    'max_allowed_packet=512M',
    '',
  ].join('\n');
  fs.writeFileSync(file, content);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上不支持，忽略 */
  }
  tmpFiles.add(file);
  return file;
}

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `退出码 ${code}`))));
  });
}

function parseVersion(str) {
  const m = String(str).match(/Ver\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!m) return [0, 0, 0];
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function gte([a, b, c], [x, y, z]) {
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

let cachedFlavor = null;

/** 探测客户端：是 Oracle MySQL 还是 MariaDB，以及版本号 */
export async function detectClient() {
  if (cachedFlavor) return cachedFlavor;
  try {
    const { stdout } = await runCapture(bin('mysqldump'), ['--version']);
    const isMariaDB = /mariadb/i.test(stdout);
    const version = parseVersion(stdout);
    cachedFlavor = { available: true, isMariaDB, version, raw: stdout.trim() };
  } catch (err) {
    cachedFlavor = { available: false, error: err.message, isMariaDB: false, version: [0, 0, 0] };
  }
  return cachedFlavor;
}

/**
 * 组装兼容性参数：
 * - MariaDB 的 mysqldump 不认识 --set-gtid-purged / --column-statistics
 * - Oracle 8.0.22+ 的 mysqldump 默认开启 column-statistics，连 5.7 服务端会直接报错
 */
function compatArgs(client) {
  const args = [];
  if (client.isMariaDB) return args;
  args.push('--set-gtid-purged=OFF');
  if (client.available && gte(client.version, [8, 0, 22])) {
    args.push('--column-statistics=0');
  }
  return args;
}

/**
 * 导出源库到压缩文件。
 * sameName=true 时用 --databases + --add-drop-database（导出的 SQL 自带 DROP/CREATE DATABASE）
 */
export async function dumpToFile({ conn, databases, outFile, sameName, extraArgs = [] }) {
  const cnf = makeDefaultsFile(conn);
  const client = await detectClient();

  const args = [
    `--defaults-extra-file=${cnf}`,
    '--single-transaction', // InnoDB 一致性快照，不锁表
    '--quick', // 一行一行读，避免大表吃满内存
    '--skip-lock-tables',
    '--routines', // 存储过程/函数（默认不带，必须显式加）
    '--triggers',
    '--events',
    '--hex-blob', // 二进制字段用十六进制，避免乱码
    '--default-character-set=utf8mb4',
    '--no-tablespaces', // 避免要求 PROCESS 权限
    ...compatArgs(client),
    ...extraArgs,
  ];

  if (sameName) {
    args.push('--add-drop-database', '--databases', ...databases);
  } else {
    args.push('--no-create-db', ...databases);
  }

  const tmp = `${outFile}.tmp`;
  const child = spawn(bin('mysqldump'), args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  const closed = new Promise((resolve) => child.on('close', resolve));
  const piped = pipeline(child.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp)).catch((err) => err);

  const [code, pipeResult] = await Promise.all([closed, piped]);
  if (pipeResult instanceof Error && code === 0) throw pipeResult;
  if (code !== 0) {
    await fs.promises.rm(tmp, { force: true });
    throw new Error(`mysqldump 失败（退出码 ${code}）：${stderr.trim()}`);
  }

  fs.renameSync(tmp, outFile);
  return { file: outFile, bytes: fs.statSync(outFile).size };
}

/** 把压缩的 SQL 文件灌进目标库 */
export async function loadFromFile({ conn, file, database }) {
  const cnf = makeDefaultsFile(conn);
  const args = [`--defaults-extra-file=${cnf}`, '--default-character-set=utf8mb4'];
  if (database) args.push(`--database=${database}`);

  const child = spawn(bin('mysql'), args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  child.stdout.on('data', () => {});

  const closed = new Promise((resolve) => child.on('close', resolve));
  const piped = pipeline(fs.createReadStream(file), zlib.createGunzip(), child.stdin).catch((err) => err);

  const [code, pipeResult] = await Promise.all([closed, piped]);
  if (pipeResult instanceof Error && code === 0) throw pipeResult;
  if (code !== 0) throw new Error(`导入失败（mysql 退出码 ${code}）：${stderr.trim()}`);
}
