import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { probeVoiceRuntime, prepareVoiceRuntime, waitForVoiceRecovery } from '../src/voice/runtime.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve('tsx/esm')).href;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('SDK reconnect recovery keeps a transient connection and cleans competing state listeners', async () => {
  const { sdk } = await prepareVoiceRuntime(),
    connection = new EventEmitter() as EventEmitter & { state: { status: string } };
  connection.state = { status: sdk.VoiceConnectionStatus.Disconnected };
  const work = waitForVoiceRecovery(connection as never, sdk);
  connection.state = { status: sdk.VoiceConnectionStatus.Connecting };
  connection.emit(sdk.VoiceConnectionStatus.Connecting);
  await new Promise<void>((done) => setImmediate(done));
  connection.state = { status: sdk.VoiceConnectionStatus.Ready };
  connection.emit(sdk.VoiceConnectionStatus.Ready);
  await work;
  assert.equal(connection.listenerCount(sdk.VoiceConnectionStatus.Signalling), 0);
  assert.equal(connection.listenerCount(sdk.VoiceConnectionStatus.Connecting), 0);
  assert.equal(connection.listenerCount(sdk.VoiceConnectionStatus.Ready), 0);
});

test('reconnect waits are bounded and explicit shutdown cancels them without forcing a rejoin', async (t) => {
  const { sdk } = await prepareVoiceRuntime();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  for (const [state, deadline] of [
    [sdk.VoiceConnectionStatus.Disconnected, 5000],
    [sdk.VoiceConnectionStatus.Connecting, 20000],
  ] as const) {
    const connection = new EventEmitter() as EventEmitter & { state: { status: string } };
    connection.state = { status: state };
    const work = waitForVoiceRecovery(connection as never, sdk),
      rejected = assert.rejects(work);
    t.mock.timers.tick(deadline + 1);
    await rejected;
    assert.equal(connection.listenerCount(sdk.VoiceConnectionStatus.Ready), 0);
  }
  const connection = new EventEmitter() as EventEmitter & { state: { status: string } },
    controller = new AbortController();
  connection.state = { status: sdk.VoiceConnectionStatus.Disconnected };
  const work = waitForVoiceRecovery(connection as never, sdk, controller.signal),
    rejected = assert.rejects(work);
  controller.abort();
  await rejected;
  assert.equal(connection.listenerCount(sdk.VoiceConnectionStatus.Signalling), 0);
  assert.equal(connection.listenerCount(sdk.VoiceConnectionStatus.Connecting), 0);
});
function temporary(t: TestContext): string {
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, 'discord-voice-runtime-'));
  t.after(() => {
    assert.equal(dirname(realpathSync(directory)), base);
    assert.match(basename(directory), /^discord-voice-runtime-/);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('voice runtime performs actual volume/Opus encode/decode and native DAVE cryptographic initialization', async () => {
  const result = await probeVoiceRuntime();
  assert.equal(result.voiceVersion, '0.19.2');
  assert.ok(['opusscript', '@discordjs/opus', 'node-opus'].includes(result.opusBackend));
  assert.equal(result.encodedFrames, 3);
  assert.equal(result.decodedPcmBytes, 11520);
  assert.equal(result.daveProtocolVersion, 1);
  assert.ok(result.daveKeyPackageBytes >= 100);
  assert.equal(result.aesGcm, true);
  const [first, second] = await Promise.all([prepareVoiceRuntime(), prepareVoiceRuntime()]);
  assert.equal(first, second);
});

test('voice runtime and native package resolution remain functional outside the project working directory', async (t) => {
  const directory = temporary(t);
  const entry = pathToFileURL(join(root, 'src/voice/runtime.ts')).href;
  const output = await run(
    process.execPath,
    [
      '--import',
      tsx,
      '--input-type=module',
      '-e',
      `const {probeVoiceRuntime}=await import(${JSON.stringify(entry)});const result=await probeVoiceRuntime();if(result.decodedPcmBytes!==11520||result.daveKeyPackageBytes<100)throw new Error('Incomplete runtime');console.log('independent-cwd voice runtime passed');`,
    ],
    { cwd: directory, timeout: 20000, windowsHide: true },
  );
  assert.match(output.stdout, /independent-cwd voice runtime passed/);
});

test('an unavailable voice native dependency cannot prevent non-voice service construction and yields actionable join failure', async (t) => {
  const directory = temporary(t);
  const entry = pathToFileURL(join(root, 'src/features/voice.ts')).href;
  const output = await run(
    process.execPath,
    [
      '--import',
      tsx,
      '--input-type=module',
      '-e',
      `import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){if(specifier==='@discordjs/voice'){const error=new Error('Simulated native binary incompatibility');error.code='ERR_DLOPEN_FAILED';throw error;}return next(specifier,context);}});
    const {VoiceService}=await import(${JSON.stringify(entry)});const voice=new VoiceService();
    const channel={id:'900000000000000002',type:2,guild:{id:'900000000000000003'},permissionsFor:()=>({has:()=>true})};
    const ctx={guild:{id:'900000000000000003',members:{me:{id:'bot'}}},member:{id:'900000000000000001',voice:{channel}}};
    try{await voice.join(ctx);throw new Error('Missing dependency was ignored');}catch(error){if(error.name!=='UserError'||!error.message.includes('pnpm run doctor')||!error.message.includes('SDK/DAVE'))throw error;}
    finally{voice.close();await voice.drain();}console.log('optional voice failure isolated');`,
    ],
    { cwd: directory, timeout: 20000, windowsHide: true },
  );
  assert.match(output.stdout, /optional voice failure isolated/);
});
