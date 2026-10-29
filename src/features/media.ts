import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { PDFDocument as PdfDocument, PDFFont } from 'pdf-lib';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import { discordAttachmentUrl, downloadAttachment } from '../core/files.js';
import { UserError } from '../core/errors.js';
import { heavyWork } from '../core/work-budget.js';

export const MEDIA_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  pixels: 40_000_000,
  imageDimension: 16384,
  pdfPages: 100,
  workers: 2,
  timeoutMs: 20_000,
});
export interface MediaFile {
  attachment: Buffer;
  name: string;
  notice?: string;
}
const dimension = z.number().int().min(1).max(4096);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const format = z.enum(['png', 'jpeg', 'webp', 'gif']);
const resizeOptions = z
  .strictObject({
    kind: z.literal('resize'),
    width: dimension.optional(),
    height: dimension.optional(),
    fit: z.enum(['inside', 'contain', 'cover', 'fill']).default('inside'),
    enlarge: z.boolean().default(false),
  })
  .refine((v) => v.width !== undefined || v.height !== undefined, 'Provide a width or height');
const cropOptions = z.strictObject({
  kind: z.literal('crop'),
  left: z.number().int().min(0).max(16383),
  top: z.number().int().min(0).max(16383),
  width: dimension,
  height: dimension,
});
const rotateOptions = z.strictObject({
  kind: z.literal('rotate'),
  degrees: z.number().min(-360).max(360),
  background: color.default('#000000'),
});
const formatOptions = z.strictObject({
  kind: z.literal('format'),
  format: format.default('png'),
  quality: z.number().int().min(1).max(100).default(85),
});
const blurOptions = z.strictObject({
  kind: z.literal('blur'),
  sigma: z.number().min(0.3).max(20).default(2),
});
const grayscaleOptions = z.strictObject({ kind: z.literal('grayscale') });
export const imageFilterStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('modulate'),
    brightness: z.number().min(0.2).max(2).default(1),
    saturation: z.number().min(0).max(2).default(1),
    hue: z.number().min(-180).max(180).default(0),
  }),
  z.strictObject({ kind: z.literal('negate') }),
  z.strictObject({ kind: z.literal('normalize') }),
  z.strictObject({ kind: z.literal('gamma'), value: z.number().min(1).max(3) }),
  z.strictObject({ kind: z.literal('sharpen'), sigma: z.number().min(0.3).max(3).default(1) }),
  z.strictObject({ kind: z.literal('threshold'), value: z.number().int().min(0).max(255).default(128) }),
  z.strictObject({ kind: z.literal('tint'), color }),
]);
const filterOptions = z.strictObject({
  kind: z.literal('filters'),
  steps: z.array(imageFilterStepSchema).min(1).max(8),
});
const transparentOptions = z.strictObject({
  kind: z.literal('background-remove'),
  color: color.optional(),
  tolerance: z.number().int().min(0).max(255).default(30),
  feather: z.number().int().min(0).max(80).default(10),
});
const memeOptions = z
  .strictObject({
    kind: z.literal('meme'),
    top: z.string().max(100).default(''),
    bottom: z.string().max(100).default(''),
  })
  .refine((v) => !!v.top || !!v.bottom, 'Provide top or bottom text');
export const imageOperationSchema = z.union([
  resizeOptions,
  cropOptions,
  rotateOptions,
  formatOptions,
  blurOptions,
  grayscaleOptions,
  memeOptions,
  filterOptions,
  transparentOptions,
]);
export type ImageOperation = z.input<typeof imageOperationSchema>;
const cardSchema = z.strictObject({
  title: z.string().min(1).max(60),
  subtitle: z.string().max(100).default(''),
  detail: z.string().max(100).default(''),
  progress: z.number().min(0).max(1).optional(),
  background: color.default('#111827'),
  accent: color.default('#6366f1'),
});
const chartSchema = z.strictObject({
  title: z.string().min(1).max(100),
  values: z
    .array(z.strictObject({ label: z.string().min(1).max(30), value: z.number().min(0).max(1_000_000_000) }))
    .min(1)
    .max(20),
  color: color.default('#6366f1'),
  style: z.enum(['bar', 'line', 'area', 'pie', 'scatter']).default('bar'),
});
const reportSchema = z.strictObject({
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(40_000),
});
type CardInput = z.input<typeof cardSchema>;
type ChartInput = z.input<typeof chartSchema>;
type ReportInput = z.input<typeof reportSchema>;
const animationSchema = z.strictObject({
  width: z.number().int().min(16).max(512).default(320),
  height: z.number().int().min(16).max(512).default(320),
  delayMs: z
    .number()
    .int()
    .min(20)
    .max(2000)
    .refine((value) => value % 10 === 0, 'Use a delay in multiples of ten milliseconds')
    .default(100),
  loop: z.number().int().min(0).max(100).default(0),
});
export type AnimationInput = z.input<typeof animationSchema>;
type MediaJob =
  | { kind: 'image'; data: Uint8Array; operation: ImageOperation }
  | { kind: 'image-info'; data: Uint8Array }
  | { kind: 'card'; input: CardInput }
  | { kind: 'chart'; input: ChartInput }
  | { kind: 'sticker'; data: Uint8Array }
  | { kind: 'animation'; frames: Uint8Array[]; input: AnimationInput }
  | { kind: 'pdf-info'; data: Uint8Array }
  | { kind: 'pdf-merge'; data: Uint8Array[] }
  | { kind: 'pdf-split'; data: Uint8Array; pages: number[] }
  | { kind: 'pdf-report'; input: ReportInput }
  | { kind: 'image-hash'; data: Uint8Array }
  | { kind: 'hash'; data: Uint8Array };
