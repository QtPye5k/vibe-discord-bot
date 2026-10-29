import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { ActionRegistry } from './registry.js';
import type { Action } from './types.js';
import { UserError } from './errors.js';

export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  actions: number;
}
export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  cleanup(): Promise<{ failures: { id: string; error: string }[] }>;
}
export interface PluginApi {
  readonly z: typeof z;
  readonly permissions: typeof PermissionFlagsBits;
}
export interface LocalPlugin {
  name: string;
  version: string;
  register(
    registry: ActionRegistry,
    api: PluginApi,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  cleanup?(): void | Promise<void>;
}
const pluginId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/)
  .refine((value) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value), 'Reserved device name');
const moduleMetadata = z.object({
  name: pluginId,
  version: z
    .string()
    .max(100)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
});
const permissions = Object.freeze({ ...PermissionFlagsBits });
const api: PluginApi = Object.freeze({ z, permissions });
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};
const errorName = (error: unknown) => (error instanceof Error ? error.name.slice(0, 80) : 'Error');
/** Loads only explicitly configured local JavaScript. Plugin code runs with full process trust, not in a sandbox. */
export async function loadPlugins(
  registry: ActionRegistry,
  projectRoot: string,
  rawIds: readonly string[],
): Promise<PluginLoadResult> {
  const ids = z
    .array(pluginId)
    .max(20)
    .refine((values) => new Set(values).size === values.length, 'Plugin IDs must be unique')
    .parse(rawIds);
  const cleanups: { id: string; fn: () => void | Promise<void> }[] = [];
  let cleanupPromise: Promise<{ failures: { id: string; error: string }[] }> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      const failures: { id: string; error: string }[] = [];
      for (const item of [...cleanups].reverse())
        try {
          await item.fn();
        } catch (error) {
          failures.push({ id: item.id, error: errorName(error) });
        }
      return { failures };
    })());
  if (!ids.length) return { plugins: [], cleanup };
  let root: string, pluginRoot: string;
  try {
    root = await realpath(resolve(projectRoot));
    pluginRoot = await realpath(resolve(root, 'plugins'));
  } catch {
    throw new UserError('Configured local plugins require an existing project/plugins directory.');
  }
  if (!within(root, pluginRoot) || !(await stat(pluginRoot)).isDirectory())
    throw new UserError('The plugins directory must resolve inside the configured project root.');
  const staged = new ActionRegistry(),
    plugins: LoadedPlugin[] = [];
  let loading = '';
  try {
    for (const id of ids) {
      loading = id;
      const directory = await realpath(resolve(pluginRoot, id));
      if (!within(pluginRoot, directory) || !(await stat(directory)).isDirectory())
        throw new UserError('Plugin directory escapes the configured plugins root.');
      const entry = await realpath(resolve(directory, 'index.js'));
      if (!within(directory, entry) || !within(pluginRoot, entry) || !(await stat(entry)).isFile())
        throw new UserError('Plugin entry must be a regular file inside its own configured directory.');
      const imported: unknown = await import(pathToFileURL(entry).href);
      const namespace = imported as Record<string, unknown>,
        candidate = (namespace.default ?? namespace) as Partial<LocalPlugin>;
      const metadata = moduleMetadata.parse(candidate);
      if (
        metadata.name !== id ||
        typeof candidate.register !== 'function' ||
        (candidate.cleanup !== undefined && typeof candidate.cleanup !== 'function')
      )
        throw new UserError('Plugin metadata or registration contract is invalid.');
      if (candidate.cleanup) cleanups.push({ id, fn: () => candidate.cleanup!() });
      const before = staged.list().length;
      const returned = await candidate.register(staged, api);
      if (returned !== undefined && typeof returned !== 'function')
        throw new UserError('Plugin registration may return only an optional cleanup function.');
      if (returned && returned !== candidate.cleanup) cleanups.push({ id, fn: returned });
      const count = staged.list().length - before;
      if (count > 100 || staged.list().length > 500)
        throw new UserError('Plugin action limit exceeded (100 per plugin / 500 total).');
      plugins.push({ id, name: metadata.name, version: metadata.version, actions: count });
    }
    const existing = new Set(registry.list().map((action) => action.id));
    const actions = staged.list().map((action) => validateAction(action));
    for (const action of actions)
      if (existing.has(action.id))
        throw new UserError('Plugin action collides with an existing registered action.');
    // No awaits between complete validation and commit. Failed imports/registrations never mutate the main catalog.
    for (const action of actions) registry.register(action);
    return { plugins, cleanup };
  } catch (error) {
    await cleanup();
    throw new UserError(
      `Local plugin ${loading || 'configuration'} failed to load (${errorName(error)}). No staged plugin actions were installed.`,
    );
  }
}
function validateAction(action: Action): Action {
  const value = {
    id: action.id,
    description: action.description,
    category: action.category,
    schema: action.schema,
    userPermissions: [...(action.userPermissions ?? [])],
    botPermissions: [...(action.botPermissions ?? [])],
    risk: action.risk,
    execute: action.execute,
  };
  if (
    !/^[a-z][a-z0-9_.-]{1,63}$/.test(value.id) ||
    typeof value.description !== 'string' ||
    !value.description.trim() ||
    value.description.length > 500 ||
    !/^[a-z][a-z0-9-]{1,31}$/.test(value.category) ||
    !['read', 'write', 'destructive'].includes(value.risk) ||
    !(value.schema instanceof z.ZodType) ||
    typeof value.execute !== 'function' ||
    !Array.isArray(action.userPermissions) ||
    !Array.isArray(action.botPermissions) ||
    value.userPermissions.length > 64 ||
    value.botPermissions.length > 64 ||
    [...value.userPermissions, ...value.botPermissions].some(
      (permission) => typeof permission !== 'bigint' || permission < 0n,
    )
  )
    throw new UserError('Invalid plugin action contract.');
  return value;
}
