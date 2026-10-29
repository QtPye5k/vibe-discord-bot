# Common room Activity

The Activity is a real browser application bundled with `@discord/embedded-app-sdk`. It shares the bot's optional HTTP listener, SQLite storage, member/channel checks, action policies and optional premium access rules. It does not need another bot token.

## Configure

Set `ACTIVITY_PUBLIC_URL` to your HTTPS origin and provide `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`. These are OAuth application settings, distinct from the bot token. The public URL enables a listener on port 3000 when `HEALTH_PORT` is blank/zero. Keep the secret on the server.

Enable Activities for the application in the Developer Portal, configure its supported launch contexts and map the Activity's `/` URL mapping to your host. The root redirects to `/activity`; bundled scripts/styles and API routes are served by the same host. A reverse proxy must preserve the expected host/origin. See [Discord's Activity setup](https://docs.discord.com/developers/activities/building-an-activity). Configure the selected OAuth consent scopes `identify` and `rpc.activities.write` for identity and the user-triggered Share presence control.

Register the configured commands, then use `/activity`, the native app entry point or the button returned by `activity.launch`. Guild-scoped command deployment keeps the primary entry point global, as required by Discord. This implementation requires an installed server channel. For voice/stage launches, the member must currently belong to that channel. Membership, channel visibility/history access, instance identity and connected-user membership are checked at authorization and refreshed during the session.

The SDK first authorizes and exchanges a code, then authenticates with Discord. Only after authentication does the backend admit the verified connected user to that exact native instance. Access tokens and room bearer credentials stay in browser memory. Native invites and presence are real SDK commands; failures are shown to the user.

## Shared tools

- Tic-tac-toe enforces player turns and terminal outcomes; the sliding puzzle starts from a solvable board.
- The whiteboard supports shared pointer/touch strokes and undo of your own strokes.
- The editor saves explicit revisions. A conflicting update keeps your local draft for review.
- Quiz rounds record one answer per person before the deadline. Learning mode adds explanatory lesson text.
- The task board creates shared tasks and moves them between To do/In progress/Done.
- The coordinate map shares labeled points with zoom/pan controls. It uses a longitude/latitude grid without claiming street or terrain imagery.
- The simulation shares gravity/bounce/particle settings and renders a local deterministic initial arrangement.
- Room statistics report local participation, tasks, strokes and game/quiz scores. Native Discord Profile Board widgets use the separate [Game Stats Widget API](GAME_STATS_WIDGETS.md).

The first active participant is host; host controls choose the shared mode and reset round/settings. The backend uses revisions and rejects stale mutations. The browser never automatically repeats a failed mutation. State reads poll every 2 seconds only while the page is visible; read/write admission is separate so polling cannot consume a write's slot. Drawing and unfinished editor/task/map drafts survive ordinary refreshes.

## Privacy and limits

Room state is shared with current authorized channel participants. `activity.erase` removes your participants/strokes/tasks/markers/scores/quiz answers and invalidates in-flight credentials. An edited shared document does not retain per-character authorship, so individually contributed text cannot be identified automatically. The channel's authorized participants can revise that shared document.

Limits include 25 active participants per room, 200 strokes/8192 points, 100 tasks, 100 map markers, 250 retained scoring identities, 50 rooms/server and 1000 globally. Inactive rooms expire after 7 days; bearer sessions expire after 15 minutes and private previews after their advertised lifetime. Admission and body sizes are bounded. Private `activity.preview` links provide an authenticated browser preview with the requester's actual Discord permissions; they do not simulate native instance membership or unlock SDK invite/presence controls.

If configured, premium subscription/durable access is checked on admission, fresh mutations and bounded read leases. Observed entitlement events invalidate those leases. Consumable credits cannot gate continuous native Activity access. Blank `PREMIUM_POLICY_FILE` leaves ordinary access rules in place.

Tests exercise room rules, exact source context, authorization/erasure races, native two-phase join, premium admission, polling limits and local browser flows. Native Discord launch/voice membership and public HTTPS still need acceptance with the operator's configured app and server.
