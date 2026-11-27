# Foreman — guide for agents working on this repository

Foreman is an orchestration app for autonomous agents: it takes work (mostly Jira tickets),
routes it to an agent, runs the agent behind guardrails, asks a person when it must, and
reports what happened. Everything a person can do in the UI can also be done over MCP.

Read this file first, then the guide for the part you are changing:

| You are changing | Read |
|---|---|
| Anything in `packages/core` | [packages/core/AGENTS.md](packages/core/AGENTS.md) |
| A capability (API / MCP tool) | [packages/core/docs/capabilities.md](packages/core/docs/capabilities.md) |
| Runs, guardrails, approvals, the mock runtime, agent tools | [packages/core/docs/run-engine.md](packages/core/docs/run-engine.md) |
| Work queue, routing, Jira, batches, flow metrics | [packages/core/docs/work-queue.md](packages/core/docs/work-queue.md) |
| Notifications, Teams cards, the Teams bot | [packages/core/docs/notifications.md](packages/core/docs/notifications.md) |
| Secrets vault, redaction | [packages/core/docs/secrets.md](packages/core/docs/secrets.md) |
| The Copilot SDK adapter | [packages/runtime-copilot/AGENTS.md](packages/runtime-copilot/AGENTS.md) |
| HTTP server, MCP endpoint, mock Jira/Teams routes, demo mode | [apps/server/AGENTS.md](apps/server/AGENTS.md) |
| The web UI | [apps/web/AGENTS.md](apps/web/AGENTS.md) |

`README.md` is the user-facing description. `PLAN.md` and `PLAN-2-work-queue.md` are the
design and build order; all of plan 2 (slices A–F) is built.

## Layout

```
packages/core             Everything that is not transport or pixels: store, engine, policy,
                          work queue, Jira client + mock, notifications, vault, capabilities
packages/runtime-copilot  Adapter that runs agents on the GitHub Copilot SDK
apps/server               Fastify: /api/rpc, /api/stream (SSE), /mcp, /hooks, /mock/*, static UI
apps/web                  React 19 + Vite UI, hand-written CSS
spike/                    Throwaway SDK experiments. Not part of the app; do not build on it
data/                     Runtime data (SQLite, vault.key, workspaces). Git-ignored
```

npm workspaces, ES modules, TypeScript executed directly with `tsx` — there is no build step
for the server or core. Node ≥ 22.13 (uses the built-in `node:sqlite`).

## Commands

Run from the repository root.

| Command | What it does |
|---|---|
| `npm run typecheck` | Type-checks `packages/*` and `apps/server`. **Does not cover the web app** |
| `npm run build` | Type-checks and builds the web app into `apps/web/dist` |
| `npm test` | Vitest, both test files (about 5 seconds; one test starts the real Copilot CLI) |
| `npm run demo` | Server on port 4517, in memory, with sample agents and a self-feeding mock Jira |
| `npm start` | Server on port 4517 with data in `./data`; builds the web app first if it was never built (not when it is stale) |
| `npm run dev` | Server (watch) + Vite dev server on 5173, proxying to 4517 |

A change is done when `npm run typecheck`, `npm run build` and `npm test` all pass. For UI
changes, also look at the page in a browser against `npm run demo`.

The server serves `apps/web/dist`, so **rebuild the web app** (`npm run build`) before checking
UI changes on port 4517, and **restart the server** after changing server or core code
(`npm start` and `npm run demo` do not watch).

## The one architectural rule

**Every feature is a capability.** A capability is a named function with a zod input schema,
registered in `packages/core/src/capabilities/`. The registry projects each one three ways:

- HTTP: `POST /api/rpc/<name>`
- MCP: a tool named with dots replaced by underscores (`work.list` → `work_list`)
- UI: the web app calls `rpc("<name>", input)` and nothing else

So to add a feature: add or extend a capability first, then use it from the UI. Never add a
bespoke HTTP route for app functionality, and never have the UI reach data any other way. A
test asserts the MCP tool list equals the capability list.

