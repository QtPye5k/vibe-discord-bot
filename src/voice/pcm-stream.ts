/** Linear PCM16 24 kHz mono → 48 kHz stereo, preserving sample/byte boundaries across network chunks. */
export class SpeechPcmStream {
  private byte: Buffer | undefined;
  private previous: number | undefined;
  push(value: Uint8Array): Buffer {
    let data = Buffer.from(value);
    if (this.byte) {
      data = Buffer.concat([this.byte, data]);
      this.byte = undefined;
    }
    if (data.length % 2) {
      this.byte = Buffer.from(data.subarray(-1));
      data = data.subarray(0, -1);
    }
    if (!data.length) return Buffer.alloc(0);
    const samples = data.length / 2,
      frames = (samples - (this.previous === undefined ? 1 : 0)) * 2,
      output = Buffer.allocUnsafe(frames * 4);
    let offset = 0;
    for (let i = 0; i < samples; i++) {
      const sample = data.readInt16LE(i * 2);
      if (this.previous !== undefined) {
        const middle = Math.round((this.previous + sample) / 2);
        output.writeInt16LE(this.previous, offset);
        output.writeInt16LE(this.previous, offset + 2);
        output.writeInt16LE(middle, offset + 4);
        output.writeInt16LE(middle, offset + 6);
        offset += 8;
      }
      this.previous = sample;
    }
    return output;
  }
  finish(): Buffer {
    if (this.byte) throw new Error('Realtime speech ended with an incomplete PCM16 sample.');
    if (this.previous === undefined) return Buffer.alloc(0);
    const output = Buffer.alloc(8);
    for (let i = 0; i < 8; i += 2) output.writeInt16LE(this.previous, i);
    this.previous = undefined;
    return output;
  }
  clear(): void {
    this.byte?.fill(0);
    this.byte = undefined;
    this.previous = undefined;
  }
}
