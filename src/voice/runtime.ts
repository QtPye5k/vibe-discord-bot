import { getCiphers } from 'node:crypto';
import { Readable } from 'node:stream';
import { UserError } from '../core/errors.js';

type VoiceSdk = typeof import('@discordjs/voice');
type Prism = typeof import('prism-media');
interface VoiceRuntime {
  sdk: VoiceSdk;
  prism: Prism;
}
/** Wait for the SDK's own reconnect sequence; never force a rejoin after a real kick. */
export async function waitForVoiceRecovery(
  connection: InstanceType<VoiceSdk['VoiceConnection']>,
  sdk: Pick<VoiceSdk, 'entersState' | 'VoiceConnectionStatus'>,
  signal?: AbortSignal,
): Promise<void> {
  const waiting = new AbortController(),
    cancellation = signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal,
    { VoiceConnectionStatus: status, entersState } = sdk;
  try {
    cancellation.throwIfAborted();
    if (connection.state.status === status.Ready) return;
    if (connection.state.status === status.Destroyed) throw new Error('Voice connection was destroyed.');
    if (connection.state.status === status.Disconnected) {
      const grace = AbortSignal.any([cancellation, AbortSignal.timeout(5000)]);
      await Promise.any([
        entersState(connection, status.Signalling, grace),
        entersState(connection, status.Connecting, grace),
      ]);
    }
    await entersState(connection, status.Ready, AbortSignal.any([cancellation, AbortSignal.timeout(20000)]));
  } finally {
    // The losing state wait must not leave event listeners behind after recovery.
    waiting.abort();
  }
}
export interface VoiceRuntimeReport {
  voiceVersion: string;
  opusBackend: string;
  encodedFrames: number;
  decodedPcmBytes: number;
  daveProtocolVersion: number;
  daveKeyPackageBytes: number;
  aesGcm: boolean;
}
let modules: Promise<VoiceRuntime> | undefined;
let prepared: Promise<VoiceRuntime> | undefined;

function runtimeFailure(stage: string, cause: unknown): UserError {
  const failure = new UserError(
    `Voice ${stage} could not load on this computer. Run SETUP.cmd or pnpm install --frozen-lockfile on the destination computer, then pnpm run doctor and restart the bot. Do not copy node_modules between operating systems.`,
  );
  // The cause remains available to local diagnostics; Discord receives only the repair guidance above.
  Object.defineProperty(failure, 'cause', { value: cause });
  return failure;
}
async function loadModules(): Promise<VoiceRuntime> {
  modules ??= (async () => {
    let sdk: VoiceSdk;
    try {
      sdk = await import('@discordjs/voice');
    } catch (error) {
      throw runtimeFailure('SDK/DAVE dependency', error);
    }
    try {
      const imported = await import('prism-media');
      return { sdk, prism: imported.default };
    } catch (error) {
      throw runtimeFailure('Opus media dependency', error);
    }
  })();
  return modules;
}

/** Exercise the same raw PCM/volume/Opus path used by playback and the native DAVE key-package path. */
async function probe(runtime: VoiceRuntime): Promise<VoiceRuntimeReport> {
  const { sdk, prism } = runtime;
  const report: VoiceRuntimeReport = {
    voiceVersion: sdk.version,
    opusBackend: '',
    encodedFrames: 0,
    decodedPcmBytes: 0,
    daveProtocolVersion: 1,
    daveKeyPackageBytes: 0,
    aesGcm: getCiphers().includes('aes-256-gcm'),
  };
  if (!report.aesGcm) throw runtimeFailure('AES-256-GCM encryption', new Error('Cipher unavailable'));
  // The pinned voice/DAVE versions implement protocol 1. No network or real Discord identity is used.
  let session: InstanceType<VoiceSdk['DAVESession']> | undefined;
  try {
    session = new sdk.DAVESession(1, '900000000000000001', '900000000000000002', {});
    session.on('keyPackage', (value: Buffer) => {
      report.daveKeyPackageBytes = value.length;
    });
    session.reinit();
    if (report.daveKeyPackageBytes < 100) throw new Error('DAVE generated no usable key package.');
  } catch (error) {
    throw runtimeFailure('native DAVE session', error);
  } finally {
    session?.destroy();
  }
  let resource: ReturnType<VoiceSdk['createAudioResource']> | undefined;
  let decoder: InstanceType<Prism['opus']['Decoder']> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    resource = sdk.createAudioResource(Readable.from([Buffer.alloc(960 * 4 * 3)]), {
      inputType: sdk.StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume!.setVolume(0.5);
    decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    report.opusBackend = prism.opus.Encoder.type;
    const target = decoder;
    resource.playStream.once('error', (error: Error) => target.destroy(error));
    resource.playStream.on('data', () => {
      report.encodedFrames++;
    });
    timer = setTimeout(() => target.destroy(new Error('Voice runtime probe timed out.')), 5000);
    const consume = (async () => {
      for await (const data of target) report.decodedPcmBytes += (data as Buffer).length;
    })();
    resource.playStream.pipe(target);
    await consume;
    if (report.encodedFrames !== 3 || report.decodedPcmBytes !== 960 * 4 * 3)
      throw new Error('Voice pipeline produced incomplete or corrupt PCM frames.');
  } catch (error) {
    throw runtimeFailure('Opus playback/receive pipeline', error);
  } finally {
    if (timer) clearTimeout(timer);
    resource?.playStream.destroy();
    decoder?.destroy();
  }
  return report;
}

/** Diagnostics always execute native operations; an installed package name alone is insufficient. */
export async function probeVoiceRuntime(): Promise<VoiceRuntimeReport> {
  return probe(await loadModules());
}

/** Verify once before the first real connection, without making voice a prerequisite for non-voice startup. */
export function prepareVoiceRuntime(): Promise<VoiceRuntime> {
  prepared ??= (async () => {
    const runtime = await loadModules();
    await probe(runtime);
    return runtime;
  })();
  return prepared;
}

export async function voiceDependencyDetails(): Promise<string> {
  return (await loadModules()).sdk.generateDependencyReport();
}
