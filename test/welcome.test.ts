import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  Events,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
} from 'discord.js';
import { bindEvents, createServices } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { onMemberJoin, settings } from '../src/features/community.js';
import { formatWelcomeTemplate, welcomePayload } from '../src/features/welcome.js';
import { onMediaMemberJoin } from '../src/features/media-workflows.js';
const G = '960000000000000001',
  U = '960000000000000002',
  B = '960000000000000003',
  C = '960000000000000004',
  RULES = '960000000000000005';
function fixture(t: TestContext) {
  const services = createServices(loadConfig({ DATABASE_PATH: ':memory:', ENABLE_VOICE: 'false' }), {
      store: new Store(':memory:'),
    }),
    sent: MessageCreateOptions[] = [],
    state = {
      canSend: true,
      canEmbed: true,
      canView: true,
      failSend: false,
      botJoin: false,
      joinedAt: 1800000000000,
      beforeChannel: undefined as (() => void) | undefined,
      roleAdds: 0,
    };
  services.logger.error = () => {};
  services.logger.info = () => {};
  const bot = {
      id: B,
      permissions: new PermissionsBitField(P.Administrator),
      guild: { id: G },
      roles: { cache: new Collection() },
    },
    member = {
      id: U,
      displayName: 'New Member',
      client: services.client,
      user: {
        id: U,
        username: 'New_User',
        get bot() {
          return state.botJoin;
        },
      },
      get joinedTimestamp() {
        return state.joinedAt;
      },
      permissions: new PermissionsBitField(P.ManageGuild),
      roles: {
        cache: new Collection(),
        add: async () => {
          state.roleAdds++;
        },
      },
      displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${U}/avatar.png?size=256`,
    };
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    isThread: () => false,
    isSendable: () => true,
    permissionsFor: (principal: { id: string }) =>
      new PermissionsBitField(
        principal.id === B
          ? [
              P.ViewChannel,
              ...(state.canSend ? [P.SendMessages] : []),
              ...(state.canEmbed ? [P.EmbedLinks] : []),
            ]
          : state.canView
            ? [P.ViewChannel]
            : [],
      ),
    send: async (payload: MessageCreateOptions) => {
      sent.push(payload);
      if (state.failSend) throw new Error('unknown transport result');
      return { id: `welcome-${sent.length}` };
    },
  };
  const guild = {
    id: G,
    name: 'Aura',
    memberCount: 42,
    ownerId: U,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: {
      cache: new Collection([[C, channel]]),
      fetch: async () => {
        state.beforeChannel?.();
        return channel;
      },
    },
  } as unknown as Guild;
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  Object.defineProperty(services.client, 'user', { value: { id: B }, configurable: true });
  services.client.guilds.cache.set(G, guild);
  const configure = (patch: Record<string, unknown> = {}) =>
    services.store.set('community.settings', G, {
      ...settings(services.store, G),
      welcomeChannelId: C,
      welcomeTemplate: `Welcome {user} to {server}! Read <#${RULES}>.`,
      welcomeTitle: 'Welcome to {server}!',
      welcomeColor: '#8b5cf6',
      ...patch,
    });
  configure();
  let stop: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stop?.();
    await services.close();
  });
  return {
    services,
    state,
    sent,
    guild,
    member: member as unknown as GuildMember,
    configure,
    bind: () => {
      stop ??= bindEvents(services);
    },
    drain: async () => {
      await stop?.();
    },
    join: () => onMemberJoin(member as unknown as GuildMember, services.store),
  };
}
const embed = (payload: MessageCreateOptions) =>
  (
    payload.embeds![0] as {
      toJSON(): {
        title: string;
        description: string;
        color: number;
        thumbnail: { url: string };
        footer: { text: string };
        timestamp: string;
      };
    }
  ).toJSON();

