import { randomBytes } from 'node:crypto';
import { MessageFlags, ButtonBuilder, ActionRowBuilder, ButtonStyle, type Interaction } from 'discord.js';
import { z } from 'zod';
import type { Services } from '../app.js';
import { UserError } from '../core/errors.js';
import { identityContext, personalConsentCurrent } from '../features/identity.js';
import { forgetAiData } from '../features/ai.js';
import { aiPayload, textPayload, type BotPayload } from './presentation.js';
import { personalCommandNames } from './commands.js';
interface Erasure {
  userId: string;
  channelId: string;
  expiresAt: number;
}
export function forgetPersonalAi(
  services: Pick<Services, 'store'> & Partial<Pick<Services, 'resetAiVoice'>>,
  userId: string,
): number {
  const deleted = forgetAiData(services.store, userId);
  services.resetAiVoice?.(userId);
  return deleted;
}
/** Guild-free routes expose help and personal AI; they never create a synthetic guild or administrative context. */
export async function handlePersonalInteraction(
  services: Services,
  interaction: Interaction,
  help: (query?: string, page?: number) => BotPayload,
): Promise<boolean> {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== 'schema') {
      await interaction.respond([]);
      return true;
    }
    const query = String(interaction.options.getFocused()).toLowerCase();
    await interaction.respond(
      services.registry
        .list()
        .filter((action) => `${action.id} ${action.description}`.toLowerCase().includes(query))
        .slice(0, 25)
        .map((action) => ({ name: `${action.id} — ${action.description}`.slice(0, 100), value: action.id })),
    );
    return true;
  }
  if (interaction.isButton() && interaction.customId.startsWith('help:')) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [, page, query] = interaction.customId.split(':');
    await interaction.editReply(help(decodeURIComponent(query ?? ''), Number(page) || 0));
    return true;
  }
  if (interaction.isButton() && interaction.customId.startsWith('personal:forget:')) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = `${interaction.user.id}:${interaction.customId.slice('personal:forget:'.length)}`,
      pending = services.store.get<Erasure>('privacy.personal', key);
    if (
      !pending ||
      pending.userId !== interaction.user.id ||
      pending.channelId !== interaction.channelId ||
      pending.expiresAt < Date.now()
    )
      throw new UserError('This personal erasure confirmation is unavailable or expired.');
    services.store.delete('privacy.personal', key);
    const count = forgetPersonalAi(services, interaction.user.id);
    await interaction.editReply(
      textPayload(
        `Deleted ${count} of your saved AI records across servers. Pending AI responses will be discarded.`,
      ),
    );
    return true;
  }
  if (!interaction.isChatInputCommand() || !personalCommandNames.has(interaction.commandName)) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let payload: BotPayload;
  switch (interaction.commandName) {
    case 'help':
      payload = help();
      break;
    case 'schema': {
      const action = services.registry.get(interaction.options.getString('name', true));
      payload = textPayload(
        JSON.stringify(
          {
            action: action.id,
            description: action.description,
            risk: action.risk,
            schema: z.toJSONSchema(action.schema, { io: 'input' }),
          },
          null,
          2,
        ),
      );
      break;
    }
    case 'status':
      payload = textPayload(
        JSON.stringify(
          {
            ready: services.client.isReady(),
            aiAvailable: services.ai.available,
            uptimeSeconds: Math.floor(process.uptime()),
            personalCommands: true,
          },
          null,
          2,
        ),
      );
      break;
    case 'forget': {
      if (!interaction.channelId) throw new UserError('A channel is required to confirm personal erasure.');
      const now = Date.now();
      for (const row of services.store.list<Erasure>('privacy.personal', `${interaction.user.id}:`))
        services.store.delete('privacy.personal', row.key);
      const token = randomBytes(12).toString('base64url');
      services.store.set('privacy.personal', `${interaction.user.id}:${token}`, {
        userId: interaction.user.id,
        channelId: interaction.channelId,
        expiresAt: now + 120000,
      } satisfies Erasure);
      payload = textPayload(
        'Confirm deleting your saved AI conversations, preferences and private knowledge across all servers. This expires in two minutes.',
        [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`personal:forget:${token}`)
              .setLabel('Delete my saved AI data')
              .setStyle(ButtonStyle.Danger),
          ),
        ],
      );
      break;
    }
    case 'ask': {
      if (!interaction.channelId) throw new UserError('A channel is required.');
      const ctx = await identityContext(
        services.client,
        services.store,
        interaction.user.id,
        interaction.channelId,
        services.config.guildIds,
      );
      const consent = services.store.get<{ createdAt: number; version?: string }>(
        'notifications.consent',
        `${ctx.guild.id}:${interaction.user.id}`,
      );
      const file = interaction.options.getAttachment('file');
      const reply = await services.ai.chat(
        ctx,
        interaction.options.getString('prompt', true),
        file ? { url: file.url, name: file.name, contentType: file.contentType } : undefined,
        false,
        { memoryScope: 'personal-command' },
      );
      if (!consent || !personalConsentCurrent(services.store, ctx.guild.id, interaction.user.id, consent))
        throw new UserError('Personal responses were cancelled after your notification preferences changed.');
      payload = aiPayload(reply);
      break;
    }
    default:
      return false;
  }
  await interaction.editReply({ ...payload, content: payload.content ?? undefined });
  return true;
}
