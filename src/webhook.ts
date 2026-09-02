import type { Config } from './config';

export type WebhookLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

function validDiscordWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'discord.com' && /^\/api\/webhooks\/\d+\/[^/]+/.test(u.pathname);
  } catch { return false; }
}

export async function sendWebhook(config: Config, title: string, message: string, level: WebhookLevel = 'INFO'): Promise<void> {
  const url = config.webhook?.url?.trim();
  if (!config.webhook?.enabled || !url) return;
  if (!validDiscordWebhook(url)) {
    console.error('[WEBHOOK] Discord webhook URL이 아니므로 전송하지 않았습니다.');
    return;
  }
  const body = {
    username: config.webhook.username || 'LOCO-Termux Logger',
    allowed_mentions: { parse: [] as string[] },
    embeds: [{
      title: `[${level}] ${title}`,
      description: message.slice(0, 4000),
      timestamp: new Date().toISOString(),
    }],
  };
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) console.error(`[WEBHOOK] 전송 실패: HTTP ${response.status}`);
  } catch (error) {
    console.error('[WEBHOOK] 전송 오류:', error instanceof Error ? error.message : error);
  }
}

export function maskAccount(email: string): string {
  if (email.includes('@')) {
    const [name, domain] = email.split('@', 2);
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return email.length > 4 ? `${email.slice(0, 2)}***${email.slice(-2)}` : '***';
}
