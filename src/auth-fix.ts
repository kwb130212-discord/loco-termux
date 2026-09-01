import { AuthApiClient, api } from 'node-kakao';

/**
 * Authentication compatibility/diagnostic layer.
 *
 * Do not hard-code a guessed KakaoTalk version here. A stale or fabricated
 * version can itself trigger -999 (upgrade required). Values may be supplied
 * by the user/environment when they are known to be valid:
 *   LOCO_AGENT=android
 *   LOCO_APP_VERSION=...
 *   LOCO_DEVICE_MODEL=...
 *   LOCO_MCCMNC=...
 *   LOCO_NET_TYPE=...
 *
 * When a value is not supplied, node-kakao's own defaults are preserved.
 */
const overrides: Record<string, unknown> = {};

if (process.env.LOCO_AGENT) overrides.agent = process.env.LOCO_AGENT;
if (process.env.LOCO_APP_VERSION) {
  overrides.appVersion = process.env.LOCO_APP_VERSION;
  overrides.version = process.env.LOCO_APP_VERSION;
}
if (process.env.LOCO_DEVICE_MODEL) overrides.deviceModel = process.env.LOCO_DEVICE_MODEL;
if (process.env.LOCO_MCCMNC) overrides.mccmnc = process.env.LOCO_MCCMNC;
if (process.env.LOCO_NET_TYPE) {
  const netType = Number(process.env.LOCO_NET_TYPE);
  if (Number.isFinite(netType)) overrides.netType = netType;
}

const originalCreate = AuthApiClient.create.bind(AuthApiClient);
(AuthApiClient as any).create = async (
  name: string,
  deviceUUID: string,
  existingConfig: Record<string, unknown> = {},
  xvcProvider?: unknown,
) => {
  const merged = { ...existingConfig, ...overrides };
  console.log(
    `[AUTH] agent=${String(merged.agent ?? 'default')} ` +
    `appVersion=${String(merged.appVersion ?? 'default')} ` +
    `deviceModel=${String(merged.deviceModel ?? 'default')}`,
  );

  return originalCreate(
    name,
    deviceUUID,
    merged as any,
    xvcProvider || api.xvc.AndroidSubXVCProvider,
  );
};
