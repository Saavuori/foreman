# Foreman phase 3 — knowledge base

> Drafted 2026-11-26. Builds on phase 2 (work queue, Jira, Teams, vault, bring-your-own-key).
> **Status:** slices A and B are built (guide: [packages/core/docs/knowledge.md](packages/core/docs/knowledge.md)).
> C and D are not started.

## 1. What it is

A **library** inside Foreman that agents search. People arrange it like a file tree and give
each agent the branches it may use:

```
Confluence Data Center ─┐
Uploaded files ─────────┼─► Library (folders, pages, files) ─► Index ─► knowledge_search
Notes written in Foreman┘        │                                       knowledge_read
                                 └── agent studio: tick folders/pages ──► scope of those tools
```

- **One tree for everything.** A node is a folder, a page (from Confluence; can have
  sub-pages) or a file. Removing a node removes everything beneath it.
- **Confluence imports stay live.** Import a page, a page with all its sub-pages, or a whole
  space. Foreman re-reads it on a schedule and on demand: changed pages are re-indexed, deleted
  pages disappear, new sub-pages appear. Removing one sub-page of an import *excludes* it, so the
  next sync does not bring it back; it can be included again.
- **Assigning knowledge** is ticking nodes in the agent studio. An agent's `spec.knowledge` is a
  list of node ids; each covers everything beneath it, so a ticked folder picks up pages added
  to it later. It is part of the spec, so it is versioned, diffable and replayable like the rest.
- **Agents see two tools** when they have knowledge: `knowledge_search` (best passages, with
  title, place in the tree, link and date) and `knowledge_read` (a whole document, in parts).
  Both are read-only and go through the guardrail check like every other tool. Search is
  limited to the agent's own branches.

## 2. Search: fast and good without new infrastructure

Everything lives in the existing SQLite file.

| Part | How |
|---|---|
| Text | Pages and files converted to plain text that keeps headings, lists, tables and code |
| Passages | Split by heading into ~400–2400 character passages; each remembers its heading path |
| Keyword search | SQLite FTS5 (BM25), title and heading weighted above body |
| Meaning search | Embeddings stored per passage (8-bit, normalised); compared in memory — 20k passages take a few milliseconds |
| Combining | Reciprocal-rank fusion of both lists, at most two passages per document |

Embeddings come from a model endpoint the person configures — OpenAI-compatible (OpenAI,
Ollama, most local servers) or Azure OpenAI — with the key in the vault. Without one, a
built-in embedder that matches word parts (not meaning) is used, so search still tolerates
inflected and compound words; keyword search always works. Changing the embedding model
re-embeds in the background.

## 3. Build order

| Slice | Contents | Done when |
|---|---|---|
| **A** | Library tree, text extraction for text / Markdown / HTML, passages, keyword + meaning search, embeddings settings, agent assignment, the two agent tools, the Knowledge page with a search tester, studio picker, mock runtime and mock model use the tools | An agent given one folder finds a passage in it and cannot see another folder |
| **B** | Confluence Data Center (and Cloud) connection, import page / page tree / space, sync on a schedule and on demand, exclusions, mock Confluence | A Confluence page tree is imported, edited in the mock, and the change is searchable after sync |
| **C** | More file types: PDF, Word, PowerPoint, images (described by a vision model when one is configured) | Each type imports, is searchable, and shows what was extracted |
| **D** | Quality: saved test questions with the page that should answer them, hit rate per change, search log from real runs, optional re-ranking | A change to chunking or search shows its effect as a number |

## 4. Decisions and limits, stated up front

- **Permissions.** Agents see what the Confluence account used for import can see. Page
  restrictions are not applied per person. Use an account that can read only the spaces agents
  should use.
- **Content is data.** Passages reach the agent as quoted material, never as instructions,
  and cannot change an agent's tools or guardrails (safety property 3).
- **Language.** Keyword search stems English; other languages rely on prefix matching and on
  the embedder. A multilingual embedding model is recommended for Finnish content.
- **Never run for real** (to be stated in reports): real Confluence, real embedding providers.
