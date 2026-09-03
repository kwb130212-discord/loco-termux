import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const C = { reset: '\x1b[0m', cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', white: '\x1b[37m', dim: '\x1b[2m', bold: '\x1b[1m' };

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
}

function clear() { process.stdout.write('\x1b[2J\x1b[H'); }
function title(text: string) { console.log(`${C.cyan}${C.bold}╔══════════════════════════════════════════════════════╗${C.reset}`); console.log(`${C.cyan}${C.bold}║${C.reset} ${C.white}${C.bold}${text.padEnd(52)}${C.reset}${C.cyan}${C.bold}║${C.reset}`); console.log(`${C.cyan}${C.bold}╚══════════════════════════════════════════════════════╝${C.reset}`); }
function runPython(args: string[], timeout = 120_000) {
  const py = process.env.PYTHON_BIN || (existsSync('/data/data/com.termux/files/usr/bin/python3') ? 'python3' : 'python');
  return spawnSync(py, ['방관리_cli.py', ...args], { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
}
function printResult(result: ReturnType<typeof runPython>) {
  if (result.stdout?.trim()) console.log(result.stdout.trim());
  if (result.stderr?.trim()) console.error(`${C.yellow}${result.stderr.trim()}${C.reset}`);
  if (result.error) console.error(`${C.red}실행 오류: ${result.error.message}${C.reset}`);
}
async function pause() { await ask(`\n${C.dim}엔터를 누르면 메뉴로 돌아갑니다...${C.reset}`); }

async function roomList() {
  clear(); title('ROOM CENTER  /  등록된 방 전체보기');
  const r = runPython(['rooms']); printResult(r);
  await pause();
}
async function roomAdd() {
  clear(); title('ROOM CENTER  /  방 등록');
  const room = await ask('방 ID(또는 현재 시스템에서 사용하는 방 식별자): ');
  if (!room) return;
  printResult(runPython(['add', room]));
  await pause();
}
async function roomToggle(enable: boolean) {
  clear(); title(`ROOM CENTER  /  ${enable ? '방 활성화' : '방 비활성화'}`);
  const room = await ask('방 ID: ');
  if (!room) return;
  printResult(runPython([enable ? 'enable' : 'disable', room]));
  await pause();
}
async function roomRemove() {
  clear(); title('ROOM CENTER  /  방 등록 해제');
  const room = await ask('방 ID: ');
  if (!room) return;
  const confirm = await ask(`정말 '${room}' 등록을 해제할까요? (y/N): `);
  if (confirm.toLowerCase() !== 'y') return;
  printResult(runPython(['remove', room]));
  await pause();
}
async function members() {
  clear(); title('MEMBER CENTER  /  현재 확인된 멤버');
  const room = await ask('방 ID: ');
  if (!room) return;
  printResult(runPython(['members', room]));
  await pause();
}
async function readers() {
  clear(); title('READ CENTER  /  메시지 읽은 사람');
  const id = await ask('메시지 ID: ');
  if (!id) return;
  printResult(runPython(['readers', id]));
  await pause();
}
async function exportData(departed = false) {
  clear(); title(departed ? 'EXPORT CENTER  /  나간 사람 내보내기' : 'EXPORT CENTER  /  전체 데이터 내보내기');
  const room = await ask('방 ID (전체는 엔터): ');
  const format = (await ask('형식 json/csv [json]: ')).toLowerCase() || 'json';
  if (!['json', 'csv'].includes(format)) { console.log('json 또는 csv만 가능합니다.'); await pause(); return; }
  const defaultName = departed ? `loco-departed.${format}` : `loco-export.${format}`;
  const output = await ask(`파일명 [${defaultName}]: `) || defaultName;
  const args = departed ? ['departed-export', ...(room ? ['--room-id', room] : []), '--format', format, '--output', output] : ['export', ...(room ? ['--room-id', room] : []), '--format', format, '--output', output];
  printResult(runPython(args));
  await pause();
}

/**
 * Run a child process in the foreground.
 * The previous implementation used spawn() and immediately returned to the
 * parent menu. That left both the parent readline and the child process
 * competing for Termux stdin, which could make QR login appear to hang or
 * disappear. Login/runtime commands must own stdin exclusively until exit.
 */
async function launch(command: string, args: string[] = []) {
  console.log(`${C.green}▶ ${command} ${args.join(' ')} 실행${C.reset}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  if (result.error) console.error(`${C.red}${result.error.message}${C.reset}`);
  if (result.status !== 0 && result.status !== null) {
    console.error(`${C.red}프로세스 종료 코드: ${result.status}${C.reset}`);
  }
}

async function loginMenu() {
  clear(); title('AUTH CENTER  /  로그인');
  console.log('1. QR 로그인  (기존 QR 로그인 경로 그대로 실행)');
  console.log('2. 기존 로그인/상태 패널 열기');
  console.log('3. 돌아가기');
  const c = await ask('선택 > ');
  if (c === '1') { await launch('npm', ['run', 'login:qr']); await pause(); }
  else if (c === '2') { await launch('node', ['dist/bridge-main.js']); await pause(); }
}

async function mainMenu() {
  clear();
  title('LOCO-TERMUX  /  CONTROL CENTER');
  console.log(`${C.green}●${C.reset} 서비스 패널   ${C.dim}Room / Member / Read / Export / Auth${C.reset}\n`);
  console.log(`${C.cyan}[ AUTH ]${C.reset}`);
  console.log('  1. 로그인 센터  · QR / 기존 로그인 패널');
  console.log(`\n${C.cyan}[ ROOM ]${C.reset}`);
  console.log('  2. 방 목록 / 전체보기');
  console.log('  3. 방 등록');
  console.log('  4. 방 활성화');
  console.log('  5. 방 비활성화');
  console.log('  6. 방 등록 해제');
  console.log(`\n${C.cyan}[ DATA ]${C.reset}`);
  console.log('  7. 방 멤버 조회');
  console.log('  8. 읽은 사람 조회');
  console.log('  9. 전체 데이터 내보내기');
  console.log(' 10. 나간 사람 데이터 내보내기');
  console.log(`\n${C.cyan}[ RUNTIME ]${C.reset}`);
  console.log(' 11. OpenChat 봇 실행');
  console.log(' 12. 기존 LOCO 브리지 패널 실행');
  console.log('  0. 종료');
  console.log(`${C.dim}\nTip: 방 등록/해제는 여기서 관리하고, 실제 !kick·!관리자·!입장로그 등의 명령은 OpenChat 런타임에서 처리됩니다.${C.reset}`);
}

async function main() {
  while (true) {
    await mainMenu();
    const c = await ask('\nLOCO > ');
    if (c === '0' || c.toLowerCase() === 'exit') return;
    if (c === '1') await loginMenu();
    else if (c === '2') await roomList();
    else if (c === '3') await roomAdd();
    else if (c === '4') await roomToggle(true);
    else if (c === '5') await roomToggle(false);
    else if (c === '6') await roomRemove();
    else if (c === '7') await members();
    else if (c === '8') await readers();
    else if (c === '9') await exportData(false);
    else if (c === '10') await exportData(true);
    else if (c === '11') { await launch('npm', ['run', 'start:openchat']); await pause(); }
    else if (c === '12') { await launch('node', ['dist/bridge-main.js']); await pause(); }
    else { console.log(`${C.yellow}없는 메뉴입니다.${C.reset}`); await pause(); }
  }
}

main().catch(error => { console.error(`${C.red}[FATAL] ${error instanceof Error ? error.message : String(error)}${C.reset}`); process.exitCode = 1; });
