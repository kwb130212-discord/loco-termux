import os from 'node:os';
import { AuthApiClient } from 'node-kakao';
import type { Account } from './config';

export function printRuntimeDiagnostic(): void {
  console.log('\n[LOCO DIAGNOSTIC]');
  console.log(`Node      : ${process.version}`);
  console.log(`Platform  : ${process.platform} ${process.arch}`);
  console.log(`OS        : ${os.release()}`);
  console.log('Library   : node-kakao 4.5.0');
  console.log(`PID       : ${process.pid}`);
  console.log(`Uptime    : ${Math.floor(process.uptime())}s`);
}

export async function testAuthClient(account: Account): Promise<void> {
  console.log('\n[AUTH DIAGNOSTIC]');
  console.log(`Account   : ${account.name}`);
  console.log('Stage     : AuthApiClient.create');
  try {
    const api = await AuthApiClient.create('loco-termux-diagnostic', account.deviceUuid);
    console.log('[OK] AuthApiClient created.');
    console.log('[INFO] No authentication request is sent by this diagnostic.');
    void api;
  } catch (error) {
    console.error('[FAIL] AuthApiClient initialization failed:', error);
  }
}
