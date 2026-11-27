# Foreman phase 3 — Power Platform administration: pac CLI or API?

> Drafted 2026-11-27. Builds on the run engine, guardrails, vault and work queue (`PLAN.md`,
> `PLAN-2-work-queue.md`). Slices A–D and most of E are built; see §9. The code guide is
> [packages/core/docs/power-platform.md](packages/core/docs/power-platform.md).

## 1. Who and what

Foreman's users here are the **platform team** that runs the tenant's Power Platform, not
makers building apps. No solution development or ALM. The work that arrives as Jira tickets or on
a schedule looks like:

| Kind of work | Examples |
|---|---|
| Environment requests | "New sandbox for team X", copy prod to test, back up before a change, restore, reset, delete when no longer needed, move into an environment group, turn on managed environment |
| Access | Give a person or a group a security role in an environment, add an application user, remove access when someone leaves |
| Governance | DLP / connector policy changes and their impact, tenant settings, unmanaged or unused environments, resources owned by people who have left, quarantined apps |
| Capacity and licensing | Storage use per environment, environments near limits, billing policies |
| Reporting and monitoring | Scheduled reports, lifecycle operations that failed, "what changed this week" |

All of it can be done three ways: the **Power Platform API** (`api.powerplatform.com`, the
management plane), the **pac CLI** (`pac admin …`, `pac environment-management …`), or
PowerShell for administrators. Data inside an environment (users, roles) is the **Dataverse
Web API** of that environment.

## 2. Decision

**Agents call Foreman tools named after the admin job (`pp_env_list`, `pp_env_backup`,
`pp_access_grant` …). Foreman implements them on the Power Platform API, plus the Dataverse Web
API for what lives inside an environment. pac is not used at the start. It is added only for a
specific operation the API cannot do yet, and only behind its own named tool.**

Why the API and not pac:

