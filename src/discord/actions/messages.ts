import { AttachmentBuilder, MessageFlags, type Message } from 'discord.js';
import type { ActionRegistry } from '../../core/registry.js';
import { P, z, id, reason, nowReason, textWith, sendChannel, channelWith, UserError } from './shared.js';
import { readMessageRange } from '../../features/history.js';
import { resolveRole } from '../../core/permissions.js';

const target = { channelId: id, messageId: id };
const embedSchema = z.strictObject({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  url: z.url().startsWith('https://').optional(),
  fields: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(256),
        value: z.string().min(1).max(1024),
        inline: z.boolean().optional(),
      }),
    )
    .max(25)
    .optional(),
  footer: z.strictObject({ text: z.string().max(2048) }).optional(),
});
const fileSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_. -]{0,100}$/)
    .refine((v) => !v.includes('..'), 'Invalid file name'),
  base64: z
    .string()
    .min(1)
    .max(7_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  description: z.string().max(1024).optional(),
});

export function summarizeMessage(message: Message) {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    url: message.url,
    pinned: message.pinned,
    attachments: message.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      url: a.url,
    })),
    embeds: message.embeds.map((e) => ({
      title: e.title,
      description: e.description,
      url: e.url,
    })),
  };
}

async function fetchMessage(
  ctx: Parameters<typeof textWith>[0],
  input: { channelId: string; messageId: string },
  extra: bigint[] = [],
) {
  const channel = await textWith(ctx, input.channelId, [P.ReadMessageHistory, ...extra]);
  return channel.messages.fetch({ message: input.messageId, force: true });
}

