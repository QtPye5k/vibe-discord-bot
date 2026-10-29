import type { ActionContext } from '../core/types.js';
import type { ActionRegistry } from '../core/registry.js';
import type { VoiceService } from '../features/voice.js';
import { outcomePayload, textPayload, type BotPayload } from './presentation.js';

/** Deliberately small spoken allowlist. Speech cannot select arbitrary action IDs. */
export async function routeVoiceCommand(
  ctx: ActionContext,
  text: string,
  voice: Pick<VoiceService, 'stop' | 'consent'>,
  registry: ActionRegistry,
): Promise<BotPayload | undefined> {
  const original = text
    .normalize('NFKC')
    .trim()
    .replace(/[.!?]+$/u, '');
  const command = original.toLowerCase();
  if (command === 'stop') return textPayload(voice.stop(ctx));
  if (command === 'revoke' || command === 'revoke consent') return textPayload(voice.consent(ctx, false));
  if (['pause', 'resume', 'skip', 'status'].includes(command))
    return outcomePayload(await registry.request(ctx, `voice.${command}`, {}));
  if (command === 'trivia' || command === 'start trivia')
    return outcomePayload(await registry.request(ctx, 'voice.trivia-start', {}));
  if (command === 'stop trivia') return outcomePayload(await registry.request(ctx, 'voice.trivia-stop', {}));
  if (command.startsWith('answer ') && original.length <= 107)
    return outcomePayload(
      await registry.request(ctx, 'voice.trivia-answer', { answer: original.slice(7).trim() }),
    );
  if (command.startsWith('say ') && original.length <= 1004)
    return outcomePayload(await registry.request(ctx, 'voice.speak', { text: original.slice(4).trim() }));
  const volume = /^volume(?: to)? (\d{1,3})(?: percent|%)?$/.exec(command);
  if (volume && Number(volume[1]) <= 100)
    return outcomePayload(await registry.request(ctx, 'voice.volume', { value: Number(volume[1]) / 100 }));
  return undefined;
}
