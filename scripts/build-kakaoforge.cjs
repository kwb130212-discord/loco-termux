const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkgDir = path.join(root, 'node_modules', 'kakaoforge');
const srcLogin = path.join(pkgDir, 'src', 'auth', 'login.ts');
const entry = path.join(pkgDir, 'dist', 'index.js');

if (!fs.existsSync(pkgDir)) {
  console.log('[KakaoForge] package directory is not present; npm install will retry it.');
  process.exit(0);
}

function patchSource() {
  if (!fs.existsSync(srcLogin)) throw new Error(`[KakaoForge] source file not found: ${srcLogin}`);

  const original = fs.readFileSync(srcLogin, 'utf8');
  let content = original;

  content = content.replace(
    "const QR_USER_AGENT = 'okhttp/4.12.0';",
    "const QR_USER_AGENT = buildUserAgent();",
  );

  content = content.replace(
    "'Accept': '*/*',\n      'Accept-Language': 'ko',",
    "'Accept': 'application/json',\n      'Accept-Language': 'ko-KR,ko;q=0.9',",
  );

  content = content.replace(
    "if (res.status !== 200) {\n    throw new Error(`allowlist HTTP error: ${res.status}`);\n  }",
    "if (res.status !== 200) {\n    const type = res.headers?.['content-type'] || 'unknown';\n    const body = typeof res.body === 'string' ? res.body.slice(0, 512) : JSON.stringify(res.body);\n    throw new Error(`allowlist HTTP error: ${res.status}; content-type=${type}; body=${body}`);\n  }",
  );

  content = content.replace(
    "if (res.status !== 200) {\n    throw new Error(`QR generate HTTP error: ${res.status}`);\n  }\n\n  const body = res.body;\n  if (body.status && body.status !== 0) {\n    throw new Error(`QR generate failed: status=${body.status}`);\n  }",
    "if (res.status !== 200) {\n    const type = res.headers?.['content-type'] || 'unknown';\n    const body = typeof res.body === 'string' ? res.body.slice(0, 512) : JSON.stringify(res.body);\n    throw new Error(`QR generate HTTP error: ${res.status}; content-type=${type}; body=${body}`);\n  }\n\n  const body = res.body;\n  if (body.status && body.status !== 0) {\n    const detail = body.message || body.error || body.errorMessage || body.reason || '';\n    throw new Error(`QR generate failed: status=${body.status}${detail ? `, message=${detail}` : ''}`);\n  }",
  );

  if (content === original) {
    console.log('[KakaoForge] protocol patch already present.');
    return false;
  }

  fs.writeFileSync(srcLogin, content, 'utf8');
  console.log('[KakaoForge] applied QR protocol/diagnostic patch.');
  return true;
}

function run(command, args) {
  execFileSync(process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command, args, {
    cwd: pkgDir,
    stdio: 'inherit',
    env: process.env,
  });
}

const patched = patchSource();
if (patched && fs.existsSync(entry)) fs.rmSync(entry, { force: true });

if (fs.existsSync(entry)) {
  console.log('[KakaoForge] dist/index.js already exists.');
  process.exit(0);
}

console.log('[KakaoForge] Git dependency has no built dist/ directory. Building it now...');
try {
  run('npm', ['install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  run('npm', ['run', 'build']);
} catch (error) {
  console.error('[KakaoForge] Failed to build the dependency.');
  process.exit(1);
}

if (!fs.existsSync(entry)) {
  console.error(`[KakaoForge] Build finished but ${entry} is still missing.`);
  process.exit(1);
}

console.log('[KakaoForge] dist/index.js is ready.');
