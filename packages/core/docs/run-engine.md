# Runs: engine, guardrails, runtimes, agent tools

Files: `src/engine.ts`, `src/policy.ts`, `src/runtime.ts`, `src/mock.ts`, `src/tools.ts`,
`src/timeline.ts`, `src/triggers.ts`.

## Vocabulary

- **Agent** — a name plus an active **revision**. A revision is an immutable `AgentSpec`
  (instructions, model, runtime, tools, MCP servers, sub-agents, policy, budget, output shape).
  Saving an agent creates a new revision; runs record which revision they used.
- **Run** — one execution of a revision with a prompt. Statuses: `queued`, `running`,
  `waiting_approval`, `succeeded`, `failed`, `cancelled`.
- **Event** — one append-only line of a run's trace (`events` table). Types are the Copilot
  SDK's names where one exists (`assistant.message`, `tool.execution_start`,
  `tool.execution_complete`, `assistant.usage` …) plus `foreman.*` for things Foreman adds.
- **Approval** — a pending decision by a person. A **question** is an approval with
  `kind: "question"` whose answer text travels back in `reason`.

## The engine

`Engine` owns: the queue (global concurrency, default 4), per-run timeout
(`budget.timeoutSeconds`), the policy and approval path, usage accounting, and writing events.
A runtime owns only "talk to a model and report what happens".

Lifecycle of one run (`Engine.execute`):

1. Load the revision; pick `runtimes[spec.runtime]`.
2. Status `running`, emit `foreman.run_started`, start the timeout.
3. Call `runtime.execute({ run, spec, signal, emit, authorize, tools, resolveSecrets })`.
4. Check the result against `spec.outputSchema` if set (`checkResultShape`: valid JSON, right
   top-level type, required keys — deliberately small).
5. Finish as `succeeded`, `failed` or `cancelled`; expire any approval still pending.

`engine.recover()` runs at start: runs left `running`/`waiting_approval` by a previous process
are failed with "Interrupted by a server restart", and queued runs are re-queued.

Everything passed to `emit`, and the final output and error, goes through the vault's scrubber
first. Do not bypass `emit` to write events.

## Guardrails (`policy.ts`)

`authorize({ kind, toolName, targets, summary, request })` is the only gate. `evaluatePolicy`:

1. Try `spec.policy.rules` top to bottom. A rule's `match` is a glob tested against `kind`,
   `kind:toolName` and `toolName` — or, when the pattern contains `@`, against the same with
   `@<target>` appended for each of the request's `targets` (`pp_env_reset@sandbox`,
   `*@group:HR`). First match wins.
2. Otherwise the subject's `fallback`, if given: a connection's own verdict for a command
   (see Connections below). The agent's rules still come first, so a person can override it.
3. Otherwise the autonomy preset decides:

| Preset | read | write, mcp, url, custom-tool, memory | shell | destructive |
|---|---|---|---|---|
| `observe` | allow | deny | deny | deny |
| `propose` | allow | ask | ask | deny |
| `act` | allow | allow | ask | deny |
| `full` | allow | allow | allow | allow |

`destructive` (deleting, resetting, overwriting) is never a preset's call below `full`: a person
writes a rule for it. `targets` are facts a tool looked up about what it acts on (see
[power-platform.md](power-platform.md)).

`ask` creates an approval, sets the run to `waiting_approval`, and waits up to
`policy.approvalTimeoutSeconds`. A timeout or a stopped run counts as a refusal.

`summary` is the one line a person approves from — make it specific
(`shell: git push origin main`, `Jira: change status — PAY-12 → Done`).

## Connections (`connections.ts`)

A connection is a tool set up once — an MCP server, a command line or Jira — with its own rules,
and named by id in `spec.connections`. At the start of each run `ConnectionHub.apply(spec)`
folds them into the spec the runtime sees, so runtimes know nothing about connections:

| Kind | Becomes | Rules |
|---|---|---|
| `mcp` | An entry in `spec.mcpServers` under the connection's key | Globs on the server's tool names, turned into `mcp:<key>-<tool>` policy rules after the agent's own |
| `jira` | Foreman's Jira tools added to `spec.tools` (writes only if `jira.writes`) | Globs on the tool names |
| `cli` | A Foreman tool `run_<key>` with one argument, `args` | Word patterns: `az * list` (`*` is one word, more arguments may follow), via `cliDecision` |

Command lines are run by Foreman, not by the runtime's shell, so they work on every runtime and
can have their own identity (environment, `{{secret:..}}`, `{{connection_home}}` for a separate
sign-in folder). A call is authorised as kind `shell` with `fallback` set to the connection's
verdict (deny > ask > allow; no match → the autonomy preset, which asks for `shell` in
`propose` and `act`). `runProgram` spawns without a shell; an argument holding a character a
shell would act on (`& | ; < > $` …) is refused before the policy check, because on Windows a
`.cmd` program does go through `cmd.exe`. Output is scrubbed of secret values.

The run's `run_started` event lists the connections used and any `missingConnections`
(deleted since the agent was saved); those are left out of the run rather than failing it.

MCP connections still need the Copilot runtime with a Copilot account to load, like any MCP
server. `connections.test` starts one through `ForemanOptions.probeMcp` (from `apps/server`).

## Writing a runtime (`runtime.ts`)

Implement `RuntimeAdapter`: `name`, `execute(x)`, `status()`, optionally `listModels()` and
`dispose()`. Register it by passing it in `createForeman({ runtimes: [...] })` and add its name
to the `runtime` enum in `AgentSpec`.