type ImageInfo = {
  format: string;
  width: number;
  height: number;
  pages: number;
  bytes: number;
  hasAlpha: boolean;
  notice?: string;
};
type PdfInfo = { pages: number; title: string | null; bytes: number };
type MediaResult =
  MediaFile | ImageInfo | PdfInfo | { sha256: string; bytes: number; perceptualHash?: string };

function inputBuffer(data: Uint8Array): Buffer {
  if (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > MEDIA_LIMITS.inputBytes)
    throw new UserError('Input files must be between 1 byte and 8 MB.');
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
function outputFile(data: Uint8Array, name: string, notice?: string): MediaFile {
  if (data.byteLength > MEDIA_LIMITS.outputBytes)
    throw new UserError('The result exceeds 8 MB. Reduce its size or quality.');
  return { attachment: Buffer.from(data), name, ...(notice ? { notice } : {}) };
}
function assertRasterSignature(data: Buffer): void {
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const gif = ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'));
  const webp =
    data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !gif && !webp)
    throw new UserError(
      'Use a PNG, JPEG, WebP or GIF image. SVG, PDF and other formats are not accepted as image inputs.',
    );
}
function assertDimensions(width: number, height: number, pages = 1): void {
  if (
    !Number.isFinite(width * height * pages) ||
    width < 1 ||
    height < 1 ||
    width > MEDIA_LIMITS.imageDimension ||
    height > MEDIA_LIMITS.imageDimension ||
    width * height * pages > MEDIA_LIMITS.pixels
  )
    throw new UserError('Image exceeds the 40 megapixel or 16,384 pixel dimension limit.');
}

async function raster(data: Uint8Array) {
  const buffer = inputBuffer(data);
  assertRasterSignature(buffer);
  const sharp = await boundedSharp();
  const image = sharp(buffer, { failOn: 'error', limitInputPixels: MEDIA_LIMITS.pixels, animated: false });
  let metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw new UserError('Image is invalid, truncated, or exceeds the image limits.');
  }
  const width = metadata.width ?? 0,
    height = metadata.height ?? 0,
    pages = metadata.pages ?? 1;
  assertDimensions(width, height, pages);
  const rotated =
    metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  return {
    image: image.autoOrient(),
    width: rotated ? height : width,
    height: rotated ? width : height,
    info: {
      format: metadata.format ?? 'unknown',
      width,
      height,
      pages,
      bytes: buffer.length,
      hasAlpha: metadata.hasAlpha ?? false,
      ...(pages > 1 ? { notice: 'Image transforms process the first animation frame only.' } : {}),
    } satisfies ImageInfo,
  };
}
let sharpConfigured = false;
async function boundedSharp() {
  const { default: sharp } = await import('sharp');
  if (!sharpConfigured && !isMainThread) {
    sharp.concurrency(1);
    sharp.cache({ memory: 32, files: 0, items: 100 });
    sharpConfigured = true;
  }
  return sharp;
}
export async function prepareSticker(data: Uint8Array): Promise<MediaFile> {
  const source = await raster(data);
  const png = await source.image
    .resize(320, 320, { fit: 'contain', background: '#00000000' })
    .ensureAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  if (png.length > 512 * 1024) throw new UserError('Sticker PNG exceeds the 512 KiB limit.');
  return outputFile(
    png,
    'sticker.png',
    '320×320 transparent-canvas PNG prepared. Existing alpha is preserved; image backgrounds are not automatically removed. Animated inputs use their first frame.',
  );
}
export async function createAnimation(
  frames: readonly Uint8Array[],
  raw: AnimationInput = {},
): Promise<MediaFile> {
  const input = animationSchema.parse(raw);
  if (
    frames.length < 2 ||
    frames.length > 12 ||
    frames.reduce((sum, frame) => sum + frame.length, 0) > MEDIA_LIMITS.inputBytes
  )
    throw new UserError('Use 2–12 raster frames totaling at most 8 MB.');
  const pixels: Buffer[] = [];
  let total = 0;
  for (const frame of frames) {
    const source = await raster(frame);
    total += source.width * source.height;
    if (total > MEDIA_LIMITS.pixels)
      throw new UserError('Animation source frames exceed 40 megapixels in total.');
    pixels.push(
      await source.image
        .resize(input.width, input.height, { fit: 'contain', background: '#00000000' })
        .ensureAlpha()
        .raw()
        .toBuffer(),
    );
  }
  const sharp = await boundedSharp();
  const result = await sharp(Buffer.concat(pixels), {
    raw: { width: input.width, height: input.height * frames.length, channels: 4, pageHeight: input.height },
  })
    .gif({
      loop: input.loop,
      delay: frames.map(() => input.delayMs),
      colours: 128,
      effort: 2,
      keepDuplicateFrames: true,
    })
    .toBuffer();
  return outputFile(
    result,
    'animation.gif',
    'Frames are resized on a transparent canvas; animated input files contribute their first frame only.',
  );
}

