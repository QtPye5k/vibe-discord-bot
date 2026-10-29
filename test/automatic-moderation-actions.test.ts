import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  Collection,
  OverwriteType,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Client,
} from 'discord.js';
import { loadConfig } from '../src/config.js';
import { ActionRegistry } from '../src/core/registry.js';
import { Store } from '../src/core/store.js';
import { userRequestContext, type ActionContext } from '../src/core/types.js';
import { registerAutomaticModerationActions } from '../src/moderation/actions.js';
import { createAutomaticModeration, moderationPolicySchema } from '../src/moderation/service.js';

const G = '920000000000000001',
  USER = '920000000000000002',
  BOT = '920000000000000003',
  HONEY = '920000000000000004',
  LOG = '920000000000000005',
  OTHER = '920000000000000006';
function fixture(t: TestContext, hostEnabled = true) {
  const store = new Store(':memory:'),
    state = { userBan: true, botBan: true, fetches: 0 };
  const everyone = { id: G },
    roles = new Collection([[G, everyone]]);
  const member = {
      id: USER,
      user: { id: USER, bot: false },
      roles: { cache: new Collection() },
      get permissions() {
        return new PermissionsBitField([P.ManageGuild, ...(state.userBan ? [P.BanMembers] : [])]);
      },
    },
    bot = {
      id: BOT,
      roles: { cache: new Collection() },
      get permissions() {
        return new PermissionsBitField(state.botBan ? [P.BanMembers] : []);
      },
    };
  const makeChannel = (id: string) => ({
    id,
    guildId: G,
    type: ChannelType.GuildText,
    permissionOverwrites: {
      cache: new Collection([
        [
          G,
          {
            id: G,
            type: OverwriteType.Role,
            allow: new PermissionsBitField(0n),
            deny: new PermissionsBitField(P.ViewChannel),
          },
        ],
      ]),
    },
    permissionsFor: (principal: { id: string }) =>
      new PermissionsBitField(
        principal.id === G ? 0n : [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.ManageMessages],
      ),
  });
  const honey = makeChannel(HONEY),
    log = makeChannel(LOG);
  const guild = {
    id: G,
    ownerId: USER,
    members: { me: bot, fetchMe: async () => bot },
    roles: { everyone, cache: roles, fetch: async () => roles },
    channels: {
      fetch: async (id: string) => {
        state.fetches++;
        return id === HONEY ? honey : id === LOG ? log : null;
      },
    },
  };
  const client = { user: { id: BOT } } as Client;
  const ctx = userRequestContext(
    { store, client, guild, member, channelId: LOG } as unknown as ActionContext,
    'command',
  );
  const registry = new ActionRegistry(120, async (context) => context, { confirmationMode: 'smart' });
  const service = createAutomaticModeration({
    store,
    client,
    classify: async () => {
      throw new Error('No classifier requests are expected');
    },
  });
  registerAutomaticModerationActions(
    registry,
    service,
    loadConfig({ DATABASE_PATH: ':memory:', AUTO_MODERATION_ENABLED: String(hostEnabled) }),
  );
  t.after(async () => {
    await service.close();
    store.close();
  });
  const configure = async (input: unknown) => {
    const outcome = await registry.request(ctx, 'moderation.automatic.configure', input);
    assert.equal(outcome.status, 'confirmation');
    if (outcome.status !== 'confirmation') throw new Error('Expected one exact policy preview');
    return { preview: outcome, confirm: () => registry.confirm(ctx, outcome.id) };
  };
  return { store, state, ctx, registry, configure };
}

test('Smart mode still requires one exact policy confirmation, writes only reviewed input and rejects replay', async (t) => {
  const f = fixture(t),
    input = {
      enabled: true,
      textEnabled: false,
      imagesEnabled: false,
      honeypotChannelId: HONEY,
      logChannelId: LOG,
    };
  const request = await f.configure(input);
  assert.deepEqual(request.preview.input, input);
  assert.equal(f.store.get('moderation.automatic', G), undefined);
  const completed = await request.confirm();
  assert.equal(completed.status, 'completed');
  assert.deepEqual(f.store.get('moderation.automatic', G), moderationPolicySchema.parse(input));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
  await assert.rejects(request.confirm(), /unavailable|already|expired/);
});
test('Host-disabled automatic moderation cannot be enabled by a confirmed guild policy', async (t) => {
  const f = fixture(t, false),
    request = await f.configure({ enabled: true });
  await assert.rejects(request.confirm(), /AUTO_MODERATION_ENABLED=true/);
  assert.equal(f.store.get('moderation.automatic', G), undefined);
});
test('The honeypot and private moderation log cannot be the same channel', async (t) => {
  const f = fixture(t),
    request = await f.configure({ honeypotChannelId: HONEY, logChannelId: HONEY });
  await assert.rejects(request.confirm(), /different channels/);
  assert.equal(f.store.get('moderation.automatic', G), undefined);
  assert.equal(f.state.fetches, 0);
});
test('Enabling honeypot enforcement requires current Ban Members authority for both caller and bot', async (t) => {
  for (const principal of ['caller', 'bot'])
    await t.test(principal, async (sub) => {
      const f = fixture(sub),
        request = await f.configure({ enabled: true, honeypotChannelId: HONEY });
      if (principal === 'caller') f.state.userBan = false;
      else f.state.botBan = false;
      await assert.rejects(request.confirm(), /Both you and Vibe need Ban Members/);
      assert.equal(f.store.get('moderation.automatic', G), undefined);
    });
});
test('Disabling an existing classifier policy works without an API credential or Ban Members authority', async (t) => {
  const f = fixture(t);
  f.store.set(
    'moderation.automatic',
    G,
    moderationPolicySchema.parse({
      enabled: true,
      textEnabled: true,
      imagesEnabled: true,
      honeypotChannelId: HONEY,
    }),
  );
  f.state.userBan = false;
  f.state.botBan = false;
  const request = await f.configure({ enabled: false });
  assert.equal((await request.confirm()).status, 'completed');
  assert.equal(f.store.get<{ enabled: boolean }>('moderation.automatic', G)?.enabled, false);
  assert.equal(f.state.fetches, 0);
});
test('Status returns at most 25 recent cases from only the requesting guild', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 30; index++) {
    const key = `${G}:case-${index}`;
    f.store.set('moderation.automatic.cases', key, { guildId: G, id: `case-${index}` });
    f.store.db
      .prepare('UPDATE kv SET updated_at=? WHERE namespace=? AND key=?')
      .run(index, 'moderation.automatic.cases', key);
  }
  f.store.set('moderation.automatic.cases', `${OTHER}:private`, {
    guildId: OTHER,
    id: 'OTHER_GUILD_PRIVATE_CASE',
  });
  const result = await f.registry.request(f.ctx, 'moderation.automatic.status', {});
  assert.equal(result.status, 'completed');
  if (result.status !== 'completed') throw new Error('Expected a read result');
  const data = result.result as {
    recentCases: { guildId: string; id: string }[];
    classifierConfigured: boolean;
  };
  assert.equal(data.recentCases.length, 25);
  assert(data.recentCases.every((item) => item.guildId === G));
  assert.equal(data.recentCases[0]!.id, 'case-29');
  assert.equal(data.classifierConfigured, false);
  assert(!JSON.stringify(data).includes('OTHER_GUILD_PRIVATE_CASE'));
});
