const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkgDir = path.join(root, 'node_modules', 'kakaoforge');
const entry = path.join(pkgDir, 'dist', 'index.js');

if (!fs.existsSync(pkgDir)) {
  console.log('[KakaoForge] package directory is not present; npm install will retry it.');
  process.exit(0);
}

if (fs.existsSync(entry)) {
  console.log('[KakaoForge] dist/index.js already exists.');
  process.exit(0);
}

console.log('[KakaoForge] Git dependency has no built dist/ directory. Building it now...');
try {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--include=dev', '--ignore-scripts'], {
    cwd: pkgDir,
    stdio: 'inherit',
    env: process.env,
  });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: pkgDir,
    stdio: 'inherit',
    env: process.env,
  });
} catch (error) {
  console.error('[KakaoForge] Failed to build the dependency.');
  process.exit(1);
}

if (!fs.existsSync(entry)) {
  console.error(`[KakaoForge] Build finished but ${entry} is still missing.`);
  process.exit(1);
}

console.log('[KakaoForge] dist/index.js is ready.');
