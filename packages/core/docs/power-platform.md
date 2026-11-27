# Power Platform administration

Files: `src/powerplatform.ts` (client, hub), `src/pptools.ts` (the agents' `pp_*` tools),
`src/mockpowerplatform.ts` (the practice tenant), `src/capabilities/powerplatform.ts`,
`apps/web/src/pages/PowerPlatform.tsx`. Design and reasoning: [PLAN-3-power-platform.md](../../../PLAN-3-power-platform.md).

Foreman is used by a **platform team** that administers a Power Platform tenant: environments,
access, governance. It is not for building solutions; there are no ALM tools on purpose.

## The decision this area rests on

Agents never run `pac`, PowerShell or raw HTTP against Power Platform. They call named Foreman
tools (`pp_env_reset`, `pp_access_grant` …), and Foreman makes the call itself on the **Power
Platform API** (`https://api.powerplatform.com`, api-version `2024-10-01`) or, for users and
roles, the environment's **Dataverse Web API**. Reasons, in short:

- A named tool is something a guardrail rule, an approval summary and a person can understand;
  a shell command line is not.
- The agent never holds a credential. Foreman gets the token and makes the call.
- Microsoft builds this API first; the newer `pac environment-management` commands are thin
  wrappers of it. pac would add a process start and a sign-in kept on disk, nothing more.

Keep it that way. If an operation exists only in pac, add one named tool for it that runs pac
itself (per-run home folder, scrubbed output), never a generic "run pac" tool.

## Two identities

| Connection | App role in Power Platform | Used by |
|---|---|---|
| `reader` | Power Platform reader | every read tool, the environment directory, `powerplatform.test` |
| `operator` | Power Platform contributor | change and destructive tools, and their `ValidateOnly` checks |

An agent chooses with `spec.powerPlatform.connection` (default `reader`). A change tool's
`prepare` refuses when the agent is on `reader`, so a reporting agent cannot change anything even
if its rules would allow it — and Microsoft would refuse the reader's token anyway.

With `apiUrl` empty everything goes to the **practice tenant** (`MockPowerPlatform`), in-process
through its `fetch`, with built-in principals `mock-reader` and `mock-operator`. The mock also
plays role-based access: a reader token may only GET.

## How a tool call goes

```
tools.call → parse args → prepare() → refuse? → authorize({ kind, toolName, targets, summary }) → handler()
```

`prepare` (on `ForemanTool`, run by the engine) is where Power Platform tools do their checking
before anybody is asked:

1. Resolve the environment from the directory (`hub.resolve`: id, display name or domain name;
   ambiguous or unknown names fail with suggestions).
2. For a change: refuse if the agent is on the reader connection, or the environment is
   **protected** (`hub.protection`: production and default by type, plus a list). A refusal is
   recorded as a `foreman.policy_decision` with action `deny` and never creates an approval.
   `pp_env_backup` is the one change allowed on a protected environment.
3. For create, managed, copy, restore, reset and delete: ask Power Platform with
   `ValidateOnly=true`, and fail with its reason if it would refuse.
4. Return `targets` (the facts rules match) and a `summary` that names the environment by name,
   type and group and says what was checked.

`targets` are `sandbox` / `production` / … (the type, lowercased), `group:<name>` or
`no-group`, `env:<display name>`, `managed`, `protected`, and for access tools `role:<name>`.
`evaluatePolicy` tries `kind@target` and `tool@target` (and `kind:tool@target`); a pattern with
`@` is tested only against those, a pattern without only against the plain forms.

Tool kinds: reads are `read`; changes are `custom-tool` (ask under `propose`, allow under `act`);
copy, restore, reset and delete are `destructive`, which every preset except `full` denies, so a
person must write a rule (`pp_env_reset@sandbox → ask`).

## Long operations

Create, copy, restore, reset, delete, managed and add-to-group answer 202 and run for minutes.
`client.track` follows the operation (from the body's `operationId` or the `operation-location`
header) until it ends or `settings.waitSeconds` pass, emitting `foreman.progress`. If it is still
running, the tool returns the operation id and tells the agent to check with `pp_operations`.
After any change the directory cache is dropped (`hub.invalidate`).

## The environment directory

`hub.directory()` lists every environment (following `@odata.nextlink`) and group with the
reader, and keeps them for `directoryTtlSeconds` (default 300). Name lookups, targets and the UI
use it, so a tool call costs no extra listing. `resolve` refreshes once before saying a name is
unknown.

## Adding a tool

Add it to `POWER_PLATFORM_TOOLS` in `pptools.ts`:

- `kind`: `read`, `custom-tool` or `destructive` — be honest; anything that loses data is destructive.
- `prepare`: use `onEnvironment(ctx, name, change, summary)`. Add `ValidateOnly` for anything
  Power Platform can validate. Put what the handler needs in `data`, so it is not looked up twice.
- `handler`: use `hub.client("reader")` for reads and `hub.client("operator")` for changes;
  pass `ctx.signal`; finish long operations with `finish(ctx, started, what)`.
- Add the route to `MockPowerPlatform` with the documented response shape, give `ppToolArgs` in
  `mock.ts` real arguments for it, and test it in `core.test.ts` (and over HTTP in
  `server.test.ts` if it touches sign-in or headers).
- It then shows in the studio, `system.agent_tools`, the mock runtime and the Copilot adapter.

Never add a tool that changes Power Platform role assignments, app registrations or tenant-wide
settings: an agent that can grant roles can grant itself more.

## What has not been checked against the real service

- Nothing here has run against a real tenant. Request and response shapes follow Microsoft's
  REST reference (api-version 2024-10-01) and the Dataverse Web API documentation.
- Power Platform role-based access control is **preview**; which endpoints honour reader and
  contributor for service principals changes month to month. `ValidateOnly` responses are
  documented only as 202/400; the client treats any 2xx as "would be accepted".
- How the operator identity reaches each environment's Dataverse (an application user per
  environment, or rights as a management application) is unconfirmed. `pp_access_*` need it.
- Users are not added to an environment by Foreman: `pp_access_grant` needs the person to be a
  user there already.
- Not built from the plan: DLP / connector policies, inventory (it needs a delegated user;
  service principals get 403), capacity reports beyond `pp_api_get`, admin mode and settings
  changes.
