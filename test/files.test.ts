import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ActionRegistry } from '../src/core/registry.js';
import {
  FILE_LIMITS,
  registerFileActions,
  createCsv,
  parseCsv,
  createXlsx,
  createDocx,
  createPptx,
  extractFile,
  convertFile,
  createTextZip,
  inspectArchive,
  readArchive,
  parseOfficeXml,
  runFileJob,
  escapeOfficeXml,
} from '../src/features/files.js';

function repack(parts: Map<string, Buffer>) {
  return zipSync(Object.fromEntries(parts), { level: 0 });
}
test('nine office/archive actions register bounded schemas and restricted download URLs', () => {
  const registry = new ActionRegistry();
  registerFileActions(registry);
  assert.equal(registry.list().length, 9);
  for (const action of registry.list()) assert.equal(action.risk, 'read');
  assert.throws(() =>
    registry.get('file.extract').schema.parse({ url: 'file:///secret', filename: 'file.docx' }),
  );
  assert.throws(() =>
    registry
      .get('file.extract')
      .schema.parse({ url: 'https://cdn.discordapp.com/attachments/1/2/file.docm', filename: 'file.docm' }),
  );
  assert.throws(() =>
    createXlsx({
      sheets: [
        { name: 'Duplicate', rows: [[]] },
        { name: 'duplicate', rows: [[]] },
      ],
    }),
  );
  assert.throws(() => createXlsx({ sheets: [{ name: 'Bad/Name', rows: [[]] }] }));
});
test('CSV escapes formulas, quotes and newlines and pads short rows', () => {
  const file = createCsv({
    headers: ['Label', '=Header'],
    rows: [['comma,quote"', '=SUM(A1)'], ['line\nline'], [true, 2]],
  });
  const rows = parseCsv(file.attachment.toString());
  assert.deepEqual(rows, [
    ['Label', "'=Header"],
    ['comma,quote"', "'=SUM(A1)"],
    ['line\nline', ''],
    ['true', '2'],
  ]);
  assert.throws(() => createCsv({ headers: ['a'], rows: [[1, 2]] }), /more cells/);
});
test('CSV parser accepts empty quoted fields and rejects malformed quotes and exact final row/column overflow', () => {
  assert.deepEqual(parseCsv('""'), [['']]);
  assert.deepEqual(parseCsv('"a""b",c\r\n'), [['a"b', 'c']]);
  for (const value of [
    '"a"b,c',
    'ab"c',
    '"unterminated',
    'a\0b',
    Array(51).fill('a').join(','),
    Array(2002).fill('a').join('\n'),
  ])
    assert.throws(() => parseCsv(value));
});
test('XLSX stores primitive types and literal formula-like strings in valid worksheet parts', () => {
  const file = createXlsx({
    sheets: [
      {
        name: 'A & B',
        rows: [
          ['Name', 'Count', 'Flag', 'Blank'],
          ['=1+2', 2.5, true, null],
        ],
        headerRow: true,
      },
    ],
  });
  const parts = readArchive(file.attachment);
  for (const [name, data] of parts)
    if (name.endsWith('.xml') || name.endsWith('.rels')) assert.doesNotThrow(() => parseOfficeXml(data));
  const xml = parts.get('xl/worksheets/sheet1.xml')!.toString();
  assert.match(xml, /state="frozen"/);
  assert.match(xml, /t="inlineStr"/);
  assert.doesNotMatch(xml, /<f>/);
  const output = extractFile(file.attachment, 'book.xlsx');
  assert.equal(output.sheets?.[0]?.name, 'A & B');
  assert.deepEqual(output.sheets?.[0]?.rows, [
    ['Name', 'Count', 'Flag', 'Blank'],
    ['=1+2', 2.5, true, null],
  ]);
});
test('DOCX preserves escaped Unicode text, headings, paragraphs, lists and explicit line breaks', () => {
  const file = createDocx({
    title: 'A & B <title>',
    paragraphs: [
      { text: 'Heading', style: 'heading1' },
      { text: 'Café 😀\nSecond line' },
      { text: 'Bullet', style: 'bullet' },
      { text: 'Number', style: 'number' },
    ],
  });
  const parts = readArchive(file.attachment);
  assert.ok(parts.has('word/numbering.xml'));
  const text = extractFile(file.attachment, 'file.docx').text;
  assert.match(text, /A & B <title>/);
  assert.match(text, /Café 😀\nSecond line/);
  assert.match(text, /Bullet\nNumber/);
});
test('PPTX contains real slides, notes, layout/master/theme relationships and correct 16:9 dimensions', () => {
  const file = createPptx({
    slides: [
      { title: 'One & Two', bullets: ['Alpha', 'Beta'], notes: 'Private speaker notes\nNext line' },
      { title: 'Second', bullets: [] },
    ],
  });
  const parts = readArchive(file.attachment);
  for (const [name, data] of parts)
    if (name.endsWith('.xml') || name.endsWith('.rels')) assert.doesNotThrow(() => parseOfficeXml(data));
  assert.match(parts.get('ppt/presentation.xml')!.toString(), /cx="12192000" cy="6858000"/);
  assert.match(parts.get('ppt/notesSlides/notesSlide1.xml')!.toString(), /Private speaker notes/);
  assert.ok(parts.has('ppt/notesMasters/notesMaster1.xml'));
  assert.match(extractFile(file.attachment, 'file.pptx').text, /Slide 1\nOne & Two\nAlpha\nBeta/);
});
test('PPTX extraction follows declared presentation order rather than slide filenames', () => {
  const parts = readArchive(
    createPptx({
      slides: [
        { title: 'First', bullets: [] },
        { title: 'Second', bullets: [] },
      ],
    }).attachment,
  );
  parts.set(
    'ppt/presentation.xml',
    Buffer.from(
      parts
        .get('ppt/presentation.xml')!
        .toString()
        .replace('r:id="rId1"', 'r:id="TEMP"')
        .replace('r:id="rId2"', 'r:id="rId1"')
        .replace('r:id="TEMP"', 'r:id="rId2"'),
    ),
  );
  const result = extractFile(repack(parts), 'file.pptx');
  assert.match(result.text, /^Slide 1\nSecond/);
  assert.ok(result.text.indexOf('Second') < result.text.indexOf('Slide 2\nFirst'));
});
test('OpenXML extraction never evaluates formulas or follows external worksheet links', () => {
  const parts = readArchive(createXlsx({ sheets: [{ name: 'Sheet', rows: [[42]] }] }).attachment);
  parts.set(
    'xl/worksheets/sheet1.xml',
    Buffer.from(
      parts
        .get('xl/worksheets/sheet1.xml')!
        .toString()
        .replace('<v>42</v>', '<f>WEBSERVICE("file:///secret")</f><v>42</v>'),
    ),
  );
  assert.equal(extractFile(repack(parts), 'file.xlsx').sheets?.[0]?.rows[0]?.[0], 42);
  parts.set(
    'xl/_rels/workbook.xml.rels',
    Buffer.from(
      parts
        .get('xl/_rels/workbook.xml.rels')!
        .toString()
        .replace(
          'Target="worksheets/sheet1.xml"',
          'Target="https://example.com/secret" TargetMode="External"',
        ),
    ),
  );
  assert.throws(() => extractFile(repack(parts), 'file.xlsx'), /External/);
});
test('macros, embedded object packages, XML DTDs, entities and excessive nesting are rejected', () => {
  const parts = readArchive(createDocx({ paragraphs: [{ text: 'hello' }] }).attachment);
  parts.set('word/vbaProject.bin', Buffer.from('macro'));
  assert.throws(() => extractFile(repack(parts), 'file.docx'), /Macros/);
  for (const text of [
    '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><a>&x;</a>',
    '<a>'.repeat(65) + '</a>'.repeat(65),
    '<a><b></a>',
  ])
    assert.throws(() => parseOfficeXml(Buffer.from(text)));
  assert.equal(escapeOfficeXml('a\0<&"\ud800'), 'a&lt;&amp;&quot;�');
});
test('ZIP creation/extraction preserves text and rejects traversal, duplicate casefold names and unsafe paths', () => {
  const file = createTextZip([{ name: 'folder/report.txt', text: 'hello 😀' }]);
  assert.equal(readArchive(file.attachment).get('folder/report.txt')!.toString(), 'hello 😀');
  for (const name of [
    '../secret',
    '/absolute',
    'folder/../secret',
    'C:/secret',
    'folder\\secret',
    'NUL.txt',
    '__proto__',
    'constructor',
  ])
    assert.throws(() => createTextZip([{ name, text: 'x' }]));
  assert.throws(
    () =>
      createTextZip([
        { name: 'A.txt', text: 'a' },
        { name: 'a.TXT', text: 'b' },
      ]),
    /unique/,
  );
});
test('ZIP checks reject CRC tampering, decompression bombs, encrypted entries and malformed directories', () => {
  const original = createTextZip([{ name: 'file.txt', text: 'hello world' }]).attachment;
  const crc = Buffer.from(original);
  const central = crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  crc[central + 16]! ^= 1;
  assert.throws(() => readArchive(crc), /checksum|decompression/);
  const encrypted = Buffer.from(original);
  encrypted.writeUInt16LE(1, central + 8);
  assert.throws(() => inspectArchive(encrypted), /Encrypted/);
  assert.throws(() => inspectArchive(zipSync({ 'bomb.txt': strToU8('a'.repeat(1000000)) })), /ratio/);
  assert.throws(() => inspectArchive(original.subarray(0, original.length - 2)), /malformed/);
});
test('actual output cannot exceed falsified ZIP directory sizes', () => {
  const data = createTextZip([{ name: 'file.txt', text: 'a'.repeat(10000) }]).attachment;
  const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  data.writeUInt32LE(1, central + 24);
  assert.throws(() => readArchive(data), /limits|size/);
});
test('document/table conversions generate readable real output and disclose text truncation', () => {
  const input = createCsv({ headers: ['Name', 'Count'], rows: [['One', 2]] }).attachment;
  const xlsx = convertFile(input, 'table.csv', 'xlsx');
  assert.equal(extractFile(xlsx.attachment, 'table.xlsx').sheets?.[0]?.rows[1]?.[1], '2');
  const csv = convertFile(xlsx.attachment, 'table.xlsx', 'csv');
  assert.deepEqual(parseCsv(csv.attachment.toString()), [
    ['Name', 'Count'],
    ['One', '2'],
  ]);
  const docx = convertFile(Buffer.from('hello\nworld'), 'notes.txt', 'docx');
  assert.match(extractFile(docx.attachment, 'file.docx').text, /hello\nworld/);
  assert.throws(() => convertFile(Buffer.from('text'), 'text.txt', 'csv'), /tabular/);
  const txt = convertFile(Buffer.from('x'.repeat(FILE_LIMITS.textCharacters + 1)), 'large.txt', 'txt');
  assert.equal(txt.attachment.length, FILE_LIMITS.textCharacters);
  assert.match(txt.notice!, /truncated/);
  const manySheets = createXlsx({
    sheets: [
      { name: 'One', rows: [['header'], ['one']] },
      { name: 'Two', rows: [['header'], ['two']] },
    ],
  });
  assert.match(convertFile(manySheets.attachment, 'book.xlsx', 'csv').notice!, /first worksheet/);
  const longLine = convertFile(Buffer.from('x'.repeat(20000)), 'long.txt', 'docx');
  assert.equal(
    extractFile(longLine.attachment, 'long.docx').text.split('\n').slice(1).join('').length,
    20000,
  );
});
test('XLSX preserves sparse row positions and rejects malformed shared-string indices and duplicate cells', () => {
  const parts = readArchive(createXlsx({ sheets: [{ name: 'Sheet', rows: [[1]] }] }).attachment);
  parts.set(
    'xl/worksheets/sheet1.xml',
    Buffer.from(
      parts
        .get('xl/worksheets/sheet1.xml')!
        .toString()
        .replace('<row r="1">', '<row r="3">')
        .replace('r="A1"', 'r="A3"'),
    ),
  );
  assert.deepEqual(extractFile(repack(parts), 'file.xlsx').sheets?.[0]?.rows, [[], [], [1]]);
  parts.set(
    'xl/worksheets/sheet1.xml',
    Buffer.from(parts.get('xl/worksheets/sheet1.xml')!.toString().replace('<c r="A3">', '<c r="A3" t="s">')),
  );
  assert.throws(() => extractFile(repack(parts), 'file.xlsx'), /shared-string/);
  parts.set(
    'xl/worksheets/sheet1.xml',
    Buffer.from(
      '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row></sheetData></worksheet>',
    ),
  );
  assert.throws(() => extractFile(repack(parts), 'file.xlsx'), /duplicates/);
});
test('worker processing restores Buffer attachments and validates archive entries without filesystem extraction', async () => {
  const output = await runFileJob({ kind: 'docx', input: { paragraphs: [{ text: 'worker result' }] } });
  assert.ok('attachment' in output);
  if ('attachment' in output) {
    assert.ok(Buffer.isBuffer(output.attachment));
    assert.match(extractFile(output.attachment, 'file.docx').text, /worker result/);
  }
  const data = createTextZip([{ name: 'folder/x.txt', text: 'exact' }]).attachment;
  const result = await runFileJob({ kind: 'zip-extract', data, entry: 'folder/x.txt' });
  assert.ok('attachment' in result);
  if ('attachment' in result) {
    assert.equal(result.name, 'x.txt');
    assert.equal(result.attachment.toString(), 'exact');
  }
  await assert.rejects(runFileJob({ kind: 'zip-extract', data, entry: 'absent' }), /not present/);
});
const validatorPath = join(tmpdir(), 'codex-office-validators');
const pythonEnv = { ...process.env, PYTHONPATH: validatorPath };
const independent =
  spawnSync('python', ['-c', 'import openpyxl, docx, pptx'], { env: pythonEnv, windowsHide: true }).status ===
  0;
