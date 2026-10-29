import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';
import { PROJECT_ROOT } from '../src/core/paths.js';
import { OPTIONAL_INTEGRATION_FIELDS, type IntegrationField } from '../src/integrations/provider-catalog.js';
import { ADDITIONAL_SERVICE_FIELDS } from '../src/service-fields.js';

export async function configureEnvironment(
  root = PROJECT_ROOT,
  local = true,
  fields: readonly IntegrationField[] = [...OPTIONAL_INTEGRATION_FIELDS, ...ADDITIONAL_SERVICE_FIELDS],
) {
  const template = join(root, '.env.example'),
    oldTemplate = await readFile(template, 'utf8'),
    base = oldTemplate.split('\n# Optional service integrations')[0]!.trimEnd();
  const known = new Set(Object.keys(parse(base))),
    rows: string[] = [
      '',
      '',
      '# Optional service integrations — blank credentials keep each service unavailable.',
      '# Restart after changing configuration. Public services/OAuth still require their provider-side grants.',
    ];
  for (const field of fields) {
    if (known.has(field.name)) continue;
    known.add(field.name);
    rows.push('', `# ${field.provider}: ${field.description}`, `${field.name}=`);
  }
  await writeFile(template, base + rows.join('\n') + '\n');
  if (!local) return { added: 0 };
  const path = join(root, '.env');
  let original = '';
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1048576)
      throw new Error('Local environment target must be an ordinary file under1MiB.');
    original = await readFile(path, 'utf8');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const existing = new Set(Object.keys(parse(original))),
    missing = Object.entries(parse(await readFile(template, 'utf8'))).filter(([name]) => !existing.has(name));
  if (!missing.length) return { added: 0 };
  const additions =
    [
      '',
      '',
      '# Optional configuration added by setup. Existing values are preserved.',
      ...missing.flatMap(([name, value]) => {
        const definition = fields.find((field) => field.name === name);
        return [...(definition ? [`# ${definition.description}`] : []), `${name}=${value}`];
      }),
    ].join('\n') + '\n';
  const temporary = join(root, `.env.pending-${randomBytes(8).toString('hex')}`);
  try {
    await writeFile(temporary, original + additions, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { added: missing.length };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await configureEnvironment();
  console.log(
    `Configuration templates updated; appended ${result.added} missing fields to .env without replacing existing values.`,
  );
}
