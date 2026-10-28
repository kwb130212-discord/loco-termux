require('dotenv').config();
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events,
  GatewayIntentBits, ModalBuilder, REST, Routes, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'LOCO_BRIDGE_URL', 'LOCO_BRIDGE_TOKEN'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error('[config] Missing environment variables:', missing.join(', '));
  process.exit(1);
}
const adminIds = new Set((process.env.DISCORD_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const bridgeBase = process.env.LOCO_BRIDGE_URL.replace(/\/+$/, '');
const bridgeToken = process.env.LOCO_BRIDGE_TOKEN;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });
const roomSelections = new Map();
const selectedRooms = new Map();
const roomPages = new Map();
const pendingMacros = new Map();

const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('매크로 및 연결 상태 제어 패널 열기'),
  new SlashCommandBuilder().setName('자판기').setDescription('상품을 선택하고 구매 티켓 열기'),
  new SlashCommandBuilder().setName('티켓').setDescription('구매·결제 문의 티켓 열기'),
  new SlashCommandBuilder().setName('license').setDescription('내 라이선스 확인'),
  new SlashCommandBuilder().setName('license-issue').setDescription('관리자 전용 라이선스 발급')
    .addStringOption(o => o.setName('discord_user_id').setDescription('라이선스를 받을 Discord 사용자 ID').setRequired(true))
    .addStringOption(o => o.setName('product').setDescription('상품 종류').setRequired(true).addChoices(
      { name: '전체강퇴 검토권 (2회 / 3,000원)', value: 'allkick' },
      { name: '매크로 월간권 (4,000원)', value: 'macro_monthly' },
      { name: '매크로 평생권 (10,000원)', value: 'macro_lifetime' },
    )),
];

async function bridge(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(bridgeBase + path, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + bridgeToken,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { throw new Error('브리지 응답이 JSON 형식이 아닙니다.'); }
    if (!response.ok) throw new Error(body.error || `브리지 오류 (HTTP ${response.status})`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function watchQrLogin(user, expiresAt) {
  const deadline = Number.isFinite(Date.parse(expiresAt)) ? Math.min(Date.parse(expiresAt), Date.now() + 120000) : Date.now() + 120000;
  let codeSent = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    try {
      const status = await bridge('/v1/auth/qr/status');
      if (status.passcode && !codeSent) {
        await user.send('카카오 QR 인증 확인 코드: ' + String(status.passcode) + '\\n카카오톡 인증 화면에서 요청한 코드인지 확인한 뒤 직접 입력하세요.');
        codeSent = true;
      }
      if (status.authenticated) return;
    } catch (error) {
      console.error('[qr-watch]', error instanceof Error ? error.message : String(error));
      return;
    }
  }
}
async function audit(userId, action, detail = {}) {
  const { error } = await supabase.from('control_audit').insert({
    discord_user_id: String(userId), action, detail,
  });
  if (error) console.error('[audit]', error.message);
}

async function activeLicenses(userId) {
  const { data, error } = await supabase.from('licenses')
    .select('id, product, remaining_uses, expires_at, status, created_at')
    .eq('discord_user_id', String(userId)).eq('status', 'active');
  if (error) throw new Error('라이선스 DB 조회 실패: ' + error.message);
  const now = Date.now();
  return (data || []).filter((x) => !x.expires_at || Date.parse(x.expires_at) > now);
}

function canMacro(licenses) {
  return licenses.some((x) => x.product === 'macro_lifetime' ||
    (x.product === 'macro_monthly' && (!x.expires_at || Date.parse(x.expires_at) > Date.now())));
}

async function replyError(interaction, message) {
  const payload = { content: '⚠️ ' + message, ephemeral: true };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

function panelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_rooms').setLabel('매크로 방 선택').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel_qr').setLabel('카카오 연결 QR').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_status').setLabel('연결 상태').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_macros').setLabel('내 매크로 목록').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_license').setLabel('라이선스').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function roomPagePayload(userId) {
  const rooms = roomSelections.get(userId) || [];
  const pages = Math.max(1, Math.ceil(rooms.length / 25));
  const page = Math.min(Math.max(0, roomPages.get(userId) || 0), pages - 1);
  roomPages.set(userId, page);
  const slice = rooms.slice(page * 25, page * 25 + 25);
  const select = new StringSelectMenuBuilder().setCustomId('macro_room_select')
    .setPlaceholder('매크로를 실행할 오픈채팅방 선택').setMinValues(1).setMaxValues(1)
    .addOptions(slice.map((r) => ({
      label: String(r.name).slice(0, 100),
      description: ('방 ID: ' + String(r.id)).slice(0, 100),
      value: String(r.id).slice(0, 100),
    })));
  const rows = [new ActionRowBuilder().addComponents(select)];
  if (pages > 1) rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('macro_rooms_prev').setLabel('이전').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('macro_rooms_next').setLabel('다음').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  ));
  return { content: `확인된 오픈채팅방 ${rooms.length}개 · 페이지 ${page + 1}/${pages}. 방 이름이 같아도 방 ID로 구분됩니다.`, components: rows };
}