- **Microsoft builds the API first.** Features ship in the Power Platform API first, then
  reach the SDKs, CLI, PowerShell and connectors. The `pac environment-management` commands are
  documented as one-to-one wrappers of API operations ("you can also invoke this command using
  the Power Platform REST API …"). pac adds a .NET process start and an auth profile on disk,
  and no capability we need.
- **It is the only path with Microsoft-side least privilege.** Power Platform role-based access
  control (preview) lets a service principal hold *Power Platform reader* or *contributor*
  instead of full admin. The older service principal route treats the app like a Power Platform
  administrator with no finer roles.
- **It fits Foreman.** Plain HTTPS with `fetch`, JSON in and out, no new runtime on the server,
  testable against a mock like `MockJira`.

Why not pac (or PowerShell) in the agent's shell at all, for an admin team in particular:

| Concern | pac in the agent's shell | Typed Foreman tools |
|---|---|---|
| **Blast radius** | One mistyped `pac admin delete` or `pac admin reset` destroys an environment. Policy sees only `shell` plus a string; chaining and scripts defeat command-line matching | `pp_env_delete` is its own tool: `deny` by default, a one-line rule to change |
| **Which environment** | Whatever the agent types | Foreman looks up the environment first and decides on its *type* and *group* (§4) |
| **Credentials** | A tenant-admin profile on disk, usable for any command | Secret in the vault, token held by Foreman; the agent never has a credential |
| **Approvals** | Approve a raw command line | Approve "Reset *HR-Test* (sandbox, group *HR*). Checked first: valid" |
| **Instructions** | Teach pac verbs, flags, GUID formats, output tables | Instructions describe the runbook; tool descriptions carry the how |
| **Efficiency** | Seconds per process start, text tables to parse, flag typos | One HTTP call with a cached token, compact JSON |

## 3. Tools and which API backs each

Every tool resolves the environment by name or id itself, so agents never handle URLs.

**Read** (allowed under every preset):

| Tool | Backend |
|---|---|
| `pp_env_list`, `pp_env_get` | Power Platform API, environment management (filter by type, group, state; `$select`, paged) |
| `pp_env_groups` | Power Platform API, environment groups |
| `pp_operations` | Power Platform API, lifecycle operations for an environment or by id: is the copy finished, why did it fail |
| `pp_backups` | Power Platform API, environment backups |
| `pp_capacity` | Power Platform API, capacity / licensing |
| `pp_settings_get` | Power Platform API, environment management settings and tenant settings |
| `pp_dlp_list`, `pp_dlp_get` | Power Platform API, connector policies (confirm coverage when building; §8) |
| `pp_env_users`, `pp_env_roles` | Dataverse Web API of that environment (`systemuser`, `role`, `teams`) |
| `pp_inventory` | Power Platform inventory query: apps, flows, agents, owners, connectors used. **Needs a delegated user token**; it refuses service principals (§8) |

**Change** (`custom-tool` kind, so `ask` under `propose`):

| Tool | Backend | Default in templates |
|---|---|---|
| `pp_env_backup` | Power Platform API | allow (creates a restore point; no harm done) |
| `pp_env_create` | Power Platform API, provisioning | ask |
| `pp_env_add_to_group` | Power Platform API | ask |
| `pp_env_managed` | Power Platform API, managed environment on/off | ask |
| `pp_env_admin_mode` | Power Platform API, runtime state | ask |
| `pp_settings_set` | Power Platform API | ask |
| `pp_access_grant`, `pp_access_revoke` | Dataverse Web API (assign role to user / group team / application user) | ask; grant of a role on the team's allowlist may be allow |
| `pp_dlp_change` | Power Platform API | ask, always with an impact report (§5) |

**Destructive or overwriting** (a new kind, `destructive`: `deny` under every preset except
`full`; a person must write an explicit rule to make it `ask`):

`pp_env_copy` (overwrites the target), `pp_env_restore`, `pp_env_reset`, `pp_env_delete`.

Left out deliberately: role assignments in Power Platform RBAC itself, app registrations, and
tenant-wide settings writes. An agent that can grant roles can grant itself more. Those stay
with people.

## 4. Control

Three layers, from coarse to fine. Each one alone is not enough.

### 4.1 Microsoft side: two identities

- **Reader connection**: an app registration with the *Power Platform reader* role. All read
  tools use it.
- **Operator connection**: a second app registration with *Power Platform contributor*. Only
  change and destructive tools use it, and only for agents that list it.
- Both secrets live in the vault, referenced by name. An agent that only reports never has a
  token that could change anything, whatever its rules say.
- Built-in roles cannot be customised, and scoping below the tenant is still being rolled out.
  So Microsoft's side decides *read vs write*; Foreman decides *which write, where, with whose
  approval*.

### 4.2 Foreman settings: protected environments

A Power Platform setting (a capability, like Jira's) lists **protected environments** by id,
and protects the *default* environment and every *production* environment unless a person turns
that off. Change and destructive tools refuse a protected environment, whatever the policy says.
It is the same kind of switch as "writing to Jira is off until a person turns it on".

### 4.3 Policy rules that know the environment

Today `evaluatePolicy` matches `kind`, `kind:toolName` and `toolName`. The tool looks the
environment up *before* asking for permission, and passes its facts as a `target`. The policy
then also tries `toolName@<type>`, `toolName@group:<name>`, and the same with `kind`:

```
pp_env_reset@sandbox      → ask
pp_env_delete@developer   → ask
destructive@production    → deny
*@group:Finance           → ask
pp_access_grant@sandbox   → allow
```

Small change: an optional `target` on `PermissionSubject` and a `target(args)` hook on
`ForemanTool`, resolved in the engine's `tools.call`. Rules without `@` behave as today.

### 4.4 Approval text that is worth reading

The approval summary names the environment by display name, type and group, and says what was
checked: "Delete *Sales-Old* (sandbox, no group). Last modified 2025-03-02, 0 apps, 0 flows."
Where the API offers `validateOnly` (copy and provisioning do), the tool validates first and
puts the result in the summary. A person approves a fact, not a GUID.

## 5. Efficiency

- **Tokens**: client credentials against `https://api.powerplatform.com/.default`, and per
  environment `<org url>/.default` for Dataverse. Cached until shortly before they expire, per
  connection. No SDK dependency: plain `fetch`.
- **An environment directory cache**: id, name, type, group and Dataverse URL for every
  environment, refreshed every few minutes. Name lookups and the policy target resolve from it
  with no extra call.
- **Bounded results**: `$select` and paging on every list. Results over about 50 rows are
  written to a CSV in the run's workspace; the tool returns the path, the count and the first
  rows. A tenant with 800 environments does not land in the model's context.
- **Long operations**: copy, restore and provisioning take minutes to hours. The tool starts the
  operation, waits up to a configured time while emitting `foreman.progress`, and otherwise
  returns the operation id. `pp_operations` picks it up later. Agents that do these jobs get a
  longer `budget.timeoutSeconds`. Parking a run until an operation finishes, instead of keeping it
  open, is a later improvement.
- **Impact before change**: `pp_dlp_change` first runs the inventory query for resources that
  use the connector and puts the count and top owners in the approval. One call saves a
  tenant-wide outage.
- **Throttling**: honour `Retry-After` on 429, and word the error so the work queue's
  `TRANSIENT` pattern retries the ticket.

## 6. Instructing agents

- **Runbooks are the instructions.** Each template's instructions are the team's procedure in
  plain words ("Back up before any reset. Never reset an environment that changed in the last
  24 hours without asking."). The tools carry the API knowledge, so a runbook never mentions an
  endpoint, flag or GUID.
- **Tickets carry the inputs.** The prompt template renders the ticket's fields (environment
  name, requester, role asked for) as data, as it does today; content cannot change tools or rules.
- **Templates** in `onboarding.ts`, all `propose`, all running on the simulator:

| Template | Tools | Shape |
|---|---|---|
| Environment request | reads, `pp_env_create`, `pp_env_add_to_group`, `pp_env_managed`, `jira_add_comment` | Creates a sandbox from a ticket; one approval |
| Access request | reads, `pp_access_grant`, `jira_add_comment` | Roles on an allowlist go through; others ask |
| Governance report | reads only, on a schedule | Unmanaged or idle environments, capacity, orphaned resources; posts to Teams |
| DLP change assessor | reads only | Writes an impact analysis on the ticket; a person makes the change |
| Environment maintenance | reads, `pp_env_backup`, `pp_env_reset` / `pp_env_restore` with explicit `ask` rules | Backup first, then the change |

## 7. Build order

Mocks first, every feature a capability, each slice shippable.

| Slice | Contents | Done when |
|---|---|---|
| **A. Connections + reads** | Reader/operator connection settings and capabilities (`powerplatform.connections.*`, `powerplatform.status`), token client, environment directory cache, `MockPowerPlatform` under `/mock/powerplatform/*` (management API and a small Dataverse), read tools | The governance report template runs on the simulator against the mock |
| **B. Guardrails** | `target` in policy, `destructive` kind, protected environments, approval summaries with checked facts | Tests: protected env refuses every write under `full`; `destructive@production → deny` holds; reader connection is used for reads |
| **C. Changes** | Backup, create, group, managed, admin mode, settings, access grant/revoke, long-operation handling | Environment request and access request templates pass a ticket end to end in the mock with one approval |
| **D. Destructive** | Copy, restore, reset, delete with `validateOnly` and backup-first | Each is denied until a rule allows it; with a rule, it asks with a specific summary |
| **E. Governance** | DLP read/change with impact report, inventory (with the delegated-user question settled), templates, `docs/power-platform.md` | DLP assessor writes an impact report; first run of each template stops where its promise says |

## 8. Open questions and what this plan does not prove

- Nothing has run against a real tenant. The mock will follow Microsoft's documented API shapes.
- **Power Platform RBAC is preview.** Which endpoints honour it for service principals is listed
  under "known limitations" in Microsoft's programmability docs and changes monthly. Check each
  tool's endpoint against that list when building it; where reader/contributor does not apply
  yet, say so in `powerplatform.status`.
- **Inventory needs a delegated user.** The inventory query returns 403 for service principals
  today. Options: leave `pp_inventory` out until that changes, query Azure Resource Graph's
  `PowerPlatformResources` table with an Azure identity (unverified for this table), or a
  delegated sign-in by a person with refresh. Decide in slice E.
- **DLP writes**: confirm what the Power Platform API covers for classic DLP policies versus the
  newer connector policies before building `pp_dlp_change`. pac only lists and shows DLP policies.
- **Dataverse access per environment**: confirm how the operator identity reaches each
  environment's Dataverse for `pp_access_*` (an application user per environment, or rights it
  gets as a management application). This decides how much setup a new environment needs.
- pac stays unused until a needed operation exists only in pac; if that happens, it gets one named
  tool, run by Foreman with a per-run home folder and scrubbed output, never a generic "run pac".

## 9. Status (2026-11-27)

Built, against the practice tenant only:

- **A.** Reader and operator connections (`powerplatform.settings` / `configure` / `test`),
  token cache, environment directory cache, the practice tenant (`MockPowerPlatform`, in-process
  and at `/mock/powerplatform/*`), and the read tools. `pp_capacity` became the general read-only
  `pp_api_get`.
- **B.** `targets` in the policy (type, `group:`, `no-group`, `env:`, `managed`, `protected`,
  and `role:` for access), the `destructive` kind, protected environments
  (`powerplatform.protect`), approval summaries that say what was checked. An agent picks its
  identity with `spec.powerPlatform.connection`.
- **C.** Backup, create, add to group, make managed, give and take a security role, long
  operations followed up to `waitSeconds`.
- **D.** Copy, restore, reset, delete, each checked with `ValidateOnly` first.
- **E (part).** Four templates (governance report, environment requests, access requests,
  maintenance), three sample agents with five practice tickets, the Power Platform page, the
  studio's tool groups and identity switch, docs.

Not built, and why:

- DLP / connector policies and the impact report: write coverage in the API is unconfirmed (§8).
- Inventory (apps, flows, owners): the query refuses service principals today (§8).
- Admin mode and settings changes: no endpoint confirmed yet; reads work through
  `pp_settings_get` and `pp_api_get`.
- Writing large results to a CSV in the run's workspace: tools filter and cap their output
  instead, and say when there is more.
- Parking a run while a long operation finishes: the tool returns the operation id instead.
- Adding a person to an environment: `pp_access_grant` needs them to be a user there already.

