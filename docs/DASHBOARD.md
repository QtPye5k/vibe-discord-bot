# Local operator dashboard

The dashboard is an optional companion to the running bot. It serves a buildless interface from the bot's HTTP listener at `/dashboard`; it requires no separate website service, OAuth client secret or dashboard API key. It is off by default. The bot still needs its normal Discord configuration, and provider-backed actions still need their own credentials.

## Sign in

1. Set `ENABLE_DASHBOARD=true`, a nonzero `HEALTH_PORT`, and `DASHBOARD_BASE_URL` to the exact browser origin. For local use, keep `HEALTH_HOST=127.0.0.1` and use, for example, `HEALTH_PORT=3000` with `DASHBOARD_BASE_URL=http://127.0.0.1:3000`. Remote operation requires an HTTPS reverse proxy. The configured origin cannot include a path, query, fragment or credentials.
2. In the intended server and channel, run `/action name:dashboard.login input:{}` and confirm the action's preview.
3. Open the returned private link once within two minutes. It signs in as the requesting Discord member and redirects to `/dashboard`, removing the token from the URL.

Sign-in requires the application owner or a user in `OPERATOR_IDS`, current Manage Server permission, server membership, and current channel access for the user and bot, including Read Message History. Application ownership is refreshed on each authorization for users who are not explicitly configured operators. `DISCORD_GUILD_IDS` and the current `dashboard.login` action policy apply. A new session for the same user and server replaces the previous session. Sign-in links are credentials; do not share them. Keep the Discord response private.

A session lasts fifteen minutes and fixes the user, server and original channel. The browser cannot choose another identity or server through API input. Fresh authorization runs on every API call. Sign-out, expiry, process restart, a dashboard module toggle, loss of operator access, server exclusion or revoked channel/manager permissions prevent further access. To change context or recover after expiry, create a new sign-in link in the intended Discord channel.

## Interface

- **Overview:** current Gateway latency, process uptime, registered action count, memory, paused modules, session context and seven UTC days of observed message counts. It polls every thirty seconds while visible. Analytics come from the existing `analytics.observed` registry action and are unavailable if that action/module is disabled. Unobserved history cannot be reconstructed.
- **Action console:** search action names and descriptions, filter modules, inspect exact input schemas and permission names, and enter JSON. Read actions return immediately. Writes and destructive actions first return the existing expiring registry preview; a separate confirmation executes the reviewed input. Cancellation uses the registry as well.
- **Hosting notes:** describes the fixed session context and deployment limits without exposing configuration secrets.

The dashboard uses the same action registry and permission checks as Discord. Action-policy changes between preview and confirmation are rechecked. Browser confirmations are additionally tied to a preview created in that exact dashboard session. A Discord-only confirmation cannot be submitted through the browser API. Confirmation requests are claimed once; the interface never automatically retries mutations. If a network response is interrupted, verify the result in Discord before requesting the action again.

Generated attachments appear as Download links, bound to the signed-in session and its current permissions. Downloads expire after two minutes and can be retrieved again before expiry. A session retains at most three files totaling 24 MiB; process-wide retained files are capped at 96 MiB. New results evict the oldest retained files when necessary. A result can deliver at most three files within the same byte budget; larger files/results indicate that they need delivery through Discord. Downloads use binary attachment responses with sanitized ASCII filenames. Raw buffers are inspected before JSON serialization, avoiding large numeric arrays.

JSON results are capped at one MiB; a larger completed action result may need inspection through Discord. Input bodies are capped at 64 KiB, with a five-second absolute body deadline and at most 32 admitted dashboard requests. There are at most ten pending browser previews per session and 500 live links/sessions of each type per process.

## Hosting and security properties

The dashboard origin is checked against both the HTTP Host and the API Origin. A reverse proxy must preserve the expected Host and forward requests only to the intended bot listener. No CORS access is granted. Every API route uses POST with JSON, a custom dashboard header and, after bootstrap, a session-specific CSRF token. File GETs require the session cookie plus a matching Origin or the browser's same-origin Fetch Metadata header, and reauthorize before delivery. Browser sessions use HttpOnly, SameSite=Strict cookies; HTTPS origins add Secure. HTTP origins are accepted only for `localhost`, `127.0.0.1` or `::1`.

Every response uses no-store caching, no-referrer policy and nosniff. A nonce-based Content Security Policy restricts the buildless page; no external scripts, styles, fonts or assets are loaded. API values enter the page through textContent and safe DOM construction. The public sign-in screen contains no server data. There is no endpoint for arbitrary database queries, shell commands or direct outbound HTTP; any requested bot action still passes through its registered schema and normal authorization.

Only SHA-256 hashes of the 256-bit magic-link, session and download tokens are held in memory. CSRF values are hashed after bootstrap. Tokens, session cookies, files and previews are not stored in SQLite by this module, and the bot dashboard handler does not log request URLs or credentials. Configure reverse-proxy, tunnel and hosting access logs to omit/redact the `/dashboard/login` query string: those systems otherwise may record the one-use credential. The browser can retain a visited sign-in URL in history; its credential becomes unusable after consumption or two-minute expiry. Download paths also contain temporary random identifiers and should be omitted from access logs when possible; a matching authorized session is still required to retrieve them.

Use a dedicated bot/dashboard origin. Cookies and same-origin protections depend on that origin's integrity. Existing in-flight bot actions may finish after a session is signed out or the dashboard is disabled; those actions retain their normal registry and Discord safeguards.

## Integration and verification

`createDashboard({client,store,registry,operatorIds,guildIds,baseUrl,enabled})` returns `registerActions()`, `handle(request,response)` and `close()`. `enabled` accepts a boolean or callback. Register its action once, await `handle` before other HTTP routing, and let unrelated routes continue when it returns `false`. Call `close()` before closing the store to discard credentials. The module uses `core.featureEpochs` for dashboard toggle invalidation. It does not register or publish a hosted Site.

Offline HTTP tests exercise single-use login, expiry, Secure cookies, Host/Origin/CSRF validation, current permissions and application ownership, session isolation, registry confirmations, response redaction, body limits, a real slow-body deadline and concurrent request admission. File tests verify repeat downloads, session isolation, expiry, safe filenames and count/byte eviction. The suite also compiles the inline script and checks the page's nonce and DOM rules. Live Discord membership, reverse-proxy TLS and deployment acceptance remain environment checks.
