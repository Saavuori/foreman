# Knowledge base

The library agents search: Confluence pages, uploaded files and notes, arranged in one tree and
handed to agents a branch at a time. Design and build order: [PLAN-3-knowledge.md](../../../PLAN-3-knowledge.md)
(slices A and B are built; C — PDF, Word, PowerPoint, images — and D — search quality
measurement — are not).

Files:

| File | Owns |
|---|---|
| `src/knowledge.ts` | `KnowledgeHub`: the tree, passages, the full-text index, embeddings, search, read |
| `src/extract.ts` | Text out of HTML / Confluence storage format / Markdown, passage splitting, the FTS query builder, the built-in embedder |
| `src/confluence.ts` | `ConfluenceClient` (REST v1, Data Center and Cloud), `ConfluenceSync` (import, sync, exclusions), `MockConfluence` |
| `src/capabilities/knowledge.ts` | `knowledge.*`, `confluence.*`, `mockconfluence.change` |
| `src/tools.ts` | The agent tools `knowledge_search` and `knowledge_read` |

## The tree

Table `kb_nodes`. A node is a `folder`, a `page` (from Confluence; may have children) or a
`file` (uploads and notes). Everything else hangs off nodes:

- **Scope is a list of node ids.** `spec.knowledge` on an agent, and `scope` on a search, each
  cover everything beneath the listed nodes (`expand`, a recursive CTE). There is no separate
  "collection" concept: a folder is the collection.
- **Removing** deletes the node and its subtree, passages and vectors. Inside a Confluence
  import, removing anything but the import's root marks the branch **excluded** instead, so the
  next sync does not bring it back. `knowledge.include` undoes that. Excluded branches are left
  out of `expand`, so agents never see them.
- **Moving** is allowed anywhere except into the node's own subtree.
- `updateDocument` re-indexes only when the title or text actually changed (content hash), so a
  sync that finds nothing new costs no embedding calls.

## Passages and search

`toPassages` splits text at headings into passages of roughly 400–2,400 characters and keeps
the heading path ("Runbooks › Deploying › Rollback") on each one. A heading with no body is
carried into the next passage rather than becoming a passage of its own.

Each passage is in two indexes:

1. **Full text** — the FTS5 table `kb_fts` (porter stemmer), BM25 weights 4 / 2 / 1 for title,
   heading, text. `ftsQuery` turns a question into an OR of quoted words, with prefix matching
   for words of four letters or more and a small English and Finnish stop list.
2. **Vectors** — `kb_chunks.embedding`, normalised and quantised to int8, tagged with the
   embedder key (`embed_model`). They are loaded into memory once and compared by brute force;
   for a few thousand pages that takes milliseconds and needs no vector database.

`search` takes the top 60 of each, fuses them with reciprocal rank fusion (k = 60), allows at
most two passages per document, and returns `{ hits, mode, tookMs, note }`. `mode` is `hybrid`
or `keyword`; `note` says why meaning search was not used (no embedder, vectors still being
built, the provider failing). Keyword search never depends on the embedder.

### Embedders

Setting `knowledge`, changed with `knowledge.configure`:

| `kind` | Calls | Notes |
|---|---|---|
| `builtin` (default) | nothing | Feature-hashed words and four-letter word pieces, 384 dimensions. Copes with inflected and compound words; does **not** understand meaning |
| `openai` | `POST {baseUrl}/embeddings` | Any OpenAI-compatible endpoint; key from the vault (`secretName`) |
| `azure` | `POST {baseUrl}/openai/deployments/{model}/embeddings?api-version=…` | Azure OpenAI; `model` is the deployment name |
| `none` | nothing | Keyword search only |

The embedder key includes kind, address, model and dimensions, so vectors from two models are
never compared. Changing the model leaves old vectors unused; the background worker re-embeds
in batches of 32 and, on a provider error, records it in `embedState` and retries every 60 s.
`knowledge.reindex` rebuilds the full-text index and re-embeds from scratch.

## Confluence

Setting `confluence`: `baseUrl` (empty means the built-in mock), `flavor` (`datacenter` →
`/rest/api`, `cloud` → `/wiki/rest/api`), `auth` (`bearer` personal access token for Data
Center, `basic` email + API token for Cloud; the token is a vault secret named by `secretName`)
and `syncMinutes` (0 turns the schedule off).

