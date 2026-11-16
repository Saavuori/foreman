import { z } from "zod";
import type { Batch } from "../batches.ts";
import { flowMetrics, runTimeline } from "../flow.ts";
import { CapabilityError, defineCapability, actorLabel, type Ctx } from "../registry.ts";
import { requireAgent } from "./agents.ts";

const present = (ctx: Ctx, batch: Batch) => ({ ...batch, agentName: batch.agentId ? (ctx.store.getAgent(batch.agentId)?.name ?? null) : null, progress: ctx.batches.progress(batch) });
function requireBatch(ctx: Ctx, batchId: string): Batch {
    const batch = ctx.batches.get(batchId);
    if (!batch) throw new CapabilityError(`Batch ${batchId} not found`, "not_found");
    return batch;
}
const failed = (e: unknown) => new CapabilityError(e instanceof Error ? e.message : String(e), "failed");

export const flowCapabilities = [
    defineCapability({
        name: "batches.list",
        title: "List batches",
        description: "Batches are sets of tickets tracked as one job. Each comes with its progress: done, working, waiting on a person, queued, failed, total credits, and an estimated finish.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ctx.batches.list().map((b) => present(ctx, b)),
    }),
    defineCapability({
        name: "batches.get",
        title: "Get batch",
        description: "One batch with its progress and every ticket in it (key, title, state, agent, attempts).",
        readOnly: true,
        input: z.object({ batchId: z.string() }),
        handler: (ctx, { batchId }) => {
            const batch = requireBatch(ctx, batchId);
            const agents = new Map(ctx.store.listAgents(true).map((a) => [a.id, a.name]));
            const items = ctx.batches.items(batchId).map((i) => ({ id: i.id, key: i.ticket.key, title: i.ticket.title, state: i.state, agentName: i.agentId ? (agents.get(i.agentId) ?? null) : null, attempts: i.attempts, note: i.note, finishedAt: i.finishedAt }));
            return { batch: present(ctx, batch), items };
        },
    }),
    defineCapability({
        name: "batches.create",
        title: "Create a batch",
        description:
            "Track a set of tickets as one job. Give a Jira filter (jql — an epic or sprint is just a filter, e.g. \"sprint = 42\"), a list of keys, or both. The tickets are put on the board now, whether or not the intake filter would take them; routing rules apply as usual, and agentId names the agent for tickets no rule claims. One notification is sent when every ticket has finished.",
        input: z.object({ name: z.string().min(1).max(80), jql: z.string().max(2000).optional(), keys: z.array(z.string().min(1)).max(500).optional(), agentId: z.string().optional() }),
        handler: async (ctx, input) => {
            if (input.agentId) requireAgent(ctx, input.agentId);
            if (!input.jql?.trim() && !input.keys?.length) throw new CapabilityError("Give a Jira filter (jql) or a list of ticket keys", "invalid_input");
            try {
                const result = await ctx.batches.create(input);
                return { batch: present(ctx, result.batch), ticketsAdded: result.added, notFound: result.notFound };
            } catch (e) {
                throw failed(e);
            }
        },
    }),
    defineCapability({
        name: "batches.refresh",
        title: "Refresh a batch",
        description: "Run the batch's Jira filter again and take in tickets that match it now. Tickets are never removed from a batch.",
        input: z.object({ batchId: z.string() }),
        handler: async (ctx, { batchId }) => {
            requireBatch(ctx, batchId);
            try {
                const { added } = await ctx.batches.refresh(batchId);
                return { ticketsAdded: added, batch: present(ctx, ctx.batches.get(batchId)!) };
            } catch (e) {
                throw failed(e);
            }
        },
    }),
    defineCapability({
        name: "batches.retry_failed",
        title: "Retry a batch's failed tickets",
        description: "Queue another attempt for every failed ticket in the batch.",
        input: z.object({ batchId: z.string() }),
        handler: (ctx, { batchId }) => {
            requireBatch(ctx, batchId);
            return { retried: ctx.batches.retryFailed(batchId, actorLabel(ctx.actor)) };
        },
    }),
    defineCapability({
        name: "batches.delete",
        title: "Delete a batch",
        description: "Stop tracking a batch. Its tickets stay on the board and carry on.",
        destructive: true,
        input: z.object({ batchId: z.string() }),
        handler: (ctx, { batchId }) => {
            requireBatch(ctx, batchId);
            ctx.batches.delete(batchId);
            return { deleted: true };
        },
    }),
    defineCapability({
        name: "work.flow",
        title: "Flow metrics",
        description:
            "How work is flowing: tickets finished per day, median and p90 cycle time, queue depth over time, load and results per agent (with cost per ticket), the share of tickets that needed a person, tickets waiting too long, and total cost. Use it to find where work piles up.",
        readOnly: true,
        input: z.object({ days: z.number().int().min(1).max(90).default(14), hours: z.number().min(1).max(24 * 14).default(24) }),
        handler: (ctx, { days, hours }) => flowMetrics(ctx.store, { days, hours, agingMinutes: ctx.notify.settings().agingMinutes, wipPerAgent: ctx.work.settings().wipPerAgent }),
    }),
    defineCapability({
        name: "work.timeline",
        title: "Agent timeline",
        description: "Runs laid out per agent on a time axis for the last `hours`: start, end, status, the ticket each was for, and the stretches spent waiting on a person. Shows load, idle gaps and overlaps.",
        readOnly: true,
        input: z.object({ hours: z.number().min(0.25).max(24 * 7).default(6) }),
        handler: (ctx, { hours }) => runTimeline(ctx.store, hours),
    }),
];
