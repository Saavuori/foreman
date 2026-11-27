# apps/web — guide for agents

The UI: React 19 + Vite, TypeScript, one hand-written stylesheet. No component library, no CSS
framework, no state library, no router package. Read the root [AGENTS.md](../../AGENTS.md)
first.

## Files

| File | Role |
|---|---|
| `src/main.tsx` | Mounts the app, imports fonts and `styles.css` |
| `src/App.tsx` | Shell: navigation, hash routing (`Page`), command palette (Ctrl+K), token prompt |
| `src/api.ts` | `rpc`, `useRpc`, the live-update stream, `useRoute` / `go` |
| `src/ui.tsx` | Shared pieces: `Lamp`, `Field`, `Segmented`, `Empty`, `ErrorBanner`, `Modal`, `CopyButton`, toasts, `useAction`, `useTick`, formatters |
| `src/Trace.tsx` | The "shift log": a run's trace on a time rail |
| `src/Answer.tsx` | `AnswerBox` for replying to an agent's question |
| `src/styles.css` | All styles, in labelled sections |
| `src/pages/Home.tsx` | Board (overview); also exports `ApprovalTicket`, `RunRows` |
| `src/pages/GetStarted.tsx` | The getting-started checklist on the Board (`setup.status`), sample data buttons |
| `src/pages/Work.tsx` | Work board, queue, ticket drawer, routing & intake, Jira connection |
| `src/pages/WorkViews.tsx` | Timeline, Flow (charts), Batches |
| `src/pages/AgentStudio.tsx` | New agent (from a template or blank), the studio (spec editor, test bench with an example task, triggers, revisions) |
| `src/pages/Lists.tsx` | Agents, Runs, Approvals, Activity lists |
| `src/pages/RunDetail.tsx` | One run |
| `src/pages/Notifications.tsx` | Inbox, Teams preview, channels & rules, delivery log |
| `src/pages/Secrets.tsx` | Secrets |
| `src/pages/PowerPlatform.tsx` | Power Platform: connection (reader and operator identities), environments and protection, which agents use it |
| `src/pages/Connect.tsx` | MCP connection details and the capability console |

## Data: one way in, one way out

```ts
const items = useRpc<any[]>("work.list", {}, ["work", "approval"]);   // read, kept fresh
const { busy, run } = useAction();
await run(() => rpc("work.hold", { itemId, held: true }), "Held");     // write, with a toast
```

- **`rpc(name, input)`** is the only way to talk to the server. Do not call `fetch` for app
  data. If what you need does not exist, add a capability in `packages/core` first.
- **`useRpc(name, input, topics)`** fetches and refetches when the server publishes one of
  `topics`: `run`, `run:<id>`, `approval`, `agents`, `triggers`, `audit`, `work`, `notify`.
  Pass `null` as the name to skip the call. It returns `{ data, error, loading, reload }`.
  Bursts of events collapse into one refetch.
- **`useAction()`** runs a write, shows failures as a toast, returns `undefined` on failure and
  exposes `busy` for disabling buttons. Give it a success message when the result is not
  otherwise visible.
- **`useTick(ms)`** re-renders on a timer, for relative times ("12s ago").
- Because of live updates, do not copy server data into state to "keep" it. Local state is for
  form drafts and view choices only. Forms that edit settings copy the server value once (see
  the `useEffect` that fills `form` / `conn` / `wb` in `Work.tsx`).

Types from `@foreman/core` may be imported **as types only**; most pages use `any` for
capability results.

## Routing

Hash-based. `useRoute()` returns the path segments; `go("/work/wrk_1")` navigates. `Page` in
`App.tsx` switches on the first segment. To add a page: write it in `src/pages/`, add a `case`
in `Page`, and add an entry to `NAV` if it belongs in the sidebar. The command palette picks up
navigation entries and every capability automatically.

## Rules that prevent real bugs

1. **Hooks go above every early return.** Pages return early while loading
   (`if (!spec) return …`). A `useRpc` or `useState` added below such a return crashes the page
   with React error 310 the moment data arrives. This has happened here.