(independent ? test : test.skip)(
  'independent openpyxl, python-docx and python-pptx readers open generated files with correct content',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-office-test-'));
    try {
      writeFileSync(
        join(directory, 'book.xlsx'),
        createXlsx({
          sheets: [
            {
              name: 'Data',
              rows: [
                ['Label', 'Count'],
                ['=literal', 2],
              ],
              headerRow: true,
            },
          ],
        }).attachment,
      );
      writeFileSync(
        join(directory, 'doc.docx'),
        createDocx({ title: 'Title', paragraphs: [{ text: 'Body' }] }).attachment,
      );
      writeFileSync(
        join(directory, 'slides.pptx'),
        createPptx({
          slides: [
            { title: 'First', bullets: ['Bullet'], notes: 'Speaker note' },
            { title: 'Second', bullets: [] },
          ],
        }).attachment,
      );
      const result = execFileSync(
        'python',
        [
          '-c',
          'import sys,os,openpyxl,docx,pptx; d=sys.argv[1]; w=openpyxl.load_workbook(os.path.join(d,"book.xlsx")); assert w["Data"]["A2"].value=="=literal"; assert w["Data"]["A2"].data_type=="s"; assert w["Data"]["B2"].value==2; assert w["Data"].freeze_panes=="A2"; doc=docx.Document(os.path.join(d,"doc.docx")); assert [p.text for p in doc.paragraphs]==["Title","Body"]; p=pptx.Presentation(os.path.join(d,"slides.pptx")); assert len(p.slides)==2; assert "First" in p.slides[0].shapes[0].text; assert "Speaker note" in p.slides[0].notes_slide.notes_text_frame.text; print("three independent readers passed")',
          directory,
        ],
        { env: pythonEnv, windowsHide: true, timeout: 20000 },
      );
      assert.match(result.toString(), /three independent readers passed/);
    } finally {
      if (relative(tmpdir(), directory).startsWith('discord-office-test-'))
        rmSync(directory, { recursive: true, force: true });
    }
  },
);
