import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, type Zippable } from 'fflate';
import { PROJECT_ROOT, projectPath } from '../src/core/paths.js';

const directories = new Set(['src', 'scripts', 'test', 'docs', 'web', 'config', '.github']);
const rootFiles = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.build.json',
  '.env.example',
  '.gitignore',
  '.dockerignore',
  '.prettierrc.json',
  '.prettierignore',
  'README.md',
  'Dockerfile',
  'compose.yaml',
  'SETUP.cmd',
  'START.cmd',
  'CHECK.cmd',
  'setup.sh',
  'start.sh',
  'check.sh',
]);
const forbidden =
  /(?:^|\/)(?:node_modules|\.git|data|logs|backups|releases|coverage|\.cache|\.tools)(?:\/|$)|(?:^|\/)\.env(?:$|\.(?!example$))/;
export async function portableArchive(
  root = PROJECT_ROOT,
): Promise<{ data: Uint8Array; files: number; bytes: number }> {
  const canonical = await realpath(root),
    entries: Zippable = {},
    manifest: { path: string; bytes: number; sha256: string }[] = [];
  let bytes = 0;
  async function collect(directory: string): Promise<void> {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = resolve(directory, item.name),
        name = relative(canonical, absolute).split(sep).join('/');
      if (forbidden.test(name) || item.isSymbolicLink()) continue;
      if (name.startsWith('config/') && !name.endsWith('.example.json')) continue;
      if (directory === canonical && !directories.has(item.name) && !rootFiles.has(item.name)) continue;
      if (item.isDirectory()) {
        await collect(absolute);
        continue;
      }
      if (!item.isFile()) continue;
      const target = await realpath(absolute),
        part = relative(canonical, target);
      if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`))
        throw new Error('Portable source escapes project root.');
      const info = await stat(target);
      if (info.size > 16 * 1048576 || bytes + info.size > 64 * 1048576 || manifest.length >= 2048)
        throw new Error('Portable source exceeds its reviewed package bounds.');
      const data = await readFile(target);
      bytes += data.length;
      entries[name] = [new Uint8Array(data), { mtime: new Date('2000-01-01T00:00:00Z'), level: 6 }];
      manifest.push({
        path: name,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
    }
  }
  await collect(canonical);
  entries['PORTABLE-MANIFEST.json'] = new TextEncoder().encode(
    JSON.stringify(
      {
        version: 1,
        sourceFiles: manifest,
        excludes: [
          'credentials',
          '.env',
          'runtime database',
          'logs',
          'backups',
          'platform-specific node_modules',
        ],
        setup: 'Run SETUP.cmd on Windows, ./setup.sh on Linux, or docker compose up --build.',
      },
      null,
      2,
    ),
  );
  return { data: zipSync(entries), files: manifest.length, bytes };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await portableArchive();
  await mkdir(projectPath('releases'), { recursive: true });
  const target = projectPath('releases/discord-bot-portable.zip');
  await writeFile(target, result.data);
  console.log(
    `Portable source package: ${target} (${result.files} files, ${result.data.length} compressed bytes). Credentials and user data excluded.`,
  );
}
