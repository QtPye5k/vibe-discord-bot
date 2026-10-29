import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { projectPath } from '../src/core/paths.js';
import { prepareVoice } from '../scripts/prepare-voice.js';

test('Voice defaults use local wake transcription, fixed portable cache and streamed Marin replies', () => {
  const config = loadConfig({});
  assert.equal(config.voiceTranscriptionBackend, 'local');
  assert.equal(config.localWhisperModel, 'Xenova/whisper-tiny.en');
  assert.equal(config.localWhisperCacheDirectory, projectPath('.cache/models'));
  assert.equal(config.voiceResponseBackend, 'realtime');
  assert.equal(config.speechVoice, 'marin');
  assert.equal(config.realtimeModel, 'gpt-realtime-2.1');
  assert.equal(config.confirmationMode, 'smart');
  assert.equal(config.voiceRequireWakeWord, true);
});

test('Transcription backend and fixed model identifiers are explicit validated host settings', () => {
  const config = loadConfig({
    VOICE_TRANSCRIPTION_BACKEND: 'openai',
    LOCAL_WHISPER_MODEL: 'Xenova/whisper-base.en',
    LOCAL_WHISPER_CACHE_DIRECTORY: 'untrusted-override',
  });
  assert.equal(config.voiceTranscriptionBackend, 'openai');
  assert.equal(config.localWhisperModel, 'Xenova/whisper-base.en');
  assert.equal(config.localWhisperCacheDirectory, projectPath('.cache/models'));
  assert.throws(() => loadConfig({ VOICE_TRANSCRIPTION_BACKEND: 'automatic-fallback' }));
  for (const model of ['../outside', 'https://example.com/model', 'Xenova/model/../other', '/tmp/model'])
    assert.throws(() => loadConfig({ LOCAL_WHISPER_MODEL: model }));
});

test('Voice model preparation initializes the configured cache once and always closes without credentials', async () => {
  const config = loadConfig({}),
    seen: unknown[] = [];
  await prepareVoice(config, (options) => {
    seen.push(options);
    return {
      prepare: async () => {
        seen.push('prepare');
      },
      close: async () => {
        seen.push('close');
      },
    };
  });
  assert.deepEqual(seen, [
    { model: 'Xenova/whisper-tiny.en', cacheDir: projectPath('.cache/models'), allowDownload: true },
    'prepare',
    'close',
  ]);
  let closed = false;
  await assert.rejects(
    prepareVoice(config, () => ({
      prepare: async () => {
        throw new Error('Model unavailable');
      },
      close: async () => {
        closed = true;
      },
    })),
    /Model unavailable/,
  );
  assert.equal(closed, true);
});

test('Setup skips all local model work when voice is disabled or transcription is explicitly remote', async () => {
  for (const env of [{ ENABLE_VOICE: 'false' }, { VOICE_TRANSCRIPTION_BACKEND: 'openai' }]) {
    const prepared = await prepareVoice(loadConfig(env), () => {
      throw new Error('Disabled local speech must not download or initialize a worker');
    });
    assert.equal(prepared, false);
  }
});
