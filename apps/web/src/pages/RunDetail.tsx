import { useState } from "react";
import { go, rpc, useRpc } from "../api.ts";
import { Trace } from "../Trace.tsx";
import { CopyButton, ErrorBanner, Lamp, num, relTime, runDuration, SOURCE_LABEL, useAction, useTick } from "../ui.tsx";

const ACTIVE = ["queued", "running", "waiting_approval"];

export function RunDetail({ runId }: { runId: string }) {
    useTick(1000);
    const detail = useRpc<any>("runs.get", { runId }, [`run:${runId}`]);
    const timeline = useRpc<any>("runs.timeline", { runId }, [`run:${runId}`]);
    const [diagnosis, setDiagnosis] = useState<any>(null);
    const { busy, run: act } = useAction();
    const run = detail.data?.run;
    if (!run) return <div className="page">{detail.error ? <ErrorBanner error={detail.error} /> : null}</div>;

    const active = ACTIVE.includes(run.status);
    const replay = async () => {
        const next = await act(() => rpc<any>("runs.replay", { runId }), "Replay started on the active revision");
        if (next) go(`/runs/${next.id}`);
    };
    const mcpCall = JSON.stringify({ tool: "runs_timeline", arguments: { runId } });

    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <div className="eyebrow" style={{ marginBottom: 8 }}>
                        <a href="#/runs">Runs</a> / <span className="mono">{run.id}</span>
                    </div>
                    <h1>
                        <a href={`#/agents/${run.agentId}`}>{detail.data.agentName}</a>
                    </h1>
                    <div className="row wrap" style={{ marginTop: 10 }}>
                        <Lamp status={run.status} />
                        <span className="tag">revision {run.revisionNumber}</span>
                        <span className="tag">
                            {SOURCE_LABEL[run.source.kind]}
                            {run.source.actor ? ` · ${run.source.actor}` : ""}
                        </span>
                        {run.source.replayOf ? (
                            <a className="tag" href={`#/runs/${run.source.replayOf}`}>
                                replay of {run.source.replayOf}
                            </a>
                        ) : null}
                        <span className="muted mono">started {relTime(run.startedAt ?? run.createdAt)}</span>
                    </div>
                </div>
                {active ? (
                    <button className="btn danger" disabled={busy} onClick={() => act(() => rpc("runs.cancel", { runId }), "Cancelled")}>
                        Cancel run
                    </button>
                ) : (
                    <>
                        <button className="btn" disabled={busy} onClick={async () => setDiagnosis(await act(() => rpc("runs.explain_failure", { runId })))}>
                            Explain
                        </button>
                        <button className="btn primary" disabled={busy} onClick={replay}>
                            Replay
                        </button>
                    </>
                )}
            </header>

            {run.error ? (
                <div className="banner error" style={{ marginBottom: 16 }}>
                    <div className="grow">
                        <b>Failed.</b> {run.error}
                    </div>
                </div>
            ) : null}
            {diagnosis ? (
                <div className="card" style={{ marginBottom: 16 }}>
                    <div className="card-head">
                        <h3>Diagnosis</h3>
                        <span className="grow" />
                        <button className="btn sm ghost" onClick={() => setDiagnosis(null)}>
                            Close
                        </button>
                    </div>
                    <div className="card-body stack">
                        <p style={{ fontWeight: 500 }}>{diagnosis.summary}</p>
                        {diagnosis.signals.length > 1 ? (
                            <div>
                                <div className="eyebrow" style={{ marginBottom: 6 }}>
                                    Signals
                                </div>
                                {diagnosis.signals.map((s: string, i: number) => (
                                    <div key={i} className="mono" style={{ marginBottom: 3 }}>
                                        {s}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                        {diagnosis.suggestions.length ? (
                            <div>
                                <div className="eyebrow" style={{ marginBottom: 6 }}>
                                    Try
                                </div>
                                {diagnosis.suggestions.map((s: string, i: number) => (
                                    <div key={i}>{s}</div>
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <div className="split">
                <div className="card">
                    <div className="card-head">
                        <h3>Shift log</h3>
                        <span className="muted" style={{ fontSize: 12.5 }}>
                            {timeline.data?.steps.length ?? 0} steps · bars show when each step ran within the run
                        </span>
                    </div>
                    <div className="card-body">
                        <Trace steps={timeline.data?.steps ?? []} />
                    </div>
                </div>
                <div className="stack">
                    <div className="card pad">
                        <dl className="kv">
                            <dt>Took</dt>
                            <dd>{runDuration(run)}</dd>
                            <dt>Model calls</dt>
                            <dd>{run.usage.modelCalls}</dd>
                            <dt>Tool calls</dt>
                            <dd>{run.usage.toolCalls}</dd>
                            <dt>Tokens in / out</dt>
                            <dd>
                                {num(run.usage.inputTokens)} / {num(run.usage.outputTokens)}
                            </dd>
                            <dt>Credits</dt>
                            <dd>{run.usage.credits}</dd>
                            {run.sessionId ? (
                                <>
                                    <dt>Session</dt>
                                    <dd>{run.sessionId}</dd>
                                </>
                            ) : null}
                        </dl>
                    </div>
                    <div className="card">
                        <div className="card-head">
                            <h3>Result</h3>
                        </div>
                        <div className="card-body">{run.output ? <pre className="pre">{run.output}</pre> : <span className="muted">{active ? "Still working…" : "The run produced no result."}</span>}</div>
                    </div>
                    <div className="card">
                        <div className="card-head">
                            <h3>Prompt</h3>
                        </div>
                        <div className="card-body">
                            <pre className="pre">{run.prompt}</pre>
                        </div>
                    </div>
                    <div className="card pad stack">
                        <div className="row">
                            <span className="label grow">Hand this run to an agent</span>
                            <CopyButton text={mcpCall} label="Copy MCP call" />
                        </div>
                        <span className="hint">
                            Any MCP client connected to Foreman can read this trace with <span className="mono">runs_timeline</span> and diagnose it with <span className="mono">runs_explain_failure</span>.
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
