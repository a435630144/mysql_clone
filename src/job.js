import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDumpDir } from './config.js';
import { logger, formatDuration } from './logger.js';
import { ping } from './db.js';
import { verifyClone } from './verify.js';
import { notify } from './notify.js';
import { sendMail, summaryLines, mailEnabled } from './mailer.js';
import { runDumpEngine } from './engines/dumpEngine.js';
import { runStreamEngine } from './engines/streamEngine.js';
import { runSyncEngine } from './engines/syncEngine.js';
import { cleanupTmpFiles, detectClient } from './mysqlClient.js';

const LOCK_FILE = () => path.join(config.dumpDir, '.clone.lock');

/** 用文件锁避免上一次任务没跑完就启动下一次 */
function acquireLock() {
  ensureDumpDir();
  const file = LOCK_FILE();
  if (fs.existsSync(file)) {
    const hours = (Date.now() - fs.statSync(file).mtimeMs) / 1000 / 60 / 60;
    if (hours < config.lockTimeoutHours) return false;
    logger.warn(`发现超过 ${config.lockTimeoutHours} 小时的残留锁文件，清理后继续`);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return true;
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_FILE(), { force: true });
  } catch {
    /* 忽略 */
  }
}

/** 清理旧的导出文件，只保留最近 KEEP_DUMPS 份 */
function pruneDumps() {
  if (!config.keepDumps || config.keepDumps <= 0) return;
  const dir = config.dumpDir;
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql.gz'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  for (const item of files.slice(config.keepDumps)) {
    fs.rmSync(path.join(dir, item.f), { force: true });
    logger.info(`清理旧备份: ${item.f}`);
  }
}

export async function precheck() {
  const srcVersion = await ping(config.source);
  const dstVersion = await ping(config.target);
  logger.info(`源库连通 (${srcVersion})`);
  logger.info(`目标库连通 (${dstVersion})`);

  if (config.engine === 'dump') {
    const client = await detectClient();
    if (!client.available) {
      throw new Error(
        `CLONE_ENGINE=dump 但找不到 mysqldump 客户端（${client.error}）。` +
          `请安装 MySQL 客户端，或把 CLONE_ENGINE 改为 sync。`,
      );
    }
    logger.info(`客户端: ${client.raw}`);
  } else {
    logger.info(`使用 ${config.engine} 引擎，无需本地 MySQL 客户端`);
  }
  logger.info(`邮件告警: ${mailEnabled() ? `已开启 -> ${config.mailTo}` : '未配置（出问题不会发信）'}`);
}

function runEngine() {
  if (config.engine === 'dump') return runDumpEngine();
  if (config.engine === 'stream') return runStreamEngine();
  return runSyncEngine();
}

/** 完整跑一次 */
export async function runJob() {
  const startedAt = Date.now();
  logger.step(`开始 ${config.source.database} -> ${config.target.database}（引擎: ${config.engine}）`);

  if (!acquireLock()) {
    logger.warn('上一次任务仍在运行，本次跳过');
    return { skipped: true };
  }

  let mailAlreadySent = false;
  try {
    await precheck();
    const result = await runEngine();
    const problems = result.problems || [];

    // 增量模式且完全没变动时，跳过逐表 COUNT(*) 校验，省时间
    const needVerify = config.verifyMode !== 'off' && !(config.engine === 'sync' && result.changed === 0);
    let verifyResult = { skipped: true, ok: true, tables: 0, mismatches: [] };
    if (needVerify) {
      logger.step('校验两边行数');
      verifyResult = await verifyClone();
      logger.info(
        verifyResult.ok
          ? `校验通过，共 ${verifyResult.tables} 张表`
          : `校验发现 ${verifyResult.mismatches.length} 处不一致`,
      );
    }

    const duration = formatDuration(Date.now() - startedAt);
    const statLines = [];
    if (result.stats) {
      const s = result.stats;
      statLines.push(
        `新建表 ${s.created}，重建表 ${s.rebuilt}，清理多余表 ${s.tablesDropped}`,
        `插入 ${s.inserted}，更新 ${s.updated}，删除 ${s.deleted}`,
        `列变更 ${s.columnsAdded + s.columnsDropped + s.columnsModified}，视图 ${s.views}`,
      );
    } else if (result.file) {
      statLines.push(`导出文件 ${(result.bytes / 1024 / 1024).toFixed(2)} MB`);
    } else if (result.rows !== undefined) {
      statLines.push(`复制行数 ${result.rows}`);
    }
    statLines.push(`校验: ${verifyResult.skipped ? '跳过（无变动）' : verifyResult.ok ? '通过' : '不通过'}`);
    statLines.push(`耗时: ${duration}`);

    const lines = summaryLines(statLines);
    logger.step(`完成，耗时 ${duration}`);
    cleanupTmpFiles();
    pruneDumps();

    if (!verifyResult.ok) {
      for (const m of verifyResult.mismatches.slice(0, 20)) {
        problems.push({ table: m.table, action: '行数校验', error: `源=${m.source} 目标=${m.target}` });
      }
    }

    // 邮件只在两种情况发：有解决不了的问题，或你主动开了每日报告
    if (problems.length) {
      mailAlreadySent = true; // 下面抛错时不要重复发第二封
      await sendMail({
        subject: `[数据库同步] 有 ${problems.length} 个问题需要处理`,
        title: `同步完成，但有 ${problems.length} 个问题未能自动解决`,
        lines,
        problems,
      });
      await notify({ success: false, title: '同步完成但存在问题', details: lines.join('\n') });
      throw new Error(`${problems.length} 个问题未能自动解决：${problems.map((p) => p.table).join(', ')}`);
    }

    await notify({ success: true, title: `同步成功 ${config.source.database}`, details: lines.join('\n') });
    if (config.mailOnSuccess) {
      await sendMail({ subject: '[数据库同步] 每日报告：正常', title: '同步正常完成', lines, problems: [] });
    }

    return { ok: true, duration, result, verifyResult };
  } catch (err) {
    logger.error(`任务失败: ${err.message}`);
    if (!mailAlreadySent) {
      await sendMail({
        subject: '[数据库同步] 任务失败',
        title: '同步任务失败',
        lines: summaryLines([`错误: ${err.message}`]),
        problems: [{ table: '-', action: '整体任务', error: err.message }],
      });
    }
    await notify({
      success: false,
      title: `同步失败 ${config.source.database}`,
      details: `${err.message}\n时间: ${new Date().toISOString()}`,
    });
    throw err;
  } finally {
    releaseLock();
    cleanupTmpFiles();
  }
}
