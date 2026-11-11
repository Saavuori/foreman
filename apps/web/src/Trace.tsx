import { useState } from "react";
import type { TimelineStep } from "@foreman/core";
import { rpc } from "./api.ts";
import { duration, Lamp, useAction } from "./ui.tsx";

const KIND_LABEL: Record<TimelineStep["kind"], string> = {
    lifecycle: "Run",
    prompt: "Prompt",
    thought: "Plan",
    progress: "Stage",
    message: "Reply",
    tool: "Tool",
    policy: "Policy",
    approval: "Approval",
    usage: "Model",
    subagent: "Agent",
    error: "Error",
};
const OPEN_BY_DEFAULT = new Set(["message", "error"]);

/**
 * The shift log: every step of a run on one rail, with its offset from the start and a bar
 * showing where in the run's total time it happened and how long it took.
 */
export function Trace({ steps, compact }: { steps: TimelineStep[]; compact?: boolean }) {
    if (!steps.length) return <p className="muted">Nothing recorded yet.</p>;
    const start = Date.parse(steps[0]!.ts);
    const end = Math.max(...steps.map((s) => Date.parse(s.ts) + (s.durationMs ?? 0)));
    const total = Math.max(end - start, 1);
    return (
        <div className="trace">
            {steps.map((step) => (
                <Step key={step.seq} step={step} offset={Date.parse(step.ts) - start} total={total} compact={compact} />
            ))}
        </div>
    );
}

function Step({ step, offset, total, compact }: { step: TimelineStep; offset: number; total: number; compact?: boolean }) {
    const args = step.data?.arguments;
    const hasDetail = !!step.detail || args !== undefined;
    const [open, setOpen] = useState(!compact && (OPEN_BY_DEFAULT.has(step.kind) || step.status === "error"));
    const { busy, run } = useAction();
    const lamp = step.status ?? (step.kind === "error" ? "error" : "idle");
    const approvalId = step.kind === "approval" && step.status === "pending" ? (step.data?.approvalId as string) : null;
    const decide = (decision: "approve" | "deny") => run(() => rpc("approvals.decide", { approvalId, decision }), decision === "approve" ? "Approved" : "Denied");

    return (
        <div className={`step ${step.kind}${step.status === "error" ? " error" : ""}${hasDetail ? " has-detail" : ""}`}>
            <div className="at">+{duration(offset)}</div>
            <div className="rail">
                <Lamp status={lamp} bare />
            </div>
            <div className="body">
                <button type="button" className="head" onClick={() => hasDetail && setOpen(!open)} aria-expanded={hasDetail ? open : undefined}>
                    <span className="kind">{KIND_LABEL[step.kind]}</span>
                    <span className="title">{step.title}</span>
                    {step.durationMs != null ? <span className="dur">{duration(step.durationMs)}</span> : null}
                </button>
                {step.durationMs != null && !compact ? (
                    <div className="bar" aria-hidden>
                        <i style={{ left: `${(offset / total) * 100}%`, width: `${(step.durationMs / total) * 100}%` }} />
                    </div>
                ) : null}
                {approvalId ? (
                    <div className="row" style={{ marginTop: 8 }}>
                        <button className="btn sm hivis" disabled={busy} onClick={() => decide("approve")}>
                            Approve
                        </button>
                        <button className="btn sm" disabled={busy} onClick={() => decide("deny")}>
                            Deny
                        </button>
                    </div>
                ) : null}
                {open && hasDetail ? (
                    <div className="detail">
                        {args !== undefined ? `${JSON.stringify(args, null, 2)}\n${step.detail ? "\n→ " : ""}` : ""}
                        {step.detail}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
