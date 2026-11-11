# Foreman — autonomous agent orchestration on the GitHub Copilot SDK

> Working name. Plan drafted 2026-11-10 from the SDK's `main` branch docs.

## 1. Vision

A self-hosted control plane where creating an autonomous agent takes minutes:
pick a trigger, describe the job, choose tools, set guardrails, ship. Every run is
fully observable and replayable, and **everything a human can do in the UI an
agent can do over MCP** — so agents can build, debug and tune other agents.

Three bets make this more than a cron wrapper around an LLM:

1. **One capability registry, three surfaces.** Each operation is defined once
   (schema + handler + scope) and projected into the UI's API, the MCP server and
   a CLI. Parity is structural and enforced in CI, not maintained by hand.
2. **Runs are data.** Every SDK event is persisted in an append-only store. That
   single decision gives us the trace viewer, replay, fork-from-step, evals,
   cost analytics and regression tests for free.
3. **Agents are versioned artefacts.** Immutable revisions, diffs, canary
   rollout and rollback — the same discipline as code deploys, so letting an
   agent edit an agent is safe.

## 2. What the Copilot SDK gives us (and what we build)

Verified in the SDK docs:

| Need | SDK capability we use |
|---|---|
| Agent loop, planning, tool calls, file edits | Copilot runtime over JSON-RPC (`CopilotClient` / `CopilotSession`) |
| Server deployment | Headless runtime over TCP (`RuntimeConnection.forUri`), `mode: "empty"` so nothing ambient leaks in |
| Per-agent behaviour | `systemMessage`, `model`, `reasoningEffort`, `availableTools` / `excludedTools`, `tools` (custom), `mcpServers`, skills, plugin directories |
| Multi-agent | `customAgents` (sub-agents with scoped tools), fleet mode (`session.rpc.fleet.start`, experimental) |
| Guardrails | `onPermissionRequest`, `permissionMode`, hooks (pre/post tool use, pre-MCP call, prompt submitted, lifecycle, error) |
| Budgets | `sessionLimits.maxAiCredits` (soft cap), `session.usage_info`, `assistant.usage` events |
| Long / durable runs | Session persistence + `resumeSession`, `infiniteSessions` (auto-compaction), `autopilot` continuation policy |
| Trigger provenance | `send({ source: "automation-<id>" })` — defines the task but carries no human authority |
| Typed results | `responseSchema` (JSON Schema / Zod) on `sendAndWait` (preview) |
| Human in the loop | Permission, `ask_user` and elicitation requests surfaced as events |
| Observability | ~50 typed streaming events, built-in OpenTelemetry export with trace-context propagation |
| Auth | Logged-in user, GitHub token, rotating `gitHubTokenProvider`, GitHub App installation tokens (server-to-server), BYOK providers |
| Storage isolation | `baseDirectory`, `sessionFs` provider, `memory.storeMemory` |

What the SDK does **not** give us, and Foreman therefore owns: triggers, queueing
and concurrency, agent definitions and versioning, secrets, the approval inbox,
the event store, evals, the UI and the MCP control surface.

**Language choice: TypeScript end to end.** The Node SDK bundles the runtime,
passes wire schemas through untouched and shares Zod types with the UI and MCP
layers.

## 3. Architecture

```
            ┌──────────────── surfaces ────────────────┐
            │  Web UI      MCP server       CLI        │
            │  (React)     (HTTP + stdio)   (foreman)  │
            └──────┬───────────┬──────────────┬────────┘
                   └───────────┼──────────────┘
                     Capability registry  ← single source of truth
                     (zod in/out, scope, audit, dry-run)
        ┌──────────────┬───────┴───────┬───────────────┬────────────┐
   Agent registry   Trigger hub     Run engine     Policy &      Insights
   (revisions,      (webhook, cron, (queue, lanes, approvals     (traces, cost,
    diff, rollout)   GitHub, mail,   retries,       secrets       evals,
                     chat, events)   budgets)       vault         optimizer)
        └──────────────┴───────┬───────┴───────────────┴────────────┘
                        Runtime adapter (Copilot SDK)
                 ┌─────────────┴──────────────┐
           Copilot runtime pool          Workspaces
           (headless, mode: empty)       (dir / git worktree / container)
                               │
                  Event store + DB (SQLite → Postgres)   OTel export
```

