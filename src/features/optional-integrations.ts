import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext, Risk } from '../core/types.js';
import type { Store } from '../core/store.js';
import { assertPermissions, freshContext, resolveChannel } from '../core/permissions.js';
import { assertOperator } from '../core/operator.js';
import { UserError } from '../core/errors.js';
import { downloadAttachment } from '../core/files.js';
import { publicUrl } from './integrations.js';
import {
  createCredentials,
  type CredentialOptions,
  type ResolvedCredential,
} from '../integrations/credentials.js';
import { providerHttp, providerJson, safeProviderValue, type ProviderInput } from '../integrations/http.js';
import { integrationStatus } from '../integrations/provider-catalog.js';

export interface OptionalIntegrationsOptions extends CredentialOptions {
  operatorIds?: readonly string[];
}
const empty = z.strictObject({}),
  resource = z.string().min(1).max(256),
  fileId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  uuid = z.string().regex(/^[0-9a-fA-F-]{16,64}$/),
  snowflake = z.string().regex(/^\d{17,20}$/);
const dateTime = z.string().datetime({ offset: true }),
  email = z.string().email().max(254),
  text = z.string().min(1).max(12000),
  prompt = z.string().min(1).max(1000);
const page = z.number().int().min(1).max(1000).default(1),
  limit = z.number().int().min(1).max(50).default(20);
const login = z.string().regex(/^[A-Za-z0-9_]{1,25}$/);
const encode = encodeURIComponent;
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const field = (value: unknown, name: string) => obj(value)[name];
const pick = (value: unknown, names: readonly string[]) =>
  Object.fromEntries(
    names.filter((name) => obj(value)[name] !== undefined).map((name) => [name, obj(value)[name]]),
  );
