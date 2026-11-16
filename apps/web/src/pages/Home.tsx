import { go, rpc, useRpc } from "../api.ts";
import { AnswerBox } from "../Answer.tsx";
import { Empty, ErrorBanner, Lamp, num, pct, relTime, runDuration, SOURCE_LABEL, useAction, useTick } from "../ui.tsx";

export function ApprovalTicket({ approval }: { approval: any }) {
    const { busy, run } = useAction();
    const decide = (decision: "approve" | "deny") => run(() => rpc("approvals.decide", { approvalId: approval.id, decision }), decision === "approve" ? "Approved" : "Denied");
    const meta = (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
            <a href={`#/agents/${approval.agentId}`}>{approval.agentName}</a> · asked {relTime(approval.createdAt)} ·{" "}
            <a href={`#/runs/${approval.runId}`} style={{ textDecoration: "underline" }}>
                see the run
            </a>
        </div>
    );
    if (approval.kind === "question")
        return (
            <div className="ticket question">
                <div className="grow">
                    <div className="eyebrow">Question</div>
                    <div className="what plain">{approval.summary}</div>
                    {meta}
                    <AnswerBox approvalId={approval.id} />
                </div>
            </div>
        );
    return (
        <div className="ticket">
            <div className="grow">
                <div className="what">{approval.summary}</div>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                    <a href={`#/agents/${approval.agentId}`}>{approval.agentName}</a> · asked {relTime(approval.createdAt)} ·{" "}
                    <a href={`#/runs/${approval.runId}`} style={{ textDecoration: "underline" }}>
                        see the run
                    </a>
                </div>
            </div>
            <button className="btn hivis" disabled={busy} onClick={() => decide("approve")}>
                Approve
            </button>
            <button className="btn" disabled={busy} onClick={() => decide("deny")}>
                Deny
            </button>
        </div>
    );
}

export function RunRows({ runs, showAgent = true }: { runs: any[]; showAgent?: boolean }) {
    return (
        <div className="scroll-x">
            <table className="grid">
                <thead>
                    <tr>
                        <th>Status</th>
                        {showAgent ? <th>Agent</th> : null}
                        <th>Prompt</th>
                        <th>From</th>
                        <th className="num">Took</th>
                        <th className="num">Credits</th>
                        <th className="num">Started</th>
                    </tr>
                </thead>
                <tbody>
                    {runs.map((run) => (
                        <tr key={run.id} className="link" onClick={() => go(`/runs/${run.id}`)}>
                            <td>
                                <Lamp status={run.status} />
                            </td>
                            {showAgent ? <td style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{run.agentName}</td> : null}
                            <td style={{ maxWidth: 380 }}>
                                <div className="truncate">{run.prompt}</div>
                            </td>
                            <td>
                                <span className="tag">
                                    {SOURCE_LABEL[run.source.kind] ?? run.source.kind} · r{run.revisionNumber}
                                </span>
                            </td>
                            <td className="num">{runDuration(run)}</td>
                            <td className="num">{run.usage.credits || "—"}</td>
                            <td className="num">{relTime(run.createdAt)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function Home() {
    useTick();
    const approvals = useRpc<any[]>("approvals.list", { status: "pending" }, ["approval"]);
    const active = useRpc<any[]>("runs.list", { status: ["queued", "running", "waiting_approval"], limit: 20 }, ["run"]);
    const recent = useRpc<any[]>("runs.list", { limit: 8 }, ["run"]);
    const insights = useRpc<any>("insights.summary", { days: 1 }, ["run"]);
    const system = useRpc<any>("system.info", {}, []);
    const t = insights.data?.total;
    const agents = useRpc<any[]>("agents.list", {}, ["agents"]);
    // Only worth a warning when some agent actually depends on Copilot.
    const copilot = agents.data?.some((a) => a.runtime === "copilot") ? system.data?.runtimes.find((r: any) => r.name === "copilot") : undefined;

    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>The board</h1>
                    <p>What needs you, what is on shift, and how the last day went.</p>
                </div>
                <a className="btn primary" href="#/agents/new">
                    New agent
                </a>
            </header>
            <ErrorBanner error={approvals.error ?? recent.error} />
            {copilot && !copilot.ok ? (
                <div className="banner warn" style={{ marginBottom: 16 }}>
                    <div className="grow">
                        <b>Copilot runtime is not ready.</b> {copilot.detail} Agents on the mock runtime still work.
                    </div>
                    <a className="btn sm" href="#/connect">
                        Details
                    </a>
                </div>
            ) : null}

            <div className="stats">
                <div className="stat">
                    <span className="eyebrow">Runs · 24h</span>
                    <b>{t ? num(t.runs) : "—"}</b>
                    <small>{t ? `${t.failed} failed · ${t.cancelled} cancelled` : " "}</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">Success</span>
                    <b>{t ? pct(t.successRate) : "—"}</b>
                    <small>of finished runs</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">Credits · 24h</span>
                    <b>{t ? t.credits : "—"}</b>
                    <small>{t ? `${num(t.inputTokens + t.outputTokens)} tokens` : " "}</small>
                </div>
                <div className="stat">
                    <span className="eyebrow">On shift</span>
                    <b>{insights.data ? insights.data.engine.running : "—"}</b>
                    <small>{insights.data ? `${insights.data.engine.queued} queued · limit ${insights.data.engine.concurrency}` : " "}</small>
                </div>
            </div>

            <h2 className="section-title">
                Needs you <span className="after">{approvals.data?.length ? `${approvals.data.length} waiting` : ""}</span>
            </h2>
            {approvals.data?.length ? (
                approvals.data.map((a) => <ApprovalTicket key={a.id} approval={a} />)
            ) : (
                <p className="muted">Nothing is waiting on you. Agents ask here before doing anything their guardrails mark as “ask”.</p>
            )}

            <h2 className="section-title">On shift now</h2>
            {active.data?.length ? (
                <div className="card">
                    <RunRows runs={active.data} />
                </div>
            ) : (
                <p className="muted">No runs in progress.</p>
            )}

            <h2 className="section-title">
                Latest runs{" "}
                <a className="after" href="#/runs" style={{ textDecoration: "underline" }}>
                    all runs
                </a>
            </h2>
            <div className="card">
                {recent.data?.length ? (
                    <RunRows runs={recent.data} />
                ) : (
                    <Empty title="No runs yet">
                        Open an agent and use its test bench, or attach a trigger.
                        <br />
                        <a className="btn" href="#/agents">
                            Go to agents
                        </a>
                    </Empty>
                )}
            </div>
        </div>
    );
}
