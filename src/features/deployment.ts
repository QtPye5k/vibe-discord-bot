import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup } from 'node:sqlite';
import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { freshContext } from '../core/permissions.js';
import { UserError } from '../core/errors.js';

const releaseId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({
  version: z.literal(1),
  id: releaseId,
  entry: z.literal('dist/main.js'),
  files: z.record(z.string(), hashSchema),
  databaseSchemaVersion: z.literal(1),
});
const selectionSchema = z.strictObject({ id: releaseId, manifestHash: hashSchema });
const pointerSchema = z.strictObject({
  version: z.literal(1),
  current: selectionSchema,
  previous: selectionSchema.nullable(),
  generation: z.number().int().nonnegative(),
  activatedAt: z.number().int().nonnegative(),
  backupSnapshot: z
    .strictObject({ file: z.string().regex(/^[a-z0-9_-]+\.sqlite$/), sha256: hashSchema })
    .optional(),
});
export type DeploymentPointer = z.infer<typeof pointerSchema>;
export interface VerifiedRelease {
  id: string;
  manifestHash: string;
  entry: string;
  directory: string;
  files: number;
  databaseSchemaVersion: 1;
}
function inside(root: string, target: string) {
  const rel = relative(root, target);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export async function hashReleaseFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
/** Supervisor and bot use the same verifier. Local operators must make approved release directories immutable. */
export async function verifyRelease(
  releasesDirectory: string,
  requestedId: string,
  expectedHash?: string,
): Promise<VerifiedRelease> {
  releaseId.parse(requestedId);
  const root = await realpath(releasesDirectory),
    directory = await realpath(join(root, requestedId));
  if (!inside(root, directory))
    throw new UserError('Release directory must stay inside the configured releases root.');
  const manifestPath = await realpath(join(directory, 'release.json'));
  if (!inside(directory, manifestPath) || (await stat(manifestPath)).size > 262144)
    throw new UserError('Invalid release manifest path or size.');
  const raw = await readFile(manifestPath);
  if (raw.length > 262144) throw new UserError('Release manifest exceeds 256 KiB.');
  const manifestHash = createHash('sha256').update(raw).digest('hex');
  if (expectedHash && manifestHash !== expectedHash)
    throw new UserError('Release manifest changed. Review its current hash before activation.');
  const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8'))),
    paths = Object.entries(manifest.files);
  if (
    manifest.id !== requestedId ||
    paths.length < 1 ||
    paths.length > 4096 ||
    !manifest.files[manifest.entry]
  )
    throw new UserError('The release manifest ID, entry or file count is invalid.');
  let total = 0;
  for (const [file, expected] of paths) {
    if (
      file.includes('\\') ||
      file.split('/').some((part) => !part || part === '.' || part === '..') ||
      isAbsolute(file) ||
      !file.startsWith('dist/') ||
      !/\.(?:js|json|css|html|map|wasm|png|svg|woff2?)$/i.test(file)
    )
      throw new UserError('Release manifests may contain only supported built files under dist/.');
    const path = await realpath(join(directory, file));
    if (!inside(directory, path)) throw new UserError('A release file escapes its approved directory.');
    const info = await stat(path);
    total += info.size;
    if (!info.isFile() || info.size > 67108864 || total > 536870912)
      throw new UserError('Release exceeds the built-file size limits.');
    if ((await hashReleaseFile(path)) !== expected)
      throw new UserError(`Release file hash mismatch: ${file}`);
  }
  return {
    id: manifest.id,
    manifestHash,
    entry: resolve(directory, manifest.entry),
    directory,
    files: paths.length,
    databaseSchemaVersion: manifest.databaseSchemaVersion,
  };
}
export async function readDeploymentPointer(activeFile: string): Promise<DeploymentPointer | undefined> {
  try {
    const info = await stat(activeFile);
    if (!info.isFile() || info.size > 4096) throw new UserError('Invalid active deployment pointer.');
    return pointerSchema.parse(JSON.parse(await readFile(activeFile, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
/** Retain only this service's generated snapshots; operator backups with other names are untouched. */
export async function pruneDeploymentBackups(activeFile: string): Promise<void> {
  const directory = join(dirname(activeFile), 'backups'),
    current = (await readDeploymentPointer(activeFile))?.backupSnapshot?.file;
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const generated = files
    .filter((file) => /^deployment_\d{13}_[a-f0-9]{12}\.sqlite$/.test(file))
    .sort()
    .reverse();
  const retained = new Set(generated.slice(0, 20));
  if (current) retained.add(current);
  for (const file of generated) if (!retained.has(file)) await rm(join(directory, file), { force: true });
}
export interface DeploymentOptions {
  releasesDirectory?: string;
  activeFile?: string;
  operatorIds: readonly string[];
  canRestart?: () => boolean;
  restart?: () => void | Promise<void>;
}
export function createDeploymentService(options: DeploymentOptions) {
  let changing = false;
  const configured = () => Boolean(options.releasesDirectory && options.activeFile);
  const available = () => configured() && (options.canRestart?.() ?? false) && Boolean(options.restart);
  function operator(ctx: ActionContext) {
    if (!options.operatorIds.includes(ctx.member.id) || !ctx.member.permissions.has(P.Administrator))
      throw new UserError(
        'This action requires a configured host operator with current server Administrator permission.',
      );
  }
  function authorized(ctx: ActionContext, rollback: boolean) {
    operator(ctx);
    const policy = ctx.store.get<{ enabled: boolean; roleIds: string[]; channelIds: string[] }>(
      'core.actionPolicies',
      `${ctx.guild.id}:deployment.${rollback ? 'rollback' : 'activate'}`,
    );
    if (
      policy &&
      (!policy.enabled ||
        (policy.roleIds.length && !policy.roleIds.some((id) => ctx.member.roles.cache.has(id))) ||
        (policy.channelIds.length && !policy.channelIds.includes(ctx.channelId)))
    )
      throw new UserError('The deployment action policy changed.');
    if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('owner'))
      throw new UserError('Host operator actions are disabled.');
  }
  async function activate(
    ctx: ActionContext,
    selected: { id: string; manifestHash: string },
    rollback: boolean,
  ) {
    operator(ctx);
    if (!available())
      throw new UserError('Approved releases require configured paths and the controlled supervisor.');
    if (changing) throw new UserError('A deployment change is already in progress.');
    changing = true;
    try {
      const initial = await readDeploymentPointer(options.activeFile!),
        prior = JSON.stringify(initial);
      if (
        rollback &&
        (!initial?.previous ||
          initial.previous.id !== selected.id ||
          initial.previous.manifestHash !== selected.manifestHash)
      )
        throw new UserError('Rollback must select the exact current previous release.');
      if (initial?.current.id === selected.id && initial.current.manifestHash === selected.manifestHash)
        throw new UserError('This release is already selected.');
      await verifyRelease(options.releasesDirectory!, selected.id, selected.manifestHash);
      const directory = join(dirname(options.activeFile!), 'backups');
      await mkdir(directory, { recursive: true });
      const backupFile = `deployment_${Date.now()}_${randomBytes(6).toString('hex')}.sqlite`,
        backupPath = join(directory, backupFile);
      await backup(ctx.store.db, backupPath);
      const backupHash = await hashReleaseFile(backupPath);
      ctx = await freshContext(ctx);
      authorized(ctx, rollback);
      if (!available() || JSON.stringify(await readDeploymentPointer(options.activeFile!)) !== prior)
        throw new UserError('The deployment pointer or supervisor availability changed. Review again.');
      await verifyRelease(options.releasesDirectory!, selected.id, selected.manifestHash);
      ctx = await freshContext(ctx);
      authorized(ctx, rollback);
      if (!available() || JSON.stringify(await readDeploymentPointer(options.activeFile!)) !== prior)
        throw new UserError('The deployment pointer changed during final verification.');
      const next: DeploymentPointer = {
        version: 1,
        current: selected,
        previous: initial?.current ?? null,
        generation: (initial?.generation ?? 0) + 1,
        activatedAt: Date.now(),
        backupSnapshot: { file: backupFile, sha256: backupHash },
      };
      await mkdir(dirname(options.activeFile!), { recursive: true });
      const temporary = `${options.activeFile!}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, options.activeFile!);
      } finally {
        await rm(temporary, { force: true });
      }
      ctx.store.set('deployment.history', `${Date.now()}:${randomBytes(4).toString('hex')}`, {
        ...next,
        userId: ctx.member.id,
        guildId: ctx.guild.id,
        rollback,
      });
      for (const row of ctx.store.list('deployment.history').slice(0, -100))
        ctx.store.delete('deployment.history', row.key);
      try {
        await options.restart!();
      } catch {
        throw new UserError(
          'The release pointer was selected, but restart could not be scheduled. Use the host supervisor and inspect deployment.status before retrying.',
        );
      }
      return {
        selected,
        generation: next.generation,
        restartScheduled: true,
        backupSnapshot: next.backupSnapshot,
        databaseRestored: false,
      };
    } finally {
      try {
        await pruneDeploymentBackups(options.activeFile!);
      } catch {
        /* Retention must not change the reviewed activation outcome. */
      }
      changing = false;
    }
  }
  return {
    available,
    registerActions(registry: ActionRegistry) {
      const base = {
        category: 'owner',
        userPermissions: [P.Administrator],
        botPermissions: [],
        risk: 'read' as const,
        available: configured,
        unavailableReason:
          'Set DEPLOYMENT_RELEASES_DIRECTORY and DEPLOYMENT_ACTIVE_FILE; activation additionally requires the controlled supervisor.',
      };
      registry.register({
        ...base,
        id: 'deployment.status',
        description:
          'Inspect the current/previous approved release selections and the pre-activation SQLite backup checksum. Rollback switches code only.',
        schema: z.strictObject({}),
        execute: async (ctx) => {
          operator(ctx);
          return { pointer: await readDeploymentPointer(options.activeFile!), canActivate: available() };
        },
      });
      registry.register({
        ...base,
        id: 'deployment.releases',
        description:
          'Verify and list up to 50 operator-staged immutable built releases and exact manifest hashes for review.',
        schema: z.strictObject({}),
        execute: async (ctx) => {
          operator(ctx);
          const rows = [];
          for (const entry of (await readdir(options.releasesDirectory!, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && releaseId.safeParse(entry.name).success)
            .slice(0, 50)) {
            try {
              const value = await verifyRelease(options.releasesDirectory!, entry.name);
              rows.push({
                id: value.id,
                manifestHash: value.manifestHash,
                files: value.files,
                databaseSchemaVersion: value.databaseSchemaVersion,
              });
            } catch {
              rows.push({ id: entry.name, invalid: true });
            }
          }
          return rows;
        },
      });
      for (const rollback of [false, true])
        registry.register({
          ...base,
          available,
          risk: 'destructive',
          id: `deployment.${rollback ? 'rollback' : 'activate'}`,
          description: rollback
            ? 'Confirm the exact previous immutable release hash, take a consistent SQLite snapshot, atomically select its code and request a controlled restart. Current database content is preserved.'
            : 'Confirm an operator-staged release ID and immutable manifest hash, verify every built file, take a consistent SQLite snapshot, atomically select code and request a controlled restart. Schema version must remain 1.',
          schema: selectionSchema,
          execute: (ctx, input) => activate(ctx, input, rollback),
        });
    },
  };
}
