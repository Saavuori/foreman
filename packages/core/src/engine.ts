import { evaluatePolicy } from "./policy.ts";
import type { Actor, Bus } from "./registry.ts";
import { actorLabel } from "./registry.ts";
import type { AuthorizeRequest, RuntimeAdapter } from "./runtime.ts";
import { TERMINAL_STATUSES, type Approval, type Run, type RunUsage } from "./schemas.ts";
import type { Store } from "./store.ts";
import type { JiraClient } from "./jira.ts";
import { FOREMAN_TOOLS, foremanTool, toolEnabled, toolInfo } from "./tools.ts";
import { z } from "zod";

export interface EngineOptions {
    concurrency: number;
    /** Removes vault values from anything about to be recorded. */
    scrub?: <T>(data: T) => T;
    resolveSecrets?: (text: string) => string;
}

interface Active {
    abort: AbortController;
    cancelledBy?: string;
    timedOut?: boolean;
}

/**
 * Runs agents: a durable queue with a global concurrency limit, per-run timeouts, the policy and
 * approval path, usage accounting and the append-only trace.
 */
export class Engine {
    private queue: string[] = [];
    private active = new Map<string, Active>();
    private pendingApprovals = new Map<string, (approved: boolean, reason: string) => void>();
    private idleWaiters: (() => void)[] = [];

    constructor(
        private store: Store,
        private bus: Bus,
        private runtimes: Record<string, RuntimeAdapter>,
        private opts: EngineOptions = { concurrency: 4 },
    ) {}

    private toolHost?: { jira(): JiraClient };
    /** What Foreman's own agent tools act on. Set once the work queue exists. */
    setToolHost(host: { jira(): JiraClient }) {
        this.toolHost = host;
    }

    /** Call once at boot: fail anything a previous process left mid-flight and re-queue the rest. */
    recover() {
        for (const run of this.store.listRuns({ status: ["running", "waiting_approval"], limit: 500 })) {
            this.store.appendEvent(run.id, "foreman.run_interrupted", { reason: "Server restarted while the run was in flight" });
            this.store.updateRun(run.id, { status: "failed", error: "Interrupted by a server restart", finishedAt: new Date().toISOString() });
        }
        for (const approval of this.store.listApprovals({ status: "pending", limit: 500 })) {
            this.store.decideApproval(approval.id, "expired", "system:recover", "Server restarted");
        }
        for (const run of this.store.listRuns({ status: ["queued"], limit: 500 }).reverse()) this.queue.push(run.id);
        this.pump();
    }

    enqueue(run: Run) {
        this.store.appendEvent(run.id, "foreman.run_queued", { source: run.source, revisionNumber: run.revisionNumber });
        this.queue.push(run.id);
        this.bus.emit("run", run);
        this.pump();
    }

    cancel(runId: string, actor: Actor): Run {
        const run = this.store.getRun(runId);
        if (!run) throw new Error(`Run ${runId} not found`);
        if (TERMINAL_STATUSES.includes(run.status)) return run;
        const active = this.active.get(runId);
        if (active) {
            active.cancelledBy = actorLabel(actor);
            active.abort.abort();
            return this.store.getRun(runId)!;
        }
        this.queue = this.queue.filter((id) => id !== runId);
        this.store.appendEvent(runId, "foreman.run_cancelled", { by: actorLabel(actor) });
        const updated = this.store.updateRun(runId, { status: "cancelled", finishedAt: new Date().toISOString() });
        this.bus.emit("run", updated);
        return updated;
    }

    decideApproval(approvalId: string, approved: boolean, actor: Actor, reason?: string): Approval {
        const approval = this.store.decideApproval(approvalId, approved ? "approved" : "denied", actorLabel(actor), reason);
        this.bus.emit("approval", approval);
        this.pendingApprovals.get(approvalId)?.(approved, reason ?? (approved ? "Approved" : "Denied") + ` by ${actorLabel(actor)}`);
        return approval;
    }

    /** Resolves when nothing is queued or running. Used by tests and graceful shutdown. */
    whenIdle(): Promise<void> {
        if (!this.queue.length && !this.active.size) return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }

    stats() {
        return { queued: this.queue.length, running: this.active.size, concurrency: this.opts.concurrency };
    }

