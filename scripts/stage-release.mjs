import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Host-only preparation: immutable built code is reviewed before Discord can select its manifest hash. */
export async function stageRelease(sourceDirectory, releasesDirectory, id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
    throw new Error('Use a lowercase release ID of 1–64 letters, digits, underscores or hyphens.');
  const source = resolve(sourceDirectory),
    destination = resolve(releasesDirectory, id),
    rel = relative(join(source, 'dist'), destination);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)))
    throw new Error('Stage releases outside the built dist directory.');
  const files = {};
  let bytes = 0;
  async function scan(directory, prefix = 'dist') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isSymbolicLink()) throw new Error('Built releases cannot contain symlinks.');
      const file = `${prefix}/${entry.name}`,
        path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path, file);
      else {
        if (!entry.isFile() || !/\.(?:js|json|css|html|map|wasm|png|svg|woff2?)$/i.test(file))
          throw new Error(`Unsupported built file: ${file}`);
        const info = await stat(path);
        bytes += info.size;
        if (info.size > 67108864 || bytes > 536870912 || Object.keys(files).length >= 4096)
          throw new Error('Built release exceeds size/file limits.');
        files[file] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
      }
    }
  }
  await scan(join(source, 'dist'));
  if (!files['dist/main.js']) throw new Error('Build the project first; dist/main.js is missing.');
  // mkdir without recursive prevents silently overwriting an existing reviewed release.
  await mkdir(resolve(releasesDirectory), { recursive: true });
  await mkdir(destination);
  await cp(join(source, 'dist'), join(destination, 'dist'), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const manifest = { version: 1, id, entry: 'dist/main.js', files, databaseSchemaVersion: 1 };
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(destination, 'release.json'), raw, { flag: 'wx', mode: 0o600 });
  return {
    id,
    manifestHash: createHash('sha256').update(raw).digest('hex'),
    files: Object.keys(files).length,
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [source, root, id] = process.argv.slice(2);
  if (!source || !root || !id)
    throw new Error(
      'Usage: node scripts/stage-release.mjs <built-project-directory> <releases-directory> <release-id>',
    );
  process.stdout.write(JSON.stringify(await stageRelease(source, root, id)) + '\n');
}
