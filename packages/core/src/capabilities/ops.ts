import { z } from "zod";
import { CapabilityError, defineCapability, type Ctx } from "../registry.ts";
import { TriggerConfig, type Trigger } from "../schemas.ts";
import { validateCron } from "../triggers.ts";
import { MOCK_SCENARIOS } from "../mock.ts";
import { requireAgent } from "./agents.ts";

const present = (ctx: Ctx, t: Trigger) => ({
    ...t,
    nextRunAt: ctx.triggers.nextRun(t.id),
    webhookUrl: t.config.kind === "webhook" ? `${ctx.info.baseUrl}/hooks/${t.id}/${t.secret}` : null,
});

function checkConfig(config: TriggerConfig) {
    if (config.kind !== "schedule") return;
    try {
        if (!validateCron(config.cron, config.timezone)) throw new Error("it never fires");
    } catch (e) {
        throw new CapabilityError(`Invalid schedule "${config.cron}" (${config.timezone}): ${e instanceof Error ? e.message : e}`, "invalid_input");
    }
}

export const opsCapabilities = [
    defineCapability({
        name: "triggers.list",
        title: "List triggers",
        description: "List triggers, optionally for one agent. Includes the next scheduled fire time and the webhook URL.",
        readOnly: true,
        input: z.object({ agentId: z.string().optional() }),
        handler: (ctx, { agentId }) => ctx.store.listTriggers(agentId).map((t) => present(ctx, t)),
    }),
    defineCapability({
        name: "triggers.create",
        title: "Create trigger",
        description:
            "Attach a trigger to an agent. `schedule` fires on a cron expression; `webhook` returns a secret URL that accepts POSTed JSON. The promptTemplate becomes the run's prompt; `{{payload}}` and `{{payload.path}}` insert trigger data.",
        input: z.object({
            agentId: z.string(),
            name: z.string().min(1).max(80),
            config: TriggerConfig,
            promptTemplate: z.string().min(1),
            enabled: z.boolean().default(true),
        }),
        handler: (ctx, input) => {
            requireAgent(ctx, input.agentId);
            checkConfig(input.config);
            const trigger = ctx.store.createTrigger(input);
            ctx.triggers.sync(trigger);
            ctx.bus.emit("change", "triggers");
            return present(ctx, trigger);
        },
    }),
    defineCapability({
        name: "triggers.update",
        title: "Update trigger",
        description: "Change a trigger's name, schedule or webhook config, prompt template, or enable/disable it.",
        input: z.object({ triggerId: z.string(), name: z.string().min(1).max(80).optional(), config: TriggerConfig.optional(), promptTemplate: z.string().min(1).optional(), enabled: z.boolean().optional() }),
        handler: (ctx, { triggerId, ...patch }) => {
            if (!ctx.store.getTrigger(triggerId)) throw new CapabilityError(`Trigger ${triggerId} not found`, "not_found");
            if (patch.config) checkConfig(patch.config);
            const trigger = ctx.store.updateTrigger(triggerId, patch);
            ctx.triggers.sync(trigger);
            ctx.bus.emit("change", "triggers");
            return present(ctx, trigger);
        },
    }),
    defineCapability({
        name: "triggers.delete",
        title: "Delete trigger",
        description: "Delete a trigger. Runs it already started are kept.",
        destructive: true,
        input: z.object({ triggerId: z.string() }),
        handler: (ctx, { triggerId }) => {
            if (!ctx.store.getTrigger(triggerId)) throw new CapabilityError(`Trigger ${triggerId} not found`, "not_found");
            ctx.store.deleteTrigger(triggerId);
            ctx.triggers.sync({ id: triggerId, deleted: true });
            ctx.bus.emit("change", "triggers");
            return { deleted: true };
        },
    }),
    defineCapability({
        name: "triggers.fire",
        title: "Fire trigger",
        description: "Fire a trigger now with a test payload, exactly as the schedule or webhook would. Works on disabled triggers.",
        input: z.object({ triggerId: z.string(), payload: z.unknown().optional() }),
        handler: (ctx, { triggerId, payload }) => {
            const result = ctx.triggers.fire(triggerId, payload ?? { test: true }, ctx.actor.kind === "mcp" ? "mcp" : "manual", `${ctx.actor.kind}:${ctx.actor.id}`);
            if (!result.fired) throw new CapabilityError(result.reason, "conflict");
            return result.run;
        },
    }),
    defineCapability({
        name: "insights.summary",
        title: "Insights summary",
        description: "Run counts, success rate, spend and latency over a window, overall and per agent.",
        readOnly: true,
        input: z.object({ days: z.number().min(1).max(90).default(7), agentId: z.string().optional() }),
        handler: (ctx, { days, agentId }) => {
            const stats = ctx.store.runStats(new Date(Date.now() - days * 86_400_000).toISOString(), agentId);
            const names = new Map(ctx.store.listAgents(true).map((a) => [a.id, a.name]));
            const roll = (rows: typeof stats) => {
                const done = rows.filter((r) => r.status === "succeeded" || r.status === "failed");
                const durations = rows.map((r) => r.durationMs).filter((d): d is number => d != null).sort((a, b) => a - b);
                return {
                    runs: rows.length,
                    succeeded: rows.filter((r) => r.status === "succeeded").length,
                    failed: rows.filter((r) => r.status === "failed").length,
                    cancelled: rows.filter((r) => r.status === "cancelled").length,
                    active: rows.filter((r) => ["queued", "running", "waiting_approval"].includes(r.status)).length,
                    successRate: done.length ? done.filter((r) => r.status === "succeeded").length / done.length : null,
                    credits: Math.round(rows.reduce((s, r) => s + r.usage.credits, 0) * 100) / 100,
                    inputTokens: rows.reduce((s, r) => s + r.usage.inputTokens, 0),
                    outputTokens: rows.reduce((s, r) => s + r.usage.outputTokens, 0),
                    toolCalls: rows.reduce((s, r) => s + r.usage.toolCalls, 0),
                    medianDurationMs: durations.length ? durations[Math.floor(durations.length / 2)]! : null,
                };
            };
            const byAgent = [...new Set(stats.map((s) => s.agentId))].map((id) => ({ agentId: id, agentName: names.get(id) ?? id, ...roll(stats.filter((s) => s.agentId === id)) }));
            return { days, total: roll(stats), byAgent: byAgent.sort((a, b) => b.runs - a.runs), pendingApprovals: ctx.store.listApprovals({ status: "pending" }).length, engine: ctx.engine.stats() };
        },
    }),
    defineCapability({
        name: "insights.tool_usage",
        title: "Tool usage",
        description: "Which tools agents actually call: call counts, failure counts and average duration. Use it to spot unused or failing tools.",
        readOnly: true,
        input: z.object({ days: z.number().min(1).max(90).default(7), agentId: z.string().optional() }),
        handler: (ctx, { days, agentId }) => {
            const events = ctx.store.toolEvents(new Date(Date.now() - days * 86_400_000).toISOString(), agentId);
            const tools = new Map<string, { tool: string; calls: number; failures: number }>();
            const open = new Map<string, string>();
            for (const e of events) {
                const key = `${e.runId}:${e.data?.toolCallId}`;
                if (e.type === "tool.execution_start") {
                    const tool = String(e.data?.toolName ?? "unknown");
                    open.set(key, tool);
                    const row = tools.get(tool) ?? { tool, calls: 0, failures: 0 };
                    row.calls++;
                    tools.set(tool, row);
                } else if (e.data?.success === false || e.data?.error) {
                    const row = tools.get(open.get(key) ?? String(e.data?.toolName));
                    if (row) row.failures++;
                }
            }
            return { days, tools: [...tools.values()].sort((a, b) => b.calls - a.calls) };
        },
    }),
    defineCapability({
        name: "audit.list",
        title: "Audit log",
        description: "Every state-changing capability call: who (user, MCP client, trigger), what, with which input, and whether it succeeded.",
        readOnly: true,
        input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
        handler: (ctx, { limit }) => ctx.store.listAudit(limit),
    }),
    defineCapability({
        name: "system.info",
        title: "System info",
        description: "Server version, runtime health (including whether Copilot is reachable and authorised), engine load and MCP endpoint.",
        readOnly: true,
        input: z.object({}),
        handler: async (ctx) => ({
            ...ctx.info,
            mcpUrl: `${ctx.info.baseUrl}/mcp`,
            engine: ctx.engine.stats(),
            runtimes: await Promise.all(Object.values(ctx.runtimes).map(async (r) => ({ name: r.name, ...(await r.status().catch((e) => ({ ok: false, detail: String(e?.message ?? e) }))) }))),
            capabilities: ctx.registry.describe().length,
        }),
    }),
    defineCapability({
        name: "system.models",
        title: "List models",
        description: "Models each runtime can use.",
        readOnly: true,
        input: z.object({}),
        handler: async (ctx) =>
            Promise.all(
                Object.values(ctx.runtimes).map(async (r) => {
                    try {
                        return { runtime: r.name, models: (await r.listModels?.()) ?? [], error: null };
                    } catch (e) {
                        return { runtime: r.name, models: [], error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
                    }
                }),
            ),
    }),
    defineCapability({
        name: "system.mock_scenarios",
        title: "List mock scenarios",
        description:
            "Scripted behaviours of the mock runtime (clean success, stops for approval, tool failure, timeout, …). Set one with agents.update spec.mock.scenario, use \"random\" for a seeded mix, or put [mock:name] in a prompt to choose per run.",
        readOnly: true,
        input: z.object({}),
        handler: () => [...MOCK_SCENARIOS.map(({ name, title, description }) => ({ name, title, description })), { name: "random", title: "Random mix", description: "Picks a different scenario per run, mostly successes. The same run always plays the same way." }],
    }),
    defineCapability({
        name: "capabilities.search",
        title: "Search capabilities",
        description: "Find capabilities by keyword. Returns names, descriptions and input schemas — useful when only a subset of tools is loaded.",
        readOnly: true,
        input: z.object({ query: z.string().default("") }),
        handler: (ctx, { query }) => {
            const q = query.toLowerCase().split(/\s+/).filter(Boolean);
            return ctx.registry.describe().filter((c) => q.every((w) => `${c.name} ${c.title} ${c.description}`.toLowerCase().includes(w)));
        },
    }),
];
