import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from '../src/config.js';
import { createLocalTranscriber } from '../src/voice/local-transcriber.js';

type PreparationConfig = Pick<
  Config,
  'enableVoice' | 'voiceTranscriptionBackend' | 'localWhisperModel' | 'localWhisperCacheDirectory'
>;
type PreparationClient = { prepare(): Promise<void>; close(): Promise<void> };
type PreparationFactory = (options: {
  model: string;
  cacheDir: string;
  allowDownload: true;
}) => PreparationClient;

/** Downloads/initializes only local model assets; no Discord login, OpenAI request or audio input. */
export async function prepareVoice(
  config: PreparationConfig,
  factory: PreparationFactory = createLocalTranscriber,
): Promise<boolean> {
  if (!config.enableVoice || config.voiceTranscriptionBackend !== 'local') return false;
  const transcriber = factory({
    model: config.localWhisperModel,
    cacheDir: config.localWhisperCacheDirectory,
    allowDownload: true,
  });
  try {
    await transcriber.prepare();
    return true;
  } finally {
    await transcriber.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await import('../src/core/environment.js');
  try {
    const config = loadConfig();
    if (config.enableVoice && config.voiceTranscriptionBackend === 'local')
      console.log(
        `Preparing local speech model ${config.localWhisperModel}. The first run downloads model assets.`,
      );
    const prepared = await prepareVoice(config);
    console.log(
      prepared
        ? `Local speech is ready. Cache: ${config.localWhisperCacheDirectory}`
        : 'Local speech preparation skipped: voice is disabled or uses the OpenAI transcription backend.',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Local speech preparation failed.');
    process.exitCode = 1;
  }
}