export function registerMessageActions(registry: ActionRegistry): void {
  registry.register({
    id: 'message.send',
    category: 'messages',
    description:
      'Send text, embeds, permitted base64 attachments, optional TTS, silent delivery and embed suppression.',
    schema: z
      .strictObject({
        channelId: id,
        content: z.string().max(2000).optional(),
        embeds: z.array(embedSchema).max(4).optional(),
        files: z.array(fileSchema).max(2).optional(),
        tts: z.boolean().default(false),
        silent: z.boolean().default(false),
        suppressEmbeds: z.boolean().default(false),
        stickerIds: z.array(id).max(3).optional(),
        mentionUserIds: z.array(id).max(10).optional(),
        mentionRoleIds: z.array(id).max(10).optional(),
        mentionEveryone: z.boolean().default(false),
      })
      .refine(
        (v) => !!v.content || !!v.embeds?.length || !!v.files?.length || !!v.stickerIds?.length,
        'Provide message content, an embed, file, or sticker',
      ),
    userPermissions: [P.SendMessages],
    botPermissions: [P.SendMessages],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await sendChannel(ctx, input.channelId);
      if (input.embeds?.length) await channelWith(ctx, input.channelId, [P.EmbedLinks]);
      if (input.files?.length) await channelWith(ctx, input.channelId, [P.AttachFiles]);
      if (input.tts) await channelWith(ctx, input.channelId, [P.SendTTSMessages]);
      for (const userId of input.mentionUserIds ?? [])
        await ctx.guild.members.fetch({ user: userId, force: true });
      for (const roleId of input.mentionRoleIds ?? []) {
        const role = await resolveRole(ctx, roleId);
        if (!role.mentionable) await channelWith(ctx, input.channelId, [P.MentionEveryone]);
      }
      if (input.mentionEveryone) await channelWith(ctx, input.channelId, [P.MentionEveryone]);
      if (input.embeds && JSON.stringify(input.embeds).length > 6000)
        throw new UserError('Combined embed text must fit Discord’s 6,000 character limit.');
      const files = input.files?.map(
        (file) =>
          new AttachmentBuilder(Buffer.from(file.base64, 'base64'), {
            name: file.name,
            description: file.description,
          }),
      );
      if (files && files.some((file) => Buffer.byteLength(file.attachment as Buffer) > 5_000_000))
        throw new UserError('Files are limited to 5 MB each.');
      const flags =
        (input.silent ? MessageFlags.SuppressNotifications : 0) |
        (input.suppressEmbeds ? MessageFlags.SuppressEmbeds : 0);
      return summarizeMessage(
        await channel.send({
          content: input.content,
          embeds: input.embeds,
          files,
          stickers: input.stickerIds,
          tts: input.tts,
          flags,
          allowedMentions: {
            parse: input.mentionEveryone ? ['everyone'] : [],
            ...(input.mentionUserIds?.length ? { users: input.mentionUserIds } : {}),
            ...(input.mentionRoleIds?.length ? { roles: input.mentionRoleIds } : {}),
            repliedUser: false,
          },
        }),
      );
    },
  });
  registry.register({
    id: 'message.search',
    category: 'messages',
    risk: 'read',
    description:
      'Search a resumable accessible message-history range, returning a cursor until the requested history is exhausted.',
    schema: z.strictObject({
      channelId: id,
      query: z.string().min(1).max(200),
      authorId: id.optional(),
      before: id.optional(),
      after: id.optional(),
      maxMessages: z.number().int().min(1).max(5000).default(1000),
    }),
    userPermissions: [P.ReadMessageHistory],
    botPermissions: [P.ReadMessageHistory],
    execute: (ctx, input) => readMessageRange(ctx, input.channelId, input),
  });
  registry.register({
    id: 'message.history-export',
    category: 'messages',
    risk: 'read',
    description:
      'Export an accessible history range with source IDs, replies, attachments and a resumable continuation cursor.',
    schema: z.strictObject({
      channelId: id,
      before: id.optional(),
      after: id.optional(),
      maxMessages: z.number().int().min(1).max(5000).default(1000),
    }),
    userPermissions: [P.ReadMessageHistory],
    botPermissions: [P.ReadMessageHistory],
    execute: async (ctx, input) => ({
      attachment: Buffer.from(JSON.stringify(await readMessageRange(ctx, input.channelId, input))),
      name: `history-${input.channelId}.json`,
    }),
  });
  registry.register({
    id: 'message.read',
    category: 'messages',
    description: 'Read one current message in an accessible channel.',
    schema: z.strictObject(target),
    userPermissions: [P.ReadMessageHistory],
    botPermissions: [P.ReadMessageHistory],
    risk: 'read',
    execute: async (ctx, input) => summarizeMessage(await fetchMessage(ctx, input)),
  });
  registry.register({
    id: 'message.history',
    category: 'messages',
    description: 'Read up to 100 accessible messages with optional pagination.',
    schema: z.strictObject({
      channelId: id,
      limit: z.number().int().min(1).max(100).default(30),
      before: id.optional(),
      after: id.optional(),
    }),
    userPermissions: [P.ReadMessageHistory],
    botPermissions: [P.ReadMessageHistory],
    risk: 'read',
    execute: async (ctx, { channelId, ...options }) => {
      if (options.before && options.after) throw new UserError('Use either before or after pagination.');
      const channel = await textWith(ctx, channelId, [P.ReadMessageHistory]);
      return (await channel.messages.fetch({ ...options, cache: false })).map(summarizeMessage);
    },
  });
  registry.register({
    id: 'message.search-recent',
    category: 'messages',
    description: 'Case-insensitive search within the last 100 accessible channel messages.',
    schema: z.strictObject({
      channelId: id,
      query: z.string().min(1).max(200),
      authorId: id.optional(),
    }),
    userPermissions: [P.ReadMessageHistory],
    botPermissions: [P.ReadMessageHistory],
    risk: 'read',
    execute: async (ctx, input) => {
      const channel = await textWith(ctx, input.channelId, [P.ReadMessageHistory]);
      const messages = await channel.messages.fetch({
        limit: 100,
        cache: false,
      });
      return {
        scope: 'Most recent 100 messages only',
        matches: messages
          .filter(
            (m) =>
              (!input.authorId || m.author.id === input.authorId) &&
              m.content.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()),
          )
          .map(summarizeMessage),
      };
    },
  });
  registry.register({
    id: 'message.reply',
    category: 'messages',
    description: 'Reply to an accessible message without pinging its author.',
    schema: z.strictObject({ ...target, content: z.string().min(1).max(2000) }),
    userPermissions: [P.SendMessages, P.ReadMessageHistory],
    botPermissions: [P.SendMessages, P.ReadMessageHistory],
    risk: 'write',
    execute: async (ctx, input) => {
      await sendChannel(ctx, input.channelId);
      const message = await fetchMessage(ctx, input);
      return summarizeMessage(
        await message.reply({
          content: input.content,
          allowedMentions: { parse: [], repliedUser: false },
        }),
      );
    },
  });
  registry.register({
    id: 'message.edit',
    category: 'messages',
    description: 'Edit the bot’s own message in an accessible channel.',
    schema: z.strictObject({ ...target, content: z.string().min(1).max(2000) }),
    userPermissions: [P.ManageMessages],
    botPermissions: [],
    risk: 'write',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input);
      if (message.author.id !== ctx.client.user?.id)
        throw new UserError('Only this bot’s own messages may be edited.');
      return summarizeMessage(
        await message.edit({
          content: input.content,
          allowedMentions: { parse: [], repliedUser: false },
        }),
      );
    },
  });
  registry.register({
    id: 'message.delete',
    category: 'messages',
    description: 'Delete one accessible message with moderation authorization.',
    schema: z.strictObject(target),
    userPermissions: [P.ManageMessages],
    botPermissions: [P.ManageMessages],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input, [P.ManageMessages]);
      await message.delete();
      return { deletedMessageId: input.messageId };
    },
  });
  registry.register({
    id: 'message.bulk-delete',
    category: 'messages',
    description: 'Delete 2–100 explicit unique message IDs, all less than two weeks old.',
    schema: z.strictObject({
      channelId: id,
      messageIds: z
        .array(id)
        .min(2)
        .max(100)
        .refine(
          (values) => new Set(values).size === values.length,
          'Duplicate message IDs are not permitted',
        ),
    }),
    userPermissions: [P.ManageMessages],
    botPermissions: [P.ManageMessages],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const channel = await textWith(ctx, input.channelId, [P.ManageMessages, P.ReadMessageHistory]);
      if (!('bulkDelete' in channel)) throw new UserError('This channel does not support bulk deletion.');
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      for (const messageId of input.messageIds) {
        const timestamp = Number((BigInt(messageId) >> 22n) + 1420070400000n);
        if (timestamp <= cutoff || timestamp > Date.now() + 60_000)
          throw new UserError('Every message must be less than two weeks old and have a valid timestamp.');
      }
      const deleted = await channel.bulkDelete(input.messageIds, false);
      return { deleted: deleted.size, messageIds: [...deleted.keys()] };
    },
  });
  for (const operation of ['pin', 'unpin'] as const)
    registry.register({
      id: `message.${operation}`,
      category: 'messages',
      description: `${operation === 'pin' ? 'Pin' : 'Unpin'} an accessible message.`,
      schema: z.strictObject({ ...target, reason }),
      userPermissions: [P.PinMessages],
      botPermissions: [P.PinMessages],
      risk: 'write',
      execute: async (ctx, input) => {
        const message = await fetchMessage(ctx, input, [P.PinMessages]);
        await message[operation](nowReason(ctx, input.reason));
        return { messageId: input.messageId, pinned: operation === 'pin' };
      },
    });
  registry.register({
    id: 'message.pins',
    category: 'messages',
    description: 'Read up to 50 currently pinned messages using the current pins endpoint.',
    schema: z.strictObject({
      channelId: id,
      limit: z.number().int().min(1).max(50).default(50),
    }),
    userPermissions: [P.ReadMessageHistory],
    botPermissions: [P.ReadMessageHistory],
    risk: 'read',
    execute: async (ctx, input) => {
      const channel = await textWith(ctx, input.channelId, [P.ReadMessageHistory]);
      const pins = await channel.messages.fetchPins({ limit: input.limit });
      return {
        hasMore: pins.hasMore,
        items: pins.items.map((pin) => ({
          pinnedAt: pin.pinnedAt.toISOString(),
          message: summarizeMessage(pin.message),
        })),
      };
    },
  });
  registry.register({
    id: 'message.react',
    category: 'messages',
    description: 'Add a Unicode or accessible custom emoji reaction.',
    schema: z.strictObject({ ...target, emoji: z.string().min(1).max(100) }),
    userPermissions: [P.AddReactions],
    botPermissions: [P.AddReactions],
    risk: 'write',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input, [P.AddReactions]);
      const result = await message.react(input.emoji);
      return { messageId: input.messageId, emoji: result.emoji.identifier };
    },
  });
  registry.register({
    id: 'message.reaction-remove',
    category: 'messages',
    description: 'Remove one member’s reaction, or the bot’s own reaction.',
    schema: z.strictObject({
      ...target,
      emoji: z.string().min(1).max(100),
      userId: id.optional(),
    }),
    userPermissions: [P.ManageMessages],
    botPermissions: [P.ManageMessages],
    risk: 'write',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input, [P.ManageMessages]);
      const reaction = message.reactions.cache.find(
        (r) =>
          r.emoji.name === input.emoji || r.emoji.id === input.emoji || r.emoji.identifier === input.emoji,
      );
      if (!reaction) throw new UserError('Matching reaction does not exist.');
      await reaction.users.remove(input.userId ?? ctx.client.user!.id);
      return { removed: true };
    },
  });
  registry.register({
    id: 'message.reactions-clear',
    category: 'messages',
    description: 'Remove all reactions from an accessible message.',
    schema: z.strictObject(target),
    userPermissions: [P.ManageMessages],
    botPermissions: [P.ManageMessages],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input, [P.ManageMessages]);
      await message.reactions.removeAll();
      return { cleared: true };
    },
  });
  registry.register({
    id: 'message.typing',
    category: 'messages',
    description: 'Display a typing indicator in an accessible channel.',
    schema: z.strictObject({ channelId: id }),
    userPermissions: [P.SendMessages],
    botPermissions: [P.SendMessages],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await sendChannel(ctx, input.channelId);
      await channel.sendTyping();
      return { typing: true };
    },
  });
  registry.register({
    id: 'message.suppress-embeds',
    category: 'messages',
    description: 'Suppress or restore link embeds on an accessible message.',
    schema: z.strictObject({ ...target, suppressed: z.boolean() }),
    userPermissions: [P.ManageMessages],
    botPermissions: [P.ManageMessages],
    risk: 'write',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input, [P.ManageMessages]);
      await message.suppressEmbeds(input.suppressed);
      return { suppressed: input.suppressed };
    },
  });
  registry.register({
    id: 'message.crosspost',
    category: 'messages',
    description: 'Publish a supported announcement message to followers.',
    schema: z.strictObject(target),
    userPermissions: [P.ManageMessages],
    botPermissions: [P.ManageMessages],
    risk: 'write',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input, [P.ManageMessages]);
      if (!message.crosspostable) throw new UserError('This message cannot be crossposted.');
      return summarizeMessage(await message.crosspost());
    },
  });
  registry.register({
    id: 'message.forward',
    category: 'messages',
    description: 'Forward a supported accessible message to another authorized channel.',
    schema: z.strictObject({
      sourceChannelId: id,
      messageId: id,
      channelId: id,
    }),
    userPermissions: [P.SendMessages, P.ReadMessageHistory],
    botPermissions: [P.SendMessages, P.ReadMessageHistory],
    risk: 'write',
    execute: async (ctx, input) => {
      const source = await fetchMessage(ctx, {
        channelId: input.sourceChannelId,
        messageId: input.messageId,
      });
      const destination = await sendChannel(ctx, input.channelId);
      return summarizeMessage(await source.forward(destination));
    },
  });
  registry.register({
    id: 'poll.create',
    category: 'polls',
    description: 'Create a native Discord poll with 2–10 answer choices.',
    schema: z.strictObject({
      channelId: id,
      question: z.string().min(1).max(300),
      answers: z.array(z.string().min(1).max(55)).min(2).max(10),
      durationHours: z.number().int().min(1).max(768).default(24),
      multiple: z.boolean().default(false),
    }),
    userPermissions: [P.SendPolls, P.SendMessages],
    botPermissions: [P.SendPolls, P.SendMessages],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await sendChannel(ctx, input.channelId);
      await channelWith(ctx, input.channelId, [P.SendPolls]);
      return summarizeMessage(
        await channel.send({
          poll: {
            question: { text: input.question },
            answers: input.answers.map((text) => ({ text })),
            duration: input.durationHours,
            allowMultiselect: input.multiple,
          },
          allowedMentions: { parse: [] },
        }),
      );
    },
  });
  registry.register({
    id: 'poll.end',
    category: 'polls',
    description: 'End one native poll created by this bot.',
    schema: z.strictObject(target),
    userPermissions: [P.ManageMessages],
    botPermissions: [],
    risk: 'write',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input);
      if (message.author.id !== ctx.client.user?.id || !message.poll)
        throw new UserError('Requires a native poll created by this bot.');
      await message.poll.end();
      return { ended: true };
    },
  });
  registry.register({
    id: 'poll.results',
    category: 'polls',
    description: 'Read native poll questions, answers and available vote counts.',
    schema: z.strictObject(target),
    userPermissions: [P.ReadMessageHistory],
    botPermissions: [P.ReadMessageHistory],
    risk: 'read',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input);
      if (!message.poll) throw new UserError('Message does not contain a poll.');
      return {
        question: message.poll.question.text,
        expiresAt: message.poll.expiresAt?.toISOString(),
        finalized: message.poll.resultsFinalized,
        answers: message.poll.answers.map((a) => ({
          id: a.id,
          text: a.text,
          emoji: a.emoji?.toString(),
          voteCount: a.voteCount,
        })),
      };
    },
  });
  registry.register({
    id: 'poll.voters',
    category: 'polls',
    description: 'Read up to 100 available voters for one native poll answer.',
    schema: z.strictObject({
      ...target,
      answerId: z.number().int().min(1).max(10),
      limit: z.number().int().min(1).max(100).default(100),
      after: id.optional(),
    }),
    userPermissions: [P.ReadMessageHistory],
    botPermissions: [P.ReadMessageHistory],
    risk: 'read',
    execute: async (ctx, input) => {
      const message = await fetchMessage(ctx, input);
      const answer = message.poll?.answers.get(input.answerId);
      if (!answer) throw new UserError('Poll answer does not exist.');
      return (await answer.voters.fetch({ limit: input.limit, after: input.after })).map((user) => ({
        id: user.id,
        username: user.username,
      }));
    },
  });
}
