import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { freshContext } from '../core/permissions.js';
import { UserError } from '../core/errors.js';

const parameter = z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  nullable: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(4000).default(4000),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
});
const querySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  description: z.string().min(1).max(500),
  sql: z.string().min(1).max(20000),
  parameters: z.array(parameter).max(20).default([]),
  rowLimit: z.number().int().min(1).max(1000).default(100),
  roleIds: z
    .array(z.string().regex(/^\d{17,20}$/))
    .max(20)
    .default([]),
});
const catalogSchema = z.strictObject({ version: z.literal(1), queries: z.array(querySchema).max(100) });
type ApprovedQuery = z.infer<typeof querySchema>;
type DatabasePool = Pick<Pool, 'connect' | 'end' | 'on'>;
export interface ExternalDatabaseOptions {
  url?: string;
  queriesFile?: string;
  /** Tests may inject a real-driver-shaped pool; production always uses node-postgres. */
  createPool?: () => DatabasePool | Promise<DatabasePool>;
}

/** Lex only enough to reject multi-statement and visibly mutating allowlist mistakes.
 * This is not a SQL sandbox: the operator must use a restricted read-only database role. */
export function validateReadQuery(sql: string): void {
  let plain = '',
    index = 0;
  while (index < sql.length) {
    const tail = sql.slice(index);
    if (tail.startsWith('--')) {
      const end = sql.indexOf('\n', index + 2);
      index = end < 0 ? sql.length : end;
      plain += ' ';
      continue;
    }
    if (tail.startsWith('/*')) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) {
          depth++;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth--;
          index += 2;
        } else index++;
      }
      if (depth) throw new UserError('Unterminated SQL comment.');
      plain += ' ';
      continue;
    }
    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index++];
      let closed = false;
      while (index < sql.length) {
        if (sql[index++] === quote) {
          if (sql[index] === quote) {
            index++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) throw new UserError('Unterminated SQL quoted value.');
      plain += ' value ';
      continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(tail)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, index + dollar.length);
      if (end < 0) throw new UserError('Unterminated SQL dollar string.');
      index = end + dollar.length;
      plain += ' value ';
      continue;
    }
    plain += sql[index++];
  }
  if (
    !/^\s*(?:SELECT|WITH)\b/i.test(plain) ||
    plain.includes(';') ||
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|SET|RESET|INTO|LOCK|VACUUM|ANALYZE|PG_SLEEP|PG_ADVISORY_LOCK|PG_ADVISORY_XACT_LOCK|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|SET_CONFIG|DBLINK_EXEC|LO_IMPORT|LO_EXPORT)\b/i.test(
      plain,
    )
  )
    throw new UserError(
      'Approved SQL must be one read-only SELECT/WITH statement without a terminating semicolon.',
    );
}

