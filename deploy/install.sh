#!/usr/bin/env bash
# ============================================================
#  copy_database 一键部署到服务器
#
#  用法（在服务器上执行）：
#    bash install.sh
#  可选环境变量：
#    INSTALL_DIR=/opt/copy_database   安装目录
#    CRON_SCHEDULE="0 3 * * *"        定时任务表达式，留空则不装 cron
# ============================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/copy_database}"
CRON_SCHEDULE="${CRON_SCHEDULE:-0 3 * * *}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 安装目录: ${INSTALL_DIR}"

# 1. 检查 node
if ! command -v node >/dev/null 2>&1; then
  echo "错误：没找到 node，请先安装 Node.js >= 20（推荐用 nvm 或官方二进制包）" >&2
  exit 1
fi
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "错误：当前 node 版本 $(node -v)，需要 >= 20" >&2
  exit 1
fi
echo "==> node $(node -v)，路径 $(command -v node)"

# 2. 拷贝项目文件（跳过本地运行产生的东西）
mkdir -p "${INSTALL_DIR}"
cd "${SRC_DIR}"
tar \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./logs' \
  --exclude='./dumps' \
  --exclude='./.env' \
  -cf - . | tar -xf - -C "${INSTALL_DIR}"
echo "==> 文件已复制到 ${INSTALL_DIR}"

# 3. 安装依赖
cd "${INSTALL_DIR}"
npm install --omit=dev --no-audit --no-fund
echo "==> 依赖安装完成"

# 4. 配置文件
if [ ! -f "${INSTALL_DIR}/.env" ]; then
  if [ -f "${SRC_DIR}/.env" ]; then
    cp "${SRC_DIR}/.env" "${INSTALL_DIR}/.env"
    echo "==> 已沿用现有 .env"
  else
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    echo "==> 已从模板创建 .env，请编辑填入数据库信息："
    echo "    vi ${INSTALL_DIR}/.env"
  fi
else
  echo "==> .env 已存在，保持不变"
fi
chmod 600 "${INSTALL_DIR}/.env"

# 5. 装 cron
if [ -n "${CRON_SCHEDULE}" ]; then
  NODE_BIN="$(command -v node)"
  CRON_LINE="${CRON_SCHEDULE} cd ${INSTALL_DIR} && ${NODE_BIN} src/index.js --once >> ${INSTALL_DIR}/logs/cron.log 2>&1"
  mkdir -p "${INSTALL_DIR}/logs"
  # 先删掉本项目旧的 cron 行，再追加新的，避免重复
  ( crontab -l 2>/dev/null | grep -v "copy_database\|${INSTALL_DIR}" || true
    echo "${CRON_LINE}" ) | crontab -
  echo "==> 已写入 crontab: ${CRON_LINE}"
else
  echo "==> 跳过 cron 安装（CRON_SCHEDULE 为空）"
fi

echo
echo "==> 部署完成。下一步："
echo "    1) 确认 .env 里的数据库信息：vi ${INSTALL_DIR}/.env"
echo "    2) 体检：cd ${INSTALL_DIR} && npm run check"
echo "    3) 手动跑一次：cd ${INSTALL_DIR} && npm run once"
echo "    4) 看日志：tail -f ${INSTALL_DIR}/logs/*.log"