2. **Effects use block bodies.** `useEffect(() => { … })`, not an arrow that returns the value
   of an expression; an accidental non-function return value breaks on unmount.
3. **Type-check with `npm run build`.** The root `npm run typecheck` does not include this
   package.
4. **The server serves `dist`.** After a change, `npm run build`, then reload port 4517. Or use
   `npm run dev` and port 5173.

## Design language

The identity is a **dispatch board**: cool slate paper, dark ink, and one loud colour —
hi-vis amber — reserved for "a person is needed". Follow it; do not introduce a second accent.

- **Tokens** are CSS custom properties at the top of `styles.css` (`--paper`, `--surface`,
  `--sunken`, `--ink`, `--ink-2`, `--ink-3`, `--line`, `--line-strong`, `--hivis`, `--go`,
  `--stop`, `--run`, `--idle`, `--review`, `--r`, `--shadow`, fonts `--display`, `--body`,
  `--mono`). Dark mode redefines them under `prefers-color-scheme: dark`. **Never write a raw
  colour in a component**; use a token so both themes work.
- **Type**: Barlow Condensed (`--display`) for headings and big numbers, IBM Plex Sans
  (`--body`) for text, IBM Plex Mono (`--mono`) for ids, keys, code and figures.
- **Signal lamps** (`<Lamp status>`, `.lamp`) are the single status vocabulary. Reuse the
  existing statuses rather than inventing coloured badges.
- **Hazard stripes** mean "waiting on a person" — approvals, questions, the Needs-you column.
  Use them for nothing else.
- **Building blocks** already styled: `.page`, `.page-head`, `.card` (+ `.card-head`,
  `.card-body`), `.list` / `.list-row`, `table.grid`, `.stats` / `.stat`, `.split`, `.stack`,
  `.row`, `.cols`, `.btn` (`primary`, `hivis`, `ghost`, `danger`, `sm`), `.input` (`code`),
  `.chip`, `.tag` (`hivis`), `.banner` (`warn`, `error`), `.hint`, `.eyebrow`, `.muted`,
  `.mono`, `.truncate`, `.grow`. Look for an existing class before writing a new one, and add
  new rules to the matching labelled section of `styles.css`.

## Writing for the people using it

- Plain words, sentence case, no jargon: "Check Jira now", "Waiting on a person", not "Sync" or
  "Blocked". Buttons say what they do.
- Every empty state says what will appear there and how to get it (`<Empty title>…`).
- Errors say what to do next. Server messages are shown as they are, so fix unclear ones at
  the capability.
- Destructive buttons use `ghost danger` and a `confirm()` that names the thing.
- Never display a secret, a full webhook address or a token. Password inputs for entering them,
  masked text for showing that one exists.

## Charts (`WorkViews.tsx`)

Hand-built with HTML and a little SVG; no chart library. Conventions already in place — keep
them for any new chart:

- One y-axis per chart; a round maximum and three ticks from `axis()`.
- Series colours are `--series-1` (blue) and `--series-2` (orange), chosen and checked for
  colour-blind separation on both surfaces. A third series needs a colour that has been checked
  the same way, not a guess.
- Status is never colour alone: failed bars are striped as well as red, and every chart with
  more than one series has a legend.
- Thin marks: 2px lines, bars at most 24px wide with a rounded top, hairline grid.
- Hover (and keyboard focus) shows a tooltip via `Tip`; the same numbers are available in a
  "Show as a table" disclosure (`TableToggle`).
- Text uses ink tokens, never a series colour.

## Accessibility basics kept so far

Real `<button>` and `<a>` elements, `aria-label` on icon-only or ambiguous controls,
`aria-pressed` on toggle chips, `role="img"` with a text label on purely visual indicators,
visible focus styles. Keep interactive things reachable by keyboard.

## Checking your work

There are no UI tests. After a change: `npm run build`, start `npm run demo`, open the page,
and look — at both a wide and a narrow window, and in the browser console for errors. The demo
produces approvals, questions, failures, batches and notifications within about half a minute,
so most states can be seen without setup. Say in your report which states you actually looked
at.
