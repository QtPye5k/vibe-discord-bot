import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandOptionType, ApplicationCommandType } from 'discord.js';
import { commandDefinitions, resolveSlashCommandName } from '../src/discord/commands.js';

interface Definition {
  name: string;
  type?: number;
  description?: string;
  name_localizations?: Record<string, string>;
  description_localizations?: Record<string, string>;
  options?: (Definition & { required?: boolean; autocomplete?: boolean; max_length?: number })[];
}
const definitions = () => commandDefinitions() as Definition[];
const options = (group: string | null, subcommand: string | null) => ({
  getSubcommandGroup: () => group,
  getSubcommand: () => subcommand,
});

test('structured command groups preserve existing exact action input and autocomplete', () => {
  const bot = definitions().find((command) => command.name === 'bot')!;
  assert.equal(bot.options?.length, 2);
  const group = bot.options!.find((item) => item.name === 'actions')!;
  assert.equal(group.type, ApplicationCommandOptionType.SubcommandGroup);
  const run = group.options!.find((item) => item.name === 'run')!;
  assert.equal(run.type, ApplicationCommandOptionType.Subcommand);
  assert.deepEqual(
    run.options!.map((item) => item.name),
    ['name', 'input', 'input_file'],
  );
  assert.equal(run.options![0]!.required, true);
  assert.equal(run.options![0]!.autocomplete, true);
  assert.equal(run.options![1]!.max_length, 6000);
  assert.equal(run.options![2]!.type, ApplicationCommandOptionType.Attachment);
  const schema = group.options!.find((item) => item.name === 'schema')!;
  assert.equal(schema.options![0]!.autocomplete, true);
  assert.equal(schema.options![0]!.required, true);
});

test('structured aliases dispatch only their exact established routes', () => {
  assert.equal(resolveSlashCommandName('bot', options('actions', 'run')), 'action');
  assert.equal(resolveSlashCommandName('bot', options('actions', 'schema')), 'schema');
  assert.equal(resolveSlashCommandName('bot', options('account', 'status')), 'status');
  assert.equal(resolveSlashCommandName('bot', options('account', 'forget')), 'forget');
  for (const [group, subcommand] of [
    [null, null],
    ['account', 'run'],
    ['actions', 'forget'],
    ['system', 'run'],
  ])
    assert.equal(resolveSlashCommandName('bot', options(group!, subcommand!)), 'unknown-structured-command');
  assert.equal(
    resolveSlashCommandName('action', {
      getSubcommandGroup: () => {
        throw new Error('Flat commands must not query groups');
      },
      getSubcommand: () => {
        throw new Error('Flat commands must not query subcommands');
      },
    }),
    'action',
  );
});

test('all command names and slash descriptions include valid Spanish localization', () => {
  const commands = definitions();
  assert.equal(new Set(commands.map((item) => item.name)).size, commands.length);
  for (const command of commands) {
    const translated = command.name_localizations?.['es-ES'];
    assert.ok(translated, `Missing Spanish name: ${command.name}`);
    assert.ok(translated.length <= 32);
    if (command.type === ApplicationCommandType.Message || command.type === ApplicationCommandType.User)
      continue;
    assert.match(translated, /^[\p{Ll}\p{Lm}\p{Lo}\p{N}_-]{1,32}$/u);
    assert.ok(command.description_localizations?.['es-ES']);
    assert.ok(command.description_localizations['es-ES'].length <= 100);
  }
});

test('localized hierarchy serializes through Discord builders within platform bounds', () => {
  const bot = definitions().find((command) => command.name === 'bot')!;
  for (const group of bot.options!) {
    assert.ok(group.name_localizations?.['es-ES']);
    assert.ok(group.description_localizations?.['es-ES']);
    for (const subcommand of group.options!) {
      assert.ok(subcommand.name_localizations?.['es-ES']);
      assert.ok(subcommand.description_localizations?.['es-ES']);
      assert.ok(subcommand.description!.length <= 100);
      assert.ok(subcommand.description_localizations['es-ES'].length <= 100);
      let seenOptional = false;
      for (const option of subcommand.options ?? []) {
        if (!option.required) seenOptional = true;
        else assert.equal(seenOptional, false, 'Required options must precede optional options');
      }
    }
  }
});
