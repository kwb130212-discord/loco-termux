import { AuthApiClient, api } from 'node-kakao';

/**
 * Compatibility configuration for current KakaoTalk authentication servers.
 * Values can be overridden without editing source:
 *   LOCO_AGENT=android
 *   LOCO_APP_VERSION=26.5.0
 *   LOCO_DEVICE_MODEL=SM-T976N
 *   LOCO_MCCMNC=999
 *   LOCO_NET_TYPE=0
 */
const config = {
  agent: process.env.LOCO_AGENT || 'android',
  mccmnc: process.env.LOCO_MCCMNC || '999',
  deviceModel: process.env.LOCO_DEVICE_MODEL || 'SM-T976N',
  appVersion: process.env.LOCO_APP_VERSION || '26.5.0',
  version: process.env.LOCO_APP_VERSION || '26.5.0',
  netType: Number(process.env.LOCO_NET_TYPE || '0'),
  subDevice: true,
};

const originalCreate = AuthApiClient.create.bind(AuthApiClient);
(AuthApiClient as any).create = async (
  name: string,
  deviceUUID: string,
  existingConfig: Record<string, unknown> = {},
  xvcProvider?: unknown,
) => {
  const merged = { ...config, ...existingConfig };
  return originalCreate(
    name,
    deviceUUID,
    merged as any,
    xvcProvider || api.xvc.AndroidSubXVCProvider,
  );
};

console.log(
  `[AUTH] client=${config.agent} version=${config.version} model=${config.deviceModel} net=${config.netType}`,
);
