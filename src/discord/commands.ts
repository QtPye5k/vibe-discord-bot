import {
  ApplicationCommandType,
  EntryPointCommandHandlerType,
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
} from 'discord.js';
const spanish: Record<string, [string, string]> = {
  help: ['ayuda', 'Busca funciones y aprende a usar el bot'],
  action: ['accion', 'Ejecuta una acción exacta con verificación de permisos'],
  schema: ['esquema', 'Muestra los campos, permisos y reglas de confirmación de una acción'],
  ask: ['preguntar', 'Conversa, analiza un archivo o propone una acción de administración'],
  confirm: ['confirmar', 'Confirma una acción pendiente exacta'],
  cancel: ['cancelar', 'Cancela una acción pendiente'],
  status: ['estado', 'Muestra el estado del bot y las funciones habilitadas'],
  forget: ['olvidar', 'Borra tus conversaciones, conocimientos y preferencias de IA'],
  join: ['entrar', 'Entra en tu canal de voz; la transcripción requiere consentimiento individual'],
  leave: ['salir', 'Desconecta inmediatamente y descarta el audio de la sesión'],
  stop: ['parar', 'Detiene la reproducción de voz y descarta el audio en cola'],
  revoke: ['revocar', 'Revoca inmediatamente tu consentimiento de transcripción de voz'],
  consent: ['consentir', 'Permite transcribir tu voz durante diez minutos en el canal de texto anunciado'],
  speak: ['hablar', 'Lee texto en tu canal de voz con voz generada por IA'],
  remind: ['recordar', 'Crea un recordatorio personal persistente'],
  balance: ['saldo', 'Consulta tu saldo de monedas ficticias'],
  daily: ['diario', 'Reclama tus monedas ficticias diarias'],
  ticket: ['soporte', 'Abre un ticket de soporte privado'],
  report: ['denunciar', 'Envía al equipo una denuncia privada sobre un miembro'],
  bot: ['bot', 'Acciones, estado y privacidad del bot organizados por grupos'],
};
const command = (name: string, description: string) => {
  const builder = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  const translation = spanish[name];
  if (translation)
    builder
      .setNameLocalizations({ 'es-ES': translation[0] })
      .setDescriptionLocalizations({ 'es-ES': translation[1] });
  return builder;
};

/** Normalizes structured aliases before dispatch; Discord always sends canonical English names. */
export function resolveSlashCommandName(
  name: string,
  options: {
    getSubcommandGroup(required: false): string | null;
    getSubcommand(required: false): string | null;
  },
): string {
  if (name !== 'bot') return name;
  const group = options.getSubcommandGroup(false);
  const subcommand = options.getSubcommand(false);
  if (group === 'actions' && subcommand === 'run') return 'action';
  if (group === 'actions' && subcommand === 'schema') return 'schema';
  if (group === 'account' && subcommand === 'status') return 'status';
  if (group === 'account' && subcommand === 'forget') return 'forget';
  return 'unknown-structured-command';
}
const actionOption = (builder: SlashCommandBuilder) =>
  builder.addStringOption((o) =>
    o
      .setName('name')
      .setDescription('Action name; start typing to search')
      .setAutocomplete(true)
      .setRequired(true),
  );
