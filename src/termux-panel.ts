import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const C={r:'\x1b[0m',c:'\x1b[36m',g:'\x1b[32m',y:'\x1b[33m',x:'\x1b[31m',d:'\x1b[2m',b:'\x1b[1m'};
const DATA=join(homedir(),'.loco-termux'); const AUTH=join(DATA,'kakaoforge-auth.json'); const PID=join(DATA,'openchat.pid'); const WANT=join(DATA,'openchat.desired'); const LOG=join(DATA,'openchat.log');
mkdirSync(DATA,{recursive:true,mode:0o700});
class Back extends Error{constructor(){super('BACK');this.name='Back';}}
const isBack=(e:unknown)=>e instanceof Back||(e instanceof Error&&e.message==='BACK');
async function ask(p:string){const rl=readline.createInterface({input,output});try{const v=(await rl.question(p)).trim();if(v==='00')throw new Back();return v;}finally{rl.close();}}
function clear(){process.stdout.write('\x1b[2J\x1b[H\x1b[3J');}
function head(t:string){clear();console.log(`${C.c}${C.b}╭────────────────────────────────────────────────────────────╮${C.r}`);console.log(`${C.c}${C.b}│${C.r} ${C.b}${t.padEnd(58)}${C.r}${C.c}${C.b}│${C.r}`);console.log(`${C.c}${C.b}╰────────────────────────────────────────────────────────────╯${C.r}`);}
function py(args:string[],timeout=120000){const bins=[process.env.PYTHON_BIN,'python3','python'].filter(Boolean) as string[];let last:any=null;for(const b of bins){last=spawnSync(b,['방관리_cli.py',...args],{encoding:'utf8',timeout,maxBuffer:8*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}});if(!last.error)break;}return last;}
function out(r:any){if(r?.stdout?.trim())console.log(r.stdout.trim());if(r?.stderr?.trim())console.error(`${C.y}${r.stderr.trim()}${C.r}`);if(r?.error)console.error(`${C.x}${r.error.message}${C.r}`);}
async function pause(){await ask(`\n${C.d}엔터=계속 · 00=메인 패널${C.r}`);}
function pid(){try{const n=Number(readFileSync(PID,'utf8').trim());return Number.isInteger(n)&&n>0?n:null;}catch{return null;}}
function alive(n:number|null){if(!n)return false;try{process.kill(n,0);return true;}catch{return false;}}
function want(){try{return readFileSync(WANT,'utf8').trim()==='1';}catch{return false;}}
function setWant(v:boolean){writeFileSync(WANT,v?'1':'0','utf8');}
function authOk(){return existsSync(AUTH);}
function status(){const p=pid();return alive(p)?'RUNNING':want()?'CRASHED':'STOPPED';}
function start():boolean{if(!authOk()){console.log(`${C.y}⚠ QR 로그인부터 완료하세요.${C.r}`);return false;}const p=pid();if(alive(p)){setWant(true);console.log(`${C.g}● 이미 실행 중 PID=${p}${C.r}`);return true;}try{unlinkSync(PID);}catch{}setWant(true);const fd=openSync(LOG,'a');const ch=spawn(process.execPath,['dist/openchat-main.js'],{cwd:process.cwd(),detached:true,stdio:['ignore',fd,fd],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'}});if(!ch.pid){setWant(false);return false;}writeFileSync(PID,String(ch.pid),'utf8');ch.unref();console.log(`${C.g}✓ 런타임 시작 PID=${ch.pid}${C.r}`);return true;}
function stop(){setWant(false);const p=pid();if(!p||!alive(p)){try{unlinkSync(PID);}catch{}console.log(`${C.d}이미 정지 상태${C.r}`);return true;}try{process.kill(p,'SIGTERM');setTimeout(()=>{if(alive(p))try{process.kill(p,'SIGKILL')}catch{}try{unlinkSync(PID)}catch{}},1800).unref();console.log(`${C.g}✓ 정지 요청 완료${C.r}`);return true;}catch(e){console.error(`${C.x}${e}${C.r}`);return false;}}
function watchdog(){const t=setInterval(()=>{if(want()&&!alive(pid())){console.log(`${C.y}[WATCHDOG] 런타임 복구 시도${C.r}`);setTimeout(()=>{if(want()&&!alive(pid()))start()},2000).unref();}},3000);t.unref();}
async function qr(){head('QR LOGIN / KAKAOTALK');console.log(`${C.g}QR 로그인${C.r}`);console.log(`${C.d}KakaoTalk에서 직접 승인하고 QR 세션이 저장될 때까지 이 화면을 유지하세요.${C.r}\n`);const r=spawnSync('npm',['run','login:qr'],{stdio:'inherit',env:{...process.env}});if(r.status===0&&authOk()){console.log(`${C.g}\n✓ QR 인증 저장 완료${C.r}`);start();}else console.log(`${C.x}\n✗ QR 로그인 실패${C.r}`);await pause();}
async function rooms(){head('ROOM CENTER / 전체보기');out(py(['rooms']));await pause();}
async function add(){head('ROOM CENTER / 등록');const v=await ask('방 ID: ');if(v)out(py(['add',v]));await pause();}
async function toggle(on:boolean){head(`ROOM CENTER / ${on?'활성화':'비활성화'}`);const v=await ask('방 ID: ');if(v)out(py([on?'enable':'disable',v]));await pause();}
async function removeRoom(){head('ROOM CENTER / 등록 해제');const v=await ask('방 ID: ');if(v&&((await ask(`'${v}' 해제? y/N: `)).toLowerCase()==='y'))out(py(['remove',v]));await pause();}
async function members(){head('MEMBER CENTER');const v=await ask('방 ID: ');if(v)out(py(['members',v]));await pause();}
async function readers(){head('READ CENTER');const v=await ask('메시지 ID: ');if(v)out(py(['readers',v]));await pause();}
async function exportData(departed=false){head(departed?'DEPARTED EXPORT':'DATA EXPORT');const room=await ask('방 ID(전체는 엔터): ');const fmt=(await ask('json/csv [json]: ')).toLowerCase()||'json';if(!['json','csv'].includes(fmt)){console.log('json/csv만 가능');await pause();return;}const def=departed?`loco-departed.${fmt}`:`loco-export.${fmt}`;const file=await ask(`파일명 [${def}]: `)||def;out(py([departed?'departed-export':'export',...(room?['--room-id',room]:[]),'--format',fmt,'--output',file]));await pause();}
async function log(){head('RUNTIME LOG');try{const a=readFileSync(LOG,'utf8').split(/\r?\n/).filter(Boolean);console.log(a.slice(-100).join('\n')||'(로그 없음)')}catch{console.log('(로그 없음)')}await pause();}
async function statusPage(){head('SYSTEM STATUS');console.log(`인증: ${authOk()?C.g+'OK'+C.r:C.x+'없음'+C.r}`);console.log(`런타임: ${status()}`);console.log(`PID: ${pid()??'-'}`);console.log(`자동복구: ${want()?'ON':'OFF'}`);console.log(`데이터: ${DATA}`);console.log(`로그: ${LOG}`);await pause();}
function help(){head('COMMANDS / 기존 명령어 유지');console.log(['!명령어  !핑  !봇정보  !봇상태','!관리자 @유저  !관리자해제 @유저  !관리자목록','!읽은사람  !채팅순위','!kick @유저  !allkick','!봇등록  !방등록해제','!입장로그  !퇴장로그  !입퇴장로그','!나간사람  !나간사람내보내기','!도박가입  !도박 <포인트>','!echo <문구>'].join('\n'));}
async function menu(){head('LOCO-TERMUX / CONTROL CENTER');console.log(`인증 ${authOk()?C.g+'● QR OK':C.x+'○ QR 필요'}${C.r}   런타임 ${status()}   PID ${pid()??'-'}`);console.log(`\n${C.c}[ AUTH ]${C.r}`);console.log(' 1 QR 로그인');console.log(' 2 인증 상태');console.log(`\n${C.c}[ ROOM ]${C.r}`);console.log(' 3 방 전체보기   4 방 등록   5 방 활성화   6 방 비활성화   7 방 등록 해제');console.log(`\n${C.c}[ DATA ]${C.r}`);console.log(' 8 멤버   9 읽은 사람   10 전체 내보내기   11 나간 사람 내보내기');console.log(`\n${C.c}[ SERVICE ]${C.r}`);console.log(' 12 시작   13 정지   14 재시작   15 로그   16 명령어');console.log(' 0 종료');console.log(`\n${C.d}※ 모든 입력창: 00=메인 패널 · 런타임은 패널과 분리 · 비정상 종료 자동복구${C.r}`);}
async function main(){watchdog();while(true){try{await menu();const c=await ask('\nLOCO > ');switch(c){case'1':await qr();break;case'2':await statusPage();break;case'3':await rooms();break;case'4':await add();break;case'5':await toggle(true);break;case'6':await toggle(false);break;case'7':await removeRoom();break;case'8':await members();break;case'9':await readers();break;case'10':await exportData(false);break;case'11':await exportData(true);break;case'12':start();await pause();break;case'13':stop();await pause();break;case'14':stop();setTimeout(()=>start(),800).unref();await pause();break;case'15':await log();break;case'16':help();await pause();break;case'0':setWant(false);process.exit(0);}}catch(e){if(isBack(e))continue;console.error(`${C.x}패널 오류: ${e instanceof Error?e.message:String(e)}${C.r}`);await new Promise(r=>setTimeout(r,500));}}}
void main();
