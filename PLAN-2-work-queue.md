# Foreman phase 2 — Jira work queue, Teams notifications, full mock

> Drafted 2026-11-11. Builds on what exists today: capability registry, run engine,
> approvals, triggers, traces, MCP server and web UI (see `PLAN.md`).

## 1. What changes

Phase 1 treats a **run** as the unit of work. That fits a webhook or a schedule,
but not a ticket: a ticket lives for days, can be attempted several times, can
wait on a person, and has a status other people watch in Jira.

Phase 2 adds a unit above the run — the **work item** — and makes it the centre
of the product:

```
Jira ──► Intake ──► Work queue ──► Agent run(s) ──► Write-back to Jira
                        │                │
                        └── Work board ◄─┘──► Notifications ──► Teams
```

Everything runs against mocks first (no Copilot, no Jira site, no Teams tenant
needed), and every new feature is a capability, so it is in MCP from day one.

## 2. Work items and the queue

### 2.1 The work item

| Field | Notes |
|---|---|
| `source`, `key`, `url` | `jira` / `PROJ-123` / link. Unique on source + key, so a ticket is never queued twice |
| Snapshot | title, description, type, priority, labels, components, reporter, assignee, Jira status, recent comments, linked issues |
| `agentId` | chosen by a routing rule, changeable by hand |
| `state` | see below |
| `rank` | queue order: Jira priority, then age; can be dragged |
| `attempts` | each attempt is one run, linked both ways |
| `progress` | latest step reported by the agent (`3 of 5 — running tests`) |
| `blockedReason` | what it is waiting for, when it is waiting |
| Timestamps | received, queued, started, finished — basis for cycle time |

States, which are also the board columns:

```
inbox ─► queued ─► working ─► review ─► done
            ▲         │  ▲
            │         ▼  │
            │      needs_you   (approval, or the agent asked a question)
            └──── failed       (retry puts it back in queued)
   skipped  (deliberately not handled)
```

- **inbox** — arrived but matched no routing rule, or routing is set to manual.
- **needs_you** — an approval is pending, or the agent asked for information.
- **review** — the agent finished and a person should check the result before
  the ticket is closed. Optional per agent; otherwise it goes straight to done.

### 2.2 Queue behaviour

- One active run per ticket; a work-in-progress limit per agent and per Jira project.
- Ordering by rank; a ticket can be held, bumped, reassigned or skipped.
- Automatic retry with backoff for failures marked transient; otherwise it stops
  in **failed** and notifies.
- A ticket that changes in Jira while queued refreshes its snapshot; a new human
  comment on a `needs_you` or `done` ticket can re-queue it (configurable).

### 2.3 Capabilities (API + MCP + UI at once)

`work.list`, `work.get`, `work.add` (by Jira key or JQL), `work.assign`,
`work.rank`, `work.hold`, `work.retry`, `work.skip`, `work.complete`,
`work.stats` (throughput, cycle time, queue depth, ageing),
`routing.list/create/update/delete/test` (dry-run a rule against a ticket).

## 3. Jira intake

### 3.1 Getting tickets in — four ways, one pipeline

| Way | When to use it | Needs |
|---|---|---|
| **JQL poll** (default) | Works from a laptop or behind a firewall | Site URL + API token. Polls on a cursor of `updated`, every 1–5 min |
| **Jira webhook** | Instant pickup | Foreman reachable from the internet; shared secret |
| **Jira Automation rule** ("send web request") | Teams that already manage rules in Jira | Same endpoint as the webhook |
| **By hand** | One-off, or to try an agent on a real ticket | `work.add` from the UI, palette or MCP |

All four produce the same normalised ticket event, so dedupe, routing and
queueing are written once.

### 3.2 Opting tickets in

Recommended default: **explicit opt-in**, so nothing is picked up by accident —
either a label (`foreman`) or assignment to a dedicated bot user. A routing rule
then maps tickets to agents:

```yaml
- name: Bugs in PAY go to the triage agent
  match: { project: PAY, type: Bug, label: foreman }   # or raw JQL
  agent: bug-triage
  review: true            # stop in "review" before done
  onStart:   { transition: "In Progress", comment: true }
  onSuccess: { transition: "In Review", comment: summary }
  onFailure: { comment: reason, label: foreman-failed }
  onNeedsInfo: { assignTo: reporter, comment: question }
```

### 3.3 Writing back

Two separate paths, on purpose:

- **Orchestrator write-back** (deterministic): the status transitions and
  comments in the rule above. Foreman does these itself, so the ticket always
  reflects reality even if the agent misbehaves.
