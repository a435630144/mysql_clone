import mysql from 'mysql2/promise';

/**
 * 用 mysql2 打开一个数据库连接。
 * 校验模块、stream 引擎都用它，因此即使服务器上没有 mysql 客户端也能工作。
 */
export async function connect(conn, { database = null } = {}) {
  return mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: database || undefined,
    charset: 'utf8mb4',
    connectTimeout: 20000,
    // 一次连不上就报错，不要无限重试
    enableKeepAlive: true,
  });
}

/** 执行查询并返回行数组 */
export async function query(conn, sql, params = []) {
  const c = await connect(conn);
  try {
    const [rows] = await c.query(sql, params);
    return rows;
  } finally {
    await c.end().catch(() => {});
  }
}

/** 在指定库的连接上下文里执行一段 SQL（用于建库/删库等需要切库的操作） */
export async function execute(conn, sql) {
  const c = await mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    charset: 'utf8mb4',
    multipleStatements: true,
    connectTimeout: 20000,
  });
  try {
    await c.query(sql);
  } finally {
    await c.end().catch(() => {});
  }
}

/** 连通性检查，成功返回服务端版本字符串 */
export async function ping(conn) {
  const rows = await query(conn, 'SELECT VERSION() AS v');
  return rows[0]?.v || 'unknown';
}

/** 转义标识符（库名/表名），防止反引号注入 */
export function ident(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}
