import { randomBytes } from 'node:crypto';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
export interface VoiceRecordingPolicy {
  enabled: boolean;
  retentionHours: number;
  maximumRecordings: number;
  version: string;
}
const initialized = new WeakSet<Store>();
function tables(store: Store): void {
  if (initialized.has(store)) return;
  store.db.exec(
    `CREATE TABLE IF NOT EXISTS voice_recordings(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,channel_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,audio BLOB NOT NULL);CREATE INDEX IF NOT EXISTS voice_recordings_owner ON voice_recordings(guild_id,user_id,created_at);CREATE INDEX IF NOT EXISTS voice_recordings_expiry ON voice_recordings(expires_at);`,
  );
  initialized.add(store);
}
export function pruneVoiceRecordings(store: Store, now = Date.now()): void {
  tables(store);
  store.db.prepare('DELETE FROM voice_recordings WHERE expires_at<=?').run(now);
}
export function saveVoiceRecording(
  store: Store,
  guildId: string,
  userId: string,
  channelId: string,
  audio: Buffer,
  policy: VoiceRecordingPolicy,
  now = Date.now(),
): { id: string; bytes: number; expiresAt: number } {
  if (audio.length > 3_000_000 || audio.subarray(0, 4).toString() !== 'RIFF')
    throw new UserError('Recording exceeds the per-utterance WAV bound.');
  pruneVoiceRecordings(store, now);
  return store.transaction(() => {
    const current = store.get<VoiceRecordingPolicy>('voice.recordingPolicy', guildId);
    if (!current?.enabled || current.version !== policy.version)
      throw new UserError('Recording consent policy changed.');
    const count = Number(
        store.db.prepare('SELECT count(*) AS n FROM voice_recordings WHERE guild_id=?').get(guildId)?.n ?? 0,
      ),
      size = Number(
        store.db.prepare('SELECT COALESCE(sum(length(audio)),0) AS bytes FROM voice_recordings').get()
          ?.bytes ?? 0,
      );
    if (count >= policy.maximumRecordings || size + audio.length > 64 * 1048576)
      throw new UserError(
        'Voice archive is full; erase old recordings before capturing more (64 MiB overall).',
      );
    const id = randomBytes(12).toString('hex'),
      expiresAt = now + policy.retentionHours * 3600000;
    store.db
      .prepare('INSERT INTO voice_recordings VALUES(?,?,?,?,?,?,?)')
      .run(id, guildId, userId, channelId, now, expiresAt, audio);
    return { id, bytes: audio.length, expiresAt };
  });
}
export function ownVoiceRecordings(store: Store, guildId: string, userId: string, now = Date.now()) {
  pruneVoiceRecordings(store, now);
  return store.db
    .prepare(
      'SELECT id,channel_id AS channelId,created_at AS createdAt,expires_at AS expiresAt,length(audio) AS bytes FROM voice_recordings WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100',
    )
    .all(guildId, userId);
}
export function voiceRecording(
  store: Store,
  guildId: string,
  userId: string,
  id: string,
  now = Date.now(),
): { channelId: string; attachment: Buffer; name: string } {
  pruneVoiceRecordings(store, now);
  const row = store.db
    .prepare('SELECT channel_id,audio FROM voice_recordings WHERE id=? AND guild_id=? AND user_id=?')
    .get(id, guildId, userId);
  if (!row) throw new UserError('Recording is expired or belongs to another account.');
  return {
    channelId: String(row.channel_id),
    attachment: Buffer.from(row.audio as Uint8Array),
    name: `voice-${id}.wav`,
  };
}
export function eraseVoiceRecordings(store: Store, guildId: string, userId: string): number {
  tables(store);
  return Number(
    store.db.prepare('DELETE FROM voice_recordings WHERE guild_id=? AND user_id=?').run(guildId, userId)
      .changes,
  );
}
/** Acoustic energy VAD over 20ms PCM16 stereo frames; it detects activity, not speaker identity or semantic speech. */
export function acousticVoiceActivity(
  pcm: Uint8Array,
  thresholdDb = -42,
): { active: boolean; activeFrames: number; frames: number; peak: number; rmsDb: number } {
  if (
    pcm.byteLength % 4 ||
    pcm.byteLength > 15 * 48000 * 4 ||
    !Number.isFinite(thresholdDb) ||
    thresholdDb < -60 ||
    thresholdDb > -20
  )
    throw new UserError('Use bounded PCM16 stereo and a VAD threshold between -60 and -20 dB.');
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    samples = bytes.length / 2,
    frameSamples = 960 * 2,
    threshold = 32768 * 10 ** (thresholdDb / 20);
  let activeFrames = 0,
    frames = 0,
    total = 0,
    peak = 0;
  for (let offset = 0; offset < samples; offset += frameSamples) {
    let power = 0,
      count = 0;
    for (let index = offset; index < Math.min(samples, offset + frameSamples); index++) {
      const value = bytes.readInt16LE(index * 2);
      power += value * value;
      peak = Math.max(peak, Math.abs(value));
      count++;
    }
    frames++;
    total += power;
    if (count && Math.sqrt(power / count) >= threshold) activeFrames++;
  }
  return {
    active: activeFrames >= Math.max(1, Math.ceil(frames * 0.05)),
    activeFrames,
    frames,
    peak,
    rmsDb: samples ? 20 * Math.log10(Math.max(1e-9, Math.sqrt(total / samples) / 32768)) : -180,
  };
}
