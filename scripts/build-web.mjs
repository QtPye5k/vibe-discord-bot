import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [resolve(root, 'web/activity.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['chrome120', 'firefox120', 'safari17'],
  outdir: resolve(root, 'dist/web'),
  legalComments: 'eof',
  sourcemap: false,
  logLevel: 'warning',
});
console.log('Built local Activity SDK bundle and styles.');
