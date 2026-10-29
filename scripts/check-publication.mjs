import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// Inspect exactly Git's publishable snapshot. Never print a matching credential.
const git = (...args) => execFileSync('git', args, { windowsHide: true, maxBuffer: 32 * 1048576 });
const staged = git('ls-files', '-z').toString().split('\0').filter(Boolean);
const files = staged.length
  ? staged
  : git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean);
const blobs = new Map();
if (staged.length) {
  const entries = git('ls-files', '--stage', '-z')
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^\d+ ([a-f0-9]{40,64}) 0\t(.+)$/s.exec(line);
      if (!match) throw new Error('Resolve index conflicts before publication.');
      return { sha: match[1], path: match[2] };
    });
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    input: entries.map((entry) => entry.sha).join('\n') + '\n',
    windowsHide: true,
    maxBuffer: 32 * 1048576,
  });
  let offset = 0;
  for (const entry of entries) {
    const end = batch.indexOf(10, offset),
      header = batch.subarray(offset, end).toString();
    const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.sha) throw new Error('Unsupported publication object.');
    const size = Number(match[2]);
    blobs.set(entry.path, batch.subarray(end + 1, end + 1 + size));
    offset = end + size + 2;
  }
}
const findings = [];
const report = (path, category, text = '', offset = 0) =>
  findings.push({ path, category, line: text.slice(0, offset).split('\n').length });
const forbiddenPath =
  /(?:^|\/)(?:node_modules|\.git|\.cache|\.tools|data|logs|backups|coverage|dist|releases|\.vscode|\.idea)(?:\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))|\.(?:pem|key|p12|pfx|jks|keystore|sqlite(?:3)?(?:-wal|-shm)?|db(?:-wal|-shm)?|wav|pcm|mp3|ogg|flac|m4a|mp4|webm|zip|7z|bak|backup)$/i;
const knownSecrets = [];
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value.length >= 12 && !/^(?:YOUR_|your-|replace|changeme|example)/i.test(value))
      knownSecrets.push(value);
  }
}
const patterns = [
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['discord-token', /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];
const redactionFixture = ['sk-', 'proj-', 'abcdefghijklmnopqrstuv0123456789'].join('');
for (const path of files) {
  if (forbiddenPath.test(path) || (path.startsWith('config/') && !path.endsWith('.example.json')))
    report(path, 'private-runtime-path');
  const bytes = staged.length ? blobs.get(path) : readFileSync(path);
  const text = bytes.toString('utf8');
  for (const value of knownSecrets) {
    const offset = text.indexOf(value);
    if (offset >= 0) report(path, 'local-credential-value', text, offset);
  }
  if (bytes.includes(0)) continue;
  for (const [category, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (path === 'test/operations.test.ts' && match[0] === redactionFixture) continue;
      report(path, category, text, match.index);
    }
  }
  const localPath = /[A-Za-z]:[\\/]Users[\\/](?!Public\b|example\b|username\b|you\b)[^\\/\s"']+/gi;
  for (const match of text.matchAll(localPath)) report(path, 'personal-home-path', text, match.index);
}
if (findings.length) {
  console.error(JSON.stringify({ publication: 'blocked', findings }, null, 2));
  process.exitCode = 1;
} else
  console.log(
    `PASS publication guard: ${files.length} Git source files; no private runtime paths or recognized credentials.`,
  );
