# Foreman

Orchestration for autonomous agents on the GitHub Copilot SDK. Configure agents, triggers and
guardrails in a web UI; every action is also an MCP tool.

Plans: [PLAN.md](PLAN.md) (overall), [PLAN-2-work-queue.md](PLAN-2-work-queue.md) (Jira, Teams, mock).

## Run it

Needs Node 22.13 or newer.

```bash
npm install
npm run build      # builds the web UI
npm run demo       # sample agents + a live feed of mock work, kept in memory
npm start          # normal mode, data saved in ./data
```

Open http://localhost:4517. The MCP endpoint is http://localhost:4517/mcp.

For UI development run `npm run dev` (server with reload on 4517, Vite on 5173).

## No Copilot subscription needed

New agents use the **mock runtime**: scripted scenarios (clean success, stops for approval, tool
failure, flaky, timeout, over budget, sub-agents, wrong result shape) that go through the real
guardrails, approvals, budgets and traces. Pick a scenario per agent in the studio, or put
`[mock:name]` in a prompt. Switch an agent's runtime to `copilot` once Copilot access exists —
that adapter type-checks against the SDK but has not yet completed a live run.

## Layout

| Path | What |
|---|---|
| `packages/core` | Domain model, capability registry, run engine, policy, triggers, mock runtime, SQLite store |
| `packages/runtime-copilot` | Copilot SDK adapter |
| `apps/server` | HTTP API, live stream, webhooks, MCP server, demo mode |
| `apps/web` | React UI |
| `spike` | The first SDK spike and its findings |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `FOREMAN_PORT` / `FOREMAN_HOST` | `4517` / `127.0.0.1` | Where to listen. A non-loopback host requires a token |
| `FOREMAN_TOKEN` | unset | Bearer token for the API and MCP |
| `FOREMAN_DATA_DIR` | `./data` | Database and workspaces |
| `FOREMAN_GITHUB_TOKEN` | unset | Token for the Copilot runtime instead of the signed-in user |

## Test

```bash
npm test
npm run typecheck
```
