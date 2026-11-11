import { useEffect, useMemo, useState } from "react";
import { go, rpc, useRpc } from "../api.ts";
import { Trace } from "../Trace.tsx";
import { duration, Empty, ErrorBanner, Field, Lamp, Modal, pct, relTime, runDuration, Segmented, useAction, useTick } from "../ui.tsx";

type View = "board" | "queue" | "setup";
const COLUMNS: { state: string; title: string; hint: string }[] = [
    { state: "inbox", title: "Inbox", hint: "No rule matched. Assign an agent." },
    { state: "queued", title: "Queued", hint: "Waiting for a free slot." },
    { state: "working", title: "Working", hint: "An agent is on it." },
    { state: "needs_you", title: "Needs you", hint: "Waiting for a decision." },
    { state: "review", title: "Review", hint: "Finished — check and accept." },
    { state: "done", title: "Done", hint: "Last 24 hours." },
    { state: "failed", title: "Failed", hint: "Stopped. Retry or reassign." },
];
const LAMP: Record<string, string> = { inbox: "idle", queued: "queued", working: "running", needs_you: "waiting_approval", review: "review", done: "succeeded", failed: "failed", skipped: "idle" };
export const WORK_LABEL: Record<string, string> = { inbox: "Inbox", queued: "Queued", working: "Working", needs_you: "Needs you", review: "Review", done: "Done", failed: "Failed", skipped: "Skipped" };
const PRIORITY_MARK: Record<string, string> = { highest: "▲▲", high: "▲", medium: "", low: "▽", lowest: "▽▽" };

function WorkLamp({ state, bare }: { state: string; bare?: boolean }) {
    return (
        <span className={`lamp ${LAMP[state] ?? "idle"}${bare ? " bare" : ""}`} title={WORK_LABEL[state]} role="img" aria-label={WORK_LABEL[state]}>
            {bare ? null : WORK_LABEL[state]}
        </span>
    );
}

const since = (item: any) => (item.state === "queued" || item.state === "inbox" ? (item.queuedAt ?? item.receivedAt) : item.state === "working" || item.state === "needs_you" ? item.startedAt : item.finishedAt) as string | null;

function Card({ item, onOpen }: { item: any; onOpen: () => void }) {
    const { busy, run } = useAction();
    const decide = (decision: "approve" | "deny") => run(() => rpc("approvals.decide", { approvalId: item.pendingApproval.id, decision }), decision === "approve" ? "Approved" : "Denied");
    const mark = PRIORITY_MARK[item.ticket.priority.toLowerCase()] ?? "";
    return (
        <article className={`wcard ${item.state}${item.held ? " held" : ""}`}>
            <button className="wcard-main" onClick={onOpen} aria-label={`${item.ticket.key} ${item.ticket.title}`}>
                <span className="wcard-top">
                    <span className="mono wcard-key">{item.ticket.key}</span>
                    {mark ? (
                        <span className="wcard-pri" title={`Priority ${item.ticket.priority}`}>
                            {mark}
                        </span>
                    ) : null}
                    {item.held ? <span className="tag">held</span> : null}
                    {item.attempts > 1 ? <span className="tag">attempt {item.attempts}</span> : null}
                    <span className="wcard-age mono">{relTime(since(item)).replace(" ago", "")}</span>
                </span>
                <span className="wcard-title">{item.ticket.title}</span>
                <span className="wcard-foot">
                    <WorkLamp state={item.state} bare />
                    <span className="truncate">{item.agentName ?? "Unassigned"}</span>
                </span>
                {item.progress ? (
                    <span className="wcard-progress">
                        <span className="bar-track" aria-hidden>
                            <i style={{ width: `${(item.progress.step / item.progress.total) * 100}%` }} />
                        </span>
                        <span className="truncate">
                            {item.progress.step}/{item.progress.total} · {item.progress.message}
                        </span>
                    </span>
                ) : null}
                {item.note && item.state !== "needs_you" ? <span className="wcard-note">{item.note}</span> : null}
            </button>
            {item.pendingApproval ? (
                <div className="wcard-ask">
                    <span className="mono">{item.pendingApproval.summary}</span>
                    <div className="row" style={{ gap: 6 }}>
                        <button className="btn sm hivis" disabled={busy} onClick={() => decide("approve")}>
                            Approve
                        </button>
                        <button className="btn sm" disabled={busy} onClick={() => decide("deny")}>
                            Deny
                        </button>
                    </div>
                </div>
            ) : null}
        </article>
    );
}

