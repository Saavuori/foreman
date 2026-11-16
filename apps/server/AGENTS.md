# apps/server — guide for agents

The transport layer: a Fastify app that exposes `@foreman/core` over HTTP, server-sent events
and MCP, serves the built web UI, and hosts the mock Jira and mock Teams endpoints. It contains
almost no logic of its own, and should stay that way. Read the root [AGENTS.md](../../AGENTS.md)
first.

## Files

| File | Role |
|---|---|
| `src/main.ts` | Process entry: reads environment, builds the app, seeds or starts the demo, listens |
| `src/app.ts` | `buildApp(options)` — all routes. `seedIfEmpty` — the sample agent on a fresh install |
| `src/mcp.ts` | `createMcpServer(backend)` — tools, resources and prompts from the registry |
| `src/mcp-stdio.ts` | A stdio MCP server that forwards to a running Foreman over HTTP |
| `src/demo.ts` | `startDemo` — sample agents, routing rules, a Teams preview channel, a batch, the ticket generator |
| `src/server.test.ts` | Integration tests over real HTTP and a real MCP client |

## Routes

| Route | Purpose |
|---|---|
| `GET /api/capabilities` | `registry.describe()` — names, descriptions, JSON schemas |
| `POST /api/rpc/:name` | Invoke a capability. Body is the input; answer is `{ result }` or `{ error, code }` |
| `GET /api/stream` | Server-sent events: `run`, `event`, `approval`, `change` (ids only, never payloads) |
| `POST /mcp` | MCP over Streamable HTTP, **stateless**: a new server per request. `GET`/`DELETE` answer 405 |
| `POST /hooks/:id/:secret` | Webhook triggers. The secret in the path is the credential |
| `/mock/jira/rest/api/:v/*` | Mock Jira (v3 as Cloud, v2 as Data Center) |
| `GET /mock/jira/browse/:key` | A plain HTML page for a mock ticket — what "Open in Jira" links to |
| `POST /mock/teams/:channel` | Accepts what a Teams Workflows webhook accepts |
| everything else | The built UI from `apps/web/dist`, with `index.html` as the fallback |

**App functionality never gets its own route.** If the UI or an agent needs something, add a
capability in `packages/core`; `/api/rpc` and `/mcp` expose it automatically. New routes are
only for things that are not capabilities by nature: an inbound protocol (a webhook receiver)
or a stand-in for an outside service (the mocks).

## Authentication

- Default bind is `127.0.0.1`. `main.ts` refuses any other host unless `FOREMAN_TOKEN` is set.
- With a token, `/api/*` and `/mcp` require `Authorization: Bearer <token>` (compared in
  constant time by `safeEqual`).
- `/hooks/*` is authenticated by the per-trigger secret in the path, also constant-time.
- `/mock/*` is unauthenticated on purpose: it stands in for outside services. Do not put
  anything real behind it.

If you add a route, decide which of these it falls under and say so in a comment.

## Actors

Each call is attributed for the audit log. `/api/rpc` is `user:local` unless the caller sends
an `x-foreman-client` header (the stdio bridge does), in which case it is `mcp:<client>`.
`/mcp` is always `mcp:<client>`, taken from `x-foreman-client` or the user agent.

## MCP (`mcp.ts`)

- **Tools** are the capabilities: name with dots → underscores, the capability's JSON schema,
  `readOnlyHint` and `destructiveHint` from its flags. Results are JSON text.
- **Resources**: `foreman://agents/<id>` and templates for runs — read-only views for clients
  that prefer resources.
- **Prompts** (`PROMPTS`): ready-made multi-step instructions such as `investigate-run`.
  Tool names inside prompt text are the underscore form.
- `INSTRUCTIONS` is the server's own description to the connecting model; keep it current when
  a new area is added.

`createMcpServer` takes a `backend` of `{ describe, invoke }`, so the same code serves the HTTP
endpoint (calling the registry directly) and the stdio bridge (calling `/api/rpc`). The stdio
bridge reads `FOREMAN_URL` and `FOREMAN_TOKEN`.

A test asserts the MCP tool list equals `/api/capabilities`. It will fail if you filter or
rename tools here.

## Mock Jira routes

The mock's data lives in `MockJira` (core); the routes here only translate HTTP. The real
`JiraClient` is pointed at these routes, so they must answer with Jira's shapes: `issues` +
`isLast` for v3 search, `issues` + `startAt` + `total` for v2, `errorMessages` / `errors` on
failure, 204 for a transition. When you add a client call, add its route for `:v` (both
versions), keep the shape faithful to Jira's documentation, and note in your report that only
the mock was exercised.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `FOREMAN_PORT`, `FOREMAN_HOST` | `4517`, `127.0.0.1` | Where to listen |
| `FOREMAN_TOKEN` | unset | Bearer token for `/api` and `/mcp` |
| `FOREMAN_DATA_DIR` | `./data` | Database, `vault.key`, Copilot workspaces |
| `FOREMAN_BASE_URL` | derived | Public address, used in links and webhook URLs |
| `FOREMAN_SECRET_KEY` | unset | Passphrase for the vault instead of the key file |
| `FOREMAN_GITHUB_TOKEN` | unset | Token for the Copilot runtime |
| `FOREMAN_CONCURRENCY` | `4` | Runs in parallel |
| `FOREMAN_DEMO=1` or `--demo` | off | Demo mode |
| `FOREMAN_LOG=1` | off | Fastify request logging |

A new variable is read in `main.ts`, passed as an option, and documented here and in
`README.md`.

## Demo mode (`demo.ts`)

In memory, nothing written to disk. It must keep working with no outside service: no Copilot,
no Jira, no Teams. When you add a feature, make the demo show it — an agent, a seeded ticket
with the right `mock:` label, a rule — because the demo is how changes are checked by eye.
Things that call the mock Jira over HTTP must wait until the server is listening (see the
delayed batch creation).

## Tests (`server.test.ts`)

One server is started in `beforeAll` for the whole file, in memory, on a random port, with a
token, and a real MCP client is connected. Helpers: `rpc(name, input)` → `{ status, body }`,
`tool(name, args)` → parsed MCP result.

- Suites run in file order and **share state**. Later suites see tickets, agents and
  notifications from earlier ones. Assert with `toBeGreaterThanOrEqual` or filter by a name you
  created, and restore any setting you change.
- `baseUrl` is `http://test`, so the configured Jira site `http://127.0.0.1:<port>/mock/jira`
  counts as a "real" site — which is how sign-in is tested against the mock.
- `foreman` (the core services) is available to reach mock internals such as
  `foreman.mockJira.requiredAuth`.
- Work is asynchronous. Poll for a state (`settle`, `waitFor`); never sleep a fixed time.
