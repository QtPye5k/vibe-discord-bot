# Local operator-curated plugins

The plugin loader extends the action registry with explicitly configured local JavaScript modules. A configured ID `example` maps to `<project>/plugins/example/index.js`. IDs use lowercase letters, digits or hyphens and cannot contain paths, extensions or reserved Windows device names. The loader does not discover or install unconfigured directories and has no Discord upload/install/eval command.

Plugins are fully trusted process code. The operator must review and place them on disk. They can import Node APIs and access the same process credentials/resources as the bot; this mechanism is not a security sandbox. Realpath checks prevent a configured plugins directory from escaping the project, a configured module directory from escaping the plugin root, or its entry file from escaping its module directory. These checks do not defend against a trusted local administrator concurrently rewriting code after validation.

A module can expose named exports or one default object with `name`, `version`, `register` and optional `cleanup`. `name` must match its configured ID, and `version` must be a version such as `1.0.0` or `1.0.0-beta.1`. The registration function receives a staging `ActionRegistry` and `{ z, permissions }`, where `z` is the application's Zod API and `permissions` contains Discord permission constants.

```js
export const name = 'example';
export const version = '1.0.0';

export function register(registry, { z, permissions }) {
  registry.register({
    id: 'example.echo',
    category: 'plugins',
    description: 'Return supplied text privately.',
    schema: z.strictObject({ text: z.string().max(500) }),
    userPermissions: [permissions.ViewChannel],
    botPermissions: [],
    risk: 'read',
    execute: (_ctx, input) => input.text,
  });
}
```

Actions must have valid unique IDs, nonempty descriptions, a Zod schema, permission arrays, a supported risk and an executable callback. Writes/destructive behavior must be classified accurately by the plugin author so the standard confirmation machinery applies. Plugin actions use the same permission, module/policy, confirmation, audit and AI tool dispatch paths as built-in actions. At most twenty plugin IDs, one hundred actions per plugin and five hundred total staged actions are allowed.

All configured modules register into a staging catalog. Imports, metadata, registration, action contracts and collisions are validated before any actions enter the main catalog. A failed plugin leaves the main catalog unchanged, including actions staged by earlier plugins in that same load call. This rolls back registry installation; arbitrary side effects performed by trusted module code cannot be automatically undone.

An async registration function is supported. It can return a cleanup function, and a module can also export cleanup. Cleanup runs once, in reverse registration order, and continues through failures. The loader returns loaded IDs, versions, action counts and the cleanup function; shutdown should await cleanup before closing shared resources. Error reports retain error classes without leaking arbitrary thrown message text. Cleanup does not remove installed actions at runtime; this is a startup/shutdown plugin lifecycle, with no hot unload/reload command. Plugin registration and cleanup must complete promptly and release their own resources.

Tests import real temporary ESM files, including paths with spaces and `#`, confirm source bytes remain unchanged, reject traversal/junction escapes, check all-or-nothing catalog installation, and exercise lifecycle ordering/failure handling.