function Drawer({ itemId, agents, onClose }: { itemId: string; agents: any[]; onClose: () => void }) {
    const detail = useRpc<any>("work.get", { itemId }, ["work", "run", "approval"]);
    const item = detail.data?.item;
    const timeline = useRpc<any>(item?.runId ? "runs.timeline" : null, { runId: item?.runId }, item?.runId ? [`run:${item.runId}`] : []);
    const [agentId, setAgentId] = useState("");
    const { busy, run } = useAction();
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, [onClose]);
    useEffect(() => {
        if (item) setAgentId(item.agentId ?? "");
    }, [item?.id, item?.agentId]);

    const act = (name: string, input: Record<string, unknown>, message: string) => run(() => rpc(name, { itemId: item.id, ...input }), message);
    const active = item && (item.state === "working" || item.state === "needs_you");
    return (
        <aside className="drawer" aria-label="Work item">
            {!item ? (
                <div className="drawer-body">{detail.error ? <ErrorBanner error={detail.error} /> : null}</div>
            ) : (
                <>
                    <header className="drawer-head">
                        <div className="grow">
                            <div className="row" style={{ gap: 8 }}>
                                <a className="mono" href={item.ticket.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, textDecoration: "underline" }}>
                                    {item.ticket.key}
                                </a>
                                <WorkLamp state={item.state} />
                                {item.held ? <span className="tag">held</span> : null}
                            </div>
                            <h2>{item.ticket.title}</h2>
                        </div>
                        <button className="btn ghost sm" onClick={onClose} aria-label="Close">
                            Close
                        </button>
                    </header>
                    <div className="drawer-body">
                        <div className="row wrap" style={{ gap: 6 }}>
                            <span className="tag">{item.ticket.type}</span>
                            <span className="tag">{item.ticket.priority}</span>
                            <span className="tag">Jira: {item.ticket.status}</span>
                            {item.ticket.labels.map((l: string) => (
                                <span key={l} className={`tag${l.startsWith("mock:") ? " hivis" : ""}`}>
                                    {l}
                                </span>
                            ))}
                        </div>
                        {item.note ? <div className={`banner ${item.state === "failed" ? "error" : item.state === "needs_you" ? "warn" : ""}`}>{item.note}</div> : null}
                        {item.ticket.description ? <p className="drawer-desc">{item.ticket.description}</p> : null}

                        <div className="drawer-actions">
                            <div className="row" style={{ gap: 6 }}>
                                <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent" disabled={active}>
                                    <option value="">Choose an agent…</option>
                                    {agents.map((a) => (
                                        <option key={a.id} value={a.id}>
                                            {a.name}
                                        </option>
                                    ))}
                                </select>
                                <button className="btn" disabled={busy || !agentId || active || (agentId === item.agentId && item.state === "queued")} onClick={() => run(() => rpc("work.assign", { itemId: item.id, agentId }), "Assigned and queued")}>
                                    {item.agentId && agentId === item.agentId ? "Queue" : "Assign"}
                                </button>
                            </div>
                            <div className="row wrap" style={{ gap: 6 }}>
                                {item.state === "review" || item.state === "failed" ? (
                                    <button className="btn primary sm" disabled={busy} onClick={() => act("work.complete", {}, "Marked as done")}>
                                        {item.state === "review" ? "Accept as done" : "Mark as done"}
                                    </button>
                                ) : null}
                                {item.agentId && item.state !== "queued" ? (
                                    <button className="btn sm" disabled={busy} onClick={() => act("work.retry", {}, active ? "Stopped and queued again" : "Queued again")}>
                                        {active ? "Stop and retry" : "Retry"}
                                    </button>
                                ) : null}
                                {item.state === "queued" ? (
                                    <>
                                        <button className="btn sm" disabled={busy} onClick={() => act("work.rank", { position: "top" }, "Moved to the top")}>
                                            Move to top
                                        </button>
                                        <button className="btn sm" disabled={busy} onClick={() => act("work.hold", { held: !item.held }, item.held ? "Released" : "Held")}>
                                            {item.held ? "Release" : "Hold"}
                                        </button>
                                    </>
                                ) : null}
                                {item.state !== "skipped" && item.state !== "done" ? (
                                    <button className="btn sm ghost danger" disabled={busy} onClick={() => act("work.skip", {}, "Skipped")}>
                                        Skip
                                    </button>
                                ) : null}
                            </div>
                        </div>

                        <h3 className="drawer-title">Attempts</h3>
                        {detail.data.attempts.length ? (
                            <div className="card list">
                                {detail.data.attempts.map((attempt: any, i: number) => (
                                    <a key={attempt.id} className="list-row" href={`#/runs/${attempt.id}`} style={{ padding: "8px 12px" }}>
                                        <Lamp status={attempt.status} />
                                        <span className="grow muted truncate" style={{ fontSize: 12.5 }}>
                                            #{detail.data.attempts.length - i} · r{attempt.revisionNumber} · {attempt.usage.credits} credits
                                        </span>
                                        <span className="mono muted">{runDuration(attempt)}</span>
                                    </a>
                                ))}
                            </div>
                        ) : (
                            <p className="muted">Not attempted yet.</p>
                        )}

                        {item.runId && timeline.data ? (
                            <>
                                <h3 className="drawer-title">{active ? "Happening now" : "Last attempt"}</h3>
                                <Trace steps={timeline.data.steps} compact />
                            </>
                        ) : null}
                        {detail.data.rule ? <p className="hint">Routed by “{detail.data.rule.name}”.</p> : item.agentId ? <p className="hint">Assigned by hand.</p> : null}
                    </div>
                </>
            )}
        </aside>
    );
}