    private pump() {
        while (this.active.size < this.opts.concurrency && this.queue.length) {
            const runId = this.queue.shift()!;
            const state: Active = { abort: new AbortController() };
            this.active.set(runId, state);
            void this.execute(runId, state).finally(() => {
                this.active.delete(runId);
                this.pump();
                if (!this.queue.length && !this.active.size) this.idleWaiters.splice(0).forEach((w) => w());
            });
        }
    }

    private async execute(runId: string, state: Active) {
        const { store, bus } = this;
        let run = store.getRun(runId)!;
        const revision = store.getRevision(run.revisionId);
        const usage: RunUsage = { ...run.usage };
        const scrub = this.opts.scrub ?? (<T>(d: T) => d);
        const emit = (type: string, raw: unknown) => {
            const data = scrub(raw);
            // Persist usage as it accrues so a live run shows its spend, not only a finished one.
            if (accumulateUsage(usage, type, data)) store.updateRun(runId, { usage });
            bus.emit("event", store.appendEvent(runId, type, data));
        };
        const setStatus = (patch: Parameters<Store["updateRun"]>[1]) => {
            run = store.updateRun(runId, { ...patch, usage });
            bus.emit("run", run);
        };
        const finish = (status: "succeeded" | "failed" | "cancelled", patch: { output?: string; error?: string } = {}) => {
            patch = scrub(patch);
            emit(`foreman.run_${status}`, patch.error ? { error: patch.error } : {});
            setStatus({ status, ...patch, finishedAt: new Date().toISOString() });
        };

        if (!revision) return finish("failed", { error: `Revision ${run.revisionId} no longer exists` });
        const spec = revision.spec;
        const runtime = this.runtimes[spec.runtime];
        if (!runtime) return finish("failed", { error: `Runtime "${spec.runtime}" is not available on this server` });

        setStatus({ status: "running", startedAt: new Date().toISOString() });
        emit("foreman.run_started", { runtime: runtime.name, model: spec.model, autonomy: spec.policy.autonomy, budget: spec.budget });
        const timer = setTimeout(() => {
            state.timedOut = true;
            state.abort.abort();
        }, spec.budget.timeoutSeconds * 1000);

        const authorize = async (request: AuthorizeRequest) => {
            const decision = evaluatePolicy(spec.policy, request);
            if (decision.action !== "ask") {
                emit("foreman.policy_decision", { kind: request.kind, toolName: request.toolName, summary: request.summary, ...decision });
                return { allowed: decision.action === "allow", reason: decision.reason };
            }
            const approval = store.createApproval({ runId, agentId: run.agentId, kind: request.kind, toolName: request.toolName, summary: request.summary, request: request.request });
            emit("foreman.approval_requested", { approvalId: approval.id, kind: request.kind, toolName: request.toolName, summary: request.summary, reason: decision.reason });
            setStatus({ status: "waiting_approval" });
            bus.emit("approval", approval);
            const verdict = await this.waitForApproval(approval.id, spec.policy.approvalTimeoutSeconds * 1000, state.abort.signal);
            emit("foreman.approval_decided", { approvalId: approval.id, ...verdict });
            if (!state.abort.signal.aborted) setStatus({ status: "running" });
            return verdict;
        };

        // A question is an approval that carries text back: same waiting state, same timeout.
        const ask = async (question: string): Promise<string | null> => {
            const approval = store.createApproval({ runId, agentId: run.agentId, kind: "question", toolName: "ask_for_info", summary: question, request: { question } });
            emit("foreman.question_asked", { approvalId: approval.id, question });
            setStatus({ status: "waiting_approval" });
            bus.emit("approval", approval);
            const verdict = await this.waitForApproval(approval.id, spec.policy.approvalTimeoutSeconds * 1000, state.abort.signal);
            emit("foreman.question_answered", { approvalId: approval.id, answered: verdict.allowed, answer: verdict.allowed ? verdict.reason : null, reason: verdict.allowed ? undefined : verdict.reason });
            if (!state.abort.signal.aborted) setStatus({ status: "running" });
            return verdict.allowed ? verdict.reason : null;
        };
        const tools = {
            available: FOREMAN_TOOLS.filter((t) => toolEnabled(t, spec.tools)).map(toolInfo),
            call: async (name: string, args: unknown): Promise<{ ok: boolean; content: string }> => {
                const tool = foremanTool(name);
                if (!tool) return { ok: false, content: `Unknown tool "${name}"` };
                if (!toolEnabled(tool, spec.tools)) return { ok: false, content: `${name} is not switched on for this agent` };
                const parsed = tool.input.safeParse(args ?? {});
                if (!parsed.success) return { ok: false, content: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` };
                if (tool.kind !== "internal") {
                    const verdict = await authorize({ kind: tool.kind, toolName: tool.name, summary: `${tool.title} — ${tool.summary(parsed.data)}`.slice(0, 200), request: { toolName: tool.name, arguments: parsed.data } });
                    if (!verdict.allowed) return { ok: false, content: `Permission denied: ${verdict.reason}` };
                }
                if (!this.toolHost) return { ok: false, content: "Foreman tools are not available on this server" };
                try {
                    return { ok: true, content: await tool.handler({ run, emit, ask, jira: () => this.toolHost!.jira() }, parsed.data) };
                } catch (e) {
                    return { ok: false, content: e instanceof Error ? e.message : String(e) };
                }
            },
        };

        try {
            const result = await runtime.execute({ run, spec, signal: state.abort.signal, emit, authorize, tools, resolveSecrets: this.opts.resolveSecrets ?? ((text) => text) });
            state.abort.signal.throwIfAborted();
            if (result.sessionId) store.updateRun(runId, { sessionId: result.sessionId });
            const mismatch = spec.outputSchema ? checkResultShape(result.output, spec.outputSchema) : null;
            result.output = scrub(result.output);
            if (mismatch) {
                store.updateRun(runId, { output: result.output });
                return finish("failed", { error: `Result does not match the agent's result shape: ${mismatch}` });
            }
            finish("succeeded", { output: result.output });
        } catch (e) {
            if (state.cancelledBy) {
                emit("foreman.run_cancel_requested", { by: state.cancelledBy });
                finish("cancelled");
            } else if (state.timedOut) {
                finish("failed", { error: `Timed out after ${spec.budget.timeoutSeconds}s (budget.timeoutSeconds)` });
            } else {
                finish("failed", { error: e instanceof Error ? e.message : String(e) });
            }
        } finally {
            clearTimeout(timer);
            for (const approval of store.listApprovals({ status: "pending", runId })) {
                bus.emit("approval", store.decideApproval(approval.id, "expired", "system:engine", "Run ended"));
            }
        }
    }

    private waitForApproval(approvalId: string, timeoutMs: number, signal: AbortSignal): Promise<{ allowed: boolean; reason: string }> {
        return new Promise((resolve) => {
            const done = (allowed: boolean, reason: string) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                this.pendingApprovals.delete(approvalId);
                resolve({ allowed, reason });
            };
            const expire = (reason: string) => {
                try {
                    this.bus.emit("approval", this.store.decideApproval(approvalId, "expired", "system:engine", reason));
                } catch {
                    /* already decided */
                }
                done(false, reason);
            };
            const onAbort = () => expire("Run was stopped while waiting for approval");
            const timer = setTimeout(() => expire("Approval timed out"), timeoutMs);
            signal.addEventListener("abort", onAbort, { once: true });
            this.pendingApprovals.set(approvalId, done);
        });
    }
}

/** A deliberately small check: valid JSON, right top-level type, required keys present. */
export function checkResultShape(output: string, schema: Record<string, unknown>): string | null {
    let value: unknown;
    try {
        value = JSON.parse(output);
    } catch {
        return "it is not valid JSON";
    }
    if (schema.type === "object") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return "expected a JSON object";
        const missing = ((schema.required as string[] | undefined) ?? []).filter((key) => !(key in (value as object)));
        if (missing.length) return `missing required field${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`;
    } else if (schema.type === "array" && !Array.isArray(value)) return "expected a JSON array";
    return null;
}

function accumulateUsage(usage: RunUsage, type: string, data: any): boolean {
    if (type === "assistant.usage" && data) {
        usage.modelCalls += 1;
        usage.inputTokens += Number(data.inputTokens ?? 0);
        usage.outputTokens += Number(data.outputTokens ?? 0);
        usage.credits = Math.round((usage.credits + Number(data.cost ?? 0)) * 1000) / 1000;
    } else if (type === "tool.execution_start") {
        usage.toolCalls += 1;
    } else return false;
    return true;
}