## Conventions

- **Language for people.** UI text, capability descriptions and error messages are plain
  English a non-developer can act on ("Give a Jira filter or a list of ticket keys"). Capability
  descriptions are read by other agents over MCP: say what it does, when to use it, and what the
  result means.
- **Comments** explain why, not what. Keep the existing density; do not add narration.
- **Formatting.** 4-space indent, double quotes, semicolons, long lines are fine. A formatter
  may rewrite files after you save them — re-read a file before a second edit that depends on
  exact text.
- **Imports** between TypeScript files include the `.ts` / `.tsx` extension.
- **No new dependencies** without a reason you can state. The UI has no component library and
  no CSS framework on purpose.
- **Line endings** are LF (`.gitattributes`).
- **Do not hand-edit** `apps/web/dist`, `data/` or `package-lock.json`.

## Safety properties to preserve

These are deliberate. Do not weaken one as a side effect of another change.

1. The server binds to `127.0.0.1` and refuses any other host unless `FOREMAN_TOKEN` is set.
2. Secret values are write-only: no capability returns one, the audit log redacts them, and run
   traces are scrubbed. See [secrets.md](packages/core/docs/secrets.md).
3. Ticket and webhook content is data, never instructions: it reaches the agent inside a prompt
   template and cannot change an agent's tools or guardrails.
4. Every tool call an agent makes goes through the policy check in the engine. A new way for an
   agent to act must call `authorize` too. A runtime's own built-in tools that skip the check
   are switched off (the Copilot CLI's GitHub MCP server is — see the runtime's guide).
5. Writing to Jira by Foreman itself is off until a person turns it on.
6. Every non-read-only capability call is written to the audit log with its actor. A decision
   made from a Teams card goes through `approvals.decide` as the actor `teams:<name> · <object id>`.
7. Inbound messages to the Teams bot are accepted only with a valid Bot Framework token, and
   only a verified message may record a conversation — its service URL receives the bot's token.
   There is no switch to skip the check.

## Things that are easy to get wrong

- **zod `.partial()` still applies defaults.** For "patch" capabilities, read the caller's
  `raw` input (third handler argument) to know which fields were actually sent.
- **Audit redaction is by key name.** A field holding a credential must have a name matching
  `secret|token|password|authorization|api-key|webhook`, or it will be logged in clear.
- **React hooks before early returns.** Several pages return early while loading; a hook added
  below such a return crashes the page (React error 310).
- **Tests share one server.** `apps/server/src/server.test.ts` starts one in-memory server for
  the whole file and the suites run in order, so state leaks forward. Put settings back at the
  end of a suite (see the last lines of the "secrets…" suite) and expect counts from earlier
  suites to be present.
- **The mock JQL parser is tiny** and silently ignores clauses it does not understand. Passing
  against the mock does not prove a query works on real Jira.
- **Shell.** The primary shell on the maintainer's machine is PowerShell on Windows; bash is
  available. Avoid shell here-documents for multi-line file edits — use your editing tools.

## What has never been run for real

Be honest about these in anything you report; none of them is covered by a test against the
real service.

- **Copilot runtime with a Copilot subscription.** The maintainer has none. The runtime itself
  *does* run, in tests and the demo, on a model endpoint of your own (`spec.provider`, "bring your
  own key") pointed at Foreman's mock model at `/mock/model/v1`. No real model provider has been
  tried. The simulated runtime is the default.
- **Real Jira.** Sign-in, search, comments, transitions, subtasks and the webhook are tested only
  against the built-in mock.
- **Real Teams.** Workflows-webhook cards and the Teams bot (token checks, sending, updating,
  button presses) follow Microsoft's documented formats and are tested over HTTP against the
  mock Bot Framework only. No Entra app registration has been used.

## Git

Commit only when asked. Work on `main` is the norm in this repository so far. Write commit
messages as a short imperative subject plus a bulleted body of what changed.
