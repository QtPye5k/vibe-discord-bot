import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { ActionRegistry } from '../src/core/registry.js';
import {
  MEDIA_LIMITS,
  registerMediaActions,
  inspectImage,
  processImage,
  createCard,
  createBarChart,
  escapeXml,
  inspectPdf,
  mergePdfs,
  splitPdf,
  createPdfReport,
  runMediaJob,
  prepareSticker,
  createAnimation,
} from '../src/features/media.js';

async function coloredPng(width = 64, height = 32) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 3;
      data[index + (x < width / 2 ? 0 : 1)] = 255;
    }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}
async function pdfWithWidths(widths: number[], annotations = false) {
  const pdf = await PDFDocument.create();
  for (const width of widths) {
    const page = pdf.addPage([width, 300]);
    if (annotations) {
      page.node.set(
        PDFName.of('AA'),
        pdf.context.obj({ O: { S: PDFName.of('JavaScript'), JS: PDFString.of('app.alert("unsafe")') } }),
      );
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          {
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Link'),
            Rect: [0, 0, 50, 50],
            A: { S: PDFName.of('URI'), URI: PDFString.of('https://example.test') },
          },
        ]),
      );
    }
  }
  return Buffer.from(await pdf.save());
}

test('media actions register 17 strict bounded local operations', () => {
  const registry = new ActionRegistry();
  registerMediaActions(registry);
  assert.equal(registry.list().length, 17);
  for (const action of registry.list()) {
    assert.equal(action.category, 'media');
    assert.equal(action.risk, 'read');
  }
  assert.throws(() =>
    registry
      .get('image.resize')
      .schema.parse({ url: 'https://cdn.discordapp.com/attachments/1/2/image.png' }),
  );
  assert.throws(() =>
    registry.get('pdf.merge').schema.parse({ urls: ['https://cdn.discordapp.com/attachments/1/2/file.pdf'] }),
  );
  assert.throws(() =>
    registry.get('image.card').schema.parse({ title: 'hi', background: 'url(http://evil.test)' }),
  );
  for (const url of [
    'file:///secret.png',
    'http://127.0.0.1/a',
    'https://evil.test/attachments/a',
    'https://cdn.discordapp.com.evil.test/attachments/a',
    'https://cdn.discordapp.com/not-attachments/a',
  ])
    assert.throws(() => registry.get('image.info').schema.parse({ url }));
});
test('real PNG resize preserves ratio and produces a decodable bounded output', async () => {
  const input = await coloredPng();
  const info = await inspectImage(input);
  assert.equal(info.width, 64);
  assert.equal(info.height, 32);
  assert.equal(info.format, 'png');
  const output = await processImage(input, { kind: 'resize', width: 16 });
  const metadata = await sharp(output.attachment).metadata();
  assert.equal(metadata.width, 16);
  assert.equal(metadata.height, 8);
  assert.equal(output.name, 'processed.png');
});
test('real crop selects the requested pixels and rejects coordinates outside the image', async () => {
  const input = await coloredPng();
  const output = await processImage(input, { kind: 'crop', left: 40, top: 2, width: 8, height: 10 });
  const { data, info } = await sharp(output.attachment).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 8);
  assert.equal(info.height, 10);
  assert.deepEqual([...data.subarray(0, 3)], [0, 255, 0]);
  await assert.rejects(
    processImage(input, { kind: 'crop', left: 60, top: 0, width: 8, height: 10 }),
    /outside/,
  );
});
test('rotation and format conversion return valid JPEG, WebP and single-frame GIF files', async () => {
  const input = await coloredPng();
  const rotated = await processImage(input, { kind: 'rotate', degrees: 90 });
  const metadata = await sharp(rotated.attachment).metadata();
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 64);
  for (const format of ['jpeg', 'webp', 'gif'] as const) {
    const output = await processImage(input, { kind: 'format', format, quality: 80 });
    assert.equal((await sharp(output.attachment).metadata()).format, format);
    assert.ok(output.attachment.length < MEDIA_LIMITS.outputBytes);
  }
});
test('grayscale changes colorful source pixels and blur creates real color transitions', async () => {
  const input = await coloredPng();
  const grayscale = await processImage(input, { kind: 'grayscale' });
  const gray = await sharp(grayscale.attachment).toColourspace('srgb').raw().toBuffer();
  assert.equal(gray[0], gray[1]);
  assert.equal(gray[1], gray[2]);
  assert.ok(gray[0]! > 0 && gray[0]! < 255);
  const blurred = await processImage(input, { kind: 'blur', sigma: 2 });
  const transition = await sharp(blurred.attachment)
    .extract({ left: 31, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer();
  assert.ok(transition[0]! > 0 && transition[0]! < 255);
  assert.ok(transition[1]! > 0 && transition[1]! < 255);
});
test('SVG references, PDFs, ZIP archives and truncated image files are rejected as raster inputs', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///secret.env"/></svg>');
  for (const data of [
    svg,
    Buffer.from('%PDF-1.7'),
    Buffer.from('PK\x03\x04zip-data'),
    Buffer.from('plain text'),
  ])
    await assert.rejects(inspectImage(data), /PNG, JPEG, WebP or GIF/);
  await assert.rejects(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0])), /invalid|truncated|limits/);
});
test('oversized buffers are rejected before decoding', async () => {
  const oversized = Buffer.alloc(MEDIA_LIMITS.inputBytes + 1);
  await assert.rejects(inspectImage(oversized), /between 1 byte and 8 MB/);
  await assert.rejects(inspectPdf(oversized), /between 1 byte and 8 MB/);
});
test('compressed image dimension bombs are rejected before raster decoding', async () => {
  const input = Buffer.from(await coloredPng(1, 1));
  input.writeUInt32BE(40000, 16);
  input.writeUInt32BE(40000, 20);
  // Recalculate the IHDR CRC so the parser sees a valid header with malicious dimensions.
  let crc = 0xffffffff;
  for (const byte of input.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  input.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  await assert.rejects(inspectImage(input), /limit|megapixel|invalid/);
});
test('one-dimensional resizing rejects pathological aspect expansion', async () => {
  const thin = await sharp({ create: { width: 1, height: 16384, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
  await assert.rejects(
    processImage(thin, { kind: 'resize', width: 4096, enlarge: true }),
    /megapixel|dimension limit/,
  );
});
test('cards, charts and meme overlays render actual PNGs and escape markup', async () => {
  assert.equal(
    escapeXml('<image href="file:///secret"/> & \'quoted\''),
    '&lt;image href=&quot;file:///secret&quot;/&gt; &amp; &apos;quoted&apos;',
  );
  const card = await createCard({
    title: '<script>alert(1)</script>',
    subtitle: '& escaped text',
    progress: 0.5,
  });
  const cardInfo = await sharp(card.attachment).metadata();
  assert.equal(cardInfo.width, 1024);
  assert.equal(cardInfo.height, 320);
  const chart = await createBarChart({
    title: 'Daily activity',
    values: [
      { label: '<image href="evil"/>', value: 0 },
      { label: 'Tuesday', value: 50 },
    ],
  });
  const chartInfo = await sharp(chart.attachment).metadata();
  assert.equal(chartInfo.width, 1100);
  assert.equal(chartInfo.height, 244);
  const meme = await processImage(await coloredPng(640, 320), {
    kind: 'meme',
    top: 'HELLO',
    bottom: '<image href="file:///secret"/>',
  });
  assert.equal((await sharp(meme.attachment).metadata()).width, 640);
  await assert.rejects(processImage(await coloredPng(), { kind: 'meme', top: 'tiny' }), /at least 320/);
});
test('chart, progress, quality and resize bounds reject nonfinite or excessive values', async () => {
  await assert.rejects(createCard({ title: 'test', progress: 1.01 }));
  await assert.rejects(
    createBarChart({ title: 'bad', values: [{ label: 'bad', value: Number.POSITIVE_INFINITY }] }),
  );
  await assert.rejects(
    createBarChart({
      title: 'bad',
      values: Array.from({ length: 21 }, () => ({ label: 'too many', value: 1 })),
    }),
  );
  await assert.rejects(processImage(await coloredPng(), { kind: 'resize', width: 100000 }));
  await assert.rejects(processImage(await coloredPng(), { kind: 'format', format: 'jpeg', quality: 101 }));
});
test('PDF merge preserves page order and strips interactive annotations and additional actions', async () => {
  const first = await pdfWithWidths([200, 250], true),
    second = await pdfWithWidths([400]);
  const result = await mergePdfs([first, second]);
  const pdf = await PDFDocument.load(result.attachment);
  assert.deepEqual(
    pdf.getPages().map((page) => page.getWidth()),
    [200, 250, 400],
  );
  for (const page of pdf.getPages()) {
    assert.equal(page.node.has(PDFName.of('AA')), false);
    assert.equal(page.node.has(PDFName.of('Annots')), false);
  }
  assert.ok(result.notice?.includes('annotations'));
});
test('PDF split uses 1-based pages, supports reordering and validates duplicates and missing pages', async () => {
  const source = await pdfWithWidths([200, 250, 400]);
  const result = await splitPdf(source, [3, 1]);
  assert.deepEqual(
    (await PDFDocument.load(result.attachment)).getPages().map((page) => page.getWidth()),
    [400, 200],
  );
  await assert.rejects(splitPdf(source, [1, 1]));
  await assert.rejects(splitPdf(source, [0]));
  await assert.rejects(splitPdf(source, [4]), /beyond/);
});
test('PDF page limits apply to each source and to the merged total', async () => {
  await assert.rejects(inspectPdf(await pdfWithWidths(Array(101).fill(100))), /100 pages/);
  await assert.rejects(
    mergePdfs([await pdfWithWidths(Array(60).fill(100)), await pdfWithWidths(Array(60).fill(100))]),
    /100 pages/,
  );
  await assert.rejects(mergePdfs([await pdfWithWidths([100])]), /between two and three/);
});
test('PDF inspection rejects archives, raster images, malformed and encrypted documents', async () => {
  for (const data of [Buffer.from('PK\x03\x04compressed'), await coloredPng(), Buffer.from('not a PDF')])
    await assert.rejects(inspectPdf(data), /valid PDF/);
  await assert.rejects(inspectPdf(Buffer.from('%PDF-1.7\nmalformed')), /invalid, encrypted, or unsupported/);
  const encrypted = Buffer.from(
    '%PDF-1.7\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type /Pages /Count 1 /Kids [3 0 R]>>\nendobj\n3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 100 100]>>\nendobj\n4 0 obj\n<</Filter /Standard /V 1 /R 2 /O (test) /U (test) /P -4>>\nendobj\ntrailer\n<</Root 1 0 R /Encrypt 4 0 R>>\n%%EOF',
  );
  await assert.rejects(inspectPdf(encrypted), /invalid, encrypted, or unsupported/);
});
test('PDF report wraps paragraphs and long words across readable pages with title metadata', async () => {
  const output = await createPdfReport({
    title: 'Operations report',
    text: `${'A long but readable paragraph. '.repeat(1000)}\n${'X'.repeat(4000)}`,
  });
  const pdf = await PDFDocument.load(output.attachment);
  assert.equal(pdf.getTitle(), 'Operations report');
  assert.ok(pdf.getPageCount() > 1);
  assert.ok(pdf.getPageCount() < 100);
  assert.equal(output.notice, undefined);
  assert.equal(output.name, 'report.pdf');
  const info = await inspectPdf(output.attachment);
  assert.equal(info.pages, pdf.getPageCount());
});
test('PDF report explicitly reports unsupported Unicode glyph replacement', async () => {
  const output = await createPdfReport({ title: 'Meeting 🙂', text: 'English text with 中文 and emoji 🚀.' });
  assert.ok(output.notice?.includes('unsupported characters'));
  assert.equal((await PDFDocument.load(output.attachment)).getTitle(), 'Meeting ?');
});
test('real worker jobs return known hashes and retain Buffer output type', async () => {
  const hash = await runMediaJob({ kind: 'hash', data: Buffer.from('abc') });
  assert.deepEqual(hash, {
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    bytes: 3,
  });
  const image = await runMediaJob({
    kind: 'image',
    data: await coloredPng(),
    operation: { kind: 'resize', width: 8 },
  });
  assert.ok('attachment' in image);
  assert.ok(Buffer.isBuffer(image.attachment));
  assert.equal((await sharp(image.attachment).metadata()).width, 8);
});
test('worker failures return bounded user-facing errors and release processor slots', async () => {
  await assert.rejects(
    runMediaJob({ kind: 'image-info', data: Buffer.from('not an image') }),
    /PNG, JPEG, WebP or GIF/,
  );
  const result = await runMediaJob({ kind: 'hash', data: Buffer.from('abc') });
  assert.ok('sha256' in result);
});
test('media concurrency rejects a third job without creating an unbounded waiting queue', async () => {
  const first = runMediaJob({ kind: 'hash', data: Buffer.from('first') });
  const second = runMediaJob({ kind: 'hash', data: Buffer.from('second') });
  const results = await Promise.allSettled([
    first,
    second,
    runMediaJob({ kind: 'hash', data: Buffer.from('third') }),
  ]);
  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.status, 'fulfilled');
  assert.equal(results[2]?.status, 'rejected');
  if (results[2]?.status === 'rejected') assert.match(String(results[2].reason), /processors are busy/);
  const later = await runMediaJob({ kind: 'hash', data: Buffer.from('later') });
  assert.ok('sha256' in later);
});
test('sticker preparation produces a real transparent-canvas 320px PNG under Discord file limit', async () => {
  const file = await prepareSticker(await coloredPng());
  const metadata = await sharp(file.attachment).metadata();
  assert.equal(file.name, 'sticker.png');
  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 320);
  assert.equal(metadata.hasAlpha, true);
  assert.ok(file.attachment.length <= 512 * 1024);
  const pixel = await sharp(file.attachment)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer();
  assert.equal(pixel[3], 0);
});
test('real animation GIF preserves distinct frame colors, dimensions and timing', async () => {
  const red = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ff0000' } })
      .png()
      .toBuffer(),
    blue = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#0000ff' } })
      .png()
      .toBuffer();
  const file = await createAnimation([red, blue], { width: 32, height: 32, delayMs: 200 });
  const metadata = await sharp(file.attachment, { animated: true }).metadata();
  assert.equal(metadata.pages, 2);
  assert.equal(metadata.pageHeight, 32);
  assert.deepEqual(metadata.delay, [200, 200]);
  assert.equal(metadata.loop, 0);
  const { data, info } = await sharp(file.attachment, { animated: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.ok(data[0]! > 200 && data[2]! < 10);
  const second = 32 * 32 * info.channels;
  assert.ok(data[second]! < 10 && data[second + 2]! > 200);
});
test('animation rejects excessive count, combined input, unsafe raster formats and unsupported timing before output', async () => {
  const input = await coloredPng();
  await assert.rejects(createAnimation([input]), /2–12/);
  await assert.rejects(createAnimation(Array(13).fill(input)), /2–12/);
  await assert.rejects(
    createAnimation([Buffer.alloc(4 * 1024 * 1024 + 1), Buffer.alloc(4 * 1024 * 1024)]),
    /8 MB/,
  );
  await assert.rejects(createAnimation([input, Buffer.from('<svg/>')]), /PNG, JPEG/);
  await assert.rejects(createAnimation([input, input], { delayMs: 21 }));
});
test('animation and sticker jobs run through real bounded workers with Buffer results', async () => {
  const input = await coloredPng();
  const animated = await runMediaJob({
    kind: 'animation',
    frames: [input, input],
    input: { width: 32, height: 32 },
  });
  assert.ok('attachment' in animated);
  if ('attachment' in animated) {
    assert.ok(Buffer.isBuffer(animated.attachment));
    assert.equal((await sharp(animated.attachment, { animated: true }).metadata()).pages, 2);
  }
  const sticker = await runMediaJob({ kind: 'sticker', data: input });
  assert.ok('attachment' in sticker);
  if ('attachment' in sticker) assert.equal((await sharp(sticker.attachment).metadata()).width, 320);
});
