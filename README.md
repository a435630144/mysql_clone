# copy_database · MySQL 数据库定时同步工具

把一个 MySQL 数据库同步到另一个 MySQL 数据库，**增量比对、跨版本自适应、冲突自愈、出问题发邮件**。

适用于：云端数据库（RDS / CDB / 虚拟主机）之间的定时同步、主备库克隆、异地数据镜像。
程序跑完一次就退出，定时交给服务器的系统 cron。

```
源库 MySQL 8.0  ──增量比对──>  备库 MySQL 5.6 / 5.7 / 8.0 / MariaDB
     只读                          自动适配版本差异
```

## 为什么不用现成的

MySQL Shell 的 `util.copySchemas()` 更快，但要求目标库开 `local_infile`（多数云厂商不给改），
还需要源库的 `BACKUP_ADMIN` 权限。本工具只用最普通的 SELECT / INSERT 权限，云端数据库都能跑。

## 特性

- **增量同步**：逐表比对，只同步新增/修改/删除的行，不是每次推倒重来
- **跨版本自适应**：运行时探测两端版本、字符集、JSON、生成列等能力，8.0 → 5.6 也能跑
- **冲突自愈**：排序规则不兼容、索引超长、生成列、主键冲突等 10 类问题自动处理
- **邮件告警**：只有在程序自己解决不了时才发信，不会每天骚扰你
- **零二进制依赖**：纯 Node 驱动，服务器上不需要安装任何 MySQL 客户端
- **跑完即退**：不常驻，小内存服务器友好

---

## Quick Start (English)

```bash
git clone <your-repo> copy_database && cd copy_database
npm install
cp .env.example .env       # fill in source / target database info
npm run check              # connectivity & compatibility check
npm run once               # run one sync
# then schedule it with cron:
# 0 3 * * * cd /path/to/copy_database && /usr/bin/node src/index.js --once >> /var/log/mysql-clone.log 2>&1
```

Three engines available via `CLONE_ENGINE`: `sync` (incremental, default), `stream` (full overwrite, pure Node),
`dump` (full overwrite via mysqldump client).

---

## 三种引擎

| | `sync`（默认，推荐） | `stream` | `dump` |
|---|---|---|---|
| 方式 | 逐表比对，只改有差异的行 | 每次整表重建 | mysqldump 导出 + mysql 导入 |
| 服务器要求 | 只要 Node | 只要 Node | 需装 MySQL 客户端 |
| 速度 | 快（无变化时几乎不写） | 中等 | 快 |
| 同步范围 | 表 + 数据 + 视图 | 表 + 数据 + 视图 | 加上存储过程/触发器/事件 |
| 适用场景 | 日常定时同步 | 需要强制一致时 | 需要完整迁移数据库对象 |

## 快速开始

```bash
npm install
cp .env.example .env
vi .env                 # 填入源库、备库的连接信息和库名
npm run check           # 体检：连通性、版本、兼容性、两边表数量
npm run once            # 跑一次（首次建议手动跑，确认无误后再配 cron）
```

`npm run check` 是只读的，不碰任何数据。配置里库名写错时，它会列出该账号可见的所有库，帮你找到真实库名。

## 增量同步是怎么做的

对每张有单列主键的表：

1. 分批取源库的 `主键 + CRC32(整行)`，和目标库比对
2. 目标库没有的行 → `REPLACE INTO`（主键冲突自动解决）
3. 两边都有但 CRC 不同的行 → `REPLACE INTO`（覆盖成源库的值）
4. 目标库有、源库没有的行 → `DELETE`
5. 表结构：缺的列 `ADD`、多的列 `DROP`、类型变了 `MODIFY`
6. 目标库多出来的整张表 → `DROP`

没单列主键的表无法做行级比对，会先比整表摘要（行数 + CRC 之和），一样就跳过，不一样才整表重建。

> 分页用的是**主键游标**，不是 `LIMIT/OFFSET`。同步过程中源库可能正在被写入，OFFSET 会错位漏检。

## 跨版本自适应

两端版本不一致是常态。程序启动时探测目标库能力，据此调整，不需要你手动判断：

| 差异 | 自动处理 |
|---|---|
| 8.0 的 `utf8mb4_0900_ai_ci` / `uca1400_*` 老版本不存在 | 自动映射成目标库支持的等价排序规则 |
| 生成列（MySQL 5.7.6 才有） | 降级成普通列，并把值一起复制 |
| JSON 类型（5.7.8 才有） | 降级成 TEXT |
| 索引超过 767 字节（5.6 `innodb_large_prefix=OFF`） | 三级降级：原样 → `ROW_FORMAT=DYNAMIC` → 前缀索引 |
| 整数显示宽度 `int(11)` vs `int`（8.0.19+ 不再显示） | 归一化后视为相同，不会反复 ALTER |
| 建表时外键引用了还没建的表 | 全程 `FOREIGN_KEY_CHECKS=0` |
| 视图的 `DEFINER` 需要 SUPER 权限 | 自动改成 `DEFINER=CURRENT_USER` |
| 网络抖动 | 关键操作自动重试 |

