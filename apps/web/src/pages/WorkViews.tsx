import { useEffect, useRef, useState } from "react";
import { go, rpc, useRpc } from "../api.ts";
import { duration, Empty, ErrorBanner, Field, pct, relTime, Segmented, useAction, useTick } from "../ui.tsx";

// ── Shared chart pieces ────────────────────────────────────────────────────

/** A round axis maximum at or above `value`, and three ticks up to it. */
function axis(value: number): { max: number; ticks: number[] } {
    const steps = [1, 2, 5];
    let unit = 1;
    for (let pow = 1; ; pow *= 10) {
        const step = steps.find((s) => s * pow * 2 >= value);
        if (step) {
            unit = step * pow;
            break;
        }
    }
    const max = Math.max(2, unit * 2);
    return { max, ticks: [0, max / 2, max] };
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const shortDay = (date: string) => new Date(date + "T12:00:00Z").toLocaleDateString([], { day: "numeric", month: "short" });

function Tip({ x, children }: { x: number; children: React.ReactNode }) {
    return (
        <div className="viz-tip" style={x > 60 ? { right: `${100 - x}%`, marginRight: 10 } : { left: `${x}%`, marginLeft: 10 }} role="status">
            {children}
        </div>
    );
}

function TableToggle({ children }: { children: React.ReactNode }) {
    return (
        <details className="viz-table">
            <summary>Show as a table</summary>
            <div className="scroll-x">{children}</div>
        </details>
    );
}

// ── Throughput: tickets done per day ───────────────────────────────────────

function Throughput({ days }: { days: { date: string; done: number; failed: number }[] }) {
    const [hover, setHover] = useState<number | null>(null);
    const { max, ticks } = axis(Math.max(...days.map((d) => d.done), 1));
    const peak = days.reduce((best, d, i) => (d.done > days[best]!.done ? i : best), 0);
    const every = Math.ceil(days.length / 7);
    const h = hover !== null ? days[hover] : null;
    return (
        <div className="viz">
            <div className="viz-plot cols" onPointerLeave={() => setHover(null)}>
                {ticks.map((t) => (
                    <div key={t} className="viz-grid" style={{ bottom: `${(t / max) * 100}%` }}>
                        <span>{t}</span>
                    </div>
                ))}
                <div className="viz-cols">
                    {days.map((d, i) => (
                        <button key={d.date} type="button" className={`viz-col${hover === i ? " on" : ""}`} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${shortDay(d.date)}: ${d.done} done, ${d.failed} failed`}>
                            {d.done ? <i style={{ height: `${(d.done / max) * 100}%` }}>{i === peak || i === days.length - 1 ? <b>{d.done}</b> : null}</i> : null}
                        </button>
                    ))}
                </div>
                {h ? (
                    <Tip x={((hover! + 0.5) / days.length) * 100}>
                        <span className="viz-tip-head">{shortDay(h.date)}</span>
                        <span>
                            <b>{h.done}</b> done
                        </span>
                        <span>
                            <b>{h.failed}</b> failed
                        </span>
                    </Tip>
                ) : null}
            </div>
            <div className="viz-x">
                {days.map((d, i) => (
                    <span key={d.date}>{(days.length - 1 - i) % every === 0 ? shortDay(d.date) : ""}</span>
                ))}
            </div>
            <TableToggle>
                <table className="grid">
                    <thead>
                        <tr>
                            <th>Day (UTC)</th>
                            <th className="num">Done</th>
                            <th className="num">Failed</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...days].reverse().map((d) => (
                            <tr key={d.date}>
                                <td>{shortDay(d.date)}</td>
                                <td className="num">{d.done}</td>
                                <td className="num">{d.failed}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </TableToggle>
        </div>
    );
}

// ── Queue depth: waiting and in progress over time ─────────────────────────

const SERIES = [
    { key: "queued", label: "Waiting in the queue", cls: "s2" },
    { key: "inProgress", label: "Being worked on", cls: "s1" },
] as const;

function QueueDepth({ points }: { points: { at: string; queued: number; inProgress: number }[] }) {
    const [hover, setHover] = useState<number | null>(null);
    const { max, ticks } = axis(Math.max(...points.map((p) => Math.max(p.queued, p.inProgress)), 1));
    const n = points.length - 1;
    const path = (key: "queued" | "inProgress") => points.map((p, i) => `${i ? "L" : "M"}${((i / n) * 100).toFixed(2)},${(100 - (p[key] / max) * 100).toFixed(2)}`).join(" ");
    const move = (e: React.PointerEvent<HTMLDivElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        setHover(Math.max(0, Math.min(n, Math.round(((e.clientX - box.left) / box.width) * n))));
    };
    const h = hover !== null ? points[hover]! : null;
    const last = points[n]!;
    return (
        <div className="viz">
            <div className="viz-legend">
                {SERIES.map((s) => (
                    <span key={s.key}>
                        <i className={`viz-key ${s.cls}`} />
                        {s.label}
                    </span>
                ))}
            </div>
            <div className="viz-plot lines" onPointerMove={move} onPointerLeave={() => setHover(null)}>
                {ticks.map((t) => (
                    <div key={t} className="viz-grid" style={{ bottom: `${(t / max) * 100}%` }}>
                        <span>{t}</span>
                    </div>
                ))}
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                    {SERIES.map((s) => (
                        <path key={s.key} className={s.cls} d={path(s.key)} />
                    ))}
                </svg>
                {SERIES.map((s) => (
                    <span key={s.key} className={`viz-end ${s.cls}`} style={{ bottom: `${(last[s.key] / max) * 100}%` }}>
                        <i />
                        <b>{last[s.key]}</b>
                    </span>
                ))}
                {h ? (
                    <>
                        <div className="viz-cross" style={{ left: `${(hover! / n) * 100}%` }} />
                        <Tip x={(hover! / n) * 100}>
                            <span className="viz-tip-head">{clock(h.at)}</span>
                            {SERIES.map((s) => (
                                <span key={s.key}>
                                    <i className={`viz-key ${s.cls}`} />
                                    <b>{h[s.key]}</b> {s.label.toLowerCase()}
                                </span>
                            ))}
                        </Tip>
                    </>
                ) : null}
            </div>
            <div className="viz-x ends">
                <span>{clock(points[0]!.at)}</span>
                <span>{clock(points[Math.round(n / 2)]!.at)}</span>
                <span>now</span>
            </div>
            <TableToggle>
                <table className="grid">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th className="num">Waiting</th>
                            <th className="num">In progress</th>
                        </tr>
                    </thead>
                    <tbody>
                        {points.filter((_, i) => (n - i) % 4 === 0).reverse().map((p) => (
                            <tr key={p.at}>
                                <td>{clock(p.at)}</td>
                                <td className="num">{p.queued}</td>
                                <td className="num">{p.inProgress}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </TableToggle>
        </div>
    );
}

// ── Flow ───────────────────────────────────────────────────────────────────

export function Flow() {
    useTick(5000);
    const [days, setDays] = useState("14");
    const [hours, setHours] = useState("24");
    const flow = useRpc<any>("work.flow", { days: Number(days), hours: Number(hours) }, ["work"]);
    const f = flow.data;
    if (!f) return <ErrorBanner error={flow.error} />;
    const perDay = f.throughput.length ? f.done / f.throughput.length : 0;
    return (
        <div className="stack">
            <div className="row">
                <Segmented label="History" value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "14", label: "14 days" }, { value: "30", label: "30 days" }]} />
                <span className="muted" style={{ fontSize: 12.5 }}>
                    {f.finished} tickets finished in this period
                </span>
            </div>
            <div className="stats">
                <div className="stat">
                    <span className="eyebrow">Done per day</span>
                    <b>{perDay >= 10 ? Math.round(perDay) : perDay.toFixed(1)}</b>
                    <small>
                        {f.done} done · {f.failed} failed
                    </small>
                </div>
                <div className="stat">
                    <span className="eyebrow">Cycle time</span>
                    <b>{duration(f.cycle.medianMs)}</b>
                    <small>{f.cycle.p90Ms != null ? `median · 9 in 10 under ${duration(f.cycle.p90Ms)}` : "queued to done"}</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">Needed a person</span>
                    <b>{pct(f.neededPersonRate)}</b>
                    <small>{f.neededPerson} stopped for an approval, question or review</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">Cost per ticket</span>
                    <b>{f.cost.perTicket ?? "—"}</b>
                    <small>{f.cost.perTicket != null ? `credits · ${f.cost.attemptsPerTicket} attempts each` : "nothing finished yet"}</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">Waiting too long</span>
                    <b>{f.ageing.count}</b>
                    <small>over {f.ageing.thresholdMinutes} min without moving</small>
                </div>
            </div>

            <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
                <div className="card">
                    <div className="card-head">
                        <h3>Tickets done per day</h3>
                    </div>
                    <div className="card-body">{f.finished ? <Throughput days={f.throughput} /> : <Empty title="Nothing finished yet">Bars appear as tickets reach Done.</Empty>}</div>
                </div>
                <div className="card">
                    <div className="card-head">
                        <h3>Queue depth</h3>
                        <span className="grow" />
                        <Segmented label="Queue depth window" value={hours} onChange={setHours} options={[{ value: "1", label: "1 h" }, { value: "24", label: "24 h" }, { value: "72", label: "3 days" }]} />
                    </div>
                    <div className="card-body">
                        <QueueDepth points={f.queueDepth} />
                        <p className="hint" style={{ marginTop: 8 }}>
                            Rebuilt from each ticket's latest timestamps, so a retried ticket is drawn as one wait and one stretch of work.
                        </p>
                    </div>
                </div>
            </div>

            <div className="card">
                <div className="card-head">
                    <h3>By agent</h3>
                </div>
                {f.perAgent.length ? (
                    <div className="scroll-x">
                        <table className="grid">
                            <thead>
                                <tr>
                                    <th>Agent</th>
                                    <th>In progress now</th>
                                    <th className="num">Queued</th>
                                    <th className="num">Done</th>
                                    <th className="num">Failed</th>
                                    <th className="num">Median cycle</th>
                                    <th className="num">First time right</th>
                                    <th className="num">Credits / ticket</th>
                                </tr>
                            </thead>
                            <tbody>
                                {f.perAgent.map((a: any) => (
                                    <tr key={a.agentId} className="link" onClick={() => go(`/agents/${a.agentId}`)}>
                                        <td style={{ fontWeight: 500 }}>{a.agentName}</td>
                                        <td>
                                            <span className="wip" title={`${a.working} working, ${a.waiting} waiting on a person, limit ${a.wipLimit}`}>
                                                <span className="wip-track" aria-hidden>
                                                    <i style={{ width: `${Math.min(1, (a.working + a.waiting) / a.wipLimit) * 100}%` }} />
                                                </span>
                                                <span className="mono">
                                                    {a.working + a.waiting} of {a.wipLimit}
                                                </span>
                                                {a.waiting ? <span className="tag hivis">{a.waiting} waiting on you</span> : null}
                                            </span>
                                        </td>
                                        <td className="num">{a.queued}</td>
                                        <td className="num">{a.done}</td>
                                        <td className="num">{a.failed}</td>
                                        <td className="num">{duration(a.medianCycleMs)}</td>
                                        <td className="num">{pct(a.firstTimeRate)}</td>
                                        <td className="num">{a.creditsPerTicket ?? "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <Empty title="No agent has taken a ticket yet" />
                )}
            </div>

            <div className="card">
                <div className="card-head">
                    <h3>Waiting too long</h3>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                        Oldest first. The threshold is set under Notifications.
                    </span>
                </div>
                {f.ageing.oldest.length ? (
                    <div className="list">
                        {f.ageing.oldest.map((t: any) => (
                            <a key={t.itemId} className="list-row" href={`#/work/${t.itemId}`}>
                                <span className="mono" style={{ fontWeight: 600 }}>
                                    {t.key}
                                </span>
                                <span className="grow truncate">{t.title}</span>
                                <span className="tag">{t.state === "needs_you" ? "needs you" : t.state}</span>
                                <span className="muted truncate" style={{ maxWidth: 160, fontSize: 12.5 }}>
                                    {t.agentName ?? "unassigned"}
                                </span>
                                <span className="mono muted">{relTime(t.waitingSince).replace(" ago", "")}</span>
                            </a>
                        ))}
                    </div>
                ) : (
                    <Empty title="Nothing is stuck" />
                )}
            </div>
        </div>
    );
}