export const personalCommandNames = new Set(['help', 'schema', 'ask', 'status', 'forget']);
export function commandDefinitions(options: { userInstall?: boolean; activities?: boolean } = {}): unknown[] {
  const definitions: unknown[] = [
    command('bot', 'Bot actions, status and privacy organized into groups')
      .addSubcommandGroup((group) =>
        group
          .setName('actions')
          .setNameLocalizations({ 'es-ES': 'acciones' })
          .setDescription('Inspect and run permission-checked actions')
          .setDescriptionLocalizations({ 'es-ES': 'Consulta y ejecuta acciones con permisos verificados' })
          .addSubcommand((subcommand) =>
            subcommand
              .setName('run')
              .setNameLocalizations({ 'es-ES': 'ejecutar' })
              .setDescription('Run an exact bot action with normal authorization and confirmation')
              .setDescriptionLocalizations({ 'es-ES': 'Ejecuta una acción con autorización y confirmación' })
              .addStringOption((option) =>
                option
                  .setName('name')
                  .setDescription('Action name; start typing to search')
                  .setAutocomplete(true)
                  .setRequired(true),
              )
              .addStringOption((option) =>
                option
                  .setName('input')
                  .setDescription('JSON input; use schema to inspect fields')
                  .setMaxLength(6000),
              )
              .addAttachmentOption((option) =>
                option.setName('input_file').setDescription('JSON input attachment; use instead of input'),
              ),
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName('schema')
              .setNameLocalizations({ 'es-ES': 'esquema' })
              .setDescription('Inspect an action’s exact fields, permissions and confirmation rules')
              .setDescriptionLocalizations({
                'es-ES': 'Consulta los campos, permisos y confirmación de una acción',
              })
              .addStringOption((option) =>
                option
                  .setName('name')
                  .setDescription('Action name; start typing to search')
                  .setAutocomplete(true)
                  .setRequired(true),
              ),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName('account')
          .setNameLocalizations({ 'es-ES': 'cuenta' })
          .setDescription('Read bot status and manage your AI privacy')
          .setDescriptionLocalizations({ 'es-ES': 'Consulta el estado y gestiona tu privacidad de IA' })
          .addSubcommand((subcommand) =>
            subcommand
              .setName('status')
              .setNameLocalizations({ 'es-ES': 'estado' })
              .setDescription('Show bot health and enabled features')
              .setDescriptionLocalizations({ 'es-ES': 'Muestra el estado y las funciones habilitadas' }),
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName('forget')
              .setNameLocalizations({ 'es-ES': 'olvidar' })
              .setDescription('Delete your saved AI conversations, knowledge and preferences')
              .setDescriptionLocalizations({
                'es-ES': 'Borra tus conversaciones, conocimientos y preferencias de IA',
              }),
          ),
      ),
    command('help', 'Find capabilities and learn how to use the bot').addStringOption((o) =>
      o.setName('search').setDescription('Search available actions'),
    ),
    actionOption(command('action', 'Run an exact, permission-checked bot action'))
      .addStringOption((o) =>
        o
          .setName('input')
          .setDescription('JSON input; use /schema to see fields (default {})')
          .setMaxLength(6000),
      )
      .addAttachmentOption((o) =>
        o
          .setName('input_file')
          .setDescription('Optional JSON input attachment; use instead of the input field'),
      ),
    actionOption(command('schema', 'Show the exact input format, permissions and confirmation rules')),
    command('ask', 'Chat, analyze an attachment, or propose a Discord administration action')
      .addStringOption((o) =>
        o
          .setName('prompt')
          .setDescription('Your question or instruction')
          .setRequired(true)
          .setMaxLength(6000),
      )
      .addAttachmentOption((o) => o.setName('file').setDescription('Optional image, PDF or text/code file')),
    command('confirm', 'Confirm an exact pending action').addStringOption((o) =>
      o
        .setName('id')
        .setDescription('Optional ID; otherwise confirm the last displayed preview')
        .setMaxLength(32),
    ),
    command('cancel', 'Cancel a pending action').addStringOption((o) =>
      o
        .setName('id')
        .setDescription('Optional ID; otherwise cancel the last displayed preview')
        .setMaxLength(32),
    ),
    command('status', 'Show health and enabled capabilities'),
    command('forget', 'Delete your saved AI conversations, knowledge and preferences'),
    command('join', 'Join your voice channel; individual consent is required to transcribe'),
    command('leave', 'Immediately disconnect and discard all voice session audio'),
    command('stop', 'Immediately stop voice playback and discard queued audio'),
    command('revoke', 'Immediately revoke your own voice transcription consent'),
    command(
      'consent',
      'Allow your own voice to be transcribed for 10 minutes into the join text channel',
    ).addBooleanOption((o) =>
      o
        .setName('replies')
        .setDescription('Also send transcripts to AI and play synthetic spoken replies')
        .setRequired(true),
    ),
    command('speak', 'Speak text in your voice channel using AI-generated speech').addStringOption((o) =>
      o.setName('text').setDescription('Text to speak').setRequired(true).setMaxLength(1000),
    ),
    command('remind', 'Create a durable personal reminder')
      .addIntegerOption((o) =>
        o
          .setName('minutes')
          .setDescription('Minutes from now')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(525600),
      )
      .addStringOption((o) =>
        o.setName('text').setDescription('Reminder text').setRequired(true).setMaxLength(1500),
      ),
    command('balance', 'Check your fictional coin balance'),
    command('daily', 'Claim your daily fictional coins'),
    command('ticket', 'Open a private support ticket').addStringOption((o) =>
      o.setName('subject').setDescription('What do you need help with?').setRequired(true).setMaxLength(100),
    ),
    command('report', 'Send a private member report for staff review')
      .addUserOption((o) => o.setName('member').setDescription('Member to report').setRequired(true))
      .addStringOption((o) =>
        o.setName('reason').setDescription('Reason for your report').setRequired(true).setMaxLength(1500),
      ),
    new ContextMenuCommandBuilder()
      .setName('Explain message')
      .setNameLocalizations({ 'es-ES': 'Explicar mensaje' })
      .setType(ApplicationCommandType.Message)
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall),
    new ContextMenuCommandBuilder()
      .setName('Inspect member')
      .setNameLocalizations({ 'es-ES': 'Inspeccionar miembro' })
      .setType(ApplicationCommandType.User)
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall),
  ].map((c) => {
    if (options.userInstall && personalCommandNames.has(c.name))
      c.setContexts(
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      ).setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall);
    return c.toJSON();
  });
  if (options.activities) {
    definitions.push(command('activity', 'Launch the configured shared Discord Activity').toJSON());
    definitions.push({
      name: 'Launch common room',
      description: 'Open the shared Activity',
      type: ApplicationCommandType.PrimaryEntryPoint,
      handler: EntryPointCommandHandlerType.DiscordLaunchActivity,
      contexts: [InteractionContextType.Guild],
      integration_types: [ApplicationIntegrationType.GuildInstall],
    });
  }
  return definitions;
}
