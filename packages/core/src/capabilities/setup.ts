import { z } from "zod";
import { actorLabel, CapabilityError, defineCapability } from "../registry.ts";
import { AGENT_TEMPLATES, exampleTask, loadSamples, removeSamples, sampleRecord, setupStatus } from "../onboarding.ts";
import { AgentSpec } from "../schemas.ts";
import { requireAgent } from "./agents.ts";

export const setupCapabilities = [
    defineCapability({
        name: "setup.status",
        title: "Getting-started checklist",
        description:
            "The steps to a working setup (an agent, a first run, ticket intake, a routing rule) and the optional ones (notifications, a real model, an MCP client), each marked done from what is really configured. `next` is the first required step not yet done; null means the basics are set up. Sample data does not count as done.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => setupStatus(ctx),
    }),
    defineCapability({
        name: "setup.hide",
        title: "Hide or show the checklist",
        description: "Hide the getting-started checklist on the board, or show it again. Changes nothing else.",
        input: z.object({ hidden: z.boolean().default(true) }),
        handler: (ctx, { hidden }) => {
            ctx.store.setSetting("setup.hidden", hidden);
            ctx.bus.emit("change", "setup");
            return { hidden };
        },
    }),
    defineCapability({
        name: "agents.templates",
        title: "Agent templates",
        description:
            "Ready-made agents to start from: a name, what it is for, what a first run shows, and a spec. Create one by passing its name, description and spec to agents.create. Every template runs on the simulator with autonomy `propose`, so nothing changes without approval.",
        readOnly: true,
        input: z.object({}),
        handler: () => AGENT_TEMPLATES.map((t) => ({ ...t, spec: AgentSpec.parse(t.spec) })),
    }),
    defineCapability({
        name: "agents.example_task",
        title: "Example task for an agent",
        description:
            "A task to try an agent with on the test bench, chosen from its tools. For an agent with Jira tools and the built-in practice Jira, it names a real practice ticket; with a real Jira site, put one of your own ticket keys in. `ticketKey` is the ticket used, if any.",
        readOnly: true,
        input: z.object({ agentId: z.string() }),
        handler: (ctx, { agentId }) => {
            const agent = requireAgent(ctx, agentId);
            return exampleTask(ctx, ctx.store.getRevision(agent.activeRevisionId)!.spec.tools);
        },
    }),
    defineCapability({
        name: "samples.load",
        title: "Load sample data",
        description:
            "Add sample agents on the simulator, routing rules for the built-in practice Jira and a Teams preview channel, and switch on ticket pickup if it is off and no real Jira is set up. Use it to look around with realistic content. Remove it all again with samples.remove; your own agents and settings are not touched.",
        input: z.object({}),
        handler: (ctx) => {
            if (sampleRecord(ctx)) throw new CapabilityError("Sample data is already loaded. Remove it first to load it again.", "conflict");
            const record = loadSamples(ctx, actorLabel(ctx.actor));
            ctx.bus.emit("change", "setup");
            return { agents: record.agentIds.length, rules: record.ruleIds.length, channels: record.channelIds.length, intakeSwitchedOn: record.enabledIntake };
        },
    }),
    defineCapability({
        name: "samples.remove",
        title: "Remove sample data",
        description:
            "Remove what samples.load added: the sample agents are archived (their runs stay in history), their routing rules and the Teams preview channel are deleted, and ticket pickup is switched back off if loading switched it on and no rule is left. Tickets already on the work board stay there.",
        destructive: true,
        input: z.object({}),
        handler: (ctx) => {
            if (!sampleRecord(ctx)) throw new CapabilityError("No sample data is loaded.", "not_found");
            const removed = removeSamples(ctx);
            ctx.bus.emit("change", "setup");
            return removed;
        },
    }),
];
