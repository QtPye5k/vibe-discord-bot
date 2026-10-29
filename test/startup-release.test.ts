import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const project = fileURLToPath(new URL('..', import.meta.url));
const staging = await import(new URL('../scripts/stage-release.mjs', import.meta.url).href);
const launch = await import(new URL('../scripts/start.mjs', import.meta.url).href);
async function fixture(t: TestContext) {
  const parent = join(project, 'logs', 'startup-fixtures');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'fixture-'));
  t.after(async () => {
    const rel = relative(parent, root);
    assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'dist', 'features'), { recursive: true });
  await copyFile(join(project, 'scripts', 'start.mjs'), join(root, 'scripts', 'start.mjs'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, '.env'), '# Empty isolated test configuration\n');
  await build({
    entryPoints: [join(project, 'src/features/deployment.ts')],
    outfile: join(root, 'dist/features/deployment.js'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  const code = (name: string) =>
    `import {writeFileSync} from 'node:fs';writeFileSync(process.env.STARTUP_TEST_MARKER,JSON.stringify({name:${JSON.stringify(name)},workspace:process.env.BOT_WORKSPACE_ROOT,env:process.env.DOTENV_CONFIG_PATH}));`;
  await writeFile(join(root, 'dist/main.js'), code('default'));
  const releases = join(root, 'data', 'releases'),
    active = join(root, 'data', 'active.json');
  const environment = { DEPLOYMENT_RELEASES_DIRECTORY: releases, DEPLOYMENT_ACTIVE_FILE: active };
  const stage = async (id: string) => {
    await writeFile(join(root, 'dist/main.js'), code(id));
    return staging.stageRelease(root, releases, id) as Promise<{ id: string; manifestHash: string }>;
  };
  const point = async (selection: { id: string; manifestHash: string }) => {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(
      active,
      JSON.stringify({
        version: 1,
        current: { id: selection.id, manifestHash: selection.manifestHash },
        previous: null,
        generation: 1,
        activatedAt: Date.now(),
      }),
    );
  };
  const start = async () => {
    const marker = join(root, 'marker.json');
    await rm(marker, { force: true });
    const child = spawn(process.execPath, [join(root, 'scripts/start.mjs')], {
      cwd: root,
      windowsHide: true,
      shell: false,
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        DEPLOYMENT_RELEASES_DIRECTORY: releases,
        DEPLOYMENT_ACTIVE_FILE: active,
        DOTENV_CONFIG_PATH: join(root, '.env'),
        STARTUP_TEST_MARKER: marker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', (chunk) => {
      output += String(chunk).slice(0, 4096);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, output, marker };
  };
  return { root, releases, active, environment, stage, point, start };
}
test('startup resolves the default build with blank configuration or an absent active pointer and rejects half-configured selection', async (t) => {
  const f = await fixture(t);
  assert.equal(await launch.resolveLaunchEntry({}, f.root), join(f.root, 'dist/main.js'));
  assert.equal(await launch.resolveLaunchEntry(f.environment, f.root), join(f.root, 'dist/main.js'));
  await assert.rejects(
    () => launch.resolveLaunchEntry({ DEPLOYMENT_ACTIVE_FILE: f.active }, f.root),
    /Both deployment/,
  );
});
test('real staging helper hashes built files once and startup imports the approved release with original workspace environment', async (t) => {
  const f = await fixture(t),
    selection = await f.stage('approved-one');
  await f.point(selection);
  const manifest = await readFile(join(f.releases, selection.id, 'release.json'));
  assert.equal(createHash('sha256').update(manifest).digest('hex'), selection.manifestHash);
  assert.equal(
    await launch.resolveLaunchEntry(f.environment, f.root),
    join(f.releases, selection.id, 'dist/main.js'),
  );
  await assert.rejects(() => f.stage('approved-one'), /exist/i);
  const result = await f.start();
  assert.equal(result.code, 0, result.output);
  const marker = JSON.parse(await readFile(result.marker, 'utf8'));
  assert.equal(marker.name, 'approved-one');
  assert.equal(resolve(marker.workspace), resolve(f.root));
  assert.equal(resolve(marker.env), join(f.root, '.env'));
});
test('startup never imports tampered release bytes, malformed pointers or an escaping release ID', async (t) => {
  const f = await fixture(t),
    selection = await f.stage('verified');
  await f.point(selection);
  await writeFile(
    join(f.releases, selection.id, 'dist/main.js'),
    'throw new Error("UNVERIFIED CODE EXECUTED");',
  );
  let result = await f.start();
  assert.equal(result.code, 1);
  assert.match(result.output, /verification failed/);
  assert.doesNotMatch(result.output, /UNVERIFIED CODE EXECUTED/);
  await assert.rejects(() => readFile(result.marker));
  await writeFile(f.active, '{bad json');
  await assert.rejects(() => launch.resolveLaunchEntry(f.environment, f.root));
  await f.point({ id: '../outside', manifestHash: '0'.repeat(64) });
  await assert.rejects(() => launch.resolveLaunchEntry(f.environment, f.root));
  result = await f.start();
  assert.equal(result.code, 1);
  await assert.rejects(() => readFile(result.marker));
});
