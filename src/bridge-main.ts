import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA=join(homedir(),'.loco-termux'); const AUTH=join(DATA,'kakaoforge-auth.json'); const PID=join(DATA,'openchat.pid'); const WANT=join(DATA,'openchat.desired'); const LOG=join(DATA,'openchat.log');
mkdirSync(DATA,{recursive:true,mode:0o700});
class Back extends Error{constructor(){super('BACK');}}
async function ask(p:string){const rl=readline.createInterface({input,output});try{const v=(await rl.question(p)).trim();if(v==='00')throw new Back();return v;}finally{rl.close();}}
function clear(){process.stdout.write('\x1b[2J\x1b[H\x1b[3J');}
function pid(){try{const n=Number(readFileSync(PID,'utf8').trim());return Number.isInteger(n)&&n>0?n:null;}catch{return null;}}
function alive(p:number|null){if(!p)return false;try{process.kill(p,0);return true;}catch{return false;}}
function want(){try{return readFileSync(WANT,'utf8').trim()==='1';}catch{return false;}}
function setWant(v:boolean){writeFileSync(WANT,v?'1':'0','utf8');}
function start(){if(!existsSync(AUTH)){console.log('QR 로그인 필요');return false;}const p=pid();if(alive(p)){setWant(true);return true;}const fd=require('node:fs').openSync(LOG,'a');const c=require('node:child_process').spawn(process.execPath,['dist/openchat-main.js'],{cwd:process.cwd(),detached:true,stdio:['ignore',fd,fd],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}});if(!c.pid){setWant(false);return false;}setWant(true);writeFileSync(PID,String(c.pid),'utf8');c.unref();return true;}
function stop(){setWant(false);const p=pid();if(!p||!alive(p)){try{unlinkSync(PID)}catch{}return true;}try{process.kill(p,'SIGTERM');setTimeout(()=>{if(alive(p))try{process.kill(p,'SIGKILL')}catch{}try{unlinkSync(PID)}catch{}},1800).unref();return true;}catch{return false;}}
function header(){clear();console.log('╭────────────────────────────────────────────────────────────╮');console.log('│ LOCO-TERMUX  /  QR-FIRST BRIDGE                           │');console.log('╰────────────────────────────────────────────────────────────╯');console.log(`인증: ${existsSync(AUTH)?'QR OK':'QR 필요'}  런타임: ${alive(pid())?'RUNNING':want()?'CRASHED':'STOPPED'}  PID: ${pid()??'-'}\n`);}
async function qr(){header();console.log('공식/지원되는 QR 로그인 흐름을 시작합니다.');const r=spawnSync('npm',['run','login:qr'],{stdio:'inherit',env:{...process.env}});if(r.status===0&&existsSync(AUTH)){console.log('✓ QR 인증 완료');start();}else console.log('✗ QR 인증 실패');await ask('엔터=메뉴 · 00=메인 패널');}
async function main(){while(true){try{header();console.log('1. QR 로그인');console.log('2. 인증 상태');console.log('3. OpenChat 시작');console.log('4. OpenChat 정지');console.log('5. OpenChat 재시작');console.log('6. 로그 보기');console.log('0. 종료');const c=await ask('\nLOCO > ');if(c==='1'){await qr();continue;}if(c==='2'){console.log(`인증 파일: ${AUTH}`);console.log(`인증: ${existsSync(AUTH)?'OK':'없음'}`);await ask('엔터=메뉴 · 00=메인 패널');continue;}if(c==='3'){console.log(start()?'✓ 시작':'✗ 시작 실패');await ask('엔터=메뉴 · 00=메인 패널');continue;}if(c==='4'){console.log(stop()?'✓ 정지':'✗ 정지 실패');await ask('엔터=메뉴 · 00=메인 패널');continue;}if(c==='5'){stop();setTimeout(()=>start(),800).unref();console.log('✓ 재시작 예약');await ask('엔터=메뉴 · 00=메인 패널');continue;}if(c==='6'){try{const a=readFileSync(LOG,'utf8').split(/\r?\n/).filter(Boolean);console.log(a.slice(-100).join('\n')||'(로그 없음)')}catch{console.log('(로그 없음)')}await ask('엔터=메뉴 · 00=메인 패널');continue;}if(c==='0'){setWant(false);process.exit(0);}}catch(e){if(e instanceof Back)continue;console.error(e);}}}
void main();
