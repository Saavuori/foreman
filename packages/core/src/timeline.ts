import type { Run, RunEvent } from "./schemas.ts";

export interface TimelineStep {
    seq: number;
    ts: string;
    kind: "lifecycle" | "prompt" | "thought" | "progress" | "message" | "tool" | "policy" | "approval" | "usage" | "subagent" | "error";
    title: string;
    detail?: string;
    status?: "ok" | "error" | "pending" | "denied";
    durationMs?: number;
    /** Extra structured fields worth showing (arguments, result, token counts). */
    data?: Record<string, unknown>;
}

const clip = (v: unknown, max = 600): string => {
    const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + "…" : s;
};
const LIFECYCLE: Record<string, string> = {
    "foreman.run_queued": "Queued",
    "foreman.run_started": "Started",
    "foreman.run_succeeded": "Succeeded",
    "foreman.run_cancelled": "Cancelled",
    "foreman.run_cancel_requested": "Cancel requested",
    "foreman.run_interrupted": "Interrupted",
};

/**
 * Fold the raw event stream into the steps a person (or an agent debugging over MCP) wants to
 * read: tool calls paired with their results, approvals paired with their decisions.
 */
export function buildTimeline(events: RunEvent[]): TimelineStep[] {
    const steps: TimelineStep[] = [];
    const tools = new Map<string, TimelineStep>();
    const approvals = new Map<string, TimelineStep>();
    for (const e of events) {
        const d = (e.data ?? {}) as any;
        const base = { seq: e.seq, ts: e.ts };
        if (LIFECYCLE[e.type]) {
            steps.push({ ...base, kind: "lifecycle", title: LIFECYCLE[e.type]!, detail: e.type === "foreman.run_started" ? `${d.runtime} · ${d.model} · autonomy ${d.autonomy}` : d.reason ?? d.by, status: "ok" });
            continue;
        }
        switch (e.type) {
            case "foreman.run_failed":
                steps.push({ ...base, kind: "error", title: "Run failed", detail: clip(d.error, 2000), status: "error" });
                break;
            case "user.message":
                steps.push({ ...base, kind: "prompt", title: "Prompt", detail: clip(d.content, 4000), data: d.source ? { source: d.source } : undefined });
                break;
            case "foreman.progress":
                steps.push({ ...base, kind: "progress", title: `${d.step} of ${d.total} — ${d.message}`, data: { step: d.step, total: d.total } });
                break;
            case "assistant.intent":
                steps.push({ ...base, kind: "thought", title: clip(d.intent, 200) });
                break;
            case "assistant.reasoning":
                steps.push({ ...base, kind: "thought", title: "Reasoning", detail: clip(d.content, 2000) });
                break;
            case "assistant.message":
                if (d.content) steps.push({ ...base, kind: "message", title: "Assistant", detail: clip(d.content, 8000) });
                break;
            case "tool.execution_start": {
                const step: TimelineStep = { ...base, kind: "tool", title: d.mcpServerName ? `${d.mcpServerName} · ${d.mcpToolName ?? d.toolName}` : String(d.toolName), status: "pending", data: { arguments: d.arguments } };
                if (d.toolCallId) tools.set(d.toolCallId, step);
                steps.push(step);
                break;
            }
            case "tool.execution_complete": {
                const step = d.toolCallId ? tools.get(d.toolCallId) : undefined;
                const failed = d.success === false || !!d.error;
                const detail = failed ? clip(d.error?.message ?? d.error, 2000) : clip(d.result?.content ?? d.result, 2000);
                if (step) {
                    step.status = failed ? "error" : "ok";
                    step.detail = detail;
                    step.durationMs = Date.parse(e.ts) - Date.parse(step.ts);
                } else {
                    steps.push({ ...base, kind: "tool", title: String(d.toolName ?? "tool"), status: failed ? "error" : "ok", detail });
                }
                break;
            }
            case "foreman.policy_decision":
                steps.push({ ...base, kind: "policy", title: `${d.action === "allow" ? "Allowed" : "Denied"}: ${d.summary}`, detail: d.reason, status: d.action === "allow" ? "ok" : "denied" });
                break;
            case "foreman.approval_requested": {
                const step: TimelineStep = { ...base, kind: "approval", title: `Approval needed: ${d.summary}`, detail: d.reason, status: "pending", data: { approvalId: d.approvalId } };
                approvals.set(d.approvalId, step);
                steps.push(step);
                break;
            }
            case "foreman.question_asked": {
                const step: TimelineStep = { ...base, kind: "approval", title: `Question: ${clip(d.question, 300)}`, status: "pending", data: { approvalId: d.approvalId, question: true } };
                approvals.set(d.approvalId, step);
                steps.push(step);
                break;
            }
            case "foreman.question_answered": {
                const step = approvals.get(d.approvalId);
                if (step) {
                    step.status = d.answered ? "ok" : "denied";
                    step.detail = d.answered ? `Answer: ${clip(d.answer, 2000)}` : `No answer: ${d.reason}`;
                    step.durationMs = Date.parse(e.ts) - Date.parse(step.ts);
                }
                break;
            }
            case "foreman.approval_decided": {
                const step = approvals.get(d.approvalId);
                if (step) {
                    step.status = d.allowed ? "ok" : "denied";
                    step.title = step.title.replace("Approval needed", d.allowed ? "Approved" : "Not approved");
                    step.detail = d.reason;
                    step.durationMs = Date.parse(e.ts) - Date.parse(step.ts);
                }
                break;
            }
            case "assistant.usage":
                steps.push({ ...base, kind: "usage", title: `Model call · ${d.model ?? "model"}`, detail: `${d.inputTokens ?? 0} in · ${d.outputTokens ?? 0} out${d.cost != null ? ` · ${d.cost} credits` : ""}`, data: { inputTokens: d.inputTokens, outputTokens: d.outputTokens, cost: d.cost, durationMs: d.duration } });
                break;
            case "subagent.started":
            case "subagent.completed":
            case "subagent.failed":
                steps.push({ ...base, kind: "subagent", title: `Sub-agent ${d.agentName ?? d.agentDisplayName ?? ""} ${e.type.split(".")[1]}`, status: e.type.endsWith("failed") ? "error" : "ok", detail: clip(d.error ?? d.summary) });
                break;
            case "session.error":
                steps.push({ ...base, kind: "error", title: "Session error", detail: clip(d.message ?? d, 2000), status: "error" });
                break;
        }
    }
    return steps;
}