function AddTickets({ onClose }: { onClose: () => void }) {
    const [keys, setKeys] = useState("");
    const [result, setResult] = useState<any>(null);
    const { busy, run } = useAction();
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const list = keys.split(/[\s,;]+/).filter(Boolean);
        const out = await run(() => rpc<any>("work.add", { keys: list }));
        if (!out) return;
        if (!out.notFound.length && !out.alreadyOnBoard.length) return onClose();
        setResult(out);
    };
    return (
        <Modal onClose={onClose}>
            <form className="dialog" onSubmit={submit}>
                <h2>Add tickets</h2>
                <div className="stack">
                    <Field label="Jira keys" hint="Separate with spaces or commas. Tickets are added even if the intake filter would not pick them up.">
                        <input className="input code" value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="PAY-181, WEB-190" autoFocus />
                    </Field>
                    {result ? (
                        <div className="banner">
                            <div>
                                {result.added.length ? <div>Added {result.added.map((i: any) => i.ticket.key).join(", ")}.</div> : null}
                                {result.alreadyOnBoard.length ? <div>Already on the board: {result.alreadyOnBoard.join(", ")}.</div> : null}
                                {result.notFound.length ? <div>Not found in Jira: {result.notFound.join(", ")}.</div> : null}
                            </div>
                        </div>
                    ) : null}
                    <div className="row">
                        <button className="btn primary" disabled={busy || !keys.trim()}>
                            Add to board
                        </button>
                        <button type="button" className="btn ghost" onClick={onClose}>
                            {result ? "Close" : "Cancel"}
                        </button>
                    </div>
                </div>
            </form>
        </Modal>
    );
}

