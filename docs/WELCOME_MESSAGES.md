# Welcome messages

Vibe sends a customizable join message, following the channel/template flow described in [Sapphire’s official welcome documentation](https://docs.sapph.xyz/#/welcomemessages). Its native embed includes the new member’s avatar, the current server name, member count and join timestamp. It needs no image-generation API call, separate service or downloaded image assets.

Use `community.configure` to set these fields. Settings are stored per server in `community.settings`; patching welcome fields preserves spam protection and other community settings.

| Field              | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `welcomeChannelId` | Existing welcome channel ID; `null` disables automatic welcomes. |
| `welcomeStyle`     | `embed` by default, or `text` for a plain message.               |
| `welcomeTemplate`  | Body text, including channel links and placeholders.             |
| `welcomeTitle`     | Embed title; defaults to `Welcome to {server}!`.                 |
| `welcomeColor`     | Six-digit hex color; default `#8b5cf6`.                          |
| `welcomeMention`   | Allow one notification to the joining member; default `true`.    |

Supported placeholders are `{user}` (member mention), `{id}`, `{name}`/`{username}`, `{displayName}`, `{server}`, `{memberCount}`/`{count}` and `{avatar}` (avatar URL). Unknown placeholders remain literal. Name/server text is escaped as Markdown; role mentions and `@everyone` never receive mention permission. Only the joining member can be notified, and `welcomeMention:false` disables that notification too.

Choose an existing public welcome channel; use general only when no suitable welcome channel exists. A template can welcome `{user}`, point them to the server’s rules and verification channels with `<#CHANNEL_ID>` links, and suggest introducing themselves in general. Channel selection is an explicit configuration choice; the bot never guesses another destination after an access failure.

The bot needs View Channel and Send Messages in that destination, plus Embed Links for the embed style. The joining member must be able to view it. Future human joins trigger delivery; bot joins are ignored. The community feature switch and the current welcome settings are checked again after member/channel refresh. This feature does not create, move, edit or assign roles.

A durable claim binds delivery to the server, member and actual join timestamp. Repeated Gateway events send only once; a genuine leave/rejoin with a new timestamp can receive another welcome. A transport failure with an unknown send result keeps its claim rather than posting a duplicate. Delivery metadata contains IDs, time and status, is bounded to 5,000 entries per server, and expires after thirty days during later join deliveries. The legacy automatic PNG-welcome hook defers while this community welcome is configured and the community feature is active, so enabling both does not post two welcome messages.

Tests use fixture joins and permission changes. They do not send a test welcome to real members.
