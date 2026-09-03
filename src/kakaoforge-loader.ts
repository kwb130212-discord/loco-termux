import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const KAKAO_FORGE_REPO = 'https://github.com/minjaemin2020/KakaoForge.git';
const KAKAO_FORGE_COMMIT = '4b774ea40b1347280fadb685415436584093118b';

export interface AuthPayload {
  userId: number;
  accessToken: string;
  refreshToken?: string;
  deviceUuid: string;
  savedAt?: string;
  raw?: unknown;
  authPath?: string;
}

export interface CreateAuthByQROptions {
  authPath?: string;
  deviceUuid?: string;
  deviceName?: string;
  modelName?: string;
  forced?: boolean;
  checkAllowlist?: boolean;
  enforceAllowlist?: boolean;
  appVer?: string;
  onQrUrl?: (url: string) => void;
  onPasscode?: (passcode: string) => void;
  save?: boolean;
}

export interface KakaoForgeModule {
  createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload>;
  createClient(config?: Record<string, unknown>): any;
}

function resolvePackageRoot(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, 'node_modules', 'kakaoforge');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('KakaoForge is not installed. Run "npm install" and retry.');
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 1}).`);
  }
}

function restoreSourceCheckout(packageRoot: string): void {
  const sourceEntry = join(packageRoot, 'src', 'index.ts');
  if (existsSync(sourceEntry)) return;

  // npm may install a Git dependency as its packed npm artifact. KakaoForge's
  // package.json publishes only dist/ and README.md, so the source tree can be
  // absent even though npm successfully installed the dependency. Rehydrate
  // the exact pinned source revision directly from GitHub in that case.
  const parent = dirname(packageRoot);
  const checkoutRoot = join(parent, '.kakaoforge-source');
  const git = process.platform === 'win32' ? 'git.exe' : 'git';

  console.log('[KakaoForge] source tree is missing; restoring the pinned Git revision...');

  if (existsSync(checkoutRoot)) {
    rmSync(checkoutRoot, { recursive: true, force: true });
  }
  mkdirSync(parent, { recursive: true });

  run(git, ['clone', '--filter=blob:none', KAKAO_FORGE_REPO, checkoutRoot], parent);
  run(git, ['checkout', '--detach', KAKAO_FORGE_COMMIT], checkoutRoot);

  const restoredSource = join(checkoutRoot, 'src');
  const restoredPackage = join(checkoutRoot, 'package.json');
  if (!existsSync(join(restoredSource, 'index.ts')) || !existsSync(restoredPackage)) {
    throw new Error('Pinned KakaoForge checkout is incomplete.');
  }

  // Replace the packed dependency contents with the real source checkout while
  // preserving node_modules as the stable package location used by createRequire.
  const keep = new Set(['node_modules']);
  for (const entry of readdirSync(packageRoot)) {
    if (!keep.has(entry)) {
      rmSync(join(packageRoot, entry), { recursive: true, force: true });
    }
  }

  run('cp', ['-a', `${checkoutRoot}/.`, packageRoot], parent);
}

function ensureBuildConfig(packageRoot: string): void {
  const tsconfigPath = join(packageRoot, 'tsconfig.json');
  if (existsSync(tsconfigPath)) return;

  const sourceEntry = join(packageRoot, 'src', 'index.ts');
  if (!existsSync(sourceEntry)) {
    throw new Error('KakaoForge source files are missing even after source restoration.');
  }

  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'CommonJS',
          moduleResolution: 'Node',
          rootDir: 'src',
          outDir: 'dist',
          declaration: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          strict: false,
          removeComments: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log('[KakaoForge] restored missing tsconfig.json for the source build.');
}

function buildKakaoForge(packageRoot: string): void {
  restoreSourceCheckout(packageRoot);

  const distEntry = join(packageRoot, 'dist', 'index.js');
  if (existsSync(distEntry)) return;

  console.log('[KakaoForge] dist/index.js is missing. Building the pinned source checkout...');

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['install', '--include=dev', '--ignore-scripts'], packageRoot);
  ensureBuildConfig(packageRoot);
  run(npm, ['run', 'build'], packageRoot);

  if (!existsSync(distEntry)) {
    throw new Error('KakaoForge build finished but dist/index.js was not produced.');
  }
}

function loadModule(): KakaoForgeModule {
  const packageRoot = resolvePackageRoot();
  buildKakaoForge(packageRoot);
  const require = createRequire(join(packageRoot, 'package.json'));
  return require(packageRoot) as KakaoForgeModule;
}

export function getKakaoForge(): KakaoForgeModule {
  return loadModule();
}

export async function createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload> {
  return loadModule().createAuthByQR(options);
}

export function createClient(config?: Record<string, unknown>): any {
  return loadModule().createClient(config);
}

export function ensureKakaoForgeInstalled(): void {
  const packageRoot = resolvePackageRoot();
  buildKakaoForge(packageRoot);
}