function Setup({ agents, jira }: { agents: any[]; jira: any }) {
    const rules = useRpc<any[]>("routing.list", {}, ["work", "agents"]);
    const { busy, run } = useAction();
    const [name, setName] = useState("");
    const [match, setMatch] = useState({ project: "", type: "", label: "", priority: "" });
    const [agentId, setAgentId] = useState("");
    const [review, setReview] = useState(false);
    const [form, setForm] = useState<any>(null);
    const [summary, setSummary] = useState("");
    const [labels, setLabels] = useState("foreman");
    useEffect(() => {
        if (jira && !form) setForm({ baseUrl: jira.usingMock ? "" : jira.baseUrl, jql: jira.jql, pollSeconds: jira.pollSeconds, wipPerAgent: jira.wipPerAgent, maxAttempts: jira.maxAttempts });
    }, [jira, form]);

    const addRule = async (e: React.FormEvent) => {
        e.preventDefault();
        const clean = Object.fromEntries(Object.entries(match).filter(([, v]) => v.trim()));
        const out = await run(() => rpc<any>("routing.create", { name, match: clean, agentId, review }));
        if (out) (setName(""), setMatch({ project: "", type: "", label: "", priority: "" }));
    };
    const describe = (m: any) => Object.entries(m).filter(([, v]) => v);

    return (
        <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) 400px" }}>
            <div className="stack">
                <div className="card">
                    <div className="card-head">
                        <h3>Routing rules</h3>
                        <span className="muted" style={{ fontSize: 12.5 }}>
                            Tried top to bottom. The first match wins; no match means the inbox.
                        </span>
                    </div>
                    <div className="list">
                        {rules.data?.length ? (
                            rules.data.map((r, i) => (
                                <div key={r.id} className="list-row">
                                    <span className="mono muted">{i + 1}</span>
                                    <div className="grow">
                                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                                        <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                                            {describe(r.match).length ? (
                                                describe(r.match).map(([k, v]) => (
                                                    <span key={k} className="tag">
                                                        {k} = {String(v)}
                                                    </span>
                                                ))
                                            ) : (
                                                <span className="tag">every ticket</span>
                                            )}
                                            <span className="muted">→</span>
                                            <a href={`#/agents/${r.agentId}`} style={{ fontWeight: 500 }}>
                                                {r.agentName}
                                            </a>
                                            {r.review ? <span className="tag hivis">review before done</span> : null}
                                            {!r.enabled ? <span className="tag">off</span> : null}
                                        </div>
                                    </div>
                                    <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("routing.update", { ruleId: r.id, enabled: !r.enabled }))}>
                                        {r.enabled ? "Turn off" : "Turn on"}
                                    </button>
                                    <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm(`Delete rule “${r.name}”?`) && run(() => rpc("routing.delete", { ruleId: r.id }), "Rule deleted")}>
                                        Delete
                                    </button>
                                </div>
                            ))
                        ) : (
                            <Empty title="No rules yet">Without a rule every ticket waits in the inbox for you to assign it.</Empty>
                        )}
                    </div>
                    <form className="form-section" style={{ borderTop: "1px solid var(--line)" }} onSubmit={addRule}>
                        <h3>Add a rule</h3>
                        <div className="cols" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
                            <Field label="Rule name">
                                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Payment bugs" required />
                            </Field>
                            {(["project", "type", "label", "priority"] as const).map((k) => (
                                <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}>
                                    <input className="input code" value={match[k]} onChange={(e) => setMatch({ ...match, [k]: e.target.value })} placeholder="any" />
                                </Field>
                            ))}
                            <Field label="Goes to">
                                <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} required>
                                    <option value="">Choose an agent…</option>
                                    {agents.map((a) => (
                                        <option key={a.id} value={a.id}>
                                            {a.name}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                        </div>
                        <label className="row" style={{ gap: 8 }}>
                            <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
                            <span>Stop finished tickets in Review for a person to accept</span>
                        </label>
                        <div>
                            <button className="btn primary" disabled={busy || !name.trim() || !agentId}>
                                Add rule
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            <div className="stack">
                <div className="card">
                    <div className="card-head">
                        <h3>Jira intake</h3>
                        <span className="grow" />
                        {jira ? <Lamp status={jira.enabled ? (jira.lastPoll && !jira.lastPoll.ok ? "error" : "ok") : "idle"} bare /> : null}
                    </div>
                    {form && jira ? (
                        <form
                            className="card-body stack"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void run(() => rpc("jira.configure", { ...form, pollSeconds: Number(form.pollSeconds), wipPerAgent: Number(form.wipPerAgent), maxAttempts: Number(form.maxAttempts) }), "Intake settings saved");
                            }}
                        >
                            <Field label="Jira site" hint={jira.usingMock ? "Empty means the built-in mock Jira. Real sites need credentials, which arrive with the secrets vault." : undefined}>
                                <input className="input code" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="Built-in mock Jira" />
                            </Field>
                            <Field label="Take tickets matching" hint="JQL. Keep it an explicit opt-in, such as a label or a bot assignee.">
                                <textarea className="input code" rows={2} value={form.jql} onChange={(e) => setForm({ ...form, jql: e.target.value })} />
                            </Field>
                            <div className="cols" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
                                <Field label="Check every (s)">
                                    <input className="input code" type="number" min={2} value={form.pollSeconds} onChange={(e) => setForm({ ...form, pollSeconds: e.target.value })} />
                                </Field>
                                <Field label="At once per agent">
                                    <input className="input code" type="number" min={1} value={form.wipPerAgent} onChange={(e) => setForm({ ...form, wipPerAgent: e.target.value })} />
                                </Field>
                                <Field label="Max attempts">
                                    <input className="input code" type="number" min={1} value={form.maxAttempts} onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })} />
                                </Field>
                            </div>
                            <div className="row">
                                <button className="btn primary" disabled={busy}>
                                    Save
                                </button>
                                <button type="button" className={`btn ${jira.enabled ? "" : "hivis"}`} disabled={busy} onClick={() => run(() => rpc("jira.configure", { enabled: !jira.enabled }), jira.enabled ? "Intake paused" : "Intake on")}>
                                    {jira.enabled ? "Pause intake" : "Turn intake on"}
                                </button>
                            </div>
                            <span className="hint">{jira.lastPoll ? `Last check ${relTime(jira.lastPoll.at)}: ${jira.lastPoll.detail}` : "Not checked yet."}</span>
                        </form>
                    ) : null}
                </div>

                {jira?.usingMock ? (
                    <div className="card">
                        <div className="card-head">
                            <h3>Mock Jira</h3>
                            <span className="muted" style={{ fontSize: 12.5 }}>
                                {jira.mock.issues} tickets
                            </span>
                        </div>
                        <form
                            className="card-body stack"
                            onSubmit={async (e) => {
                                e.preventDefault();
                                const out = await run(() => rpc<any>("mockjira.create_issue", { summary: summary.trim() || undefined, labels: labels.split(/[\s,]+/).filter(Boolean) }));
                                if (out) (setSummary(""), void run(() => rpc("work.sync"), `Filed ${out.key}`));
                            }}
                        >
                            <Field label="File a ticket" hint="Leave the title empty for a generated one.">
                                <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Checkout fails for carts over 99 items" />
                            </Field>
                            <Field label="Labels" hint="Add mock:needs-approval, mock:flaky, mock:slow, mock:tool-failure or mock:sub-agents to choose how the mock agent behaves.">
                                <input className="input code" value={labels} onChange={(e) => setLabels(e.target.value)} />
                            </Field>
                            <div>
                                <button className="btn" disabled={busy}>
                                    File ticket
                                </button>
                            </div>
                            <div className="field">
                                <span className="label">New tickets on their own</span>
                                <Segmented label="Ticket generator rate" value={String(jira.mock.generatorPerMinute)} onChange={(v) => void run(() => rpc("mockjira.generator", { perMinute: Number(v) }))} options={[{ value: "0", label: "Off" }, { value: "2", label: "2 / min" }, { value: "5", label: "5 / min" }, { value: "12", label: "12 / min" }]} />
                            </div>
                        </form>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function Work({ itemId }: { itemId?: string }) {
    useTick(3000);
    const [view, setView] = useState<View>("board");
    const [agentFilter, setAgentFilter] = useState("");
    const [projectFilter, setProjectFilter] = useState("");
    const [adding, setAdding] = useState(false);
    const items = useRpc<any[]>("work.list", {}, ["work", "approval"]);
    const stats = useRpc<any>("work.stats", {}, ["work"]);
    const jira = useRpc<any>("jira.settings", {}, ["work"]);
    const agents = useRpc<any[]>("agents.list", {}, ["agents"]);
    const { busy, run } = useAction();

    const all = items.data ?? [];
    const projects = useMemo(() => [...new Set(all.map((i) => i.ticket.project))].sort(), [all]);
    const shown = all.filter((i) => (!agentFilter || i.agentId === agentFilter) && (!projectFilter || i.ticket.project === projectFilter));
    const queue = shown.filter((i) => i.state === "queued" || i.state === "inbox");
    const s = stats.data;
    const open = (id: string) => go(`/work/${id}`);

    return (
        <div className={`page work-page${itemId ? " with-drawer" : ""}`}>
            <header className="page-head">
                <div className="grow">
                    <h1>Work</h1>
                    <p>Tickets taken from Jira, from arrival to done. Each card is a ticket; each attempt at it is a run.</p>
                </div>
                <Segmented label="View" value={view} onChange={setView} options={[{ value: "board", label: "Board" }, { value: "queue", label: "Queue" }, { value: "setup", label: "Routing & intake" }]} />
                <button className="btn" disabled={busy} onClick={() => run(() => rpc("work.sync"), "Checked Jira")}>
                    Check Jira now
                </button>
                <button className="btn primary" onClick={() => setAdding(true)}>
                    Add tickets
                </button>
            </header>
            <ErrorBanner error={items.error} />
            {jira.data && !jira.data.enabled ? (
                <div className="banner warn" style={{ marginBottom: 16 }}>
                    <div className="grow">
                        <b>Intake is off.</b> Foreman is not checking Jira{jira.data.usingMock ? " (the built-in mock)" : ""} for new tickets. You can still add tickets by key.
                    </div>
                    <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("jira.configure", { enabled: true }), "Intake on")}>
                        Turn intake on
                    </button>
                </div>
            ) : jira.data?.lastPoll && !jira.data.lastPoll.ok ? (
                <div className="banner error" style={{ marginBottom: 16 }}>
                    <div className="grow">
                        <b>Jira check failed.</b> {jira.data.lastPoll.detail}
                    </div>
                </div>
            ) : null}

            <div className="stats">
                <div className="stat">
                    <span className="eyebrow">In queue</span>
                    <b>{s ? s.byState.queued : "—"}</b>
                    <small>{s ? (s.oldestQueuedAt ? `oldest ${relTime(s.oldestQueuedAt)}` : "nothing waiting") + (s.held ? ` · ${s.held} held` : "") : " "}</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">In progress</span>
                    <b>{s ? s.byState.working + s.byState.needs_you : "—"}</b>
                    <small>{s ? `${s.byState.needs_you} waiting on you` : " "}</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">Done · 24h</span>
                    <b>{s ? s.doneLast24h : "—"}</b>
                    <small>{s ? `${s.byState.review} in review · ${s.byState.failed} failed` : " "}</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">Cycle time</span>
                    <b>{s ? duration(s.medianCycleMs) : "—"}</b>
                    <small>{s?.p90CycleMs != null ? `median · 9 in 10 under ${duration(s.p90CycleMs)}` : "queued to done"}</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">First time right</span>
                    <b>{s ? pct(s.firstTimeRate) : "—"}</b>
                    <small>finished on attempt one</small>
                </div>
            </div>

            {view !== "setup" ? (
                <div className="row" style={{ margin: "16px 0 12px" }}>
                    <select className="input" style={{ width: 200 }} value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} aria-label="Filter by agent">
                        <option value="">All agents</option>
                        {(agents.data ?? []).map((a) => (
                            <option key={a.id} value={a.id}>
                                {a.name}
                            </option>
                        ))}
                    </select>
                    <select className="input" style={{ width: 160 }} value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="Filter by project">
                        <option value="">All projects</option>
                        {projects.map((p) => (
                            <option key={p} value={p}>
                                {p}
                            </option>
                        ))}
                    </select>
                    <span className="grow" />
                    <span className="muted" style={{ fontSize: 12.5 }}>
                        {jira.data ? `${jira.data.usingMock ? "Mock Jira" : "Jira"} · ${jira.data.enabled ? `checked every ${jira.data.pollSeconds}s` : "intake off"}${jira.data.lastPoll ? ` · last ${relTime(jira.data.lastPoll.at)}` : ""}` : ""}
                    </span>
                </div>
            ) : (
                <div style={{ height: 16 }} />
            )}

            {view === "board" ? (
                <div className="board" role="list">
                    {COLUMNS.map((col) => {
                        const cards = shown.filter((i) => i.state === col.state);
                        if (col.state === "done") cards.sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
                        return (
                            <section key={col.state} className={`col ${col.state}`} role="listitem" aria-label={col.title}>
                                <header>
                                    <h3>{col.title}</h3>
                                    <span className="mono">{cards.length}</span>
                                </header>
                                <div className="col-body">
                                    {cards.length ? cards.slice(0, 40).map((item) => <Card key={item.id} item={item} onOpen={() => open(item.id)} />) : <p className="col-empty">{col.hint}</p>}
                                    {cards.length > 40 ? <p className="col-empty">+{cards.length - 40} more</p> : null}
                                </div>
                            </section>
                        );
                    })}
                </div>
            ) : view === "queue" ? (
                <div className="card">
                    {queue.length ? (
                        <div className="scroll-x">
                            <table className="grid">
                                <thead>
                                    <tr>
                                        <th className="num">#</th>
                                        <th>Ticket</th>
                                        <th>Priority</th>
                                        <th>Agent</th>
                                        <th className="num">Waiting</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {queue.map((item, i) => (
                                        <tr key={item.id} className="link" onClick={() => open(item.id)}>
                                            <td className="num">{i + 1}</td>
                                            <td style={{ maxWidth: 460 }}>
                                                <div className="truncate">
                                                    <span className="mono" style={{ fontWeight: 600, marginRight: 8 }}>
                                                        {item.ticket.key}
                                                    </span>
                                                    {item.ticket.title}
                                                </div>
                                            </td>
                                            <td>{item.ticket.priority}</td>
                                            <td>{item.agentName ?? <span className="tag hivis">inbox — unassigned</span>}</td>
                                            <td className="num">{relTime(item.queuedAt ?? item.receivedAt).replace(" ago", "")}</td>
                                            <td onClick={(e) => e.stopPropagation()}>
                                                <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                                                    {item.held ? <span className="tag">held</span> : null}
                                                    <button className="btn sm" disabled={busy || i === 0} onClick={() => run(() => rpc("work.rank", { itemId: item.id, position: "top" }))}>
                                                        To top
                                                    </button>
                                                    {item.state === "queued" ? (
                                                        <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("work.hold", { itemId: item.id, held: !item.held }))}>
                                                            {item.held ? "Release" : "Hold"}
                                                        </button>
                                                    ) : null}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <Empty title="The queue is empty">New tickets appear here in the order they will be worked on.</Empty>
                    )}
                </div>
            ) : (
                <Setup agents={agents.data ?? []} jira={jira.data} />
            )}

            {itemId ? <Drawer key={itemId} itemId={itemId} agents={agents.data ?? []} onClose={() => go("/work")} /> : null}
            {adding ? <AddTickets onClose={() => setAdding(false)} /> : null}
        </div>
    );
}
