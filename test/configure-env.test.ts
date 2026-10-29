import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { configureEnvironment } from '../scripts/configure-env.js';
test('Optional configuration appends blank credentials, preserves exact existing content, and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discord-config-test-'));
  try {
    await writeFile(join(root, '.env.example'), 'DISCORD_TOKEN=\n');
    const original = '# user comments\nDISCORD_TOKEN=private-test-value\n';
    await writeFile(join(root, '.env'), original);
    const fields = [
      {
        name: 'OPTIONAL_TEST_TOKEN',
        provider: 'test',
        secret: true,
        required: true,
        description: 'Optional test credential.',
      },
    ];
    assert.equal((await configureEnvironment(root, true, fields)).added, 1);
    const result = await readFile(join(root, '.env'), 'utf8');
    assert.ok(result.startsWith(original));
    assert.match(result, /OPTIONAL_TEST_TOKEN=\n/);
    assert.equal((await configureEnvironment(root, true, fields)).added, 0);
    assert.ok(!(await readFile(join(root, '.env.example'), 'utf8')).includes('private-test-value'));
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
