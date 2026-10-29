import { createHash } from 'node:crypto';
import { ApplicationCommandType, Routes, type REST } from 'discord.js';
import type { Config } from '../config.js';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import { commandDefinitions, personalCommandNames } from './commands.js';

type Definition = Record<string, unknown>;
type CommandConfig = Pick<Config, 'guildIds' | 'enableUserInstall' | 'optionalEnvironment'>;
export interface CommandSyncOptions {
  applicationId: string;
  config: CommandConfig;
  rest: Pick<REST, 'get' | 'put'>;
  store: Pick<Store, 'get' | 'set' | 'list'>;
  logger: Pick<Logger, 'info'>;
  /** A ready Gateway client already knows its installed guilds; REST-only publication discovers them. */
  installedGuildIds?: readonly string[];
}

const localization = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : {};
function option(raw: Definition): Definition {
  const normalized: Definition = {
    type: raw.type,
    name: raw.name,
    description: raw.description ?? '',
    name_localizations: localization(raw.name_localizations),
    description_localizations: localization(raw.description_localizations),
    required: raw.required ?? false,
    autocomplete: raw.autocomplete ?? false,
    options: Array.isArray(raw.options) ? raw.options.map((value) => option(value as Definition)) : [],
    choices: Array.isArray(raw.choices)
      ? raw.choices.map((value) => {
          const choice = value as Definition;
          return {
            name: choice.name,
            value: choice.value,
            name_localizations: localization(choice.name_localizations),
          };
        })
      : [],
  };
  for (const key of ['min_value', 'max_value', 'min_length', 'max_length'])
    if (raw[key] !== undefined && raw[key] !== null) normalized[key] = raw[key];
  for (const key of ['channel_types', 'file_types'])
    normalized[key] = Array.isArray(raw[key]) ? [...(raw[key] as unknown[])].sort() : [];
  return normalized;
}
/** Discard server IDs/version/default noise, but compare every supported behavior-affecting definition field. */
export function normalizedCommandDefinitions(raw: unknown, global: boolean): Definition[] {
  if (!Array.isArray(raw))
    throw new Error(
      'Discord returned an invalid application-command list. No command changes were accepted.',
    );
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string')
        throw new Error('Discord returned an invalid application command.');
      const value = item as Definition,
        type = value.type ?? ApplicationCommandType.ChatInput;
      const result: Definition = {
        type,
        name: value.name,
        description: value.description ?? '',
        name_localizations: localization(value.name_localizations),
        description_localizations: localization(value.description_localizations),
        default_member_permissions: value.default_member_permissions ?? null,
        nsfw: value.nsfw ?? false,
        options: Array.isArray(value.options) ? value.options.map((item) => option(item as Definition)) : [],
      };
      if (global) {
        result.contexts = Array.isArray(value.contexts) ? [...value.contexts].sort() : null;
        result.integration_types = Array.isArray(value.integration_types)
          ? [...value.integration_types].sort()
          : null;
      }
      if (type === ApplicationCommandType.PrimaryEntryPoint) result.handler = value.handler ?? 1;
      return result;
    })
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

export function desiredCommandScopes(config: CommandConfig): { id: string; body: Definition[] }[] {
  const activities = Boolean(
    config.optionalEnvironment.ACTIVITY_PUBLIC_URL && config.optionalEnvironment.DISCORD_CLIENT_SECRET,
  );
  const body = commandDefinitions({ userInstall: config.enableUserInstall, activities }) as Definition[];
  if (!config.guildIds.length) return [{ id: 'global', body }];
  // Personal commands have one global definition with their native DM/user-install contexts,
  // instead of shadowing the same name with a second guild definition.
  const personal = (value: Definition) =>
    config.enableUserInstall && personalCommandNames.has(String(value.name));
  const scopes = [...new Set(config.guildIds)].map((id) => ({
    id,
    body: body
      .filter((value) => value.type !== ApplicationCommandType.PrimaryEntryPoint && !personal(value))
      .map((value) => {
        const copy = { ...value };
        delete copy.contexts;
        delete copy.integration_types;
        return copy;
      }),
  }));
  // Include an empty global target too: obsolete global commands survive guild overwrites otherwise.
  scopes.push({
    id: 'global',
    body: body.filter((value) => personal(value) || value.type === ApplicationCommandType.PrimaryEntryPoint),
  });
  return scopes;
}

export async function installedCommandGuildIds(rest: Pick<REST, 'get'>): Promise<string[]> {
  const result: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ limit: '200', ...(after ? { after } : {}) });
    const values = await rest.get(Routes.userGuilds(), { query });
    if (
      !Array.isArray(values) ||
      values.some((value) => !value || typeof value !== 'object' || !/^\d{17,20}$/.test(String(value.id)))
    )
      throw new Error('Discord returned an invalid installed-server list.');
    for (const value of values) result.push(String(value.id));
    if (values.length < 200) return [...new Set(result)];
    const next = String(values.at(-1)!.id);
    if (next === after) throw new Error('Discord installed-server pagination did not advance.');
    after = next;
  }
  throw new Error('Installed-server command reconciliation exceeded its 10,000-server bound.');
}

/** Remote state, not a local hash alone, decides whether definitions need publication. */
export async function reconcileApplicationCommands(
  options: CommandSyncOptions,
): Promise<{ checked: number; published: number; removed: number }> {
  const { applicationId, config, rest, store, logger } = options;
  const installed = new Set(options.installedGuildIds ?? (await installedCommandGuildIds(rest)));
  const scopes = desiredCommandScopes(config);
  if (config.guildIds.some((id) => !installed.has(id)))
    throw new Error(
      'A configured command server is not currently installed. Check DISCORD_GUILD_IDS and the bot installation.',
    );
  if (!config.guildIds.length) {
    // Global definitions supersede this application's guild definitions only in installed servers.
    for (const id of installed) scopes.push({ id, body: [] });
  }
  const summary = { checked: 0, published: 0, removed: 0 };
  for (const scope of scopes) {
    const route =
      scope.id === 'global'
        ? Routes.applicationCommands(applicationId)
        : Routes.applicationGuildCommands(applicationId, scope.id);
    const read = () => rest.get(route, { query: new URLSearchParams({ with_localizations: 'true' }) });
    const desired = JSON.stringify(normalizedCommandDefinitions(scope.body, scope.id === 'global'));
    const actual = await read(),
      current = JSON.stringify(normalizedCommandDefinitions(actual, scope.id === 'global'));
    summary.checked++;
    if (current !== desired) {
      await rest.put(route, { body: scope.body });
      const confirmed = JSON.stringify(normalizedCommandDefinitions(await read(), scope.id === 'global'));
      if (confirmed !== desired)
        throw new Error(
          `Discord command verification failed for scope ${scope.id}. Run deploy:commands again after checking the application settings.`,
        );
      summary.published++;
      summary.removed += Math.max(0, (actual as unknown[]).length - scope.body.length);
      logger.info('commands.registered', { scope: scope.id, commands: scope.body.length });
    }
    // This is a successful observation/checkpoint, never authority to skip the next remote check.
    store.set(
      'core.commands',
      `${applicationId}:${scope.id}`,
      createHash('sha256').update(desired).digest('hex'),
    );
  }
  return summary;
}
