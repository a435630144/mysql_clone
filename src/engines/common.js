import mysqlCb from 'mysql2';
import { logger } from '../logger.js';
import { ident } from '../db.js';

/**
 * 两个引擎（全量 stream / 增量 sync）共用的底层工具。
 * 全部基于 mysql2 驱动，不依赖服务器上的 MySQL 客户端。
 */

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function connOptions(conn, database) {
  return {
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database,
    charset: 'utf8mb4',
    connectTimeout: 20000,
  };
}

/** 建立底层（callback 风格）连接，这样才能用 .stream() 做流式读取 */
export function rawConnect(conn, database) {
  return new Promise((resolve, reject) => {
    const c = mysqlCb.createConnection(connOptions(conn, database));
    c.connect((err) => (err ? reject(err) : resolve(c)));
  });
}

/** 把 callback 风格的 query 包装成 Promise */
export function q(connection, sql, params) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

export function closeConnection(c) {
  return new Promise((resolve) => {
    try {
      c.end(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** 网络抖动时重试几次 */
export async function withRetry(fn, { times = 3, label = '操作' } = {}) {
  let lastErr;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < times) {
        logger.warn(`${label} 第 ${i} 次失败（${err.message}），1.5 秒后重试`);
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  }
  throw lastErr;
}

export async function listTables(connection, type) {
  const rows = await q(connection, `SHOW FULL TABLES WHERE Table_type = ?`, [type]);
  // 列名是 `Tables_in_<库名>`，取每行第一个值即可
  return rows.map((r) => Object.values(r)[0]);
}

/** 单列主键返回列名；多列主键或无主键返回 null */
export async function getSinglePrimaryKey(connection, schema, table) {
  const rows = await q(
    connection,
    `SELECT column_name FROM information_schema.key_column_usage
     WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'
     ORDER BY ordinal_position`,
    [schema, table],
  );
  const cols = rows.map((r) => r.column_name ?? r.COLUMN_NAME);
  return cols.length === 1 ? cols[0] : null;
}

export async function getColumns(connection, schema, table) {
  const rows = await q(
    connection,
    `SELECT column_name, column_type, is_nullable, column_default, extra, data_type
     FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
    [schema, table],
  );
  return rows.map((r) => ({
    name: r.column_name ?? r.COLUMN_NAME,
    type: r.column_type ?? r.COLUMN_TYPE,
    nullable: (r.is_nullable ?? r.IS_NULLABLE) === 'YES',
    default: r.column_default ?? r.COLUMN_DEFAULT,
    extra: (r.extra ?? r.EXTRA) || '',
    dataType: r.data_type ?? r.DATA_TYPE,
  }));
}

/** 生成列（虚拟列/存储列） */
export function isGeneratedColumn(col) {
  return /GENERATED|VIRTUAL|STORED/i.test(col.extra || '');
}

// 8.0 新增的排序规则在 5.6 上不存在，按语义降级映射
const COLLATION_FALLBACK = {
  utf8mb4_0900_ai_ci: 'utf8mb4_general_ci',
  utf8mb4_0900_as_ci: 'utf8mb4_general_ci',
  utf8mb4_0900_as_cs: 'utf8mb4_bin',
  utf8mb4_0900_bin: 'utf8mb4_bin',
  utf8mb4_unicode_520_ci: 'utf8mb4_unicode_ci',
};

// 各版本引入的特性门槛（用于自适应判断，不写死任何一种组合）
function gte(major, minor, patch, [a, b, c]) {
  if (major !== a) return major > a;
  if (minor !== b) return minor > b;
  return patch >= c;
}

/**
 * 探测目标库能力：版本、排序规则、生成列、JSON 等。
 * 同时兼容 MySQL 与 MariaDB（MariaDB 的 VERSION() 里带 -MariaDB 后缀）。
 */
export async function inspectTarget(dst) {
  const versionRows = await q(dst, 'SELECT VERSION() AS v');
  const version = versionRows[0]?.v || '';
  const isMariaDB = /mariadb/i.test(version);
  const [major = 5, minor = 6, patch = 0] = version.split('-')[0].split('.').map((n) => Number(n) || 0);

  // 生成列：MySQL 5.7.6+ / MariaDB 5.2+（这里保守按 MySQL 口径判断）
  const supportsGenerated = isMariaDB ? true : gte(major, minor, patch, [5, 7, 6]);
  // JSON 类型：MySQL 5.7.8+ / MariaDB 10.2+
  const supportsJson = isMariaDB ? gte(major, minor, patch, [10, 2, 0]) : gte(major, minor, patch, [5, 7, 8]);

  const collRows = await q(dst, 'SELECT COLLATION_NAME AS c FROM information_schema.collations');
  const collations = new Set(collRows.map((r) => String(r.c).toLowerCase()));

  logger.info(
    `目标库 ${version}（${isMariaDB ? 'MariaDB' : 'MySQL'}），` +
      `生成列: ${supportsGenerated}，JSON: ${supportsJson}，排序规则 ${collations.size} 种`,
  );

  return { version, major, minor, patch, isMariaDB, supportsGenerated, supportsJson, collations };
}

export function mapCollation(name, target) {
  const lower = String(name).toLowerCase();
  if (target.collations.has(lower)) return lower;
  const mapped = COLLATION_FALLBACK[lower];
  if (mapped && target.collations.has(mapped)) return mapped;
  const charset = lower.split('_')[0];
  const any = [...target.collations].find((c) => c.startsWith(`${charset}_`));
  return any || lower;
}

export function adaptCollations(sql, target) {
  return sql.replace(/COLLATE\s*=?\s*'?([A-Za-z0-9_]+)'?/gi, (_m, name) => `COLLATE=${mapCollation(name, target)}`);
}

/** 目标库不支持生成列时，把 `col` type GENERATED ALWAYS AS (...) STORED 降级成普通列 */
export function stripGenerated(sql) {
  const re = /GENERATED\s+ALWAYS\s+AS/gi;
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const start = m.index;
    let i = sql.indexOf('(', start + m[0].length);
    if (i === -1) continue;

    let depth = 0;
    let j = i;
    for (; j < sql.length; j++) {
      const ch = sql[j];
      if (ch === "'" || ch === '`' || ch === '"') {
        const quote = ch;
        j++;
        while (j < sql.length && sql[j] !== quote) {
          if (sql[j] === '\\') j++;
          j++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }

    let end = j + 1;
    const tail = sql.slice(end).match(/^\s*(STORED|VIRTUAL)/i);
    if (tail) end += tail[0].length;

    result += sql.slice(last, start);
    last = end;
    re.lastIndex = end;
  }
  return result + sql.slice(last);
}

/** JSON 类型在老版本上不存在，降级成 TEXT（换掉的是建表语句里的列类型） */
export function downgradeTypes(sql, target) {
  if (target.supportsJson) return sql;
  return sql.replace(/`\s+json\b/gi, '` TEXT').replace(/\bjson\s+(NOT NULL|NULL|DEFAULT|COMMENT|GENERATED)/gi, 'TEXT $1');
}

export function adaptCreateSql(sql, target) {
  let out = adaptCollations(sql, target);
  if (!target.supportsGenerated) out = stripGenerated(out);
  out = downgradeTypes(out, target);
  return out;
}

export function isKeyTooLong(err) {
  return err.errno === 1071 || /max key length|Specified key was too long/i.test(err.message || '');
}

export function parseColumnLengths(createSql) {
  const map = {};
  const re = /^\s*`(\w+)`\s+(?:varchar|char|varbinary|binary|text|tinytext|mediumtext|longtext)\s*(?:\((\d+)\))?/gim;
  let m;
  while ((m = re.exec(createSql)) !== null) {
    map[m[1]] = Number(m[2] || 65535);
  }
  return map;
}

/** 把过长的索引改成前缀索引，让总长度落回 767 字节以内 */
export function shortenKeys(createSql, colLengths) {
  const budget = 760;
  return createSql.replace(
    /^(\s*)(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?KEY\s+`?\w+`?\s*\(([^)]*)\)(\s*[^,\n]*)?(,?)\s*$/gm,
    (line, indent, kindRaw, colsPart, tailRaw, comma) => {
      const cols = colsPart
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!cols.length) return line;

      const per = Math.max(1, Math.floor(budget / cols.length / 4));
      const newCols = cols.map((c) => {
        const m = c.match(/^`?(\w+)`?\s*(?:\((\d+)\))?\s*(ASC|DESC)?$/i);
        if (!m) return c;
        const declared = colLengths[m[1]];
        if (!declared) return c;
        return `\`${m[1]}\`(${Math.min(per, declared)})`;
      });

      const kind = kindRaw ? kindRaw.trim() + ' ' : '';
      const tail = (tailRaw || '').trim();
      return `${indent}${kind}KEY (${newCols.join(', ')})${tail ? ' ' + tail : ''}${comma}`;
    },
  );
}

/** 建表三级降级：原样 -> ROW_FORMAT=DYNAMIC -> 索引前缀缩短 */
export async function createTableWithFallback(dst, createSql, table) {
  try {
    await q(dst, createSql);
    return;
  } catch (err) {
    if (!isKeyTooLong(err)) throw err;
  }
  logger.warn(`${table}: 索引过长，尝试 ROW_FORMAT=DYNAMIC`);
  try {
    await q(dst, `${createSql} ROW_FORMAT=DYNAMIC`);
    return;
  } catch (err) {
    if (!isKeyTooLong(err)) throw err;
  }
  logger.warn(`${table}: 改用前缀索引（唯一约束范围会缩小）`);
  await q(dst, shortenKeys(createSql, parseColumnLengths(createSql)));
}

/** 从建表语句里按行提取每个列的定义，供 ALTER 使用 */
export function extractColumnDefs(createSql) {
  const map = {};
  for (const rawLine of createSql.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '');
    const m = line.match(/^`(\w+)`\s+(.+)$/);
    if (!m) continue;
    const [, name, def] = m;
    if (/^(PRIMARY|UNIQUE|KEY|CONSTRAINT|FULLTEXT|SPATIAL|CHECK|INDEX|PERIOD)/i.test(def)) continue;
    map[name] = def;
  }
  return map;
}

/** 取建表语句（已做跨版本适配） */
export async function getAdaptedCreateSql(src, srcDb, table, targetInfo) {
  const rows = await q(src, `SHOW CREATE TABLE ${ident(srcDb)}.${ident(table)}`);
  let sql = Object.values(rows[0])[1];
  sql = sql.replace(
    new RegExp(`^CREATE TABLE\\s+\`?${escapeRegExp(srcDb)}\`?\\.\`?${escapeRegExp(table)}\`?`, 'i'),
    `CREATE TABLE ${ident(table)}`,
  );
  return adaptCreateSql(sql, targetInfo);
}

/** 拼 CRC32 校验表达式，用于快速判断一行有没有变化 */
export function buildHashExpr(columns) {
  const parts = columns.map((c) => `IFNULL(CAST(${ident(c)} AS CHAR), '<NULL>')`);
  return `CRC32(CONCAT_WS('|', ${parts.join(', ')}))`;
}
