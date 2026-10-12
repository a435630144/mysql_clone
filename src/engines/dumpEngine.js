import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDumpDir } from '../config.js';
import { logger } from '../logger.js';
import { dumpToFile, loadFromFile, detectClient } from '../mysqlClient.js';
import { execute, ident } from '../db.js';

/** 生成形如 20261013-030000 的时间戳（本地时间） */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 引擎 A：mysqldump 导出 -> 压缩落盘 -> mysql 导入
 * 优点：完整保留存储过程、函数、触发器、事件、视图；兼容性最好
 * 前提：服务器上装有 mysqldump / mysql 客户端
 */
export async function runDumpEngine() {
  const client = await detectClient();
  if (!client.available) {
    throw new Error(
      `未找到 mysqldump 客户端（${client.error}）。` +
        `请在服务器上安装 MySQL 客户端，或把 CLONE_ENGINE 改成 stream 使用纯 Node 引擎。`,
    );
  }
  logger.info(`客户端: ${client.raw}`);

  const databases = config.source.database
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sameName = databases.length === 1 && databases[0] === config.target.database;

  if (!sameName && databases.length > 1) {
    throw new Error('一次克隆多个库时，目标库名必须与源库一致。');
  }

  ensureDumpDir();

  // 目标库名与源库不同时，SQL 里不会带 CREATE DATABASE，需要自己先准备库
  if (!sameName) {
    logger.info(`准备目标库 ${config.target.database}（DROP + CREATE）`);
    await execute(
      config.target,
      `DROP DATABASE IF EXISTS ${ident(config.target.database)};
       CREATE DATABASE ${ident(config.target.database)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`,
    );
  }

  const file = path.join(config.dumpDir, `${databases.join('_')}_${stamp()}.sql.gz`);

  logger.step(`导出源库 ${databases.join(', ')}`);
  const { bytes } = await dumpToFile({
    conn: config.source,
    databases,
    outFile: file,
    sameName,
    extraArgs: config.dumpExtraOptions,
  });
  logger.info(`导出完成: ${file} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);

  logger.step(`导入到目标库 ${config.target.database}`);
  await loadFromFile({
    conn: config.target,
    file,
    database: sameName ? null : config.target.database,
  });
  logger.info('导入完成');

  return { file, bytes };
}
