import { config } from '../config.js';
import { logger, formatDuration } from '../logger.js';
import { execute, ident } from '../db.js';
import {
  q,
  rawConnect,
  closeConnection,
  listTables,
  inspectTarget,
  getAdaptedCreateSql,
  createTableWithFallback,
  getSinglePrimaryKey,
  getColumns,
  extractColumnDefs,
  buildHashExpr,
  isGeneratedColumn,
  withRetry,
  escapeRegExp,
} from './common.js';

const BATCH = 500;

/**
 * 增量同步引擎（推荐）
 *
 * 和全量引擎的区别：不整库推倒重来，而是逐表比对后只做必要的改动
 *   - 源库新增的行 -> 目标库 INSERT
 *   - 源库改过的行 -> 目标库 REPLACE（覆盖写，天然解决主键冲突）
 *   - 源库删掉的行 -> 目标库 DELETE
 *   - 目标库多出来的表/列 -> DROP（可关）
 *   - 表结构不一致 -> ALTER 增/删/改列
 * 表没有单列主键时无法做行级比对，自动退化成整表重建。
 */
export async function runSyncEngine() {
  const srcDb = config.source.database;
  const dstDb = config.target.database;
  const startedAt = Date.now();

  const stats = {
    tables: 0,
    created: 0,
    rebuilt: 0,
    unchanged: 0,
    inserted: 0,
    updated: 0,
    deleted: 0,
    columnsAdded: 0,
    columnsDropped: 0,
    columnsModified: 0,
    tablesDropped: 0,
    views: 0,
  };
  const problems = [];

  await execute(
    config.target,
    `CREATE DATABASE IF NOT EXISTS ${ident(dstDb)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`,
  );

  const src = await rawConnect(config.source, srcDb);
  const dst = await rawConnect(config.target, dstDb);

  try {
    await q(dst, 'SET FOREIGN_KEY_CHECKS=0');
    await q(dst, 'SET UNIQUE_CHECKS=0');
    await q(dst, 'SET SESSION sql_log_bin = 0').catch(() => {});

    const targetInfo = await inspectTarget(dst);
    const srcVersionRows = await q(src, 'SELECT VERSION() AS v');
    logger.info(`源库 ${srcVersionRows[0]?.v} -> 目标库 ${targetInfo.version}`);

    let srcTables = await listTables(src, 'BASE TABLE');
    if (config.tablesInclude.length) srcTables = srcTables.filter((t) => config.tablesInclude.includes(t));
    if (config.tablesExclude.length) srcTables = srcTables.filter((t) => !config.tablesExclude.includes(t));
    const dstTables = await listTables(dst, 'BASE TABLE');

    // 目标库多出来的表（源库已经删掉的）
    const extraTables = dstTables.filter((t) => !srcTables.includes(t));
    if (extraTables.length && config.dropExtraTables) {
      logger.step(`目标库多出 ${extraTables.length} 张表，删除: ${extraTables.join(', ')}`);
      await q(dst, `DROP TABLE IF EXISTS ${extraTables.map((t) => ident(t)).join(', ')}`);
      stats.tablesDropped = extraTables.length;
    } else if (extraTables.length) {
      logger.warn(`目标库多出 ${extraTables.length} 张表但未开启删除: ${extraTables.join(', ')}`);
    }

    logger.step(`同步 ${srcTables.length} 张表`);
    stats.tables = srcTables.length;

    for (const table of srcTables) {
      try {
        await withRetry(() => syncTable(src, dst, srcDb, dstDb, table, dstTables, targetInfo, stats, problems), {
          times: 2,
          label: `表 ${table}`,
        });
      } catch (err) {
        problems.push({ table, action: '同步整表', error: err.message });
        logger.error(`表 ${table} 同步失败: ${err.message}`);
      }
    }

    await syncViews(src, dst, srcDb, targetInfo, stats, problems);
    await q(dst, 'SET FOREIGN_KEY_CHECKS=1');
    await q(dst, 'SET UNIQUE_CHECKS=1');
  } finally {
    await closeConnection(src);
    await closeConnection(dst);
  }

  const changed = stats.created + stats.rebuilt + stats.inserted + stats.updated + stats.deleted +
    stats.columnsAdded + stats.columnsDropped + stats.columnsModified + stats.tablesDropped + stats.views;

  logger.step(
    `增量同步完成：${stats.tables} 张表（无变化 ${stats.unchanged}），` +
      `新建 ${stats.created}，重建 ${stats.rebuilt}，` +
      `插入 ${stats.inserted}，更新 ${stats.updated}，删除 ${stats.deleted}，` +
      `列变更 ${stats.columnsAdded + stats.columnsDropped + stats.columnsModified}，` +
      `视图 ${stats.views}，耗时 ${formatDuration(Date.now() - startedAt)}`,
  );

  return { stats, problems, changed, rows: stats.inserted + stats.updated };
}

