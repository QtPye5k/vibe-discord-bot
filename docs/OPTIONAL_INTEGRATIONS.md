# Optional service integrations

Optional adapters use named host configuration. Blank required values disable that provider: its actions stay documented but are hidden from normal command/tool discovery and cannot create or execute confirmations. Enter the desired provider values in `.env`, restart the bot, and inspect `integration.services`. No rebuild is needed. “Enabled” means configuration is present, not that a live provider has accepted the credentials, account, scopes or billing.

Credentials never belong in `/action` input. Schemas accept resource identifiers, selected content and operations. Existing bot/OpenAI credentials do not authorize these additional accounts. Provider onboarding, domain verification, API enablement, grants and quotas still apply to the selected account.

## Configuration and operations

| Provider     | Configuration                                                                                                                                                                                        | Concrete operations                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google       | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and user linking; or shared `GOOGLE_REFRESH_TOKEN`; `GOOGLE_ACCESS_TOKEN` is a short-lived alternative. Optional `GOOGLE_CALENDAR_ID`, default `primary`. | Calendar events/appointments create, update and cancel; Sheets range reads and RAW writes; Drive search, binary download, PDF/text export and text upload.                    |
| GitHub       | `GITHUB_TOKEN`                                                                                                                                                                                       | Authenticated repository, commits, releases, issues, pull requests and workflow runs; confirmed issue creation.                                                               |
| GitLab       | `GITLAB_TOKEN`; optional `GITLAB_BASE_URL`, default `https://gitlab.com`                                                                                                                             | Authorized project metadata, pipelines and confirmed issue creation.                                                                                                          |
| Trello       | `TRELLO_API_KEY`, `TRELLO_TOKEN`                                                                                                                                                                     | List cards and create reviewed task cards.                                                                                                                                    |
| Notion       | `NOTION_TOKEN`                                                                                                                                                                                       | Shared-page search, current data-source query and child-page creation. The adapter pins `Notion-Version: 2025-09-03`.                                                         |
| YouTube      | `YOUTUBE_API_KEY`                                                                                                                                                                                    | Channel identity/statistics/uploads-playlist discovery and recent upload listing.                                                                                             |
| Twitch       | `TWITCH_CLIENT_ID` plus `TWITCH_CLIENT_SECRET` or `TWITCH_ACCESS_TOKEN`                                                                                                                              | Broadcaster metadata and actual live-stream status. Client-secret configuration acquires/caches an app access token.                                                          |
| Resend email | `RESEND_API_KEY`, `EMAIL_FROM`                                                                                                                                                                       | Confirmed plain-text sending to 1–5 exact recipients and retrieval of a received email by ID. Sender/receiving-domain setup is provider-side.                                 |
| Twilio SMS   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`                                                                                                                                             | Confirmed sending to one E.164 recipient. A queued result is not proof of delivery.                                                                                           |
| VirusTotal   | `VIRUSTOTAL_API_KEY`                                                                                                                                                                                 | Existing URL/file reputation, confirmed URL/file submission and analysis-job status. File submissions upload the selected Discord attachment to an external scanning service. |
| Turnstile    | `TURNSTILE_SECRET_KEY`, `TURNSTILE_EXPECTED_HOSTNAME`; `TURNSTILE_SITE_KEY` for the web widget                                                                                                       | Actual single-use token verification, including exact hostname and expected action. The low-level verify action itself does not assign a role.                                |
| Steam        | `STEAM_API_KEY`                                                                                                                                                                                      | Real player/game statistics and achievements by explicit SteamID/AppID. Private/inaccessible profiles remain provider-restricted.                                             |
| AfterShip    | `AFTERSHIP_API_KEY`                                                                                                                                                                                  | Register a carrier/tracking number and retrieve shipping status/checkpoints by record ID. The adapter pins Tracking API `2026-07`.                                            |
| Shopify      | `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`; optional `SHOPIFY_API_VERSION`, default `2026-10`                                                                                                             | Fixed GraphQL product/variant availability, prices and inventory query with separately encoded search variables.                                                              |
| Mastodon     | `MASTODON_BASE_URL`, `MASTODON_ACCESS_TOKEN`                                                                                                                                                         | Account lookup, posts and confirmed text publication. The default publication visibility is unlisted.                                                                         |
| Runway       | `RUNWAY_API_KEY`; optional `RUNWAY_VIDEO_MODEL`, default `gen4.5`                                                                                                                                    | Confirmed text/image-to-video generation, task status/output URLs and confirmed task cancellation.                                                                            |
| Shotstack    | `SHOTSTACK_API_KEY`; optional `SHOTSTACK_ENVIRONMENT`, `stage` or `v1`, default `stage`                                                                                                              | Confirmed edit jobs with up to ten public clips/120 timeline seconds, plus actual job status/output URL. Stage keys and production keys are separate provider configuration.  |
| Cloudflare   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                                                                                                                                                      | Worker listing, DNS-record listing and exact confirmed DNS record updates in an authorized zone.                                                                              |

Use `/help search:integration.` and `/schema name:ACTION_ID` for current exact fields. The schemas and fixed operations do not expose arbitrary URLs, credentials, HTTP methods, GraphQL mutations or shell commands.

### Account ownership

Shared host credentials represent the operator's service account. Their actions require an application operator (`OPERATOR_IDS` or current application owner), current Manage Server permission and source-channel access. A guild administrator does not automatically receive access to the hosting operator's private accounts.

Google additionally accepts per-member linked credentials from the account-linking service. An ordinary member can use only a credential whose user/server IDs match their current context. Calendar, Sheets and Drive actions require appropriate granted Google scopes and current member/bot View Channel and Read Message History. An identity-only grant does not unlock document/calendar access. `drive.file` limits Drive access to files granted to or created by that application. Shared/legacy string tokens remain operator-only.

Linked grants are checked before each outbound operation and before private result delivery. Unlinking, changing account/grant version, withdrawing a scope or losing channel access cancels late results. A request already accepted by a provider cannot be recalled by local cancellation.

## Durable provider monitors

`integration.provider-watch.create` is a confirmed operator policy. It names a source, target channel and polling interval of 60–86,400 seconds (default 300). The first successful read establishes a baseline. Subsequent meaningful metadata changes notify the reviewed channel. Provider payloads are reduced to selected titles, times, IDs, URLs and status/price/inventory fields; full private documents, email bodies, customer addresses and authorization tokens are not copied into notifications or retained baselines.

| `kind`               | Exact `source` fields                                                |
| -------------------- | -------------------------------------------------------------------- |
| `google-calendar`    | `calendarId`                                                         |
| `youtube-uploads`    | `playlistId` obtained from channel content details                   |
| `twitch-live`        | `login`                                                              |
| `steam-achievements` | `steamId`, `appId`                                                   |
| `shopify-products`   | Optional `query`                                                     |
| `mastodon-posts`     | `accountId`                                                          |
| `parcels`            | `trackingId`                                                         |
| `gitlab-pipelines`   | `projectId`                                                          |
| `github-releases`    | `owner`, `repository`                                                |
| `github-pulls`       | `owner`, `repository`, optional `number` for a specific pull request |
| `github-runs`        | `owner`, `repository`, optional `branch`                             |

Example, with a real configured Twitch account and actual destination ID:

```json
{
  "id": "stream-alerts",
  "kind": "twitch-live",
  "source": { "login": "YOUR_BROADCASTER" },
  "channelId": "YOUR_DISCORD_CHANNEL_ID",
  "intervalSeconds": 300
}
```

At most 25 monitors per server and 500 per host are retained; at most five due monitors run per sweep. Current author/operator permission, action policy, module state and target-channel permission are checked again. Missing provider configuration or a disabled module pauses admission. API failures back off and pause after five failures. Providers may impose lower quotas; configure intervals accordingly.

Google calendar monitors bind the account and authorization revision selected at creation. Relinking an account or replacing shared Google credentials requires recreating the monitor after reviewing its calendar source and destination; an existing monitor never silently switches to the newly linked account. Each read and notification rechecks that binding.

Notifications use a stable Discord nonce. An interrupted/ambiguous send pauses the monitor rather than retrying automatically. Inspect Discord, then use `integration.provider-watch.resume` with `remoteStateReviewed:true` and `pendingOutcome:"delivered"` or `"not-delivered"`. A delivered outcome advances the retained baseline; a not-delivered outcome allows the explicitly reviewed retry. `integration.provider-watch.remove` deletes the monitor/baseline.

## Transport and verification

Authenticated requests bind credentials to an exact configured HTTPS origin. Public DNS addresses are validated and the actual TLS connection is pinned; mixed/private DNS, redirects, userinfo URLs and custom ports are rejected. Private home-server/remote-admin access uses a different trusted-host design. Requests admit at most four globally/two per provider, with a 15-second network budget and explicit request/response/JSON limits. There is no automatic write retry. API error bodies, token headers and secret URLs are not exposed in errors. Results redact known credentials and token fields while preserving binary attachments.

Offline fixtures exercise actual route/body/header construction, normal registry confirmations, blank configuration, account ownership/scopes/revocation, DNS/redirect boundaries, response limits, concurrency, provider monitors, ambiguous-send recovery and real Buffer delivery. These tests do not authenticate a supplied account, send an email/SMS, generate paid video, change DNS or establish provider eligibility.

Primary API references: [Google Calendar](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [Sheets](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get), [Drive](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list), [GitHub](https://docs.github.com/en/rest), [GitLab](https://docs.gitlab.com/api/), [Trello](https://developer.atlassian.com/cloud/trello/rest/), [Notion data sources](https://developers.notion.com/reference/query-a-data-source), [YouTube](https://developers.google.com/youtube/data/reference/rest), [Twitch](https://dev.twitch.tv/docs/api/reference/), [Resend](https://resend.com/docs/api-reference/emails/send-email), [Twilio](https://www.twilio.com/docs/messaging/api/message-resource), [VirusTotal](https://docs.virustotal.com/reference/url-info), [Turnstile](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [Steam](https://partner.steamgames.com/doc/webapi/ISteamUserStats), [AfterShip](https://www.aftership.com/docs/tracking/quickstart/api-quick-start), [Shopify](https://shopify.dev/docs/api/admin-graphql/latest/queries/products), [Mastodon](https://docs.joinmastodon.org/methods/accounts/), [Runway](https://docs.dev.runwayml.com/guides/using-the-api/), [Shotstack](https://shotstack.io/docs/api/) and [Cloudflare](https://developers.cloudflare.com/api/).
