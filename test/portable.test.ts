import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { portableArchive } from '../scripts/package-portable.js';
import { projectPath, PROJECT_ROOT } from '../src/core/paths.js';
import { loadConfig } from '../src/config.js';

test('Portable archive contains source/templates and never includes credentials, runtime data or unknown root files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'discord-portable-test-'));
  try {
    for (const name of ['src', 'data', 'logs', 'config', '.github/workflows'])
      await mkdir(join(temp, name), { recursive: true });
    for (const [name, text] of Object.entries({
      'src/main.ts': 'source',
      '.env': 'PRIVATE_SECRET',
      'unknown-key.txt': 'PRIVATE_SECRET',
      'data/bot.sqlite': 'PRIVATE_DATA',
      'logs/runtime.txt': 'PRIVATE_LOG',
      '.env.example': 'OPTIONAL_KEY=',
      'config/private-profiles.json': 'PRIVATE_GAME_IDENTITIES',
      'config/queries.example.json': '{"version":1}',
      '.github/workflows/ci.yml': 'verification',
      'package.json': '{}',
    }))
      await writeFile(join(temp, name), text);
    const archive = await portableArchive(temp),
      files = unzipSync(archive.data);
    assert.deepEqual(
      Object.keys(files).sort(),
      [
        '.env.example',
        '.github/workflows/ci.yml',
        'config/queries.example.json',
        'PORTABLE-MANIFEST.json',
        'package.json',
        'src/main.ts',
      ].sort(),
    );
    assert.ok(!Object.values(files).some((data) => strFromU8(data).includes('PRIVATE_')));
    const manifest = JSON.parse(strFromU8(files['PORTABLE-MANIFEST.json']!));
    assert.equal(manifest.sourceFiles.length, 5);
    assert.match(
      manifest.sourceFiles.find((row: { path: string }) => row.path === 'src/main.ts').sha256,
      /^[a-f0-9]{64}$/,
    );
  } finally {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    await rm(temp, { recursive: true, force: true });
  }
});
test('Relative configuration resolves against the project, preserving explicit in-memory SQLite', () => {
  assert.equal(loadConfig({}).databasePath, projectPath('data/bot.sqlite'));
  assert.equal(loadConfig({ DATABASE_PATH: ':memory:' }).databasePath, ':memory:');
  assert.equal(
    loadConfig({ VOICE_AUDIO_DIRECTORY: 'audio' }).voiceAudioDirectory,
    join(PROJECT_ROOT, 'audio'),
  );
});
