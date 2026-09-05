const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'kakaoforge');
const required = [
  ['dist/index.js', 'runtime entry'],
  ['dist/client/client.js', 'client transport'],
  ['dist/net/loco-stream.js', 'LOCO stream'],
  ['dist/protocol/loco-packet.js', 'LOCO packet codec'],
  ['dist/auth/login.js', 'QR/auth flow'],
  ['dist/client/openchat-mixin.js', 'OpenChat operations'],
  ['dist/client/message-mixin.js', 'message operations'],
];

function fail(message) {
  console.error(`[LOCO-DOCTOR] FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(pkg)) fail('node_modules/kakaoforge is missing. Run npm install.');
for (const [relative, label] of required) {
  if (!fs.existsSync(path.join(pkg, relative))) fail(`${label} is missing: ${relative}`);
}

try {
  const revision = execFileSync('git', ['-C', pkg, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(`[LOCO-DOCTOR] KakaoForge checkout: ${revision}`);
} catch {
  console.log('[LOCO-DOCTOR] KakaoForge is installed as a package/build output; git metadata unavailable.');
}

try {
  const forge = require(pkg);
  const requiredExports = ['createAuthByQR', 'createClient'];
  for (const name of requiredExports) {
    if (typeof forge[name] !== 'function') fail(`required export is unavailable: ${name}`);
  }
  console.log('[LOCO-DOCTOR] exports: createAuthByQR/createClient OK');
} catch (error) {
  fail(`cannot load KakaoForge: ${error instanceof Error ? error.message : String(error)}`);
}

console.log('[LOCO-DOCTOR] LOCO transport bundle is present and loadable.');