async function syncTable(src, dst, srcDb, dstDb, table, dstTables, targetInfo, stats, problems) {
  const createSql = await getAdaptedCreateSql(src, srcDb, table, targetInfo);
  const dstHas = dstTables.includes(table);

  if (!dstHas) {
    await createTableWithFallback(dst, createSql, table);
    const rows = await fullCopy(src, dst, srcDb, dstDb, table, targetInfo);
    stats.created++;
    stats.inserted += rows;
    logger.info(`${table}: 目标库没有，新建并灌入 ${rows} 行`);
    return;
  }

  await syncStructure(src, dst, srcDb, dstDb, table, createSql, targetInfo, stats, problems);

  const pk = await getSinglePrimaryKey(src, srcDb, table);
  if (!pk) {
    // 没有单列主键就无法做行级比对：先比整表摘要，一样就跳过，不一样才整表重建
    const cols = (await getColumns(src, srcDb, table)).map((c) => c.name);
    const [srcSig, dstSig] = await Promise.all([
      tableSignature(src, srcDb, table, cols),
      tableSignature(dst, dstDb, table, cols),
    ]);
    if (srcSig.count === dstSig.count && srcSig.hash === dstSig.hash) {
      stats.unchanged++;
      return;
    }
    logger.warn(`${table}: 无单列主键且内容有差异，整表重建`);
    await q(dst, `DROP TABLE IF EXISTS ${ident(dstDb)}.${ident(table)}`);
    await createTableWithFallback(dst, createSql, table);
    stats.rebuilt++;
    stats.inserted += await fullCopy(src, dst, srcDb, dstDb, table, targetInfo);
    return;
  }

  await syncData(src, dst, srcDb, dstDb, table, pk, targetInfo, stats, problems);
}

/** 表结构同步：加缺失列、删多余列、改类型不同的列 */
async function syncStructure(src, dst, srcDb, dstDb, table, createSql, targetInfo, stats, problems) {
  const srcCols = await getColumns(src, srcDb, table);
  const dstCols = await getColumns(dst, dstDb, table);
  const defs = extractColumnDefs(createSql);
  const dstTable = `${ident(dstDb)}.${ident(table)}`;

  const srcMap = new Map(srcCols.map((c) => [c.name, c]));
  const dstMap = new Map(dstCols.map((c) => [c.name, c]));

  for (const [name, col] of srcMap) {
    if (dstMap.has(name)) continue;
    const def = defs[name];
    if (!def) {
      problems.push({ table, action: `新增列 ${name}`, error: '无法从建表语句里解析出列定义' });
      continue;
    }
    try {
      await q(dst, `ALTER TABLE ${dstTable} ADD COLUMN ${ident(name)} ${def}`);
      stats.columnsAdded++;
      logger.info(`${table}: 新增列 ${name}`);
    } catch (err) {
      problems.push({ table, action: `新增列 ${name}`, error: err.message });
    }
  }

  if (config.dropExtraColumns) {
    for (const name of dstMap.keys()) {
      if (srcMap.has(name)) continue;
      try {
        await q(dst, `ALTER TABLE ${dstTable} DROP COLUMN ${ident(name)}`);
        stats.columnsDropped++;
        logger.info(`${table}: 删除多余列 ${name}`);
      } catch (err) {
        problems.push({ table, action: `删除列 ${name}`, error: err.message });
      }
    }
  }

  for (const [name, col] of srcMap) {
    const d = dstMap.get(name);
    if (!d) continue;
    // 生成列在老版本上已经被降级成普通列，属于预期差异，不去动它
    if (isGeneratedColumn(col) && !targetInfo.supportsGenerated) continue;
    if (normalizeType(col.type) === normalizeType(d.type)) continue;
    const def = defs[name];
    if (!def) continue;
    try {
      await q(dst, `ALTER TABLE ${dstTable} MODIFY COLUMN ${ident(name)} ${def}`);
      stats.columnsModified++;
      logger.info(`${table}: 修正列类型 ${name} (${d.type} -> ${col.type})`);
    } catch (err) {
      problems.push({ table, action: `修正列 ${name}`, error: err.message });
    }
  }
}

