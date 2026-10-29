# Native Discord Game Stats Widgets

This module uses the actual Application Identity Profile API that powers native Profile Board widgets. It is separate from the embedded Activity's local room-statistics panel. It reuses the single Discord bot token; it does not require another bot.

The game developer must [claim the game](https://docs.discord.com/developers/platform/claim-your-game), then configure its layouts/fields under **Developer Portal → application → Games → Widget**. Discord controls eligibility and the user chooses whether to add the widget to their profile. These account/product steps cannot be enabled by an arbitrary bot command. See [Discord's widget setup](https://docs.discord.com/developers/social-layer/game-stats-widgets/widget-configuration).

Leave `GAME_STATS_PROFILES_FILE` blank to keep this optional module unavailable. To enable it, maintain a trusted game-server export with the schema in [the example](../config/game-stats-profiles.example.json), set that fixed project-relative path in `.env`, and restart. The file is capped at 1 MiB/1,000 profiles and allows one approved profile per Discord user. The game operator must verify the Discord-to-game account mapping from the game's own account system and export authoritative statistics. Do not fill it from an unverified user's claim that they own a game account. Discord command inputs cannot select a file, target another Discord user or submit statistics differing from this approved export.

The player runs `oauth.start` with `{"provider":"discord","purpose":"game-stats"}` and confirms their own verified account link. The grant must include `application_identities.write`. Identity-only, another account's, another server's, revoked or replaced grants cannot access widget data. Ordinary channel permissions and current module/action policies also apply.

- `game-stats.identities`: discover only the caller's existing native application identities, including exact provider fields.
- `game-stats.source`: inspect the caller's approved game-ID/stat snapshot and obtain the exact `nextUpdateRequest` containing its source hash and full payload.
- `game-stats.update`: review/confirm that exact request. The module compares the complete payload against the approved source, refreshes the user's grant and native identity, rechecks the source, then PATCHes the real native profile. First-time creation uses only the approved game ID; a conflicting existing identity stops the write.
- `game-stats.profile`: read one of the caller's currently verified native identities. It returns username/stat fields rather than arbitrary internal metadata.
- `game-stats.remove`: confirm removal of the exact currently verified own provider type, game ID and optional provider ID. Discord may refuse deletion of the final account-linking identity; profile-only `NONE` identities can be removed.

When a PATCH includes `data`, Discord replaces the entire prior `data` object, removing omitted fields. The confirmation/source preview makes this explicit; there is no implicit read/merge that can overwrite an unseen concurrent update. Primary stat values, dynamic field types, public media URLs, unique field keys, thirty-field maximum and a strict serialized UTF-8 data budget below 10,000 bytes are validated locally. A source/grant/access change stops pending dispatch or suppresses late private results. Requests already accepted remotely cannot be recalled and are not automatically repeated by this module.

The [official API reference](https://docs.discord.com/developers/resources/application-identity-profile) defines:

| Operation               | Exact route                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Discover own identities | `GET /users/{user_id}/application-identities/{application_id}`                                                   |
| Read profile            | `GET /applications/{application_id}/users/{user_id}/identities/{provider_issued_user_id}/profile`                |
| Update profile          | `PATCH /applications/{application_id}/users/{user_id}/identities/{provider_issued_user_id}/profile`              |
| Remove identity/profile | `POST /users/{user_id}/application-identities/{application_id}/{provider_type}/{provider_issued_user_id}/delete` |

Removal is the documented POST deletion operation, not an invented HTTP DELETE route. [Sending game data](https://docs.discord.com/developers/social-layer/game-stats-widgets/sending-game-data) describes the bot-token authorization plus player OAuth prerequisite. Offline tests verify these exact methods/routes, payloads, confirmations, ownership/scopes, source replacement, revocation, concurrent admission and byte limits. They do not claim that this operator owns a claimed game, completed the Portal layout or updated a live player profile.
