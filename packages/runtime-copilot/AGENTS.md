# packages/runtime-copilot — guide for agents

The adapter that runs Foreman agents on the GitHub Copilot agent runtime through
`@github/copilot-sdk`. One file: `src/index.ts`. Read the root [AGENTS.md](../../AGENTS.md)
and [run-engine.md](../core/docs/run-engine.md) first — the adapter implements the
`RuntimeAdapter` interface described there.

## Status: runs on your own model key, never on a Copilot subscription

The maintainer's GitHub account has no Copilot subscription; Copilot-backed requests are refused
with HTTP 403. But the runtime runs without one when the agent names its own model provider
(`spec.provider`, "bring your own key"). A test in `apps/server/src/server.test.ts` ("runs the
real Copilot runtime on a model endpoint of your own") and the demo's "Model-backed reader"
agent run the real runtime against Foreman's mock model at `/mock/model/v1` (an
OpenAI-compatible endpoint in `apps/server/src/app.ts`, replies built by `mockModelReply` in
core). So a change here **can** be verified at run time — run that test (about 3–6 s; it starts
the Copilot CLI). What remains unverified: a real model provider, and anything that needs a
Copilot account (model routing with `auto`, built-in tools' names and permission requests).

- Do not make this runtime the default. `simulated` is the default in `AgentSpec` on purpose.
- The SDK bundles the runtime as a native binary (`@github/copilot-sdk-win32-x64` on this
  machine). When a type is not enough, the generated RPC types in
  `node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts` describe what the runtime answers.

## What the spikes established

`spike/spike.mjs` (sign-in), `spike/byok.mjs` (own key), `spike/mcp-permissions.mjs` (MCP).

- The client is created with `mode: "empty"`, so a session has **no tools unless the spec names
  them**. Empty mode requires `baseDirectory`; Foreman uses `<dataDir>/copilot-home`.
- A session's `sessionLimits.maxAiCredits` must be at least 30, which is why
  `AgentSpec.budget.maxAiCredits` has that minimum.
- Being signed in to GitHub is not enough; `status()` also lists models to detect an account
  without Copilot access and reports the 403 in plain words.
- With `provider` set, a session runs with **no Copilot access at all**: the runtime calls the
  provider's `chat/completions` (non-streaming, since `streaming: false`), offers Foreman's
  tools as functions, and reports `assistant.usage` with cost 0.
- **The runtime adds its own `github-mcp-server`**, signed in as whoever is logged in on the
  machine (the `gh` CLI user). Its read tools ran **without any permission request**, so past
  Foreman's guardrails, and reached api.github.com. The adapter therefore always passes
  `disabledMcpServers: ["github-mcp-server"]` (unless the spec defines a server of that name).
  A test asserts no GitHub tool appears in the trace.
- **An agent's own MCP servers are filtered out** when there is no Copilot account behind the
  session: `session.rpc.mcp.list()` reports them under `filteredServers` with
  `mcp3pEnabled: false` ("third-party MCP servers are policy-enabled"). So it is still unknown
  whether the runtime asks permission before a *read-only* tool of a user's MCP server. Find out
  before relying on MCP guardrails with a Copilot account (re-run `spike/mcp-permissions.mjs`).
- A tool handler that **throws** reaches the model and the trace only as "Tool execution
  failed". Foreman's tools therefore return `{ textResultForLlm, resultType: "failure" |
  "denied", error }` so the reason (a denial by policy, Jira unreachable) is visible.

## How a spec becomes a session (`toSessionConfig`)

| AgentSpec | Session config |
|---|---|
| `model`, `reasoningEffort` | same |
| `instructions` | `systemMessage: { mode: "append", content }` |
| `tools` (minus Foreman's own tool names) | `availableTools: new ToolSet().addBuiltIn(...).addMcp("*").addCustom("*")` |
| `mcpServers` | `mcpServers`, with `{{secret:NAME}}` in `env` / `headers` resolved here |
| `subAgents` | `customAgents` |
| `budget.maxAiCredits` | `sessionLimits.maxAiCredits` |
| `outputSchema` | `responseSchema` on the message |
| `provider` (`type`, `baseUrl`, `wireApi`, `secretName`) | `provider`, with the key resolved from the vault here |
| — | `disabledMcpServers: ["github-mcp-server"]`, always |

`toSessionConfig` is exported so it can be tested without a Copilot account.

## How a run executes (`execute`)

1. One shared `CopilotClient`, started lazily.
2. A working directory per run: `<dataDir>/workspaces/<runId>`.
3. `createSession` with:
   - `onPermissionRequest` → `describePermission` turns the SDK's request into Foreman's
     `{ kind, toolName, summary }`, then `x.authorize` decides. Allowed →
     `{ kind: "approve-once" }`; refused → `{ kind: "reject", feedback: reason }`.
   - `tools` → Foreman's own tools from `x.tools.available`, each defined with `defineTool` and
     `skipPermission: true`, because `x.tools.call` already runs the guardrail check. Do not
     remove `skipPermission` without also removing the check, or people are asked twice.
4. Every session event is forwarded to `x.emit`, except streaming deltas and the per-turn
   message snapshots (`SKIPPED_EVENTS`), which would multiply the size of a trace without adding
   content. A real session emits many more event types than the timeline shows (`model.*`,
   `session.*`, `instruction.update` …); they are kept in the raw events.
5. `sendAndWait` with `source: "automation-<kind>"`, so the runtime knows the prompt did not
   come from a person at a keyboard.
6. On abort (cancel or timeout) the session is aborted; it is always disconnected at the end.

## Rules

- **Every action is authorised.** Anything the runtime can do with a side effect must reach
  `x.authorize` — through `onPermissionRequest` or through `x.tools.call`. Never return
  `approve-once` unconditionally, and never use the SDK's `approveAll`. Anything the runtime
  brings that bypasses `onPermissionRequest` (its GitHub MCP server) stays disabled.
- **Secrets are resolved late and never emitted.** Use `resolveSecrets` when building the
  session config, not earlier, and do not put the result in an event or a log line.
- **Event names pass through unchanged.** `packages/core/src/timeline.ts` and the usage
  accounting in the engine key off the SDK's event types (`tool.execution_start`,
  `tool.execution_complete`, `assistant.message`, `assistant.usage` …). If an SDK upgrade renames
  one, update those consumers in the same change.
- **Built-in tool names are the runtime's, not Foreman's.** The names offered as chips in the
  agent studio (`view`, `grep`, `edit`, `shell` …) are best guesses and have not been confirmed
  against a live session.

## When Copilot access exists

The first live session should check, in this order: sign-in and model listing (`status()`), a
run with no tools, a run with one built-in tool to confirm the tool names and the shape of
permission requests, a run using a Foreman tool to confirm custom tools are not double-prompted,
and a run that hits the credit limit. Record what differs from this document and fix the
document.

## Bring-your-own-key

A mode of this adapter, not a separate runtime: `AgentSpec.provider` (`schemas.ts`) holds the
provider `type` (`openai`, `azure`, `anthropic`), `baseUrl`, optional `wireApi` and the name of the
vault secret with the key. `agents.create` / `agents.update` refuse `model: "auto"` with a
provider, since only Copilot can route; the model must be the provider's own id. The key is
resolved in `toSessionConfig` and never emitted. `secrets.list` shows the agent as a user of the
secret ("model key").
