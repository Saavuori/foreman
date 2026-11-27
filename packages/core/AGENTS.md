# packages/core — guide for agents

Everything in Foreman that is not transport or pixels. No HTTP server and no UI code lives
here; `apps/server` and `apps/web` are thin layers over this package. Read the root
[AGENTS.md](../../AGENTS.md) first.

## Map

| File | Owns | Guide |
|---|---|---|
| `schemas.ts` | zod schemas and types for every stored thing (AgentSpec, Run, WorkItem, JiraSettings …) | — |
| `store.ts` | SQLite persistence (`node:sqlite`) for agents, revisions, runs, events, approvals, triggers, work items, routing rules, settings, audit | below |
| `registry.ts` | `Bus`, `Services`, `defineCapability`, `Registry`, `CapabilityError`, `redact` | [capabilities.md](docs/capabilities.md) |
| `capabilities/*.ts` | The capabilities, grouped by area | [capabilities.md](docs/capabilities.md) |
| `engine.ts` | Run queue, concurrency, timeouts, policy + approval path, questions, usage, trace | [run-engine.md](docs/run-engine.md) |
| `policy.ts` | Autonomy presets and glob rules → allow / ask / deny | [run-engine.md](docs/run-engine.md) |
| `runtime.ts` | The interface a runtime implements | [run-engine.md](docs/run-engine.md) |
| `mock.ts` | Simulated runtime and its scripted scenarios | [run-engine.md](docs/run-engine.md) |
| `tools.ts` | Tools Foreman gives agents (progress, ask, Jira) | [run-engine.md](docs/run-engine.md) |
| `timeline.ts` | Raw events → readable trace; `explainFailure` | [run-engine.md](docs/run-engine.md) |
| `triggers.ts` | Schedule and webhook triggers; `renderPrompt` | [run-engine.md](docs/run-engine.md) |
| `work.ts` | Work queue: intake, routing, dispatch, state machine, Jira write-back | [work-queue.md](docs/work-queue.md) |
| `jira.ts` | `JiraClient` (Cloud + Data Center) and `MockJira` | [work-queue.md](docs/work-queue.md) |
| `batches.ts` | Batches: sets of tickets tracked as one job | [work-queue.md](docs/work-queue.md) |
| `flow.ts` | Flow metrics and the per-agent run timeline | [work-queue.md](docs/work-queue.md) |
| `notify.ts` | Notification hub, channels, rules, Adaptive Cards, mock Teams | [notifications.md](docs/notifications.md) |
| `teamsbot.ts` | Teams bot (Bot Framework protocol, token checks, card buttons) and the mock Bot Framework | [notifications.md](docs/notifications.md) |
| `vault.ts` | Encrypted secrets, sealing, scrubbing | [secrets.md](docs/secrets.md) |
| `connections.ts` | Connections: tools set up once (MCP servers, command lines, Jira), their presets and rules, `apply` (folds an agent's connections into its spec), running a command line without a shell | [run-engine.md](docs/run-engine.md) |
| `powerplatform.ts` | `PowerPlatformClient` (sign-in, API, Dataverse, operations) and `PowerPlatformHub` (settings, identities, directory, protection, targets) | [power-platform.md](docs/power-platform.md) |
| `pptools.ts` | The agents' `pp_*` tools, with `prepare` checks | [power-platform.md](docs/power-platform.md) |
| `mockpowerplatform.ts` | The practice tenant: management API, Dataverse, sign-in, role-based access | [power-platform.md](docs/power-platform.md) |
| `onboarding.ts` | Getting started: agent templates, sample data (load/remove), the checklist (`setupStatus`), example tasks | below |
| `index.ts` | `createForeman(options)`: builds and wires everything; the package's exports | below |
| `core.test.ts` | Unit-level tests through the registry | below |

## How the pieces are wired

`createForeman` in `index.ts` is the only place objects are constructed. Order matters:

```
Store → Bus → runtimes → Vault → ConnectionHub → Engine → TriggerHub → MockJira → WorkHub → PowerPlatformHub → NotifyHub
      → MockBotFramework → TeamsBot (notify.setBot) → BatchHub → Registry → bot.setDecider
```

Two late bindings break what would be cycles: the bot stores its mock messages in the hub's
`MockTeams`, so `NotifyHub` gets the bot with `setBot`; and the bot decides approvals through
the registry, which exists last, so it gets `setDecider`.

Hubs do not call each other's internals; they talk through the **Bus** (`registry.ts`):

| Event | Emitted by | Meaning |
|---|---|---|
| `run` | Engine | A run changed status |
| `event` | Engine | One trace event was appended |
| `approval` | Engine | An approval or question was created or decided |
| `work` | WorkHub | A work item changed state (`item`, `previous`) |
| `notice` | WorkHub | Something to tell a person that has no run or ticket behind it |
| `change` | anyone | "This collection changed" — drives live refresh in the UI |

Adding a new hub: construct it in `createForeman`, add it to `Services` in `registry.ts` (so
capabilities can reach it as `ctx.<name>`), and call its `start()` / `stop()` there. If it has a
new kind of `change`, add the entity name to `BusEvents["change"]` **and** to the topic list in
`apps/web/src/api.ts`.

## Storage

- One SQLite file, `<dataDir>/foreman.db`, or `:memory:` when `memory: true` (tests, demo).
- Core tables are created by the `SCHEMA` string in `store.ts`. Hubs that own their own tables
  (`notify.ts`, `vault.ts`, `batches.ts`, `connections.ts`) create them in their constructor with
  `store.db.exec(SCHEMA)` and query through `store.db` directly.
- There is **no migration system**. Every statement is `CREATE TABLE IF NOT EXISTS`. Adding a
  column to an existing table needs an explicit `ALTER TABLE … ADD COLUMN` guarded so it runs
  once; prefer a new table or a JSON column that already exists. Say so in your report if you
  change a table that real data may already use.
- Structured fields are stored as JSON text and read with `json_extract` where filtering is
  needed (`runs.source`, `runs.usage`, `work_items.ticket`).
- Small singletons go in the `settings` table: `store.getSetting(key)` / `setSetting(key, v)`.
- Timestamps are ISO strings in UTC everywhere.

## Schemas

`schemas.ts` is the single source for shapes. Rules that have bitten before:

- Nested objects with defaults use `.prefault({})` (see `JiraSettings.auth`), so parsing `{}`
  fills them in.
- `AgentSpec.budget.maxAiCredits` has a minimum of 30 because the Copilot runtime rejects less.
- Changing `AgentSpec` changes what is stored in every revision. Add fields with defaults so old
  revisions still parse.

## Tests

`core.test.ts` boots a Foreman with `createForeman({ memory: true, simulatedStepDelayMs: 0 })`
and drives it through `registry.invoke(name, input, actor)` — the same entry point HTTP and MCP
use. Prefer that over calling hub methods, so the capability is tested too. Anything that needs
HTTP (mock Jira, Teams webhooks, MCP) belongs in `apps/server/src/server.test.ts`.

`simulatedStepDelayMs: 0` makes mock runs finish instantly; do not write tests that sleep for a
fixed time — poll for the state you expect.

## Getting started (`onboarding.ts`)

The checklist on the Board comes from `setup.status`, which works each step out from real state
— never from what a person clicked. Things to keep true when changing it:

- **Sample data never counts.** `samples.load` records what it created under the `samples`
  setting; `setupStatus` ignores those agents, rules and channels, and ticket pickup the samples
  switched on. `samples.remove` archives the agents (runs stay in history) and deletes the rest.
  The demo loads the samples too (`apps/server/src/demo.ts`) and hides the checklist.
- **Templates keep their promise.** Every template runs on the simulator with autonomy
  `propose`. Templates that write to Jira also carry explicit `ask` rules, so they keep asking if
  the agent is later moved to `act` (which allows custom tools). A test checks that a template's first run stops for
  approval.
- The MCP step is ticked by the registry on the first call from an `mcp` actor
  (`setup.mcpSeen`).
- A new step needs a `path` the UI can go to; `/work/setup` and `/notifications/setup` are
  addressable for that reason.

## Exports

Anything `apps/server`, `packages/runtime-copilot` or the web app's type imports need must be
exported from `index.ts`. The web app imports **types only** from `@foreman/core`.
