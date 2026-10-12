import { config } from './config.js';
import { logger } from './logger.js';

/**
 * 把成功/失败结果推送到 webhook。
 * 自动适配企业微信、钉钉机器人的文本消息格式，其他地址则发通用 JSON。
 */
export async function notify({ success, title, details }) {
  const url = config.notifyWebhook;
  if (!url) return false;

  const text = [`[数据库克隆] ${success ? '成功' : '失败'} - ${title}`, details].filter(Boolean).join('\n');

  let body;
  if (url.includes('qyapi.weixin.qq.com') || url.includes('oapi.dingtalk.com')) {
    body = { msgtype: 'text', text: { content: text } };
  } else {
    body = { success, title, text, time: new Date().toISOString() };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn(`通知发送返回非 2xx: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`通知发送失败: ${err.message}`);
    return false;
  }
}
