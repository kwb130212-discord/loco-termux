import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const C = { reset: '\x1b[0m', cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', white: '\x1b[37m', dim: '\x1b[2m', bold: '\x1b[1m' };
const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'kakaoforge-auth.json');
const PID_PATH = join(DATA_DIR, 'openchat.pid');
const DESIRED_PATH = join(DATA_DIR, 'openchat.desired');
const LOG_PATH = join(DATA_DIR, 'openchat.log');

mkdirSync(DATA_DIR, { recursive: true });

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
}
function clear() { process.stdout.write('\x1b[2J\x1b[H'); }
function title(text: string) {
  console.log(`${C.cyan}${C.bold}╔══════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.cyan}${C.bold}║${C.reset} ${C.white}${C.bold}${text.padEnd(52)}${C.reset}${C.cyan}${C.bold}║${C.reset}`);
  console.log(`${C.cyan}${C.bold}╚══════════════════════════════════════════════════════╝${C.reset}`);
}
function runPython(args: string[], timeout = 120_000) {
  const py = process.env.PYTHON_BIN || (existsSync('/data/data/com.termux/files/usr/bin/python3') ? 'python3' : 'python');
  return spawnSync(py, ['방관리_cli.py', ...args], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
}
function printResult(result: ReturnType<typeof runPython>) {
  if (result.stdout?.trim()) console.log(result.stdout.trim());
  if (result.stderr?.trim()) console.error(`${C.yellow}${result.stderr.trim()}${C.reset}`);
  if (result.error) console.error(`${C.red}실행 오류: ${result.error.message}${C.reset}`);
  if (result.status !== 0 && result.status !== null) console.error(`${C.red}종료 코드: ${result.status}${C.reset}`);
}
async function pause() { await ask(`\n${C.dim}엔터를 누르면 메뉴로 돌아갑니다...${C.reset}`); }

function readPid(): number | null {
  try { const n = Number(readFileSync(PID_PATH, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
}
function processAlive(pid: number | null): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function desiredRunning(): boolean { try { return readFileSync(DESIRED_PATH, 'utf8').trim() === '1'; } catch { return false; } }
function setDesired(value: boolean) { writeFileSync(DESIRED_PATH, value ? '1' : '0', 'utf8'); }
function clearPid() { try { unlinkSync(PID_PATH); } catch {} }
function runtimeStatus(): 'RUNNING' | 'STOPPED' | 'CRASHED' { const pid = readPid(); if (processAlive(pid)) return 'RUNNING'; return desiredRunning() ? 'CRASHED' : 'STOPPED'; }

function startRuntime(): boolean {
  if (!existsSync(AUTH_PATH)) { console.log(`${C.yellow}⚠ 먼저 QR 로그인으로 인증 세션을 만들어야 합니다.${C.reset}`); return false; }
  const current = readPid();
  if (processAlive(current)) { setDesired(true); console.log(`${C.green}● OpenChat 런타임이 이미 실행 중입니다. PID=${current}${C.reset}`); return true; }
  clearPid();
  setDesired(true);
  const logFd = openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, ['dist/openchat-main.js'], {
    cwd: process.cwd(), detached: true, stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  if (!child.pid) { setDesired(false); return false; }
  writeFileSync(PID_PATH, String(child.pid), 'utf8');
  child.unref();
  console.log(`${C.green}✓ OpenChat 런타임 시작: PID=${child.pid}${C.reset}`);
  console.log(`${C.dim}로그: ${LOG_PATH}${C.reset}`);
  return true;
}
function stopRuntime(): boolean {
  setDesired(false);
  const pid = readPid();
  if (!pid) { clearPid(); console.log(`${C.dim}이미 정지 상태입니다.${C.reset}`); return true; }
  if (!processAlive(pid)) { clearPid(); console.log(`${C.dim}이미 종료된 런타임입니다.${C.reset}`); return true; }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { console.error(`${C.red}정지 실패: ${e instanceof Error ? e.message : String(e)}${C.reset}`); return false; }
  setTimeout(() => { if (processAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } clearPid(); }, 1500).unref();
  console.log(`${C.green}✓ OpenChat 런타임 정지 요청 완료${C.reset}`);
  return true;
}
function restartRuntime(): boolean { stopRuntime(); return startRuntime(); }
function runtimeInfo() {
  const status = runtimeStatus(); const pid = readPid();
  const label = status === 'RUNNING' ? `${C.green}● RUNNING${C.reset}` : status === 'CRASHED' ? `${C.red}● CRASHED → 자동복구 대기${C.reset}` : `${C.dim}○ STOPPED${C.reset}`;
  console.log(`런타임: ${label}`); console.log(`PID: ${pid ?? '-'}  자동실행: ${desiredRunning() ? 'ON' : 'OFF'}`);
  console.log(`인증: ${existsSync(AUTH_PATH) ? 'OK' : '없음'}`); console.log(`로그: ${LOG_PATH}`);
}
function startWatchdog() {
  const timer = setInterval(() => {
    if (!desiredRunning() || processAlive(readPid())) return;
    console.log(`${C.yellow}[WATCHDOG] OpenChat 런타임 종료 감지 → 2초 후 재시작${C.reset}`);
    setTimeout(() => { if (desiredRunning() && !processAlive(readPid())) startRuntime(); }, 2000).unref();
  }, 3000);
  timer.unref();
}

async function roomList() { clear(); title('ROOM CENTER  /  등록된 방 전체보기'); printResult(runPython(['rooms'])); await pause(); }
async function roomAdd() { clear(); title('ROOM CENTER  /  방 등록'); const room = await ask('방 ID(또는 현재 시스템에서 사용하는 방 식별자): '); if (!room) return; printResult(runPython(['add', room])); await pause(); }
async function roomToggle(enable: boolean) { clear(); title(`ROOM CENTER  /  ${enable ? '방 활성화' : '방 비활성화'}`); const room = await ask('방 ID: '); if (!room) return; printResult(runPython([enable ? 'enable' : 'disable', room])); await pause(); }
async function roomRemove() { clear(); title('ROOM CENTER  /  방 등록 해제'); const room = await ask('방 ID: '); if (!room) return; const confirm = await ask(`정말 '${room}' 등록을 해제할까요? (y/N): `); if (confirm.toLowerCase() !== 'y') return; printResult(runPython(['remove', room])); await pause(); }
async function members() { clear(); title('MEMBER CENTER  /  현재 확인된 멤버'); const room = await ask('방 ID: '); if (!room) return; printResult(runPython(['members', room])); await pause(); }
async function readers() { clear(); title('READ CENTER  /  메시지 읽은 사람'); const id = await ask('메시지 ID: '); if (!id) return; printResult(runPython(['readers', id])); await pause(); }
async function exportData(departed = false) { clear(); title(departed ? 'EXPORT CENTER  /  나간 사람 내보내기' : 'EXPORT CENTER  /  전체 데이터 내보내기'); const room = await ask('방 ID (전체는 엔터): '); const format = (await ask('형식 json/csv [json]: ')).toLowerCase() || 'json'; if (!['json', 'csv'].includes(format)) { console.log('json 또는 csv만 가능합니다.'); await pause(); return; } const defaultName = departed ? `loco-departed.${format}` : `loco-export.${format}`; const output = await ask(`파일명 [${defaultName}]: `) || defaultName; const args = departed ? ['departed-export', ...(room ? ['--room-id', room] : []), '--format', format, '--output', output] : ['export', ...(room ? ['--room-id', room] : []), '--format', format, '--output', output]; printResult(runPython(args)); await pause(); }

async function launchInteractive(command: string, args: string[] = []) {
  console.log(`${C.green}▶ ${command} ${args.join(' ')} 실행${C.reset}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
  if (result.error) console.error(`${C.red}${result.error.message}${C.reset}`);
  if (result.status !== 0 && result.status !== null) console.error(`${C.red}프로세스 종료 코드: ${result.status}${C.reset}`);
  return result.status === 0;
}

async function loginMenu(): Promise<boolean> {
  clear(); title('AUTH CENTER  /  LOGIN FIRST');
  const hasSavedAuth = existsSync(AUTH_PATH);
  if (hasSavedAuth) {
    console.log(`${C.green}●${C.reset} 저장된 KakaoForge 인증 세션을 발견했습니다.\n`);
    console.log('1. 저장된 로그인으로 바로 연결'); console.log('2. QR 로그인 (새 인증)'); console.log('3. 기존 로그인/상태 패널 열기'); console.log('4. 돌아가기');
    const c = await ask('로그인 > ');
    if (c === '1') return true;
    if (c === '2') { const ok = await launchInteractive('npm', ['run', 'login:qr']); if (!ok || !existsSync(AUTH_PATH)) { await pause(); return false; } return true; }
    if (c === '3') { await launchInteractive('node', ['dist/bridge-main.js']); await pause(); return true; }
    return false;
  }
  console.log(`${C.yellow}●${C.reset} 저장된 로그인 세션이 없습니다. 먼저 로그인해야 합니다.\n`);
  console.log('1. QR 로그인'); console.log('2. 기존 로그인/상태 패널 열기'); console.log('3. 돌아가기');
  const c = await ask('로그인 > ');
  if (c === '1') { const ok = await launchInteractive('npm', ['run', 'login:qr']); if (!ok || !existsSync(AUTH_PATH)) { await pause(); return false; } return true; }
  if (c === '2') { await launchInteractive('node', ['dist/bridge-main.js']); await pause(); return true; }
  return false;
}

async function mainMenu() {
  clear(); title('LOCO-TERMUX  /  CONTROL CENTER'); runtimeInfo();
  console.log(`\n${C.cyan}[ AUTH ]${C.reset}`); console.log('  1. 로그인 센터  · QR / 기존 로그인 패널');
  console.log(`\n${C.cyan}[ ROOM ]${C.reset}`); console.log('  2. 방 목록 / 전체보기'); console.log('  3. 방 등록'); console.log('  4. 방 활성화'); console.log('  5. 방 비활성화'); console.log('  6. 방 등록 해제');
  console.log(`\n${C.cyan}[ DATA ]${C.reset}`); console.log('  7. 방 멤버 조회'); console.log('  8. 읽은 사람 조회'); console.log('  9. 전체 데이터 내보내기'); console.log(' 10. 나간 사람 데이터 내보내기');
  console.log(`\n${C.cyan}[ SERVICE ]${C.reset}`); console.log(' 11. OpenChat 시작'); console.log(' 12. OpenChat 정지'); console.log(' 13. OpenChat 재시작'); console.log(' 14. OpenChat 상태'); console.log(' 15. OpenChat 로그 마지막 부분'); console.log(' 16. 기존 LOCO 브리지 패널'); console.log('  0. 패널 종료 (서비스는 계속 실행 가능)');
  console.log(`${C.dim}\n※ 런타임은 패널과 분리되고, 비정상 종료 시 Watchdog가 자동 재시작합니다.${C.reset}`);
}
async function showLog() {
  clear(); title('SERVICE CENTER  /  OpenChat 최근 로그');
  try { const lines = readFileSync(LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean); console.log(lines.slice(-80).join('\n') || '(로그 없음)'); } catch { console.log('(로그 없음)'); }
  await pause();
}
async function main() {
  startWatchdog();
  const loggedIn = await loginMenu();
  if (loggedIn) startRuntime();
  while (true) {
    await mainMenu(); const c = await ask('\nLOCO > ');
    if (c === '0' || c.toLowerCase() === 'exit') return;
    if (c === '1') { const ok = await loginMenu(); if (ok) startRuntime(); }
    else if (c === '2') await roomList(); else if (c === '3') await roomAdd(); else if (c === '4') await roomToggle(true); else if (c === '5') await roomToggle(false); else if (c === '6') await roomRemove(); else if (c === '7') await members(); else if (c === '8') await readers(); else if (c === '9') await exportData(false); else if (c === '10') await exportData(true);
    else if (c === '11') { clear(); title('SERVICE CENTER  /  OpenChat 시작'); startRuntime(); await pause(); }
    else if (c === '12') { clear(); title('SERVICE CENTER  /  OpenChat 정지'); stopRuntime(); await pause(); }
    else if (c === '13') { clear(); title('SERVICE CENTER  /  OpenChat 재시작'); restartRuntime(); await pause(); }
    else if (c === '14') { clear(); title('SERVICE CENTER  /  OpenChat 상태'); runtimeInfo(); await pause(); }
    else if (c === '15') await showLog();
    else if (c === '16') { await launchInteractive('node', ['dist/bridge-main.js']); await pause(); }
    else { console.log(`${C.yellow}없는 메뉴입니다.${C.reset}`); await pause(); }
  }
}
main().catch(error => { console.error(`${C.red}[FATAL] ${error instanceof Error ? error.message : String(error)}${C.reset}`); process.exitCode = 1; });
