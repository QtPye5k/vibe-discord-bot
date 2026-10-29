import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { zipSync, strToU8, strFromU8, Unzip, UnzipInflate, type Zippable } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import { downloadAttachment, discordAttachmentUrl } from '../core/files.js';
import { UserError } from '../core/errors.js';
import { heavyWork } from '../core/work-budget.js';

export const FILE_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  entries: 256,
  compressionRatio: 200,
  xmlDepth: 64,
  textCharacters: 30000,
  workers: 2,
  timeoutMs: 20000,
});
export interface GeneratedFile {
  attachment: Buffer;
  name: string;
  notice?: string;
}
type Cell = string | number | boolean | null;
const cell = z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]);
const row = z.array(cell).max(50);
const sheetSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(31)
    .regex(/^[^\[\]:*?/\\]+$/),
  rows: z.array(row).min(1).max(2000),
  headerRow: z.boolean().default(false),
});
const workbookSchema = z
  .strictObject({ sheets: z.array(sheetSchema).min(1).max(5) })
  .superRefine((value, ctx) => {
    if (new Set(value.sheets.map((sheet) => sheet.name.toLowerCase())).size !== value.sheets.length)
      ctx.addIssue({ code: 'custom', message: 'Sheet names must be unique ignoring case.' });
    if (
      value.sheets.reduce((count, sheet) => count + sheet.rows.reduce((sum, row) => sum + row.length, 0), 0) >
      50000
    )
      ctx.addIssue({ code: 'custom', message: 'Workbook cell limit: 50,000.' });
  });
