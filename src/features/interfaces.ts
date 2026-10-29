import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  CheckboxBuilder,
  CheckboxGroupBuilder,
  ContainerBuilder,
  FileBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MentionableSelectMenuBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits as P,
  RadioGroupBuilder,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThumbnailBuilder,
  UserSelectMenuBuilder,
  type Interaction,
  type ModalSubmitInteraction,
  type Role,
  type GuildMember,
} from 'discord.js';
import { z } from 'zod';
import type { ActionContext, Action } from '../core/types.js';
import type { ActionRegistry, ActionOutcome } from '../core/registry.js';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
import { assertOrdinaryRole } from '../core/safe-role.js';
import { assertRoleHierarchy, resolveChannel, resolveMember, resolveRole } from '../core/permissions.js';
import { discordAttachmentUrl, downloadAttachment, csv } from '../core/files.js';
import {
  outcomePayload,
  textPayload,
  stringify,
  confirmationRows,
  preview,
  NO_MENTIONS,
} from '../discord/presentation.js';
import { settings as communitySettings } from './community.js';

const id = z.string().regex(/^\d{17,20}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const empty = z.strictObject({});
const token = () => randomBytes(8).toString('hex');
const key = (guildId: string, value: string) => `${guildId}:${value}`;
const epoch = () => Date.now();
const MAX_SESSIONS = 100;
const SESSION_MS = 20 * 60_000;
const ANONYMOUS_DISCLOSURE =
  'Identity is hidden in normal staff review/export; bot operators can access audit/internal records. Timestamps and action audit entries may correlate with you. Answers and files can identify you, so avoid self-identifying details when needed. This is private submission, not absolute anonymity.';

export const formFieldSchema = z
  .strictObject({
    id: slug,
    label: z.string().min(1).max(45),
    description: z.string().max(100).optional(),
    kind: z.enum([
      'short',
      'paragraph',
      'radio',
      'checkbox',
      'checkboxes',
      'select',
      'user',
      'role',
      'channel',
      'mentionable',
      'file',
    ]),
    required: z.boolean().default(true),
    options: z
      .array(z.strictObject({ label: z.string().min(1).max(50), value: slug }))
      .min(2)
      .max(10)
      .optional(),
    maxLength: z.number().int().min(1).max(2000).default(1000),
  })
  .superRefine((field, ctx) => {
    if (['radio', 'checkboxes', 'select'].includes(field.kind) && !field.options)
      ctx.addIssue({ code: 'custom', message: 'Choice fields require options.' });
    if (field.options && new Set(field.options.map((option) => option.value)).size !== field.options.length)
      ctx.addIssue({ code: 'custom', message: 'Option values must be unique.' });
  });
export const formDefinitionSchema = z
  .strictObject({
    id: slug,
    title: z.string().min(1).max(45),
    description: z.string().max(1500).default(''),
    purpose: z.enum(['application', 'recruitment', 'survey', 'quiz']).default('application'),
    fields: z.array(formFieldSchema).min(1).max(20),
    staffRoleId: id.nullable().default(null),
    reviewChannelId: id.nullable().default(null),
    anonymous: z.boolean().default(false),
    maxSubmissionsPerUser: z.number().int().min(1).max(10).default(1),
    answerKey: z
      .record(slug, z.union([z.string().max(2000), z.boolean(), z.array(z.string().max(100)).max(10)]))
      .default({}),
  })
  .refine(
    (form) => new Set(form.fields.map((field) => field.id)).size === form.fields.length,
    'Field IDs must be unique.',
  )
  .superRefine((form, ctx) => {
    for (const fieldId of Object.keys(form.answerKey)) {
      const field = form.fields.find((field) => field.id === fieldId);
      if (
        form.purpose !== 'quiz' ||
        !field ||
        ['user', 'role', 'channel', 'mentionable', 'file'].includes(field.kind)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Answer keys are supported only for quiz text/choice/checkbox fields that exist.',
        });
    }
  });
type Form = z.infer<typeof formDefinitionSchema> & { revision: string; createdBy: string };
type Field = z.infer<typeof formFieldSchema>;
type Answer = string | boolean | string[] | { name: string; size: number; url: string }[];
interface Draft {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  formId: string;
  revision: string;
  step: number;
  answers: Record<string, Answer>;
  expiresAt: number;
  ready: boolean;
}
interface Submission {
  id: string;
  formId: string;
  title: string;
  purpose: Form['purpose'];
  userId: string;
  /** Immutable privacy choice at submission; changing the definition must not reveal an earlier owner. */
  anonymous?: boolean;
  createdAt: number;
  answers: Record<string, Answer>;
  labels: Record<string, string>;
  status: 'new' | 'accepted' | 'denied' | 'reviewed';
  reviewerId?: string;
  note?: string;
  staffRoleId: string | null;
  score?: { correct: number; total: number };
}
interface Panel {
  id: string;
  kind: 'roles' | 'ticket' | 'form' | 'settings' | 'moderation' | 'verification';
  channelId: string;
  messageId: string;
  roleIds?: string[];
  formId?: string;
}
interface Suggestion {
  id: string;
  userId: string;
  channelId: string;
  messageId: string;
  content: string;
  createdAt: number;
  votes: Record<string, 'up' | 'down'>;
  status: 'open' | 'accepted' | 'denied';
  note?: string;
  reviewerId?: string;
}
interface VerifySettings {
  roleId: string;
  rules: string;
  minimumAccountAgeHours: number;
  minimumMembershipMinutes: number;
  captchaRequired?: boolean;
  version?: string;
}

