const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkgDir = path.join(root, 'node_modules', 'kakaoforge');
const distEntry = path.join(pkgDir, 'dist', 'index.js');

if (!fs.existsSync(pkgDir)) {
  console.error('[KakaoForge] node_modules/kakaoforge not found. npm install must finish first.');
  process.exit(1);
}

if (fs.existsSync(distEntry)) {
  console.log('[KakaoForge] compiled package already present.');
  process.exit(0);
}

console.log('[KakaoForge] npm package no longer publishes dist files; building the pinned source checkout...');
console.log(`[KakaoForge] source: ${pkgDir}`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const install = spawnSync(npm, ['install', '--include=dev', '--ignore-scripts'], {
  cwd: pkgDir,
  stdio: 'inherit',
  env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
});
if (install.status !== 0) {
  console.error('[KakaoForge] dependency installation failed.');
  process.exit(install.status || 1);
}

const build = spawnSync(npm, ['run', 'build'], {
  cwd: pkgDir,
  stdio: 'inherit',
  env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
});
if (build.status !== 0) {
  console.error('[KakaoForge] source build failed.');
  process.exit(build.status || 1);
}

if (!fs.existsSync(distEntry)) {
  console.error('[KakaoForge] build completed without dist/index.js.');
  process.exit(1);
}

console.log('[KakaoForge] source build completed successfully.');
