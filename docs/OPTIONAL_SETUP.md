# Optional setup

The normal bot uses `DISCORD_TOKEN` and, for AI, `OPENAI_API_KEY`. `pnpm configure` appends missing configuration fields without replacing saved values. Every optional credential field starts blank. Fill only the services you want, restart, then use `/action name:system.services input:{}` to inspect configuration names and action availability. No secret is accepted through Discord commands.

Configuration presence enables an adapter; the provider still validates its key, scopes, plan and resource permissions. Passive posting, relays, monitors, verification policies and automations additionally need their reviewed Discord configuration. This prevents entering a key from silently enabling background messages.

## Accounts and public routes

Use a public HTTPS origin that you control. Set `APP_PUBLIC_URL` for account linking/CAPTCHA and `ACTIVITY_PUBLIC_URL` for Activities. Either setting starts the companion HTTP listener on port 3000 when `HEALTH_PORT` is blank or zero. An explicit nonzero port takes precedence. `HEALTH_HOST` defaults to loopback; an HTTPS reverse proxy on the same host forwards to it. Development accepts loopback HTTP. TLS/domain/proxy hosting is supplied by your host, rather than created by entering an API key.

Register these **exact callback URLs** with the selected provider, replacing the origin with your own:

| Provider | Environment                                                              | Callback                                   |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| Discord  | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `APP_PUBLIC_URL`           | `https://YOUR-HOST/oauth/callback/discord` |
| Google   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_PUBLIC_URL`             | `https://YOUR-HOST/oauth/callback/google`  |
| GitHub   | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `APP_PUBLIC_URL` | `https://YOUR-HOST/oauth/callback/github`  |

`oauth.start` issues a private browser link for your selected purpose. Complete provider consent, then explicitly confirm the returned account ID with `oauth.link.confirm` in the original Discord context. Tokens are encrypted locally. A private key is generated in `data/oauth.key` unless `OAUTH_ENCRYPTION_KEY` supplies a 32-byte base64 key. Preserve this key with its database; changing or losing it requires relinking. `oauth.unlink` removes the local grant. Provider-side revocation remains available in that provider's connected-app settings.

Google calendar, Drive and Sheets purposes request their relevant scopes. Identity-only linking does not grant document access. Enable the selected Google APIs for your OAuth project. Shared host Google credentials are an operator-only alternative described in [OPTIONAL_INTEGRATIONS.md](OPTIONAL_INTEGRATIONS.md).

OAuth self-join uses `OAUTH_JOIN_GUILD_IDS`: enter the approved target server IDs, install the bot there, and request purpose `join` with that exact `joinGuildId`. The requester links their own Discord identity with `guilds.join`, then confirms `oauth.guild.join`. This cannot bypass bans, rules screening or server eligibility. No roles or nickname are assigned by this action.

## Hosted features

