# Public currency, GraphQL and Minecraft services

The `integrations` category includes three public services that require no additional provider key. They return bounded data through the existing action interface. Disabling `integrations` disables these actions. The configured bot identity and normal Discord action permissions still apply.

| Action                         | Input                                                    | Behavior                                                                          |
| ------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `integration.currency`         | `base`, `quote`, optional `amount` and `date`            | Fetch a dated currency rate and calculate an amount estimate.                     |
| `integration.graphql-get`      | `url`, `query`, optional `variables` and `operationName` | Send one explicitly confirmed query to an approved public HTTPS GraphQL endpoint. |
| `integration.minecraft-status` | `hostname`                                               | Query one approved public Minecraft Java server at TCP port 25565.                |

## Currency reference rates

`integration.currency` uses [Frankfurter v2's single-pair route](https://frankfurter.dev/) at `https://api.frankfurter.dev/v2/rate/{base}/{quote}`. Frankfurter publishes daily blended rates without requiring an API key. A `date` becomes the provider's historical-date parameter. Unsupported currencies, unavailable dates, provider failures and malformed responses produce errors.

Example input:

```json
{ "base": "EUR", "quote": "USD", "amount": 10, "date": "2026-10-28" }
```

Currency codes accept exactly three ASCII letters and normalize to uppercase. Amounts must be finite, from zero to one trillion; the default is one. Dates must be real calendar dates in `YYYY-MM-DD` format. The result includes the provider's actual rate date, the requested date, currency pair, source and `convertedEstimate`. An identical base/quote returns the arithmetic identity locally; this does not verify whether that code is a supported currency.

The estimate uses JavaScript number arithmetic and does not promise accounting rounding, settlement or an intraday trading quote. Rates are cached for one hour by pair/date, independent of amount. Concurrent identical requests share one fetch. Each service instance holds at most one hundred currency/Minecraft cache entries and four distinct pending cache requests; failures release pending slots. Currency JSON is limited to 32 KiB, requires a supported JSON media type, valid UTF-8, an expected pair and a positive finite rate.

## Public GraphQL GET

First use `integration.hosts` to confirm the exact endpoint hostname for the server. `integration.graphql-get` requires current Manage Server permission and the normal confirmation of the complete input. Authority, hostname approval and module state are checked again immediately before transport and before returning the response.

Example input after confirming `example.com`:

```json
{
  "url": "https://example.com/graphql",
  "query": "query Country($code: ID!) { country(code: $code) { name } }",
  "variables": { "code": "CA" },
  "operationName": "Country"
}
```

The [GraphQL HTTP format](https://graphql.org/learn/serving-over-http/) carries the document, JSON variables and optional operation name as GET parameters. The bot sends no authorization headers and provides no POST, subscriptions, authentication setup or automatic retries. Endpoint URLs may contain other parameters but cannot predefine `query`, `variables` or `operationName`. Redirects are rejected.

The local parser accepts exactly one query operation, including shorthand queries, with optional fragments. It rejects mutation/subscription operations, multiple operations, mismatched operation names, duplicate fragment names, unbalanced groups and more than 32 nested syntax groups. It understands quoted strings and comments when finding operation boundaries; block strings are deliberately unsupported. This is an operation-envelope check, not a full GraphQL grammar, remote schema validator, field cost limit or proof that the endpoint's resolvers have no side effects. The action therefore retains write-risk confirmation even for a query sent by GET.

Queries are at most 2,000 characters. Variables must contain finite JSON values with at most 1,000 nodes, ten nested levels and 2,000 serialized characters. The encoded URL must fit 4,096 characters. Responses must be valid UTF-8 JSON under 256 KiB, 10,000 nodes and 32 nested levels, with GraphQL `data` and/or a nonempty `errors` array containing error messages. HTTP 4xx GraphQL errors and HTTP 2xx application errors return `ok:false`; invalid responses and HTTP 5xx fail the action. Results have no application cache. Response content remains untrusted data and is never evaluated as code.

## Minecraft Java status

Approve the exact DNS hostname or public IPv4 literal with `integration.hosts`, then call:

```json
{ "hostname": "play.example.com" }
```

The bot performs the Java Server List Ping handshake and status request directly. It sends the normalized original hostname in the handshake and connects to one validated, pinned public DNS answer. Every DNS answer must be public with a matching IP family; an empty answer set or any private/unsupported answer rejects the request. Host input cannot contain a scheme, path, credentials, port, shorthand numeric IPv4 address or invalid DNS label. IPv6 DNS answers are supported; direct IPv6 literals are outside the hostname input format.

The TCP destination is always port **25565**. This service has no SRV lookup, custom ports, arbitrary TCP payloads, Bedrock support, RCON, login, world management or player administration. The result reports a successful status reply from the bot's network vantage point, version/protocol, online/max player counts, bounded plain MOTD and response time. Player samples, UUIDs and favicons are omitted. A timeout or connection failure is an error, not a claim that the server is globally offline.

At most two Minecraft requests run globally. A five-second total deadline covers DNS and connection/response processing; abort, close, errors, malformed framing, size excess and timeout release resources and concurrency slots. Packets are limited to 64 KiB plus their length prefix and 512 received chunks. Responses must contain one complete status packet, a valid JSON string length and valid UTF-8. Status results share a thirty-second cache with concurrent request coalescing. Host approval and module state are checked on every call, again before connection and after a response; revoked approval prevents a late result from being cached or returned.

## Verification

`test/public-services.test.ts` covers the real handshake layout, VarInts, fragmented TCP framing through a local test server, socket cleanup/cancellation, invalid responses, bounded concurrency, deadlines, cache expiry/eviction, DNS pinning, public/private answer rejection, current authorization and revocation. HTTP providers use controlled pinned transports in the test suite. The socket factory injection exists only as an internal protocol-test seam; action inputs cannot replace the transport or destination port.

A read-only public probe on 2026-10-29 successfully retrieved the dated 2026-10-28 EUR/USD rate through the production Frankfurter transport. No Discord messages, OpenAI requests or authenticated provider calls were needed for that probe.
