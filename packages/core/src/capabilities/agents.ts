import { z } from "zod";
import { CapabilityError, defineCapability, actorLabel, type Ctx } from "../registry.ts";
import { AgentSpec } from "../schemas.ts";
import { diffJson } from "../timeline.ts";

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Merge a patch into a spec: `policy` and `budget` merge key by key, everything else is replaced. */
function mergeSpec(current: AgentSpec, patch: Record<string, unknown>): AgentSpec {
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key];
        else if ((key === "policy" || key === "budget") && isPlain(value)) merged[key] = { ...(merged[key] as object), ...value };
        else merged[key] = value;
    }
    const parsed = AgentSpec.safeParse(merged);
    if (!parsed.success) throw new CapabilityError(`Invalid agent spec: ${z.prettifyError(parsed.error)}`, "invalid_input");
    checkSpec(parsed.data);
    return parsed.data;
}
/** Rules that span fields, which the schema alone cannot express. */
function checkSpec(spec: AgentSpec) {
    if (spec.provider && spec.model === "auto") throw new CapabilityError("With your own model provider, name the model (the provider's model id) instead of \"auto\"", "invalid_input");
}

export function requireAgent(ctx: Ctx, agentId: string) {
    const agent = ctx.store.getAgent(agentId);
    if (!agent) throw new CapabilityError(`Agent ${agentId} not found`, "not_found");
    return agent;
}

const SpecPatch = AgentSpec.partial()
    // Optional fields accept null, which clears them.
    .extend({ outputSchema: AgentSpec.shape.outputSchema.nullable(), reasoningEffort: AgentSpec.shape.reasoningEffort.nullable(), provider: AgentSpec.shape.provider.nullable() })
    .describe(
    "Fields of the agent spec to set. Omitted fields keep their current value; `policy` and `budget` merge key by key; pass null to clear an optional field such as outputSchema.",
);