async function showRooms(interaction) {
  const licenses = await activeLicenses(interaction.user.id);
  if (!canMacro(licenses)) return replyError(interaction, '매크로 라이선스가 없습니다. 월간권 또는 평생권을 확인하세요.');
  await interaction.deferReply({ ephemeral: true });
  let result;
  try { result = await bridge('/v1/rooms'); }
  catch (e) { return interaction.editReply('실제 오픈채팅방 목록 브리지가 연결되지 않았습니다. 샘플 목록은 표시하지 않았습니다.\\n' + e.message); }
  const rooms = Array.isArray(result.rooms) ? result.rooms.filter((r) => r && r.id && r.name && r.isOpenChat === true) : [];
  if (!rooms.length) return interaction.editReply('연결된 계정에서 확인된 오픈채팅방이 없습니다. 먼저 카카오 연결 및 방 목록 동기화를 완료하세요.');
  roomSelections.set(interaction.user.id, rooms);
  roomPages.set(interaction.user.id, 0);
  return interaction.editReply(roomPagePayload(interaction.user.id));
}
function macroModal(roomId) {
  const modal = new ModalBuilder().setCustomId('macro_modal').setTitle('매크로 메시지 설정');
  const message = new TextInputBuilder().setCustomId('macro_message').setLabel('보낼 메시지')
    .setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(1500).setRequired(true);
  const interval = new TextInputBuilder().setCustomId('macro_interval').setLabel('반복 간격 (분, 최소 10분)')
    .setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(4).setPlaceholder('예: 30').setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(message), new ActionRowBuilder().addComponents(interval));
  return { modal, roomId };
}

async function openTicket(interaction, kind, product) {
  if (!interaction.guild) return replyError(interaction, '서버 안에서만 티켓을 열 수 있습니다.');
  const existing = interaction.guild.channels.cache.find((ch) =>
    ch.type === 0 && ch.topic?.includes('owner:' + interaction.user.id) && ch.topic?.includes('ticket-kind:' + kind));
  if (existing) return interaction.reply({ content: '이미 열린 티켓이 있습니다: ' + existing.toString(), ephemeral: true });
  const categoryId = process.env.DISCORD_TICKET_CATEGORY_ID;
  const staffRoleId = process.env.DISCORD_TICKET_STAFF_ROLE_ID;
  const permissionOverwrites = [
    { id: interaction.guild.roles.everyone.id, deny: ['ViewChannel'] },
    { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles'] },
    { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'] },
  ];
  if (staffRoleId) permissionOverwrites.push({ id: staffRoleId, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] });
  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: 'ticket-' + interaction.user.username.toLowerCase().replace(/[^a-z0-9가-힣-]/g, '').slice(0, 35) + '-' + interaction.user.id.slice(-4),
      type: 0,
      topic: 'owner:' + interaction.user.id + '; ticket-kind:' + kind + (product ? '; product:' + product.product : ''),
      ...(categoryId ? { parent: categoryId } : {}),
      permissionOverwrites,
      reason: 'Private support/purchase ticket',
    });
  } catch (error) {
    console.error('[ticket-create]', error);
    return replyError(interaction, '티켓 채널 생성에 실패했습니다. 봇에 채널 관리 권한이 있는지 확인하세요.');
  }
  if (kind === 'purchase' && product) {
    const { error } = await supabase.from('shop_orders').insert({
      discord_user_id: String(interaction.user.id),
      product: product.product,
      amount_krw: product.price,
      status: 'pending',
      ticket_channel_id: channel.id,
    });
    if (error) {
      await channel.delete('Order DB insert failed').catch(() => {});
      return replyError(interaction, '주문 저장 실패: ' + error.message);
    }
    await audit(interaction.user.id, 'shop_order_created', { product: product.product, amountKrw: product.price, ticketChannelId: channel.id });
  }
  const title = kind === 'purchase' && product ? '구매 신청 티켓' : '고객 지원 티켓';
  const details = kind === 'purchase' && product
    ? '\\n상품: **' + product.label + '**\\n금액: **' + product.price.toLocaleString('ko-KR') + '원**\\n상태: **결제 대기**\\n\\n운영진이 결제 방법을 안내합니다. 결제 확인 전에는 라이선스가 발급되지 않습니다.'
    : '\\n문의 내용을 남겨 주세요. 운영진이 확인합니다.';
  await channel.send({
    content: '<@' + interaction.user.id + '> ' + (staffRoleId ? '<@&' + staffRoleId + '>' : ''),
    embeds: [{
      title,
      description: '작성자: <@' + interaction.user.id + '>' + details,
    }],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_close').setLabel('티켓 종료').setStyle(ButtonStyle.Danger),
    )],
  });
  return interaction.reply({ content: '비공개 티켓을 만들었습니다: ' + channel.toString(), ephemeral: true });
}