Inside `execute(x)`:

- Call `x.emit(type, data)` for everything that happens. Use the SDK event names so
  `timeline.ts` renders them; unknown types are kept but not shown.
- Call `x.authorize(...)` before every action with a side effect and honour the answer.
- Stop when `x.signal` aborts (cancel or timeout) — throw or return; the engine decides the
  final status.
- Offer `x.tools.available` to the model and route calls to `x.tools.call(name, args)`.
  `call` validates arguments, checks guardrails itself and never throws: it returns
  `{ ok, content }`. Do not also ask the runtime to prompt for permission for these.
- Use `x.resolveSecrets(text)` at the last moment for values that may contain
  `{{secret:NAME}}`. Never emit a resolved value.
- Emit `assistant.usage` with `{ inputTokens, outputTokens, cost }` so spend is tracked.

## The simulated runtime (`mock.ts`)

Default runtime (`runtime: "simulated"`). It plays a scripted **scenario** instead of calling a
model, but goes through the real engine: real policy checks, real approvals, real events. It
is what makes the whole app testable without Copilot, and it is what the demo runs on.

Which scenario plays (`pickScenario`): a `mock:<name>` tag anywhere in the prompt wins (ticket
labels are rendered into the prompt, so a Jira label `mock:flaky` works), otherwise the agent's
`spec.mock.scenario`. `random` picks from a pool, seeded so a given run always plays the same.

Scenarios: `auto`, `happy`, `needs-approval`, `slow`, `tool-failure`, `flaky`, `timeout`,
`over-budget`, `sub-agents`, `asks-question`, `jira-updates`, `bad-output`.

Adding a scenario: append to `MOCK_SCENARIOS` with a `script(ctx)` returning `MockStep[]`:

| Step | Effect |
|---|---|
| `think` | An intent line in the trace |
| `tool` | A tool call. If the name is one of Foreman's tools or a connection's command line it is **really executed**; otherwise the result is the scripted text. Either way guardrails apply |
| `ask` | Calls `ask_for_info` and continues with the `answered(answer)` or `unanswered` branch |
| `progress` | Drives the progress bar |
| `subagent` | Nested steps attributed to a sub-agent |
| `usage` | Tokens and credits |
| `wait`, `hang` | Pause; never return (for timeout tests) |
| `say` | Sets the final answer |
| `fail` | Ends the run with an error |

The scenario appears in the UI's picker and in `system.mock_scenarios` automatically. Errors
whose text matches the `TRANSIENT` pattern in `work.ts` are retried by the work queue.

In `auto`, an agent's command-line connections are called too. The arguments come from a line
in the prompt that starts with `$ ` (`$ account show`), else from the connection's test
command — so a test-bench run can try one real, harmless command.

`beatMs` (constructor) is the length of one step; tests pass `0`.

## Foreman's agent tools (`tools.ts`)

Tools Foreman provides on every runtime, defined once in `FOREMAN_TOOLS`:

| Tool | Kind | Notes |
|---|---|---|
| `report_progress` | internal | Emits `foreman.progress`; always available |
| `ask_for_info` | internal | Asks a person and waits; always available |
| `jira_get_issue`, `jira_search` | read | Switched on per agent |
| `jira_add_comment`, `jira_transition`, `jira_create_subtask` | custom-tool | Switched on per agent; guardrails apply |
| `pp_*` (Power Platform) | read, custom-tool, destructive | Switched on per agent; see [power-platform.md](power-platform.md) |

`internal` tools skip the policy check because they only talk to Foreman. The others are
enabled by listing the name in `spec.tools`, and are authorised as `kind` + `toolName`, so a
rule `jira_transition → ask` works.

Adding a tool: append to `FOREMAN_TOOLS` with a zod `input`, a `group`, a `summary(args)` for
approvals and a `handler(ctx, args)` returning text. Optionally a `prepare(ctx, args)` runs before
the guardrail check and returns `targets`, a better `summary`, a `refuse` reason (refused without
asking anyone) and `data` handed to the handler as `ctx.prepared`. `ctx` gives `run`, `spec`,
`signal`, `emit`, `ask`, `jira()` and `powerPlatform()`. If it
needs something else, extend `ToolContext` and supply it in `Engine.execute` (the tool host is
set with `engine.setToolHost` in `index.ts`). Throw to report failure. It then shows up in the
agent studio, in `system.agent_tools`, in the mock runtime and in the Copilot adapter with no
further work.

## Questions

`ask_for_info` → `Engine` creates an approval of kind `question`, emits
`foreman.question_asked`, waits, emits `foreman.question_answered`. It is answered with
`approvals.decide { decision: "approve", reason: "<the answer>" }` or `work.answer`. Approving
a question without text is rejected. Denying means "no answer is coming"; the tool then fails
and the agent decides what to do.

## Trace rendering (`timeline.ts`)

`buildTimeline(events)` turns raw events into steps for the UI and for `runs.timeline`: tool
start/complete are paired, approvals and questions are paired with their decision, lifecycle
events are labelled. If you add a `foreman.*` event that people should see, add a case here.
`explainFailure` collects signals (failed tools, denials, timeouts) for `runs.explain_failure`.

## Triggers (`triggers.ts`)

Schedules (cron, via `croner`) and webhooks (`POST /hooks/:id/:secret`). `renderPrompt(template,
payload)` substitutes `{{payload}}` and `{{payload.some.path}}`. Payloads are wrapped as
untrusted data in the prompt — keep it that way; a payload must not be able to change the
agent's instructions.
