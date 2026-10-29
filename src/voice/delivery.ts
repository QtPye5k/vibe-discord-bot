import { Events, MessagePayload, Routes, type MessageCreateOptions, type SendableChannels } from 'discord.js';

/** Unlike channel.send, this passes cancellation into Discord's queued REST request. */
export async function sendVoiceMessage(
  channel: SendableChannels,
  options: MessageCreateOptions,
  signal: AbortSignal,
  current: () => void = () => signal.throwIfAborted(),
): Promise<void> {
  signal.throwIfAborted();
  const payload = MessagePayload.create(channel, options).resolveBody();
  await payload.resolveFiles();
  current();
  signal.throwIfAborted();
  const authority = new AbortController(),
    requestSignal = AbortSignal.any([signal, authority.signal]),
    check = () => {
      try {
        current();
      } catch (error) {
        authority.abort(error);
      }
    },
    events = [
      Events.ChannelUpdate,
      Events.GuildRoleUpdate,
      Events.GuildMemberUpdate,
      Events.GuildUpdate,
    ] as const;
  // An SDK bucket can queue a send after the final fetch. Revoke that queued request
  // as soon as cached access changes, and also observe time-based/local lease changes.
  for (const event of events) channel.client.on(event, check);
  const monitor = setInterval(check, 100);
  monitor.unref();
  try {
    check();
    requestSignal.throwIfAborted();
    await channel.client.rest.post(Routes.channelMessages(channel.id), {
      body: payload.body,
      files: payload.files ?? undefined,
      signal: requestSignal,
    });
  } finally {
    clearInterval(monitor);
    for (const event of events) channel.client.off(event, check);
  }
}
