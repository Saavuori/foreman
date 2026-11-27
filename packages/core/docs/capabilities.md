# Capabilities

A capability is the unit of functionality. The HTTP API, the MCP server and the UI are all
generated from the registry, so adding one here makes it available everywhere.

Files: `src/registry.ts` (machinery), `src/capabilities/*.ts` (definitions).

| File | Groups |
|---|---|
| `agents.ts` | `agents.*`, `revisions.*` |
| `runs.ts` | `runs.*`, `approvals.*` |
| `work.ts` | `work.*`, `routing.*`, `jira.*`, `mockjira.*` |
| `flow.ts` | `batches.*`, `work.flow`, `work.timeline` |
| `notify.ts` | `notify.*`, `channels.*`, `notifyrules.*`, `mockteams.messages` / `clear` |
| `teams.ts` | `teamsbot.*`, `mockteams.install` / `press` |
| `vault.ts` | `secrets.*`, `system.agent_tools` |
| `setup.ts` | `setup.*` (the getting-started checklist), `agents.templates`, `agents.example_task`, `samples.*` |
| `powerplatform.ts` | `powerplatform.*` (connection, test, environments, protect) |
| `ops.ts` | `triggers.*`, `insights.*`, `audit.list`, `system.*`, `capabilities.search` |

## Anatomy

```ts
defineCapability({
    name: "work.hold",                    // dotted; the MCP tool is work_hold
    title: "Hold or release",             // short, shown in the UI's capability console
    description: "A held item keeps its place in the queue but is not started until released.",
    readOnly: false,                      // true → not audited, MCP readOnlyHint
    destructive: false,                   // true → MCP destructiveHint
    input: z.object({ itemId: z.string(), held: z.boolean().default(true) }),
    handler: (ctx, input, raw) => { … },  // may be async; return plain JSON
})
```

- `ctx` is `Services` plus `actor`: `ctx.store`, `ctx.bus`, `ctx.engine`, `ctx.triggers`,
  `ctx.work`, `ctx.mockJira`, `ctx.notify`, `ctx.vault`, `ctx.batches`, `ctx.bot`, `ctx.mockBot`, `ctx.powerPlatform`, `ctx.runtimes`,
  `ctx.registry`, `ctx.info`, `ctx.actor`.
- `input` is the parsed value with defaults applied. `raw` is what the caller sent.
- Return values are sent as JSON as they are. Do not return class instances.

## Adding a capability

1. Put it in the file for its group, or a new file whose array you spread into
   `registry.register(...)` in `src/index.ts`.
2. Name it `<group>.<verb_or_noun>`. The part before the first dot is the group shown in the UI.
3. Write the description for an agent that has never seen the app: what it does, when to use
   it, anything surprising about the result. Describe non-obvious input fields with
   `.describe()`.
4. Set `readOnly: true` if it changes nothing. Read-only calls are not audited, so be strict:
   anything that writes, sends or starts something is not read-only.
5. Set `destructive: true` for deletes and for anything that cannot be undone.
6. Add a test that calls it through the registry (`core.test.ts`) or over HTTP
   (`server.test.ts`).

No other registration is needed. The MCP tool, the HTTP route and the UI's capability console
pick it up from `registry.describe()`.

## Errors

Throw `CapabilityError(message, code)`. The code decides the HTTP status:

| Code | Status | Use for |
|---|---|---|
| `not_found` | 404 | The thing named by an id does not exist |
| `invalid_input` | 400 | Input that parses but makes no sense |
| `conflict` | 409 | Valid request, wrong state ("An attempt is still running") |
| `failed` (default) | 500 | An outside system failed (Jira unreachable) |

Hubs throw plain `Error`s. Wrap calls so they do not surface as 500s — see `guard()` in
`capabilities/work.ts`, which maps "not found" messages to `not_found` and the rest to
`conflict`. Input that fails the zod schema is rejected by the registry before the handler runs.

Messages are shown to people and to agents. Say what to do next:
`Secret "x" does not exist; store the token first with secrets.set`.

## Patch semantics

zod applies defaults even on `.partial()` schemas, so `input` cannot tell you which fields the
caller actually sent. For update-style capabilities, take the keys from `raw`:

```ts
handler: (ctx, _input, raw) => {
    const patch = Object.fromEntries(Object.entries(raw).filter(([k]) => k in Settings.shape));
    …
}
```

See `jira.configure` and `agents.update`. To let a caller clear an optional field, accept
`null` explicitly (see `SpecPatch` in `capabilities/agents.ts`).

## Audit and redaction

Every non-read-only call is recorded with its actor (for example `user:local`,
`mcp:<client>`, `system:<what>`, `teams:<name> · <Entra object id>`) and its input, after
`redact()`.

`redact()` works **by key name**: a string value is replaced with `•••` when its key matches
`/(secret|token|password|authorization|api[-_]?key|webhook)/i`. So:

- Name any field that carries a credential accordingly (`secretValue`, `webhookUrl`).
- Never return a credential from a capability. List things with the value masked or omitted
  (see `present()` in `capabilities/notify.ts` and `secrets.list`).

## Live updates

After changing state, emit `ctx.bus.emit("change", "<entity>")` (hubs usually do this
themselves). The entities are `agents`, `triggers`, `audit`, `work`, `notify`, `setup`, `powerplatform`. The UI's
`useRpc(name, input, topics)` refetches when a topic it listed is published.

## Presenting results

Capabilities return ids, but people want names. Follow the existing `present()` helpers: add
`agentName` next to `agentId`, and so on, rather than making the caller do a second lookup.