### 3.1 Capability registry (the core idea)

```ts
defineCapability({
  name: "agents.update",
  scope: "agents:write",
  input: AgentPatch, output: AgentRevision,   // zod
  destructive: false, supportsDryRun: true,
  handler: async (ctx, input) => { ... },
});
```

- Projected automatically into: typed HTTP/RPC for the UI, MCP tools (with JSON
  Schema, annotations for read-only/destructive), CLI subcommands, OpenAPI.
- Every call is authorised by scope, written to the audit log with the actor
  (human, API token, or agent run), and can be previewed with `dryRun`.
- CI check: the UI package may only import the generated client. No private
  endpoints means no feature can exist that MCP lacks.

### 3.2 Domain model

- **Agent** → many immutable **Revisions** (instructions, model, tools, MCP
  servers, sub-agents, skills, policy, budget, output schema, workspace spec).
- **Trigger** → bound to an agent + rollout channel; has filter, input mapping,
  concurrency key, dedupe window.
- **Run** → one execution of a revision; owns a Copilot session id, workspace,
  status, cost, result; parent/child links for agent-to-agent chains.
- **Event** → append-only, raw SDK event envelope + Foreman events (trigger
  received, approval decided, retry scheduled).
- **Connection** → a reusable MCP server or credential (GitHub App, Slack, IMAP,
  BYOK provider), with secrets held in the vault.
- **Approval**, **Dataset / EvalCase / EvalRun**, **AuditEntry**, **ApiToken**.

Agent specs are also plain YAML — exportable to git and importable back
(GitOps mode), so the database is never a lock-in.

### 3.3 Triggers

| Kind | Notes |
|---|---|
| Manual / API / MCP | `runs.start`; also "Run with this payload" from the UI |
| Schedule | Cron + timezone, jitter, catch-up policy for missed fires |
| Webhook | Per-trigger URL, HMAC verification, templates for GitHub, Grafana, Stripe-style signatures |
| GitHub | App webhook: issues, PRs, comments, check failures, labels, `@mention` |
| Email | Inbound address / IMAP poll, attachments passed as files |
| Chat | Slack / Teams mention or slash command, replies threaded back |
| Agent events | Run completed/failed, approval timed out — enables pipelines and a self-healing "doctor" agent |
| File / queue | Folder watcher, generic poller (HTTP, SQL) with a cursor |

Pipeline for every trigger: **receive → verify → filter (expression) → map to
prompt + attachments → dedupe / concurrency key → enqueue**. Raw payloads are
stored so any past event can be replayed against a new revision.

Payloads are sent with `source: "automation-<trigger>"` and wrapped as untrusted
data — an incoming email cannot grant itself permissions.

### 3.4 Run engine

- Durable queue in the database; lanes with concurrency limits per agent, per
  trigger key (for example one run per PR) and globally.
- Policies per agent: timeout, max turns, retry with backoff, credit budget
  (`sessionLimits`), on-budget-exhausted behaviour (stop / ask human).
- Crash recovery: runs map to persistent sessions; on restart the engine
  `resumeSession`s anything that was in flight.
- Workspaces: scratch dir, git clone/worktree of a repo, or a container sandbox
  for agents with shell access. Artefacts (files, diffs) are collected at the end.
- Steering: a human or another agent can `send` into a live run, pause, or abort.
- Runtime pool: N headless runtimes with isolated `baseDirectory`; health checks
  via `ping`, automatic restart.

### 3.5 Guardrails

- Tool policy per agent: `allow` / `deny` / `ask` rules matched on tool name and
  arguments (for example `shell: ask if command matches rm|push|deploy`).
  Implemented in `onPermissionRequest` plus pre-tool-use hooks.
