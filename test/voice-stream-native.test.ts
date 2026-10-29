import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { prepareVoiceRuntime } from '../src/voice/runtime.js';
import { SpeechPcmStream } from '../src/voice/pcm-stream.js';

test('the real volume/Opus pipeline emits audio before a streaming speech source finishes', async () => {
  const { sdk, prism } = await prepareVoiceRuntime(),
    source = new PassThrough(),
    converter = new SpeechPcmStream();
  const resource = sdk.createAudioResource(source, { inputType: sdk.StreamType.Raw, inlineVolume: true }),
    decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  resource.volume!.setVolume(0.5);
  let first!: () => void,
    packets = 0,
    timer: NodeJS.Timeout | undefined;
  const began = new Promise<void>((resolve) => {
    first = resolve;
  });
  resource.playStream.once('error', (error) => decoder.destroy(error));
  resource.playStream.on('data', () => {
    packets++;
    first();
  });
  const decoded = (async () => {
    let bytes = 0;
    for await (const data of decoder) bytes += (data as Buffer).length;
    return bytes;
  })();
  void decoded.catch(() => {});
  resource.playStream.pipe(decoder);
  try {
    const input = Buffer.alloc(4800);
    for (let frame = 0; frame < input.length / 2; frame++)
      input.writeInt16LE(Math.round(5000 * Math.sin((frame * 440 * Math.PI * 2) / 24000)), frame * 2);
    source.write(converter.push(input));
    await Promise.race([
      began,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('No live Opus packet arrived before the source ended')),
          5000,
        );
      }),
    ]);
    assert.equal(source.writableEnded, false);
    assert(packets > 0);
    source.end(converter.finish());
    assert.equal(await decoded, 19200);
    assert.equal(packets, 5);
  } finally {
    if (timer) clearTimeout(timer);
    source.destroy();
    resource.playStream.destroy();
    decoder.destroy();
    converter.clear();
  }
});
