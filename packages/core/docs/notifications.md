# Notifications

Files: `src/notify.ts` (NotifyHub, MockTeams, card builders), `src/capabilities/notify.ts`,
`src/teamsbot.ts` (TeamsBot, MockBotFramework), `src/capabilities/teams.ts`.

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
| `knowledge_sync_failed` | bus `notice` from `ConfluenceSync`, when an import's check goes from working to failing |
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
  dedupeKey, agentId?, project?,
  decision?: { approvalId, question } }           // only approvals and questions
```

`decision` is what lets the bot add buttons. Only `onApproval` sets it.

`agentId` and `project` exist so rules can narrow by them; set them when known.

## Channels

| Kind | Payload | Notes |
|---|---|---|
| `teams` | `toTeamsPayload` — a `message` with one Adaptive Card 1.4 attachment | For a Teams **Workflows** webhook. Office 365 connector webhooks are retired |
| `teams_bot` | `toAdaptiveCard(event, { interactive: true })`, posted by `TeamsBot` | A Teams conversation the bot was added to. `webhook_url` holds the **conversation id** |
| `mock_teams` | same payload as `teams`, kept in memory | The built-in preview; also reachable over HTTP at `POST /mock/teams/:channel` |
| `webhook` | `toWebhookPayload` — plain JSON | Any URL |

Cards are built by `toAdaptiveCard`. Keep to Adaptive Card 1.4 elements that Teams renders
(`TextBlock`, `FactSet`, `Input.Text`, `Action.OpenUrl`, `Action.Execute`). The web preview in
`apps/web/src/pages/Notifications.tsx` renders only what the builder produces — if you add an
element type to the card, teach the preview to draw it.

A card posted through a Workflows webhook cannot be answered or updated, so it only ever gets
links. With `interactive`, approvals get `Action.Execute` buttons (verbs `approve`, `deny`) and
questions an `Input.Text` named `answer` plus a `answer` button; `data.approvalId` says which.

## The Teams bot (`teamsbot.ts`)

Spoken to over the Bot Framework REST protocol directly; there is no Bot Framework SDK
dependency.

```
Teams ──POST /hooks/teams/messages (Bearer JWT)──► TeamsBot.receive
          conversationUpdate / message → remember the conversation
          invoke adaptiveCard/action    → approvals.decide as teams:<name> · <oid> → updated card
Foreman ──token from Entra──► POST {serviceUrl}v3/conversations/{id}/activities   (send a card)
                              PUT  …/activities/{activityId}                       (update it)
```

- **Inbound check** (`verify`): every step of Microsoft's "Authenticate requests from the Bot
  Connector service": RS256 signature with a key from the OpenID document's `jwks_uri` (cached
  6 h), issuer `https://api.botframework.com`, audience = app ID, `exp`/`nbf` with 5 min skew,
  `serviceUrl` claim equal to the activity's, channel endorsement. Any failure is a 401. Do not
  add a way to skip it.
- **Conversations** are recorded only from verified activities, because the bot sends its access
  token to the stored `serviceUrl`. A name learned at install is kept when later activities
  (button presses) carry none.
- **Decisions** go through `setDecider`, which `createForeman` wires to
  `registry.invoke("approvals.decide", …)`: the same checks, the same audit, the actor is the
  Teams user. `approvers` (Entra object ids) narrows who may decide; empty means anyone who can
  see the card. Refusals come back as a one-line message instead of a new card.
- **Cards update everywhere**: `bot_cards` remembers which posted card offers which approval. When
  an approval is settled by any route, `onApproval` replaces each such card with `decidedCard`
  (buttons and input removed, outcome added).
- **Outbound token**: client credentials against `login.microsoftonline.com/<tenant or
  botframework.com>`, scope `https://api.botframework.com/.default`, secret from the vault by
  `secretName`, cached until two minutes before expiry.

### Mock Bot Framework

`MockBotFramework` stands in for Microsoft at `/mock/botframework/*`: an OpenID document and key
set (its own RSA key, endorsed for `msteams`), a token endpoint, and the connector endpoints,
which store messages in `MockTeams` with `via: "bot"`. `install(team, channel)` and
`press(messageId, verb, inputs, user)` send **signed** activities to Foreman's own messaging
endpoint over HTTP, so the bot code takes exactly the path it takes with Teams. `settings.mock`
switches the bot's OpenID and login addresses to the mock; nothing else differs.

`mockBot.serverUrl` is where the mock reaches Foreman (both directions). It defaults to
`baseUrl`; tests set it to the real port, because `baseUrl` there is `http://test`.

### Setting up a real bot (never done yet)

Azure Bot resource (single-tenant), its app ID and a client secret → `teamsbot.configure` with
`appId`, `tenantId`, `secretName`; messaging endpoint = `teamsbot.status.messagingEndpoint`,
reachable over HTTPS; a Teams app manifest with the bot, installed in a team. Adding it to a
channel makes the conversation appear in `teamsbot.status`, after which a `teams_bot` channel can
point at it.

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
- `mockteams.messages` returns what the preview channel received; bot messages are filed under
  their conversation id.
- The bot needs `foreman.mockBot.serverUrl = base` in `server.test.ts`, then
  `teamsbot.configure({ enabled: true, mock: true })`, `mockteams.install`, and
  `mockteams.press` to act on a card.
