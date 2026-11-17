# Work queue, Jira, batches, flow

Files: `src/work.ts` (WorkHub), `src/jira.ts` (JiraClient, MockJira), `src/batches.ts`
(BatchHub), `src/flow.ts` (metrics), `src/capabilities/work.ts`, `src/capabilities/flow.ts`.

## Model

A **work item** is one ticket as Foreman tracks it. It outlives its runs: each attempt at the
ticket is a run with `source: { kind: "work", workItemId }`.

```
            ┌────────── retry (transient failure, or by hand) ──────────┐
            ▼                                                           │
 inbox ─► queued ─► working ─► review ─► done                           │
   ▲         │         │  ▲       (only if the rule says review)        │
   │         │         ▼  │                                             │
   │         │      needs_you  (approval or question pending)           │
   │         │         │                                                │
   │         └─────────┴────────────► failed ───────────────────────────┘
   └── no rule matched, or its agent was archived        skipped  (decided not to handle)
```

- `inbox` — no routing rule matched; a person assigns an agent.
- `queued` — waiting for a slot. Order is `rank` (priority, then arrival; lower runs sooner).
  `held` items keep their place but do not start.
- `working` / `needs_you` — the "active" states (`ACTIVE_WORK_STATES`). `runId` is the current
  attempt.
- `review` — finished, waiting for a person to accept (`work.complete`).

All state changes go through `WorkHub.setState`, which stamps times, emits `change` and `work`
on the bus, and triggers Jira write-back. **Do not update `state` any other way.**

## Intake

Three ways in, one pipeline (`WorkHub.ingest(ticket)`), which never creates a duplicate
(`UNIQUE (source, key)`):

1. **Polling** — `poll()` runs the configured JQL every `pollSeconds`, asking only for tickets
   updated since the last successful poll (cursor in settings key `jira.cursor`, stepped back a
   minute because Jira compares to the minute).
2. **By key** — `addByKeys(keys)`, regardless of the filter.
3. **Batches** — a batch's own JQL or key list.

A failing poll emits one `notice` per outage, not one per attempt.

**The Jira webhook** (`POST /hooks/jira/:secret`) is not a fourth way in: it calls `nudge()`,
which polls at once (or once more after a poll in flight, via `pollAgain`). The request body is
ignored on purpose — a webhook could name any ticket, and only the JQL filter decides what is
taken. The secret is random, sealed in settings key `jira.webhookSecret`, and replaced by
`jira.rotate_webhook`. `webhookUrl()` builds the address from `baseUrl`, so Jira can only reach
it if `FOREMAN_BASE_URL` is a public address. `MockJira.webhookUrl`, when set, makes the mock call
it on every new ticket (`mockjira.webhooks`); the demo turns that on and polls only every 30 s.

## Routing and dispatch

`route(ticket)` returns the first enabled rule (ordered by `position`) whose `match` fields all
equal the ticket's (`project`, `type`, `label`, `priority`; case-insensitive; empty match
catches everything). The rule sets the agent, whether to stop in review, and the prompt
template (default `DEFAULT_TICKET_PROMPT`).

`dispatch()` starts queued items in rank order while the agent has fewer than `wipPerAgent`
active items. It is cheap and idempotent — call it after anything that could free a slot or
add work.

`onRun` moves the item when its run changes. It ignores runs that are not the item's current
`runId`, which is what makes "stop and retry" safe: `stopRun` detaches the run first, then
cancels it.

A failed run is retried automatically only when the error matches `TRANSIENT` and
`attempts < maxAttempts`.

## Jira client (`jira.ts`)

`JiraClient(baseUrl, { headers, flavor })`:

| | `cloud` | `datacenter` |
|---|---|---|
| API prefix | `/rest/api/3` | `/rest/api/2` |
| Search | `/search/jql`, `nextPageToken` paging | `/search`, `startAt` paging |
| Rich text | Atlassian Document (`toDocument`) | plain string |

Methods: `myself`, `getIssue`, `getIssueWithComments`, `search`, `addComment`, `transitions`,
`transition` (by status name or transition name; returns null if already there),
`createSubtask` (tries issue type "Sub-task", then "Subtask").