/**
 * 归一化类型字符串，避免把「语义相同、写法不同」当成差异。
 * 典型：MySQL 8.0.19+ 不再显示整数显示宽度，源库是 int，5.6 目标是 int(11)，其实一样。
 */
function normalizeType(type) {
  return String(type || '')
    .toLowerCase()
    .replace(/\b(tinyint|smallint|mediumint|bigint|integer|int)\s*\(\d+\)/g, '$1') // 去掉整数显示宽度
    .replace(/\s+/g, ' ')
    .trim();
}

/** 整表摘要：行数 + 所有行 CRC 之和，用于快速判断整表有没有变化 */
async function tableSignature(conn, db, table, cols) {
  const expr = buildHashExpr(cols);
  const rows = await q(conn, `SELECT COUNT(*) AS c, COALESCE(SUM(${expr}), 0) AS h FROM ${ident(db)}.${ident(table)}`);
  return { count: Number(rows[0]?.c ?? -1), hash: String(rows[0]?.h ?? '') };
}

/** 行级比对：只同步真正有差异的行 */
async function syncData(src, dst, srcDb, dstDb, table, pk, targetInfo, stats, problems) {
  const srcTable = `${ident(srcDb)}.${ident(table)}`;
  const dstTable = `${ident(dstDb)}.${ident(table)}`;

  const srcCols = await getColumns(src, srcDb, table);
  const dstCols = await getColumns(dst, dstDb, table);
  const dstNames = new Set(dstCols.map((c) => c.name));
  const names = srcCols
    .filter((c) => dstNames.has(c.name))
    .filter((c) => targetInfo.supportsGenerated || !isGeneratedColumn(c))
    .map((c) => c.name);

  if (!names.length) {
    problems.push({ table, action: '比对数据', error: '找不到可比对的重合列' });
    return;
  }

  const hashExpr = buildHashExpr(names);
  const pkCol = ident(pk);
  const toInsert = [];
  const toUpdate = [];

  // 1) 扫源库，找出目标库缺少或内容不同的行
  // 用「主键游标」而不是 OFFSET 分页：源库可能正在被写入，OFFSET 会错位导致漏检
  let lastPk = null;
  for (;;) {
    const where = lastPk === null ? '' : `WHERE ${pkCol} > ?`;
    const rows = await q(
      src,
      `SELECT ${pkCol} AS _pk, ${hashExpr} AS _h FROM ${srcTable} ${where} ORDER BY ${pkCol} LIMIT ${BATCH}`,
      lastPk === null ? [] : [lastPk],
    );
    if (!rows.length) break;
    lastPk = rows[rows.length - 1]._pk;

    const pks = rows.map((r) => r._pk);
    const ph = pks.map(() => '?').join(',');
    const dstRows = await q(
      dst,
      `SELECT ${pkCol} AS _pk, ${hashExpr} AS _h FROM ${dstTable} WHERE ${pkCol} IN (${ph})`,
      pks,
    );
    const dstMap = new Map(dstRows.map((r) => [String(r._pk), String(r._h)]));

    for (const r of rows) {
      const key = String(r._pk);
      if (!dstMap.has(key)) toInsert.push(r._pk);
      else if (dstMap.get(key) !== String(r._h)) toUpdate.push(r._pk);
    }
  }

  // 2) 写入：REPLACE INTO 同时覆盖新增和更新的行，主键冲突自动解决
  for (const [list, bucket, label] of [
    [toInsert, 'inserted', '新增'],
    [toUpdate, 'updated', '更新'],
  ]) {
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const ph = chunk.map(() => '?').join(',');
      const rows = await q(
        src,
        `SELECT ${names.map(ident).join(', ')} FROM ${srcTable} WHERE ${pkCol} IN (${ph})`,
        chunk,
      );
      if (!rows.length) continue;
      const values = rows.map((r) => names.map((n) => r[n]));
      try {
        await q(dst, `REPLACE INTO ${dstTable} (${names.map(ident).join(', ')}) VALUES ?`, [values]);
        stats[bucket] += rows.length;
      } catch (err) {
        problems.push({ table, action: `${label} ${rows.length} 行`, error: err.message });
      }
    }
  }

  // 3) 删掉源库已经没有的行
  // 这里必须用游标分页：边删边用 OFFSET 分页会跳过记录，导致删不干净
  if (config.dropExtraRows) {
    let lastPk = null;
    for (;;) {
      const where = lastPk === null ? '' : `WHERE ${pkCol} > ?`;
      const rows = await q(
        dst,
        `SELECT ${pkCol} AS _pk FROM ${dstTable} ${where} ORDER BY ${pkCol} LIMIT ${BATCH}`,
        lastPk === null ? [] : [lastPk],
      );
      if (!rows.length) break;
      lastPk = rows[rows.length - 1]._pk;

      const pks = rows.map((r) => r._pk);
      const ph = pks.map(() => '?').join(',');
      const exists = await q(src, `SELECT ${pkCol} AS _pk FROM ${srcTable} WHERE ${pkCol} IN (${ph})`, pks);
      const existSet = new Set(exists.map((r) => String(r._pk)));
      const del = pks.filter((v) => !existSet.has(String(v)));
      if (!del.length) continue;

      const dph = del.map(() => '?').join(',');
      try {
        await q(dst, `DELETE FROM ${dstTable} WHERE ${pkCol} IN (${dph})`, del);
        stats.deleted += del.length;
        logger.info(`${table}: 删除源库已不存在的 ${del.length} 行`);
      } catch (err) {
        problems.push({ table, action: `删除 ${del.length} 行`, error: err.message });
      }
    }
  }

  if (toInsert.length || toUpdate.length) {
    logger.info(`${table}: 新增 ${toInsert.length}，更新 ${toUpdate.length}`);
  }
}

