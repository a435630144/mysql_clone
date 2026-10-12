import { connect, query, ident } from './db.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * 克隆完成后对比源库与目标库的行数。
 * mode=count    : 逐表 SELECT COUNT(*)，精确，表多时略慢（<1GB 的库完全可接受）
 * mode=estimate : 读 information_schema 的估算值，秒级，但 InnoDB 的估算值可能偏差
 * mode=off      : 不校验
 */
export async function verifyClone() {
  const mode = config.verifyMode;
  if (mode === 'off') {
    return { skipped: true, ok: true, tables: 0, mismatches: [] };
  }

  const srcDb = config.source.database;
  const dstDb = config.target.database;

  const [srcTables, dstTables] = await Promise.all([listTables(config.source, srcDb), listTables(config.target, dstDb)]);

  const missing = srcTables.filter((t) => !dstTables.includes(t));
  const extra = dstTables.filter((t) => !srcTables.includes(t));
  const common = srcTables.filter((t) => dstTables.includes(t));

  const mismatches = [];
  for (const t of common) {
    const [s, d] = await Promise.all([rowCount(config.source, srcDb, t, mode), rowCount(config.target, dstDb, t, mode)]);
    if (s !== d) {
      mismatches.push({ table: t, source: s, target: d });
      logger.warn(`行数不一致: ${t} 源=${s} 目标=${d}`);
    }
  }

  for (const t of missing) mismatches.push({ table: t, source: '存在', target: '缺失' });
  for (const t of extra) mismatches.push({ table: t, source: '不存在', target: '多出' });

  return {
    skipped: false,
    ok: mismatches.length === 0,
    tables: srcTables.length,
    checked: common.length,
    mismatches,
  };
}

async function listTables(conn, schema) {
  const rows = await query(
    conn,
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = ? AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
  return rows.map((r) => r.table_name ?? r.TABLE_NAME);
}

async function rowCount(conn, schema, table, mode) {
  if (mode === 'estimate') {
    const rows = await query(
      conn,
      `SELECT table_rows AS c FROM information_schema.tables
       WHERE table_schema = ? AND table_name = ?`,
      [schema, table],
    );
    return Number(rows[0]?.c ?? -1);
  }
  const rows = await query(conn, `SELECT COUNT(*) AS c FROM ${ident(schema)}.${ident(table)}`);
  return Number(rows[0]?.c ?? -1);
}
