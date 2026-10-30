# Public images, GIFs, and generated image posting

Vibe can find media and post it to any server text channel or thread the requesting member and bot can currently use. It resolves actual channel IDs, checks current membership and destination permissions, disables mentions, and returns the actual Discord message receipt. Natural requests can choose a relevant result and post it directly under smart confirmation policy.

- `image.search`: public Commons images by default; optional `provider: pinterest` uses Pinterest's approved public partner search.
- `gif.search`: approved KLIPY when configured, otherwise Commons. An explicit provider request never silently switches catalogs.
- `media.search-send`: post an exact returned selection, with optional destination `channelId`.
- `media.generate-send`: generate an OpenAI image and post its verified bytes to optional `channelId`, using `OPENAI_API_KEY`, the configured `OPENAI_IMAGE_MODEL`, and the same AI access/quota controls as chat.
- `media.link-send`: post a supplied original Pinterest Pin or KLIPY GIF page link, without scraping or a provider credential.

For example: “Vibe send a waving GIF from KLIPY in #general,” “Find a landscape image on Pinterest and post it in #art,” or “Generate a watercolor fox and post it in #art.” You can also supply a full Pinterest Pin link and ask Vibe to post it. Discord controls third-party link previews; preview availability and animation are not guaranteed.

Optional provider setup
-----------------------

Set optional fields in the local `.env`; blank fields leave that provider unavailable. Commons and supplied public-link sharing need no extra key.

| Field                    | Purpose                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `KLIPY_API_KEY`          | KLIPY application key obtained through its Partner Panel.                                                 |
| `KLIPY_BOT_APPROVED`     | Leave `false` until KLIPY has approved this server-side Discord integration and direct-link presentation. |
| `PINTEREST_ACCESS_TOKEN` | Pinterest OAuth token for an app approved for public partner search, with `boards:read` and `pins:read`.  |
| `PINTEREST_COUNTRY_CODE` | Uppercase country code for public search, default `US`.                                                   |

KLIPY's [integration requirements](https://docs.klipy.com/integration-requirements) require prior approval for custom server-side integrations. Vibe keeps KLIPY results separate and ordered, preserves media URLs and delivery parameters, posts a direct provider link, and reports a successful share using a pseudonymous user identifier. It never downloads, mirrors, or retains KLIPY media bytes. Unsupported result compositions fail clearly rather than being silently rewritten. See its [GIF search](https://docs.klipy.com/gifs-api/gifs-search-api) and [share API](https://docs.klipy.com/gifs-api/gifs-share-trigger-api).

Pinterest's [official API description](https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml) marks `/v5/search/partner/pins` as restricted beta access. An ordinary account token alone may be refused. Vibe does not substitute `/search/pins`, because that account-scoped search can include private Pins. Public partner search returns supported image Pins; Pinterest does not expose a GIF-only search or animation-discovery contract. A supplied original public Pin URL can still be posted through `media.link-send`; any available animated preview is controlled by Pinterest and Discord. No cookies, private endpoints, browser scraping, or automatic short-link resolution are used.

OpenAI images use the [Images API](https://developers.openai.com/api/reference/resources/images/methods/generate). A destination is checked before incurring generation cost and refreshed after generation. Returned image bytes must be supported raster data within 8 MiB. Only the destination message receipt is returned, so the image is not posted again into the originating conversation.

Permission checks and duplicate protection
------------------------------------------

Search selections are bound to the originating member, server, and conversation channel for ten minutes. Changing the destination does not change that binding. The exact returned search ID, index, and title are required. Each result is claimed before sending; an uncertain Discord response prevents automatic retries. Selections are bounded to ten per member/server, one hundred per server, and five hundred globally.

Generation and supplied-link requests accept an optional `requestId`. Repeating the same ID and payload returns its completed receipt; using the ID for a different payload fails. A repeated identical request without an ID is suppressed for one minute. Receipts expire after ten minutes, with ten per origin/member and five hundred globally. Concurrent duplicate generations are rejected before another paid call. An uncertain send remains blocked; inspect the destination before making a new request.

The destination requires View Channel and Send Messages (Send Messages in Threads for a thread). Both member and bot also need Attach Files for image attachments or Embed Links for provider links. Fresh access and voice-request cancellation are checked after provider/processing waits and immediately before dispatch.

Commons search remains credential-free through the [official API](https://commons.wikimedia.org/wiki/Commons:API/MediaWiki). It returns up to five PNG, JPEG, WebP, or GIF files within 2 MiB and 40 million pixels, with source/artist/license metadata. Public JSON is capped at 256 KiB. Its cache is limited to one hundred entries for five minutes and four active queries. Downloads validate public DNS and pin the HTTPS connection, reject redirects, restrict the upload host/path, and verify actual bytes. Attribution links identify the uploader's license terms; the bot cannot independently certify those claims.

Provider search calls use fixed official API hosts and bounded JSON, never arbitrary external requests. KLIPY/Pinterest media is posted as a direct validated provider URL. Credentials stay in optional local environment fields and are registered for log redaction. Tests use synthetic provider responses, real image bytes, and sandbox Discord sends; provider-account approval is an external prerequisite and is not claimed by offline tests.
