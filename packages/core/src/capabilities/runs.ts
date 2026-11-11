import { z } from "zod";
import { once } from "node:events";
import { CapabilityError, defineCapability, actorLabel, type Ctx } from "../registry.ts";
import { RunStatus, TERMINAL_STATUSES, type Run } from "../schemas.ts";
import { buildTimeline, explainFailure } from "../timeline.ts";
import { requireAgent } from "./agents.ts";

function requireRun(ctx: Ctx, runId: string): Run {
    const run = ctx.store.getRun(runId);
    if (!run) throw new CapabilityError(`Run ${runId} not found`, "not_found");
    return run;
}

async function waitForRun(ctx: Ctx, runId: string, timeoutSeconds: number): Promise<Run> {
    const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
    for (;;) {
        const run = requireRun(ctx, runId);
        // Waiting on a human is also a moment the caller wants control back.
        if (TERMINAL_STATUSES.includes(run.status) || run.status === "waiting_approval" || deadline.aborted) return run;
        try {
            await once(ctx.bus, "run", { signal: deadline });
        } catch {
            return requireRun(ctx, runId);
        }
    }
}

export const runCapabilities = [
    defineCapability({
        name: "runs.start",
        title: "Start run",
        description:
            "Run an agent with a prompt. Uses the active revision unless revisionId names a draft. Set waitSeconds to block until the run finishes or needs an approval; otherwise poll runs.get.",
        input: z.object({
            agentId: z.string(),
            prompt: z.string().min(1),
            revisionId: z.string().optional(),
            waitSeconds: z.number().int().min(0).max(300).default(0),
        }),
        handler: async (ctx, input) => {
            const agent = requireAgent(ctx, input.agentId);
            if (agent.archived) throw new CapabilityError("Agent is archived", "conflict");
            const revision = ctx.store.getRevision(input.revisionId ?? agent.activeRevisionId);
            if (!revision || revision.agentId !== agent.id) throw new CapabilityError("Revision not found for this agent", "not_found");
            const run = ctx.store.createRun({ agentId: agent.id, revision, source: { kind: ctx.actor.kind === "mcp" ? "mcp" : "manual", actor: actorLabel(ctx.actor) }, prompt: input.prompt });
            ctx.engine.enqueue(run);
            return input.waitSeconds ? waitForRun(ctx, run.id, input.waitSeconds) : run;
        },
    }),
    defineCapability({
        name: "runs.list",
        title: "List runs",
        description: "List runs, newest first. Filter by agent and status; page with `before` (a createdAt timestamp).",
        readOnly: true,
        input: z.object({ agentId: z.string().optional(), status: z.array(RunStatus).optional(), limit: z.number().int().min(1).max(200).default(50), before: z.string().optional() }),
        handler: (ctx, input) => {
            const names = new Map(ctx.store.listAgents(true).map((a) => [a.id, a.name]));
            return ctx.store.listRuns(input).map(({ payload: _payload, ...run }) => ({ ...run, agentName: names.get(run.agentId) ?? run.agentId, prompt: run.prompt.split("\n\nNote: the trigger payload")[0]!.slice(0, 240), output: run.output?.slice(0, 240) ?? null }));
        },
    }),
    defineCapability({
        name: "runs.get",
        title: "Get run",
        description: "Get a run: status, prompt, output, error, usage and any pending approvals.",
        readOnly: true,
        input: z.object({ runId: z.string() }),
        handler: (ctx, { runId }) => {
            const run = requireRun(ctx, runId);
            return { run, agentName: ctx.store.getAgent(run.agentId)?.name ?? run.agentId, pendingApprovals: ctx.store.listApprovals({ runId, status: "pending" }) };
        },
    }),
    defineCapability({
        name: "runs.wait",
        title: "Wait for run",
        description: "Block until a run finishes or needs an approval, up to timeoutSeconds. Returns the run either way.",
        readOnly: true,
        input: z.object({ runId: z.string(), timeoutSeconds: z.number().int().min(1).max(300).default(60) }),
        handler: (ctx, { runId, timeoutSeconds }) => waitForRun(ctx, runId, timeoutSeconds),
    }),
    defineCapability({
        name: "runs.timeline",
        title: "Run timeline",
        description:
            "The readable trace of a run: prompt, model calls, tool calls paired with results and durations, policy decisions and approvals. Start here when debugging; use runs.events for raw data.",
        readOnly: true,
        input: z.object({ runId: z.string() }),
        handler: (ctx, { runId }) => {
            const run = requireRun(ctx, runId);
            return { run: { id: run.id, status: run.status, error: run.error, usage: run.usage }, steps: buildTimeline(ctx.store.listEvents(runId)) };
        },
    }),
    defineCapability({
        name: "runs.events",
        title: "Run events (raw)",
        description: "Raw event stream of a run exactly as the runtime emitted it, paged by sequence number. Optionally filter by event type.",
        readOnly: true,
        input: z.object({ runId: z.string(), afterSeq: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(200), types: z.array(z.string()).optional() }),
        handler: (ctx, { runId, ...opts }) => {
            requireRun(ctx, runId);
            const events = ctx.store.listEvents(runId, opts);
            return { events, nextAfterSeq: events.length === opts.limit ? events.at(-1)!.seq : null };
        },
    }),
    defineCapability({
        name: "runs.explain_failure",
        title: "Explain failure",
        description: "A first diagnosis of why a run failed or misbehaved: the signals found in its trace, concrete suggestions and the last steps.",
        readOnly: true,
        input: z.object({ runId: z.string() }),
        handler: (ctx, { runId }) => explainFailure(requireRun(ctx, runId), ctx.store.listEvents(runId)),
    }),
    defineCapability({
        name: "runs.cancel",
        title: "Cancel run",
        description: "Stop a queued or running run.",
        input: z.object({ runId: z.string() }),
        handler: (ctx, { runId }) => {
            requireRun(ctx, runId);
            return ctx.engine.cancel(runId, ctx.actor);
        },
    }),
    defineCapability({
        name: "runs.replay",
        title: "Replay run",
        description: "Run the same prompt and payload again — against the agent's current active revision by default, or a specific revisionId. Use it to check that a change fixed a failure.",
        input: z.object({ runId: z.string(), revisionId: z.string().optional(), waitSeconds: z.number().int().min(0).max(300).default(0) }),
        handler: async (ctx, input) => {
            const original = requireRun(ctx, input.runId);
            const agent = requireAgent(ctx, original.agentId);
            const revision = ctx.store.getRevision(input.revisionId ?? agent.activeRevisionId);
            if (!revision || revision.agentId !== agent.id) throw new CapabilityError("Revision not found for this agent", "not_found");
            const run = ctx.store.createRun({ agentId: agent.id, revision, source: { kind: "replay", replayOf: original.id, triggerId: original.source.triggerId, actor: actorLabel(ctx.actor) }, prompt: original.prompt, payload: original.payload });
            ctx.engine.enqueue(run);
            return input.waitSeconds ? waitForRun(ctx, run.id, input.waitSeconds) : run;
        },
    }),
    defineCapability({
        name: "approvals.list",
        title: "List approvals",
        description: "List approval requests. Pending ones are agents waiting on a human decision before acting.",
        readOnly: true,
        input: z.object({ status: z.enum(["pending", "approved", "denied", "expired"]).optional().default("pending"), runId: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }),
        handler: (ctx, input) => {
            const names = new Map(ctx.store.listAgents(true).map((a) => [a.id, a.name]));
            return ctx.store.listApprovals(input).map((a) => ({ ...a, agentName: names.get(a.agentId) ?? a.agentId }));
        },
    }),
    defineCapability({
        name: "approvals.decide",
        title: "Decide approval",
        description: "Approve or deny a pending approval. The waiting run continues immediately with the decision.",
        input: z.object({ approvalId: z.string(), decision: z.enum(["approve", "deny"]), reason: z.string().optional() }),
        handler: (ctx, { approvalId, decision, reason }) => {
            const approval = ctx.store.getApproval(approvalId);
            if (!approval) throw new CapabilityError(`Approval ${approvalId} not found`, "not_found");
            if (approval.status !== "pending") throw new CapabilityError(`Approval is already ${approval.status}`, "conflict");
            return ctx.engine.decideApproval(approvalId, decision === "approve", ctx.actor, reason);
        },
    }),
];
