import { config, validateConfig } from './config.js';
import { logger } from './logger.js';
import { runJob, precheck } from './job.js';
import { query } from './db.js';

// 本程序只负责「跑一次就退出」，定时调度交给服务器的系统 cron / 计划任务
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

function fail(messages) {
  for (const m of messages) logger.error(m);
  process.exitCode = 1;
  process.exit(1);
}

const errors = validateConfig();
if (errors.length) fail(errors);

/** --check：只做配置和连通性体检，不碰数据 */
async function check() {
  logger.step('配置检查');
  logger.info(`引擎: ${config.engine}`);
  logger.info(`源库: ${config.source.user}@${config.source.host}:${config.source.port}/${config.source.database}`);
  logger.info(`目标库: ${config.target.user}@${config.target.host}:${config.target.port}/${config.target.database}`);

  await precheck();

  for (const side of ['source', 'target']) {
    const dbName = config[side].database;
    const dbRows = await query(config[side], 'SHOW DATABASES');
    const visible = dbRows.map((r) => r.Database ?? r.database);
    if (!visible.includes(dbName)) {
      logger.warn(`[${side}] 找不到库 "${dbName}"。该账号能看到的库有: ${visible.join(', ')}`);
      logger.warn(`请把 .env 里的 ${side.toUpperCase()}_DATABASE 改成上面列表里的真实库名`);
      continue;
    }
    const rows = await query(
      config[side],
      `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ?`,
      [dbName],
    );
    logger.info(`[${side}] 库 ${dbName} 中的表数量: ${rows[0]?.c}`);
  }

  logger.step('体检通过，可以执行 npm run once 试跑一次');
}

async function main() {
  if (checkOnly) {
    await check();
    return;
  }
  await runJob();
}

main().catch((err) => {
  logger.error(`启动失败: ${err.stack || err.message}`);
  process.exitCode = 1;
});
