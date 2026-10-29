import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** src/core and dist/core have the same depth, so source and packaged entrypoints share a root. */
export const CODE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
/** A supervised release keeps persistent configuration/data in the original installation. */
export const PROJECT_ROOT = process.env.BOT_WORKSPACE_ROOT
  ? resolve(process.env.BOT_WORKSPACE_ROOT)
  : CODE_ROOT;
export const projectPath = (...parts: string[]): string => resolve(PROJECT_ROOT, ...parts);
export const codePath = (...parts: string[]): string => resolve(CODE_ROOT, ...parts);