An import is one of:

| Scope | Becomes | Synced by |
|---|---|---|
| `page` | One page node | Re-reading that page |
| `tree` | A page node with its sub-pages as children | `descendant/page` of the root |
| `space` | A folder holding the space's top pages and their sub-pages | `space/{key}/content/page` |

The import's root node keeps a `ConfluenceRoot` source (scope, space, last sync, error, page
count). Pages get `externalId` `confluence:<page id>`, which is how a sync matches them up.

**Sync** lists pages with their version numbers, reads the body only of pages whose version
changed (four at a time), adds new pages under their parent, moves pages whose parent changed,
and removes pages that are gone. Pages under an excluded branch are skipped. Concurrent syncs of
the same import share one promise. The report is `{ added, updated, removed, unchanged, failed,
error }`.

**Instant updates.** `POST /hooks/confluence/:secret` (address from `confluence.webhook`, secret
stored sealed in setting `confluence.webhookSecret`, replaced with `confluence.rotate_webhook`).
Confluence Data Center's webhook payloads carry little more than the page id, and Foreman reads
nothing else from them: the id only chooses which imports to check. `nudge` gathers calls for
`webhookDelayMs` (2 s; option `confluenceWebhookDelayMs`), then `flush` finds each page's space
— from the library if the page is known, otherwise by asking Confluence — and syncs every import
in those spaces. A page that cannot be looked up, or a body without an id, means all imports.
An import that is already syncing is synced once more afterwards, since that check may have
read the page before it changed.

**Failure notices.** `alert` raises a bus `notice` of kind `knowledge_sync_failed` when an
import goes from working to failing: severity `error` when the whole check failed (Confluence
unreachable, 401, the root page gone), `warning` when only some pages could not be read. The
transition is judged from the import's stored `lastSyncError`, so a long outage gives one notice,
also across restarts, and a fix followed by a new failure gives another.

`htmlToText` understands storage format: code macros become fenced blocks, Jira macros their
key, links their text, images `[image: name]`, tables `| a | b |` rows, headings `#` lines;
layout and noise macros are dropped.

**Permissions** follow the account used for the import — page restrictions are not applied per
agent or per person. Point it at an account that can read only what agents should see.

## Agent tools

`knowledge_search` and `knowledge_read` are kind `read` with `group: "knowledge"`. They are not
switched on by name: `toolEnabled(tool, spec)` turns them on when `spec.knowledge` is non-empty.
They still go through `authorize` like every other tool (safety property 4), so a guardrail can
ask or deny them.

Both are limited to the agent's scope. `knowledge_read` refuses a document outside it with the
same answer as a missing one, so an agent cannot probe for what exists elsewhere. Results wrap
passages as quoted material with a line saying they are information, not instructions (safety
property 3).

The simulated runtime's `auto` scenario searches first when the agent has knowledge, and the
mock model (`mockModelReply`) fills `query`, `documentId` and `part`, so both runtimes exercise
the tools in the demo.

## The mock

`MockConfluence` holds two spaces — ENG (Engineering handbook → Runbooks → Deploying a
service, Incident response; Coding standards → Error handling) and PAY (Payments → Refund
policy → Refund FAQ, Ledger rules) — and serves them through `/mock/confluence/rest/api/*` in
`apps/server`. `mockconfluence.change` edits, adds or deletes a page so sync can be tested by
hand or in a test. With `mockconfluence.webhooks` (on in the demo) each change also calls the
webhook address with a Data Center-shaped payload. The mock CQL search understands only `title ~ "…"` and `space = KEY`.

## What has never been run for real

- A real Confluence (Data Center or Cloud). The client follows the REST v1 documentation and is
  tested only against the mock. The webhook payload follows the one example in Atlassian's Data
  Center documentation (`page: { id }`); Cloud's webhooks are not handled differently.
- A real embedding provider. `openai` and `azure` are tested against Foreman's mock endpoint
  `/mock/model/v1/embeddings`, which returns the built-in embedder's vectors.
- Search quality on real content. There is no measurement yet (slice D).
