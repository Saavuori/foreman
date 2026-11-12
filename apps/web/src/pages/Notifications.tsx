import { useEffect, useState } from "react";
import { go, rpc, useRpc } from "../api.ts";
import { Empty, ErrorBanner, Field, Lamp, relTime, Segmented, useAction, useTick } from "../ui.tsx";

type View = "inbox" | "teams" | "setup" | "log";
const SEVERITY_LAMP: Record<string, string> = { info: "running", success: "ok", warning: "pending", error: "error" };
const KIND_LABEL: Record<string, string> = { teams: "Teams", mock_teams: "Teams preview", webhook: "Webhook" };

// ── A small Adaptive Card renderer: just the elements Foreman's cards use ──
const CARD_COLOR: Record<string, string> = { Accent: "var(--run)", Good: "var(--go)", Warning: "var(--hivis-ink)", Attention: "var(--stop)" };
function AdaptiveCard({ card }: { card: any }) {
    return (
        <div className="acard">
            {(card.body ?? []).map((el: any, i: number) => {
                if (el.type === "TextBlock")
                    return (
                        <div key={i} className={`acard-text${el.weight === "Bolder" ? " bold" : ""} ${el.size === "Medium" ? "medium" : el.size === "Small" ? "small" : ""}`} style={{ color: el.color ? CARD_COLOR[el.color] : undefined }}>
                            {el.text}
                        </div>
                    );
                if (el.type === "FactSet")
                    return (
                        <dl key={i} className="acard-facts">
                            {el.facts.map((f: any) => (
                                <div key={f.title}>
                                    <dt>{f.title}</dt>
                                    <dd>{f.value}</dd>
                                </div>
                            ))}
                        </dl>
                    );
                return null;
            })}
            {card.actions?.length ? (
                <div className="acard-actions">
                    {card.actions.map((a: any) => (
                        <a key={a.title} href={a.url} target={a.url.includes("/#/") ? undefined : "_blank"} rel="noreferrer">
                            {a.title}
                        </a>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function Inbox() {
    const inbox = useRpc<any>("notify.inbox", { limit: 150 }, ["notify"]);
    const { busy, run } = useAction();
    const open = (entry: any) => {
        if (!entry.read) void rpc("notify.mark_read", { ids: [entry.id] });
        go(entry.path);
    };
    return (
        <div className="card">
            <div className="card-head">
                <h3>Inbox</h3>
                <span className="muted" style={{ fontSize: 12.5 }}>
                    {inbox.data ? `${inbox.data.unread} unread` : ""}
                </span>
                <span className="grow" />
                <button className="btn sm" disabled={busy || !inbox.data?.unread} onClick={() => run(() => rpc("notify.mark_read"), "All marked as read")}>
                    Mark all as read
                </button>
            </div>
            <div className="list">
                {inbox.data?.entries.length ? (
                    inbox.data.entries.map((entry: any) => (
                        <button key={entry.id} className={`list-row inbox-row${entry.read ? " read" : ""}`} onClick={() => open(entry)}>
                            <Lamp status={SEVERITY_LAMP[entry.severity] ?? "idle"} bare />
                            <span className="grow" style={{ minWidth: 0 }}>
                                <span className="inbox-title truncate">{entry.title}</span>
                                <span className="muted truncate" style={{ display: "block", fontSize: 12.5 }}>
                                    {entry.text}
                                </span>
                            </span>
                            <span className="mono muted">{relTime(entry.ts)}</span>
                        </button>
                    ))
                ) : inbox.loading ? null : (
                    <Empty title="Nothing yet">Approvals, failures and finished tickets are listed here as they happen.</Empty>
                )}
            </div>
        </div>
    );
}

function TeamsPreview({ channels }: { channels: any[] }) {
    const mocks = channels.filter((c) => c.kind === "mock_teams");
    const [channelId, setChannelId] = useState("");
    const messages = useRpc<any[]>("mockteams.messages", { channelId: channelId || undefined }, ["notify"]);
    const { busy, run } = useAction();
    const names = new Map(channels.map((c) => [c.id, c.name]));
    if (!mocks.length && !messages.data?.length)
        return (
            <div className="card">
                <Empty title="No Teams preview channel">
                    Add a “Teams preview” channel and a rule that sends to it. Cards then appear here exactly as Teams would receive them.
                    <br />
                    <button className="btn primary" disabled={busy} onClick={() => run(async () => rpc("notifyrules.create", { name: "Everything", channelId: (await rpc<any>("channels.create", { name: "Teams preview", kind: "mock_teams" })).id }), "Preview channel added")}>
                        Add a preview channel
                    </button>
                </Empty>
            </div>
        );
    return (
        <div className="teams">
            <header className="teams-head">
                <span className="teams-logo" aria-hidden>
                    T
                </span>
                <select className="input" style={{ width: 260 }} value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Preview channel">
                    <option value="">All preview channels</option>
                    {mocks.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name}
                        </option>
                    ))}
                </select>
                <span className="muted grow" style={{ fontSize: 12.5 }}>
                    A stand-in for Teams. These are the Adaptive Cards a real channel would receive.
                </span>
                <button className="btn sm" disabled={busy || !messages.data?.length} onClick={() => run(() => rpc("mockteams.clear", { channelId: channelId || undefined }), "Cleared")}>
                    Clear
                </button>
            </header>
            <div className="teams-feed">
                {messages.data?.length ? (
                    messages.data.map((m) => (
                        <div key={m.id} className="teams-msg">
                            <span className="teams-avatar" aria-hidden>
                                F
                            </span>
                            <div className="grow" style={{ minWidth: 0 }}>
                                <div className="teams-meta">
                                    <b>Foreman</b> <span className="muted">via Workflows · {names.get(m.channel) ?? m.channel} · {relTime(m.ts)}</span>
                                </div>
                                <AdaptiveCard card={m.payload.attachments[0].content} />
                            </div>
                        </div>
                    ))
                ) : (
                    <p className="muted" style={{ padding: 24 }}>
                        No messages yet. They arrive as soon as a matching event happens.
                    </p>
                )}
            </div>
        </div>
    );
}

function Setup({ channels, agents, settings }: { channels: any[]; agents: any[]; settings: any }) {
    const rules = useRpc<any[]>("notifyrules.list", {}, ["notify", "agents"]);
    const { busy, run } = useAction();
    const [channel, setChannel] = useState({ name: "", kind: "teams", webhookUrl: "" });
    const [rule, setRule] = useState<{ name: string; events: string[]; agentId: string; project: string; channelId: string }>({ name: "", events: [], agentId: "", project: "", channelId: "" });
    const [form, setForm] = useState<any>(null);
    useEffect(() => {
        if (settings && !form) setForm({ agingMinutes: settings.agingMinutes, digestEnabled: settings.digestEnabled, digestCron: settings.digestCron, digestTimezone: settings.digestTimezone, ratePerMinute: settings.ratePerMinute });
    }, [settings, form]);
    const kinds: { kind: string; label: string }[] = settings?.eventKinds ?? [];
    const label = (kind: string) => kinds.find((k) => k.kind === kind)?.label ?? kind;
    const toggleEvent = (kind: string) => setRule({ ...rule, events: rule.events.includes(kind) ? rule.events.filter((k) => k !== kind) : [...rule.events, kind] });

    const addChannel = async (e: React.FormEvent) => {
        e.preventDefault();
        const out = await run(() => rpc("channels.create", { name: channel.name, kind: channel.kind, webhookUrl: channel.kind === "mock_teams" ? undefined : channel.webhookUrl }), "Channel added");
        if (out) setChannel({ name: "", kind: channel.kind, webhookUrl: "" });
    };
    const addRule = async (e: React.FormEvent) => {
        e.preventDefault();
        const out = await run(() => rpc("notifyrules.create", { name: rule.name, events: rule.events, agentId: rule.agentId || null, project: rule.project.trim() || null, channelId: rule.channelId }), "Rule added");
        if (out) setRule({ ...rule, name: "", events: [] });
    };

    return (
        <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            <div className="stack">
                <div className="card">
                    <div className="card-head">
                        <h3>Channels</h3>
                        <span className="muted" style={{ fontSize: 12.5 }}>
                            Where messages can go.
                        </span>
                    </div>
                    <div className="list">
                        {channels.length ? (
                            channels.map((c) => (
                                <div key={c.id} className="list-row">
                                    <Lamp status={c.enabled ? "ok" : "idle"} bare />
                                    <div className="grow" style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                                        <div className="muted mono truncate" style={{ fontSize: 12 }}>
                                            {KIND_LABEL[c.kind]} · {c.address}
                                        </div>
                                    </div>
                                    <button className="btn sm" disabled={busy} onClick={() => run(async () => { const d = await rpc<any>("channels.test", { channelId: c.id }); if (d.status !== "sent") throw new Error(`Test not delivered: ${d.error}`); }, "Test message delivered")}>
                                        Send test
                                    </button>
                                    <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("channels.update", { channelId: c.id, enabled: !c.enabled }))}>
                                        {c.enabled ? "Turn off" : "Turn on"}
                                    </button>
                                    <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm(`Delete channel “${c.name}” and its rules?`) && run(() => rpc("channels.delete", { channelId: c.id }), "Channel deleted")}>
                                        Delete
                                    </button>
                                </div>
                            ))
                        ) : (
                            <Empty title="No channels yet">Notifications still reach the inbox. Add a channel to send them to Teams.</Empty>
                        )}
                    </div>
                    <form className="form-section" style={{ borderTop: "1px solid var(--line)" }} onSubmit={addChannel}>
                        <h3>Add a channel</h3>
                        <Segmented label="Channel kind" value={channel.kind} onChange={(kind) => setChannel({ ...channel, kind })} options={[{ value: "teams", label: "Teams" }, { value: "mock_teams", label: "Teams preview" }, { value: "webhook", label: "Webhook" }]} />
                        <Field label="Name">
                            <input className="input" value={channel.name} onChange={(e) => setChannel({ ...channel, name: e.target.value })} placeholder={channel.kind === "webhook" ? "Ops webhook" : "Payments team"} required />
                        </Field>
                        {channel.kind !== "mock_teams" ? (
                            <Field
                                label="Webhook address"
                                hint={channel.kind === "teams" ? "In Teams: channel menu → Workflows → “Send webhook alerts to a channel”, then paste the address it gives you. Treat it as a secret; Foreman shows only its last characters afterwards." : "Foreman POSTs plain JSON: event, severity, title, text, facts, links."}
                            >
                                <input className="input code" type="url" value={channel.webhookUrl} onChange={(e) => setChannel({ ...channel, webhookUrl: e.target.value })} placeholder="https://…" required />
                            </Field>
                        ) : (
                            <span className="hint">A stand-in for Teams inside Foreman. No address needed; cards show up under Teams preview.</span>
                        )}
                        <div>
                            <button className="btn primary" disabled={busy || !channel.name.trim()}>
                                Add channel
                            </button>
                        </div>
                    </form>
                </div>

                <div className="card">
                    <div className="card-head">
                        <h3>Timing</h3>
                    </div>
                    {form ? (
                        <form
                            className="card-body stack"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void run(() => rpc("notify.configure", { ...form, agingMinutes: Number(form.agingMinutes), ratePerMinute: Number(form.ratePerMinute) }), "Saved");
                            }}
                        >
                            <div className="cols" style={{ gridTemplateColumns: "1fr 1fr" }}>
                                <Field label="Flag a waiting ticket after (min)" hint="0 turns this off.">
                                    <input className="input code" type="number" min={0} value={form.agingMinutes} onChange={(e) => setForm({ ...form, agingMinutes: e.target.value })} />
                                </Field>
                                <Field label="Most messages per channel per minute" hint="Extra ones are logged as skipped.">
                                    <input className="input code" type="number" min={1} value={form.ratePerMinute} onChange={(e) => setForm({ ...form, ratePerMinute: e.target.value })} />
                                </Field>
                            </div>
                            <label className="row" style={{ gap: 8 }}>
                                <input type="checkbox" checked={form.digestEnabled} onChange={(e) => setForm({ ...form, digestEnabled: e.target.checked })} />
                                <span>Send a daily digest</span>
                            </label>
                            {form.digestEnabled ? (
                                <div className="cols" style={{ gridTemplateColumns: "1fr 1fr" }}>
                                    <Field label="When (cron)" hint="minute hour day month weekday">
                                        <input className="input code" value={form.digestCron} onChange={(e) => setForm({ ...form, digestCron: e.target.value })} />
                                    </Field>
                                    <Field label="Time zone">
                                        <input className="input code" value={form.digestTimezone} onChange={(e) => setForm({ ...form, digestTimezone: e.target.value })} />
                                    </Field>
                                </div>
                            ) : null}
                            <div className="row">
                                <button className="btn primary" disabled={busy}>
                                    Save
                                </button>
                                <button type="button" className="btn" disabled={busy} onClick={() => run(() => rpc("notify.send_digest"), "Digest sent")}>
                                    Send digest now
                                </button>
                                {settings?.nextDigestAt ? <span className="hint">Next digest {relTime(settings.nextDigestAt)}.</span> : null}
                            </div>
                        </form>
                    ) : null}
                </div>
            </div>

            <div className="card">
                <div className="card-head">
                    <h3>Rules</h3>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                        Which events go to which channel.
                    </span>
                </div>
                <div className="list">
                    {rules.data?.length ? (
                        rules.data.map((r) => (
                            <div key={r.id} className="list-row" style={{ alignItems: "flex-start" }}>
                                <div className="grow" style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600 }}>
                                        {r.name} <span className="muted" style={{ fontWeight: 400 }}>→ {r.channelName}</span>
                                    </div>
                                    <div className="row wrap" style={{ gap: 5, marginTop: 5 }}>
                                        {r.events.length ? (
                                            r.events.map((k: string) => (
                                                <span key={k} className="tag">
                                                    {label(k)}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="tag">every event</span>
                                        )}
                                        {r.agentName ? <span className="tag hivis">agent: {r.agentName}</span> : null}
                                        {r.project ? <span className="tag hivis">project: {r.project}</span> : null}
                                        {!r.enabled ? <span className="tag">off</span> : null}
                                    </div>
                                </div>
                                <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("notifyrules.update", { ruleId: r.id, enabled: !r.enabled }))}>
                                    {r.enabled ? "Turn off" : "Turn on"}
                                </button>
                                <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm(`Delete rule “${r.name}”?`) && run(() => rpc("notifyrules.delete", { ruleId: r.id }), "Rule deleted")}>
                                    Delete
                                </button>
                            </div>
                        ))
                    ) : (
                        <Empty title="No rules yet">A channel receives nothing until a rule points at it.</Empty>
                    )}
                </div>
                <form className="form-section" style={{ borderTop: "1px solid var(--line)" }} onSubmit={addRule}>
                    <h3>Add a rule</h3>
                    <div className="cols" style={{ gridTemplateColumns: "1fr 1fr" }}>
                        <Field label="Rule name">
                            <input className="input" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} placeholder="Payments approvals" required />
                        </Field>
                        <Field label="Send to">
                            <select className="input" value={rule.channelId} onChange={(e) => setRule({ ...rule, channelId: e.target.value })} required>
                                <option value="">Choose a channel…</option>
                                {channels.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                    </div>
                    <div className="field">
                        <span className="label">Events</span>
                        <div className="row wrap" style={{ gap: 6 }}>
                            {kinds.map((k) => (
                                <button key={k.kind} type="button" className="chip" style={{ fontFamily: "var(--body)" }} aria-pressed={rule.events.includes(k.kind)} onClick={() => toggleEvent(k.kind)}>
                                    {k.label}
                                </button>
                            ))}
                        </div>
                        <span className="hint">{rule.events.length ? `${rule.events.length} selected.` : "None selected means every event."}</span>
                    </div>
                    <div className="cols" style={{ gridTemplateColumns: "1fr 1fr" }}>
                        <Field label="Only for agent">
                            <select className="input" value={rule.agentId} onChange={(e) => setRule({ ...rule, agentId: e.target.value })}>
                                <option value="">Any agent</option>
                                {agents.map((a) => (
                                    <option key={a.id} value={a.id}>
                                        {a.name}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="Only for Jira project">
                            <input className="input code" value={rule.project} onChange={(e) => setRule({ ...rule, project: e.target.value })} placeholder="any" />
                        </Field>
                    </div>
                    <div>
                        <button className="btn primary" disabled={busy || !rule.name.trim() || !rule.channelId}>
                            Add rule
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

function Log() {
    const log = useRpc<any[]>("notify.log", { limit: 200 }, ["notify"]);
    const lamp: Record<string, string> = { sent: "ok", failed: "error", retrying: "pending", skipped: "idle" };
    return (
        <div className="card">
            {log.data?.length ? (
                <div className="scroll-x">
                    <table className="grid">
                        <thead>
                            <tr>
                                <th>Result</th>
                                <th>Message</th>
                                <th>Channel</th>
                                <th className="num">Tries</th>
                                <th className="num">When</th>
                            </tr>
                        </thead>
                        <tbody>
                            {log.data.map((d) => (
                                <tr key={d.id}>
                                    <td>
                                        <span className={`lamp ${lamp[d.status]}`}>{d.status[0].toUpperCase() + d.status.slice(1)}</span>
                                    </td>
                                    <td style={{ maxWidth: 520 }}>
                                        <div className="truncate">{d.title}</div>
                                        {d.error ? (
                                            <div className="truncate" style={{ fontSize: 12.5, color: d.status === "skipped" ? "var(--ink-3)" : "var(--stop)" }}>
                                                {d.error}
                                            </div>
                                        ) : null}
                                    </td>
                                    <td>{d.channelName}</td>
                                    <td className="num">{d.attempts}</td>
                                    <td className="num">{relTime(d.ts)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : log.loading ? null : (
                <Empty title="Nothing sent yet">Each attempt to deliver a message to a channel is recorded here, with the reason when it fails.</Empty>
            )}
        </div>
    );
}

export function Notifications({ view: initial }: { view?: string }) {
    useTick();
    const view = (["inbox", "teams", "setup", "log"].includes(initial ?? "") ? initial : "inbox") as View;
    const channels = useRpc<any[]>("channels.list", {}, ["notify"]);
    const agents = useRpc<any[]>("agents.list", {}, ["agents"]);
    const settings = useRpc<any>("notify.settings", {}, ["notify"]);
    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Notifications</h1>
                    <p>What Foreman tells people, and where. Everything lands in the inbox; rules decide what also goes to Teams.</p>
                </div>
                <Segmented label="View" value={view} onChange={(v) => go(`/notifications/${v}`)} options={[{ value: "inbox", label: "Inbox" }, { value: "teams", label: "Teams preview" }, { value: "setup", label: "Channels & rules" }, { value: "log", label: "Delivery log" }]} />
            </header>
            <ErrorBanner error={channels.error} />
            {view === "inbox" ? <Inbox /> : view === "teams" ? <TeamsPreview channels={channels.data ?? []} /> : view === "setup" ? <Setup channels={channels.data ?? []} agents={agents.data ?? []} settings={settings.data} /> : <Log />}
        </div>
    );
}