function add<S extends z.ZodType>(
  registry: ActionRegistry,
  spec: Omit<Action<S>, 'category' | 'userPermissions' | 'botPermissions'> &
    Partial<Pick<Action<S>, 'category' | 'userPermissions' | 'botPermissions'>>,
) {
  registry.register({ category: 'interfaces', userPermissions: [], botPermissions: [], ...spec });
}
function enabled(store: Store, guildId: string) {
  if ((store.get<string[]>('core.disabled', guildId) ?? []).includes('interfaces'))
    throw new UserError('Interactive interfaces are disabled in this server.');
}
function safeRole(role: Role, bot: GuildMember) {
  assertOrdinaryRole(role, bot);
}
async function sendable(ctx: ActionContext, channelId: string) {
  const channel = await resolveChannel(ctx, channelId);
  if (
    !channel.isSendable() ||
    !channel.permissionsFor(ctx.member)?.has(P.SendMessages) ||
    !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages)
  )
    throw new UserError('You and the bot need Send Messages in that channel.');
  return channel;
}
function getForm(store: Store, guildId: string, formId: string): Form {
  const form = store.get<Form>('ui.forms', key(guildId, formId));
  if (!form) throw new UserError('Form is unavailable.');
  return form;
}
function getPanel(
  store: Store,
  guildId: string,
  panelId: string,
  channelId: string,
  messageId?: string,
): Panel {
  const panel = store.get<Panel>('ui.panels', key(guildId, panelId));
  if (!panel || panel.channelId !== channelId || (messageId && panel.messageId !== messageId))
    throw new UserError('This panel is unavailable or belongs to another channel.');
  return panel;
}
function staff(ctx: ActionContext, roleId: string | null): boolean {
  return ctx.member.permissions.has(P.ManageGuild) || !!(roleId && ctx.member.roles.cache.has(roleId));
}
function canReview(ctx: ActionContext, row: Submission): boolean {
  const current = ctx.store.get<Form>('ui.forms', key(ctx.guild.id, row.formId));
  return staff(ctx, current ? current.staffRoleId : row.staffRoleId);
}
/** Explicit output fields keep internal owner identifiers out of every normal anonymous review route. */
function reviewerSubmission(row: Submission, includeAnswers = true): Record<string, unknown> {
  return {
    id: row.id,
    formId: row.formId,
    title: row.title,
    purpose: row.purpose,
    ...(row.anonymous === true
      ? { anonymous: true, identity: 'Hidden from reviewers' }
      : { userId: row.userId }),
    createdAt: row.createdAt,
    status: row.status,
    staffRoleId: row.staffRoleId,
    ...(row.reviewerId !== undefined ? { reviewerId: row.reviewerId } : {}),
    ...(row.note !== undefined ? { note: row.note } : {}),
    ...(row.score !== undefined ? { score: row.score } : {}),
    ...(includeAnswers ? { answers: row.answers, labels: row.labels } : {}),
  };
}
function quizScore(form: Form, answers: Record<string, Answer>): Submission['score'] {
  const entries = Object.entries(form.answerKey ?? {});
  if (form.purpose !== 'quiz' || !entries.length) return undefined;
  const normalize = (value: unknown): string =>
    Array.isArray(value)
      ? JSON.stringify(value.map((item) => String(item).trim().toLowerCase()).sort())
      : String(value).trim().toLowerCase();
  return {
    correct: entries.filter(([field, expected]) => normalize(answers[field]) === normalize(expected)).length,
    total: entries.length,
  };
}
function getDraft(store: Store, guildId: string, userId: string, channelId: string, draftId: string): Draft {
  const draft = store.get<Draft>('ui.drafts', key(guildId, draftId));
  if (!draft || draft.userId !== userId || draft.guildId !== guildId || draft.channelId !== channelId)
    throw new UserError('This form session belongs to another person or channel.');
  if (draft.expiresAt <= epoch()) {
    store.delete('ui.drafts', key(guildId, draftId));
    throw new UserError('Form session expired. Start again.');
  }
  const form = getForm(store, guildId, draft.formId);
  if (form.revision !== draft.revision) throw new UserError('The form was updated. Start a new session.');
  return draft;
}
export function startFormSession(
  store: Store,
  guildId: string,
  userId: string,
  channelId: string,
  formId: string,
): Draft {
  const form = getForm(store, guildId, formId);
  const drafts = store.list<Draft>('ui.drafts', `${guildId}:`);
  for (const row of drafts) if (row.value.expiresAt <= epoch()) store.delete('ui.drafts', row.key);
  const active = drafts.filter((row) => row.value.expiresAt > epoch());
  if (active.length >= MAX_SESSIONS)
    throw new UserError('This server has too many active form sessions. Try again later.');
  if (active.filter((row) => row.value.userId === userId).length >= 2)
    throw new UserError('Finish your current forms before starting more.');
  const draft: Draft = {
    id: token(),
    guildId,
    userId,
    channelId,
    formId,
    revision: form.revision,
    step: 0,
    answers: {},
    expiresAt: epoch() + SESSION_MS,
    ready: false,
  };
  store.set('ui.drafts', key(guildId, draft.id), draft);
  return draft;
}
export function buildFormModal(form: Form, draft: Draft): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`ui:formsubmit:${draft.id}:${draft.step}`)
    .setTitle(`${form.title} (${draft.step + 1}/${Math.ceil(form.fields.length / 5)})`.slice(0, 45));
  for (const field of form.fields.slice(draft.step * 5, draft.step * 5 + 5)) {
    const label = new LabelBuilder().setLabel(field.label);
    if (field.description) label.setDescription(field.description);
    const customId = `field:${field.id}`;
    const min = field.required ? 1 : 0;
    switch (field.kind) {
      case 'short':
      case 'paragraph':
        label.setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(customId)
            .setStyle(field.kind === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
            .setRequired(field.required)
            .setMaxLength(field.maxLength),
        );
        break;
      case 'radio':
        label.setRadioGroupComponent(
          new RadioGroupBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .addOptions(...field.options!),
        );
        break;
      case 'checkbox':
        label.setCheckboxComponent(new CheckboxBuilder().setCustomId(customId).setDefault(false));
        break;
      case 'checkboxes':
        label.setCheckboxGroupComponent(
          new CheckboxGroupBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(min)
            .setMaxValues(field.options!.length)
            .addOptions(...field.options!),
        );
        break;
      case 'select':
        label.setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(min)
            .setMaxValues(1)
            .addOptions(...field.options!),
        );
        break;
      case 'user':
        label.setUserSelectMenuComponent(
          new UserSelectMenuBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(min)
            .setMaxValues(1),
        );
        break;
      case 'role':
        label.setRoleSelectMenuComponent(
          new RoleSelectMenuBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(min)
            .setMaxValues(1),
        );
        break;
      case 'channel':
        label.setChannelSelectMenuComponent(
          new ChannelSelectMenuBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(min)
            .setMaxValues(1),
        );
        break;
      case 'mentionable':
        label.setMentionableSelectMenuComponent(
          new MentionableSelectMenuBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(min)
            .setMaxValues(1),
        );
        break;
      case 'file':
        label.setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(customId)
            .setRequired(field.required)
            .setMinValues(min)
            .setMaxValues(2),
        );
        break;
    }
    modal.addLabelComponents(label);
  }
  return modal;
}
function readAnswers(interaction: ModalSubmitInteraction, fields: Field[]): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const field of fields) {
    const customId = `field:${field.id}`;
    let answer: Answer;
    switch (field.kind) {
      case 'short':
      case 'paragraph':
        answer = interaction.fields.getTextInputValue(customId).trim();
        if (answer.length > field.maxLength) throw new UserError(`${field.label} is too long.`);
        break;
      case 'radio':
        answer = interaction.fields.getRadioGroup(customId) ?? '';
        break;
      case 'checkbox':
        answer = interaction.fields.getCheckbox(customId);
        if (field.required && !answer) throw new UserError(`You must acknowledge ${field.label}.`);
        break;
      case 'checkboxes':
        answer = [...interaction.fields.getCheckboxGroup(customId)];
        break;
      case 'select':
        answer = [...interaction.fields.getStringSelectValues(customId)];
        break;
      case 'user':
        answer = [...(interaction.fields.getSelectedUsers(customId)?.keys() ?? [])];
        break;
      case 'role':
        answer = [...(interaction.fields.getSelectedRoles(customId)?.keys() ?? [])];
        break;
      case 'channel':
        answer = [...(interaction.fields.getSelectedChannels(customId)?.keys() ?? [])];
        break;
      case 'mentionable': {
        const selected = interaction.fields.getSelectedMentionables(customId);
        answer = selected ? [...selected.users.keys(), ...selected.roles.keys()] : [];
        break;
      }
      case 'file':
        answer = [...(interaction.fields.getUploadedFiles(customId)?.values() ?? [])].map((file) => {
          discordAttachmentUrl(file.url);
          if (file.size > 8 * 1024 * 1024) throw new UserError('Form files must be at most 8 MiB each.');
          return { name: file.name, size: file.size, url: file.url };
        });
        break;
    }
    if (
      field.required &&
      ((typeof answer === 'string' && !answer) || (Array.isArray(answer) && !answer.length))
    )
      throw new UserError(`${field.label} is required.`);
    if (field.options) {
      const allowed = new Set(field.options.map((option) => option.value));
      if (
        typeof answer === 'string'
          ? !!answer && !allowed.has(answer)
          : Array.isArray(answer) && answer.some((value) => typeof value !== 'string' || !allowed.has(value))
      )
        throw new UserError('Invalid choice for this form field.');
    }
    answers[field.id] = answer;
  }
  return answers;
}
function suggestionText(suggestion: Suggestion): string {
  const votes = Object.values(suggestion.votes);
  return `**Suggestion ${suggestion.id}** · ${suggestion.status}\n${suggestion.content}\n\nBy <@${suggestion.userId}> · 👍 ${votes.filter((v) => v === 'up').length} · 👎 ${votes.filter((v) => v === 'down').length}${suggestion.note ? `\nStaff decision: ${suggestion.note}` : ''}`;
}
function suggestionButtons(suggestion: Suggestion) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`ui:suggest:${suggestion.id}:up`)
        .setLabel('Support')
        .setStyle(ButtonStyle.Success)
        .setDisabled(suggestion.status !== 'open'),
      new ButtonBuilder()
        .setCustomId(`ui:suggest:${suggestion.id}:down`)
        .setLabel('Oppose')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(suggestion.status !== 'open'),
      new ButtonBuilder()
        .setCustomId(`ui:suggest:${suggestion.id}:view`)
        .setLabel('Details')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}
