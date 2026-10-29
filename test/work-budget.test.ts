import assert from 'node:assert/strict';
import test from 'node:test';
import { heavyWork } from '../src/core/work-budget.js';
import { runMediaJob } from '../src/features/media.js';
import { runFileJob } from '../src/features/files.js';
import { processAudioMedia } from '../src/features/audio-media.js';
import { pcmToWav } from '../src/features/voice.js';
test('Image, Office and FFmpeg work share the same bounded admission budget and release idempotently', async () => {
  const first = heavyWork.enter(),
    second = heavyWork.enter();
  try {
    await assert.rejects(() => runMediaJob({ kind: 'hash', data: Buffer.from('abc') }), /busy/);
    await assert.rejects(() => runFileJob({ kind: 'csv', input: { headers: ['a'], rows: [[1]] } }), /busy/);
    await assert.rejects(() => processAudioMedia(pcmToWav(Buffer.alloc(400)), { kind: 'audio' }), /busy/);
    first();
    first();
    const result = await runMediaJob({ kind: 'hash', data: Buffer.from('abc') });
    assert.ok('sha256' in result);
  } finally {
    first();
    second();
  }
  const result = await runFileJob({ kind: 'csv', input: { headers: ['a'], rows: [[1]] } });
  assert.ok('attachment' in result);
});
