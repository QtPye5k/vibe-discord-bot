import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../scripts/check-publication.mjs', import.meta.url));
function repository(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-publication-'));
  t.after(() => {
    assert.ok(realpathSync(root).startsWith(join(realpathSync(tmpdir()), 'vibe-publication-')));
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git('init', '-q');
  const check = () =>
    spawnSync(process.execPath, [guard], { cwd: root, windowsHide: true, encoding: 'utf8' });
  return { root, git, check };
}

test('Publication guard scans staged blobs even when a credential was removed only from the working copy', (t) => {
  const f = repository(t),
    secret = ['sk-', 'proj-', 'a'.repeat(60)].join('');
  mkdirSync(join(f.root, 'src'));
  writeFileSync(join(f.root, '.env'), `OPENAI_API_KEY=${secret}\n`);
  writeFileSync(join(f.root, '.gitignore'), '.env\n');
  writeFileSync(join(f.root, 'src', 'example.ts'), `export const unsafe = '${secret}';\n`);
  f.git('add', '.gitignore', 'src/example.ts');
  writeFileSync(join(f.root, 'src', 'example.ts'), 'export const safe = true;\n');
  const result = f.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-credential-value/);
  assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stdout.includes(secret));
  f.git('add', 'src/example.ts');
  assert.equal(f.check().status, 0);
});

test('Publication guard permits a placeholder example but blocks a forcibly tracked private environment file', (t) => {
  const f = repository(t);
  writeFileSync(join(f.root, '.gitignore'), '.env\n');
  writeFileSync(join(f.root, '.env.example'), 'DISCORD_TOKEN=YOUR_DISCORD_TOKEN\n');
  f.git('add', '.gitignore', '.env.example');
  assert.equal(f.check().status, 0);
  writeFileSync(resolve(f.root, '.env'), 'DISCORD_TOKEN=private-local-value\n');
  f.git('add', '-f', '.env');
  const result = f.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private-runtime-path/);
  assert.ok(!result.stderr.includes('private-local-value'));
});