- **Approval inbox**: pending permission, question and elicitation requests show
  up in the UI, via MCP (`approvals.list` / `approvals.decide`) and in chat, with
  the full context of what the agent is trying to do. Timeouts and default
  decisions are configurable.
- Secrets vault: encrypted at rest, referenced by name, injected only into the
  tool or MCP server that needs them, redacted from the event store.
- Autonomy levels as presets: *Observe* (read-only tools), *Propose* (writes need
  approval), *Act* (allow-listed writes), *Full* (sandboxed only).

## 4. MCP surface

Streamable HTTP (remote, OAuth 2.1 or scoped API tokens) and stdio (local).

- **Tools**, generated from the registry and grouped: `agents.*`, `revisions.*`,
  `triggers.*`, `runs.*`, `approvals.*`, `connections.*`, `secrets.*` (write-only
  values), `evals.*`, `insights.*`, `system.*`. Roughly 60 capabilities, so the
  server supports toolset selection per token and a `capabilities.search` tool to
  keep client context small.
- **Debug and optimisation tools** designed for agents, not just raw dumps:
  `runs.explain_failure`, `runs.timeline` (compact, paginated), `runs.get_step`,
  `runs.diff` (two runs side by side), `runs.replay`, `runs.fork_from_step`,
  `insights.tool_usage`, `insights.cost_breakdown`, `insights.slow_steps`,
  `revisions.diff`, `revisions.promote` / `rollback`.
- **Resources**: `foreman://agents/{id}`, `foreman://runs/{id}/transcript`,
  `foreman://runs/{id}/events`, with subscriptions for live runs.
- **Prompts**: "create an agent for…", "investigate this failed run", "tune this
  agent's cost".
- Safety: destructive tools require a `confirm` token returned by a prior dry
  run; all MCP actions land in the audit log attributed to the token.

Foreman also *consumes* MCP: connections are a catalogue of MCP servers agents
can be given, with a tool browser and a test console.

## 5. Interface

Stack: React + Vite, TanStack Router/Query, Tailwind, Radix primitives, live
updates over SSE. Calm, dense, keyboard-first — closer to Linear than to a node
canvas. Light and dark from the start.

| Screen | What it does |
|---|---|
| **Home** | What ran, what failed, what needs you (approvals), spend today |
| **Agents** | List with health sparkline, success rate, cost per run |
| **Agent studio** | Tabs: Instructions · Tools & connections · Triggers · Guardrails · Budget · Output. Right-hand **playground** runs the draft revision live against a sample or recorded payload |
| **Revisions** | History, diff, promote, canary %, rollback |
| **Runs** | Filterable live list; saved views |
| **Run detail** | Timeline of turns, tool calls and sub-agents (waterfall), token and credit usage per step, inputs/outputs, workspace diff, artefacts; replay / fork / steer |
| **Approvals** | Inbox with one-key approve/deny and "always allow this pattern" |
| **Connections** | MCP servers and credentials, tool browser, test console |
| **Evals** | Datasets, runs, score trends, revision comparison |
| **Insights** | Cost, latency, tool usage, failure clusters |
| **Settings** | Tokens, members, runtime pool, audit log |

Signature interactions:

- **Create by describing.** "When a Grafana alert fires, investigate and post a
  summary to Slack" → the built-in Builder agent drafts the agent, trigger and
  guardrails through the same MCP tools; the user reviews a diff and confirms.
- **Command palette** (Ctrl+K) that exposes every registry capability.
- **Copy as MCP call / CLI command** on every action, to teach the agent surface.

## 6. Evals and optimisation