- **Agent tools** (guard-railed): `jira_get_issue`, `jira_search`,
  `jira_add_comment`, `jira_transition`, `jira_create_subtask`. These go through
  the existing policy engine, so "comment freely, ask before transitioning" is a
  two-line guardrail.

The ticket text becomes the prompt through a template, wrapped as untrusted
data exactly like webhook payloads today — a ticket description cannot grant the
agent permissions.

Two built-in tools let the agent talk to the queue: `report_progress(step,
total, message)` drives the progress bar and optional Teams/Jira updates, and
`ask_for_info(question)` moves the ticket to `needs_you`.

### 3.4 Prerequisite: secrets vault

Jira and Teams credentials must not sit in plain config. The vault from the
original plan (encrypted at rest, write-only through the API, referenced by
name, redacted from traces and the audit log) moves into this phase.

## 4. Seeing progress

### 4.1 Work board (new main screen)

```
┌ Inbox 2 ─┬ Queued 7 ──┬ Working 3 ───────┬ Needs you 1 ┬ Review 2 ─┬ Done today 14 ┐
│ PAY-311  │ PAY-298 ▲  │ PAY-290          │ ▨ PAY-287   │ OPS-51    │ PAY-280  4m   │
│ OPS-77   │ PAY-301    │ bug-triage       │ approve:    │ OPS-49    │ PAY-279  2m   │
│          │ OPS-60     │ ● 3/5 run tests  │ git push    │           │ …             │
│          │ …          │ ▓▓▓▓▓░░░ 6m      │ [Approve]   │           │               │
└──────────┴────────────┴──────────────────┴─────────────┴───────────┴───────────────┘
 Filter: project · agent · label · batch        View: Board | Queue | Timeline
```

- Cards show the Jira key, title, agent, the signal lamp already used across the
  UI, live progress, elapsed time and cost. Hazard-stripe cards mean "needs you",
  with approve / deny on the card.
- **Queue view**: the same data as a ranked list with drag-to-reorder and bulk
  actions.
- **Timeline view**: one lane per agent, runs as bars on a time axis — shows
  load, idle gaps and where things pile up.
- Card drawer: ticket snapshot, every attempt with its shift log, what was
  written back to Jira, what was sent to Teams, and actions.

### 4.2 Batches

Most real asks are "work through these 40 tickets". A **batch** is a saved JQL,
epic or sprint tracked as a unit: progress bar (done / working / waiting /
failed), estimated finish from recent cycle time, total cost, and one Teams
summary when it completes.

### 4.3 Flow metrics

On the board header and in `work.stats`: throughput per day, median and p90
cycle time, queue depth over time, work in progress per agent, share needing a
human, ageing tickets (waiting longer than a threshold), cost per ticket.

## 5. Notifications, Teams first

### 5.1 Model

`event → rule → channel → delivery`, each stored, so there is always an answer
to "was anyone told?".

| Event | Default |
|---|---|
| Approval needed | Immediately, to the agent's channel |
| Agent asked a question | Immediately, mentioning the ticket's reporter |
| Ticket failed | Immediately |
| Ticket done / ready for review | Immediately, or batched |
| Batch finished | One summary |
| Ticket ageing in queue or waiting | After a threshold |
| Budget hit, runtime unhealthy, Jira or Teams connection failing | Immediately, to an admin channel |
| Daily digest | Scheduled: done, failed, waiting, spend |

Rules choose channel by agent, Jira project, event and severity, with quiet
hours, de-duplication (one card per ticket, updated rather than repeated where
the channel allows), and rate limits so a bad night does not flood a channel.

Channels: **Teams**, an in-app inbox (bell in the nav), and a generic webhook.
Email can follow.

### 5.2 Teams, in two steps

**Step 1 — Workflows webhook (no admin, minutes to set up).** The old Office 365
connector webhooks were retired in 2026; the supported replacement is a Teams
*Workflows* flow with the "When a Teams webhook request is received" trigger.
Foreman posts Adaptive Cards to that URL. Cards carry the ticket, agent, what
happened and buttons that open Foreman and Jira. Approvals are decided by
opening the Foreman link. This covers every notification above.

**Step 2 — Teams bot (interactive).** Approve / Deny / Answer directly inside
the card, direct messages to a named person, real @mentions, and cards that
update in place. Needs an app registration in Microsoft Entra, a bot
registration and Foreman reachable over HTTPS. Decisions made in Teams go
through the same `approvals.decide` capability and are audited as the Teams user.

Both steps render from the **same card templates**, so step 2 adds
interactivity without redesigning anything.

### 5.3 Capabilities

