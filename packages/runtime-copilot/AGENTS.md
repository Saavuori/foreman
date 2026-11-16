# packages/runtime-copilot — guide for agents

The adapter that runs Foreman agents on the GitHub Copilot agent runtime through
`@github/copilot-sdk`. One file: `src/index.ts`. Read the root [AGENTS.md](../../AGENTS.md)
and [run-engine.md](../core/docs/run-engine.md) first — the adapter implements the
`RuntimeAdapter` interface described there.

## Status: never run live

**No agent has ever executed through this adapter.** The maintainer's GitHub account has no
Copilot subscription; requests are refused with HTTP 403. The code type-checks against the SDK
and follows what a spike (`spike/`) established, nothing more.

Consequences for anyone changing it:

- You cannot verify a change here by running it. Verify by type-checking against the installed
  SDK's `.d.ts` files in `node_modules/@github/copilot-sdk/dist`, and say plainly in your report
  that it is unverified at run time.
- Do not "fix" behaviour you only suspect. Prefer the smallest change that the types support.
- Do not make this runtime the default. `simulated` is the default in `AgentSpec` on purpose.

## What the spike established

- The client is created with `mode: "empty"`, so a session has **no tools unless the spec names
  them**. Empty mode requires `baseDirectory`; Foreman uses `<dataDir>/copilot-home`.
- A session's `sessionLimits.maxAiCredits` must be at least 30, which is why
  `AgentSpec.budget.maxAiCredits` has that minimum.
- Being signed in to GitHub is not enough; `status()` also lists models to detect an account
  without Copilot access and reports the 403 in plain words.

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
4. Every session event is forwarded to `x.emit`, except streaming deltas (`SKIPPED_EVENTS`),
   which would multiply the size of a trace without adding content.
5. `sendAndWait` with `source: "automation-<kind>"`, so the runtime knows the prompt did not
   come from a person at a keyboard.
6. On abort (cancel or timeout) the session is aborted; it is always disconnected at the end.

## Rules

- **Every action is authorised.** Anything the runtime can do with a side effect must reach
  `x.authorize` — through `onPermissionRequest` or through `x.tools.call`. Never return
  `approve-once` unconditionally, and never use the SDK's `approveAll`.
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

Running on a model API key instead of a Copilot subscription is planned as a spike (slice F in
`PLAN-2-work-queue.md`) and is not started. It would be a second `RuntimeAdapter` in its own
package, not a mode of this one.
