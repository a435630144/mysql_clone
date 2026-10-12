FROM node:22-bookworm-slim

# default-mysql-client 提供 mysqldump / mysql 客户端（Debian 上它是 MariaDB 版，
# 项目已自动识别并跳过它不支持的参数）。
# 如果你用 CLONE_ENGINE=stream，这一行可以删掉，镜像更小。
RUN apt-get update \
 && apt-get install -y --no-install-recommends default-mysql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production
# 跑完一次就退出，定时由宿主机的 cron 触发（见 deploy/crontab.example）
CMD ["node", "src/index.js", "--once"]
