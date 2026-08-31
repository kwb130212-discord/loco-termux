import 'dotenv/config';
import {
  AuthApiClient,
  TalkClient,
} from 'node-kakao';

const EMAIL = process.env.KAKAO_EMAIL;
const PASSWORD = process.env.KAKAO_PASSWORD;
const DEVICE_NAME = process.env.KAKAO_DEVICE_NAME || 'loco-termux';
const DEVICE_UUID = process.env.KAKAO_DEVICE_UUID;
const PREFIX = process.env.PREFIX || '!';

if (!EMAIL || !PASSWORD || !DEVICE_UUID) {
  throw new Error('KAKAO_EMAIL, KAKAO_PASSWORD and KAKAO_DEVICE_UUID are required.');
}

const client = new TalkClient();

client.on('chat', async (data, channel) => {
  const text = data.text?.trim();
  if (!text || !text.startsWith(PREFIX)) return;

  const commandLine = text.slice(PREFIX.length).trim();
  const [command, ...args] = commandLine.split(/\s+/);
  const cmd = command?.toLowerCase();

  if (cmd === 'ping') {
    await channel.sendChat('Pong!');
    return;
  }

  if (cmd === 'help') {
    await channel.sendChat([
      '📖 명령어',
      `${PREFIX}ping - 봇 응답 확인`,
      `${PREFIX}help - 명령어 목록`,
      `${PREFIX}echo <내용> - 입력 내용 반복`,
      `${PREFIX}args <값...> - 인자 확인`,
    ].join('\n'));
    return;
  }

  if (cmd === 'echo') {
    const value = args.join(' ').trim();
    await channel.sendChat(value || '사용법: !echo <내용>');
    return;
  }

  if (cmd === 'args') {
    await channel.sendChat(args.length ? args.join(' | ') : '인자가 없습니다.');
  }
});

client.on('error', (error) => {
  console.error('[node-kakao] error:', error);
});

async function main(): Promise<void> {
  console.log('[BOOT] node-kakao bot starting...');

  const api = await AuthApiClient.create(DEVICE_NAME, DEVICE_UUID);
  const loginRes = await api.login({
    email: EMAIL,
    password: PASSWORD,
    forced: false,
  });

  if (!loginRes.success) {
    throw new Error(`Web login failed: ${loginRes.status}`);
  }

  const result = await client.login(loginRes.result);
  if (!result.success) {
    throw new Error(`KakaoTalk login failed: ${result.status}`);
  }

  console.log('[BOOT] Login success. Bot is online.');
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
