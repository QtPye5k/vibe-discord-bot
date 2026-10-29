import { projectPath } from './core/paths.js';
import { z } from 'zod';
import { OPTIONAL_INTEGRATION_FIELDS } from './integrations/provider-catalog.js';
import { ADDITIONAL_SERVICE_FIELDS } from './service-fields.js';

const bool = (fallback: boolean) =>
  z.preprocess(
    (v) => (v === undefined ? String(fallback) : String(v)),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
  );
const number = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const ids = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .refine((v) => v.every((s) => /^\d{17,20}$/.test(s)), 'Use comma-separated Discord IDs');
const settings = z.object({
  botName: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .refine((value) => !/[\u0000-\u001f\u007f<>]/.test(value), 'Bot name must be plain single-line text')
    .default('Vibe'),
  confirmationMode: z.enum(['smart', 'always']).default('smart'),
  timeZone: z
    .string()
    .default('America/New_York')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Use an IANA timezone such as America/New_York'),
  discordToken: z.string().default(''),
  optionalEnvironment: z.record(z.string(), z.string()).default({}),
  openaiKey: z.string().default(''),
  autoModerationEnabled: bool(false),
  moderationModel: z.string().trim().min(1).max(100).default('omni-moderation-latest'),
  moderationTimeoutMs: number(12000, 1000, 60000),
  moderationLogChannelId: z
    .string()
    .regex(/^(?:\d{17,20})?$/)
    .default(''),
  honeypotChannelId: z
    .string()
    .regex(/^(?:\d{17,20})?$/)
    .default(''),
  guildIds: ids,
  operatorIds: ids,
  discordPublicKey: z
    .string()
    .regex(/^(?:[a-fA-F0-9]{64})?$/)
    .default(''),
  enableWebhookEvents: bool(false),
  enableUserInstall: bool(false),
  enableDashboard: bool(false),
  dashboardBaseUrl: z.string().default(''),
  pluginIds: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(20)),
  localOperationsManifest: z.string().default(''),
  databasePath: z.string().default('data/bot.sqlite'),
  model: z.string().min(1).default('gpt-5-mini'),
  imageModel: z.string().min(1).default('gpt-image-2.5-flare'),
  imageEditModel: z.string().min(1).default('gpt-image-2.5-sunburst'),
  speechModel: z.string().min(1).default('gpt-4o-mini-tts'),
  transcriptionModel: z.string().min(1).default('gpt-transcribe'),
  voiceTranscriptionBackend: z.enum(['local', 'openai']).default('local'),
  localWhisperModel: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
    .default('Xenova/whisper-tiny.en'),
  localWhisperCacheDirectory: z.string().default(projectPath('.cache/models')),
  speechVoice: z.string().trim().min(1).max(64).default('marin'),
  realtimeModel: z.string().min(1).default('gpt-realtime-2.1'),
  voiceResponseBackend: z.enum(['realtime', 'pipeline']).default('realtime'),
  voiceTranscriptChannelId: z
    .string()
    .regex(/^(?:\d{17,20})?$/)
    .default(''),
  voiceTranscriptChannelName: z
    .string()
    .regex(/^[a-z0-9_-]{1,100}$/)
    .default('vibe-transcripts'),
  voiceRequireWakeWord: bool(true),
  voiceWakeWords: z
    .string()
    .default('Vibe')
    .transform((value) =>
      value
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(1).max(40)).max(10)),
  voiceFollowUpSeconds: number(60, 5, 60),
  voiceSilenceMs: number(450, 250, 1500),
  enableMessageContent: bool(false),
  enableMembers: bool(false),
  enablePresences: bool(false),
  enableVoice: bool(true),
  maxVoiceSessions: number(5, 1, 20),
  voiceAudioDirectory: z.string().default(''),
  enableWebSearch: bool(false),
  prefix: z.string().max(8).default('!'),
  maxAiRequestsPerUserDay: number(50, 1, 10000),
  maxAiRequestsPerGuildDay: number(500, 1, 100000),
  maxAiConcurrent: number(3, 1, 20),
  maxOutputTokens: number(2000, 128, 16000),
  aiTimeoutMs: number(60000, 1000, 300000),
  maxToolRounds: number(5, 1, 10),
  maxAttachmentBytes: number(8388608, 1024, 25000000),
  memoryDays: number(7, 1, 90),
  auditDays: number(30, 1, 365),
  confirmationSeconds: number(120, 30, 600),
  healthPort: number(0, 0, 65535),
  healthHost: z.string().default('127.0.0.1'),
});
export type Config = z.infer<typeof settings>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = settings.parse({
    botName: env.BOT_NAME || undefined,
    confirmationMode: env.CONFIRMATION_MODE || undefined,
    timeZone: env.BOT_TIME_ZONE || undefined,
    optionalEnvironment: Object.fromEntries(
      [...OPTIONAL_INTEGRATION_FIELDS, ...ADDITIONAL_SERVICE_FIELDS].flatMap((field) =>
        env[field.name] === undefined ? [] : [[field.name, env[field.name]!]],
      ),
    ),
    discordToken: env.DISCORD_TOKEN || env.DISCORD_BOT_TOKEN || '',
    openaiKey: env.OPENAI_API_KEY || '',
    autoModerationEnabled: env.AUTO_MODERATION_ENABLED,
    moderationModel: env.OPENAI_MODERATION_MODEL || undefined,
    moderationTimeoutMs: env.MODERATION_TIMEOUT_MS,
    moderationLogChannelId: env.MODERATION_LOG_CHANNEL_ID,
    honeypotChannelId: env.HONEYPOT_CHANNEL_ID,
    guildIds: env.DISCORD_GUILD_IDS || env.DISCORD_GUILD_ID,
    operatorIds: env.OPERATOR_IDS,
    discordPublicKey: env.DISCORD_PUBLIC_KEY,
    enableWebhookEvents: env.ENABLE_WEBHOOK_EVENTS,
    enableUserInstall: env.ENABLE_USER_INSTALL,
    enableDashboard: env.ENABLE_DASHBOARD,
    dashboardBaseUrl: env.DASHBOARD_BASE_URL,
    pluginIds: env.PLUGIN_MODULES,
    localOperationsManifest: env.LOCAL_OPERATIONS_MANIFEST,
    databasePath: env.DATABASE_PATH,
    model: env.OPENAI_MODEL,
    imageModel: env.OPENAI_IMAGE_MODEL,
    imageEditModel: env.OPENAI_IMAGE_EDIT_MODEL,
    speechModel: env.OPENAI_SPEECH_MODEL,
    transcriptionModel: env.OPENAI_TRANSCRIPTION_MODEL,
    voiceTranscriptionBackend: env.VOICE_TRANSCRIPTION_BACKEND || undefined,
    localWhisperModel: env.LOCAL_WHISPER_MODEL || undefined,
    speechVoice: env.OPENAI_SPEECH_VOICE || env.OPENAI_VOICE,
    realtimeModel: env.OPENAI_REALTIME_MODEL || undefined,
    voiceResponseBackend: env.VOICE_RESPONSE_BACKEND || undefined,
    voiceTranscriptChannelId: env.VOICE_TRANSCRIPT_CHANNEL_ID,
    voiceTranscriptChannelName: env.VOICE_TRANSCRIPT_CHANNEL_NAME || undefined,
    voiceRequireWakeWord: env.VOICE_REQUIRE_WAKE_WORD,
    voiceWakeWords: env.VOICE_WAKE_WORDS || env.BOT_NAME || undefined,
    voiceFollowUpSeconds: env.VOICE_FOLLOW_UP_SECONDS,
    voiceSilenceMs: env.VOICE_SILENCE_MS,
    enableMessageContent: env.ENABLE_MESSAGE_CONTENT,
    enableMembers: env.ENABLE_MEMBERS,
    enablePresences: env.ENABLE_PRESENCES,
    enableVoice: env.ENABLE_VOICE,
    maxVoiceSessions: env.MAX_VOICE_SESSIONS,
    voiceAudioDirectory: env.VOICE_AUDIO_DIRECTORY,
    enableWebSearch: env.ENABLE_WEB_SEARCH,
    prefix: env.COMMAND_PREFIX,
    maxAiRequestsPerUserDay: env.MAX_AI_REQUESTS_PER_USER_DAY,
    maxAiRequestsPerGuildDay: env.MAX_AI_REQUESTS_PER_GUILD_DAY,
    maxAiConcurrent: env.MAX_AI_CONCURRENT,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    aiTimeoutMs: env.AI_TIMEOUT_MS,
    maxToolRounds: env.MAX_TOOL_ROUNDS,
    maxAttachmentBytes: env.MAX_ATTACHMENT_BYTES,
    memoryDays: env.MEMORY_DAYS,
    auditDays: env.AUDIT_DAYS,
    confirmationSeconds: env.CONFIRMATION_SECONDS,
    healthPort:
      (!env.HEALTH_PORT || env.HEALTH_PORT === '0') &&
      (env.APP_PUBLIC_URL || env.ACTIVITY_PUBLIC_URL || env.DEPLOYMENT_WEBHOOK_SECRET)
        ? 3000
        : env.HEALTH_PORT,
    healthHost: env.HEALTH_HOST,
  });
  if (config.databasePath !== ':memory:') config.databasePath = projectPath(config.databasePath);
  if (config.voiceAudioDirectory) config.voiceAudioDirectory = projectPath(config.voiceAudioDirectory);
  if (config.localOperationsManifest)
    config.localOperationsManifest = projectPath(config.localOperationsManifest);
  if (!config.dashboardBaseUrl) config.dashboardBaseUrl = `http://127.0.0.1:${config.healthPort || 3000}`;
  if (config.enableDashboard && !config.healthPort)
    throw new Error('Set HEALTH_PORT to serve the enabled dashboard.');
  if (config.enableWebhookEvents && !config.healthPort)
    throw new Error('Set HEALTH_PORT to serve /discord/events when ENABLE_WEBHOOK_EVENTS=true.');
  return config;
}
export function credentialPresent(value: string): boolean {
  return (
    value.length >= 20 && !/(?:your[_ -]|paste[_ -]|replace[_ -]|example|placeholder|here$)/i.test(value)
  );
}