async function showLicense(interaction) {
  const rows = await activeLicenses(interaction.user.id);
  const names = { allkick: '전체강퇴 검토권 (2회)', macro_monthly: '매크로 월간권', macro_lifetime: '매크로 평생권' };
  const text = rows.length ? rows.map((x) => {
    const uses = x.product === 'allkick' ? ` · 잔여 ${x.remaining_uses ?? 0}회` : '';
    const expires = x.expires_at ? ` · 만료 ${new Date(x.expires_at).toLocaleString('ko-KR')}` : '';
    return `• ${names[x.product] || x.product}${uses}${expires}`;
  }).join('\n') : '활성 라이선스가 없습니다.';
  return interaction.reply({ content: '**내 라이선스**\n' + text, ephemeral: true });
}

async function issueLicense(interaction) {
  if (!adminIds.has(interaction.user.id)) return replyError(interaction, '이 명령은 설정된 Discord 관리자만 사용할 수 있습니다.');
  const userId = interaction.options.getString('discord_user_id', true).trim();
  const product = interaction.options.getString('product', true);
  if (!/^\d{17,20}$/.test(userId)) return replyError(interaction, 'Discord 사용자 ID 형식이 올바르지 않습니다.');
  const expiresAt = product === 'macro_monthly' ? new Date(Date.now() + 30 * 86400000).toISOString() : null;
  const remainingUses = product === 'allkick' ? 2 : null;
  const { error } = await supabase.from('licenses').insert({
    discord_user_id: userId, product, remaining_uses: remainingUses, expires_at: expiresAt,
    status: 'active', created_by: interaction.user.id,
  });
  if (error) return replyError(interaction, '라이선스 저장 실패: ' + error.message);
  await audit(interaction.user.id, 'license_issue', { targetUserId: userId, product });
  return interaction.reply({ content: `라이선스를 발급했습니다: ${product} → <@${userId}>. 실제 결제 여부는 별도로 확인해야 합니다.`, ephemeral: true });
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') {
        return interaction.reply({
          content: '**LOCO-Termux 제어 패널**\n매크로는 연결된 계정이 실제로 조회한 오픈채팅방에서만 설정할 수 있습니다. QR은 Discord DM으로 전달됩니다.',
          components: panelRows(), ephemeral: true,
        });
      }
      if (interaction.commandName === 'license') return await showLicense(interaction);
      if (interaction.commandName === '자판기') {
        return interaction.reply({
          content: '**LOCO 자판기**\\n상품을 선택하면 본인과 운영진만 볼 수 있는 구매 티켓이 열립니다. 결제 확인 전에는 라이선스가 발급되지 않습니다.',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('shop_macro_monthly').setLabel('매크로 월간권 · 4,000원').setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId('shop_macro_lifetime').setLabel('매크로 평생권 · 10,000원').setStyle(ButtonStyle.Primary),
            ),
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('shop_allkick').setLabel('전체강퇴 검토권 2회 · 3,000원').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('ticket_general').setLabel('구매/결제 문의').setStyle(ButtonStyle.Secondary),
            ),
          ],
          ephemeral: true,
        });
      }
      if (interaction.commandName === '티켓') return await openTicket(interaction, 'support', null);
      if (interaction.commandName === 'license-issue') return await issueLicense(interaction);
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'ticket_general') return await openTicket(interaction, 'support', null);
      if (interaction.customId.startsWith('shop_')) {
        const product = interaction.customId.slice(5);
        const products = {
          allkick: { label: '전체강퇴 검토권 2회', price: 3000 },
          macro_monthly: { label: '매크로 월간권', price: 4000 },
          macro_lifetime: { label: '매크로 평생권', price: 10000 },
        };
        if (!products[product]) return replyError(interaction, '알 수 없는 상품입니다.');
        return await openTicket(interaction, 'purchase', { product, ...products[product] });
      }
      if (interaction.customId === 'ticket_close') {
        if (!interaction.channel || !interaction.channel.name.startsWith('ticket-')) return replyError(interaction, '티켓 채널에서만 사용할 수 있습니다.');
        const member = interaction.member;
        const isStaff = adminIds.has(interaction.user.id) ||
          (process.env.DISCORD_TICKET_STAFF_ROLE_ID && member?.roles?.cache?.has(process.env.DISCORD_TICKET_STAFF_ROLE_ID));
        const isOwner = interaction.channel.topic?.includes('owner:' + interaction.user.id);
        if (!isStaff && !isOwner) return replyError(interaction, '티켓 작성자 또는 운영진만 종료할 수 있습니다.');
        await interaction.reply({ content: '티켓을 종료합니다. 이 채널은 5초 후 삭제됩니다.' });
        setTimeout(() => interaction.channel?.delete('Ticket closed').catch(() => {}), 5000);
        return;
      }
      if (interaction.customId === 'panel_rooms') return await showRooms(interaction);
      if (interaction.customId === 'macro_rooms_prev' || interaction.customId === 'macro_rooms_next') {
        const rooms = roomSelections.get(interaction.user.id);
        if (!rooms) return replyError(interaction, '방 목록이 만료됐습니다. 다시 조회하세요.');
        const pages = Math.max(1, Math.ceil(rooms.length / 25));
        const current = roomPages.get(interaction.user.id) || 0;
        roomPages.set(interaction.user.id, Math.min(pages - 1, Math.max(0, current + (interaction.customId === 'macro_rooms_next' ? 1 : -1))));
        return interaction.update(roomPagePayload(interaction.user.id));
      }
      if (interaction.customId === 'panel_license') return await showLicense(interaction);
      if (interaction.customId === 'panel_qr') {
        await interaction.deferReply({ ephemeral: true });
        let qr;
        try { qr = await bridge('/v1/auth/qr', { method: 'POST', body: JSON.stringify({ discordUserId: interaction.user.id }) }); }
        catch (e) { return interaction.editReply('QR 브리지가 연결되지 않았습니다. OAuth 로그인만으로 오픈채팅 세션이 생성됐다고 가정하지 않습니다.\n' + e.message); }
        if (!qr.qrDataUrl || !String(qr.qrDataUrl).startsWith('data:image/')) return interaction.editReply('브리지가 유효한 QR 이미지를 반환하지 않았습니다.');
        const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(qr.qrDataUrl);
        if (!match) return interaction.editReply('QR 이미지 형식이 올바르지 않습니다.');
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const attachment = new AttachmentBuilder(Buffer.from(match[2], 'base64'), { name: 'kakao-login-qr.' + ext });
        try {
          await interaction.user.send({ content: `카카오 연결 QR\n만료: ${qr.expiresAt || '브리지 제공 정보 없음'}\n본인이 시작한 로그인 요청인지 확인하고 직접 스캔하세요.`, files: [attachment] });
          void watchQrLogin(interaction.user, qr.expiresAt);
          return interaction.editReply('QR을 Discord DM으로 전송했습니다. 인증 확인 코드가 필요한 경우 DM으로 추가 전달됩니다.');
        } catch { return interaction.editReply('Discord DM 전송에 실패했습니다. DM 수신 설정을 확인하세요.'); }
      }
      if (interaction.customId === 'panel_status') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const status = await bridge('/v1/auth/status');
          return interaction.editReply(`카카오 연결: ${status.authenticated ? '인증됨' : '미인증'}\n계정: ${status.nickname || '확인 불가'}`);
        } catch (e) { return interaction.editReply('연결 상태 브리지 미구현/접속 불가: ' + e.message); }
      }
      if (interaction.customId.startsWith('macro_stop_')) {
        const id = interaction.customId.slice('macro_stop_'.length);
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) return replyError(interaction, '매크로 ID 형식이 올바르지 않습니다.');
        await interaction.deferReply({ ephemeral: true });
        try {
          await bridge('/v1/macros/' + encodeURIComponent(id) + '?requestedBy=' + encodeURIComponent(interaction.user.id), { method: 'DELETE' });
          await audit(interaction.user.id, 'macro_stop', { macroId: id });
          return interaction.editReply('매크로를 정지했습니다.');
        } catch (e) { return interaction.editReply('정지 실패: ' + e.message); }
      }
      if (interaction.customId === 'panel_macros') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const result = await bridge('/v1/macros');
          const macros = Array.isArray(result.macros) ? result.macros.filter((m) => String(m.createdBy || '') === interaction.user.id) : [];
          const visible = macros.slice(-5).reverse();
          const content = visible.length ? visible.map((m) => `• ${m.roomName || m.roomId} — ${m.intervalMinutes}분 간격 — ${m.enabled === false ? '정지' : '실행'} — ID ${m.id}`).join('\n') : '등록된 매크로가 없습니다.';
          const components = visible.filter((m) => m.enabled !== false).slice(0, 5).map((m) => new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('macro_stop_' + String(m.id)).setLabel('정지: ' + String(m.roomName || m.roomId).slice(0, 50)).setStyle(ButtonStyle.Danger),
          ));
          return interaction.editReply({ content, components });
        } catch (e) { return interaction.editReply('매크로 목록 브리지 미구현/접속 불가: ' + e.message); }
      }
      if (interaction.customId === 'macro_confirm') {
        const pending = pendingMacros.get(interaction.user.id);
        if (!pending || pending.expiresAt < Date.now()) {
          pendingMacros.delete(interaction.user.id);
          return replyError(interaction, '설정이 만료됐습니다. 방 선택부터 다시 진행하세요.');
        }
        const licenses = await activeLicenses(interaction.user.id);
        if (!canMacro(licenses)) return replyError(interaction, '매크로 라이선스가 만료됐거나 없습니다.');
        await interaction.deferReply({ ephemeral: true });
        try {
          const result = await bridge('/v1/macros', { method: 'POST', body: JSON.stringify({
            roomId: pending.roomId, message: pending.message, intervalMinutes: pending.intervalMinutes,
            requestedBy: interaction.user.id, requireRoomMembership: true, requireOpenChat: true,
          }) });
          pendingMacros.delete(interaction.user.id);
          await audit(interaction.user.id, 'macro_create', { macroId: result.id, roomId: pending.roomId, intervalMinutes: pending.intervalMinutes });
          return interaction.editReply(`매크로 등록 완료: ${result.id || 'ID 확인 불가'}`);
        } catch (e) { return interaction.editReply('등록 실패 — 브리지가 실제 전송 지원을 제공하지 않거나 오류가 발생했습니다.\n' + e.message); }
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'macro_room_select') {
      const rooms = roomSelections.get(interaction.user.id) || [];
      const room = rooms.find((r) => String(r.id) === interaction.values[0]);
      if (!room) return replyError(interaction, '방 목록이 만료됐습니다. 다시 조회하세요.');
      if (room.isOpenChat !== true) return replyError(interaction, '오픈채팅으로 확인된 방만 선택할 수 있습니다.');
      const { modal } = macroModal(String(room.id));
      selectedRooms.set(interaction.user.id, room);
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'macro_modal') {
      const room = selectedRooms.get(interaction.user.id);
      if (!room) return replyError(interaction, '선택한 방 정보가 만료됐습니다. 다시 선택하세요.');
      const message = interaction.fields.getTextInputValue('macro_message').trim();
      const intervalMinutes = Number(interaction.fields.getTextInputValue('macro_interval').trim());
      if (!message || message.length > 1500) return replyError(interaction, '메시지는 1~1500자로 입력하세요.');
      if (/@everyone|@here/.test(message)) return replyError(interaction, '@everyone / @here 멘션은 매크로에 사용할 수 없습니다.');
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 10 || intervalMinutes > 1440) return replyError(interaction, '반복 간격은 10~1440분 범위의 정수여야 합니다.');
      pendingMacros.set(interaction.user.id, { roomId: String(room.id), roomName: String(room.name), message, intervalMinutes, expiresAt: Date.now() + 5 * 60 * 1000 });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('macro_confirm').setLabel('확인 후 등록').setStyle(ButtonStyle.Success),
      );
      return interaction.reply({
        content: `**매크로 등록 확인**\n방: ${room.name} (${room.id})\n간격: ${intervalMinutes}분\n메시지:\n${message.slice(0, 1600)}\n\n등록을 누르면 연결된 브리지로 설정이 전송됩니다. 브리지가 없는 경우 등록되지 않습니다.`,
        components: [row], ephemeral: true,
      });
    }
  } catch (error) {
    console.error('[interaction]', error);
    await replyError(interaction, error instanceof Error ? error.message : '알 수 없는 오류');
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[discord] Logged in as ${readyClient.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands.map((x) => x.toJSON()) });
    console.log('[discord] Slash commands registered');
  } catch (error) {
    console.error('[discord] Slash command registration failed:', error);
  }
});

client.on(Events.Error, (error) => console.error('[discord] client error', error));
process.on('unhandledRejection', (error) => console.error('[process] unhandled rejection', error));
client.login(process.env.DISCORD_TOKEN);
