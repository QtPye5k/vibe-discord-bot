# Private knowledge and message summaries

Knowledge belongs to the requesting user within one server. Use private slash-command responses for document operations; a source document can contain personal data even when its name appears harmless. The model receives selected document text as part of a request, subject to the provider's data policies.

| Action                | Behavior                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `ai.knowledge.add`    | Save or replace a named text document and embedding; up to fifty documents, 12,000 characters each |
| `ai.knowledge.list`   | List your document names and sizes without an API request                                          |
| `ai.knowledge.search` | Embed a query and return up to five semantically ranked excerpts from your documents               |
| `ai.knowledge.ask`    | Retrieve up to three relevant sources and answer using bounded named excerpts                      |
| `ai.knowledge.remove` | Delete one named document after confirmation                                                       |

Names accept 1–64 letters, numbers, underscores or hyphens. Search and question actions use AI quotas and can incur provider charges. Semantic similarity does not guarantee relevance or factual accuracy. The question workflow quotes sources as untrusted data, disables administrative tools, preferences, retained chat history and web search, and asks for document-name citations. It checks sources again before delivery and cancels if a selected document was removed or changed during processing. If no sufficiently similar source exists, it returns that result without inventing a source.

Documents expire under `MEMORY_DAYS` since their last stored update, default seven days. Reading a document does not renew that stored timestamp. `/forget` or `ai.memory.forget` erases the caller's AI documents, conversation data and preferences for that server and invalidates pending AI results. Non-server personal erasure covers the caller's saved AI records across servers. Local deletion does not recall inputs already sent to a provider.

`ai.memory.pin` also provides up to twenty named private notes of 1,000 characters each that persist until unpinned or forgotten, independently of conversation retention. Pins are quoted as untrusted context and excluded from shared/public/voice requests. `/forget` also removes those pins, private workflow plans and their approval chains.

Managers can use `ai.knowledge.shared-add` to save up to one hundred server documents, each restricted to explicitly approved roles and the source channel where it was created. `shared-list` and `shared-ask` require current source visibility and readable history for both caller and bot. Managers can remove a document with `shared-remove`. Shared answers use up to three ranked excerpts, named citations, no private preferences/pins/history, no web search and no administrative tools. Exact document versions and current role/source access are checked before uploading source text and before delivery. Shared documents remain server records until removed; personal erasure does not remove a document intentionally published for approved server roles.

## Accessible channel summaries

`ai.summarize.messages` accepts a `channelId`, a limit of 1–100 messages and optional `focus`. Both caller and bot need current channel visibility and Read Message History, including private-thread access where applicable. The result identifies selected message IDs and is always labeled partial: only a bounded recent text excerpt is analyzed; attachments, older messages and truncated text are excluded.

The summary uses a separate scope without administrative tools, personal preferences, retained chat history or web search. Access is refreshed again before returning the result. It does not start continuous recording, index a server's complete history or turn channel messages into shared knowledge documents.

`ai.history.answer` adds permission-checked pagination (optional `before`, up to 500 messages), answers a question using bounded multi-stage text analysis, and reports fetched source IDs, actual analyzed/source character counts, truncation and whether older history remains. Analysis covers at most 30,000 characters in twelve excerpts plus one synthesis request; large histories are explicitly truncated and attachments are excluded. [AI workflows](AI_WORKFLOWS.md) describes document, article, log, policy and plan actions.
