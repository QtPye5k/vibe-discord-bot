import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChannelType, PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { freshContext, resolveChannel, assertPermissions } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { HttpError, publicOrigin, readBody, jsonResponse } from '../core/http.js';
import { codePath } from '../core/paths.js';
import { newActivityRoom, applyActivityOperation, publicActivityRoom, type ActivityRoom } from './state.js';
import type { PremiumAppearance } from '../features/premium.js';
const id = z.string().regex(/^\d{17,20}$/),
  hash = (value: string) => createHash('sha256').update(value).digest('hex'),
  secret = () => randomBytes(32).toString('base64url');
interface Session {
  userId: string;
  name: string;
  guildId: string;
  channelId: string;
  instanceId: string;
  roomId: string;
  expiresAt: number;
  checkedAt: number;
  lastRequest: number;
  lastWrite: number;
  epoch: number;
  featureEpoch: number;
  native: boolean;
  context?: ActionContext;
  authorizationVersion?: string;
  appearanceCache?: { value: PremiumAppearance; expiresAt: number; version: string };
}
export function createActivityService(options: {
  env: NodeJS.ProcessEnv;
  store: Store;
  client: Client;
  registry: ActionRegistry;
  allowedGuildIds: readonly string[];
  authenticate: (
    code: string,
  ) => Promise<{ accessToken: string; identity: { id: string; name: string }; expiresAt: number }>;
  now?: () => number;
  authorizeFeature?: (ctx: ActionContext, actionId: string) => Promise<unknown>;
  onNativeJoin?: (ctx: ActionContext) => Promise<void>;
  appearance?: (ctx: ActionContext) => Promise<PremiumAppearance>;
}) {
  const { env, store, client, registry } = options,
    now = options.now ?? Date.now;
  let base: URL | undefined;
  try {
    if (env.ACTIVITY_PUBLIC_URL) base = publicOrigin(env.ACTIVITY_PUBLIC_URL);
  } catch {
    /* Optional invalid origins never enable Activities. */
  }
  let closed = false,
    active = 0,
    lastPrune = 0;
  const sessions = new Map<string, Session>(),
    previews = new Map<string, Session>(),
    pending = new Map<string, { session: Session; expiresAt: number }>();
  const clientId = () => env.DISCORD_CLIENT_ID || client.application?.id || client.user?.id || '';
  const available = () => !closed && !!base && !!clientId() && !!env.DISCORD_CLIENT_SECRET;
  const allowed = (guildId: string) =>
    !options.allowedGuildIds.length || options.allowedGuildIds.includes(guildId);
  const originAllowed = (origin: string | undefined) =>
    origin === base?.origin || origin === `https://${clientId()}.discordsays.com`;
  const accessVersion = (session: Session) =>
    `${store.get<number>('premium.entitlementEpoch', 'current') ?? 0}:${store.get<number>('core.featureEpochs', `${session.guildId}:premium`) ?? 0}:${(store.get<string[]>('core.disabled', session.guildId) ?? []).includes('premium')}`;
  function prune() {
    if (lastPrune > now() - 60000) return;
    lastPrune = now();
    for (const map of [sessions, previews, pending])
      for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    for (const row of store.list<ActivityRoom>('activity.rooms'))
      if (row.value.updatedAt < now() - 7 * 86400000) store.delete('activity.rooms', row.key);
  }
  function assertSessionCurrent(session: Session): void {
    if (closed || session.expiresAt <= now() || !allowed(session.guildId))
      throw new HttpError(401, 'Activity session expired. Relaunch it in Discord.');
    if ((store.get<number>('activity.epochs', `${session.guildId}:${session.userId}`) ?? 0) !== session.epoch)
      throw new HttpError(401, 'Activity data was erased; relaunch before creating new state.');
    if (
      (store.get<string[]>('core.disabled', session.guildId) ?? []).includes('activities') ||
      (store.get<number>('core.featureEpochs', `${session.guildId}:activities`) ?? 0) !== session.featureEpoch
    )
      throw new HttpError(
        403,
        'Activities were disabled or changed in this server. Relaunch after enabling them.',
      );
  }
  async function verifyInstance(session: Session, requireConnected: boolean): Promise<void> {
    if (!client.application)
      throw new HttpError(503, 'Discord Activity application identity is unavailable.');
    const instance = await client.application.fetchActivityInstance(session.instanceId);
    assertSessionCurrent(session);
    if (
      instance.applicationId !== client.application.id ||
      instance.applicationId !== clientId() ||
      instance.instanceId !== session.instanceId ||
      instance.location.guildId !== session.guildId ||
      instance.location.channelId !== session.channelId ||
      (requireConnected && !instance.users.includes(session.userId))
    )
      throw new HttpError(403, 'Join the exact authorized Discord Activity instance first.');
  }
  async function authorize(session: Session, force = false, requireConnected = true): Promise<ActionContext> {
    assertSessionCurrent(session);
    const action = session.native ? 'activity.launch' : 'activity.preview';
    const version = accessVersion(session);
    if (
      !force &&
      session.checkedAt > now() - 5000 &&
      session.context &&
      session.authorizationVersion === version
    ) {
      registry.assertPolicy(session.context, action);
      return session.context;
    }
    // A failed fresh check cannot leave an earlier read lease usable.
    session.checkedAt = 0;
    session.authorizationVersion = undefined;
    if (session.native) await verifyInstance(session, requireConnected);
    const guild = await client.guilds.fetch(session.guildId),
      member = await guild.members.fetch({ user: session.userId, force: true }),
      ctx = await freshContext({ client, store, guild, member, channelId: session.channelId });
    const channel = await resolveChannel(ctx, session.channelId);
    if (
      [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type) &&
      ctx.member.voice.channelId !== channel.id
    )
      throw new HttpError(403, 'Join the Activity’s voice channel first.');
    await assertPermissions(ctx, [P.ReadMessageHistory], [P.ReadMessageHistory], {});
    registry.assertPolicy(ctx, action);
    if (options.authorizeFeature) {
      await options.authorizeFeature(ctx, action);
      assertSessionCurrent(session);
      const fresh = await freshContext(ctx);
      await assertPermissions(fresh, [P.ReadMessageHistory], [P.ReadMessageHistory], {});
      registry.assertPolicy(fresh, action);
      assertSessionCurrent(session);
      if (accessVersion(session) !== version)
        throw new HttpError(
          409,
          'Premium access changed during Activity authorization. Refresh before retrying.',
        );
      session.checkedAt = now();
      session.context = fresh;
      session.authorizationVersion = version;
      return fresh;
    }
    assertSessionCurrent(session);
    session.checkedAt = now();
    session.context = ctx;
    session.authorizationVersion = version;
    return ctx;
  }
  async function appearance(session: Session, ctx: ActionContext, force = false): Promise<PremiumAppearance> {
    if (!options.appearance) return {};
    const version = accessVersion(session);
    if (session.authorizationVersion !== version)
      throw new HttpError(409, 'Premium access changed. Refresh the Activity.');
    if (!force && session.appearanceCache?.version === version && session.appearanceCache.expiresAt > now())
      return session.appearanceCache.value;
    const result = await options.appearance(ctx);
    assertSessionCurrent(session);
    const fresh = await freshContext(ctx);
    await assertPermissions(fresh, [P.ReadMessageHistory], [P.ReadMessageHistory], {});
    const channel = await resolveChannel(fresh, session.channelId);
    if (
      [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type) &&
      fresh.member.voice.channelId !== channel.id
    )
      throw new HttpError(403, 'Join the Activity’s voice channel first.');
    registry.assertPolicy(fresh, session.native ? 'activity.launch' : 'activity.preview');
    assertSessionCurrent(session);
    if (accessVersion(session) !== version)
      throw new HttpError(409, 'Premium appearance changed during this request. Refresh the Activity.');
    session.appearanceCache = { value: result, expiresAt: session.checkedAt + 5000, version };
    return result;
  }
  function join(session: Session): ActivityRoom {
    assertSessionCurrent(session);
    if (session.context)
      registry.assertPolicy(session.context, session.native ? 'activity.launch' : 'activity.preview');
    const key = session.roomId;
    let room = store.get<ActivityRoom>('activity.rooms', key),
      changed = false;
    if (!room) {
      const rows = store.list<ActivityRoom>('activity.rooms');
      if (rows.length >= 1000 || rows.filter((row) => row.value.guildId === session.guildId).length >= 50)
        throw new HttpError(429, 'Activity room limit reached.');
      room = newActivityRoom(
        {
          id: key,
          guildId: session.guildId,
          channelId: session.channelId,
          instanceId: session.instanceId,
          userId: session.userId,
          name: session.name,
        },
        now(),
      );
      changed = true;
    }
    const before = room.participants.map((member) => member.id).join(':'),
      member = room.participants.find((member) => member.id === session.userId);
    if (member) {
      if (member.lastSeen <= now() - 15000 || member.name !== session.name) {
        member.lastSeen = now();
        member.name = session.name;
        changed = true;
      }
    } else {
      room.participants = room.participants.filter((member) => member.lastSeen > now() - 120000);
      if (room.participants.length >= 25) throw new HttpError(429, 'This room already has25participants.');
      room.participants.push({ id: session.userId, name: session.name, lastSeen: now() });
      changed = true;
    }
    room.participants = room.participants.filter((member) => member.lastSeen > now() - 120000);
    if (!room.participants.some((member) => member.id === room!.hostId))
      room.hostId = room.participants[0]!.id;
    if (before !== room.participants.map((member) => member.id).join(':')) {
      room.revision++;
      changed = true;
    }
    if (changed) {
      room.updatedAt = now();
      store.set('activity.rooms', key, room);
    }
    return room;
  }
  function registerActions() {
    registry.register({
      id: 'activity.launch',
      category: 'activities',
      risk: 'read',
      available,
      description:
        'Open a native Discord Activity launch button for this configured Embedded App SDK application.',
      schema: z.strictObject({}),
      userPermissions: [],
      botPermissions: [],
      execute: () => ({ activityLaunch: true }),
    });
    registry.register({
      id: 'activity.preview',
      category: 'activities',
      risk: 'write',
      available,
      description:
        'Create a private, two-minute one-use browser preview of a real shared Activity room in this authorized server/channel; do not share the sign-in link.',
      schema: z.strictObject({}),
      userPermissions: [],
      botPermissions: [],
      execute: async (ctx) => {
        prune();
        if (previews.size >= 100) throw new UserError('Too many unconsumed Activity previews.');
        const instanceId = `preview-${ctx.channelId}`,
          session: Session = {
            userId: ctx.member.id,
            name: ctx.member.user.username,
            guildId: ctx.guild.id,
            channelId: ctx.channelId,
            instanceId,
            roomId: hash(`${ctx.guild.id}:${ctx.channelId}:${instanceId}`),
            expiresAt: now() + 120000,
            checkedAt: 0,
            lastRequest: 0,
            lastWrite: 0,
            epoch: store.get<number>('activity.epochs', `${ctx.guild.id}:${ctx.member.id}`) ?? 0,
            featureEpoch: store.get<number>('core.featureEpochs', `${ctx.guild.id}:activities`) ?? 0,
            native: false,
          };
        await authorize(session, true);
        const token = secret();
        previews.set(hash(token), session);
        return { url: new URL(`/activity?preview=${token}`, base).href, expiresAt: session.expiresAt };
      },
    });
    registry.register({
      id: 'activity.rooms',
      category: 'activities',
      risk: 'read',
      available,
      description: 'List active companion Activity rooms in channels currently visible to you and the bot.',
      schema: z.strictObject({}),
      userPermissions: [],
      botPermissions: [],
      execute: async (ctx) => {
        prune();
        const result = [];
        for (const row of store.list<ActivityRoom>('activity.rooms'))
          if (row.value.guildId === ctx.guild.id) {
            try {
              await resolveChannel(ctx, row.value.channelId);
              result.push({
                id: row.key,
                channelId: row.value.channelId,
                mode: row.value.mode,
                participants: row.value.participants.length,
                updatedAt: row.value.updatedAt,
              });
            } catch {
              /* Invisible rooms are not disclosed. */
            }
          }
        return result;
      },
    });
    registry.register({
      id: 'activity.erase',
      category: 'activities',
      risk: 'destructive',
      description:
        'Remove your saved Activity strokes, tasks, markers, quiz answers, scores and participant metadata in this server.',
      schema: z.strictObject({}),
      userPermissions: [],
      botPermissions: [],
      execute: (ctx) => {
        const epochKey = `${ctx.guild.id}:${ctx.member.id}`;
        const eraseSequence = (store.get<number>('activity.eraseClock', 'sequence') ?? 0) + 1;
        store.set('activity.eraseClock', 'sequence', eraseSequence);
        store.set('activity.erasedAt', epochKey, eraseSequence);
        store.set('activity.epochs', epochKey, (store.get<number>('activity.epochs', epochKey) ?? 0) + 1);
        let count = 0;
        for (const row of store.list<ActivityRoom>('activity.rooms'))
          if (row.value.guildId === ctx.guild.id) {
            const room = row.value;
            room.strokes = room.strokes.filter((row) => row.authorId !== ctx.member.id);
            room.tasks = room.tasks.filter((row) => row.authorId !== ctx.member.id);
            room.markers = room.markers.filter((row) => row.authorId !== ctx.member.id);
            room.participants = room.participants.filter((row) => row.id !== ctx.member.id);
            delete room.scores[ctx.member.id];
            delete room.quiz.answers[ctx.member.id];
            room.board = room.board.map((value) => (value === ctx.member.id ? null : value));
            if (!room.participants.length) store.delete('activity.rooms', row.key);
            else {
              if (room.hostId === ctx.member.id) room.hostId = room.participants[0]!.id;
              if (room.turn === ctx.member.id) room.turn = room.participants[0]!.id;
              if (room.winner === ctx.member.id) delete room.winner;
              room.revision++;
              store.set('activity.rooms', row.key, room);
            }
            count++;
          }
        for (const map of [sessions, previews])
          for (const [key, value] of map)
            if (value.userId === ctx.member.id && value.guildId === ctx.guild.id) map.delete(key);
        for (const [key, value] of pending)
          if (value.session.userId === ctx.member.id && value.session.guildId === ctx.guild.id)
            pending.delete(key);
        return {
          erasedRooms: count,
          notice:
            'Shared editor text may contain identifying content supplied by participants; this action does not infer authorship within collaboratively edited text.',
        };
      },
    });
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url || '/', base?.origin || 'http://127.0.0.1');
    if (url.pathname === '/' && available()) {
      response.writeHead(302, { Location: '/activity', 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
    if (url.pathname !== '/activity' && !url.pathname.startsWith('/activity/')) return false;
    if (!available()) {
      jsonResponse(response, 503, {
        error:
          'Activities are unavailable until their public origin and Discord OAuth credentials are configured.',
      });
      return true;
    }
    if (active >= 64) {
      jsonResponse(response, 429, { error: 'Activities are busy.' });
      return true;
    }
    active++;
    try {
      if (request.headers.host !== base!.host) throw new HttpError(403, 'Unexpected Activity host.');
      prune();
      if (request.method === 'GET' && url.pathname === '/activity') {
        const bootstrap = { clientId: clientId(), preview: url.searchParams.get('preview') || null };
        const nonce = randomBytes(16).toString('base64');
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com; base-uri 'none'; form-action 'none'`,
        });
        response.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Common room · Discord Activity</title><link rel="stylesheet" href="/activity/activity.css"><body><div id="app"><p>Connecting to your shared room…</p></div><script type="application/json" id="bootstrap">${JSON.stringify(bootstrap).replaceAll('<', '\\u003c')}</script><script nonce="${nonce}" type="module" src="/activity/activity.js"></script></body></html>`,
        );
        return true;
      }
      if (
        request.method === 'GET' &&
        ['/activity/activity.js', '/activity/activity.css'].includes(url.pathname)
      ) {
        const extension = url.pathname.endsWith('.css') ? 'css' : 'js',
          data = await readFile(codePath(`dist/web/activity.${extension}`));
        if (data.length > 2 * 1048576)
          throw new HttpError(503, 'Activity asset exceeds the deployment limit.');
        response.writeHead(200, {
          'Content-Type': extension === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(data);
        return true;
      }
      if (
        request.method !== 'POST' ||
        !originAllowed(request.headers.origin) ||
        request.headers['content-type']?.split(';')[0] !== 'application/json'
      )
        throw new HttpError(403, 'Use the authorized Activity client.');
      const input: unknown = JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(await readBody(request)),
      );
      if (url.pathname === '/activity/api/auth') {
        const authEraseSequence = store.get<number>('activity.eraseClock', 'sequence') ?? 0;
        const parsed = z
          .union([
            z.strictObject({ preview: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
            z.strictObject({
              code: z.string().min(1).max(4096),
              guildId: id,
              channelId: id,
              instanceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
            }),
          ])
          .parse(input);
        if (sessions.size >= 1000 || pending.size >= 1000)
          throw new HttpError(429, 'Activity session limit reached.');
        let session: Session;
        if ('preview' in parsed) {
          const id = hash(parsed.preview),
            preview = previews.get(id);
          if (!preview || preview.expiresAt <= now())
            throw new HttpError(401, 'Private Activity preview expired.');
          previews.delete(id);
          session = { ...preview, expiresAt: now() + 900000, checkedAt: 0 };
        } else {
          if (!allowed(parsed.guildId))
            throw new HttpError(403, 'This server is unavailable for Activities.');
          const featureEpoch = store.get<number>('core.featureEpochs', `${parsed.guildId}:activities`) ?? 0;
          const auth = await options.authenticate(parsed.code);
          if (
            !id.safeParse(auth.identity.id).success ||
            (store.get<number>('activity.erasedAt', `${parsed.guildId}:${auth.identity.id}`) ?? 0) >
              authEraseSequence
          )
            throw new HttpError(
              401,
              'Activity authorization was erased while authentication was pending. Relaunch it.',
            );
          session = {
            userId: auth.identity.id,
            name: auth.identity.name,
            guildId: parsed.guildId,
            channelId: parsed.channelId,
            instanceId: parsed.instanceId,
            roomId: hash(`${parsed.guildId}:${parsed.channelId}:${parsed.instanceId}`),
            expiresAt: Math.min(now() + 900000, auth.expiresAt || Number.MAX_SAFE_INTEGER),
            checkedAt: 0,
            lastRequest: 0,
            lastWrite: 0,
            epoch: store.get<number>('activity.epochs', `${parsed.guildId}:${auth.identity.id}`) ?? 0,
            featureEpoch,
            native: true,
          };
          await authorize(session, true, false);
          if (pending.size >= 1000) throw new HttpError(429, 'Pending Activity authorization limit reached.');
          const pendingToken = secret(),
            expiresAt = Math.min(session.expiresAt, now() + 60000);
          pending.set(hash(pendingToken), { session, expiresAt });
          jsonResponse(response, 200, {
            pending: pendingToken,
            access_token: auth.accessToken,
            userId: session.userId,
            expiresAt,
          });
          return true;
        }
        const ctx = await authorize(session, true);
        const selectedAppearance = await appearance(session, ctx, true);
        if (sessions.size >= 1000) throw new HttpError(429, 'Activity session limit reached.');
        const room = join(session),
          token = secret();
        sessions.set(hash(token), session);
        jsonResponse(response, 200, {
          token,
          userId: session.userId,
          appearance: selectedAppearance,
          room: publicActivityRoom(room, session.userId, now()),
        });
        return true;
      }
      if (url.pathname === '/activity/api/join') {
        const parsed = z.strictObject({ pending: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(input),
          key = hash(parsed.pending),
          authorization = pending.get(key);
        if (!authorization || authorization.expiresAt <= now())
          throw new HttpError(401, 'Pending Activity authorization expired. Relaunch it.');
        // Claim before awaiting Discord so parallel/replayed joins cannot create extra sessions.
        pending.delete(key);
        const ctx = await authorize(authorization.session, true);
        const selectedAppearance = await appearance(authorization.session, ctx, true);
        if (authorization.expiresAt <= now() || sessions.size >= 1000)
          throw new HttpError(401, 'Activity join expired or the session limit was reached. Relaunch it.');
        // Admission charges only a claimed native join; ordinary state polling uses the pure access hook.
        await options.onNativeJoin?.(ctx);
        await authorize(authorization.session, true);
        if (authorization.expiresAt <= now() || sessions.size >= 1000)
          throw new HttpError(401, 'Activity join expired or the session limit was reached. Relaunch it.');
        const room = join(authorization.session),
          token = secret();
        sessions.set(hash(token), authorization.session);
        jsonResponse(response, 200, {
          token,
          userId: authorization.session.userId,
          appearance: selectedAppearance,
          room: publicActivityRoom(room, authorization.session.userId, now()),
        });
        return true;
      }
      if (!['/activity/api/state', '/activity/api/operation'].includes(url.pathname))
        throw new HttpError(404, 'Unknown Activity route.');
      const raw = request.headers.authorization || '';
      if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(raw))
        throw new HttpError(401, 'Activity authentication required.');
      const session = sessions.get(hash(raw.slice(7)));
      if (!session) throw new HttpError(401, 'Activity session expired.');
      const rateClock = url.pathname === '/activity/api/operation' ? 'lastWrite' : 'lastRequest',
        interval = rateClock === 'lastWrite' ? 100 : 200;
      if (session[rateClock] > now() - interval)
        throw new HttpError(429, 'Wait before the next Activity update.');
      session[rateClock] = now();
      const ctx = await authorize(session, url.pathname === '/activity/api/operation');
      const selectedAppearance = await appearance(session, ctx, url.pathname === '/activity/api/operation');
      if (
        sessions.get(hash(raw.slice(7))) !== session ||
        (store.get<number>('activity.epochs', `${session.guildId}:${session.userId}`) ?? 0) !== session.epoch
      )
        throw new HttpError(401, 'Activity session was erased.');
      let room = join(session);
      if (url.pathname === '/activity/api/operation') {
        const operation = z
          .strictObject({ revision: z.number().int().min(0), operation: z.unknown() })
          .parse(input);
        room = applyActivityOperation(room, session.userId, operation.operation, operation.revision, now());
        store.set('activity.rooms', room.id, room);
      } else if (url.pathname !== '/activity/api/state') throw new HttpError(404, 'Unknown Activity route.');
      jsonResponse(response, 200, {
        room: publicActivityRoom(room, session.userId, now()),
        userId: session.userId,
        appearance: selectedAppearance,
      });
    } catch (error) {
      jsonResponse(
        response,
        error instanceof HttpError ? error.status : error instanceof UserError ? 409 : 400,
        {
          error:
            error instanceof HttpError || error instanceof UserError
              ? error.message
              : 'Activity request was rejected; no successful change is assumed.',
        },
      );
    } finally {
      active--;
    }
    return true;
  }
  return {
    registerActions,
    handle,
    available,
    prune,
    close() {
      closed = true;
      sessions.clear();
      previews.clear();
      pending.clear();
    },
  };
}