| Feature                   | Setup                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord Webhook Events    | `ENABLE_WEBHOOK_EVENTS=true`, nonzero `HEALTH_PORT`, HTTPS proxy, optional `DISCORD_PUBLIC_KEY`. The Portal **Webhook Events URL** is `https://YOUR-HOST/discord/events`. This route handles signed Webhook Events; Gateway events continue over the bot connection.                                        |
| Embedded Activity         | Set `ACTIVITY_PUBLIC_URL`, Discord client ID/secret. Enable Activities in the app's Developer Portal and map `/` to the HTTPS host. Deploy commands after configuring it. Launch `/activity` or the app's entry point in an installed server. [ACTIVITIES.md](ACTIVITIES.md) covers the runtime and limits. |
| Member CAPTCHA            | Set `APP_PUBLIC_URL`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`; authorize your exact hostname in Cloudflare. A manager enables `captchaRequired` on the verification policy. Members request `verification.captcha.start`, complete their own challenge and acknowledge the server rules in Discord.    |
| Native Game Stats Widgets | Set `GAME_STATS_PROFILES_FILE` to the approved identity/stat export and link purpose `game-stats`. Claim/configure your game's widget layout in Discord. [GAME_STATS_WIDGETS.md](GAME_STATS_WIDGETS.md) describes the actual native API, source format and eligibility.                                     |
| Premium offerings         | Set `PREMIUM_POLICY_FILE` after configuring eligible Discord SKUs, pricing and payouts. [PREMIUM.md](PREMIUM.md) provides the policy template and supported subscription/durable/consumable flows. Blank leaves ordinary bot actions free of premium restrictions.                                          |
| Operator dashboard        | `ENABLE_DASHBOARD=true`, nonzero `HEALTH_PORT`, `DASHBOARD_BASE_URL` for remote HTTPS. Use a confirmed `dashboard.login` link. [DASHBOARD.md](DASHBOARD.md).                                                                                                                                                |

The bot implements entitlement checks, checkout buttons, usage/credits and configured benefits. Discord controls application eligibility, discovery approval, store publishing, game claims, pricing and payout onboarding. Those account-specific Portal actions have no substitute bot-token endpoint. The supplied setup links and configuration do not represent those approvals as already granted.

## Other services

[OPTIONAL_INTEGRATIONS.md](OPTIONAL_INTEGRATIONS.md) lists Google, GitHub/GitLab, Trello, Notion, YouTube/Twitch, Steam, Shopify, AfterShip, Mastodon, Cloudflare, VirusTotal, email/SMS, Runway and Shotstack fields and operations. Leave each provider's fields blank to keep its actions unavailable. Video generation/editing uses the optional video providers because the former OpenAI Videos API has retired.

`website.analytics` uses `PLAUSIBLE_API_KEY` and `PLAUSIBLE_SITE_ID` for authenticated traffic, acquisition and goal conversions from your selected site. The key must belong to the team owning that site and have Stats API access under an eligible plan. It calls the [Plausible Stats API v2](https://plausible.io/docs/stats-api). No arbitrary website or bearer credential can be supplied through the command.

For approved PostgreSQL reads, copy `config/external-database.queries.example.json` to a private configuration file, replace its reviewed named queries, and set `EXTERNAL_DATABASE_URL` plus `EXTERNAL_DATABASE_QUERIES_FILE`. Use a database role restricted to read-only access. SQL and connection strings cannot be chosen through Discord. [COMMUNITY_AND_AUTOMATION.md](COMMUNITY_AND_AUTOMATION.md) covers bounds and query permissions.

## Host processes, releases and webhooks

- Fixed local tasks use `LOCAL_OPERATIONS_MANIFEST`. The optional remote companion uses `REMOTE_AGENT_URL`/`REMOTE_AGENT_KEY`; start its separate process with `pnpm start:agent`. The companion reads `HOST_AGENT_MANIFEST` and `HOST_AGENT_KEY` (blank generates private `data/host-agent.key`). Copy that key privately to the controlling bot's `REMOTE_AGENT_KEY`. Default bind/port are `127.0.0.1:3010`; use an HTTPS reverse proxy for remote access. Only named fixed tasks are executable. No arbitrary shell input is accepted. [LOCAL_OPERATIONS.md](LOCAL_OPERATIONS.md).
- `pnpm start:monitor` runs independently using `MONITOR_TARGET_URL` and `MONITOR_DISCORD_WEBHOOK_URL`. Run it on another host to detect loss of the bot's host. It persists outage/recovery alerts and retries failed delivery; ambiguous webhook acceptance can result in a duplicate carrying the same alert ID. It sends nothing while healthy and unchanged.
- Managed releases use `DEPLOYMENT_RELEASES_DIRECTORY=data/releases` and `DEPLOYMENT_ACTIVE_FILE=data/deployment-active.json`, plus `pnpm start:supervised` (or the Compose restart policy). Stage a built release with `node scripts/stage-release.mjs . data/releases release-2026-01`, using your own unique lowercase release ID. Review its manifest/hash before confirming deployment. Activation validates every file and takes an online database snapshot. Rollback selects prior code while preserving current compatible database contents; restoring a snapshot is a separate deliberate operator action. For Compose, copy approved release folders into its mounted `/app/data/releases` volume; the host project's `data` directory is not that named Docker volume. See [COMMUNITY_AND_AUTOMATION.md](COMMUNITY_AND_AUTOMATION.md).
- Deployment notifications use `DEPLOYMENT_WEBHOOK_SECRET` and `POST /hooks/deployments`; configure an exact Discord destination with the typed deployment-notification actions. The HMAC format and payload are documented in that guide. This route reports deployment events; it does not accept uploaded code or execute a deployment.
- Outgoing automation uses `OUTBOUND_AUTOMATION_URL`/`OUTBOUND_AUTOMATION_KEY`. Configure the exact permitted event subscription in Discord. Deliveries contain selected event metadata and a stable idempotency ID, signed for that fixed receiver.

## Moving the project

Run `pnpm package:portable` for `releases/discord-bot-portable.zip`. It contains source, the dependency lockfile, build/setup scripts, docs and example configuration, with a SHA-256 source manifest. It excludes `.env`, keys, databases, logs, backups and installed dependencies.

On another computer, extract it, install Node 24.17+ in the 24.x series, pnpm 11.25.0 and FFmpeg/ffprobe, then run `SETUP.cmd` on Windows or `sh setup.sh` on Linux. Dependencies are installed for that destination OS/CPU. Copy your `.env` and private data separately only when you intend to migrate that installation. For an existing installation preserve its database and encryption keys together. Docker builds a Linux runtime with the same locked application dependencies; configure the same environment and persistent data volume.

Relative data/configuration paths resolve against the installation folder even when launched from another working directory. Staged release code uses `BOT_WORKSPACE_ROOT` to retain that installation's configuration/data, while code assets come from the selected release. Keep staged releases under the installation tree so they can resolve its installed dependencies, or supply compatible production dependencies on the destination release host.

Compose mounts the host's `config/` directory read-only at `/app/config`, so the same project-relative policy/query/profile paths work in the container. Private configuration files are ignored by Git and excluded from the image build context and source archive; copy them separately during a deliberate migration. The source archive includes only `*.example.json` from that directory. Ensure the container's non-root user can read the selected files. The database, OAuth key and staged releases remain in the writable `bot-data` volume.