- Turn any past run or trigger payload into an eval case with one click.
- Assertions: structured-output checks, tool-call expectations ("must not call
  X", "must call Y before Z"), and LLM-judged rubrics.
- Replay a dataset against a draft revision before promoting; gate promotion on
  score and cost regressions.
- Canary rollout: route a percentage of trigger traffic to a new revision and
  compare outcomes.
- **Optimizer agent**: reads traces and insights over MCP, proposes concrete
  revisions (trim unused tools, cheaper model for a step, tighter instructions),
  validates them on the dataset and opens a revision for human approval.

## 7. Tech stack and layout

- Node 22, TypeScript, pnpm workspaces, Zod, Fastify, Drizzle ORM.
- SQLite by default (single binary feel, zero setup); Postgres for multi-node.
- `@github/copilot-sdk`, `@modelcontextprotocol/sdk`.
- Vitest, Playwright; a fake runtime adapter for deterministic tests.
- Ships as one Docker image plus `npx foreman` for local use.

```
apps/server      Fastify host: API, MCP, webhooks, SSE
apps/web         React UI
apps/cli         foreman CLI (generated from registry)
packages/core    domain model, capability registry, policy engine
packages/runtime Copilot SDK adapter, runtime pool, workspaces
packages/triggers trigger kinds + pipeline
packages/store   schema, event store, migrations
packages/mcp     registry → MCP projection
packages/evals   datasets, assertions, judges
```

## 8. Milestones

| # | Goal | Done when |
|---|---|---|
| **0. Spike** (days) | De-risk the SDK | A script runs a session in `mode: "empty"` with one custom tool, one MCP server, a permission handler, a credit limit and structured output; all events captured to a file; session resumed after a kill |
| **1. Vertical slice** | Registry, agent CRUD with revisions, manual runs, event store, minimal UI (agents, studio, run detail), MCP server | An agent can be created in the UI *and* by an external MCP client, run, and inspected step by step |
| **2. Autonomy** | Schedule, webhook and GitHub triggers; queue, lanes, retries, budgets; approval inbox; secrets vault; connections | A GitHub issue triggers an agent that proposes a fix and waits for approval before pushing |
| **3. Debuggability** | Full trace viewer, replay, fork, steer, run diff, insights, OTel export, debug MCP tools | An external agent can diagnose a failed run using MCP alone |
| **4. Self-improvement** | Evals, canary, Builder and Optimizer agents, chat and email triggers | "Describe an agent" works end to end; a promotion is blocked by an eval regression |
| **5. Team-ready** | Auth (GitHub OAuth), roles, audit UI, Postgres, container sandboxes, Docker image, docs | Runs unattended for a week on a server with several users |

## 9. Risks and how they are handled

- **Preview / experimental SDK features** (structured output, fleet mode,
  autopilot options, in-process runtime): isolated behind the runtime adapter,
  SDK and runtime versions pinned, feature-flagged; milestone 0 exists to check
  them.
- **Billing**: each prompt counts against Copilot usage. Budgets are mandatory on
  triggers, with a global daily cap and a kill switch. BYOK supported as an
  alternative.
- **Unattended auth**: installation tokens last one hour — use
  `gitHubTokenProvider` to rotate; needs an org with the Copilot-requests policy
  enabled. A personal token works for single-user installs.
- **Prompt injection from triggers**: automation provenance, untrusted-data
  wrapping, default *Propose* autonomy, deny-by-default tool lists under
  `mode: "empty"`, sandboxed workspaces for shell access.
- **MCP as an admin surface**: scoped tokens, dry-run + confirm for destructive
  operations, full audit, and agents cannot raise their own autonomy level
  without human approval.
- **No official runtime Docker image**: we build and pin our own.
- **Scope**: this is a large product. Milestones 0–2 already form a useful tool;
  everything after is additive.

## 10. Decisions to confirm

1. **Audience first**: single-user self-hosted (assumed above) or multi-tenant
   from day one? The latter pulls auth, roles and Postgres into milestone 1.
2. **Auth to Copilot**: personal Copilot subscription, an organisation GitHub
   App, or BYOK keys?
3. **First three triggers** to prioritise (assumed: schedule, webhook, GitHub).
4. **Deployment target**: local Windows machine only, or a container on a server
   from the start?
5. **Name**: Foreman is a placeholder.
