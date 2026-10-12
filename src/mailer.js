import nodemailer from 'nodemailer';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * 邮件告警：只在「程序自己解决不了」的时候发。
 * 常见的兼容性冲突（排序规则、索引过长、生成列、主键冲突等）引擎已经自动处理，不会打扰你。
 */

function createTransport() {
  const port = Number(config.smtp.port);
  return nodemailer.createTransport({
    host: config.smtp.host,
    port,
    // 465 是 SMTPS（直连 SSL），587 是 STARTTLS
    secure: port === 465,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

export function mailEnabled() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass && config.mailTo);
}

/** 把 hosts 脱敏，避免邮件正文里出现完整的服务器地址 */
function mask(host) {
  if (!host) return '(未配置)';
  const ipLike = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (ipLike) {
    const parts = host.split('.');
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  const parts = host.split('.');
  return parts.length > 2 ? `${parts[0]}.***.${parts[parts.length - 1]}` : host;
}

function buildHtml({ title, lines, problems }) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const rows = problems?.length
    ? `<h3>未能自动处理的问题（${problems.length}）</h3>
       <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
       <tr><th>对象</th><th>操作</th><th>错误</th></tr>
       ${problems
         .slice(0, 50)
         .map((p) => `<tr><td>${esc(p.table)}</td><td>${esc(p.action)}</td><td>${esc(p.error)}</td></tr>`)
         .join('')}
       </table>`
    : '';

  return `<div style="font-family:-apple-system,'Microsoft YaHei',sans-serif">
    <h2 style="color:${problems?.length ? '#c0392b' : '#27ae60'}">${esc(title)}</h2>
    <pre style="background:#f6f8fa;padding:12px;border-radius:6px">${esc(lines.join('\n'))}</pre>
    ${rows}
    <p style="color:#888;font-size:12px">本邮件由 copy_database 自动发送，主机地址已脱敏。</p>
  </div>`;
}

export async function sendMail({ subject, title, lines, problems = [] }) {
  if (!mailEnabled()) {
    logger.warn('未配置完整的 SMTP 信息，跳过邮件告警');
    return false;
  }

  const text = [title, '', ...lines, '', ...problems.slice(0, 50).map((p) => `[${p.table}] ${p.action}: ${p.error}`)].join(
    '\n',
  );

  try {
    const info = await createTransport().sendMail({
      from: config.smtp.from || config.smtp.user,
      to: config.mailTo,
      subject,
      text,
      html: buildHtml({ title, lines, problems }),
    });
    logger.info(`告警邮件已发送: ${info.messageId}`);
    return true;
  } catch (err) {
    logger.error(`邮件发送失败: ${err.message}`);
    return false;
  }
}

/** 汇总信息里的固定抬头，统一脱敏 */
export function summaryLines(extra = []) {
  return [
    `源库: ${mask(config.source.host)} / ${config.source.database}`,
    `目标库: ${mask(config.target.host)} / ${config.target.database}`,
    `引擎: ${config.engine}`,
    `时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ...extra,
  ];
}