export type WorkbookInput = z.input<typeof workbookSchema>;
const paragraphSchema = z.strictObject({
  text: z.string().max(12000),
  style: z.enum(['normal', 'title', 'heading1', 'heading2', 'bullet', 'number']).default('normal'),
});
const documentSchema = z.strictObject({
  title: z.string().max(150).default('Document'),
  paragraphs: z.array(paragraphSchema).min(1).max(500),
});
export type DocumentInput = z.input<typeof documentSchema>;
const slideSchema = z.strictObject({
  title: z.string().min(1).max(150),
  bullets: z.array(z.string().max(500)).max(12),
  notes: z.string().max(3000).optional(),
});
const presentationSchema = z.strictObject({
  title: z.string().max(150).default('Presentation'),
  slides: z.array(slideSchema).min(1).max(30),
  accent: z
    .string()
    .regex(/^[A-Fa-f0-9]{6}$/)
    .default('6366F1'),
});
export type PresentationInput = z.input<typeof presentationSchema>;
const csvSchema = z.strictObject({
  headers: z.array(z.string().max(200)).min(1).max(50),
  rows: z.array(row).max(2000),
});
export type CsvInput = z.input<typeof csvSchema>;
export function escapeOfficeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
const relationships = (entries: { id: string; type: string; target: string }[]) =>
  xml(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map((entry) => `<Relationship Id="${entry.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${entry.type}" Target="${entry.target}"/>`).join('')}</Relationships>`,
  );
function budget(value: unknown): void {
  if (JSON.stringify(value).length > 1_000_000)
    throw new UserError('File generation input exceeds one million JSON characters.');
}
function artifact(data: Uint8Array, name: string, notice?: string): GeneratedFile {
  if (data.length > FILE_LIMITS.outputBytes)
    throw new UserError('Generated file exceeds 8 MB. Reduce its content.');
  return { attachment: Buffer.from(data), name, ...(notice ? { notice } : {}) };
}
function safeName(name: string) {
  if (
    !/^[A-Za-z0-9_\[\]][A-Za-z0-9 _./\[\]-]{0,239}$/.test(name) ||
    name.includes('\\') ||
    name
      .split('/')
      .some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          ['__proto__', 'prototype', 'constructor'].includes(segment.toLowerCase()) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment),
      )
  )
    throw new UserError(
      'Archive entry names must be safe relative paths without traversal or reserved names.',
    );
}
interface Entry {
  name: string;
  size: number;
  compressed: number;
  crc: number;
  method: number;
}
export function inspectArchive(data: Uint8Array): Entry[] {
  const buffer = Buffer.from(data);
  if (buffer.length < 22 || buffer.length > FILE_LIMITS.inputBytes || buffer.readUInt32LE(0) !== 0x04034b50)
    throw new UserError('Use a ZIP/OpenXML package at most 8 MB.');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      end = i;
      break;
    }
  if (end < 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0)
    throw new UserError('Split, ZIP64 or malformed archives are unsupported.');
  const count = buffer.readUInt16LE(end + 10),
    directorySize = buffer.readUInt32LE(end + 12),
    offset = buffer.readUInt32LE(end + 16);
  if (
    count !== buffer.readUInt16LE(end + 8) ||
    count < 1 ||
    count > FILE_LIMITS.entries ||
    offset + directorySize > end
  )
    throw new UserError('Archive central-directory limits exceeded.');
  const entries: Entry[] = [];
  const names = new Set<string>();
  let position = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50)
      throw new UserError('Malformed archive directory.');
    const flags = buffer.readUInt16LE(position + 8),
      method = buffer.readUInt16LE(position + 10),
      compressed = buffer.readUInt32LE(position + 20),
      size = buffer.readUInt32LE(position + 24),
      nameLength = buffer.readUInt16LE(position + 28),
      extraLength = buffer.readUInt16LE(position + 30),
      commentLength = buffer.readUInt16LE(position + 32),
      localOffset = buffer.readUInt32LE(position + 42);
    if (
      position + 46 + nameLength + extraLength + commentLength > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      localOffset + 30 > offset
    )
      throw new UserError('Encrypted, unsupported or malformed ZIP entries are rejected.');
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    safeName(name);
    const normalized = name.toLowerCase();
    if (names.has(normalized)) throw new UserError('Duplicate archive entries are not allowed.');
    names.add(normalized);
    if (
      size > FILE_LIMITS.entryBytes ||
      size > Math.max(1, compressed) * FILE_LIMITS.compressionRatio ||
      (total += size) > FILE_LIMITS.totalBytes
    )
      throw new UserError('Archive decompression size or compression-ratio limit exceeded.');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new UserError('Malformed ZIP local entry.');
    entries.push({ name, size, compressed, crc: buffer.readUInt32LE(position + 16), method });
    position += 46 + nameLength + extraLength + commentLength;
  }
  if (position !== offset + directorySize)
    throw new UserError('Archive directory size does not match its records.');
  return entries;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(data: Uint8Array) {
  let crc = -1;
  for (const value of data) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 255]!;
  return ~crc >>> 0;
}
export function readArchive(data: Uint8Array): Map<string, Buffer> {
  const entries = inspectArchive(data),
    known = new Map(entries.map((entry) => [entry.name, entry])),
    output = new Map<string, Buffer>();
  let total = 0;
  const unzip = new Unzip((file) => {
    const entry = known.get(file.name);
    if (!entry || file.compression !== entry.method || output.has(file.name))
      throw new UserError('ZIP local and central records disagree.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw new UserError('Archive decompression failed.');
      length += chunk.length;
      total += chunk.length;
      if (length > entry.size || length > FILE_LIMITS.entryBytes || total > FILE_LIMITS.totalBytes) {
        file.terminate();
        throw new UserError('Actual archive output exceeds declared limits.');
      }
      chunks.push(chunk);
      if (final) {
        if (length !== entry.size) throw new UserError('ZIP output size mismatch.');
        const buffer = Buffer.concat(chunks, length);
        if (crc32(buffer) !== entry.crc) throw new UserError('ZIP content checksum mismatch.');
        output.set(file.name, buffer);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < data.length; offset += 4096)
    unzip.push(data.subarray(offset, offset + 4096), offset + 4096 >= data.length);
  if (output.size !== known.size) throw new UserError('Incomplete archive contents.');
  return output;
}
function pack(parts: Record<string, string | Uint8Array>): Buffer {
  const files: Zippable = Object.create(null) as Zippable;
  for (const [name, value] of Object.entries(parts)) {
    safeName(name);
    files[name] = typeof value === 'string' ? strToU8(value) : value;
  }
  let result = zipSync(files, { level: 6 });
  try {
    inspectArchive(result);
  } catch {
    result = zipSync(files, { level: 0 });
    inspectArchive(result);
  }
  return Buffer.from(result);
}
export function createCsv(raw: CsvInput): GeneratedFile {
  const input = csvSchema.parse(raw);
  budget(input);
  if (input.rows.some((row) => row.length > input.headers.length))
    throw new UserError('A row has more cells than the header.');
  const quote = (value: Cell) => {
    let text = value === null ? '' : String(value);
    if (/^\s*[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = [
    input.headers,
    ...input.rows.map((row) => input.headers.map((_, index) => row[index] ?? null)),
  ];
  return artifact(
    Buffer.from('\ufeff' + rows.map((row) => row.map(quote).join(',')).join('\r\n')),
    'table.csv',
  );
}
export function parseCsv(source: string): string[][] {
  if (source.length > 1_000_000 || source.includes('\0'))
    throw new UserError('CSV input is too large or binary.');
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    closedQuote = false;
  const text = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else value += char;
    } else if (closedQuote && char !== ',' && char !== '\r' && char !== '\n') {
      throw new UserError('Invalid characters after a CSV closing quote.');
    } else if (char === '"') {
      if (value) throw new UserError('Invalid CSV quote placement.');
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
      closedQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      closedQuote = false;
    } else value += char;
    if (value.length > 12000 || row.length > 50 || rows.length > 2001)
      throw new UserError('CSV row/cell limits exceeded.');
  }
  if (quoted) throw new UserError('CSV quoted field is incomplete.');
  if (value || row.length || closedQuote || !rows.length) {
    row.push(value);
    rows.push(row);
  }
  if (rows.length > 2001 || rows.some((row) => row.length > 50))
    throw new UserError('CSV row/cell limits exceeded.');
  return rows;
}
function columnName(index: number): string {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}
export function createXlsx(raw: WorkbookInput): GeneratedFile {
  const input = workbookSchema.parse(raw);
  budget(input);
  const parts: Record<string, string> = {};
  const overrides = [
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
  ];
  for (let index = 0; index < input.sheets.length; index++) {
    const sheet = input.sheets[index]!;
    const columns = Math.max(1, ...sheet.rows.map((row) => row.length));
    const cells = sheet.rows
      .map(
        (values, rowIndex) =>
          `<row r="${rowIndex + 1}">${values
            .map((value, column) => {
              const ref = `${columnName(column)}${rowIndex + 1}`,
                style = sheet.headerRow && rowIndex === 0 ? ' s="1"' : '';
              return value === null
                ? `<c r="${ref}"/>`
                : typeof value === 'number'
                  ? `<c r="${ref}"${style}><v>${value}</v></c>`
                  : typeof value === 'boolean'
                    ? `<c r="${ref}" t="b"${style}><v>${value ? 1 : 0}</v></c>`
                    : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeOfficeXml(value)}</t></is></c>`;
            })
            .join('')}</row>`,
      )
      .join('');
    parts[`xl/worksheets/sheet${index + 1}.xml`] = xml(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${columnName(columns - 1)}${sheet.rows.length}"/><sheetViews><sheetView workbookViewId="0">${sheet.headerRow ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ''}</sheetView></sheetViews><cols><col min="1" max="${columns}" width="22" customWidth="1"/></cols><sheetData>${cells}</sheetData>${sheet.headerRow ? `<autoFilter ref="A1:${columnName(columns - 1)}${sheet.rows.length}"/>` : ''}</worksheet>`,
    );
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    );
  }
  parts['[Content_Types].xml'] = xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`,
  );
  parts['_rels/.rels'] = relationships([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]);
  parts['xl/workbook.xml'] = xml(
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${input.sheets.map((sheet, index) => `<sheet name="${escapeOfficeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
  );
  parts['xl/_rels/workbook.xml.rels'] = relationships([
    ...input.sheets.map((_, index) => ({
      id: `rId${index + 1}`,
      type: 'worksheet',
      target: `worksheets/sheet${index + 1}.xml`,
    })),
    { id: `rId${input.sheets.length + 1}`, type: 'styles', target: 'styles.xml' },
  ]);
  parts['xl/styles.xml'] = xml(
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  );
  return artifact(
    pack(parts),
    'workbook.xlsx',
    'Cell strings are literal text; formulas and macros are never generated.',
  );
}
export function createDocx(raw: DocumentInput): GeneratedFile {
  const input = documentSchema.parse(raw);
  budget(input);
  const styleNames = {
    normal: 'Normal',
    title: 'Title',
    heading1: 'Heading1',
    heading2: 'Heading2',
    bullet: 'Normal',
    number: 'Normal',
  };
  const paragraphs = [
    ...(input.title ? [{ text: input.title, style: 'title' as const }] : []),
    ...input.paragraphs,
  ]
    .map(
      (paragraph) =>
        `<w:p><w:pPr><w:pStyle w:val="${styleNames[paragraph.style]}"/>${paragraph.style === 'bullet' || paragraph.style === 'number' ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${paragraph.style === 'bullet' ? 1 : 2}"/></w:numPr>` : ''}</w:pPr><w:r>${paragraph.text
          .split('\n')
          .map(
            (line, index) =>
              `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeOfficeXml(line)}</w:t>`,
          )
          .join('')}</w:r></w:p>`,
    )
    .join('');
  const parts: Record<string, string> = {
    '[Content_Types].xml': xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    ),
    '_rels/.rels': relationships([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]),
    'word/document.xml': xml(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
    ),
    'word/_rels/document.xml.rels': relationships([
      { id: 'rId1', type: 'styles', target: 'styles.xml' },
      { id: 'rId2', type: 'numbering', target: 'numbering.xml' },
    ]),
    'word/styles.xml': xml(
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>',
    ),
    'word/numbering.xml': xml(
      '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="180"/></w:pPr></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="180"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
    ),
  };
  return artifact(pack(parts), 'document.docx');
}
const group =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const presentationNamespaces =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
function textShape(
  id: number,
  name: string,
  texts: string[],
  x: number,
  y: number,
  width: number,
  height: number,
  size: number,
  bold: boolean,
  color: string,
  bullets = false,
) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${texts.map((text) => `<a:p><a:pPr marL="${bullets ? 228600 : 0}" indent="${bullets ? -228600 : 0}">${bullets ? '<a:buChar char="•"/>' : '<a:buNone/>'}<a:spcAft><a:spcPts val="1000"/></a:spcAft></a:pPr><a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Aptos"/></a:rPr><a:t>${escapeOfficeXml(text)}</a:t></a:r><a:endParaRPr lang="en-US" sz="${size}"/></a:p>`).join('')}</p:txBody></p:sp>`;
}
export function createPptx(raw: PresentationInput): GeneratedFile {
  const input = presentationSchema.parse(raw);
  budget(input);
  const parts: Record<string, string> = {};
  const overrides = [
    [
      '/ppt/presentation.xml',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    ],
    [
      '/ppt/slideMasters/slideMaster1.xml',
      'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    ],
    [
      '/ppt/slideLayouts/slideLayout1.xml',
      'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
    ],
    ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
  ];
  for (let i = 0; i < input.slides.length; i++) {
    const slide = input.slides[i]!,
      titleSize = Math.min(3400, Math.floor(180000 / Math.max(1, slide.title.length))),
      bodySize = Math.max(
        1000,
        Math.min(
          2200,
          Math.floor(150000 / Math.max(1, ...slide.bullets.map((line) => line.length))),
          Math.floor(24000 / Math.max(1, slide.bullets.length)),
        ),
      );
    parts[`ppt/slides/slide${i + 1}.xml`] = xml(
      `<p:sld ${presentationNamespaces}><p:cSld name="${escapeOfficeXml(slide.title)}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${textShape(2, 'Title', [slide.title], 685800, 457200, 10820400, 1097280, titleSize, true, '111827')}${textShape(3, 'Body', slide.bullets, 685800, 1737360, 10820400, 4434840, bodySize, false, '334155', true)}${textShape(4, 'Footer', [`${i + 1} / ${input.slides.length}`], 685800, 6400800, 10820400, 274320, 1000, false, input.accent)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    );
    parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = relationships([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      ...(slide.notes
        ? [{ id: 'rIdNotes', type: 'notesSlide', target: `../notesSlides/notesSlide${i + 1}.xml` }]
        : []),
    ]);
    if (slide.notes) {
      parts[`ppt/notesSlides/notesSlide${i + 1}.xml`] = xml(
        `<p:notes ${presentationNamespaces}><p:cSld><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Text"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${slide.notes
          .split('\n')
          .map((line) => `<a:p><a:r><a:t>${escapeOfficeXml(line)}</a:t></a:r></a:p>`)
          .join(
            '',
          )}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`,
      );
      parts[`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`] = relationships([
        { id: 'rIdSlide', type: 'slide', target: `../slides/slide${i + 1}.xml` },
        { id: 'rIdMaster', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' },
      ]);
      overrides.push([
        `/ppt/notesSlides/notesSlide${i + 1}.xml`,
        'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
      ]);
    }
    overrides.push([
      `/ppt/slides/slide${i + 1}.xml`,
      'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    ]);
  }
  const hasNotes = input.slides.some((slide) => slide.notes);
  if (hasNotes) {
    parts['ppt/notesMasters/notesMaster1.xml'] = xml(
      `<p:notesMaster ${presentationNamespaces}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:notesStyle/></p:notesMaster>`,
    );
    parts['ppt/notesMasters/_rels/notesMaster1.xml.rels'] = relationships([
      { id: 'rIdTheme', type: 'theme', target: '../theme/theme1.xml' },
    ]);
    overrides.push([
      '/ppt/notesMasters/notesMaster1.xml',
      'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
    ]);
  }
  parts['[Content_Types].xml'] = xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([name, type]) => `<Override PartName="${name}" ContentType="${type}"/>`).join('')}</Types>`,
  );
  parts['_rels/.rels'] = relationships([
    { id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' },
  ]);
  parts['ppt/presentation.xml'] = xml(
    `<p:presentation ${presentationNamespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>${hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rIdNotesMaster"/></p:notesMasterIdLst>' : ''}<p:sldIdLst>${input.slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  parts['ppt/_rels/presentation.xml.rels'] = relationships([
    { id: 'rIdMaster', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
    ...(hasNotes
      ? [{ id: 'rIdNotesMaster', type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' }]
      : []),
    ...input.slides.map((_, index) => ({
      id: `rId${index + 1}`,
      type: 'slide',
      target: `slides/slide${index + 1}.xml`,
    })),
  ]);
  parts['ppt/slideMasters/slideMaster1.xml'] = xml(
    `<p:sldMaster ${presentationNamespaces}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
  );
  parts['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = relationships([
    { id: 'rIdLayout', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rIdTheme', type: 'theme', target: '../theme/theme1.xml' },
  ]);
  parts['ppt/slideLayouts/slideLayout1.xml'] = xml(
    `<p:sldLayout ${presentationNamespaces} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  );
  parts['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = relationships([
    { id: 'rIdMaster', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' },
  ]);
  const colors = {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '1F2937',
    lt2: 'F1F5F9',
    accent1: input.accent,
    accent2: '0EA5E9',
    accent3: '10B981',
    accent4: 'F59E0B',
    accent5: 'EF4444',
    accent6: '8B5CF6',
    hlink: '2563EB',
    folHlink: '7C3AED',
  };
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',
    line = `<a:ln w="9525">${fill}<a:prstDash val="solid"/></a:ln>`;
  parts['ppt/theme/theme1.xml'] = xml(
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Unified Bot"><a:themeElements><a:clrScheme name="Unified">${Object.entries(
      colors,
    )
      .map(([name, color]) => `<a:${name}><a:srgbClr val="${color}"/></a:${name}>`)
      .join(
        '',
      )}</a:clrScheme><a:fontScheme name="Aptos"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Unified"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${line.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  );
  return artifact(pack(parts), 'presentation.pptx');
}
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  ignoreDeclaration: true,
});
export function parseOfficeXml(data: Uint8Array): Record<string, unknown> {
  const text = strFromU8(data);
  if (data.length > FILE_LIMITS.entryBytes || /<!DOCTYPE|<!ENTITY/i.test(text))
    throw new UserError('XML size limit or prohibited DTD/entity declaration.');
  let depth = 0;
  for (let start = text.indexOf('<'); start >= 0; start = text.indexOf('<', start + 1)) {
    if (text[start + 1] === '?' || text[start + 1] === '!') continue;
    const end = text.indexOf('>', start + 1);
    if (end < 0) throw new UserError('Malformed XML.');
    if (text[start + 1] === '/') depth--;
    else if (text[end - 1] !== '/') depth++;
    if (depth < 0 || depth > FILE_LIMITS.xmlDepth) throw new UserError('XML nesting limit exceeded.');
  }
  if (XMLValidator.validate(text) !== true) throw new UserError('Malformed XML document.');
  return parser.parse(text) as Record<string, unknown>;
}
const list = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function decodeXmlText(value: string) {
  const entities: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return value.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#[0-9]+);/gi, (match: string, code: string) => {
    if (!code.startsWith('#')) return entities[code] ?? match;
    const value = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : match;
  });
}
function plainText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return decodeXmlText(String(value));
  if (Array.isArray(value)) return value.map(plainText).join('');
  if (value && typeof value === 'object')
    return Object.entries(value)
      .filter(([name]) => !name.startsWith('@_'))
      .map(([, child]) => plainText(child))
      .join('');
  return '';
}
function paragraphTexts(data: Uint8Array, prefix: string): string[] {
  parseOfficeXml(data);
  const tree: unknown = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: false,
    ignoreDeclaration: true,
  }).parse(strFromU8(data));
  const result: string[] = [];
  function walk(node: unknown) {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [name, value] of Object.entries(node)) {
      if (name === `${prefix}:p`) {
        {
          const texts: string[] = [];
          const collect = (node: unknown) => {
            if (Array.isArray(node)) {
              for (const value of node) collect(value);
              return;
            }
            if (!node || typeof node !== 'object') return;
            for (const [name, value] of Object.entries(node))
              if (name === `${prefix}:t`) texts.push(plainText(value));
              else if (name === `${prefix}:br`) texts.push('\n');
              else if (!name.startsWith('@_')) collect(value);
          };
          collect(value);
          result.push(texts.join(''));
        }
      } else walk(value);
    }
  }
  walk(tree);
  return result;
}
export interface ExtractedFile {
  format: 'xlsx' | 'docx' | 'pptx' | 'csv' | 'text';
  text: string;
  truncated: boolean;
  sheets?: { name: string; rows: Cell[][] }[];
}
export function extractFile(data: Uint8Array, filename: string): ExtractedFile {
  if (data.length > FILE_LIMITS.inputBytes) throw new UserError('Input exceeds 8 MB.');
  const extension = filename.toLowerCase().split('.').pop();
  if (['txt', 'md', 'log', 'json'].includes(extension ?? '')) {
    const text = Buffer.from(data).toString('utf8');
    if (text.includes('\0')) throw new UserError('Binary text files are not supported.');
    return {
      format: 'text',
      text: text.slice(0, FILE_LIMITS.textCharacters),
      truncated: text.length > FILE_LIMITS.textCharacters,
    };
  }
  if (extension === 'csv') {
    const rows = parseCsv(Buffer.from(data).toString('utf8'));
    const text = rows.map((row) => row.join('\t')).join('\n');
    return {
      format: 'csv',
      text: text.slice(0, FILE_LIMITS.textCharacters),
      truncated: text.length > FILE_LIMITS.textCharacters,
      sheets: [{ name: 'Sheet1', rows }],
    };
  }
  if (!['xlsx', 'docx', 'pptx'].includes(extension ?? ''))
    throw new UserError('Supported document inputs: XLSX, DOCX, PPTX, CSV and text.');
  const parts = readArchive(data);
  for (const name of parts.keys())
    if (/(?:vbaProject|activeX|embeddings|macros)/i.test(name))
      throw new UserError('Macros, active content and embedded object packages are unsupported.');
  const get = (name: string) => {
    const data = parts.get(name);
    if (!data) throw new UserError(`Required OpenXML part is missing: ${name}`);
    return parseOfficeXml(data);
  };
  const types = parts.get('[Content_Types].xml');
  if (!types || /macroEnabled/i.test(strFromU8(types)))
    throw new UserError('Invalid or macro-enabled Office package.');
  if (extension === 'docx') {
    const document = parts.get('word/document.xml');
    if (!document) throw new UserError('Required document XML is missing.');
    const text = paragraphTexts(document, 'w').join('\n');
    return {
      format: 'docx',
      text: text.slice(0, FILE_LIMITS.textCharacters),
      truncated: text.length > FILE_LIMITS.textCharacters,
    };
  }
  if (extension === 'pptx') {
    const presentation = object(get('ppt/presentation.xml')['p:presentation']);
    const rels = list(object(get('ppt/_rels/presentation.xml.rels').Relationships).Relationship).map(object);
    const slides = list(object(presentation['p:sldIdLst'])['p:sldId']).map((node) => {
      const rel = rels.find((rel) => rel['@_Id'] === object(node)['@_r:id']);
      if (!rel || rel['@_TargetMode'] === 'External')
        throw new UserError('External or missing slide relationships are unsupported.');
      const target = String(rel['@_Target']),
        name = target.startsWith('/') ? target.slice(1) : `ppt/${target}`;
      if (!/^ppt\/slides\/[A-Za-z0-9_.-]+\.xml$/.test(name))
        throw new UserError('Unsupported slide relationship.');
      return name;
    });
    if (slides.length > 100) throw new UserError('At most 100 input slides are supported.');
    const text = slides
      .map((name, index) => {
        const data = parts.get(name);
        if (!data) throw new UserError('Required slide XML is missing.');
        return `Slide ${index + 1}\n${paragraphTexts(data, 'a').join('\n')}`;
      })
      .join('\n\n');
    return {
      format: 'pptx',
      text: text.slice(0, FILE_LIMITS.textCharacters),
      truncated: text.length > FILE_LIMITS.textCharacters,
    };
  }
  const workbook = object(get('xl/workbook.xml').workbook),
    sheets = list(object(workbook.sheets).sheet);
  if (sheets.length > 10) throw new UserError('At most 10 input worksheets are supported.');
  const rels = list(object(get('xl/_rels/workbook.xml.rels').Relationships).Relationship);
  const shared = parts.has('xl/sharedStrings.xml')
    ? list(object(get('xl/sharedStrings.xml').sst).si).map(plainText)
    : [];
  let count = 0;
  const result = sheets.map((node, index) => {
    const sheet = object(node),
      rel = rels.map(object).find((rel) => rel['@_Id'] === sheet['@_r:id']);
    if (!rel || rel['@_TargetMode'] === 'External')
      throw new UserError('External or missing worksheet relationships are unsupported.');
    const target = String(rel['@_Target']);
    const name = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    if (name.includes('..') || !/^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$/.test(name))
      throw new UserError('Unsupported worksheet relationship.');
    const worksheet = object(get(name).worksheet),
      rows: Cell[][] = [];
    for (const rowNode of list(object(worksheet.sheetData).row)) {
      const rowIndex = Number(object(rowNode)['@_r'] ?? rows.length + 1);
      if (!Number.isInteger(rowIndex) || rowIndex < rows.length + 1 || rowIndex > 2000)
        throw new UserError('Worksheet rows must be ordered and within the 2,000-row limit.');
      while (rows.length < rowIndex - 1) rows.push([]);
      const row: Cell[] = [];
      for (const cellNode of list(object(rowNode).c)) {
        if (++count > 50000) throw new UserError('Worksheet cell limit exceeded.');
        const cell = object(cellNode),
          reference = String(cell['@_r'] ?? '');
        const columnMatch = /^([A-Z]{1,3})\d+$/.exec(reference);
        let column = row.length;
        if (columnMatch) {
          column = [...columnMatch[1]!].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
        }
        if (column > 49) throw new UserError('At most 50 input columns are supported.');
        if (column < row.length) throw new UserError('Worksheet cells must be ordered without duplicates.');
        while (row.length < column) row.push(null);
        const kind = String(cell['@_t'] ?? 'n'),
          raw = plainText(cell.v);
        let value: Cell =
          kind === 'inlineStr'
            ? plainText(cell.is)
            : kind === 's'
              ? Number.isInteger(Number(raw)) && Number(raw) >= 0 && shared[Number(raw)] !== undefined
                ? shared[Number(raw)]!
                : (() => {
                    throw new UserError('Invalid shared-string reference.');
                  })()
              : kind === 'b'
                ? raw === '1'
                : kind === 'str' || kind === 'e'
                  ? raw
                  : raw !== '' && Number.isFinite(Number(raw))
                    ? Number(raw)
                    : kind === 'n' && raw === ''
                      ? null
                      : raw;
        row[column] = value;
      }
      rows.push(row);
    }
    return { name: decodeXmlText(String(sheet['@_name'] ?? `Sheet${index + 1}`)), rows };
  });
  const text = result
    .map(
      (sheet) =>
        `[${sheet.name}]\n${sheet.rows.map((row) => row.map((value) => value ?? '').join('\t')).join('\n')}`,
    )
    .join('\n\n');
  return {
    format: 'xlsx',
    text: text.slice(0, FILE_LIMITS.textCharacters),
    truncated: text.length > FILE_LIMITS.textCharacters,
    sheets: result,
  };
}
export function convertFile(
  data: Uint8Array,
  filename: string,
  format: 'txt' | 'csv' | 'xlsx' | 'docx',
): GeneratedFile {
  const extracted = extractFile(data, filename);
  if (format === 'txt')
    return artifact(
      Buffer.from(extracted.text),
      'extracted.txt',
      extracted.truncated ? 'Text was truncated to the extraction limit.' : undefined,
    );
  if (format === 'docx') {
    const paragraphs = extracted.text.split('\n').flatMap((line) => line.match(/[\s\S]{1,12000}/g) ?? ['']);
    const result = createDocx({
      title: filename.replace(/\.[^.]+$/, '').slice(0, 150),
      paragraphs: paragraphs.slice(0, 500).map((text) => ({ text })),
    });
    if (extracted.truncated || paragraphs.length > 500)
      result.notice =
        'Text was truncated to the document extraction/paragraph limit. Layout is not preserved.';
    return result;
  }
  if (!extracted.sheets?.length)
    throw new UserError('CSV/XLSX conversion requires a supported tabular input.');
  if (format === 'xlsx')
    return createXlsx({
      sheets: extracted.sheets.map((sheet) => ({ ...sheet, rows: sheet.rows.length ? sheet.rows : [[]] })),
    });
  const rows = extracted.sheets[0]!.rows;
  if (!rows.length) return artifact(Buffer.from(''), 'table.csv');
  const result = createCsv({
    headers: rows[0]!.map((value) => (value === null ? '' : String(value))),
    rows: rows.slice(1),
  });
  if (extracted.sheets.length > 1)
    result.notice = 'CSV contains only the first worksheet. Use XLSX to preserve all supported sheets.';
  return result;
}
export function createTextZip(files: { name: string; text: string }[]): GeneratedFile {
  if (files.length < 1 || files.length > 20) throw new UserError('Use 1–20 text archive entries.');
  budget(files);
  const names = new Set<string>();
  const parts: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const file of files) {
    safeName(file.name);
    if (names.has(file.name.toLowerCase())) throw new UserError('Archive names must be unique.');
    names.add(file.name.toLowerCase());
    parts[file.name] = file.text;
  }
  return artifact(pack(parts), 'files.zip');
}
type FileJob =
  | { kind: 'xlsx'; input: WorkbookInput }
  | { kind: 'docx'; input: DocumentInput }
  | { kind: 'pptx'; input: PresentationInput }
  | { kind: 'csv'; input: CsvInput }
  | { kind: 'extract'; data: Uint8Array; filename: string }
  | { kind: 'zip-info'; data: Uint8Array }
  | { kind: 'zip-extract'; data: Uint8Array; entry: string }
  | { kind: 'convert'; data: Uint8Array; filename: string; format: 'txt' | 'csv' | 'xlsx' | 'docx' }
  | { kind: 'zip'; input: { name: string; text: string }[] };
type FileResult = GeneratedFile | ExtractedFile | { entries: Entry[] };
async function executeFileJob(job: FileJob): Promise<FileResult> {
  switch (job.kind) {
    case 'xlsx':
      return createXlsx(job.input);
    case 'docx':
      return createDocx(job.input);
    case 'pptx':
      return createPptx(job.input);
    case 'csv':
      return createCsv(job.input);
    case 'zip':
      return createTextZip(job.input);
    case 'zip-info':
      return { entries: inspectArchive(job.data) };
    case 'zip-extract': {
      const parts = readArchive(job.data),
        content = parts.get(job.entry);
      if (!content) throw new UserError('That exact entry name is not present in the archive.');
      return artifact(content, job.entry.split('/').at(-1)!);
    }
    case 'extract':
      return extractFile(job.data, job.filename);
    case 'convert':
      return convertFile(job.data, job.filename, job.format);
  }
}
let activeWorkers = 0;
export async function runFileJob(job: FileJob): Promise<FileResult> {
  if (activeWorkers >= FILE_LIMITS.workers)
    throw new UserError('Office file processors are busy. Try again shortly.');
  const release = heavyWork.enter();
  activeWorkers++;
  try {
    return await new Promise<FileResult>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { kind: 'office-file-job', job },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
      let result: FileResult | undefined,
        error: Error | undefined,
        received = false;
      const timer = setTimeout(() => {
        error = new UserError('Office file processing timed out.');
        void worker.terminate();
      }, FILE_LIMITS.timeoutMs);
      worker.once('message', (message: { ok: boolean; result?: FileResult; error?: string }) => {
        received = true;
        if (!message.ok || !message.result) error = new UserError(message.error ?? 'File operation failed.');
        else {
          result = message.result;
          if ('attachment' in result) result.attachment = Buffer.from(result.attachment);
        }
        void worker.terminate();
      });
      worker.once('error', () => {
        error = new UserError('Office file processor failed or exceeded its resource limits.');
      });
      worker.once('exit', () => {
        clearTimeout(timer);
        if (error) reject(error);
        else if (!received || !result)
          reject(new UserError('Office file processor exited without a result.'));
        else resolve(result);
      });
    });
  } finally {
    activeWorkers--;
    release();
  }
}
if (!isMainThread && workerData?.kind === 'office-file-job')
  void executeFileJob(workerData.job as FileJob)
    .then((result) => parentPort?.postMessage({ ok: true, result }))
    .catch((error: unknown) =>
      parentPort?.postMessage({
        ok: false,
        error:
          error instanceof UserError
            ? error.message
            : error instanceof z.ZodError
              ? 'Invalid file generation options.'
              : 'Invalid or unsupported document.',
      }),
    )
    .finally(() => parentPort?.close());
const attachmentUrl = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      discordAttachmentUrl(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use a Discord-hosted HTTPS attachment URL');
const filename = z.string().regex(/^[A-Za-z0-9 _.-]{1,150}\.(?:xlsx|docx|pptx|csv|txt|md|log|json)$/i);
export function registerFileActions(registry: ActionRegistry): void {
  const base = { category: 'files', risk: 'read' as const, userPermissions: [], botPermissions: [] };
  registry.register({
    ...base,
    id: 'file.csv',
    description: 'Generate spreadsheet-safe CSV from explicit headers and primitive rows.',
    schema: csvSchema,
    execute: async (_ctx, input) => runFileJob({ kind: 'csv', input }),
  });
  registry.register({
    ...base,
    id: 'file.xlsx',
    description:
      'Generate a real macro-free XLSX workbook with typed literal cells, optional bold header and frozen row.',
    schema: workbookSchema,
    execute: async (_ctx, input) => runFileJob({ kind: 'xlsx', input }),
  });
  registry.register({
    ...base,
    id: 'file.docx',
    description: 'Generate a real DOCX document with title, headings, paragraphs and bullet/number lists.',
    schema: documentSchema,
    execute: async (_ctx, input) => runFileJob({ kind: 'docx', input }),
  });
  registry.register({
    ...base,
    id: 'file.pptx',
    description: 'Generate a real 16:9 PPTX presentation with title/bullet slides and page numbers.',
    schema: presentationSchema,
    execute: async (_ctx, input) => runFileJob({ kind: 'pptx', input }),
  });
  registry.register({
    ...base,
    id: 'file.extract',
    description:
      'Read text from bounded DOCX/PPTX/CSV/text or typed XLSX cells without executing macros, formulas or external links.',
    schema: z.strictObject({ url: attachmentUrl, filename }),
    execute: async (_ctx, input) =>
      runFileJob({
        kind: 'extract',
        data: await downloadAttachment(input.url, FILE_LIMITS.inputBytes),
        filename: input.filename,
      }),
  });
  registry.register({
    ...base,
    id: 'file.convert',
    description:
      'Convert supported tabular files between CSV/XLSX, or extract supported document content to TXT/DOCX (layout is not preserved).',
    schema: z.strictObject({ url: attachmentUrl, filename, format: z.enum(['txt', 'csv', 'xlsx', 'docx']) }),
    execute: async (_ctx, input) =>
      runFileJob({
        kind: 'convert',
        data: await downloadAttachment(input.url, FILE_LIMITS.inputBytes),
        filename: input.filename,
        format: input.format,
      }),
  });
  registry.register({
    ...base,
    id: 'file.zip',
    description: 'Package up to 20 named text files into a ZIP using safe relative filenames.',
    schema: z.strictObject({
      files: z
        .array(z.strictObject({ name: z.string().min(1).max(240), text: z.string().max(200000) }))
        .min(1)
        .max(20),
    }),
    execute: async (_ctx, input) => runFileJob({ kind: 'zip', input: input.files }),
  });
  registry.register({
    ...base,
    id: 'file.zip-info',
    description: 'Inspect a bounded ZIP central directory without writing its entries to disk.',
    schema: z.strictObject({ url: attachmentUrl }),
    execute: async (_ctx, input) =>
      runFileJob({ kind: 'zip-info', data: await downloadAttachment(input.url, FILE_LIMITS.inputBytes) }),
  });
  registry.register({
    ...base,
    id: 'file.zip-extract',
    description:
      'Validate ZIP sizes and checksums, then return one exact named entry as an attachment without filesystem extraction.',
    schema: z.strictObject({ url: attachmentUrl, entry: z.string().min(1).max(240) }),
    execute: async (_ctx, input) =>
      runFileJob({
        kind: 'zip-extract',
        data: await downloadAttachment(input.url, FILE_LIMITS.inputBytes),
        entry: input.entry,
      }),
  });
}
