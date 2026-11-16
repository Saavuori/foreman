# Notifications

Files: `src/notify.ts` (NotifyHub, MockTeams, card builders), `src/capabilities/notify.ts`.

## Flow

```
something happens ──► NotifyEvent ──► inbox (always) ──► rules ──► channels ──► delivery log
```

1. A source builds a `NotifyEvent` and calls `notify.emit(event)`.
2. `emit` inserts it into the in-app inbox (`notifications` table). `dedupe_key` is unique: a
   repeat returns `false` and nothing is sent. **Every event needs a stable, specific
   `dedupeKey`** (`approval:<id>`, `failed:<itemId>:<attempt>`), or it will either repeat or be
   swallowed.
3. Each enabled rule that matches (event kind, optional agent, optional Jira project) selects a
   channel; a channel receives an event once even if several rules match.
4. `deliver` posts it, retrying twice (delays in `RETRY_DELAYS_MS`), subject to a per-channel
   rate limit. Every outcome is written to `deliveries`: `sent`, `retrying`, `failed`,
   `skipped`.

## Event kinds

`EVENT_KINDS` in `notify.ts` is the list; the key is stored, the value is the label people see.

| Kind | Raised by |
|---|---|
| `approval_needed`, `question_asked` | bus `approval` (pending) |
| `ticket_review`, `ticket_done`, `ticket_failed` | bus `work` |
| `run_failed` | bus `run`, for runs that are not ticket attempts |
| `ticket_aging` | `checkAging()`, once a minute |
| `intake_failed`, `jira_write_failed`, `custom` | bus `notice`, or `notify.send` |
| `batch_done` | `BatchHub` |
| `digest` | cron (`sendDigest`) |

Adding a kind — all four, or the type-checker or a test will tell you:

1. Add it to `EVENT_KINDS`.
2. Emit it: either from a bus listener in `NotifyHub`, or by calling `notify.emit` from the hub
   that knows (as `BatchHub` does). For a plain message from another hub, emit a bus `notice`
   and add the kind to the `notice` union in `registry.ts`.
3. Add a sample to `samples` in `capabilities/notify.ts` (used by `notify.preview` and the
   channel test button). The record is typed by kind, so a missing sample is a compile error.
4. Decide whether the demo's rule should include it (`apps/server/src/demo.ts`).

## Shape of an event

```ts
{ kind, severity: "info" | "success" | "warning" | "error",
  title,            // one line; names the ticket or agent
  text,             // one or two sentences
  facts: [["Ticket", "PAY-12"], …],
  links: [{ title: "Review and decide", url }],   // first link is where to act
  path: "/work/wrk_…",                            // in-app route for the inbox
  dedupeKey, agentId?, project? }
```

`agentId` and `project` exist so rules can narrow by them; set them when known.

## Channels

| Kind | Payload | Notes |
|---|---|---|
| `teams` | `toTeamsPayload` — a `message` with one Adaptive Card 1.4 attachment | For a Teams **Workflows** webhook. Office 365 connector webhooks are retired |
| `mock_teams` | same payload, kept in memory | The built-in preview; also reachable over HTTP at `POST /mock/teams/:channel` |
| `webhook` | `toWebhookPayload` — plain JSON | Any URL |

Cards are built by `toAdaptiveCard`. Keep to Adaptive Card 1.4 elements that Teams renders
(`TextBlock`, `FactSet`, `Action.OpenUrl`). The web preview in
`apps/web/src/pages/Notifications.tsx` renders only what the builder produces — if you add an
element type to the card, teach the preview to draw it.

A card posted through a webhook cannot be updated or answered in place. Approve/deny buttons
inside Teams need a bot; that is slice F of the plan and is not built.

Channel addresses are credentials: stored sealed by the vault (`webhook_url` column holds
`enc:v1:…`), masked by `maskUrl` when listed, and redacted in the audit log because the field is
named `webhookUrl`.

## Settings

`NotifySettings` (via `notify.settings()` / `notify.configure`): `ratePerMinute` per channel,
`agingMinutes`, and the digest (`digestEnabled`, `digestCron`, `digestTimezone`).

## Testing

- `notifyRetryDelaysMs` on `createForeman` shortens retries; tests pass `[5, 5]`.
- `NotifyHubOptions.fetch` lets a test replace the HTTP client.
- Deliveries are asynchronous: `await notify.settled()` or poll before asserting.
- `mockteams.messages` returns what the preview channel received.