const summary = (value: unknown, names: readonly string[]) => rows(value).map((row) => pick(row, names));
const publicMedia = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      publicUrl(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use a public HTTPS media URL.');
const watchKinds = z.enum([
  'google-calendar',
  'youtube-uploads',
  'twitch-live',
  'steam-achievements',
  'shopify-products',
  'mastodon-posts',
  'parcels',
  'gitlab-pipelines',
  'github-releases',
  'github-pulls',
  'github-runs',
]);
type WatchKind = z.infer<typeof watchKinds>;
type GoogleWatchBinding =
  { mode: 'owned'; accountId: string; authorizationId: string } | { mode: 'shared'; fingerprint: string };
interface Watch {
  id: string;
  guildId: string;
  authorId: string;
  channelId: string;
  kind: WatchKind;
  source: Record<string, string>;
  intervalSeconds: number;
  enabled: boolean;
  version: string;
  nextAt: number;
  fingerprint?: string;
  data?: unknown;
  attempts: number;
  lastError?: string;
  pending?: { content: string; fingerprint: string; nonce: string; data: unknown };
  googleAuthorization?: GoogleWatchBinding;
}
const sourceKeys: Record<WatchKind, readonly string[]> = {
  'google-calendar': ['calendarId'],
  'youtube-uploads': ['playlistId'],
  'twitch-live': ['login'],
  'steam-achievements': ['steamId', 'appId'],
  'shopify-products': ['query'],
  'mastodon-posts': ['accountId'],
  parcels: ['trackingId'],
  'gitlab-pipelines': ['projectId'],
  'github-releases': ['owner', 'repository'],
  'github-pulls': ['owner', 'repository', 'number'],
  'github-runs': ['owner', 'repository', 'branch'],
};
const watchProvider: Record<WatchKind, string> = {
  'google-calendar': 'google',
  'youtube-uploads': 'youtube',
  'twitch-live': 'twitch',
  'steam-achievements': 'steam',
  'shopify-products': 'commerce',
  'mastodon-posts': 'social',
  parcels: 'parcels',
  'gitlab-pipelines': 'gitlab',
  'github-releases': 'github',
  'github-pulls': 'github',
  'github-runs': 'github',
};
function monitorSignal(kind: WatchKind, value: unknown): unknown {
  switch (kind) {
    case 'google-calendar':
      return rows(value).map((item) => pick(item, ['id', 'status', 'summary', 'start', 'end', 'htmlLink']));
    case 'youtube-uploads':
      return rows(value).map((item) => ({
        id: field(item, 'id'),
        ...pick(field(item, 'snippet'), ['title', 'publishedAt', 'resourceId']),
        ...pick(field(item, 'contentDetails'), ['videoId', 'videoPublishedAt']),
      }));
    case 'twitch-live':
      return summary(value, ['id', 'user_id', 'user_login', 'started_at', 'title']);
    case 'steam-achievements':
      return {
        game: field(value, 'gameName'),
        achievements: summary(field(value, 'achievements'), ['apiname', 'achieved', 'unlocktime', 'name']),
      };
    case 'shopify-products':
      return {
        products: rows(field(value, 'nodes')).map((product) => ({
          ...pick(product, ['id', 'title', 'status', 'onlineStoreUrl', 'totalInventory']),
          variants: summary(field(field(product, 'variants'), 'nodes'), [
            'id',
            'title',
            'price',
            'inventoryQuantity',
          ]),
        })),
      };
    case 'mastodon-posts':
      return summary(value, ['id', 'url', 'created_at', 'visibility']);
    case 'parcels':
      return {
        ...pick(field(value, 'data') ?? value, [
          'id',
          'tag',
          'subtag',
          'aftership_estimated_delivery_date',
          'courier_estimated_delivery_date',
          'latest_estimated_delivery',
        ]),
        checkpointTimes: rows(field(field(value, 'data') ?? value, 'checkpoints')).map((checkpoint) =>
          field(checkpoint, 'checkpoint_time'),
        ),
      };
    case 'gitlab-pipelines':
      return summary(value, ['id', 'status', 'ref', 'sha', 'web_url', 'updated_at']);
    default:
      return value;
  }
}

export function createOptionalIntegrations(options: OptionalIntegrationsOptions) {
  const credentials = createCredentials(options),
    now = options.now ?? Date.now;
  let registry: ActionRegistry | undefined,
    closed = false;
  const operatorIds = options.operatorIds ?? [];
  const execution = new AsyncLocalStorage<{
    actionId: string;
    provider?: string;
    authorization?: ResolvedCredential;
    featureEpoch?: number;
  }>();
  function requireGoogleScope(actionId: string, credential: ResolvedCredential): void {
    if (credential.kind !== 'owned') return;
    const prefix = 'https://www.googleapis.com/auth/';
    let accepted: string[];
    if (
      actionId.startsWith('integration.google-calendar.') ||
      actionId === 'integration.provider-watch.create'
    )
      accepted =
        actionId.endsWith('.events') || actionId === 'integration.provider-watch.create'
          ? ['calendar', 'calendar.events', 'calendar.readonly', 'calendar.events.readonly']
          : ['calendar', 'calendar.events'];
    else if (actionId.startsWith('integration.google-sheets.'))
      accepted = actionId.endsWith('.read')
        ? ['spreadsheets', 'spreadsheets.readonly', 'drive', 'drive.readonly', 'drive.file']
        : ['spreadsheets', 'drive', 'drive.file'];
    else
      accepted = actionId.endsWith('.upload-text')
        ? ['drive', 'drive.file']
        : ['drive', 'drive.readonly', 'drive.file'];
    if (!accepted.some((scope) => credential.scopes.includes(prefix + scope)))
      throw new UserError(
        'Your linked Google account did not grant the scope required for this action. Reauthorize with oauth.start and the appropriate scope.',
      );
  }
  async function authorize(
    ctx: ActionContext,
    actionId = execution.getStore()?.actionId,
  ): Promise<ActionContext> {
    if (closed) throw new UserError('External services are shutting down.');
    if (
      execution.getStore()?.featureEpoch !== undefined &&
      (ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:integrations`) ?? 0) !==
        execution.getStore()!.featureEpoch
    )
      throw new UserError('Integration settings changed during this request.');
    const state = execution.getStore(),
      owned = state?.provider === 'google' && state.authorization?.kind === 'owned';
    if (!owned && !operatorIds.includes(ctx.member.id)) await ctx.client.application?.fetch();
    const fresh = await freshContext(ctx);
    if (owned) {
      await assertPermissions(fresh, [P.ReadMessageHistory], [P.ReadMessageHistory], {});
      const linked = await credentials.linked('google', fresh);
      if (
        !linked ||
        linked.kind !== 'owned' ||
        state!.authorization?.kind !== 'owned' ||
        linked.providerAccountId !== state!.authorization.providerAccountId ||
        linked.authorizationId !== state!.authorization.authorizationId ||
        state!.authorization.current?.() === false
      )
        throw new UserError('Your linked Google account changed or was disconnected during this request.');
      requireGoogleScope(actionId ?? state!.actionId, linked);
      state!.authorization = linked;
    } else {
      try {
        assertOperator(fresh, operatorIds);
      } catch (error) {
        if (state?.provider === 'google' && !state.authorization)
          throw new UserError(
            'Link your own Google account with oauth.start before using this service. Shared host credentials are restricted to application operators.',
          );
        throw error;
      }
      await assertPermissions(fresh, [P.ManageGuild], [], {});
      assertOperator(fresh, operatorIds);
    }
    if (actionId) registry?.assertPolicy(fresh, actionId);
    return fresh;
  }
  const api = async (
    ctx: ActionContext,
    provider: string,
    origin: string,
    path: string,
    input: ProviderInput = {},
    actionId?: string,
  ) => {
    credentials.requireProvider(provider);
    const value = providerJson(
      await providerHttp(provider, origin, options.transport)(path, input, () =>
        authorize(ctx, actionId).then(() => undefined),
      ),
      provider,
    );
    await authorize(ctx, actionId);
    return value;
  };
  const google = async (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) =>
    api(
      ctx,
      'google',
      'https://www.googleapis.com',
      path,
      {
        ...input,
        headers: {
          Authorization: `Bearer ${await credentials.token('google', ctx, () => authorize(ctx, actionId).then(() => undefined))}`,
          ...input.headers,
        },
      },
      actionId,
    );
  const gitlab = (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) =>
    api(
      ctx,
      'gitlab',
      credentials.value('GITLAB_BASE_URL'),
      '/api/v4' + path,
      { ...input, headers: { 'PRIVATE-TOKEN': credentials.value('GITLAB_TOKEN'), ...input.headers } },
      actionId,
    );
  const github = (ctx: ActionContext, path: string, input: ProviderInput = {}) =>
    api(ctx, 'github', 'https://api.github.com', path, {
      ...input,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${credentials.value('GITHUB_TOKEN')}`,
        'X-GitHub-Api-Version': '2026-03-10',
      },
    });
  const trello = (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) =>
    api(
      ctx,
      'trello',
      'https://api.trello.com',
      '/1' + path,
      {
        ...input,
        query: {
          ...input.query,
          key: credentials.value('TRELLO_API_KEY'),
          token: credentials.value('TRELLO_TOKEN'),
        },
      },
      actionId,
    );
  const notion = (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) =>
    api(
      ctx,
      'notion',
      'https://api.notion.com',
      '/v1' + path,
      {
        ...input,
        headers: {
          Authorization: `Bearer ${credentials.value('NOTION_TOKEN')}`,
          'Notion-Version': '2025-09-03',
          ...input.headers,
        },
      },
      actionId,
    );
  const youtube = (
    ctx: ActionContext,
    path: string,
    query: NonNullable<ProviderInput['query']>,
    actionId?: string,
  ) =>
    api(
      ctx,
      'youtube',
      'https://www.googleapis.com',
      '/youtube/v3' + path,
      { query: { ...query, key: credentials.value('YOUTUBE_API_KEY') } },
      actionId,
    );
  const twitch = async (
    ctx: ActionContext,
    path: string,
    query: NonNullable<ProviderInput['query']>,
    actionId?: string,
  ) =>
    api(
      ctx,
      'twitch',
      'https://api.twitch.tv',
      '/helix' + path,
      {
        query,
        headers: {
          Authorization: `Bearer ${await credentials.token('twitch', ctx, () => authorize(ctx, actionId).then(() => undefined))}`,
          'Client-Id': credentials.value('TWITCH_CLIENT_ID'),
        },
      },
      actionId,
    );
  const steam = (
    ctx: ActionContext,
    path: string,
    query: NonNullable<ProviderInput['query']>,
    actionId?: string,
  ) =>
    api(
      ctx,
      'steam',
      'https://api.steampowered.com',
      path,
      { query: { ...query, key: credentials.value('STEAM_API_KEY') } },
      actionId,
    );
  const parcel = (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) =>
    api(
      ctx,
      'parcels',
      'https://api.aftership.com',
      '/tracking/2026-07' + path,
      { ...input, headers: { 'as-api-key': credentials.value('AFTERSHIP_API_KEY') } },
      actionId,
    );
  const social = (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) =>
    api(
      ctx,
      'social',
      credentials.value('MASTODON_BASE_URL'),
      '/api/v1' + path,
      { ...input, headers: { Authorization: `Bearer ${credentials.value('MASTODON_ACCESS_TOKEN')}` } },
      actionId,
    );
  const runway = (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) =>
    api(
      ctx,
      'video-generation',
      'https://api.dev.runwayml.com',
      '/v1' + path,
      {
        ...input,
        headers: {
          Authorization: `Bearer ${credentials.value('RUNWAY_API_KEY')}`,
          'X-Runway-Version': '2024-11-06',
        },
      },
      actionId,
    );
  const shotstack = (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) => {
    const environment = credentials.value('SHOTSTACK_ENVIRONMENT');
    if (!['stage', 'v1'].includes(environment))
      throw new UserError('SHOTSTACK_ENVIRONMENT must be stage or v1.');
    return api(
      ctx,
      'video-processing',
      'https://api.shotstack.io',
      `/edit/${environment}${path}`,
      { ...input, headers: { 'x-api-key': credentials.value('SHOTSTACK_API_KEY') } },
      actionId,
    );
  };
  const cloud = (ctx: ActionContext, path: string, input: ProviderInput = {}, actionId?: string) =>
    api(
      ctx,
      'cloud',
      'https://api.cloudflare.com',
      '/client/v4' + path,
      { ...input, headers: { Authorization: `Bearer ${credentials.value('CLOUDFLARE_API_TOKEN')}` } },
      actionId,
    );
  async function products(ctx: ActionContext, query: string, actionId?: string): Promise<unknown> {
    const shop = credentials.value('SHOPIFY_SHOP'),
      version = credentials.value('SHOPIFY_API_VERSION');
    if (!/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(shop) || !/^20\d{2}-(?:01|04|07|10)$/.test(version))
      throw new UserError('Configure a valid Shopify shop hostname and pinned API version.');
    const result = await api(
      ctx,
      'commerce',
      `https://${shop}`,
      `/admin/api/${version}/graphql.json`,
      {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': credentials.value('SHOPIFY_ADMIN_TOKEN') },
        json: {
          query:
            'query Products($query:String!){products(first:20,query:$query){nodes{id title status onlineStoreUrl totalInventory variants(first:20){nodes{id title price inventoryQuantity}}}}}',
          variables: { query },
        },
      },
      actionId,
    );
    if (field(result, 'errors'))
      throw new UserError('Shopify rejected the product query; check token scopes and API version.');
    return field(field(result, 'data'), 'products');
  }
  function add<S extends z.ZodType>(
    provider: string,
    id: string,
    description: string,
    risk: Risk,
    schema: S,
    execute: (ctx: ActionContext, input: z.infer<S>) => Promise<unknown>,
  ): void {
    registry!.register({
      id,
      description,
      category: 'integrations',
      risk,
      schema,
      userPermissions: provider === 'google' ? [P.ReadMessageHistory] : [P.ManageGuild],
      botPermissions: provider === 'google' ? [P.ReadMessageHistory] : [],
      available: () => !closed && credentials.available(provider),
      unavailableReason: `${provider} is disabled until its optional host configuration is complete. See OPTIONAL_INTEGRATIONS.md.`,
      execute: (ctx, input) =>
        execution.run(
          {
            actionId: id,
            provider,
            featureEpoch: ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:integrations`) ?? 0,
          },
          async () => {
            credentials.requireProvider(provider);
            if (provider === 'google')
              execution.getStore()!.authorization = await credentials.linked('google', ctx);
            await authorize(ctx, id);
            const result = await execute(ctx, input);
            await authorize(ctx, id);
            return safeProviderValue(result, credentials.secrets());
          },
        ),
    });
  }
  function registerActions(target: ActionRegistry): void {
    if (registry) throw new Error('Optional integrations already registered');
    registry = target;
    registry.register({
      id: 'integration.services',
      description:
        'Application operator inspects optional service availability and missing setting names without exposing credentials.',
      category: 'integrations',
      risk: 'read',
      schema: empty,
      userPermissions: [P.ManageGuild],
      botPermissions: [],
      execute: async (ctx) => {
        await authorize(ctx, 'integration.services');
        return status();
      },
    });
    add(
      'google',
      'integration.google-calendar.events',
      'List a bounded page of events from the authorized Google calendar.',
      'read',
      z.strictObject({
        calendarId: resource.optional(),
        timeMin: dateTime.optional(),
        timeMax: dateTime.optional(),
        pageToken: z.string().max(2048).optional(),
        limit,
      }),
      async (ctx, input) =>
        google(
          ctx,
          `/calendar/v3/calendars/${encode(input.calendarId ?? credentials.value('GOOGLE_CALENDAR_ID'))}/events`,
          {
            query: {
              singleEvents: true,
              orderBy: 'startTime',
              timeMin: input.timeMin ?? new Date(now()).toISOString(),
              timeMax: input.timeMax,
              maxResults: input.limit,
              pageToken: input.pageToken,
            },
          },
        ),
    );
    const eventFields = {
      calendarId: resource.optional(),
      title: z.string().min(1).max(250),
      start: dateTime,
      end: dateTime,
      timeZone: z.string().min(1).max(100).default('UTC'),
      description: z.string().max(4000).default(''),
      attendees: z.array(email).max(10).default([]),
    };
    add(
      'google',
      'integration.google-calendar.event-create',
      'Create an authorized external calendar appointment/interview with exact attendees, dates and timezone after review.',
      'write',
      z
        .strictObject(eventFields)
        .refine((input) => Date.parse(input.end) > Date.parse(input.start), 'End must follow start.'),
      async (ctx, input) =>
        google(
          ctx,
          `/calendar/v3/calendars/${encode(input.calendarId ?? credentials.value('GOOGLE_CALENDAR_ID'))}/events`,
          {
            method: 'POST',
            query: { sendUpdates: input.attendees.length ? 'all' : 'none' },
            json: {
              summary: input.title,
              description: input.description,
              start: { dateTime: input.start, timeZone: input.timeZone },
              end: { dateTime: input.end, timeZone: input.timeZone },
              attendees: input.attendees.map((email) => ({ email })),
            },
          },
        ),
    );
    add(
      'google',
      'integration.google-calendar.event-update',
      'Update exact event title, timing and attendees in an authorized Google calendar.',
      'write',
      z
        .strictObject({ ...eventFields, eventId: resource })
        .refine((input) => Date.parse(input.end) > Date.parse(input.start), 'End must follow start.'),
      async (ctx, input) =>
        google(
          ctx,
          `/calendar/v3/calendars/${encode(input.calendarId ?? credentials.value('GOOGLE_CALENDAR_ID'))}/events/${encode(input.eventId)}`,
          {
            method: 'PATCH',
            query: { sendUpdates: input.attendees.length ? 'all' : 'none' },
            json: {
              summary: input.title,
              description: input.description,
              start: { dateTime: input.start, timeZone: input.timeZone },
              end: { dateTime: input.end, timeZone: input.timeZone },
              attendees: input.attendees.map((email) => ({ email })),
            },
          },
        ),
    );
    add(
      'google',
      'integration.google-calendar.event-remove',
      'Cancel one exact external calendar event and notify its attendees after destructive confirmation.',
      'destructive',
      z.strictObject({ calendarId: resource.optional(), eventId: resource }),
      async (ctx, input) =>
        google(
          ctx,
          `/calendar/v3/calendars/${encode(input.calendarId ?? credentials.value('GOOGLE_CALENDAR_ID'))}/events/${encode(input.eventId)}`,
          { method: 'DELETE', query: { sendUpdates: 'all' } },
        ),
    );
    add(
      'google',
      'integration.google-sheets.read',
      'Read a bounded A1 range from an authorized Google spreadsheet.',
      'read',
      z.strictObject({ spreadsheetId: fileId, range: z.string().min(1).max(256) }),
      async (ctx, input) =>
        google(ctx, `/sheets/v4/spreadsheets/${encode(input.spreadsheetId)}/values/${encode(input.range)}`, {
          query: { valueRenderOption: 'UNFORMATTED_VALUE' },
        }),
    );
    add(
      'google',
      'integration.google-sheets.write',
      'Write exact scalar cell values using RAW input (no formula execution) after review.',
      'write',
      z.strictObject({
        spreadsheetId: fileId,
        range: z.string().min(1).max(256),
        values: z
          .array(z.array(z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()])).max(26))
          .min(1)
          .max(100),
      }),
      async (ctx, input) =>
        google(ctx, `/sheets/v4/spreadsheets/${encode(input.spreadsheetId)}/values/${encode(input.range)}`, {
          method: 'PUT',
          query: { valueInputOption: 'RAW' },
          json: { range: input.range, majorDimension: 'ROWS', values: input.values },
        }),
    );
    add(
      'google',
      'integration.google-drive.files',
      'List/search a bounded page of files shared with the configured Google identity.',
      'read',
      z.strictObject({
        name: z.string().max(100).default(''),
        folderId: fileId.optional(),
        pageToken: z.string().max(2048).optional(),
        limit,
      }),
      async (ctx, input) => {
        const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
        return google(ctx, '/drive/v3/files', {
          query: {
            q: `trashed = false${input.name ? ` and name contains '${escape(input.name)}'` : ''}${input.folderId ? ` and '${escape(input.folderId)}' in parents` : ''}`,
            pageSize: input.limit,
            pageToken: input.pageToken,
            fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)',
          },
        });
      },
    );
    add(
      'google',
      'integration.google-drive.download',
      'Download one authorized Drive binary file, bounded to 8 MiB.',
      'read',
      z.strictObject({ fileId }),
      async (ctx, input) => {
        const token = await credentials.token('google', ctx),
          response = await providerHttp('google', 'https://www.googleapis.com', options.transport)(
            `/drive/v3/files/${encode(input.fileId)}`,
            { query: { alt: 'media' }, headers: { Authorization: `Bearer ${token}` }, maxBytes: 8 * 1048576 },
            () => authorize(ctx).then(() => undefined),
          );
        if (response.status < 200 || response.status >= 300) providerJson(response, 'Google Drive');
        return { attachment: response.body, name: `drive-${input.fileId}.bin` };
      },
    );
    add(
      'google',
      'integration.google-drive.export',
      'Export an authorized Google Workspace document as PDF or plain text, bounded to 8 MiB.',
      'read',
      z.strictObject({ fileId, format: z.enum(['pdf', 'text']).default('pdf') }),
      async (ctx, input) => {
        const token = await credentials.token('google', ctx),
          response = await providerHttp('google', 'https://www.googleapis.com', options.transport)(
            `/drive/v3/files/${encode(input.fileId)}/export`,
            {
              query: { mimeType: input.format === 'pdf' ? 'application/pdf' : 'text/plain' },
              headers: { Authorization: `Bearer ${token}` },
              maxBytes: 8 * 1048576,
            },
            () => authorize(ctx).then(() => undefined),
          );
        if (response.status < 200 || response.status >= 300) providerJson(response, 'Google Drive');
        return { attachment: response.body, name: `document.${input.format === 'pdf' ? 'pdf' : 'txt'}` };
      },
    );
    add(
      'google',
      'integration.google-drive.upload-text',
      'Upload a reviewed text document to an authorized Google Drive folder.',
      'write',
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[^\\/\r\n]+$/),
        text,
        folderId: fileId.optional(),
      }),
      async (ctx, input) => {
        const boundary = 'discord_' + randomBytes(16).toString('hex'),
          body = Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: input.name, mimeType: 'text/plain', ...(input.folderId ? { parents: [input.folderId] } : {}) })}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${input.text}\r\n--${boundary}--\r\n`,
          );
        return google(ctx, '/upload/drive/v3/files', {
          method: 'POST',
          query: { uploadType: 'multipart', fields: 'id,name,webViewLink' },
          body,
          contentType: `multipart/related; boundary=${boundary}`,
        });
      },
    );
    const repositoryFields = {
      owner: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    };
    add(
      'github',
      'integration.github.read',
      'Read authenticated repository, commit, release, issue, pull-request or workflow-run data from granted GitHub repositories.',
      'read',
      z.strictObject({
        ...repositoryFields,
        kind: z.enum(['repository', 'commits', 'releases', 'issues', 'pulls', 'runs']),
        page,
        limit,
      }),
      async (ctx, input) => {
        const suffix = {
          repository: '',
          commits: '/commits',
          releases: '/releases',
          issues: '/issues',
          pulls: '/pulls',
          runs: '/actions/runs',
        }[input.kind];
        return github(ctx, `/repos/${input.owner}/${input.repository}${suffix}`, {
          query: input.kind === 'repository' ? {} : { per_page: input.limit, page: input.page },
        });
      },
    );
    add(
      'github',
      'integration.github.issue-create',
      'Create one exact reviewed issue in a granted GitHub repository.',
      'write',
      z.strictObject({
        ...repositoryFields,
        title: z.string().min(1).max(250),
        text: z.string().max(12000).default(''),
      }),
      async (ctx, input) =>
        pick(
          await github(ctx, `/repos/${input.owner}/${input.repository}/issues`, {
            method: 'POST',
            json: { title: input.title, body: input.text },
          }),
          ['number', 'title', 'state', 'html_url'],
        ),
    );
    const project = z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.\/-]+$/);
    add(
      'gitlab',
      'integration.gitlab.project',
      'Read one authorized GitLab project, including private projects granted to the configured token.',
      'read',
      z.strictObject({ projectId: project }),
      async (ctx, input) =>
        pick(await gitlab(ctx, `/projects/${encode(input.projectId)}`), [
          'id',
          'name',
          'path_with_namespace',
          'description',
          'web_url',
          'default_branch',
          'visibility',
          'last_activity_at',
        ]),
    );
    add(
      'gitlab',
      'integration.gitlab.pipelines',
      'Read a bounded GitLab pipeline page for an authorized project.',
      'read',
      z.strictObject({ projectId: project, page, limit }),
      async (ctx, input) =>
        gitlab(ctx, `/projects/${encode(input.projectId)}/pipelines`, {
          query: { page: input.page, per_page: input.limit },
        }),
    );
    add(
      'gitlab',
      'integration.gitlab.issue-create',
      'Create an exact reviewed issue in an authorized GitLab project.',
      'write',
      z.strictObject({
        projectId: project,
        title: z.string().min(1).max(250),
        description: z.string().max(12000).default(''),
      }),
      async (ctx, input) =>
        pick(
          await gitlab(ctx, `/projects/${encode(input.projectId)}/issues`, {
            method: 'POST',
            json: { title: input.title, description: input.description },
          }),
          ['iid', 'title', 'state', 'web_url', 'created_at'],
        ),
    );
    const trelloId = z.string().regex(/^[A-Za-z0-9]{1,64}$/);
    add(
      'trello',
      'integration.trello.cards',
      'Read reviewed list cards from the authorized Trello account.',
      'read',
      z.strictObject({ listId: trelloId, limit }),
      async (ctx, input) =>
        trello(ctx, `/lists/${input.listId}/cards`, {
          query: { limit: input.limit, fields: 'id,name,desc,url,due,closed' },
        }),
    );
    add(
      'trello',
      'integration.trello.card-create',
      'Create a reviewed Trello task card in an exact list.',
      'write',
      z.strictObject({
        listId: trelloId,
        title: z.string().min(1).max(250),
        description: z.string().max(10000).default(''),
        due: dateTime.optional(),
      }),
      async (ctx, input) =>
        pick(
          await trello(ctx, '/cards', {
            method: 'POST',
            json: { idList: input.listId, name: input.title, desc: input.description, due: input.due },
          }),
          ['id', 'name', 'desc', 'url', 'due'],
        ),
    );
    add(
      'notion',
      'integration.notion.search',
      'Search pages/data sources explicitly shared with the configured Notion integration.',
      'read',
      z.strictObject({ query: z.string().max(100).default(''), limit }),
      async (ctx, input) =>
        notion(ctx, '/search', { method: 'POST', json: { query: input.query, page_size: input.limit } }),
    );
    add(
      'notion',
      'integration.notion.data-source',
      'Query a current Notion data source with a bounded page size.',
      'read',
      z.strictObject({ dataSourceId: uuid, cursor: z.string().max(100).optional(), limit }),
      async (ctx, input) =>
        notion(ctx, `/data_sources/${input.dataSourceId}/query`, {
          method: 'POST',
          json: { page_size: input.limit, start_cursor: input.cursor },
        }),
    );
    add(
      'notion',
      'integration.notion.page-create',
      'Create a reviewed titled Notion child page containing plain paragraph text.',
      'write',
      z.strictObject({
        parentPageId: uuid,
        title: z.string().min(1).max(250),
        text: z.string().max(10000).default(''),
      }),
      async (ctx, input) => {
        const chunks = input.text.match(/[\s\S]{1,1800}/g) ?? [];
        return notion(ctx, '/pages', {
          method: 'POST',
          json: {
            parent: { page_id: input.parentPageId },
            properties: {
              title: { type: 'title', title: [{ type: 'text', text: { content: input.title } }] },
            },
            children: chunks.map((content) => ({
              object: 'block',
              type: 'paragraph',
              paragraph: { rich_text: [{ type: 'text', text: { content } }] },
            })),
          },
        });
      },
    );
    const channelId = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
    add(
      'youtube',
      'integration.youtube.channel',
      'Read YouTube channel metadata and the actual uploads playlist ID.',
      'read',
      z.strictObject({ channelId }),
      async (ctx, input) =>
        youtube(ctx, '/channels', { part: 'snippet,statistics,contentDetails', id: input.channelId }),
    );
    add(
      'youtube',
      'integration.youtube.uploads',
      'List recent uploads from an explicit channel uploads playlist.',
      'read',
      z.strictObject({ playlistId: fileId, limit }),
      async (ctx, input) =>
        youtube(ctx, '/playlistItems', {
          part: 'snippet,contentDetails',
          playlistId: input.playlistId,
          maxResults: input.limit,
        }),
    );
    add(
      'twitch',
      'integration.twitch.channel',
      'Read the selected Twitch broadcaster account metadata.',
      'read',
      z.strictObject({ login }),
      async (ctx, input) => twitch(ctx, '/users', { login: input.login }),
    );
    add(
      'twitch',
      'integration.twitch.streams',
      'Read live stream status for a selected Twitch broadcaster.',
      'read',
      z.strictObject({ login }),
      async (ctx, input) => twitch(ctx, '/streams', { user_login: input.login, first: 1 }),
    );
    add(
      'email',
      'integration.email.send',
      'Send the exact reviewed plain-text email through the configured Resend sender.',
      'write',
      z.strictObject({ to: z.array(email).min(1).max(5), subject: z.string().min(1).max(200), text }),
      async (ctx, input) =>
        api(ctx, 'email', 'https://api.resend.com', '/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.value('RESEND_API_KEY')}`,
            'Idempotency-Key': randomBytes(16).toString('hex'),
          },
          json: {
            from: credentials.value('EMAIL_FROM'),
            to: input.to,
            subject: input.subject,
            text: input.text,
          },
        }),
    );
    add(
      'sms',
      'integration.sms.send',
      'Send one exact reviewed SMS via the configured Twilio sender; provider charges and recipient permissions apply.',
      'write',
      z.strictObject({ to: z.string().regex(/^\+[1-9]\d{7,14}$/), text: z.string().min(1).max(1600) }),
      async (ctx, input) =>
        pick(
          await api(
            ctx,
            'sms',
            'https://api.twilio.com',
            `/2010-04-01/Accounts/${encode(credentials.value('TWILIO_ACCOUNT_SID'))}/Messages.json`,
            {
              method: 'POST',
              headers: {
                Authorization: `Basic ${Buffer.from(`${credentials.value('TWILIO_ACCOUNT_SID')}:${credentials.value('TWILIO_AUTH_TOKEN')}`).toString('base64')}`,
              },
              form: { To: input.to, From: credentials.value('TWILIO_FROM'), Body: input.text },
            },
          ),
          ['sid', 'status', 'error_code', 'date_created'],
        ),
    );
    add(
      'email',
      'integration.email.received',
      'Read a specific email received by the authorized Resend account; receiving-domain setup and API permissions apply.',
      'read',
      z.strictObject({ emailId: uuid }),
      async (ctx, input) =>
        api(ctx, 'email', 'https://api.resend.com', `/emails/receiving/${input.emailId}`, {
          headers: { Authorization: `Bearer ${credentials.value('RESEND_API_KEY')}` },
        }),
    );
    const vt = (ctx: ActionContext, path: string, input: ProviderInput = {}) =>
      api(ctx, 'virustotal', 'https://www.virustotal.com', '/api/v3' + path, {
        ...input,
        headers: { 'x-apikey': credentials.value('VIRUSTOTAL_API_KEY') },
      });
    add(
      'virustotal',
      'integration.security.url-report',
      'Read the existing external reputation report for a public URL without uploading new content.',
      'read',
      z.strictObject({ url: publicMedia }),
      async (ctx, input) => vt(ctx, `/urls/${Buffer.from(input.url).toString('base64url')}`),
    );
    add(
      'virustotal',
      'integration.security.file-report',
      'Read an existing malware reputation report by SHA-256 without uploading the file.',
      'read',
      z.strictObject({ sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }),
      async (ctx, input) => vt(ctx, `/files/${input.sha256.toLowerCase()}`),
    );
    add(
      'virustotal',
      'integration.security.scan-url',
      'Submit an exact public URL to VirusTotal for external scanning; provider retention/disclosure applies.',
      'write',
      z.strictObject({ url: publicMedia }),
      async (ctx, input) => vt(ctx, '/urls', { method: 'POST', form: { url: input.url } }),
    );
    add(
      'virustotal',
      'integration.security.scan-file',
      'Upload an exact Discord attachment to VirusTotal for external scanning; the provider may retain/share submitted content.',
      'write',
      z.strictObject({ url: z.string().url().max(2048) }),
      async (ctx, input) => {
        const bytes = await downloadAttachment(input.url, 8 * 1048576),
          boundary = 'discord_' + randomBytes(16).toString('hex');
        return vt(ctx, '/files', {
          method: 'POST',
          body: Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="scan.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
            ),
            bytes,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]),
          contentType: `multipart/form-data; boundary=${boundary}`,
        });
      },
    );
    add(
      'virustotal',
      'integration.security.analysis',
      'Read the current status/result of a submitted VirusTotal analysis.',
      'read',
      z.strictObject({ analysisId: z.string().regex(/^[A-Za-z0-9_=-]{1,256}$/) }),
      async (ctx, input) => vt(ctx, `/analyses/${input.analysisId}`),
    );
    add(
      'captcha',
      'integration.captcha.verify',
      'Verify a single-use Turnstile token and require the configured hostname and expected action; this does not itself grant a role.',
      'read',
      z.strictObject({
        token: z.string().min(1).max(2048),
        action: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,32}$/)
          .default('discord-verification'),
      }),
      async (ctx, input) => {
        const result = await api(
          ctx,
          'captcha',
          'https://challenges.cloudflare.com',
          '/turnstile/v0/siteverify',
          {
            method: 'POST',
            json: { secret: credentials.value('TURNSTILE_SECRET_KEY'), response: input.token },
          },
        );
        if (
          field(result, 'success') !== true ||
          field(result, 'hostname') !== credentials.value('TURNSTILE_EXPECTED_HOSTNAME') ||
          field(result, 'action') !== input.action
        )
          throw new UserError('CAPTCHA validation failed or belonged to another site/action.');
        return { verified: true, hostname: field(result, 'hostname'), action: field(result, 'action') };
      },
    );
    const steamFields = {
      steamId: z.string().regex(/^\d{17}$/),
      appId: z.number().int().min(1).max(4294967295),
    };
    add(
      'steam',
      'integration.steam.achievements',
      'Query real Steam game achievements for an explicit accessible player/game.',
      'read',
      z.strictObject(steamFields),
      async (ctx, input) =>
        steam(ctx, '/ISteamUserStats/GetPlayerAchievements/v1/', {
          steamid: input.steamId,
          appid: input.appId,
        }),
    );
    add(
      'steam',
      'integration.steam.stats',
      'Query real Steam player/game statistics through the authorized Web API.',
      'read',
      z.strictObject(steamFields),
      async (ctx, input) =>
        steam(ctx, '/ISteamUserStats/GetUserStatsForGame/v2/', {
          steamid: input.steamId,
          appid: input.appId,
        }),
    );
    add(
      'parcels',
      'integration.parcel.create',
      'Register an exact shipment with AfterShip; carrier-specific required fields remain provider validated.',
      'write',
      z.strictObject({
        trackingNumber: z.string().min(1).max(100),
        carrier: z.string().regex(/^[a-z0-9-]{1,100}$/),
      }),
      async (ctx, input) =>
        parcel(ctx, '/trackings', {
          method: 'POST',
          json: { tracking_number: input.trackingNumber, slug: input.carrier },
        }),
    );
    add(
      'parcels',
      'integration.parcel.get',
      'Retrieve current shipment status/checkpoints from AfterShip by tracking record ID.',
      'read',
      z.strictObject({ trackingId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
      async (ctx, input) => parcel(ctx, `/trackings/${input.trackingId}`),
    );
    add(
      'commerce',
      'integration.shopify.products',
      'Query actual product availability, variant prices and inventory from the authorized Shopify shop.',
      'read',
      z.strictObject({ query: z.string().max(200).default('') }),
      async (ctx, input) => products(ctx, input.query),
    );
    add(
      'social',
      'integration.mastodon.account',
      'Resolve an account on the configured Mastodon instance.',
      'read',
      z.strictObject({
        account: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_.@-]+$/),
      }),
      async (ctx, input) => social(ctx, '/accounts/lookup', { query: { acct: input.account } }),
    );
    add(
      'social',
      'integration.mastodon.posts',
      'Read recent posts by an explicit account from the authorized Mastodon instance.',
      'read',
      z.strictObject({ accountId: z.string().regex(/^\d{1,30}$/), limit }),
      async (ctx, input) =>
        social(ctx, `/accounts/${input.accountId}/statuses`, {
          query: { limit: input.limit, exclude_replies: true, exclude_reblogs: true },
        }),
    );
    add(
      'social',
      'integration.mastodon.post',
      'Publish an exact reviewed text post to the configured Mastodon account.',
      'write',
      z.strictObject({
        text: z.string().min(1).max(500),
        visibility: z.enum(['public', 'unlisted', 'private']).default('unlisted'),
      }),
      async (ctx, input) =>
        pick(
          await social(ctx, '/statuses', {
            method: 'POST',
            headers: { 'Idempotency-Key': randomBytes(16).toString('hex') },
            json: { status: input.text, visibility: input.visibility },
          }),
          ['id', 'url', 'created_at', 'visibility'],
        ),
    );
    const videoFields = {
      prompt,
      duration: z.union([z.literal(5), z.literal(10)]).default(5),
      ratio: z.enum(['1280:720', '720:1280']).default('1280:720'),
    };
    add(
      'video-generation',
      'integration.video.generate',
      'Start one reviewed billed text-to-video Runway job; inspect its actual task result separately.',
      'write',
      z.strictObject(videoFields),
      async (ctx, input) =>
        runway(ctx, '/text_to_video', {
          method: 'POST',
          json: {
            model: credentials.value('RUNWAY_VIDEO_MODEL'),
            promptText: input.prompt,
            duration: input.duration,
            ratio: input.ratio,
          },
        }),
    );
    add(
      'video-generation',
      'integration.video.image-generate',
      'Start one reviewed billed Runway image-to-video job using a public HTTPS image.',
      'write',
      z.strictObject({ ...videoFields, imageUrl: publicMedia }),
      async (ctx, input) =>
        runway(ctx, '/image_to_video', {
          method: 'POST',
          json: {
            model: credentials.value('RUNWAY_VIDEO_MODEL'),
            promptText: input.prompt,
            promptImage: input.imageUrl,
            duration: input.duration,
            ratio: input.ratio,
          },
        }),
    );
    add(
      'video-generation',
      'integration.video.task',
      'Read actual generation status and completed output URLs for a Runway job.',
      'read',
      z.strictObject({ taskId: uuid }),
      async (ctx, input) => runway(ctx, `/tasks/${input.taskId}`),
    );
    add(
      'video-generation',
      'integration.video.cancel',
      'Cancel/delete one exact Runway generation task after confirmation.',
      'destructive',
      z.strictObject({ taskId: uuid }),
      async (ctx, input) => runway(ctx, `/tasks/${input.taskId}`, { method: 'DELETE' }),
    );
    add(
      'video-processing',
      'integration.video.render',
      'Queue an exact reviewed external video edit with 1–10 public source clips, at most 120 total seconds.',
      'write',
      z
        .strictObject({
          clips: z
            .array(
              z.strictObject({
                url: publicMedia,
                start: z.number().min(0).max(3600).default(0),
                length: z.number().positive().max(120),
              }),
            )
            .min(1)
            .max(10),
          resolution: z.enum(['sd', 'hd', '1080']).default('hd'),
        })
        .refine(
          (input) => input.clips.reduce((sum, clip) => sum + clip.length, 0) <= 120,
          'Timeline exceeds 120 seconds.',
        ),
      async (ctx, input) => {
        let offset = 0;
        const clips = input.clips.map((clip) => {
          const rendered = {
            asset: { type: 'video', src: clip.url, trim: clip.start },
            start: offset,
            length: clip.length,
          };
          offset += clip.length;
          return rendered;
        });
        return shotstack(ctx, '/render', {
          method: 'POST',
          json: {
            timeline: { tracks: [{ clips }] },
            output: { format: 'mp4', resolution: input.resolution },
          },
        });
      },
    );
    add(
      'video-processing',
      'integration.video.render-status',
      'Read actual Shotstack edit-job status/output URL.',
      'read',
      z.strictObject({ renderId: uuid }),
      async (ctx, input) => shotstack(ctx, `/render/${input.renderId}`),
    );
    add(
      'cloud',
      'integration.cloudflare.workers',
      'List Worker scripts in the explicitly configured Cloudflare account.',
      'read',
      empty,
      async (ctx) =>
        cloud(ctx, `/accounts/${encode(credentials.value('CLOUDFLARE_ACCOUNT_ID'))}/workers/scripts`),
    );
    add(
      'cloud',
      'integration.cloudflare.dns-list',
      'Read a bounded DNS-record page in an explicitly selected authorized Cloudflare zone.',
      'read',
      z.strictObject({ zoneId: z.string().regex(/^[a-f0-9]{32}$/), page, limit }),
      async (ctx, input) =>
        cloud(ctx, `/zones/${input.zoneId}/dns_records`, {
          query: { page: input.page, per_page: input.limit },
        }),
    );
    add(
      'cloud',
      'integration.cloudflare.dns-update',
      'Update one exact authorized Cloudflare DNS record after review; no arbitrary cloud command is accepted.',
      'write',
      z.strictObject({
        zoneId: z.string().regex(/^[a-f0-9]{32}$/),
        recordId: z.string().regex(/^[a-f0-9]{32}$/),
        type: z.enum(['A', 'AAAA', 'CNAME', 'TXT']),
        name: z.string().min(1).max(253),
        content: z.string().min(1).max(2048),
        ttl: z.number().int().min(60).max(86400).default(300),
        proxied: z.boolean().default(false),
      }),
      async (ctx, input) =>
        cloud(ctx, `/zones/${input.zoneId}/dns_records/${input.recordId}`, {
          method: 'PUT',
          json: {
            type: input.type,
            name: input.name,
            content: input.content,
            ttl: input.ttl,
            proxied: input.proxied,
          },
        }),
    );
    registerWatchActions();
  }
  // Durable provider monitors are registered below; every sweep rechecks current author/operator/channel policy.
  async function selectGoogleWatchAuthorization(
    ctx: ActionContext,
  ): Promise<{ binding: GoogleWatchBinding; authorization: ResolvedCredential | undefined }> {
    const authorization = await credentials.linked('google', ctx);
    if (authorization?.kind === 'owned') {
      requireGoogleScope('integration.provider-watch.create', authorization);
      if (!authorization.authorizationId)
        throw new UserError(
          'Persistent calendar monitors require a versioned account link created through oauth.start.',
        );
      return {
        authorization,
        binding: {
          mode: 'owned',
          accountId: authorization.providerAccountId,
          authorizationId: authorization.authorizationId,
        },
      };
    }
    if (
      !authorization &&
      !credentials.value('GOOGLE_ACCESS_TOKEN') &&
      !credentials.value('GOOGLE_REFRESH_TOKEN')
    )
      throw new UserError(
        'Link your Google calendar account with oauth.start before configuring this monitor.',
      );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          authorization?.token,
          credentials.value('GOOGLE_CLIENT_ID'),
          credentials.value('GOOGLE_REFRESH_TOKEN'),
          credentials.value('GOOGLE_ACCESS_TOKEN'),
        ]),
      )
      .digest('hex');
    return { authorization, binding: { mode: 'shared', fingerprint } };
  }
  async function assertGoogleWatchBinding(ctx: ActionContext, watch: Watch): Promise<void> {
    if (watch.kind !== 'google-calendar') return;
    const selected = await selectGoogleWatchAuthorization(ctx);
    if (
      !watch.googleAuthorization ||
      JSON.stringify(selected.binding) !== JSON.stringify(watch.googleAuthorization)
    )
      throw new UserError(
        'This calendar monitor’s selected account changed. Recreate the monitor after reviewing its source and notification channel.',
      );
  }
  async function watchData(
    ctx: ActionContext,
    kind: WatchKind,
    source: Record<string, string>,
    googleBinding?: GoogleWatchBinding,
  ): Promise<unknown> {
    const selected = kind === 'google-calendar' ? await selectGoogleWatchAuthorization(ctx) : undefined;
    if (selected && (!googleBinding || JSON.stringify(selected.binding) !== JSON.stringify(googleBinding)))
      throw new UserError(
        'Calendar monitor authorization changed. Recreate the monitor to select this account.',
      );
    const authorization = selected?.authorization;
    return execution.run(
      {
        actionId: 'integration.provider-watch.create',
        provider: watchProvider[kind],
        authorization,
        featureEpoch: ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:integrations`) ?? 0,
      },
      async () => {
        switch (kind) {
          case 'google-calendar':
            return (
              field(
                await google(ctx, `/calendar/v3/calendars/${encode(source.calendarId!)}/events`, {
                  query: {
                    singleEvents: true,
                    orderBy: 'startTime',
                    timeMin: new Date(now()).toISOString(),
                    maxResults: 50,
                  },
                }),
                'items',
              ) ?? []
            );
          case 'youtube-uploads':
            return (
              field(
                await youtube(ctx, '/playlistItems', {
                  part: 'snippet,contentDetails',
                  playlistId: source.playlistId,
                  maxResults: 10,
                }),
                'items',
              ) ?? []
            );
          case 'twitch-live':
            return field(await twitch(ctx, '/streams', { user_login: source.login, first: 1 }), 'data');
          case 'steam-achievements':
            return field(
              await steam(ctx, '/ISteamUserStats/GetPlayerAchievements/v1/', {
                steamid: source.steamId,
                appid: source.appId,
              }),
              'playerstats',
            );
          case 'shopify-products':
            return products(ctx, source.query ?? '');
          case 'mastodon-posts':
            return social(ctx, `/accounts/${encode(source.accountId!)}/statuses`, {
              query: { limit: 10, exclude_replies: true, exclude_reblogs: true },
            });
          case 'parcels':
            return parcel(ctx, `/trackings/${encode(source.trackingId!)}`);
          case 'gitlab-pipelines':
            return gitlab(ctx, `/projects/${encode(source.projectId!)}/pipelines`, {
              query: { per_page: 10 },
            });
          case 'github-releases':
            return summary(
              await github(ctx, `/repos/${encode(source.owner!)}/${encode(source.repository!)}/releases`, {
                query: { per_page: 10 },
              }),
              ['id', 'tag_name', 'name', 'published_at', 'html_url', 'draft', 'prerelease'],
            );
          case 'github-pulls':
            return source.number
              ? pick(
                  await github(
                    ctx,
                    `/repos/${encode(source.owner!)}/${encode(source.repository!)}/pulls/${encode(source.number)}`,
                  ),
                  ['number', 'state', 'title', 'merged_at', 'updated_at', 'html_url'],
                )
              : summary(
                  await github(ctx, `/repos/${encode(source.owner!)}/${encode(source.repository!)}/pulls`, {
                    query: { per_page: 10, state: 'all' },
                  }),
                  ['number', 'state', 'title', 'updated_at', 'html_url'],
                );
          case 'github-runs':
            return summary(
              field(
                await github(
                  ctx,
                  `/repos/${encode(source.owner!)}/${encode(source.repository!)}/actions/runs`,
                  { query: { per_page: 10, branch: source.branch } },
                ),
                'workflow_runs',
              ),
              ['id', 'name', 'status', 'conclusion', 'head_sha', 'html_url', 'updated_at'],
            );
        }
      },
    );
  }
  function registerWatchActions(): void {
    registry!.register({
      id: 'integration.provider-watch.create',
      description:
        'Configure a concrete provider monitor; the first read establishes a baseline, later changes notify the reviewed channel.',
      available: () =>
        !closed && integrationStatus(credentials.env()).some((row) => credentials.available(row.id)),
      unavailableReason: 'Configure an optional provider locally before creating a provider monitor.',
      category: 'integrations',
      risk: 'write',
      userPermissions: [P.ManageGuild],
      botPermissions: [P.SendMessages],
      schema: z.strictObject({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
        kind: watchKinds,
        source: z.record(z.string().max(40), z.string().max(256)),
        channelId: snowflake,
        intervalSeconds: z.number().int().min(60).max(86400).default(300),
      }),
      execute: async (ctx, input) => {
        credentials.requireProvider(watchProvider[input.kind]);
        await authorize(ctx, 'integration.provider-watch.create');
        const keys = sourceKeys[input.kind];
        if (
          Object.keys(input.source).some((key) => !keys.includes(key)) ||
          keys.some((key) => !['query', 'number', 'branch'].includes(key) && !input.source[key])
        )
          throw new UserError(`Use these exact source fields: ${keys.join(', ')}.`);
        if (input.kind === 'twitch-live') login.parse(input.source.login);
        if (input.kind === 'youtube-uploads') fileId.parse(input.source.playlistId);
        if (input.kind === 'steam-achievements') {
          z.string()
            .regex(/^\d{17}$/)
            .parse(input.source.steamId);
          z.coerce.number().int().min(1).max(4294967295).parse(input.source.appId);
        }
        if (input.kind === 'mastodon-posts')
          z.string()
            .regex(/^\d{1,30}$/)
            .parse(input.source.accountId);
        if (input.kind.startsWith('github-')) {
          z.string()
            .regex(/^[A-Za-z0-9-]{1,100}$/)
            .parse(input.source.owner);
          z.string()
            .regex(/^[A-Za-z0-9_.-]{1,100}$/)
            .parse(input.source.repository);
          if (input.source.number)
            z.string()
              .regex(/^[1-9]\d{0,8}$/)
              .parse(input.source.number);
        }
        const channel = await resolveChannel(ctx, input.channelId);
        if (!channel.isSendable() || !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages))
          throw new UserError('Bot needs Send Messages in the chosen channel.');
        const key = `${ctx.guild.id}:${input.id}`;
        if (
          ctx.store.list<Watch>('integrations.providerWatches', `${ctx.guild.id}:`).length >= 25 &&
          !ctx.store.get('integrations.providerWatches', key)
        )
          throw new UserError('Limit:25 provider monitors per server.');
        if (
          ctx.store.list('integrations.providerWatches').length >= 500 &&
          !ctx.store.get('integrations.providerWatches', key)
        )
          throw new UserError('Host provider monitor limit reached.');
        const watch: Watch = {
          ...input,
          guildId: ctx.guild.id,
          authorId: ctx.member.id,
          enabled: true,
          version: randomBytes(8).toString('hex'),
          nextAt: now(),
          attempts: 0,
          ...(input.kind === 'google-calendar'
            ? { googleAuthorization: (await selectGoogleWatchAuthorization(ctx)).binding }
            : {}),
        };
        ctx.store.set('integrations.providerWatches', key, watch);
        return { configured: input.id, kind: input.kind, nextAt: watch.nextAt };
      },
    });
    registry!.register({
      id: 'integration.provider-watch.list',
      description:
        'List configured provider monitor states without exposing service credentials or private provider payloads.',
      category: 'integrations',
      risk: 'read',
      schema: empty,
      userPermissions: [P.ManageGuild],
      botPermissions: [],
      execute: async (ctx) => {
        await authorize(ctx, 'integration.provider-watch.list');
        return ctx.store
          .list<Watch>('integrations.providerWatches', `${ctx.guild.id}:`)
          .map(({ value }) =>
            pick(value, ['id', 'kind', 'source', 'channelId', 'enabled', 'nextAt', 'attempts', 'lastError']),
          );
      },
    });
    registry!.register({
      id: 'integration.provider-watch.remove',
      description: 'Remove one provider monitor and its retained baseline/pending notification.',
      category: 'integrations',
      risk: 'write',
      schema: z.strictObject({ id: z.string().max(40) }),
      userPermissions: [P.ManageGuild],
      botPermissions: [],
      execute: async (ctx, input) => {
        await authorize(ctx, 'integration.provider-watch.remove');
        return { removed: ctx.store.delete('integrations.providerWatches', `${ctx.guild.id}:${input.id}`) };
      },
    });
    registry!.register({
      id: 'integration.provider-watch.resume',
      description:
        'Resume one reviewed provider monitor after inspecting a failed/uncertain notification in Discord.',
      category: 'integrations',
      risk: 'write',
      schema: z.strictObject({
        id: z.string().max(40),
        remoteStateReviewed: z.literal(true),
        pendingOutcome: z.enum(['delivered', 'not-delivered']).optional(),
      }),
      userPermissions: [P.ManageGuild],
      botPermissions: [],
      execute: async (ctx, input) => {
        await authorize(ctx, 'integration.provider-watch.resume');
        const key = `${ctx.guild.id}:${input.id}`,
          watch = ctx.store.get<Watch>('integrations.providerWatches', key);
        if (!watch) throw new UserError('Monitor not found.');
        credentials.requireProvider(watchProvider[watch.kind]);
        if (watch.pending) {
          if (!input.pendingOutcome)
            throw new UserError(
              'Inspect the pending notification in Discord and specify pendingOutcome:delivered or not-delivered.',
            );
          if (input.pendingOutcome === 'delivered') {
            watch.fingerprint = watch.pending.fingerprint;
            watch.data = watch.pending.data;
          }
        }
        delete watch.pending;
        delete watch.lastError;
        watch.enabled = true;
        watch.attempts = 0;
        watch.nextAt = now();
        watch.version = randomBytes(8).toString('hex');
        ctx.store.set('integrations.providerWatches', key, watch);
        return { resumed: watch.id };
      },
    });
  }
  const running = new WeakSet<Store>();
  async function sweep(
    client: Client,
    store: Store,
    time = now(),
    allowedGuildIds: readonly string[] = [],
  ): Promise<void> {
    if (closed || running.has(store)) return;
    running.add(store);
    try {
      const due = store
        .list<Watch>('integrations.providerWatches')
        .filter(
          ({ value }) =>
            value.enabled &&
            value.nextAt <= time &&
            credentials.available(watchProvider[value.kind]) &&
            (!allowedGuildIds.length || allowedGuildIds.includes(value.guildId)),
        )
        .sort((a, b) => a.value.nextAt - b.value.nextAt)
        .slice(0, 5);
      for (const row of due) {
        const watch = row.value,
          key = row.key;
        const featureEpoch = store.get<number>('core.featureEpochs', `${watch.guildId}:integrations`) ?? 0;
        const current = () => {
          const latest = store.get<Watch>('integrations.providerWatches', key);
          return (
            !closed &&
            latest?.version === watch.version &&
            latest.enabled &&
            (store.get<number>('core.featureEpochs', `${watch.guildId}:integrations`) ?? 0) ===
              featureEpoch &&
            !(store.get<string[]>('core.disabled', watch.guildId) ?? []).includes('integrations')
          );
        };
        if (!current()) continue;
        try {
          const guild = await client.guilds.fetch(watch.guildId),
            member = await guild.members.fetch({ user: watch.authorId, force: true });
          const ctx: ActionContext = { client, store, guild, member, channelId: watch.channelId };
          await authorize(ctx, 'integration.provider-watch.create');
          if (!current()) continue;
          const channel = await resolveChannel(ctx, watch.channelId);
          if (!channel.isSendable() || !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages))
            throw new UserError('Monitor channel cannot receive messages.');
          const data = await watchData(ctx, watch.kind, watch.source, watch.googleAuthorization);
          await assertGoogleWatchBinding(ctx, watch);
          if (!current()) continue;
          const sanitized = safeProviderValue(data, credentials.secrets()),
            signal = monitorSignal(watch.kind, sanitized),
            serialized = JSON.stringify(signal);
          if (serialized.length > 250000)
            throw new UserError('Monitor payload exceeds its retained snapshot limit.');
          // Retain and publish only selected business metadata, never full private provider payloads.
          const fingerprint = createHash('sha256').update(JSON.stringify(signal)).digest('hex');
          if (watch.fingerprint && watch.fingerprint !== fingerprint) {
            const nonce = BigInt(
              '0x' + createHash('sha256').update(`${key}:${fingerprint}`).digest('hex').slice(0, 15),
            ).toString();
            const content = `External ${watch.kind} update for monitor ${watch.id}.\n${serialized.slice(0, 1300).replaceAll('@', '＠')}`;
            watch.pending = { content, fingerprint, nonce, data: signal };
            store.set('integrations.providerWatches', key, watch);
            await authorize(ctx, 'integration.provider-watch.create');
            await assertGoogleWatchBinding(ctx, watch);
            if (!current()) continue;
            // Mark the result ambiguous before the send; a crash never blindly retries it.
            watch.enabled = false;
            watch.lastError = 'NotificationOutcomeUnknown';
            store.set('integrations.providerWatches', key, watch);
            await channel.send({ content, allowedMentions: { parse: [] }, nonce, enforceNonce: true });
            const latest = store.get<Watch>('integrations.providerWatches', key);
            if (!latest || latest.version !== watch.version) continue;
            watch.enabled = true;
            delete watch.pending;
          }
          watch.fingerprint = fingerprint;
          watch.data = signal;
          watch.nextAt = time + watch.intervalSeconds * 1000;
          watch.attempts = 0;
          delete watch.lastError;
          store.set('integrations.providerWatches', key, watch);
        } catch (error) {
          const latest = store.get<Watch>('integrations.providerWatches', key);
          if (!latest || latest.version !== watch.version) continue;
          if (watch.pending) {
            watch.enabled = false;
            watch.lastError = 'NotificationOutcomeUnknown';
          } else {
            watch.attempts++;
            watch.lastError = error instanceof Error ? error.name : 'Error';
            watch.nextAt = time + Math.min(86400000, 60000 * 2 ** Math.min(10, watch.attempts));
            if (watch.attempts >= 5) watch.enabled = false;
          }
          store.set('integrations.providerWatches', key, watch);
        }
      }
    } finally {
      running.delete(store);
    }
  }
  function status() {
    return integrationStatus(credentials.env()).map((row) => ({
      ...row,
      enabled: !closed && credentials.available(row.id),
      missing: credentials.available(row.id) ? [] : row.missing,
    }));
  }
  return {
    registerActions,
    status,
    sweep,
    close() {
      closed = true;
      credentials.clear();
    },
  };
}
