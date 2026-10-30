import { z } from 'zod';

export type ChatCommand =
  | { kind: 'help'; query: string }
  | { kind: 'schema'; action: string }
  | { kind: 'action'; action: string; input: unknown };

/** Exact alternatives to slash commands. Other natural language goes to the typed assistant. */
export function parseChatCommand(text: string): ChatCommand | undefined {
  const input = text.trim().replace(/^\//, '');
  const simple: Record<string, string> = {
    status: 'system.status',
    forget: 'ai.memory.forget',
    'forget my data': 'ai.memory.forget',
    join: 'voice.join',
    'join me': 'voice.join',
    'join my voice channel': 'voice.join',
    leave: 'voice.leave',
    stop: 'voice.stop',
    revoke: 'voice.consent',
    'revoke consent': 'voice.consent',
    balance: 'economy.balance',
    daily: 'economy.daily',
  };
  const lower = input.toLowerCase().replace(/[.!?]+$/, '');
  if (simple[lower])
    return {
      kind: 'action',
      action: simple[lower]!,
      input: lower.startsWith('revoke') ? { enabled: false, replies: false } : {},
    };
  const help = /^help(?:\s+((?!me\b)[\s\S]+))?$/i.exec(input);
  if (help) return { kind: 'help', query: help[1] ?? '' };
  const schema = /^schema\s+([a-z][a-z0-9_.-]{1,63})$/i.exec(input);
  if (schema) return { kind: 'schema', action: schema[1]!.toLowerCase() };
  const exact = /^action\s+([a-z][a-z0-9_.-]{1,63})(?:\s+([\s\S]+))?$/i.exec(input);
  if (exact)
    return {
      kind: 'action',
      action: exact[1]!.toLowerCase(),
      input: JSON.parse(exact[2] ?? '{}') as unknown,
    };
  const speak = /^speak\s+([\s\S]+)$/i.exec(input);
  if (speak)
    return { kind: 'action', action: 'voice.speak', input: { text: z.string().max(1000).parse(speak[1]) } };
  const consent = /^consent(?:\s+(true|false|yes|no|replies|commands))?$/i.exec(input);
  if (consent)
    return {
      kind: 'action',
      action: 'voice.consent',
      input: {
        enabled: true,
        replies: !['false', 'no', 'commands'].includes(consent[1]?.toLowerCase() ?? ''),
      },
    };
  const remind = /^remind(?: me)?(?: in)?\s+(\d+)\s*(?:minutes?|mins?)\s+([\s\S]+)$/i.exec(input);
  if (remind)
    return {
      kind: 'action',
      action: 'reminder.create',
      input: {
        dueAt: new Date(
          Date.now() + z.coerce.number().int().min(1).max(525600).parse(remind[1]) * 60000,
        ).toISOString(),
        content: remind[2],
      },
    };
  const ticket = /^ticket\s+([\s\S]+)$/i.exec(input);
  if (ticket) return { kind: 'action', action: 'ticket.open', input: { subject: ticket[1] } };
  const report = /^report\s+<@!?(\d{17,20})>\s+([\s\S]+)$/i.exec(input);
  if (report)
    return { kind: 'action', action: 'report.submit', input: { userId: report[1], reason: report[2] } };
  return undefined;
}