**已知妥协**（老版本做目标时无法避免）：超长唯一索引会变成前缀索引，唯一性只在字段前若干字符内生效；生成列变成普通列。想彻底消除，把备库升到与源库相同的大版本。

## 冲突自愈清单

这些情况程序会自己处理，不会报错打扰你：

1. 目标表不存在 → 自动建表（含索引降级）
2. 列缺失 / 多余 / 类型不符 → ALTER 增删改
3. 写入时主键冲突 → `REPLACE INTO`
4. 外键约束冲突 → 会话级关闭外键检查
5. 索引过长 → 三级降级
6. 排序规则不兼容 → 映射
7. 生成列 / JSON 不支持 → 降级
8. 严格模式下的数据截断 → 记入问题清单，继续跑其他行
9. 单张表失败 → 记录后继续其他表，最后汇总
10. 网络抖动 → 重试

**只有这些才会发邮件**：连不上数据库、账号权限不足、ALTER/写入始终失败、行数校验对不上。

## 邮件告警

```env
SMTP_HOST=smtp.163.com
SMTP_PORT=465          # 465=SSL 直连，587=STARTTLS
SMTP_USER=you@163.com
SMTP_PASS=授权码        # 163/QQ 邮箱填「授权码」，不是登录密码
MAIL_FROM=you@163.com
MAIL_TO=someone@qq.com
MAIL_ON_SUCCESS=false  # true 则每次成功都发日报
```

邮件正文里的主机地址会自动脱敏（`1.2.*.*`）。

## 部署到服务器

```bash
# 一键部署：拷文件 + 装依赖 + 写 crontab
bash deploy/install.sh

# 或者手动
crontab -e
0 3 * * * cd /opt/copy_database && /usr/bin/node src/index.js --once >> /var/log/mysql-clone.log 2>&1
```

> cron 里务必用 node 的**绝对路径**（`which node` 查），cron 的 PATH 很干净。

Docker 也可以（同样由宿主 cron 触发）：

```bash
docker compose build
docker compose run --rm mysql-clone
```

## 数据库账号需要什么权限

```sql
-- 源库（只读）
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, PROCESS ON *.* TO 'sync_user'@'%';

-- 目标库（读写）
GRANT CREATE, DROP, INSERT, UPDATE, DELETE, ALTER, CREATE VIEW,
      CREATE TEMPORARY TABLES, REFERENCES ON `目标库`.* TO 'sync_user'@'%';
```

## 安全提醒

- `ALLOW_OVERWRITE` 必须为 `true` 才执行 —— 这是防止误连生产库的保险丝
- 同步会**覆盖并可能删除**目标库的数据，第一次跑之前先给目标库留一份备份
- `.env` 含明文密码，已在 `.gitignore` 里，推 GitHub 前用 `git status` 确认它没被列出来
- 日志不记录密码；邮件正文的主机地址会脱敏
- 两个库都建议只放行你服务器的 IP，别把 3306 开放到公网

## 常见问题

**Q：为什么第一次要手动跑一次？**
不是必须，只是建议——确认配置没写错再交给 cron。直接配 cron 也能全自动跑。

**Q：目标库比源库多了几行，删不掉？**
早期版本用 OFFSET 分页时边删边翻页会漏检，已改成主键游标。发现不一致再跑一次就会收敛。

**Q：能实时同步吗？**
不能，也不该。实时同步请用 MySQL 原生主从复制（replication），定时任务定位是 T+1 级别的同步。

**Q：视图之间有依赖关系怎么办？**
引擎会先把所有视图建一遍，失败的再试第二轮，能解决大部分依赖顺序问题。

**Q：日志会不会撑爆磁盘？**
日志按天分文件放在 `logs/`，cron 里加一条定期清理即可（见 `deploy/crontab.example`）。

## 目录结构

```
src/
  config.js          配置读取与校验
  db.js              mysql2 连接封装
  mailer.js          SMTP 邮件告警
  verify.js          行数校验
  notify.js          webhook 通知（企业微信/钉钉）
  job.js             编排：锁 → 同步 → 校验 → 告警
  index.js           CLI：--once 跑一次 / --check 体检
  engines/
    common.js        两端能力探测 + 跨版本适配 + 建表降级
    syncEngine.js    增量同步（默认）
    streamEngine.js  全量覆盖（纯 Node）
    dumpEngine.js    全量覆盖（mysqldump）
deploy/
  install.sh         一键部署
  crontab.example    cron 示例
```

## License

[MIT](LICENSE)
