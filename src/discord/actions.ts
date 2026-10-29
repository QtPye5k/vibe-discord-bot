import type { ActionRegistry } from '../core/registry.js';
import { registerGuildActions } from './actions/guild.js';
import { registerChannelActions } from './actions/channels.js';
import { registerRoleMemberActions } from './actions/members.js';
import { registerMessageActions } from './actions/messages.js';
import { registerResourceActions } from './actions/resources.js';

export function registerDiscordActions(registry: ActionRegistry): void {
  registerGuildActions(registry);
  registerChannelActions(registry);
  registerRoleMemberActions(registry);
  registerMessageActions(registry);
  registerResourceActions(registry);
}
