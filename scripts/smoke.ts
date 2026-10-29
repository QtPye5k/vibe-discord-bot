import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codePath } from '../src/core/paths.js';

const run = promisify(execFile);
const temporaryRoot = realpathSync(tmpdir());
const directory = mkdtempSync(join(temporaryRoot, 'discord-bot-smoke-'));
const file = pathToFileURL(codePath('dist/features/media.js')).href;
const core = pathToFileURL(codePath('dist/core/store.js')).href;
const officeFile = pathToFileURL(codePath('dist/features/files.js')).href;
const audioFile = pathToFileURL(codePath('dist/features/audio-media.js')).href;
const voiceFile = pathToFileURL(codePath('dist/voice/runtime.js')).href;
const smokeEnvFile = join(directory, 'offline.env');
writeFileSync(smokeEnvFile, '');
const smokeEnvironment = {
  ...process.env,
  // Production imports dotenv/config. Keep offline smoke independent of the operator's .env.
  DOTENV_CONFIG_PATH: smokeEnvFile,
  DISCORD_TOKEN: 'placeholder',
  DISCORD_BOT_TOKEN: 'placeholder',
  OPENAI_API_KEY: 'placeholder',
  HEALTH_PORT: '0',
  ENABLE_DASHBOARD: 'false',
  ENABLE_WEBHOOK_EVENTS: 'false',
};
try {
  let exitCode: number | undefined,
    output = '';
  try {
    await run(process.execPath, [codePath('scripts/start.mjs')], {
      timeout: 15000,
      env: smokeEnvironment,
      cwd: directory,
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    exitCode = failure.code;
    output = (failure.stdout ?? '') + (failure.stderr ?? '');
  }
  assert.equal(exitCode, 1);
  assert.match(output, /startup.credentials_required/);
  console.log('PASS production startup rejects missing credentials without connecting');
  assert.ok(readFileSync(codePath('dist/web/activity.js')).length > 10000);
  assert.ok(readFileSync(codePath('dist/web/activity.css')).length > 1000);
  console.log('PASS compiled Activity SDK bundle and stylesheet are included');
  const voice = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const {probeVoiceRuntime}=await import(${JSON.stringify(voiceFile)});const report=await probeVoiceRuntime();if(report.encodedFrames!==3||report.decodedPcmBytes!==11520||report.daveKeyPackageBytes<100)throw new Error('Incomplete voice runtime');console.log('PASS compiled Opus encode/decode, inline volume, AES-GCM and native DAVE key generation');`,
    ],
    { timeout: 15000, env: smokeEnvironment, cwd: directory, windowsHide: true },
  );
  process.stdout.write(voice.stdout);
  const workerScript = `const {runMediaJob}=await import(${JSON.stringify(file)});
    const result=await runMediaJob({kind:'hash',data:Buffer.from('abc')});
    if(result.sha256!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')throw new Error('hash mismatch');
    const card=await runMediaJob({kind:'card',input:{title:'Deployment smoke test',subtitle:'Compiled worker',progress:0.5}});
    if(!Buffer.isBuffer(card.attachment)||card.attachment.length<100)throw new Error('compiled media worker failed');
    console.log('PASS compiled native worker hash and PNG generation');`;
  const workerEntry = join(directory, 'worker-smoke.mjs');
  writeFileSync(workerEntry, workerScript);
  const worker = await run(process.execPath, [workerEntry], {
    timeout: 30000,
    env: smokeEnvironment,
    windowsHide: true,
  });
  process.stdout.write(worker.stdout);
  const officeScript = `const assert=await import('node:assert/strict');
    const {readFileSync,writeFileSync}=await import('node:fs');
    const {runFileJob}=await import(${JSON.stringify(officeFile)});
    const book=await runFileJob({kind:'xlsx',input:{sheets:[{name:'Smoke',headerRow:true,rows:[['Label','Count','Enabled'],['=literal',7,true]]}]}});
    assert.ok(Buffer.isBuffer(book.attachment));assert.ok(book.attachment.length>100);assert.equal(book.name,'workbook.xlsx');
    const path=${JSON.stringify(join(directory, 'compiled-smoke.xlsx'))};writeFileSync(path,book.attachment);
    const result=await runFileJob({kind:'extract',data:readFileSync(path),filename:'compiled-smoke.xlsx'});
    assert.deepEqual(result.sheets?.map(sheet=>({name:sheet.name,rows:sheet.rows})),[{name:'Smoke',rows:[['Label','Count','Enabled'],['=literal',7,true]]}]);
    console.log('PASS compiled Office worker XLSX generation, Buffer transfer and typed-cell extraction');`;
  const officeEntry = join(directory, 'office-smoke.mjs');
  writeFileSync(officeEntry, officeScript);
  const office = await run(process.execPath, [officeEntry], {
    timeout: 45000,
    env: smokeEnvironment,
    windowsHide: true,
  });
  process.stdout.write(office.stdout);
  const audioScript = `const assert=await import('node:assert/strict');
    const {readFileSync,writeFileSync}=await import('node:fs');
    const {processAudioMedia,inspectAudioMedia}=await import(${JSON.stringify(audioFile)});
    const rate=16000,frames=rate,wav=Buffer.alloc(44+frames*2);
    wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
    wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);
    wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(frames*2,40);
    for(let frame=0;frame<frames;frame++)wav.writeInt16LE(Math.round(8000*Math.sin(frame*440*2*Math.PI/rate)),44+frame*2);
    const source=${JSON.stringify(join(directory, 'synthetic-tone.wav'))},target=${JSON.stringify(join(directory, 'converted-tone.flac'))};
    writeFileSync(source,wav);const original=await inspectAudioMedia(readFileSync(source));
    assert.equal(original.streams.length,1);assert.equal(original.streams[0].codec,'pcm_s16le');assert.equal(original.streams[0].sampleRate,16000);assert.equal(original.streams[0].channels,1);
    const converted=await processAudioMedia(readFileSync(source),{kind:'audio',format:'flac',startSeconds:0.25,durationSeconds:0.25});
    assert.ok(Buffer.isBuffer(converted.attachment));assert.equal(converted.name,'audio.flac');assert.ok(converted.attachment.length>100&&converted.attachment.length<100000);
    assert.equal(converted.attachment.subarray(0,4).toString(),'fLaC');writeFileSync(target,converted.attachment);
    const result=await inspectAudioMedia(readFileSync(target));assert.equal(result.streams.length,1);assert.equal(result.streams[0].type,'audio');assert.equal(result.streams[0].codec,'flac');assert.equal(result.streams[0].sampleRate,48000);assert.equal(result.streams[0].channels,2);
    console.log('PASS compiled FFmpeg synthetic WAV conversion and FFprobe codec/rate/channel verification');`;
  const audioEntry = join(directory, 'audio-smoke.mjs');
  writeFileSync(audioEntry, audioScript);
  const audio = await run(process.execPath, [audioEntry], {
    timeout: 60000,
    env: smokeEnvironment,
    windowsHide: true,
  });
  process.stdout.write(audio.stdout);
  const database = join(directory, 'source.sqlite'),
    snapshot = join(directory, 'snapshot.sqlite');
  const sqliteScript = `const {Store}=await import(${JSON.stringify(core)});const {backup,DatabaseSync}=await import('node:sqlite');
    const store=new Store(${JSON.stringify(database)});store.set('smoke','state',{survives:true});
    await backup(store.db,${JSON.stringify(snapshot)});store.close();
    const restored=new Store(${JSON.stringify(snapshot)});if(!restored.get('smoke','state')?.survives)throw new Error('backup mismatch');restored.close();
    const future=new DatabaseSync(${JSON.stringify(snapshot)});future.exec('PRAGMA user_version=99');future.close();
    let rejected=false;try{new Store(${JSON.stringify(snapshot)});}catch{rejected=true;}if(!rejected)throw new Error('future schema accepted');
    console.log('PASS compiled SQLite persistence, consistent backup/restore and schema protection');`;
  const sqlite = await run(process.execPath, ['--input-type=module', '-e', sqliteScript], {
    timeout: 15000,
    env: smokeEnvironment,
    windowsHide: true,
  });
  process.stdout.write(sqlite.stdout);
} finally {
  assert.ok(
    resolve(directory).startsWith(temporaryRoot + sep),
    'Temporary cleanup path must remain inside the system temp folder',
  );
  assert.equal(dirname(resolve(directory)), temporaryRoot);
  assert.equal(dirname(realpathSync(directory)), temporaryRoot);
  assert.match(basename(directory), /^discord-bot-smoke-/);
  rmSync(directory, { recursive: true, force: true });
}