export const agentCapabilities = [
    defineCapability({
        name: "agents.list",
        title: "List agents",
        description: "List agents with their active revision number and a 7-day health summary.",
        readOnly: true,
        input: z.object({ includeArchived: z.boolean().default(false) }),
        handler: (ctx, input) => {
            const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
            const stats = ctx.store.runStats(since);
            return ctx.store.listAgents(input.includeArchived).map((agent) => {
                const mine = stats.filter((s) => s.agentId === agent.id);
                const done = mine.filter((s) => s.status === "succeeded" || s.status === "failed");
                const revision = ctx.store.getRevision(agent.activeRevisionId)!;
                return {
                    ...agent,
                    activeRevisionNumber: revision.number,
                    runtime: revision.spec.runtime,
                    model: revision.spec.model,
                    autonomy: revision.spec.policy.autonomy,
                    triggerCount: ctx.store.listTriggers(agent.id).length,
                    runs7d: mine.length,
                    successRate7d: done.length ? done.filter((s) => s.status === "succeeded").length / done.length : null,
                    credits7d: Math.round(mine.reduce((sum, s) => sum + s.usage.credits, 0) * 100) / 100,
                };
            });
        },
    }),
    defineCapability({
        name: "agents.get",
        title: "Get agent",
        description: "Get an agent with its active revision (full spec) and triggers.",
        readOnly: true,
        input: z.object({ agentId: z.string() }),
        handler: (ctx, { agentId }) => {
            const agent = requireAgent(ctx, agentId);
            return { agent, revision: ctx.store.getRevision(agent.activeRevisionId)!, triggers: ctx.store.listTriggers(agentId) };
        },
    }),
    defineCapability({
        name: "agents.create",
        title: "Create agent",
        description:
            "Create an agent. The spec becomes revision 1. Unset spec fields take safe defaults: autonomy `propose` (writes need approval), the minimum credit budget and no tools.",
        input: z.object({
            name: z.string().min(1).max(80),
            description: z.string().max(500).default(""),
            spec: AgentSpec.default(() => AgentSpec.parse({})),
            note: z.string().default("Initial revision"),
        }),
        handler: (ctx, input) => {
            checkSpec(input.spec);
            const created = ctx.store.createAgent({ ...input, actor: actorLabel(ctx.actor) });
            ctx.bus.emit("change", "agents");
            return created;
        },
    }),
    defineCapability({
        name: "agents.update",
        title: "Update agent",
        description:
            "Rename an agent and/or change its spec. A spec change creates a new immutable revision; set activate=false to save it as a draft that only runs when requested by revisionId.",
        input: z.object({
            agentId: z.string(),
            name: z.string().min(1).max(80).optional(),
            description: z.string().max(500).optional(),
            spec: SpecPatch.optional(),
            note: z.string().default(""),
            activate: z.boolean().default(true),
        }),
        handler: (ctx, input, raw) => {
            const agent = requireAgent(ctx, input.agentId);
            let revision = ctx.store.getRevision(agent.activeRevisionId)!;
            let changed = false;
            if (raw.spec && Object.keys(raw.spec).length) {
                const next = mergeSpec(revision.spec, raw.spec);
                if (JSON.stringify(next) !== JSON.stringify(revision.spec)) {
                    revision = ctx.store.addRevision(agent.id, next, input.note, actorLabel(ctx.actor), input.activate);
                    changed = true;
                }
            }
            const updated = ctx.store.updateAgentMeta(agent.id, { name: input.name, description: input.description });
            ctx.bus.emit("change", "agents");
            return { agent: updated, revision, revisionCreated: changed };
        },
    }),
    defineCapability({
        name: "agents.archive",
        title: "Archive agent",
        description: "Archive (or restore) an agent. Archived agents stop accepting triggers; history is kept.",
        destructive: true,
        input: z.object({ agentId: z.string(), archived: z.boolean().default(true) }),
        handler: (ctx, { agentId, archived }) => {
            requireAgent(ctx, agentId);
            const agent = ctx.store.updateAgentMeta(agentId, { archived });
            ctx.bus.emit("change", "agents");
            return agent;
        },
    }),
    defineCapability({
        name: "revisions.list",
        title: "List revisions",
        description: "List an agent's revisions, newest first, marking which one is active.",
        readOnly: true,
        input: z.object({ agentId: z.string() }),
        handler: (ctx, { agentId }) => {
            const agent = requireAgent(ctx, agentId);
            return ctx.store.listRevisions(agentId).map(({ spec: _spec, ...r }) => ({ ...r, active: r.id === agent.activeRevisionId }));
        },
    }),
    defineCapability({
        name: "revisions.get",
        title: "Get revision",
        description: "Get one revision with its full spec.",
        readOnly: true,
        input: z.object({ revisionId: z.string() }),
        handler: (ctx, { revisionId }) => {
            const revision = ctx.store.getRevision(revisionId);
            if (!revision) throw new CapabilityError(`Revision ${revisionId} not found`, "not_found");
            return revision;
        },
    }),
    defineCapability({
        name: "revisions.diff",
        title: "Diff revisions",
        description: "List the spec fields that differ between two revisions of an agent.",
        readOnly: true,
        input: z.object({ fromRevisionId: z.string(), toRevisionId: z.string() }),
        handler: (ctx, { fromRevisionId, toRevisionId }) => {
            const from = ctx.store.getRevision(fromRevisionId);
            const to = ctx.store.getRevision(toRevisionId);
            if (!from || !to) throw new CapabilityError("Revision not found", "not_found");
            return { from: from.number, to: to.number, changes: diffJson(from.spec, to.spec) };
        },
    }),
    defineCapability({
        name: "revisions.activate",
        title: "Activate revision",
        description: "Make a revision the active one. Use it to promote a draft or roll back to an earlier revision.",
        input: z.object({ revisionId: z.string() }),
        handler: (ctx, { revisionId }) => {
            const revision = ctx.store.getRevision(revisionId);
            if (!revision) throw new CapabilityError(`Revision ${revisionId} not found`, "not_found");
            const agent = ctx.store.updateAgentMeta(revision.agentId, { activeRevisionId: revisionId });
            ctx.bus.emit("change", "agents");
            return { agent, activeRevisionNumber: revision.number };
        },
    }),
];
