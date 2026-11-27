import { useState } from "react";
import { go, useRpc } from "../api.ts";
import { Empty, ErrorBanner, Lamp, pct, relTime, Segmented, useTick } from "../ui.tsx";
import { ApprovalTicket, RunRows } from "./Home.tsx";

const AUTONOMY_LABEL: Record<string, string> = { observe: "Observe", propose: "Propose", act: "Act", full: "Full" };

export function Agents() {
    const agents = useRpc<any[]>("agents.list", {}, ["agents", "run"]);
    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Agents</h1>
                    <p>Each agent is a versioned job description: instructions, tools, guardrails and a budget.</p>
                </div>
                <a className="btn primary" href="#/agents/new">
                    New agent
                </a>
            </header>
            <ErrorBanner error={agents.error} />
            <div className="card">
                {agents.data?.length ? (
                    <div className="scroll-x">
                        <table className="grid">
                            <thead>
                                <tr>
                                    <th>Agent</th>
                                    <th>Runs on</th>
                                    <th>Autonomy</th>
                                    <th className="num">Triggers</th>
                                    <th className="num">Runs · 7d</th>
                                    <th className="num">Success</th>
                                    <th className="num">Credits · 7d</th>
                                </tr>
                            </thead>
                            <tbody>
                                {agents.data.map((a) => (
                                    <tr key={a.id} className="link" onClick={() => go(`/agents/${a.id}`)}>
                                        <td>
                                            <div style={{ fontWeight: 600 }}>{a.name}</div>
                                            <div className="muted truncate" style={{ maxWidth: 420, fontSize: 12.5 }}>
                                                {a.description || "No description"}
                                            </div>
                                        </td>
                                        <td>
                                            <span className="tag">
                                                {a.runtime} · {a.model} · r{a.activeRevisionNumber}
                                            </span>
                                        </td>
                                        <td>{AUTONOMY_LABEL[a.autonomy]}</td>
                                        <td className="num">{a.triggerCount}</td>
                                        <td className="num">{a.runs7d}</td>
                                        <td className="num">{pct(a.successRate7d)}</td>
                                        <td className="num">{a.credits7d || "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : agents.loading ? null : (
                    <Empty title="No agents yet">
                        Start from a ready-made agent in a few clicks, or ask an MCP client to call <span className="mono">agents_create</span>.
                        <br />
                        <a className="btn primary" href="#/agents/new">
                            New agent
                        </a>
                    </Empty>
                )}
            </div>
        </div>
    );
}

const RUN_FILTERS = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
    { value: "failed", label: "Failed" },
    { value: "succeeded", label: "Succeeded" },
] as const;
const FILTER_STATUS: Record<string, string[] | undefined> = { all: undefined, active: ["queued", "running", "waiting_approval"], failed: ["failed"], succeeded: ["succeeded"] };

export function Runs() {
    useTick();
    const [filter, setFilter] = useState<(typeof RUN_FILTERS)[number]["value"]>("all");
    const runs = useRpc<any[]>("runs.list", { status: FILTER_STATUS[filter], limit: 100 }, ["run"]);
    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Runs</h1>
                    <p>Every execution, newest first. Open one to read its trace.</p>
                </div>
                <Segmented label="Filter runs" value={filter} onChange={setFilter} options={[...RUN_FILTERS]} />
            </header>
            <ErrorBanner error={runs.error} />
            <div className="card">{runs.data?.length ? <RunRows runs={runs.data} /> : runs.loading ? null : <Empty title={filter === "all" ? "No runs yet" : "No runs match this filter"} />}</div>
        </div>
    );
}

export function Approvals() {
    useTick();
    const pending = useRpc<any[]>("approvals.list", { status: "pending" }, ["approval"]);
    const approved = useRpc<any[]>("approvals.list", { status: "approved", limit: 15 }, ["approval"]);
    const denied = useRpc<any[]>("approvals.list", { status: "denied", limit: 15 }, ["approval"]);
    const expired = useRpc<any[]>("approvals.list", { status: "expired", limit: 15 }, ["approval"]);
    const history = [...(approved.data ?? []), ...(denied.data ?? []), ...(expired.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Approvals</h1>
                    <p>Agents stop here when their guardrails say “ask”. The run continues the moment you decide.</p>
                </div>
            </header>
            <ErrorBanner error={pending.error} />
            <h2 className="section-title" style={{ marginTop: 0 }}>
                Waiting
            </h2>
            {pending.data?.length ? pending.data.map((a) => <ApprovalTicket key={a.id} approval={a} />) : <p className="muted">Nothing is waiting on you.</p>}
            <h2 className="section-title">Decided</h2>
            <div className="card list">
                {history.length ? (
                    history.map((a) => (
                        <a key={a.id} className="list-row" href={`#/runs/${a.runId}`}>
                            <Lamp status={a.status === "expired" ? "idle" : a.status} />
                            <span className="mono grow truncate">{a.summary}</span>
                            <span className="muted truncate" style={{ maxWidth: 260, fontSize: 12.5 }}>
                                {a.agentName} · {a.decidedBy}
                                {a.reason ? ` · ${a.reason}` : ""}
                            </span>
                            <span className="mono muted">{relTime(a.decidedAt)}</span>
                        </a>
                    ))
                ) : (
                    <Empty title="No decisions yet" />
                )}
            </div>
        </div>
    );
}

export function Activity() {
    useTick();
    const audit = useRpc<any[]>("audit.list", { limit: 150 }, ["audit"]);
    const tools = useRpc<any>("insights.tool_usage", { days: 7 }, ["run"]);
    const [open, setOpen] = useState<number | null>(null);
    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Activity</h1>
                    <p>Every change to the system, whoever made it — you, an MCP client or a trigger.</p>
                </div>
            </header>
            <ErrorBanner error={audit.error} />
            <div className="split">
                <div className="card list">
                    {audit.data?.length ? (
                        audit.data.map((entry) => (
                            <div key={entry.id}>
                                <button className="list-row" onClick={() => setOpen(open === entry.id ? null : entry.id)} aria-expanded={open === entry.id}>
                                    <Lamp status={entry.ok ? "ok" : "error"} bare />
                                    <span className="mono" style={{ fontWeight: 500 }}>
                                        {entry.capability}
                                    </span>
                                    <span className={`tag${entry.actor.startsWith("mcp:") ? " hivis" : ""}`}>{entry.actor}</span>
                                    <span className="grow muted truncate" style={{ fontSize: 12.5 }}>
                                        {entry.error ?? ""}
                                    </span>
                                    <span className="mono muted">{relTime(entry.ts)}</span>
                                </button>
                                {open === entry.id ? (
                                    <div style={{ padding: "0 16px 12px" }}>
                                        <pre className="pre">{JSON.stringify(entry.input, null, 2)}</pre>
                                    </div>
                                ) : null}
                            </div>
                        ))
                    ) : (
                        <Empty title="No changes recorded yet" />
                    )}
                </div>
                <div className="card">
                    <div className="card-head">
                        <h3>Tool use · 7d</h3>
                    </div>
                    {tools.data?.tools.length ? (
                        <table className="grid">
                            <thead>
                                <tr>
                                    <th>Tool</th>
                                    <th className="num">Calls</th>
                                    <th className="num">Failed</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tools.data.tools.map((t: any) => (
                                    <tr key={t.tool}>
                                        <td className="mono">{t.tool}</td>
                                        <td className="num">{t.calls}</td>
                                        <td className="num" style={t.failures ? { color: "var(--stop)" } : undefined}>
                                            {t.failures}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <div className="card-body muted">No tool calls recorded in the last week.</div>
                    )}
                </div>
            </div>
        </div>
    );
}