`channels.list/create/update/delete/test`, `notify.rules.*`,
`notify.log` (deliveries with status and retries), `notify.send` (so an agent
can notify through its guardrails), `notify.preview` (render a card without
sending).

## 6. The mock — everything testable without Copilot, Jira or Teams

No Copilot subscription is available, so the mock is a first-class part of the
product, not a test helper. New agents already default to the simulated
runtime (changed today).

### 6.1 Mock runtime: scenarios instead of one script

The current simulator walks the tool list once. It becomes scenario-driven:

| Scenario | What it exercises |
|---|---|
| `happy` | Read → plan → edit → report progress → done |
| `needs-approval` | Stops at a shell command or a Jira transition |
| `asks-question` | Calls `ask_for_info`, resumes when answered |
| `slow` | Many steps over minutes with progress — for the board and timeline |
| `tool-failure` | A tool errors; agent recovers or gives up |
| `flaky` | Fails first attempt, succeeds on retry |
| `timeout`, `over-budget` | Limit handling and notifications |
| `sub-agents` | Delegation events in the trace |
| `bad-output` | Result that breaks the output schema |

- Chosen per agent (`mock.scenario`), per ticket by label (`mock:flaky`), or
  weighted at random with a fixed seed so runs are repeatable.
- Speed control (instant for tests, real-time for demos).
- Emits events in the Copilot SDK's own shapes, checked against the SDK's types
  at compile time, so the UI cannot tell the difference.
- A scenario is a small YAML file — easy to add one that reproduces a bug.

### 6.2 Mock Jira

A built-in fake Jira at `/mock/jira` implementing the subset Foreman uses
(search, get issue, comments, transitions, webhooks). It is seeded with a
project of realistic tickets, and has a "ticket generator" that files new ones
at a chosen rate. The real Jira client is pointed at it by URL — the same code
path as production, just a different base URL.

### 6.3 Mock Teams

A sink at `/mock/teams` that accepts the same payload as a Workflows webhook,
stores it and renders the Adaptive Cards in a **Teams preview** page — so cards
can be designed, and notification rules verified, with no tenant.

### 6.4 Demo mode

`npm run demo` starts Foreman with mock Jira, mock Teams, three sample agents,
routing rules and a trickle of incoming tickets across the scenarios. The board
is alive within seconds — for UI work, demos and end-to-end tests.

### 6.5 The road to real runs

- **Bring your own key.** The Copilot SDK supports running without a Copilot
  subscription by supplying your own model-provider API key. That is the
  shortest route to real agent runs and becomes a `provider` setting on the
  agent. Unverified so far — it needs a spike like the first one.
- **Record and replay.** Once any real run exists, its event stream can be saved
  as a scenario, so the mock library grows from reality.
- A **contract test suite** runs against every runtime (mock, Copilot, BYOK) so
  they cannot drift apart.

## 7. Build order

| # | Slice | Done when |
|---|---|---|
| **A** | Mock foundation: scenario runtime, demo mode, finish browser check of the current UI | `npm run demo` shows varied runs, approvals and failures on the existing screens |
| **B** | Work items, queue, routing, mock Jira, JQL poll + manual add, **Work board** | Tickets from mock Jira flow across the board live; retry, hold, reassign work from UI and MCP |
| **C** | Notification engine, card templates, mock Teams + preview, in-app inbox, Workflows webhook channel | Every event in §5.1 produces a card in the preview; a real Teams channel receives them when a webhook URL is set |
| **D** | Secrets vault, real Jira client (token auth), write-back, agent Jira tools, progress + ask-for-info tools | A real Jira ticket is picked up, commented on, transitioned and closed by a mock agent |
| **E** | Batches, flow metrics, timeline view, digest | A 40-ticket batch shows progress and sends one summary |
| **F** | Teams bot (interactive approvals), Jira webhook intake, BYOK spike | Approve from a Teams card; one real model-backed run end to end |

A–C need nothing outside this machine. D needs a Jira site and token. F needs
Microsoft Entra admin consent, a public HTTPS address, and a model API key.

## 8. Decisions needed

1. **Jira flavour** — Cloud (assumed: REST v3, API token) or Data Center?
2. **Opt-in** — label, bot assignee, or everything matching a JQL filter?
3. **Reachability** — will Foreman have a public HTTPS address? If not, intake
   stays on polling and Teams stays on step 1 (no in-card approve).
4. **Review column** — should finished tickets wait for a human check by default?
5. **How far may agents go in Jira** on their own — comment only, or transition
   and close too?
6. **Real model access** — is a model API key (for BYOK) an option, or is mock
   the horizon for now?