test('A human GuildMemberAdd event sends one styled welcome with avatar, member count, links and only the new-member mention', async (t) => {
  const f = fixture(t);
  f.bind();
  // A legacy image policy must not create a second welcome beside the configured embed.
  f.services.store.set('media.welcomePolicy', G, {
    authorId: U,
    channelId: C,
    version: 'old',
    background: '#111827',
    accent: '#8b5cf6',
  });
  f.services.client.emit(Events.GuildMemberAdd, f.member);
  f.services.client.emit(Events.GuildMemberAdd, f.member);
  await f.drain();
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.roleAdds, 0);
  const body = embed(f.sent[0]!);
  assert.equal(body.title, 'Welcome to Aura!');
  assert.match(body.description, new RegExp(`Welcome <@${U}>.*<#${RULES}>`));
  assert.match(body.thumbnail.url, /cdn.discordapp.com\/avatars/);
  assert.equal(body.footer.text, 'Member #42');
  assert.equal(body.color, 0x8b5cf6);
  assert.equal(body.timestamp, new Date(f.state.joinedAt).toISOString());
  assert.deepEqual(f.sent[0]!.allowedMentions, { parse: [], users: [U] });
});
test('Duplicate join events are suppressed while a genuinely new join timestamp is welcomed again', async (t) => {
  const f = fixture(t);
  await Promise.all([f.join(), f.join()]);
  assert.equal(f.sent.length, 1);
  f.state.joinedAt += 1000;
  await f.join();
  assert.equal(f.sent.length, 2);
});
test('Bot joins are ignored and a staff human does not ping staff roles or everyone', async (t) => {
  const f = fixture(t);
  f.state.botJoin = true;
  await f.join();
  assert.equal(f.sent.length, 0);
  f.state.botJoin = false;
  f.configure({ welcomeTemplate: 'Hi {user}, @everyone <@&960000000000000099>' });
  await f.join();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0]!.allowedMentions, { parse: [], users: [U] });
});
test('Current send/embed/member visibility permissions and a disabled community feature stop delivery without a public fallback', async (t) => {
  for (const kind of ['send', 'embed', 'view', 'disabled'])
    await t.test(kind, async (sub) => {
      const f = fixture(sub);
      f.state.beforeChannel = () => {
        if (kind === 'send') f.state.canSend = false;
        if (kind === 'embed') f.state.canEmbed = false;
        if (kind === 'view') f.state.canView = false;
        if (kind === 'disabled') f.services.store.set('core.disabled', G, ['community']);
      };
      await f.join();
      assert.deepEqual(f.sent, []);
      assert.equal(f.services.store.list('community.welcomeSeen').length, 0);
    });
});
test('An edited welcome policy during destination resolution is not sent', async (t) => {
  const f = fixture(t);
  f.state.beforeChannel = () => f.configure({ welcomeChannelId: null });
  await f.join();
  assert.deepEqual(f.sent, []);
  assert.equal(f.services.store.list('community.welcomeSeen').length, 0);
});
test('A disabled community welcome does not suppress the independently enabled legacy media welcome', async (t) => {
  const f = fixture(t);
  f.services.store.set('core.disabled', G, ['community']);
  f.services.store.set('media.welcomePolicy', G, {
    authorId: U,
    channelId: C,
    version: 'old',
    background: '#111827',
    accent: '#8b5cf6',
  });
  // This fixture deliberately withholds the manager's Send Messages grant. Reaching
  // this existing media access error proves the active-community overlap guard did not suppress it.
  await assert.rejects(
    onMediaMemberJoin(f.services.client, f.services.store, f.services.registry, f.member),
    /Welcome channel is not writable/,
  );
  assert.equal(f.sent.length, 0);
});
test('An uncertain welcome send keeps its durable claim and is not automatically duplicated', async (t) => {
  const f = fixture(t);
  f.state.failSend = true;
  await f.join();
  await f.join();
  assert.equal(f.sent.length, 1);
  const claim = f.services.store.list<{ state: string }>('community.welcomeSeen')[0]!;
  assert.equal(claim.value.state, 'uncertain');
});
test('Text-only welcomes need no Embed Links grant and can disable even the new-member notification', async (t) => {
  const f = fixture(t);
  f.state.canEmbed = false;
  f.configure({ welcomeStyle: 'text', welcomeMention: false });
  await f.join();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.embeds, undefined);
  assert.deepEqual(f.sent[0]!.allowedMentions, { parse: [], users: [] });
});
test('Welcome template substitution is one-pass and formatted payloads stay inside Discord text bounds', async (t) => {
  const f = fixture(t);
  f.member.user.username = '{server}';
  assert.equal(
    formatWelcomeTemplate('{name} / {unknown} / {memberCount}', f.member),
    '{server} / {unknown} / 42',
  );
  const body = welcomePayload(f.member, {
    ...settings(f.services.store, G),
    welcomeTemplate: '{server}'.repeat(180),
    welcomeTitle: '{server}'.repeat(30),
  });
  assert(embed(body).description.length <= 1900);
  assert(embed(body).title.length <= 256);
});
test('Configuring welcome presentation preserves existing spam settings and unrelated later patches preserve the welcome', async (t) => {
  const f = fixture(t);
  f.configure({ antiSpamEnabled: true, repeatLimit: 3, antiSpamExemptStaff: false });
  const action = f.services.registry.get('community.configure'),
    ctx = {
      client: f.services.client,
      guild: f.guild,
      member: f.member,
      channelId: C,
      store: f.services.store,
    };
  await action.execute(
    ctx,
    action.schema.parse({ welcomeStyle: 'embed', welcomeColor: '#a855f7', welcomeMention: false }),
  );
  await action.execute(ctx, action.schema.parse({ xpEnabled: true }));
  const current = settings(f.services.store, G);
  assert.equal(current.repeatLimit, 3);
  assert.equal(current.antiSpamEnabled, true);
  assert.equal(current.antiSpamExemptStaff, false);
  assert.equal(current.welcomeColor, '#a855f7');
  assert.equal(current.welcomeMention, false);
  assert.equal(current.welcomeChannelId, C);
});