const suggestionRenders = new WeakMap<Store, Map<string, { dirty: boolean; pending: Promise<void> }>>();
async function updateSuggestion(ctx: ActionContext, suggestion: Suggestion) {
  let renders = suggestionRenders.get(ctx.store);
  if (!renders) {
    renders = new Map();
    suggestionRenders.set(ctx.store, renders);
  }
  const renderKey = key(ctx.guild.id, suggestion.id),
    active = renders.get(renderKey);
  if (active) {
    active.dirty = true;
    await active.pending;
    return;
  }
  const state = { dirty: true, pending: Promise.resolve() };
  renders.set(renderKey, state);
  state.pending = (async () => {
    do {
      state.dirty = false;
      const channel = await resolveChannel(ctx, suggestion.channelId);
      if (!channel.isTextBased()) throw new UserError('Suggestion channel is unavailable.');
      const message = await channel.messages.fetch(suggestion.messageId);
      if (message.author.id !== ctx.client.user?.id)
        throw new UserError('Suggestion message does not belong to this bot.');
      const latest = ctx.store.get<Suggestion>('ui.suggestions', renderKey);
      if (!latest) throw new UserError('Suggestion is no longer available.');
      await message.edit({
        content: suggestionText(latest),
        components: suggestionButtons(latest),
        allowedMentions: NO_MENTIONS,
      });
    } while (state.dirty);
  })().finally(() => {
    if (renders!.get(renderKey) === state) renders!.delete(renderKey);
  });
  await state.pending;
}
async function publishPanel(
  ctx: ActionContext,
  kind: Panel['kind'],
  channelId: string,
  title: string,
  extra: Partial<Panel> = {},
) {
  const channel = await sendable(ctx, channelId);
  const panelId = token();
  let components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (kind === 'roles') {
    const roles = [];
    for (const roleId of extra.roleIds ?? []) roles.push(await resolveRole(ctx, roleId));
    if (!roles.length) throw new UserError('Configure at least one approved self-service role.');
    components = [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ui:roles:${panelId}:select`)
          .setPlaceholder('Select roles to toggle; confirmation follows')
          .setMinValues(1)
          .setMaxValues(Math.min(5, roles.length))
          .addOptions(...roles.map((role) => ({ label: role.name.slice(0, 100), value: role.id }))),
      ),
    ];
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const role of roles.slice(0, 5))
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ui:roles:${panelId}:${role.id}`)
          .setLabel(role.name.slice(0, 80))
          .setStyle(ButtonStyle.Secondary),
      );
    components.push(row);
  } else {
    const operation = kind === 'form' ? 'formopen' : kind;
    const label = {
      ticket: 'Open a ticket',
      form: 'Start form',
      settings: 'Configure community',
      moderation: 'Staff dashboard',
      verification: 'Read rules and verify',
    }[kind];
    components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ui:${operation}:${panelId}`)
          .setLabel(label)
          .setStyle(ButtonStyle.Primary),
      ),
    ];
  }
  const message = await channel.send({ content: title, components, allowedMentions: NO_MENTIONS });
  const panel: Panel = { id: panelId, kind, channelId, messageId: message.id, ...extra };
  ctx.store.set('ui.panels', key(ctx.guild.id, panelId), panel);
  return panel;
}

interface PagedResult {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  title: string;
  pages: string[];
  expiresAt: number;
}
function pagedPayload(row: PagedResult, page: number) {
  return {
    content: `${row.title}\n\n${row.pages[page]}\n\nPage ${page + 1}/${row.pages.length}`,
    allowedMentions: NO_MENTIONS,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ui:pages:${row.id}:${Math.max(0, page - 1)}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`ui:pages:${row.id}:${Math.min(row.pages.length - 1, page + 1)}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === row.pages.length - 1),
      ),
    ],
  };
}
export function sweepInterfaceState(store: Store, now = Date.now()) {
  for (const row of store.list<PagedResult>('ui.pages'))
    if (row.value.expiresAt <= now) store.delete('ui.pages', row.key);
}
export interface InterfaceOptions {
  assertCaptcha?: (ctx: ActionContext, policyVersion: string) => Promise<void> | void;
}
export function registerInterfaceActions(registry: ActionRegistry, options: InterfaceOptions = {}): void {
  add(registry, {
    id: 'ui.pages.publish',
    description:
      'Publish the first page of a reviewed list with owner-bound previous/next controls; remaining navigation is private and expires after ten minutes.',
    risk: 'write',
    userPermissions: [P.SendMessages],
    botPermissions: [P.SendMessages],
    schema: z.strictObject({
      channelId: id,
      title: z.string().min(1).max(100),
      pages: z.array(z.string().min(1).max(1750)).min(1).max(100),
    }),
    execute: async (ctx, input) => {
      const channel = await resolveChannel(ctx, input.channelId);
      if (
        !channel.isSendable() ||
        !channel.permissionsFor(ctx.member)?.has(P.SendMessages) ||
        !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages)
      )
        throw new UserError('Both you and the bot must be able to send in the selected channel.');
      sweepInterfaceState(ctx.store);
      const rows = ctx.store.list<PagedResult>('ui.pages', `${ctx.guild.id}:`);
      if (rows.length >= 50 || rows.filter((row) => row.value.userId === ctx.member.id).length >= 10)
        throw new UserError('Pagination limit reached; wait for existing lists to expire.');
      const row: PagedResult = {
        id: token(),
        guildId: ctx.guild.id,
        userId: ctx.member.id,
        channelId: input.channelId,
        title: input.title,
        pages: input.pages,
        expiresAt: Date.now() + 600000,
      };
      ctx.store.set('ui.pages', key(ctx.guild.id, row.id), row);
      const message = await channel.send(pagedPayload(row, 0));
      return { id: row.id, messageId: message.id, pageCount: row.pages.length, expiresAt: row.expiresAt };
    },
  });
  add(registry, {
    id: 'ui.roles.publish',
    description: 'Publish persistent role buttons and an allowlisted role-selection menu.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    botPermissions: [P.SendMessages],
    schema: z.strictObject({
      channelId: id,
      title: z.string().min(1).max(1500).default('Choose your roles'),
      roleIds: z.array(id).min(1).max(25).optional(),
    }),
    execute: async (ctx, input) => {
      const allowlist = communitySettings(ctx.store, ctx.guild.id).selfRoleIds;
      const roles = input.roleIds ?? allowlist;
      if (roles.some((role) => !allowlist.includes(role)))
        throw new UserError('Panel roles must first be approved through community.configure selfRoleIds.');
      return publishPanel(ctx, 'roles', input.channelId, input.title, { roleIds: [...new Set(roles)] });
    },
  });
  add(registry, {
    id: 'ui.ticket.publish',
    description: 'Publish a persistent ticket button that opens a private subject form.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    botPermissions: [P.SendMessages],
    schema: z.strictObject({
      channelId: id,
      title: z.string().min(1).max(1500).default('Need help? Open a private support ticket.'),
    }),
    execute: (ctx, input) => publishPanel(ctx, 'ticket', input.channelId, input.title),
  });
  add(registry, {
    id: 'form.create',
    description:
      'Create/update an application, recruitment form, survey or quiz with typed multi-step fields.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: formDefinitionSchema,
    execute: async (ctx, input) => {
      if (input.staffRoleId) await resolveRole(ctx, input.staffRoleId);
      if (input.reviewChannelId) {
        const channel = await resolveChannel(ctx, input.reviewChannelId);
        if (!channel.isSendable()) throw new UserError('Review channel must accept messages.');
        if (channel.permissionsFor(ctx.guild.roles.everyone)?.has(P.ViewChannel))
          throw new UserError('Form review notifications require a staff-only channel.');
      }
      if (
        !ctx.store.get('ui.forms', key(ctx.guild.id, input.id)) &&
        ctx.store.list('ui.forms', `${ctx.guild.id}:`).length >= 50
      )
        throw new UserError('Maximum 50 forms per server.');
      const form: Form = { ...input, revision: token(), createdBy: ctx.member.id };
      ctx.store.set('ui.forms', key(ctx.guild.id, form.id), form);
      return form;
    },
  });
  add(registry, {
    id: 'form.list',
    description: 'List public form definitions without submitted answers.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store.list<Form>('ui.forms', `${ctx.guild.id}:`).map((row) => ({
        id: row.value.id,
        title: row.value.title,
        purpose: row.value.purpose,
        description: row.value.description,
        anonymous: row.value.anonymous === true,
        ...(row.value.anonymous === true ? { identityDisclosure: ANONYMOUS_DISCLOSURE } : {}),
        fields: row.value.fields.map((field) => ({ label: field.label, kind: field.kind })),
        steps: Math.ceil(row.value.fields.length / 5),
      })),
  });
  add(registry, {
    id: 'form.delete',
    description:
      'Delete a form definition and invalidate its active drafts; prior submissions remain available to staff.',
    risk: 'destructive',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ formId: slug }),
    execute: (ctx, input) => {
      getForm(ctx.store, ctx.guild.id, input.formId);
      ctx.store.delete('ui.forms', key(ctx.guild.id, input.formId));
      return { deleted: input.formId };
    },
  });
  add(registry, {
    id: 'form.publish',
    description:
      'Publish a persistent form-start button for an existing application, recruitment form, survey or quiz.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    botPermissions: [P.SendMessages],
    schema: z.strictObject({ formId: slug, channelId: id }),
    execute: (ctx, input) => {
      const form = getForm(ctx.store, ctx.guild.id, input.formId);
      return publishPanel(
        ctx,
        'form',
        input.channelId,
        `**${form.title}**\n${form.description}${form.anonymous === true ? `\n\n${ANONYMOUS_DISCLOSURE}` : ''}`,
        {
          formId: form.id,
        },
      );
    },
  });
  add(registry, {
    id: 'form.submit',
    description: 'Submit your completed immutable form draft to its authorized staff reviewers.',
    auditIdentity: 'private',
    risk: 'write',
    schema: z.strictObject({
      sessionId: z.string().regex(/^[a-f0-9]{16}$/),
      anonymousDisclosureAccepted: z.literal(true).optional().describe(ANONYMOUS_DISCLOSURE),
    }),
    execute: async (ctx, input) => {
      const draft = getDraft(ctx.store, ctx.guild.id, ctx.member.id, ctx.channelId, input.sessionId);
      const form = getForm(ctx.store, ctx.guild.id, draft.formId);
      if (!draft.ready) throw new UserError('Finish every form step first.');
      if (form.anonymous === true && input.anonymousDisclosureAccepted !== true)
        throw new UserError(
          `${ANONYMOUS_DISCLOSURE} Review this disclosure and request form.submit again with anonymousDisclosureAccepted:true.`,
        );
      const submission = ctx.store.transaction(() => {
        const latest = getDraft(ctx.store, ctx.guild.id, ctx.member.id, ctx.channelId, input.sessionId);
        const rows = ctx.store.list<Submission>('ui.submissions', `${ctx.guild.id}:`);
        if (rows.length >= 5000)
          throw new UserError(
            'This server has reached its form submission retention limit. Staff should export/delete old submissions.',
          );
        if (
          rows.filter((row) => row.value.formId === form.id && row.value.userId === ctx.member.id).length >=
          form.maxSubmissionsPerUser
        )
          throw new UserError('Your submission limit for this form has been reached.');
        const record: Submission = {
          id: token(),
          formId: form.id,
          title: form.title,
          purpose: form.purpose,
          userId: ctx.member.id,
          anonymous: form.anonymous === true,
          createdAt: epoch(),
          answers: latest.answers,
          labels: Object.fromEntries(form.fields.map((field) => [field.id, field.label])),
          status: 'new',
          staffRoleId: form.staffRoleId,
          score: quizScore(form, latest.answers),
        };
        ctx.store.set('ui.submissions', key(ctx.guild.id, record.id), record);
        ctx.store.delete('ui.drafts', key(ctx.guild.id, latest.id));
        return record;
      });
      let notified = false;
      if (form.reviewChannelId)
        try {
          const channel = await ctx.guild.channels.fetch(form.reviewChannelId, { force: true });
          if (
            channel?.isSendable() &&
            !channel.permissionsFor(ctx.guild.roles.everyone)?.has(P.ViewChannel)
          ) {
            await channel.send({
              content: `New ${form.purpose} submission ${submission.id}: ${form.title}. Use form.responses or form.response to review.`,
              allowedMentions: NO_MENTIONS,
            });
            notified = true;
          }
        } catch {
          /* Submission remains durable if its optional staff notification fails. */
        }
      return {
        submitted: submission.id,
        formId: form.id,
        status: 'new',
        staffNotified: notified,
        ...(submission.anonymous ? { anonymous: true, identityDisclosure: ANONYMOUS_DISCLOSURE } : {}),
        ...(submission.score ? { score: submission.score } : {}),
      };
    },
  });
  add(registry, {
    id: 'form.mine',
    description: 'Read your own submitted forms and decisions in this server.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<Submission>('ui.submissions', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((row) => row.userId === ctx.member.id)
        .slice(-100)
        .map((row) => {
          const { note: _note, reviewerId: _reviewer, ...visible } = reviewerSubmission(row);
          return visible;
        }),
  });
  add(registry, {
    id: 'form.drafts',
    description: 'List your active form drafts in this server and channel.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<Draft>('ui.drafts', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter(
          (row) => row.userId === ctx.member.id && row.channelId === ctx.channelId && row.expiresAt > epoch(),
        )
        .map(({ answers: _answers, ...row }) => row),
  });
  add(registry, {
    id: 'form.draft',
    description: 'Review your own in-progress or completed form answers before submitting.',
    risk: 'read',
    schema: z.strictObject({ sessionId: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: (ctx, input) => {
      const draft = getDraft(ctx.store, ctx.guild.id, ctx.member.id, ctx.channelId, input.sessionId);
      const form = getForm(ctx.store, ctx.guild.id, draft.formId);
      return {
        ...draft,
        ...(form.anonymous === true ? { anonymous: true, identityDisclosure: ANONYMOUS_DISCLOSURE } : {}),
      };
    },
  });
  add(registry, {
    id: 'form.draft-cancel',
    description: 'Discard one of your own active form drafts.',
    risk: 'write',
    schema: z.strictObject({ sessionId: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: (ctx, input) => {
      const draft = getDraft(ctx.store, ctx.guild.id, ctx.member.id, ctx.channelId, input.sessionId);
      ctx.store.delete('ui.drafts', key(ctx.guild.id, draft.id));
      return { discarded: draft.id };
    },
  });
  add(registry, {
    id: 'form.responses',
    description: 'Read staff-authorized submission summaries for a form.',
    risk: 'read',
    schema: z.strictObject({ formId: slug, page: z.number().int().min(1).max(1000).default(1) }),
    execute: (ctx, input) => {
      const form = getForm(ctx.store, ctx.guild.id, input.formId);
      if (!staff(ctx, form.staffRoleId))
        throw new UserError('This form is restricted to its staff reviewers.');
      const rows = ctx.store
        .list<Submission>('ui.submissions', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((row) => row.formId === form.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      return {
        page: input.page,
        pages: Math.max(1, Math.ceil(rows.length / 20)),
        total: rows.length,
        submissions: rows
          .slice((input.page - 1) * 20, input.page * 20)
          .map((row) => reviewerSubmission(row, false)),
      };
    },
  });
  add(registry, {
    id: 'form.response',
    description: 'Read a single form submission and its typed answers, restricted to its reviewers.',
    risk: 'read',
    schema: z.strictObject({ submissionId: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: (ctx, input) => {
      const row = ctx.store.get<Submission>('ui.submissions', key(ctx.guild.id, input.submissionId));
      if (!row || !canReview(ctx, row)) throw new UserError('Submission is unavailable to your account.');
      return reviewerSubmission(row);
    },
  });
  add(registry, {
    id: 'form.review',
    description:
      'Record a staff approval, denial or review for an application, recruitment form, quiz or survey.',
    risk: 'write',
    schema: z.strictObject({
      submissionId: z.string().regex(/^[a-f0-9]{16}$/),
      decision: z.enum(['accepted', 'denied', 'reviewed']),
      note: z.string().max(1500).default(''),
    }),
    execute: (ctx, input) => {
      const row = ctx.store.get<Submission>('ui.submissions', key(ctx.guild.id, input.submissionId));
      if (!row || !canReview(ctx, row)) throw new UserError('Submission is unavailable to your account.');
      if (row.userId === ctx.member.id) throw new UserError('You cannot review your own submission.');
      row.status = input.decision;
      row.note = input.note;
      row.reviewerId = ctx.member.id;
      ctx.store.set('ui.submissions', key(ctx.guild.id, row.id), row);
      return { id: row.id, status: row.status };
    },
  });
  add(registry, {
    id: 'form.export',
    description: 'Export reviewer-authorized form responses to formula-safe CSV.',
    risk: 'read',
    schema: z.strictObject({ formId: slug }),
    execute: (ctx, input) => {
      const form = getForm(ctx.store, ctx.guild.id, input.formId);
      if (!staff(ctx, form.staffRoleId))
        throw new UserError('This form is restricted to its staff reviewers.');
      const rows = ctx.store
        .list<Submission>('ui.submissions', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((row) => row.formId === form.id)
        .map((row) => ({
          id: row.id,
          userId: row.anonymous === true ? '[hidden from reviewers]' : row.userId,
          ...(row.anonymous === true ? { anonymous: true } : {}),
          status: row.status,
          createdAt: new Date(row.createdAt).toISOString(),
          ...Object.fromEntries(
            Object.entries(row.answers).map(([name, value]) => [
              name,
              typeof value === 'object' ? JSON.stringify(value) : value,
            ]),
          ),
        }));
      return { attachment: Buffer.from(csv(rows)), name: `${form.id}-responses.csv` };
    },
  });
  add(registry, {
    id: 'form.erase-own',
    description: 'Erase your own form drafts and submitted answers in this server.',
    risk: 'destructive',
    schema: empty,
    execute: (ctx) => {
      let count = 0;
      for (const namespace of ['ui.drafts', 'ui.submissions'])
        for (const row of ctx.store.list<{ userId: string }>(namespace, `${ctx.guild.id}:`))
          if (row.value.userId === ctx.member.id) {
            ctx.store.delete(namespace, row.key);
            count++;
          }
      return { erasedRecords: count };
    },
  });
  add(registry, {
    id: 'form.response-delete',
    description: 'Delete one form response as an authorized reviewer after export/retention review.',
    risk: 'destructive',
    schema: z.strictObject({ submissionId: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: (ctx, input) => {
      const row = ctx.store.get<Submission>('ui.submissions', key(ctx.guild.id, input.submissionId));
      if (!row || !canReview(ctx, row)) throw new UserError('Submission is unavailable to your account.');
      ctx.store.delete('ui.submissions', key(ctx.guild.id, row.id));
      return { deleted: row.id };
    },
  });
  add(registry, {
    id: 'verification.configure',
    description:
      'Configure acknowledgement-based member verification with a safe role and account/membership age limits.',
    risk: 'write',
    userPermissions: [P.ManageGuild, P.ManageRoles],
    botPermissions: [P.ManageRoles],
    schema: z.strictObject({
      roleId: id,
      rules: z.string().min(1).max(1500),
      minimumAccountAgeHours: z.number().int().min(0).max(8760).default(0),
      minimumMembershipMinutes: z.number().int().min(0).max(43200).default(0),
      captchaRequired: z.boolean().default(false),
    }),
    execute: async (ctx, input) => {
      const role = await resolveRole(ctx, input.roleId);
      assertRoleHierarchy(ctx, role);
      safeRole(role, await ctx.guild.members.fetchMe());
      const policy = { ...input, version: token() };
      ctx.store.set('ui.verification', ctx.guild.id, policy);
      return policy;
    },
  });
  add(registry, {
    id: 'verification.publish',
    description:
      'Publish a rule-acknowledgement verification button; this is not CAPTCHA or external identity verification.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    botPermissions: [P.SendMessages],
    schema: z.strictObject({ channelId: id }),
    execute: (ctx, input) => {
      const config = ctx.store.get<VerifySettings>('ui.verification', ctx.guild.id);
      if (!config) throw new UserError('Configure verification first.');
      return publishPanel(ctx, 'verification', input.channelId, config.rules);
    },
  });
  add(registry, {
    id: 'verification.complete',
    description:
      'Acknowledge configured rules and assign yourself the currently approved ordinary verification role.',
    risk: 'write',
    botPermissions: [P.ManageRoles],
    schema: empty,
    execute: async (ctx) => {
      const config = ctx.store.get<VerifySettings>('ui.verification', ctx.guild.id);
      if (!config) throw new UserError('Verification is not configured.');
      const member = await resolveMember(ctx, ctx.member.id);
      if (member.pending) throw new UserError('Complete Discord membership screening first.');
      if (
        epoch() - member.user.createdTimestamp < config.minimumAccountAgeHours * 3600000 ||
        !member.joinedTimestamp ||
        epoch() - member.joinedTimestamp < config.minimumMembershipMinutes * 60000
      )
        throw new UserError('Your account or membership is not old enough for this verification policy.');
      const role = await resolveRole(ctx, config.roleId);
      safeRole(role, await ctx.guild.members.fetchMe());
      if (ctx.store.get<VerifySettings>('ui.verification', ctx.guild.id)?.version !== config.version)
        throw new UserError('Verification policy changed. Review the current policy and try again.');
      if (config.captchaRequired) {
        if (!options.assertCaptcha || !config.version)
          throw new UserError('CAPTCHA is required, but its provider is not configured.');
        await options.assertCaptcha(ctx, config.version);
        if (ctx.store.get<VerifySettings>('ui.verification', ctx.guild.id)?.version !== config.version)
          throw new UserError('Verification policy changed during CAPTCHA authorization.');
      }
      const granted = !member.roles.cache.has(role.id);
      if (granted) await member.roles.add(role, 'Member acknowledged configured server rules');
      ctx.store.set('ui.verified', key(ctx.guild.id, member.id), {
        roleId: role.id,
        verifiedAt: epoch(),
        granted,
      });
      return { verified: true, roleId: role.id };
    },
  });
  add(registry, {
    id: 'verification.status',
    description: 'Read your own acknowledgement verification status.',
    risk: 'read',
    schema: empty,
    execute: (ctx) => ctx.store.get('ui.verified', key(ctx.guild.id, ctx.member.id)) ?? { verified: false },
  });
  add(registry, {
    id: 'suggestion.configure',
    description: 'Select the server suggestion channel.',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ channelId: id }),
    execute: async (ctx, input) => {
      await sendable(ctx, input.channelId);
      ctx.store.set('ui.suggestionSettings', ctx.guild.id, input);
      return input;
    },
  });
  add(registry, {
    id: 'suggestion.submit',
    description: 'Publish a suggestion with persistent voting buttons (five submissions per member per day).',
    risk: 'write',
    botPermissions: [P.SendMessages],
    schema: z.strictObject({ content: z.string().trim().min(5).max(1400) }),
    execute: async (ctx, input) => {
      const config = ctx.store.get<{ channelId: string }>('ui.suggestionSettings', ctx.guild.id);
      if (!config) throw new UserError('Configure a suggestion channel first.');
      const channel = await sendable(ctx, config.channelId);
      const rows = ctx.store.list<Suggestion>('ui.suggestions', `${ctx.guild.id}:`);
      if (rows.length >= 5000) throw new UserError('Suggestion retention limit reached.');
      if (
        rows.filter((row) => row.value.userId === ctx.member.id && epoch() - row.value.createdAt < 86400000)
          .length >= 5
      )
        throw new UserError('Maximum five suggestions per day.');
      const suggestion: Suggestion = {
        id: token(),
        userId: ctx.member.id,
        channelId: channel.id,
        messageId: '',
        content: input.content,
        createdAt: epoch(),
        votes: {},
        status: 'open',
      };
      ctx.store.set('ui.suggestions', key(ctx.guild.id, suggestion.id), suggestion);
      const message = await channel.send({
        content: suggestionText(suggestion),
        components: suggestionButtons(suggestion),
        allowedMentions: NO_MENTIONS,
        nonce: suggestion.id,
        enforceNonce: true,
      });
      suggestion.messageId = message.id;
      ctx.store.set('ui.suggestions', key(ctx.guild.id, suggestion.id), suggestion);
      return suggestion;
    },
  });
  add(registry, {
    id: 'suggestion.vote',
    description: 'Set your one persistent support/opposition vote on a suggestion.',
    risk: 'write',
    schema: z.strictObject({
      suggestionId: z.string().regex(/^[a-f0-9]{16}$/),
      vote: z.enum(['up', 'down']),
    }),
    execute: async (ctx, input) => {
      const initial = ctx.store.get<Suggestion>('ui.suggestions', key(ctx.guild.id, input.suggestionId));
      if (!initial) throw new UserError('Suggestion not found.');
      await resolveChannel(ctx, initial.channelId);
      const row = ctx.store.transaction(() => {
        const current = ctx.store.get<Suggestion>('ui.suggestions', key(ctx.guild.id, input.suggestionId));
        if (!current || current.status !== 'open') throw new UserError('Suggestion voting is closed.');
        if (Object.keys(current.votes).length >= 5000 && !current.votes[ctx.member.id])
          throw new UserError('Suggestion voting limit reached.');
        current.votes[ctx.member.id] = input.vote;
        ctx.store.set('ui.suggestions', key(ctx.guild.id, current.id), current);
        return current;
      });
      let displayUpdated = true;
      try {
        await updateSuggestion(ctx, row);
      } catch {
        displayUpdated = false;
      }
      return { id: row.id, vote: input.vote, displayUpdated };
    },
  });
  add(registry, {
    id: 'suggestion.review',
    description: 'Accept or deny a suggestion with a public staff decision.',
    risk: 'write',
    userPermissions: [P.ManageMessages],
    schema: z.strictObject({
      suggestionId: z.string().regex(/^[a-f0-9]{16}$/),
      decision: z.enum(['accepted', 'denied']),
      note: z.string().min(1).max(1000),
    }),
    execute: async (ctx, input) => {
      const row = ctx.store.get<Suggestion>('ui.suggestions', key(ctx.guild.id, input.suggestionId));
      if (!row) throw new UserError('Suggestion not found.');
      const channel = await resolveChannel(ctx, row.channelId);
      if (!channel.permissionsFor(ctx.member)?.has(P.ManageMessages))
        throw new UserError('Manage Messages required in the suggestion channel.');
      const updated = ctx.store.transaction(() => {
        const latest = ctx.store.get<Suggestion>('ui.suggestions', key(ctx.guild.id, row.id));
        if (!latest) throw new UserError('Suggestion no longer exists.');
        latest.status = input.decision;
        latest.note = input.note;
        latest.reviewerId = ctx.member.id;
        ctx.store.set('ui.suggestions', key(ctx.guild.id, latest.id), latest);
        return latest;
      });
      let displayUpdated = true;
      try {
        await updateSuggestion(ctx, updated);
      } catch {
        displayUpdated = false;
      }
      return { id: updated.id, status: updated.status, displayUpdated };
    },
  });
  add(registry, {
    id: 'suggestion.list',
    description: 'List paginated suggestions visible to you.',
    risk: 'read',
    schema: z.strictObject({
      page: z.number().int().min(1).max(1000).default(1),
      query: z.string().max(100).default(''),
    }),
    execute: async (ctx, input) => {
      const visible = new Set<string>();
      const rows = ctx.store
        .list<Suggestion>('ui.suggestions', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((row) => row.content.toLowerCase().includes(input.query.toLowerCase()));
      for (const channelId of new Set(rows.map((row) => row.channelId)))
        try {
          await resolveChannel(ctx, channelId);
          visible.add(channelId);
        } catch {
          /* Hidden suggestions are omitted. */
        }
      const filtered = rows
        .filter((row) => visible.has(row.channelId))
        .sort((a, b) => b.createdAt - a.createdAt);
      return {
        page: input.page,
        pages: Math.max(1, Math.ceil(filtered.length / 10)),
        suggestions: filtered.slice((input.page - 1) * 10, input.page * 10).map((row) => ({
          id: row.id,
          content: row.content,
          status: row.status,
          support: Object.values(row.votes).filter((v) => v === 'up').length,
          opposition: Object.values(row.votes).filter((v) => v === 'down').length,
        })),
      };
    },
  });
  add(registry, {
    id: 'suggestion.delete',
    description: 'Delete a tracked suggestion and its bot-owned message as a channel moderator.',
    risk: 'destructive',
    userPermissions: [P.ManageMessages],
    schema: z.strictObject({ suggestionId: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: async (ctx, input) => {
      const row = ctx.store.get<Suggestion>('ui.suggestions', key(ctx.guild.id, input.suggestionId));
      if (!row) throw new UserError('Suggestion not found.');
      const channel = await resolveChannel(ctx, row.channelId);
      if (!channel.permissionsFor(ctx.member)?.has(P.ManageMessages))
        throw new UserError('Manage Messages required in the suggestion channel.');
      if (row.messageId && channel.isTextBased()) {
        const message = await channel.messages.fetch(row.messageId).catch((error) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 10008) return null;
          throw error;
        });
        if (message) {
          if (message.author.id !== ctx.client.user?.id)
            throw new UserError('Suggestion message belongs to another account.');
          await message.delete();
        }
      }
      ctx.store.delete('ui.suggestions', key(ctx.guild.id, row.id));
      return { deleted: row.id };
    },
  });
  for (const kind of ['settings', 'moderation'] as const)
    add(registry, {
      id: `ui.${kind}.publish`,
      description: `Publish a persistent interactive ${kind} panel. Permissions are checked again on every click.`,
      risk: 'write',
      userPermissions: [kind === 'settings' ? P.ManageGuild : P.ModerateMembers],
      botPermissions: [P.SendMessages],
      schema: z.strictObject({ channelId: id }),
      execute: (ctx, input) =>
        publishPanel(
          ctx,
          kind,
          input.channelId,
          kind === 'settings' ? 'Community settings' : 'Staff moderation dashboard',
        ),
    });
  add(registry, {
    id: 'ui.message.publish',
    description:
      'Publish a styled Components V2 announcement with text, thumbnail, gallery, file components, separators, link buttons and eligible premium purchase buttons.',
    risk: 'write',
    userPermissions: [P.ManageMessages],
    botPermissions: [P.SendMessages, P.AttachFiles],
    schema: z.strictObject({
      channelId: id,
      text: z.string().min(1).max(3500),
      accent: z.number().int().min(0).max(0xffffff).default(0x6366f1),
      thumbnail: z.url().optional(),
      images: z.array(z.url()).max(6).default([]),
      files: z.array(z.url()).max(3).default([]),
      links: z
        .array(
          z.strictObject({
            label: z.string().min(1).max(80),
            url: z.url().refine((url) => new URL(url).protocol === 'https:', 'Use HTTPS links.'),
          }),
        )
        .max(5)
        .default([]),
      premiumSkuId: id.optional(),
    }),
    execute: async (ctx, input) => {
      const channel = await sendable(ctx, input.channelId);
      const container = new ContainerBuilder().setAccentColor(input.accent);
      if (input.thumbnail) {
        discordAttachmentUrl(input.thumbnail);
        container.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(input.text))
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(input.thumbnail)),
        );
      } else container.addTextDisplayComponents(new TextDisplayBuilder().setContent(input.text));
      if (input.images.length) {
        for (const url of input.images) discordAttachmentUrl(url);
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
              ...input.images.map((url) => new MediaGalleryItemBuilder().setURL(url)),
            ),
          );
      }
      const files = [];
      let bytes = 0;
      for (let index = 0; index < input.files.length; index++) {
        const data = await downloadAttachment(input.files[index]!, 8 * 1024 * 1024);
        bytes += data.length;
        if (bytes > 8 * 1024 * 1024) throw new UserError('Announcement attachments may total at most 8 MiB.');
        const name = `file-${index + 1}.bin`;
        files.push({ attachment: data, name });
        container.addFileComponents(new FileBuilder().setURL(`attachment://${name}`));
      }
      if (input.links.length)
        container.addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...input.links.map((link) =>
              new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(link.label).setURL(link.url),
            ),
          ),
        );
      if (input.premiumSkuId) {
        const skus = await ctx.client.application?.fetchSKUs();
        if (!skus?.has(input.premiumSkuId))
          throw new UserError(
            'SKU must already belong to this Discord application. Monetization eligibility is configured in the Portal.',
          );
        container.addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId(input.premiumSkuId),
          ),
        );
      }
      const message = await channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        files,
        allowedMentions: NO_MENTIONS,
      });
      return { messageId: message.id, channelId: channel.id };
    },
  });
}