export interface FailureExplanation {
    runId: string;
    status: Run["status"];
    summary: string;
    signals: string[];
    suggestions: string[];
    lastSteps: TimelineStep[];
}

/** A rule-based first read of why a run went wrong, aimed at an agent debugging over MCP. */
export function explainFailure(run: Run, events: RunEvent[]): FailureExplanation {
    const steps = buildTimeline(events);
    const signals: string[] = [];
    const suggestions: string[] = [];
    const failedTools = steps.filter((s) => s.kind === "tool" && s.status === "error");
    const denied = steps.filter((s) => (s.kind === "policy" || s.kind === "approval") && s.status === "denied");
    const error = run.error ?? "";

    if (run.status === "succeeded" && !failedTools.length && !denied.length) {
        return { runId: run.id, status: run.status, summary: "The run succeeded with no failed tools or denied actions.", signals, suggestions, lastSteps: steps.slice(-5) };
    }
    if (error) signals.push(`Run error: ${error}`);
    for (const t of failedTools) signals.push(`Tool "${t.title}" failed: ${t.detail ?? "no detail"}`);
    for (const d of denied) signals.push(`${d.title}${d.detail ? ` (${d.detail})` : ""}`);

    if (/result shape|not valid JSON/i.test(error)) suggestions.push("The answer did not match the agent's result shape. Tighten the instructions about the output format, or relax outputSchema.");
    if (/ECONNRESET|transient|503/i.test(error)) suggestions.push("This looks transient. Replay the run with runs.replay.");
    if (/timed out/i.test(error)) suggestions.push("Raise budget.timeoutSeconds, or narrow the task so it finishes sooner.");
    if (/403|not authorized|unauthorized|authenticat/i.test(error)) suggestions.push("The runtime could not authenticate to Copilot. Check system.info for runtime status and sign in with a Copilot-entitled account, or configure a BYOK provider.");
    if (/credit|limit|quota/i.test(error)) suggestions.push("Raise budget.maxAiCredits or reduce the work per run.");
    if (/interrupted/i.test(error)) suggestions.push("The server restarted mid-run. Use runs.replay to run it again.");
    if (denied.some((d) => /timed out|expired/i.test(d.detail ?? ""))) suggestions.push("An approval expired. Raise policy.approvalTimeoutSeconds or add an allow rule for this action.");
    else if (denied.length) suggestions.push("An action was blocked by policy. If it is safe, add an allow or ask rule in policy.rules, or raise the autonomy preset.");
    if (failedTools.length) suggestions.push("Inspect the failing tool's arguments with runs.timeline and check the tool or MCP server is configured for this agent.");
    if (!suggestions.length) suggestions.push("Read the last steps below, then replay with runs.replay after adjusting the agent.");

    const summary = signals[0] ?? `Run ended as ${run.status}.`;
    return { runId: run.id, status: run.status, summary, signals, suggestions, lastSteps: steps.slice(-6) };
}

/** Flatten two JSON values into a list of changed paths. */
export function diffJson(before: unknown, after: unknown, path = ""): { path: string; before: unknown; after: unknown }[] {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    if (isObj(before) && isObj(after)) {
        return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((k) => diffJson(before[k], after[k], path ? `${path}.${k}` : k));
    }
    return [{ path: path || "(root)", before, after }];
}
