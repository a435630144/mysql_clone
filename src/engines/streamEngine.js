import mysqlCb from 'mysql2';
import { config } from '../config.js';
import { logger, formatDuration } from '../logger.js';
import { execute, ident } from '../db.js';

const BATCH_SIZE = 500; // 每批插入的行数，越大越快但占内存越多
const PROGRESS_EVERY = 20000; // 每多少行打一次进度

/**
 * 纯 Node 引擎：源库流式读 -> 目标库批量写入。
 * 不需要服务器安装任何 MySQL 客户端，内存占用可控，适合小内存服务器。
 *
 * 复制范围：表结构 + 数据 + 视图
 * 不复制：存储过程、函数、触发器、事件（云端库常因 DEFINER 需要 SUPER 权限而报错）
 */

function connOptions(conn, database) {
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
function rawConnect(conn, database) {
  return new Promise((resolve, reject) => {
    const c = mysqlCb.createConnection(connOptions(conn, database));
    c.connect((err) => (err ? reject(err) : resolve(c)));
  });
}

/** 把 callback 风格的 query 包装成 Promise */
function q(connection, sql, params) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function closeConnection(c) {
  return new Promise((resolve) => {
    try {
      c.end(() => resolve());
    } catch {
      resolve();
    }
  });
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 8.0 新增的排序规则在 5.6 上不存在，按语义降级映射
const COLLATION_FALLBACK = {
  utf8mb4_0900_ai_ci: 'utf8mb4_general_ci',
  utf8mb4_0900_as_ci: 'utf8mb4_general_ci',
  utf8mb4_0900_as_cs: 'utf8mb4_bin',
  utf8mb4_0900_bin: 'utf8mb4_bin',
  utf8mb4_unicode_520_ci: 'utf8mb4_unicode_ci',
  utf8mb4_0900_ai_ci_deprecated: 'utf8mb4_general_ci',
};

/** 探测目标库能力：版本、支持的排序规则、是否支持生成列 */
async function inspectTarget(dst) {
  const versionRows = await q(dst, 'SELECT VERSION() AS v');
  const version = versionRows[0]?.v || '';
  const [major = 5, minor = 6, patch = 0] = version.split('-')[0].split('.').map((n) => Number(n) || 0);
  // 生成列（GENERATED ALWAYS AS）从 5.7.6 开始支持
  const supportsGenerated = major > 5 || (major === 5 && (minor > 7 || (minor === 7 && patch >= 6)));

  const collRows = await q(dst, 'SELECT COLLATION_NAME AS c FROM information_schema.collations');
  const collations = new Set(collRows.map((r) => String(r.c).toLowerCase()));

  return { version, supportsGenerated, collations };
}

function mapCollation(name, target) {
  const lower = String(name).toLowerCase();
  if (target.collations.has(lower)) return lower;
  const mapped = COLLATION_FALLBACK[lower];
  if (mapped && target.collations.has(mapped)) return mapped;
  // 最后兜底：找同字符集的任意排序规则
  const charset = lower.split('_')[0];
  const any = [...target.collations].find((c) => c.startsWith(`${charset}_`));
  return any || lower;
}

/** 把建表语句里目标库不支持的排序规则换掉 */
function adaptCollations(sql, target) {
  return sql.replace(/COLLATE\s*=?\s*'?([A-Za-z0-9_]+)'?/gi, (_m, name) => `COLLATE=${mapCollation(name, target)}`);
}

/** 目标库不支持生成列时，把 `col` type GENERATED ALWAYS AS (...) STORED 降级成普通列 */
function stripGenerated(sql) {
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

function adaptCreateSql(sql, target) {
  let out = adaptCollations(sql, target);
  if (!target.supportsGenerated) out = stripGenerated(out);
  return out;
}

export async function runStreamEngine() {
  const srcDb = config.source.database;
  const dstDb = config.target.database;
  const startedAt = Date.now();

  logger.info(`准备目标库 ${dstDb}`);
  await execute(
    config.target,
    `CREATE DATABASE IF NOT EXISTS ${ident(dstDb)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`,
  );

  const src = await rawConnect(config.source, srcDb);
  const dst = await rawConnect(config.target, dstDb);

  const failures = [];
  let totalRows = 0;

  try {
    await q(dst, 'SET FOREIGN_KEY_CHECKS=0');
    await q(dst, 'SET UNIQUE_CHECKS=0');
    // 目标库开 binlog 时，导入会产生大量 binlog；没有 SUPER 权限会失败，失败就算了
    await q(dst, 'SET SESSION sql_log_bin = 0').catch(() => {
      logger.warn('无法关闭当前会话的 binlog 记录（缺少 SUPER 权限），继续');
    });

    const targetInfo = await inspectTarget(dst);
    logger.info(`目标库版本 ${targetInfo.version}，支持生成列: ${targetInfo.supportsGenerated}`);
    const srcVersionRows = await q(src, 'SELECT VERSION() AS v');
    const srcVersion = srcVersionRows[0]?.v || '';
    if (srcVersion.split('.')[0] !== targetInfo.version.split('.')[0]) {
      logger.warn(`源库 ${srcVersion} 与目标库 ${targetInfo.version} 大版本不同，已启用降级适配（排序规则/生成列）`);
    }

    // 先把目标库里现存的视图和表全部清掉。
    // 不清会有麻烦：旧表上的外键仍然指向我们要重建的表，InnoDB 会拦下 CREATE TABLE（errno 1215）
    const oldViews = await listTables(dst, 'VIEW');
    for (const v of oldViews) {
      await q(dst, `DROP VIEW IF EXISTS ${ident(v)}`).catch(() => {});
    }
    const oldTables = await listTables(dst, 'BASE TABLE');
    if (oldTables.length) {
      await q(dst, `DROP TABLE IF EXISTS ${oldTables.map((t) => ident(t)).join(', ')}`);
      logger.info(`已清理目标库 ${oldTables.length} 张旧表`);
    }

    let tables = await listTables(src, 'BASE TABLE');
    if (config.tablesInclude.length) {
      tables = tables.filter((t) => config.tablesInclude.includes(t));
    }
    if (config.tablesExclude.length) {
      tables = tables.filter((t) => !config.tablesExclude.includes(t));
    }

    logger.step(`开始复制 ${tables.length} 张表`);
    for (const table of tables) {
      try {
        totalRows += await copyTable(src, dst, srcDb, dstDb, table, targetInfo);
      } catch (err) {
        failures.push({ table, error: err.message });
        logger.error(`表 ${table} 复制失败: ${err.message}`);
      }
    }

    const views = await listTables(src, 'VIEW');
    const viewFailures = [];
    if (views.length) {
      logger.step(`复制 ${views.length} 个视图`);
      for (const view of views) {
        try {
          await copyView(src, dst, srcDb, view);
        } catch (err) {
          viewFailures.push(view);
          logger.warn(`视图 ${view} 创建失败: ${err.message}`);
        }
      }
      // 视图之间可能互相依赖，第一遍失败的再试一次
      for (const view of viewFailures) {
        try {
          await copyView(src, dst, srcDb, view);
        } catch (err) {
          failures.push({ table: `${view}(视图)`, error: err.message });
        }
      }
    }

    await q(dst, 'SET FOREIGN_KEY_CHECKS=1');
    await q(dst, 'SET UNIQUE_CHECKS=1');
  } finally {
    await closeConnection(src);
    await closeConnection(dst);
  }

  logger.step(`复制完成，共 ${totalRows} 行，耗时 ${formatDuration(Date.now() - startedAt)}`);

  if (failures.length) {
    throw new Error(`${failures.length} 个对象复制失败: ${failures.map((f) => f.table).join(', ')}`);
  }

  return { rows: totalRows, tables: 0, views: 0 };
}

async function listTables(connection, type) {
  const rows = await q(connection, `SHOW FULL TABLES WHERE Table_type = ?`, [type]);
  // 列名是 `Tables_in_<库名>`，取每行第一个值即可
  return rows.map((r) => Object.values(r)[0]);
}

/** 查询生成列（虚拟列/存储列），INSERT 时必须跳过，否则报错 3105 */
async function generatedColumns(connection, srcDb, table) {
  const rows = await q(
    connection,
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ?
       AND (extra LIKE '%GENERATED%' OR extra LIKE '%VIRTUAL%' OR extra LIKE '%STORED%')`,
    [srcDb, table],
  );
  return rows.map((r) => r.column_name ?? r.COLUMN_NAME);
}

function isKeyTooLong(err) {
  return err.errno === 1071 || /max key length|Specified key was too long/i.test(err.message || '');
}

/** 从建表语句里提取字符列的长度，供索引降级时使用 */
function parseColumnLengths(createSql) {
  const map = {};
  const re = /^\s*`(\w+)`\s+(?:varchar|char|varbinary|binary|text|tinytext|mediumtext|longtext)\s*(?:\((\d+)\))?/gim;
  let m;
  while ((m = re.exec(createSql)) !== null) {
    map[m[1]] = Number(m[2] || 65535);
  }
  return map;
}

/**
 * 把过长的索引改成前缀索引，让总长度落回 767 字节以内。
 * 代价：唯一约束只在前缀范围内生效（对只读备库影响不大）。
 */
function shortenKeys(createSql, colLengths) {
  const budget = 760; // 767 上限留一点余量
  return createSql.replace(
    /^(\s*)(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?KEY\s+`?\w+`?\s*\(([^)]*)\)(\s*[^,\n]*)?(,?)\s*$/gm,
    (line, indent, kindRaw, colsPart, tailRaw, comma) => {
      const cols = colsPart.split(',').map((s) => s.trim()).filter(Boolean);
      if (!cols.length) return line;

      const per = Math.max(1, Math.floor(budget / cols.length / 4));
      const newCols = cols.map((c) => {
        const m = c.match(/^`?(\w+)`?\s*(?:\((\d+)\))?\s*(ASC|DESC)?$/i);
        if (!m) return c;
        const name = m[1];
        const declared = colLengths[name];
        if (!declared) return c; // 数字/时间列不需要前缀
        const prefix = Math.min(per, declared);
        return `\`${name}\`(${prefix})`;
      });

      const kind = kindRaw ? kindRaw.trim() + ' ' : '';
      const tail = (tailRaw || '').trim();
      return `${indent}${kind}KEY (${newCols.join(', ')})${tail ? ' ' + tail : ''}${comma}`;
    },
  );
}