type ContextSource = ActionContext | (() => Promise<ActionContext>);
export async function handleInterfaceInteraction(
  interaction: Interaction,
  source: ContextSource,
  registry: ActionRegistry,
  providedStore?: Store,
): Promise<boolean> {
  if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return false;
  if (!interaction.customId.startsWith('ui:')) return false;
  const store = providedStore ?? (typeof source === 'function' ? undefined : source.store);
  if (!store) throw new Error('Pass Store when using a lazy interface context.');
  const context = () => (typeof source === 'function' ? source() : Promise.resolve(source));
  try {
    if (!interaction.inGuild() || !interaction.channelId)
      throw new UserError('Use this interface in a server channel.');
    const guildId = interaction.guildId,
      channelId = interaction.channelId;
    enabled(store, guildId);
    const [, operation, value, argument] = interaction.customId.split(':');
    const messageId = interaction.isMessageComponent() ? interaction.message.id : undefined;
    if ((operation === 'formopen' || operation === 'formnext') && interaction.isMessageComponent()) {
      let draft: Draft;
      if (operation === 'formopen') {
        const panel = getPanel(store, guildId, value ?? '', channelId, messageId);
        if (panel.kind !== 'form' || !panel.formId) throw new UserError('Invalid form panel.');
        draft = startFormSession(store, guildId, interaction.user.id, channelId, panel.formId);
      } else {
        draft = getDraft(store, guildId, interaction.user.id, channelId, value ?? '');
        if (draft.ready) throw new UserError('This form is already ready to submit.');
      }
      await interaction.showModal(buildFormModal(getForm(store, guildId, draft.formId), draft));
      return true;
    }
    if (operation === 'ticket' && interaction.isMessageComponent()) {
      const panel = getPanel(store, guildId, value ?? '', channelId, messageId);
      if (panel.kind !== 'ticket') throw new UserError('Invalid ticket panel.');
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`ui:ticket-submit:${panel.id}`)
          .setTitle('Open a support ticket')
          .addLabelComponents(
            new LabelBuilder()
              .setLabel('Subject')
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('subject')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(100)
                  .setRequired(true),
              ),
          ),
      );
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ctx = await context();
    if (ctx.guild.id !== guildId || ctx.member.id !== interaction.user.id || ctx.channelId !== channelId)
      throw new UserError('Interface context does not match its requester.');
    const request = async (action: string, input: unknown = {}) =>
      interaction.editReply(outcomePayload(await registry.request(ctx, action, input)));
    if (operation === 'pages' && interaction.isMessageComponent()) {
      const row = store.get<PagedResult>('ui.pages', key(guildId, value ?? ''));
      if (
        !row ||
        row.userId !== ctx.member.id ||
        row.guildId !== guildId ||
        row.channelId !== channelId ||
        row.expiresAt <= Date.now()
      )
        throw new UserError('This list expired or belongs to another person/channel.');
      if (!/^\d{1,3}$/.test(argument ?? '') || Number(argument) >= row.pages.length)
        throw new UserError('Invalid page.');
      await resolveChannel(ctx, channelId);
      await interaction.editReply(pagedPayload(row, Number(argument)));
      return true;
    }
    if (operation === 'formsubmit' && interaction.isModalSubmit()) {
      const draft = getDraft(store, guildId, interaction.user.id, channelId, value ?? '');
      if (draft.ready || String(draft.step) !== argument)
        throw new UserError('This form step was already submitted or is out of order.');
      const form = getForm(store, guildId, draft.formId);
      const answers = readAnswers(interaction, form.fields.slice(draft.step * 5, draft.step * 5 + 5));
      store.transaction(() => {
        const fresh = getDraft(store, guildId, interaction.user.id, channelId, draft.id);
        if (fresh.step !== draft.step || fresh.ready) throw new UserError('This step was already used.');
        fresh.answers = { ...fresh.answers, ...answers };
        fresh.step++;
        fresh.ready = fresh.step * 5 >= form.fields.length;
        store.set('ui.drafts', key(guildId, fresh.id), fresh);
        Object.assign(draft, fresh);
      });
      if (draft.ready) {
        const outcome = await registry.request(ctx, 'form.submit', {
          sessionId: draft.id,
          ...(form.anonymous === true ? { anonymousDisclosureAccepted: true } : {}),
        });
        const review = `Review your answers before confirming. ${form.anonymous === true ? ANONYMOUS_DISCLOSURE : 'Staff receive them after approval.'}\n${stringify(draft.answers)}\n\n${outcome.status === 'confirmation' ? preview(outcome) : ''}`;
        await interaction.editReply(
          textPayload(review, outcome.status === 'confirmation' ? confirmationRows([outcome]) : []),
        );
      } else
        await interaction.editReply(
          textPayload(`Step ${draft.step} saved. Your private draft expires in 20 minutes from the start.`, [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`ui:formnext:${draft.id}`)
                .setLabel('Continue')
                .setStyle(ButtonStyle.Primary),
            ),
          ]),
        );
    } else if (operation === 'ticket-submit' && interaction.isModalSubmit()) {
      const panel = getPanel(store, guildId, value ?? '', channelId);
      if (panel.kind !== 'ticket') throw new UserError('Invalid ticket panel.');
      await request('ticket.open', { subject: interaction.fields.getTextInputValue('subject') });
    } else if (operation === 'roles') {
      const panel = getPanel(store, guildId, value ?? '', channelId, messageId);
      if (panel.kind !== 'roles') throw new UserError('Invalid role panel.');
      const selected = interaction.isStringSelectMenu() ? [...interaction.values] : [argument ?? ''];
      if (selected.length > 5 || !selected.length || selected.some((role) => !panel.roleIds?.includes(role)))
        throw new UserError('Role choice is not part of this approved panel.');
      const outcomes: Extract<ActionOutcome, { status: 'confirmation' }>[] = [];
      for (const roleId of [...new Set(selected)]) {
        const outcome = await registry.request(
          ctx,
          ctx.member.roles.cache.has(roleId) ? 'selfrole.remove' : 'selfrole.add',
          { roleId },
        );
        if (outcome.status === 'confirmation') outcomes.push(outcome);
      }
      await interaction.editReply(
        textPayload(outcomes.map(preview).join('\n\n'), confirmationRows(outcomes)),
      );
    } else if (operation === 'verification') {
      const panel = getPanel(store, guildId, value ?? '', channelId, messageId);
      if (panel.kind !== 'verification') throw new UserError('Invalid verification panel.');
      await request('verification.complete');
    } else if (operation === 'settings') {
      const panel = getPanel(store, guildId, value ?? '', channelId, messageId);
      if (panel.kind !== 'settings' || !ctx.member.permissions.has(P.ManageGuild))
        throw new UserError('Manage Server permission required.');
      const config = communitySettings(store, guildId);
      await interaction.editReply(
        textPayload(
          `Toggle a community setting.\nXP: ${config.xpEnabled}; FAQ: ${config.faqEnabled}; custom antispam: ${config.antiSpamEnabled}`,
          [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...(['xpEnabled', 'faqEnabled', 'antiSpamEnabled'] as const).map((field) =>
                new ButtonBuilder()
                  .setCustomId(`ui:setting:${panel.id}:${field}`)
                  .setLabel(`${field}: ${config[field] ? 'on' : 'off'}`)
                  .setStyle(ButtonStyle.Secondary),
              ),
            ),
          ],
        ),
      );
    } else if (operation === 'setting') {
      const panel = getPanel(store, guildId, value ?? '', channelId);
      if (
        panel.kind !== 'settings' ||
        !['xpEnabled', 'faqEnabled', 'antiSpamEnabled'].includes(argument ?? '')
      )
        throw new UserError('Unknown community setting.');
      const field = argument as 'xpEnabled' | 'faqEnabled' | 'antiSpamEnabled';
      await request('community.configure', { [field]: !communitySettings(store, guildId)[field] });
    } else if (operation === 'moderation') {
      const panel = getPanel(store, guildId, value ?? '', channelId, messageId);
      if (panel.kind !== 'moderation' || !ctx.member.permissions.has(P.ModerateMembers))
        throw new UserError('Moderate Members permission required.');
      await interaction.editReply(
        textPayload('Staff dashboard: choose a private queue.', [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`ui:staff:${panel.id}:reports`)
              .setLabel('Open reports')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`ui:staff:${panel.id}:cases`)
              .setLabel('Warning cases')
              .setStyle(ButtonStyle.Secondary),
          ),
        ]),
      );
    } else if (operation === 'staff') {
      const panel = getPanel(store, guildId, value ?? '', channelId);
      if (panel.kind !== 'moderation') throw new UserError('Invalid dashboard.');
      await request(
        argument === 'reports' ? 'report.list' : argument === 'cases' ? 'case.list' : 'invalid.action',
        {},
      );
    } else if (operation === 'suggest') {
      const row = store.get<Suggestion>('ui.suggestions', key(guildId, value ?? ''));
      if (!row || row.channelId !== channelId || row.messageId !== messageId)
        throw new UserError('Suggestion is unavailable.');
      if (argument === 'view') await interaction.editReply(textPayload(suggestionText(row)));
      else if (argument === 'up' || argument === 'down')
        await request('suggestion.vote', { suggestionId: row.id, vote: argument });
      else throw new UserError('Unknown vote.');
    } else throw new UserError('Unknown interface.');
    return true;
  } catch (error) {
    const payload = textPayload(
      error instanceof UserError
        ? error.message
        : 'The interface could not complete. Check its settings and try again.',
    );
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    return true;
  }
}