export async function inspectImage(data: Uint8Array): Promise<ImageInfo> {
  return (await raster(data)).info;
}
export async function processImage(data: Uint8Array, rawOptions: ImageOperation): Promise<MediaFile> {
  const options = imageOperationSchema.parse(rawOptions);
  const source = await raster(data);
  let image = source.image;
  if (options.kind === 'filters') {
    for (const step of options.steps) {
      if (step.kind === 'modulate')
        image = image.modulate({ brightness: step.brightness, saturation: step.saturation, hue: step.hue });
      else if (step.kind === 'negate') image = image.negate({ alpha: false });
      else if (step.kind === 'normalize') image = image.normalize();
      else if (step.kind === 'gamma') image = image.gamma(step.value);
      else if (step.kind === 'sharpen') image = image.sharpen({ sigma: step.sigma });
      else if (step.kind === 'threshold') image = image.threshold(step.value);
      else image = image.tint(step.color);
      // Materialize each step so repeated Sharp operations remain an actual ordered stack.
      const intermediate = await image.png().toBuffer();
      if (intermediate.length > MEDIA_LIMITS.outputBytes)
        throw new UserError('Intermediate image exceeds 8 MiB.');
      image = (await raster(intermediate)).image;
    }
  } else if (options.kind === 'background-remove') {
    const pixels = source.width * source.height;
    if (pixels > 8_000_000)
      throw new UserError('Local background removal is limited to 8 megapixels; resize first.');
    const raw = await image.ensureAlpha().raw().toBuffer(),
      key = options.color
        ? [1, 3, 5].map((offset) => parseInt(options.color!.slice(offset, offset + 2), 16))
        : [raw[0]!, raw[1]!, raw[2]!];
    const visited = new Uint8Array(pixels),
      queue = new Uint32Array(pixels);
    let tail = 0;
    const visit = (index: number) => {
      if (visited[index]) return;
      visited[index] = 1;
      const offset = index * 4,
        distance = Math.max(
          Math.abs(raw[offset]! - key[0]!),
          Math.abs(raw[offset + 1]! - key[1]!),
          Math.abs(raw[offset + 2]! - key[2]!),
        );
      if (distance > options.tolerance + options.feather) return;
      const alpha =
        distance <= options.tolerance
          ? 0
          : Math.round((255 * (distance - options.tolerance)) / Math.max(1, options.feather));
      raw[offset + 3] = Math.min(raw[offset + 3]!, alpha);
      queue[tail++] = index;
    };
    for (let x = 0; x < source.width; x++) {
      visit(x);
      visit((source.height - 1) * source.width + x);
    }
    for (let y = 0; y < source.height; y++) {
      visit(y * source.width);
      visit(y * source.width + source.width - 1);
    }
    for (let head = 0; head < tail; head++) {
      const index = queue[head]!,
        x = index % source.width,
        y = Math.floor(index / source.width);
      if (x) visit(index - 1);
      if (x + 1 < source.width) visit(index + 1);
      if (y) visit(index - source.width);
      if (y + 1 < source.height) visit(index + source.width);
    }
    const sharp = await boundedSharp();
    return outputFile(
      await sharp(raw, { raw: { width: source.width, height: source.height, channels: 4 } })
        .png()
        .toBuffer(),
      'transparent.png',
      'Removes edge-connected pixels matching the selected or top-left background color; use AI removal for complex photographic backgrounds.',
    );
  } else if (options.kind === 'resize') {
    // A one-dimensional resize can otherwise expand a very thin image to enormous height/width.
    if (!options.width)
      assertDimensions(Math.ceil((source.width * options.height!) / source.height), options.height!);
    if (!options.height)
      assertDimensions(options.width!, Math.ceil((source.height * options.width!) / source.width));
    image = image.resize(options.width, options.height, {
      fit: options.fit,
      withoutEnlargement: !options.enlarge,
      background: '#00000000',
    });
  } else if (options.kind === 'crop') {
    if (options.left + options.width > source.width || options.top + options.height > source.height)
      throw new UserError('Crop rectangle extends outside the image.');
    image = image.extract({
      left: options.left,
      top: options.top,
      width: options.width,
      height: options.height,
    });
  } else if (options.kind === 'rotate') {
    const radians = (options.degrees * Math.PI) / 180;
    assertDimensions(
      Math.ceil(Math.abs(source.width * Math.cos(radians)) + Math.abs(source.height * Math.sin(radians))),
      Math.ceil(Math.abs(source.width * Math.sin(radians)) + Math.abs(source.height * Math.cos(radians))),
    );
    image = image.rotate(options.degrees, { background: options.background });
  } else if (options.kind === 'blur') image = image.blur(options.sigma);
  else if (options.kind === 'grayscale') image = image.grayscale();
  else if (options.kind === 'meme') {
    if (source.width < 320 || source.height < 120)
      throw new UserError(
        'Use an image at least 320 pixels wide and 120 pixels tall for readable meme text.',
      );
    const width = Math.min(source.width, 1280),
      height = Math.max(1, Math.round((source.height * width) / source.width));
    if (height > 4096) throw new UserError('Meme images must have an aspect ratio no taller than 3.2:1.');
    image = image.resize(width, height, { fit: 'fill', withoutEnlargement: true });
    const font = Math.max(
      4,
      Math.min(
        64,
        Math.floor((width - 24) / (Math.max(16, options.top.length, options.bottom.length) * 0.65)),
      ),
    );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="sans-serif" font-size="${font}" font-weight="bold" text-anchor="middle" fill="white" stroke="black" stroke-width="${Math.max(1, font / 18)}" paint-order="stroke"><text x="${width / 2}" y="${font + 8}">${escapeXml(options.top)}</text><text x="${width / 2}" y="${Math.max(font, height - 16)}">${escapeXml(options.bottom)}</text></g></svg>`;
    image = image.composite([{ input: Buffer.from(svg) }]);
  }
  const selectedFormat = options.kind === 'format' ? options.format : 'png';
  const result = await image
    .toFormat(selectedFormat, options.kind === 'format' ? { quality: options.quality } : {})
    .toBuffer();
  return outputFile(
    result,
    `processed.${selectedFormat === 'jpeg' ? 'jpg' : selectedFormat}`,
    source.info.notice,
  );
}

export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
export async function createCard(rawInput: CardInput): Promise<MediaFile> {
  const input = cardSchema.parse(rawInput);
  const titleSize = Math.min(42, Math.floor(896 / (Math.max(1, input.title.length) * 0.65)));
  const subtitleSize = Math.min(24, Math.floor(896 / (Math.max(1, input.subtitle.length) * 0.65)));
  const detailSize = Math.min(19, Math.floor(896 / (Math.max(1, input.detail.length) * 0.65)));
  const progress =
    input.progress === undefined
      ? ''
      : `<rect x="64" y="244" width="896" height="14" rx="7" fill="#374151"/><rect x="64" y="244" width="${Math.round(896 * input.progress)}" height="14" rx="7" fill="${input.accent}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="320"><rect width="1024" height="320" rx="24" fill="${input.background}"/><rect x="0" y="0" width="12" height="320" fill="${input.accent}"/><g font-family="sans-serif" fill="white"><text x="64" y="102" font-size="${titleSize}" font-weight="bold">${escapeXml(input.title)}</text><text x="64" y="158" font-size="${subtitleSize}">${escapeXml(input.subtitle)}</text><text x="64" y="207" font-size="${detailSize}" fill="#cbd5e1">${escapeXml(input.detail)}</text></g>${progress}</svg>`;
  const sharp = await boundedSharp();
  return outputFile(
    await sharp(Buffer.from(svg), { limitInputPixels: MEDIA_LIMITS.pixels }).png().toBuffer(),
    'card.png',
  );
}
export async function createBarChart(rawInput: ChartInput): Promise<MediaFile> {
  const input = chartSchema.parse(rawInput);
  if (input.style !== 'bar') {
    const width = 1100,
      height = 650,
      maximum = Math.max(1, ...input.values.map((row) => row.value));
    const points = input.values.map((row, index) => ({
      x: 100 + (index * 850) / Math.max(1, input.values.length - 1),
      y: 530 - (row.value / maximum) * 400,
      label: row.label,
      value: row.value,
    }));
    let drawing = '';
    if (input.style === 'pie') {
      const total = input.values.reduce((sum, row) => sum + row.value, 0);
      if (!total) throw new UserError('A pie chart requires a positive total.');
      let angle = -Math.PI / 2;
      drawing = input.values
        .map((row, index) => {
          const next = angle + (2 * Math.PI * row.value) / total,
            palette = `hsl(${Math.round((index * 360) / input.values.length)} 65% 55%)`;
          const path =
            row.value === total
              ? `<circle cx="390" cy="330" r="220" fill="${palette}"/>`
              : `<path d="M390 330 L${390 + 220 * Math.cos(angle)} ${330 + 220 * Math.sin(angle)} A220 220 0 ${next - angle > Math.PI ? 1 : 0} 1 ${390 + 220 * Math.cos(next)} ${330 + 220 * Math.sin(next)} Z" fill="${palette}"/>`;
          angle = next;
          return (
            path +
            `<text x="680" y="${110 + index * 24}" font-size="17">${escapeXml(row.label)}: ${row.value}</text>`
          );
        })
        .join('');
    } else {
      const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
      drawing =
        `<path d="M100 100 V530 H1000" stroke="#94a3b8" fill="none"/>` +
        (input.style === 'area'
          ? `<path d="${path} L${points.at(-1)!.x} 530 L100 530 Z" fill="${input.color}" opacity="0.25"/>`
          : '') +
        (input.style === 'scatter'
          ? ''
          : `<path d="${path}" fill="none" stroke="${input.color}" stroke-width="4"/>`) +
        points
          .map(
            (point) =>
              `<circle cx="${point.x}" cy="${point.y}" r="6" fill="${input.color}"/><text x="${point.x}" y="${point.y - 14}" text-anchor="middle" font-size="14">${point.value}</text><text x="${point.x}" y="565" text-anchor="middle" font-size="12">${escapeXml(point.label.slice(0, 12))}</text>`,
          )
          .join('');
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#111827"/><g fill="#f8fafc" font-family="sans-serif"><text x="40" y="52" font-size="28">${escapeXml(input.title)}</text>${drawing}</g></svg>`;
    const sharp = await boundedSharp();
    return outputFile(await sharp(Buffer.from(svg)).png().toBuffer(), 'chart.png');
  }
  const width = 1100,
    height = 160 + input.values.length * 42;
  const maximum = Math.max(1, ...input.values.map((entry) => entry.value));
  const bars = input.values
    .map((entry, index) => {
      const y = 100 + index * 42;
      return `<text x="28" y="${y + 21}" font-size="16">${escapeXml(entry.label)}</text><rect x="310" y="${y}" width="${Math.round((620 * entry.value) / maximum)}" height="28" rx="4" fill="${input.color}"/><text x="${946}" y="${y + 21}" font-size="15">${entry.value}</text>`;
    })
    .join('');
  const titleSize = Math.min(27, Math.floor(1044 / (input.title.length * 0.65)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#111827"/><g fill="#f8fafc" font-family="sans-serif"><text x="28" y="52" font-size="${titleSize}" font-weight="bold">${escapeXml(input.title)}</text>${bars}</g></svg>`;
  const sharp = await boundedSharp();
  return outputFile(
    await sharp(Buffer.from(svg), { limitInputPixels: MEDIA_LIMITS.pixels }).png().toBuffer(),
    'chart.png',
  );
}

async function loadPdf(data: Uint8Array): Promise<PdfDocument> {
  const buffer = inputBuffer(data);
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-')
    throw new UserError('A valid PDF attachment is required.');
  const { PDFDocument } = await import('pdf-lib');
  try {
    const document = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    if (
      document.getPageCount() < 1 ||
      document.getPageCount() > MEDIA_LIMITS.pdfPages ||
      document.context.enumerateIndirectObjects().length > 10_000
    )
      throw new UserError('PDFs are limited to 100 pages and 10,000 objects.');
    return document;
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('PDF is invalid, encrypted, or unsupported.');
  }
}
export async function inspectPdf(data: Uint8Array): Promise<PdfInfo> {
  const document = await loadPdf(data);
  return { pages: document.getPageCount(), title: document.getTitle() ?? null, bytes: data.byteLength };
}
async function appendPdfPages(target: PdfDocument, source: PdfDocument, indices: number[]): Promise<void> {
  const { PDFName } = await import('pdf-lib');
  const copied = await target.copyPages(source, indices);
  for (const page of copied) {
    page.node.delete(PDFName.of('Annots'));
    page.node.delete(PDFName.of('AA'));
    target.addPage(page);
  }
}
export async function mergePdfs(data: readonly Uint8Array[]): Promise<MediaFile> {
  if (data.length < 2 || data.length > 3) throw new UserError('Merge between two and three PDFs.');
  const { PDFDocument } = await import('pdf-lib');
  const target = await PDFDocument.create();
  for (const input of data) {
    const source = await loadPdf(input);
    if (target.getPageCount() + source.getPageCount() > MEDIA_LIMITS.pdfPages)
      throw new UserError('The merged document may not exceed 100 pages.');
    await appendPdfPages(target, source, source.getPageIndices());
  }
  return outputFile(
    await target.save(),
    'merged.pdf',
    'Page contents copied into a new PDF. Interactive annotations and page actions are removed.',
  );
}
export async function splitPdf(data: Uint8Array, rawPages: number[]): Promise<MediaFile> {
  const pages = z
    .array(z.number().int().min(1).max(100))
    .min(1)
    .max(100)
    .refine((values) => new Set(values).size === values.length, 'Duplicate page numbers are not allowed')
    .parse(rawPages);
  const source = await loadPdf(data);
  if (pages.some((page) => page > source.getPageCount()))
    throw new UserError('Page selection extends beyond the source PDF.');
  const { PDFDocument } = await import('pdf-lib');
  const target = await PDFDocument.create();
  await appendPdfPages(
    target,
    source,
    pages.map((page) => page - 1),
  );
  return outputFile(
    await target.save(),
    'selected-pages.pdf',
    'Selected pages use 1-based page numbers. Interactive annotations and page actions are removed.',
  );
}
function wrapText(text: string, font: PDFFont, size: number, maximumWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (line && font.widthOfTextAtSize(`${line} ${word}`, size) <= maximumWidth) line += ` ${word}`;
      else {
        if (line) lines.push(line);
        line = '';
        for (const char of word) {
          if (font.widthOfTextAtSize(line + char, size) > maximumWidth && line) {
            lines.push(line);
            line = '';
          }
          line += char;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}
export async function createPdfReport(rawInput: ReportInput): Promise<MediaFile> {
  const input = reportSchema.parse(rawInput);
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica),
    bold = await document.embedFont(StandardFonts.HelveticaBold);
  const characters = new Set(font.getCharacterSet());
  let changed = false;
  const supported = (text: string) =>
    [...text]
      .map((char) => {
        if (char === '\n' || char === '\r' || char === '\t') return char === '\t' ? '    ' : char;
        if (characters.has(char.codePointAt(0)!)) return char;
        changed = true;
        return '?';
      })
      .join('');
  const title = supported(input.title),
    text = supported(input.text);
  document.setTitle(title);
  document.setProducer('Discord Unified Bot');
  let page = document.addPage([595.28, 841.89]),
    y = 790;
  for (const line of wrapText(title, bold, 20, 491)) {
    page.drawText(line, { x: 52, y, size: 20, font: bold, color: rgb(0.12, 0.15, 0.24) });
    y -= 27;
  }
  y -= 20;
  for (const line of wrapText(text, font, 11, 491)) {
    if (y < 56) {
      if (document.getPageCount() >= MEDIA_LIMITS.pdfPages) throw new UserError('Report exceeds 100 pages.');
      page = document.addPage([595.28, 841.89]);
      y = 790;
    }
    if (line) page.drawText(line, { x: 52, y, size: 11, font, color: rgb(0.15, 0.18, 0.23) });
    y -= 16;
  }
  const pages = document.getPages();
  for (let i = 0; i < pages.length; i++)
    pages[i]!.drawText(`${i + 1} / ${pages.length}`, {
      x: 52,
      y: 28,
      size: 9,
      font,
      color: rgb(0.45, 0.48, 0.52),
    });
  return outputFile(
    await document.save(),
    'report.pdf',
    changed
      ? 'This PDF uses standard Latin fonts; unsupported characters were replaced with ?. Use a text export to preserve all Unicode characters.'
      : undefined,
  );
}

async function executeMediaJob(job: MediaJob): Promise<MediaResult> {
  switch (job.kind) {
    case 'image':
      return processImage(job.data, job.operation);
    case 'image-info':
      return inspectImage(job.data);
    case 'card':
      return createCard(job.input);
    case 'chart':
      return createBarChart(job.input);
    case 'sticker':
      return prepareSticker(job.data);
    case 'animation':
      return createAnimation(job.frames, job.input);
    case 'pdf-info':
      return inspectPdf(job.data);
    case 'pdf-merge':
      return mergePdfs(job.data);
    case 'pdf-split':
      return splitPdf(job.data, job.pages);
    case 'pdf-report':
      return createPdfReport(job.input);
    case 'hash': {
      const data = inputBuffer(job.data);
      return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
    }
    case 'image-hash': {
      const source = await raster(job.data),
        values = await source.image.resize(9, 8, { fit: 'fill' }).grayscale().removeAlpha().raw().toBuffer();
      let bits = 0n;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          bits = (bits << 1n) | (values[y * 9 + x]! > values[y * 9 + x + 1]! ? 1n : 0n);
      return {
        sha256: createHash('sha256').update(inputBuffer(job.data)).digest('hex'),
        perceptualHash: bits.toString(16).padStart(16, '0'),
        bytes: job.data.byteLength,
      };
    }
  }
}
let activeWorkers = 0;
export async function runMediaJob(job: MediaJob): Promise<MediaResult> {
  if (activeWorkers >= MEDIA_LIMITS.workers)
    throw new UserError('The media processors are busy. Try again shortly.');
  const release = heavyWork.enter();
  activeWorkers++;
  try {
    return await new Promise<MediaResult>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { kind: 'media-job', job },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
      let settled = false,
        received = false;
      let failure: Error | undefined, result: MediaResult | undefined;
      const finish = (error?: Error, value?: MediaResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(() => {
        failure = new UserError('Media processing exceeded its time limit.');
        void worker.terminate();
      }, MEDIA_LIMITS.timeoutMs);
      worker.once('message', (message: { ok: boolean; result?: MediaResult; error?: string }) => {
        received = true;
        if (!message.ok || !message.result)
          failure = new UserError(message.error ?? 'Media processing failed.');
        else {
          result = message.result;
          if ('attachment' in result) result.attachment = Buffer.from(result.attachment);
        }
        // Release the worker slot only after its thread has exited and freed its heap.
        void worker.terminate();
      });
      worker.once('error', () => {
        failure = new UserError('Media processing failed or exceeded its resource limits.');
      });
      worker.once('exit', (code) =>
        finish(
          failure ??
            (!received
              ? new UserError(`Media processor exited before returning a result (${code}).`)
              : undefined),
          result,
        ),
      );
    });
  } finally {
    activeWorkers--;
    release();
  }
}
if (!isMainThread && workerData?.kind === 'media-job') {
  void executeMediaJob(workerData.job as MediaJob)
    .then((result) => parentPort?.postMessage({ ok: true, result }))
    .catch((error: unknown) =>
      parentPort?.postMessage({
        ok: false,
        error:
          error instanceof UserError
            ? error.message
            : error instanceof z.ZodError
              ? 'Invalid media processing options.'
              : 'Invalid or unsupported media file.',
      }),
    )
    .finally(() => parentPort?.close());
}

const url = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      discordAttachmentUrl(value);
      return true;
    } catch {
      return false;
    }
  }, 'Provide an HTTPS Discord attachment URL');
const fileActions = { category: 'media', userPermissions: [], botPermissions: [], risk: 'read' as const };
export function registerMediaActions(registry: ActionRegistry): void {
  const download = (value: string) => downloadAttachment(value, MEDIA_LIMITS.inputBytes);
  registry.register({
    id: 'image.sticker',
    description:
      'Prepare a 320×320 transparent-canvas sticker PNG, at most 512 KiB; animated sources use the first frame.',
    schema: z.strictObject({ url }),
    ...fileActions,
    execute: async (_ctx, input) => runMediaJob({ kind: 'sticker', data: await download(input.url) }),
  });
  registry.register({
    id: 'image.animate',
    description:
      'Create an animated GIF from 2–12 explicit Discord raster attachment frames totaling at most 8 MB.',
    schema: z.strictObject({ urls: z.array(url).min(2).max(12), ...animationSchema.shape }),
    ...fileActions,
    execute: async (_ctx, { urls, ...input }) => {
      const frames: Buffer[] = [];
      let bytes = 0;
      for (const source of urls) {
        const frame = await download(source);
        bytes += frame.length;
        if (bytes > MEDIA_LIMITS.inputBytes)
          throw new UserError('Animation frames exceed the combined 8 MB input limit.');
        frames.push(frame);
      }
      return runMediaJob({ kind: 'animation', frames, input });
    },
  });
  registry.register({
    id: 'image.info',
    description: 'Inspect a bounded PNG, JPEG, WebP or GIF attachment without changing it.',
    schema: z.strictObject({ url }),
    ...fileActions,
    execute: async (_ctx, input) => runMediaJob({ kind: 'image-info', data: await download(input.url) }),
  });
  registry.register({
    id: 'image.resize',
    description: 'Resize a raster attachment to explicit dimensions; animated inputs use their first frame.',
    schema: z
      .strictObject({
        url,
        width: dimension.optional(),
        height: dimension.optional(),
        fit: z.enum(['inside', 'contain', 'cover', 'fill']).default('inside'),
        enlarge: z.boolean().default(false),
      })
      .refine((v) => v.width !== undefined || v.height !== undefined, 'Provide a width or height'),
    ...fileActions,
    execute: async (_ctx, { url, ...options }) =>
      runMediaJob({ kind: 'image', data: await download(url), operation: { kind: 'resize', ...options } }),
  });
  registry.register({
    id: 'image.crop',
    description: 'Extract an exact pixel rectangle from a raster attachment.',
    schema: z.strictObject({
      url,
      left: z.number().int().min(0).max(16383),
      top: z.number().int().min(0).max(16383),
      width: dimension,
      height: dimension,
    }),
    ...fileActions,
    execute: async (_ctx, { url, ...options }) =>
      runMediaJob({ kind: 'image', data: await download(url), operation: { kind: 'crop', ...options } }),
  });
  registry.register({
    id: 'image.rotate',
    description: 'Rotate a raster attachment by a finite angle with a chosen background.',
    schema: z.strictObject({
      url,
      degrees: z.number().min(-360).max(360),
      background: color.default('#000000'),
    }),
    ...fileActions,
    execute: async (_ctx, { url, ...options }) =>
      runMediaJob({ kind: 'image', data: await download(url), operation: { kind: 'rotate', ...options } }),
  });
  registry.register({
    id: 'image.format',
    description: 'Convert/compress a raster attachment to PNG, JPEG, WebP or a single-frame GIF.',
    schema: z.strictObject({ url, format, quality: z.number().int().min(1).max(100).default(85) }),
    ...fileActions,
    execute: async (_ctx, { url, ...options }) =>
      runMediaJob({ kind: 'image', data: await download(url), operation: { kind: 'format', ...options } }),
  });
  registry.register({
    id: 'image.blur',
    description: 'Apply a bounded Gaussian blur to a raster attachment.',
    schema: z.strictObject({ url, sigma: z.number().min(0.3).max(20).default(2) }),
    ...fileActions,
    execute: async (_ctx, { url, ...options }) =>
      runMediaJob({ kind: 'image', data: await download(url), operation: { kind: 'blur', ...options } }),
  });
  registry.register({
    id: 'image.grayscale',
    description: 'Create a grayscale PNG from a raster attachment.',
    schema: z.strictObject({ url }),
    ...fileActions,
    execute: async (_ctx, input) =>
      runMediaJob({ kind: 'image', data: await download(input.url), operation: { kind: 'grayscale' } }),
  });
  registry.register({
    id: 'image.meme',
    description: 'Overlay escaped top and bottom text on the first frame of a raster attachment.',
    schema: z
      .strictObject({ url, top: z.string().max(100).default(''), bottom: z.string().max(100).default('') })
      .refine((v) => !!v.top || !!v.bottom, 'Provide top or bottom text'),
    ...fileActions,
    execute: async (_ctx, { url, ...options }) =>
      runMediaJob({ kind: 'image', data: await download(url), operation: { kind: 'meme', ...options } }),
  });
  registry.register({
    id: 'image.card',
    description: 'Generate a welcome, rank, announcement or progress card as a PNG.',
    schema: cardSchema,
    ...fileActions,
    execute: async (_ctx, input) => runMediaJob({ kind: 'card', input }),
  });
  registry.register({
    id: 'chart.bar',
    description: 'Generate a horizontal bar chart PNG from up to 20 labeled numeric values.',
    schema: chartSchema,
    ...fileActions,
    execute: async (_ctx, input) => runMediaJob({ kind: 'chart', input }),
  });
  registry.register({
    id: 'pdf.info',
    description: 'Inspect an unencrypted PDF attachment with at most 100 pages.',
    schema: z.strictObject({ url }),
    ...fileActions,
    execute: async (_ctx, input) => runMediaJob({ kind: 'pdf-info', data: await download(input.url) }),
  });
  registry.register({
    id: 'pdf.merge',
    description: 'Merge two or three PDF attachments into one document, up to 100 total pages.',
    schema: z.strictObject({ urls: z.array(url).min(2).max(3) }),
    ...fileActions,
    execute: async (_ctx, input) => {
      const data = [];
      for (const url of input.urls) data.push(await download(url));
      return runMediaJob({ kind: 'pdf-merge', data });
    },
  });
  registry.register({
    id: 'pdf.split',
    description: 'Extract or reorder a unique 1-based page selection into a new PDF.',
    schema: z.strictObject({
      url,
      pages: z
        .array(z.number().int().min(1).max(100))
        .min(1)
        .max(100)
        .refine((values) => new Set(values).size === values.length, 'Duplicate page numbers are not allowed'),
    }),
    ...fileActions,
    execute: async (_ctx, input) =>
      runMediaJob({ kind: 'pdf-split', data: await download(input.url), pages: input.pages }),
  });
  registry.register({
    id: 'pdf.report',
    description: 'Generate a paginated plain-text PDF report using standard Latin fonts.',
    schema: reportSchema,
    ...fileActions,
    execute: async (_ctx, input) => runMediaJob({ kind: 'pdf-report', input }),
  });
  registry.register({
    id: 'file.hash',
    description: 'Compute a SHA-256 hash for a bounded Discord attachment to compare duplicate files.',
    schema: z.strictObject({ url }),
    ...fileActions,
    execute: async (_ctx, input) => runMediaJob({ kind: 'hash', data: await download(input.url) }),
  });
}