/** 流式全量复制（建表后灌数据，或整表重建时用） */
async function fullCopy(src, dst, srcDb, dstDb, table, targetInfo) {
  const srcTable = `${ident(srcDb)}.${ident(table)}`;
  const dstTable = `${ident(dstDb)}.${ident(table)}`;

  const cols = await getColumns(src, srcDb, table);
  const skip = targetInfo.supportsGenerated ? new Set(cols.filter(isGeneratedColumn).map((c) => c.name)) : new Set();

  let names = null;
  let batch = [];
  let copied = 0;

  const flush = async () => {
    if (!batch.length) return;
    await q(dst, `REPLACE INTO ${dstTable} (${names.map(ident).join(', ')}) VALUES ?`, [
      batch.map((row) => names.map((n) => row[n])),
    ]);
    batch = [];
  };

  const stream = src.query(`SELECT * FROM ${srcTable}`).stream({ highWaterMark: 200 });
  for await (const row of stream) {
    if (!names) names = Object.keys(row).filter((c) => !skip.has(c));
    batch.push(row);
    if (batch.length >= BATCH) await flush();
    copied++;
  }
  await flush();
  return copied;
}

/** 视图：无法增量比对，直接删掉重建，失败的换一轮再试（视图之间有依赖） */
async function syncViews(src, dst, srcDb, targetInfo, stats, problems) {
  const views = await listTables(src, 'VIEW');
  if (!views.length) return;

  const oldViews = await listTables(dst, 'VIEW');
  for (const v of oldViews) {
    await q(dst, `DROP VIEW IF EXISTS ${ident(v)}`).catch(() => {});
  }

  const failed = [];
  for (const view of views) {
    try {
      await createView(src, dst, srcDb, view);
      stats.views++;
    } catch (err) {
      failed.push(view);
    }
  }
  for (const view of failed) {
    try {
      await createView(src, dst, srcDb, view);
      stats.views++;
    } catch (err) {
      problems.push({ table: `${view}(视图)`, action: '创建视图', error: err.message });
    }
  }
  logger.info(`视图处理完成，成功 ${stats.views} 个`);
}

async function createView(src, dst, srcDb, view) {
  const rows = await q(src, `SHOW CREATE VIEW ${ident(srcDb)}.${ident(view)}`);
  let def = Object.values(rows[0])[1];
  // 云端账号通常没有 SUPER 权限，指定别人的 DEFINER 会报 ERROR 1227
  def = def.replace(/DEFINER\s*=\s*`?[^`\s]+`?@`?[^`\s]+`?/i, 'DEFINER=CURRENT_USER');
  def = def.replace(
    new RegExp(`VIEW\\s+\`?${escapeRegExp(srcDb)}\`?\\.\`?${escapeRegExp(view)}\`?`, 'i'),
    `VIEW ${ident(view)}`,
  );
  await q(dst, def);
}