// ── Timeline: one lane per agent ───────────────────────────────────────────

const RUN_LABEL: Record<string, string> = { running: "Running", waiting_approval: "Waiting on a person", succeeded: "Finished", failed: "Failed", cancelled: "Stopped", queued: "Queued" };

export function Timeline() {
    useTick(2000);
    const [hours, setHours] = useState("0.25");
    const data = useRpc<any>("work.timeline", { hours: Number(hours) }, ["run", "approval"]);
    const [hover, setHover] = useState<{ run: any; x: number; lane: string } | null>(null);
    const t = data.data;
    if (!t) return <ErrorBanner error={data.error} />;
    // Re-read the clock on each tick so running bars keep growing between refetches.
    const to = Math.max(Date.parse(t.to), Date.now());
    const from = to - Number(hours) * 3_600_000;
    const pos = (iso: string | null) => Math.max(0, Math.min(100, (((iso ? Date.parse(iso) : to) - from) / (to - from)) * 100));
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => ({ p, label: p === 1 ? "now" : clock(new Date(from + (to - from) * p).toISOString()) }));
    return (
        <div className="stack">
            <div className="row wrap">
                <Segmented label="Window" value={hours} onChange={setHours} options={[{ value: "0.25", label: "15 min" }, { value: "1", label: "1 h" }, { value: "6", label: "6 h" }, { value: "24", label: "24 h" }]} />
                <span className="grow" />
                <div className="viz-legend">
                    <span>
                        <i className="tl-key running" />
                        Running
                    </span>
                    <span>
                        <i className="tl-key succeeded" />
                        Finished
                    </span>
                    <span>
                        <i className="tl-key failed" />
                        Failed
                    </span>
                    <span>
                        <i className="tl-key wait" />
                        Waiting on a person
                    </span>
                </div>
            </div>
            <div className="card">
                {t.lanes.length ? (
                    <div className="tl" onPointerLeave={() => setHover(null)}>
                        <div className="tl-row axis">
                            <span />
                            <div className="tl-track">
                                {ticks.map((k) => (
                                    <span key={k.p} className="tl-tick" style={{ left: `${k.p * 100}%` }}>
                                        {k.label}
                                    </span>
                                ))}
                            </div>
                        </div>
                        {t.lanes.map((lane: any) => (
                            <div key={lane.agentId} className="tl-row">
                                <a href={`#/agents/${lane.agentId}`} className="truncate" title={lane.agentName}>
                                    {lane.agentName}
                                    <small>
                                        {lane.runs.length} run{lane.runs.length === 1 ? "" : "s"}
                                    </small>
                                </a>
                                <div className="tl-track">
                                    {ticks.slice(1, -1).map((k) => (
                                        <i key={k.p} className="tl-line" style={{ left: `${k.p * 100}%` }} />
                                    ))}
                                    {lane.runs.map((r: any) => {
                                        const left = pos(r.startedAt);
                                        const right = pos(r.finishedAt);
                                        return (
                                            <a
                                                key={r.runId}
                                                href={`#/runs/${r.runId}`}
                                                className={`tl-bar ${r.status}`}
                                                style={{ left: `${left}%`, width: `max(4px, ${right - left}%)` }}
                                                onPointerEnter={() => setHover({ run: r, x: (left + right) / 2, lane: lane.agentId })}
                                                onFocus={() => setHover({ run: r, x: (left + right) / 2, lane: lane.agentId })}
                                                onBlur={() => setHover(null)}
                                                aria-label={`${r.key ?? r.kind} — ${RUN_LABEL[r.status] ?? r.status}`}
                                            >
                                                {r.waits.map((w: any, i: number) => {
                                                    const a = pos(w.from);
                                                    const b = pos(w.to);
                                                    const span = Math.max(right - left, 0.0001);
                                                    return <i key={i} style={{ left: `${((a - left) / span) * 100}%`, width: `${((b - a) / span) * 100}%` }} />;
                                                })}
                                            </a>
                                        );
                                    })}
                                    {hover && hover.lane === lane.agentId ? (
                                        <Tip x={hover.x}>
                                            <span className="viz-tip-head">{hover.run.key ? `${hover.run.key} ${hover.run.title ?? ""}` : `Run started by ${hover.run.kind}`}</span>
                                            <span>
                                                <b>{RUN_LABEL[hover.run.status] ?? hover.run.status}</b> · {duration((hover.run.finishedAt ? Date.parse(hover.run.finishedAt) : to) - Date.parse(hover.run.startedAt))}
                                            </span>
                                            <span>
                                                {clock(hover.run.startedAt)}
                                                {hover.run.finishedAt ? ` – ${clock(hover.run.finishedAt)}` : " – still going"}
                                            </span>
                                            {hover.run.waits.length ? <span>Waited on a person {hover.run.waits.length} time{hover.run.waits.length === 1 ? "" : "s"}</span> : null}
                                        </Tip>
                                    ) : null}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <Empty title="No runs in this window">Widen the window, or wait for the next ticket.</Empty>
                )}
            </div>
            <p className="hint">Each bar is one run; click it to open its trace. Bars stacked in a lane overlap in time — that agent was working on several tickets at once.</p>
        </div>
    );
}

// ── Batches ────────────────────────────────────────────────────────────────

const PARTS = [
    { key: "done", label: "done" },
    { key: "working", label: "working" },
    { key: "waiting", label: "waiting on a person" },
    { key: "failed", label: "failed" },
    { key: "queued", label: "queued" },
    { key: "skipped", label: "skipped" },
] as const;

function BatchCard({ batch, open, onBoard }: { batch: any; open: boolean; onBoard: () => void }) {
    const { busy, run } = useAction();
    const detail = useRpc<any>(open ? "batches.get" : null, { batchId: batch.id }, ["work"]);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (open) ref.current?.scrollIntoView({ block: "nearest" });
    }, [open]);
    const p = batch.progress;
    const finished = p.done + p.failed + p.skipped;
    return (
        <div className="card" ref={ref}>
            <div className="card-head">
                <h3>{batch.name}</h3>
                <span className={`tag${batch.state === "complete" ? "" : " hivis"}`}>{batch.state === "complete" ? `finished ${relTime(batch.completedAt)}` : "in progress"}</span>
                <span className="grow" />
                <span className="mono muted" style={{ fontSize: 12.5 }}>
                    {finished} of {p.total}
                </span>
            </div>
            <div className="card-body stack">
                <div className="bprog" role="img" aria-label={PARTS.filter((x) => p[x.key]).map((x) => `${p[x.key]} ${x.label}`).join(", ")}>
                    {PARTS.filter((x) => p[x.key]).map((x) => (
                        <i key={x.key} className={x.key} style={{ flexGrow: p[x.key] }} />
                    ))}
                </div>
                <div className="viz-legend">
                    {PARTS.filter((x) => p[x.key]).map((x) => (
                        <span key={x.key}>
                            <i className={`bkey ${x.key}`} />
                            <b>{p[x.key]}</b> {x.label}
                        </span>
                    ))}
                </div>
                <div className="row wrap muted" style={{ gap: 14, fontSize: 12.5 }}>
                    <span>
                        {p.credits} credits · {p.attempts} attempts
                    </span>
                    <span>started {relTime(batch.createdAt)}</span>
                    {batch.state !== "complete" ? <span>{p.estimatedFinishAt ? `at this pace, done around ${clock(p.estimatedFinishAt)}${p.waiting ? " if the waiting tickets are answered" : ""}` : "no estimate until two tickets have finished since it started"}</span> : null}
                    {batch.agentName ? <span>unrouted tickets go to {batch.agentName}</span> : null}
                </div>
                {batch.jql ? <code className="mono bjql">{batch.jql}</code> : null}
                <div className="row wrap" style={{ gap: 6 }}>
                    <button className="btn sm" onClick={onBoard}>
                        Show on the board
                    </button>
                    <button className="btn sm" onClick={() => go(open ? "/work/batch" : `/work/batch/${batch.id}`)}>
                        {open ? "Hide tickets" : "List tickets"}
                    </button>
                    {batch.jql ? (
                        <button className="btn sm" disabled={busy} onClick={() => run(async () => rpc<any>("batches.refresh", { batchId: batch.id })).then((r) => r && run(async () => r, r.ticketsAdded ? `${r.ticketsAdded} new ticket${r.ticketsAdded === 1 ? "" : "s"} added` : "No new tickets match"))}>
                            Check for new tickets
                        </button>
                    ) : null}
                    {p.failed ? (
                        <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("batches.retry_failed", { batchId: batch.id }), "Failed tickets queued again")}>
                            Retry {p.failed} failed
                        </button>
                    ) : null}
                    <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm(`Stop tracking “${batch.name}”? Its tickets stay on the board.`) && run(() => rpc("batches.delete", { batchId: batch.id }), "Batch deleted")}>
                        Delete
                    </button>
                </div>
            </div>
            {open && detail.data ? (
                <div className="list" style={{ borderTop: "1px solid var(--line)", maxHeight: 420, overflowY: "auto" }}>
                    {detail.data.items.map((i: any) => (
                        <a key={i.id} className="list-row" href={`#/work/${i.id}`} style={{ padding: "7px 14px" }}>
                            <span className="mono" style={{ fontWeight: 600, minWidth: 76 }}>
                                {i.key}
                            </span>
                            <span className="grow truncate">{i.title}</span>
                            <span className="muted truncate" style={{ maxWidth: 150, fontSize: 12.5 }}>
                                {i.agentName ?? "unassigned"}
                            </span>
                            <span className="tag">{i.state === "needs_you" ? "needs you" : i.state}</span>
                        </a>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function Batches({ batches, agents, openId, onBoard }: { batches: any[] | undefined; agents: any[]; openId?: string; onBoard: (batchId: string) => void }) {
    const { busy, run } = useAction();
    const [name, setName] = useState("");
    const [jql, setJql] = useState("");
    const [keys, setKeys] = useState("");
    const [agentId, setAgentId] = useState("");
    const create = async (e: React.FormEvent) => {
        e.preventDefault();
        const list = keys.split(/[\s,;]+/).filter(Boolean);
        const out = await run(() => rpc<any>("batches.create", { name: name.trim(), ...(jql.trim() ? { jql: jql.trim() } : {}), ...(list.length ? { keys: list } : {}), ...(agentId ? { agentId } : {}) }));
        if (!out) return;
        await run(async () => out, `Batch created with ${out.ticketsAdded} ticket${out.ticketsAdded === 1 ? "" : "s"}${out.notFound.length ? `; not found: ${out.notFound.join(", ")}` : ""}`);
        setName("");
        setJql("");
        setKeys("");
    };
    return (
        <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
            <div className="stack">
                {batches?.length ? (
                    batches.map((b) => <BatchCard key={b.id} batch={b} open={b.id === openId} onBoard={() => onBoard(b.id)} />)
                ) : (
                    <div className="card">
                        <Empty title="No batches">A batch tracks a set of tickets as one job — a sprint, an epic, or any Jira filter — and tells you once when all of them have finished.</Empty>
                    </div>
                )}
            </div>
            <form className="card" onSubmit={create} style={{ alignSelf: "start" }}>
                <div className="card-head">
                    <h3>New batch</h3>
                </div>
                <div className="card-body stack">
                    <Field label="Name">
                        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sprint 42 bugs" required maxLength={80} />
                    </Field>
                    <Field label="Tickets matching" hint="JQL. A sprint or an epic is a filter too, e.g. sprint = 42.">
                        <textarea className="input code" rows={2} value={jql} onChange={(e) => setJql(e.target.value)} placeholder="project = PAY AND type = Bug" />
                    </Field>
                    <Field label="And these tickets" hint="Keys, separated by spaces or commas. Optional if a filter is given.">
                        <input className="input code" value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="PAY-181, WEB-190" />
                    </Field>
                    <Field label="Tickets no rule claims go to" hint="Routing rules still apply first.">
                        <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                            <option value="">The inbox</option>
                            {agents.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.name}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <div>
                        <button className="btn primary" disabled={busy || !name.trim() || (!jql.trim() && !keys.trim())}>
                            Create batch
                        </button>
                    </div>
                    <span className="hint">The tickets are put on the board straight away, whether or not the intake filter would take them.</span>
                </div>
            </form>
        </div>
    );
}