/** 建表三级降级：原样 -> ROW_FORMAT=DYNAMIC -> 索引前缀缩短 */
async function createTableWithFallback(dst, createSql, table) {
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

async function copyTable(src, dst, srcDb, dstDb, table, targetInfo) {
  const t0 = Date.now();

  const createRows = await q(src, `SHOW CREATE TABLE ${ident(srcDb)}.${ident(table)}`);
  let createSql = Object.values(createRows[0])[1];
  // 个别版本会带库名前缀，统一去掉，让它建在目标库里
  createSql = createSql.replace(
    new RegExp(`^CREATE TABLE\\s+\`?${escapeRegExp(srcDb)}\`?\\.\`?${escapeRegExp(table)}\`?`, 'i'),
    `CREATE TABLE ${ident(table)}`,
  );
  // 跨版本降级：替换目标库不认识的排序规则、把生成列改成普通列
  createSql = adaptCreateSql(createSql, targetInfo);

  await q(dst, `DROP TABLE IF EXISTS ${ident(dstDb)}.${ident(table)}`);
  await createTableWithFallback(dst, createSql, table);

  // 目标库不支持生成列时，那列已经被降级成普通列，要把值一起插过去
  const skipCols = targetInfo.supportsGenerated ? await generatedColumns(src, srcDb, table) : [];

  let columns = null;
  let batch = [];
  let copied = 0;

  const flush = async () => {
    if (!batch.length) return;
    const sql = `INSERT INTO ${ident(dstDb)}.${ident(table)} (${columns.map(ident).join(', ')}) VALUES ?`;
    const values = batch.map((row) => columns.map((c) => row[c]));
    await q(dst, sql, [values]);
    batch = [];
  };

  const stream = src.query(`SELECT * FROM ${ident(srcDb)}.${ident(table)}`).stream({ highWaterMark: 200 });

  for await (const row of stream) {
    if (!columns) columns = Object.keys(row).filter((c) => !skipCols.includes(c));
    batch.push(row);
    if (batch.length >= BATCH_SIZE) await flush();
    copied++;
    if (copied % PROGRESS_EVERY === 0) logger.info(`${table}: 已复制 ${copied} 行`);
  }
  await flush();

  logger.info(`${table}: ${copied} 行，耗时 ${formatDuration(Date.now() - t0)}`);
  return copied;
}

async function copyView(src, dst, srcDb, view) {
  const rows = await q(src, `SHOW CREATE VIEW ${ident(srcDb)}.${ident(view)}`);
  let def = Object.values(rows[0])[1];
  // 云端普通账号没有 SUPER 权限，指定别人的 DEFINER 会报 ERROR 1227
  def = def.replace(/DEFINER\s*=\s*`?[^`\s]+`?@`?[^`\s]+`?/i, 'DEFINER=CURRENT_USER');
  // 去掉视图名前的库名前缀，让它建在目标库里
  def = def.replace(
    new RegExp(`VIEW\\s+\`?${escapeRegExp(srcDb)}\`?\\.\`?${escapeRegExp(view)}\`?`, 'i'),
    `VIEW ${ident(view)}`,
  );
  await q(dst, `DROP VIEW IF EXISTS ${ident(view)}`);
  await q(dst, def);
  logger.info(`视图 ${view} 已创建`);
}
