import os from 'node:os';
import type { Account } from './config';

export function printRuntimeDiagnostic(): void {
  console.log('\n[LOCO DIAGNOSTIC]');
  console.log(`Node      : ${process.version}`);
  console.log(`Platform  : ${process.platform} ${process.arch}`);
  console.log(`OS        : ${os.release()}`);
  console.log('Library   : KakaoForge LOCO transport');
  console.log(`PID       : ${process.pid}`);
  console.log(`Uptime    : ${Math.floor(process.uptime())}s`);
}

export async function testAuthClient(account: Account): Promise<void> {
  console.log('\n[AUTH DIAGNOSTIC]');
  console.log(`Account   : ${account.email}`);
  console.log('Stage     : KakaoForge auth state');
  console.log(`Device UUID: ${account.deviceUuid}`);
  console.log('[INFO] No authentication request is sent by this diagnostic.');
}
