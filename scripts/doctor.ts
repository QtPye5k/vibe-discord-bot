import '../src/core/environment.js';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getCiphers } from 'node:crypto';
import { REST, Routes, ApplicationFlags } from 'discord.js';
import OpenAI from 'openai';
import { credentialPresent, loadConfig } from '../src/config.js';
import { Logger } from '../src/core/logger.js';
import { probeVoiceRuntime, voiceDependencyDetails } from '../src/voice/runtime.js';
import { projectPath } from '../src/core/paths.js';
import { createLocalTranscriber } from '../src/voice/local-transcriber.js';

const config = loadConfig();
const logger = new Logger([config.discordToken, config.openaiKey]);
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'NEEDS SETUP'} ${name}${detail ? `: ${detail}` : ''}`);
};
check(
  'Node 24.17+',
  Number(process.versions.node.split('.')[0]) === 24 && Number(process.versions.node.split('.')[1]) >= 17,
  process.versions.node,
);
check('.env exists', existsSync(process.env.DOTENV_CONFIG_PATH || projectPath('.env')));
check('Discord token present', credentialPresent(config.discordToken));
check(
  'OpenAI API key present',
  credentialPresent(config.openaiKey),
  'Required for AI, image and speech features',
);
check('Production build exists', existsSync(projectPath('dist/main.js')), 'Run pnpm build after edits');
check(
  'Image model is not the retired gpt-image-1 alias',
  config.imageModel !== 'gpt-image-1' && config.imageEditModel !== 'gpt-image-1',
  'Retired 2026-10-23; use the current image defaults in .env.example.',
);
if (config.model === 'gpt-5-mini')
  console.log(
    'NOTICE gpt-5-mini remains supported until 2026-12-11. Plan a model migration before that date.',
  );
if (config.speechModel === 'gpt-4o-mini-tts')
  console.log(
    `NOTICE gpt-4o-mini-tts remains supported until 2027-01-06. Spoken action receipts use it; ordinary conversation uses ${config.voiceResponseBackend}.`,
  );
for (const binary of ['ffmpeg', 'ffprobe']) {
  try {
    const version = execFileSync(binary, ['-version'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 65536,
    })
      .split('\n')[0]
      ?.trim();
    check(`${binary} available`, true, version);
  } catch {
    check(`${binary} available`, false, 'Install FFmpeg on PATH for audio/video file processing.');
  }
}
check('AES-256-GCM available', getCiphers().includes('aes-256-gcm'));
console.log(
  `Configured privileged intents: members=${config.enableMembers}, presences=${config.enablePresences}, message_content=${config.enableMessageContent}`,
);
if (config.enableVoice || process.argv.includes('--voice')) {
  console.log(
    `Voice configuration: response=${config.voiceResponseBackend}, transcription=${config.voiceTranscriptionBackend}, voice=${config.speechVoice}, wake=${config.voiceRequireWakeWord}, transcripts=${config.voiceTranscriptChannelId || config.voiceTranscriptChannelName}`,
  );
  if (config.voiceTranscriptionBackend === 'local') {
    const transcriber = createLocalTranscriber({
      model: config.localWhisperModel,
      cacheDir: config.localWhisperCacheDirectory,
      allowDownload: false,
    });
    try {
      await transcriber.prepare();
      check('Local transcription model and native inference', true, config.localWhisperModel);
    } catch (error) {
      check(
        'Local transcription model and native inference',
        false,
        error instanceof Error ? error.message : 'Run pnpm voice:prepare.',
      );
    } finally {
      await transcriber.close();
    }
  }
  try {
    const voice = await probeVoiceRuntime();
    check(
      'Voice raw PCM/volume/Opus encode and decode',
      true,
      `${voice.voiceVersion}; ${voice.opusBackend}; ${voice.encodedFrames} frames/${voice.decodedPcmBytes} decoded bytes`,
    );
    check(
      'Voice native DAVE session and key generation',
      true,
      `protocol ${voice.daveProtocolVersion}; ${voice.daveKeyPackageBytes}-byte key package`,
    );
    console.log(
      'Optional alternative Opus/encryption libraries are not required when these executable checks pass.',
    );
    if (process.argv.includes('--dependencies'))
      console.log(`Voice alternatives:\n${await voiceDependencyDetails()}`);
  } catch (error) {
    check('Voice runtime', false, error instanceof Error ? error.message : 'Voice runtime failed.');
  }
} else console.log('Voice audio is disabled; use --voice to explicitly check its runtime dependencies.');
if (process.argv.includes('--live')) {
  if (credentialPresent(config.discordToken))
    try {
      const rest = new REST({ version: '10', timeout: 15000, retries: 0 }).setToken(config.discordToken);
      const application = (await rest.get('/oauth2/applications/@me')) as { id: string; flags: number };
      const user = (await rest.get(Routes.user('@me'))) as { id: string; bot: boolean };
      check('Discord authenticated bot identity', user.bot && user.id === application.id);
      const flags = application.flags;
      if (config.enablePresences)
        check(
          'Presence Intent configured',
          !!(flags & (ApplicationFlags.GatewayPresence | ApplicationFlags.GatewayPresenceLimited)),
        );
      if (config.enableMembers)
        check(
          'Server Members Intent configured',
          !!(flags & (ApplicationFlags.GatewayGuildMembers | ApplicationFlags.GatewayGuildMembersLimited)),
        );
      if (config.enableMessageContent)
        check(
          'Message Content Intent configured',
          !!(
            flags &
            (ApplicationFlags.GatewayMessageContent | ApplicationFlags.GatewayMessageContentLimited)
          ),
        );
    } catch (error) {
      check('Discord authentication', false);
      logger.error('doctor.discord', error);
    }
  if (credentialPresent(config.openaiKey))
    try {
      const openai = new OpenAI({ apiKey: config.openaiKey, maxRetries: 0, timeout: 15000 });
      await openai.models.retrieve(config.model);
      check('OpenAI authentication and configured text model', true);
    } catch (error) {
      check('OpenAI authentication/model', false);
      logger.error('doctor.openai', error);
    }
  console.log(
    'Live checks are read-only. They do not verify sending messages, role mutations, voice UDP, or paid generation.',
  );
} else
  console.log(
    'Offline checks only. pnpm run doctor --live explicitly tests read-only service authentication after you supply credentials.',
  );
if (checks.some((c) => !c.ok)) process.exitCode = 1;