function catalog(path: string) {
  if (!path || statSync(path).size > 65536)
    throw new UserError('The approved query file is missing or larger than 64 KiB.');
  const raw = readFileSync(path);
  if (raw.length > 65536) throw new UserError('Approved query file exceeds 64 KiB.');
  const value = catalogSchema.parse(JSON.parse(raw.toString('utf8')));
  if (new Set(value.queries.map((query) => query.id)).size !== value.queries.length)
    throw new UserError('Approved query IDs must be unique.');
  for (const query of value.queries) validateReadQuery(query.sql);
  return { ...value, hash: createHash('sha256').update(raw).digest('hex') };
}
function allowed(ctx: ActionContext, query: ApprovedQuery) {
  if (
    !ctx.member.permissions.has(P.ManageGuild) ||
    (query.roleIds.length && !query.roleIds.some((roleId) => ctx.member.roles.cache.has(roleId)))
  )
    throw new UserError('Current server management permission and the approved query role are required.');
  const policy = ctx.store.get<{ enabled: boolean; roleIds: string[]; channelIds: string[] }>(
    'core.actionPolicies',
    `${ctx.guild.id}:database.query`,
  );
  if (
    policy &&
    (!policy.enabled ||
      (policy.roleIds.length && !policy.roleIds.some((roleId) => ctx.member.roles.cache.has(roleId))) ||
      (policy.channelIds.length && !policy.channelIds.includes(ctx.channelId)))
  )
    throw new UserError('The current database action policy denies this query.');
  if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('integrations'))
    throw new UserError('Integrations are disabled.');
}
function validateParameters(query: ApprovedQuery, values: (string | number | boolean | null)[]) {
  if (values.length !== query.parameters.length)
    throw new UserError(`This query requires ${query.parameters.length} parameters.`);
  for (let index = 0; index < values.length; index++) {
    const value = values[index],
      rule = query.parameters[index]!;
    if (value === null && rule.nullable) continue;
    if (
      value === null ||
      (rule.type === 'integer'
        ? typeof value !== 'number' || !Number.isSafeInteger(value)
        : typeof value !== rule.type)
    )
      throw new UserError(`Parameter ${index + 1} must be ${rule.type}${rule.nullable ? ' or null' : ''}.`);
    if (typeof value === 'string' && value.length > rule.maxLength)
      throw new UserError(`Parameter ${index + 1} is too long.`);
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) ||
        (rule.min !== undefined && value < rule.min) ||
        (rule.max !== undefined && value > rule.max))
    )
      throw new UserError(`Parameter ${index + 1} is outside its approved range.`);
  }
}
export function createExternalDatabaseService(options: ExternalDatabaseOptions) {
  let poolPromise: Promise<DatabasePool> | undefined;
  const available = () => Boolean(options.url?.trim() && options.queriesFile?.trim());
  const pool = () =>
    (poolPromise ??= Promise.resolve()
      .then(async () => {
        const value = options.createPool
          ? await options.createPool()
          : new (await import('pg')).Pool({
              connectionString: options.url,
              max: 2,
              connectionTimeoutMillis: 5000,
              statement_timeout: 5000,
              query_timeout: 6000,
              lock_timeout: 1000,
              idle_in_transaction_session_timeout: 7000,
              application_name: 'discord-unified-approved-reads',
            });
        value.on('error', () => {
          /* Pool errors must not expose connection URLs or become unhandled events. */
        });
        return value;
      })
      .catch((error) => {
        poolPromise = undefined;
        throw error;
      }));
  return {
    available,
    registerActions(registry: ActionRegistry) {
      const base = {
        category: 'integrations',
        risk: 'read' as const,
        userPermissions: [P.ManageGuild],
        botPermissions: [],
        available,
        unavailableReason:
          'Set EXTERNAL_DATABASE_URL and EXTERNAL_DATABASE_QUERIES_FILE to enable approved PostgreSQL reads.',
      };
      registry.register({
        ...base,
        id: 'database.queries',
        description:
          'List operator-approved parameterized PostgreSQL reads available to your current server role. SQL and connection credentials are never accepted from Discord.',
        schema: z.strictObject({}),
        execute: (ctx) =>
          catalog(options.queriesFile!)
            .queries.filter((query) => {
              try {
                allowed(ctx, query);
                return true;
              } catch {
                return false;
              }
            })
            .map(({ id, description, parameters, rowLimit }) => ({ id, description, parameters, rowLimit })),
      });
      registry.register({
        ...base,
        auditIdentity: 'private',
        id: 'database.query',
        description:
          'Run one named operator-approved query in a read-only transaction with parameter binding, fresh role checks, deadlines and response limits.',
        schema: z.strictObject({
          id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
          parameters: z
            .array(z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]))
            .max(20)
            .default([]),
        }),
        execute: async (initial, input) => {
          const approved = catalog(options.queriesFile!),
            query = approved.queries.find((query) => query.id === input.id);
          if (!query) throw new UserError('This query is not approved.');
          validateParameters(query, input.parameters);
          let ctx = await freshContext(initial);
          allowed(ctx, query);
          let client: PoolClient | undefined,
            committed = false,
            destroy = false;
          try {
            client = await (await pool()).connect();
            await client.query('BEGIN READ ONLY');
            await client.query("SET LOCAL statement_timeout = '5s'");
            await client.query("SET LOCAL lock_timeout = '1s'");
            ctx = await freshContext(ctx);
            allowed(ctx, query);
            if (catalog(options.queriesFile!).hash !== approved.hash)
              throw new UserError('The approved query catalog changed; request the query again.');
            const result = await client.query<{ payload: string | null }>({
              text: `SELECT CASE WHEN octet_length(row_to_json(approved_row)::text)<=65536 THEN row_to_json(approved_row)::text ELSE NULL END AS payload FROM (${query.sql}) AS approved_row LIMIT ${query.rowLimit + 1}`,
              values: input.parameters,
            });
            await client.query('COMMIT');
            committed = true;
            ctx = await freshContext(ctx);
            allowed(ctx, query);
            if (catalog(options.queriesFile!).hash !== approved.hash)
              throw new UserError('Query access changed while it ran; the result was withheld.');
            const rows: unknown[] = [];
            let bytes = 0;
            for (const row of result.rows.slice(0, query.rowLimit)) {
              if (row.payload === null || Buffer.byteLength(row.payload) > 65536)
                throw new UserError('A query row exceeds 64 KiB; narrow the approved query.');
              bytes += Buffer.byteLength(row.payload);
              if (bytes > 1048576)
                throw new UserError('Query output exceeds 1 MiB; narrow the approved query.');
              rows.push(JSON.parse(row.payload));
            }
            return { id: query.id, rows, count: rows.length, truncated: result.rows.length > query.rowLimit };
          } catch (error) {
            if (client && !committed)
              try {
                await client.query('ROLLBACK');
              } catch {
                destroy = true;
              }
            if (error instanceof UserError) throw error;
            throw new UserError(
              'The approved database read failed or timed out. Check the host database configuration and restricted role.',
            );
          } finally {
            client?.release(destroy);
          }
        },
      });
    },
    async close() {
      const pending = poolPromise;
      poolPromise = undefined;
      if (pending) await (await pending).end();
    },
  };
}