`WorkHub.client()` builds one per call from settings: `auth.type` `basic` sends
`email:token` as Basic auth, `bearer` sends the token; the token is read from the vault by
`auth.secretName` at that moment and is never stored in settings. `work.jira()` is the public
accessor used by agent tools and batches.

`toTicket(issue, baseUrl)` is the only place a Jira issue becomes a `Ticket`. If you need a new
field, add it to `FIELDS`, to `Ticket` in `schemas.ts` (with a default), and here.

## Mock Jira

`MockJira` is an in-memory Jira that the **real client talks to over HTTP** (routes in
`apps/server/src/app.ts` under `/mock/jira`), so the production code path is what tests
exercise. It is used whenever `settings.baseUrl` is empty (`work.isMock()`).

- Seeded with tickets in `SEED`; most carry the opt-in label `foreman`, and some carry a
  `mock:<scenario>` label that decides how the mock agent behaves on them.
- `generate()` / `setGenerator(perMinute)` file tickets on their own (used by the demo).
- Supports comments, a four-status workflow (`MOCK_STATUSES`, any status reachable from any
  other), subtasks, and `requiredAuth` to make it demand an exact `Authorization` header.
- `search(jql)` understands only `AND`-joined clauses over project, labels, status, type,
  priority and `updated >=`. **Unknown clauses are ignored, not rejected.**

If you add a call to `JiraClient`, add the matching route to the mock in `app.ts` (for both API
versions — the routes are registered on `/rest/api/:v`) and a test.

## Write-back

`WorkHub.writeBack(item, previous)` runs on every state change when
`settings.writeBack.enabled`. It may comment and/or move the ticket to a configured status:

| Entering | Comment | Status setting |
|---|---|---|
| `working` (new attempt only) | "started" | `statusStarted` |
| `needs_you` (question only) | the question | — |
| `review` | result | `statusReview` |
| `done` | result, or "accepted" | `statusDone` |
| `failed` | the error | `statusFailed` |

Writes for one ticket are chained so they arrive in order. Failures never throw: they are
recorded in `work.writeLog` (in memory, newest first) and raise a `jira_write_failed` notice.
After a successful transition the stored ticket snapshot's status is updated directly, because
the ticket may no longer match the intake filter and so would never be re-read.

`work.settled()` resolves when no write is in flight — tests must wait on it or poll.

## Settings

`JiraSettings` (settings key `jira`): `enabled`, `baseUrl`, `flavor`, `auth`, `jql`,
`pollSeconds`, `wipPerAgent`, `maxAttempts`, `writeBack`. Change them only through
`work.updateSettings(patch)`, which deep-merges `auth` and `writeBack`, resets the poll cursor
when the site or filter changes, and reschedules polling.

## Batches (`batches.ts`)

A batch is a named set of work items (tables `batches`, `batch_items`) built from a JQL, a key
list, or both. It only observes: `progress(batch)` counts items by group, sums credits from
their runs, and projects a finish time once two tickets have finished since it was created.
On each `work` bus event `check()` marks the batch `complete` when nothing is queued, working
or waiting, and emits one `batch_done` notification; a retry reopens it.

`membership()` gives the batches of every item in one query — use it rather than looking up
per item.

## Flow metrics (`flow.ts`)

`flowMetrics(store, options)` and `runTimeline(store, hours)` are pure functions over stored
data. Nothing is sampled: queue depth is rebuilt from each item's latest `queuedAt` /
`startedAt` / `finishedAt`, so a retried ticket appears as one wait and one stretch of work.
If you need exact history, add sampling rather than stretching this reconstruction.

"Needed a person" means the ticket's runs had at least one approval or question, or its rule
required review.

## Where to add things

| You want to | Change |
|---|---|
| A new work-item action | A method on `WorkHub` using `setState`, a capability in `capabilities/work.ts`, a button in the drawer in `apps/web/src/pages/Work.tsx` |
| A new routing condition | `RoutingMatch` in `schemas.ts`, `ruleMatches` in `work.ts`, the rule form in `Work.tsx` |
| A new intake source | Produce `Ticket`s and call `ingest`; keep `source` on `Ticket` accurate |
| A new metric | `flow.ts`, then the Flow view in `apps/web/src/pages/WorkViews.tsx` |
