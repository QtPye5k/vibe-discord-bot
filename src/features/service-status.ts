import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import { assertOperator } from '../core/operator.js';
import { OPTIONAL_INTEGRATION_FIELDS } from '../integrations/provider-catalog.js';
import { ADDITIONAL_SERVICE_FIELDS } from '../service-fields.js';
/** Reports configuration names and availability, never credential values or credential-bearing URLs. */
export function registerServiceStatus(
  registry: ActionRegistry,
  options: { env: NodeJS.ProcessEnv; operatorIds: readonly string[]; healthPort: number },
) {
  registry.register({
    id: 'system.services',
    category: 'system',
    risk: 'read',
    description:
      'Inspect optional service configuration names and available action counts without exposing secret values. See docs/OPTIONAL_SETUP.md for setup and callback routes.',
    schema: z.strictObject({}),
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    execute: async (ctx) => {
      assertOperator(ctx, options.operatorIds);
      const fields = [
        ...new Map(
          [...OPTIONAL_INTEGRATION_FIELDS, ...ADDITIONAL_SERVICE_FIELDS].map((field) => [field.name, field]),
        ).values(),
      ];
      return {
        httpPort: options.healthPort || null,
        actions: { registered: registry.list().length, available: registry.listAvailable().length },
        services: [...new Set(fields.map((field) => field.provider))].map((provider) => ({
          provider,
          settings: fields
            .filter((field) => field.provider === provider)
            .map((field) => ({
              name: field.name,
              configured: !!options.env[field.name]?.trim(),
              secret: field.secret,
              description: field.description,
            })),
        })),
        notice:
          'Blank settings disable their service. Some settings are alternatives or optional refinements. Restart after editing .env; use the provider setup guide for required fields and OAuth callback registration.',
      };
    },
  });
}
