import { z } from "zod";
import { CapabilityError, defineCapability, actorLabel, type Ctx } from "../registry.ts";
import { DEFAULT_TICKET_PROMPT, JiraAuth, JiraSettings, JiraWriteBack, RoutingMatch, Ticket, WorkState, type WorkItem } from "../schemas.ts";
import { ruleMatches } from "../work.ts";
import { requireAgent } from "./agents.ts";

/** Wrap WorkHub errors (plain Errors) so the API answers 409 rather than 500. */
const guard = <T>(fn: () => T): T => {
    try {
        return fn();
    } catch (e) {
        if (e instanceof CapabilityError) throw e;
        const message = e instanceof Error ? e.message : String(e);
        throw new CapabilityError(message, /not found/i.test(message) ? "not_found" : "conflict");
    }
};

function present(ctx: Ctx, items: WorkItem[]) {
    const agents = new Map(ctx.store.listAgents(true).map((a) => [a.id, a.name]));
    const approvals = ctx.store.listApprovals({ status: "pending", limit: 500 });
    const membership = ctx.batches.membership();
    return items.map((item) => {
        const approval = item.state === "needs_you" && item.runId ? approvals.find((a) => a.runId === item.runId) : undefined;
        return { ...item, batches: membership.get(item.id) ?? [], agentName: item.agentId ? (agents.get(item.agentId) ?? item.agentId) : null, pendingApproval: approval ? { id: approval.id, summary: approval.summary, kind: approval.kind } : null };
    });
}

export const workCapabilities = [
    defineCapability({
        name: "work.list",
        title: "List work items",
        description:
            "The work queue: tickets taken from Jira with their state (inbox, queued, working, needs_you, review, done, failed, skipped), agent, progress and queue order. Finished items older than `finishedWithinHours` are left out.",
        readOnly: true,
        input: z.object({ states: z.array(WorkState).optional(), agentId: z.string().optional(), project: z.string().optional(), batchId: z.string().optional().describe("Only tickets in this batch"), finishedWithinHours: z.number().min(1).max(24 * 90).default(24), limit: z.number().int().min(1).max(1000).default(300) }),
        handler: (ctx, input) => {
            const items = ctx.store.listWorkItems({ ...input, finishedSince: new Date(Date.now() - input.finishedWithinHours * 3_600_000).toISOString() });
            if (!input.batchId) return present(ctx, items);
            const inBatch = new Set(ctx.batches.itemIds(input.batchId));
            return present(ctx, items.filter((i) => inBatch.has(i.id)));
        },
    }),
    defineCapability({
        name: "work.get",
        title: "Get work item",
        description: "One work item with its ticket snapshot, every attempt (run) made at it, and the routing rule that placed it.",
        readOnly: true,
        input: z.object({ itemId: z.string().describe("Work item id, or a ticket key such as PAY-123") }),
        handler: (ctx, { itemId }) => {
            const item = ctx.store.getWorkItem(itemId) ?? ctx.store.findWorkItem("jira", itemId);
            if (!item) throw new CapabilityError(`Work item ${itemId} not found`, "not_found");
            const attempts = ctx.store.listRunsForWorkItem(item.id).map(({ payload: _p, prompt: _prompt, ...run }) => run);
            return { item: present(ctx, [item])[0]!, attempts, rule: item.ruleId ? (ctx.store.getRule(item.ruleId) ?? null) : null };
        },
    }),
    defineCapability({
        name: "work.add",
        title: "Add tickets by key",
        description: "Fetch specific Jira tickets and put them on the board, even if the intake filter would not pick them up. Tickets that match no routing rule land in the inbox.",
        input: z.object({ keys: z.array(z.string().min(1)).min(1).max(50) }),
        handler: async (ctx, { keys }) => {
            const result = await ctx.work.addByKeys(keys);
            return { added: present(ctx, result.added), alreadyOnBoard: result.existing.map((i) => i.ticket.key), notFound: result.missing };
        },
    }),
    defineCapability({
        name: "work.sync",
        title: "Check Jira now",
        description: "Poll Jira immediately instead of waiting for the next scheduled check.",
        input: z.object({}),
        handler: async (ctx) => {
            try {
                return await ctx.work.poll();
            } catch (e) {
                throw new CapabilityError(e instanceof Error ? e.message : String(e), "failed");
            }
        },
    }),
    defineCapability({
        name: "work.assign",
        title: "Assign to an agent",
        description: "Give a work item to an agent and queue it. Use it for inbox items or to hand a failed ticket to a different agent.",
        input: z.object({ itemId: z.string(), agentId: z.string() }),
        handler: (ctx, { itemId, agentId }) => {
            requireAgent(ctx, agentId);
            return present(ctx, [guard(() => ctx.work.assign(itemId, agentId))])[0];
        },
    }),
    defineCapability({
        name: "work.answer",
        title: "Answer an agent's question",
        description: "Answer the question an agent asked about a ticket (the item is in needs_you with a note starting \"Question:\"). The agent continues straight away with the answer.",
        input: z.object({ itemId: z.string().describe("Work item id, or a ticket key such as PAY-123"), answer: z.string().min(1).max(4000) }),
        handler: (ctx, { itemId, answer }) => {
            const item = ctx.store.getWorkItem(itemId) ?? ctx.store.findWorkItem("jira", itemId);
            if (!item) throw new CapabilityError(`Work item ${itemId} not found`, "not_found");
            return present(ctx, [guard(() => ctx.work.answer(item.id, answer, ctx.actor))])[0];
        },
    }),
    defineCapability({
        name: "work.retry",
        title: "Retry a work item",
        description: "Queue another attempt. If an attempt is in progress it is stopped first.",
        input: z.object({ itemId: z.string() }),
        handler: (ctx, { itemId }) => present(ctx, [guard(() => ctx.work.retry(itemId, actorLabel(ctx.actor)))])[0],
    }),
    defineCapability({
        name: "work.hold",
        title: "Hold or release",
        description: "A held item keeps its place in the queue but is not started until released.",
        input: z.object({ itemId: z.string(), held: z.boolean().default(true) }),
        handler: (ctx, { itemId, held }) => present(ctx, [guard(() => ctx.work.hold(itemId, held))])[0],
    }),
    defineCapability({
        name: "work.rank",
        title: "Reorder the queue",
        description: "Move a queued item to the top, the bottom, or just ahead of another item.",
        input: z.object({ itemId: z.string(), position: z.enum(["top", "bottom"]).optional(), beforeItemId: z.string().optional() }),
        handler: (ctx, { itemId, ...where }) => {
            if (!where.position && !where.beforeItemId) throw new CapabilityError("Give a position or beforeItemId", "invalid_input");
            return present(ctx, [guard(() => ctx.work.rank(itemId, where))])[0];
        },
    }),
    defineCapability({
        name: "work.skip",
        title: "Skip a work item",
        description: "Decide not to handle a ticket. Stops any attempt in progress. The item can be retried later.",
        destructive: true,
        input: z.object({ itemId: z.string(), reason: z.string().optional() }),
        handler: (ctx, { itemId, reason }) => present(ctx, [guard(() => ctx.work.skip(itemId, reason, actorLabel(ctx.actor)))])[0],
    }),
    defineCapability({
        name: "work.complete",
        title: "Mark as done",
        description: "Accept a work item that is waiting in review (or close out a failed one by hand).",
        input: z.object({ itemId: z.string() }),
        handler: (ctx, { itemId }) => present(ctx, [guard(() => ctx.work.complete(itemId))])[0],
    }),
    defineCapability({
        name: "work.stats",
        title: "Queue statistics",
        description: "Flow numbers for the work queue: items per state, done in the last day, median and p90 cycle time, oldest queued item, and the share finished on the first attempt.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ctx.work.stats(),
    }),
    defineCapability({
        name: "routing.list",
        title: "List routing rules",
        description: "Rules that decide which agent gets which ticket, in the order they are tried.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => {
            const agents = new Map(ctx.store.listAgents(true).map((a) => [a.id, a.name]));
            return ctx.store.listRules().map((r) => ({ ...r, agentName: agents.get(r.agentId) ?? r.agentId }));
        },
    }),
    defineCapability({
        name: "routing.create",
        title: "Create routing rule",
        description:
            "Send matching tickets to an agent. All given match fields must match; an empty match catches everything. Set review=true to stop finished tickets for a human check. Inbox items are re-routed straight away.",
        input: z.object({ name: z.string().min(1).max(80), match: RoutingMatch.default({}), agentId: z.string(), review: z.boolean().default(false), promptTemplate: z.string().min(1).default(DEFAULT_TICKET_PROMPT), enabled: z.boolean().default(true) }),
        handler: (ctx, input) => {
            requireAgent(ctx, input.agentId);
            const rule = ctx.store.createRule(input);
            const rerouted = ctx.work.rerouteInbox();
            ctx.bus.emit("change", "work");
            return { rule, inboxItemsRouted: rerouted };
        },
    }),
    defineCapability({
        name: "routing.update",
        title: "Update routing rule",
        description: "Change a rule's match, agent, review setting, prompt, order (position) or enable/disable it.",
        input: z.object({ ruleId: z.string(), name: z.string().min(1).max(80).optional(), match: RoutingMatch.optional(), agentId: z.string().optional(), review: z.boolean().optional(), promptTemplate: z.string().min(1).optional(), enabled: z.boolean().optional(), position: z.number().int().optional() }),
        handler: (ctx, { ruleId, ...patch }) => {
            if (!ctx.store.getRule(ruleId)) throw new CapabilityError(`Rule ${ruleId} not found`, "not_found");
            if (patch.agentId) requireAgent(ctx, patch.agentId);
            const rule = ctx.store.updateRule(ruleId, patch);
            const rerouted = ctx.work.rerouteInbox();
            ctx.bus.emit("change", "work");
            return { rule, inboxItemsRouted: rerouted };
        },
    }),
    defineCapability({
        name: "routing.delete",
        title: "Delete routing rule",
        description: "Delete a rule. Tickets it already routed keep their agent.",
        destructive: true,
        input: z.object({ ruleId: z.string() }),
        handler: (ctx, { ruleId }) => {
            if (!ctx.store.getRule(ruleId)) throw new CapabilityError(`Rule ${ruleId} not found`, "not_found");
            ctx.store.deleteRule(ruleId);
            ctx.bus.emit("change", "work");
            return { deleted: true };
        },
    }),
    defineCapability({
        name: "routing.test",
        title: "Test routing",
        description: "Dry run: which rule and agent would a ticket get? Give a ticket already on the board by key, or describe one.",
        readOnly: true,
        input: z.object({ key: z.string().optional(), ticket: Ticket.partial().optional() }),
        handler: (ctx, { key, ticket }) => {
            const known = key ? ctx.store.findWorkItem("jira", key)?.ticket : undefined;
            if (key && !known) throw new CapabilityError(`${key} is not on the board; describe the ticket instead`, "not_found");
            const subject = known ?? Ticket.parse({ key: "TEST-1", url: "", title: "Test ticket", project: "TEST", updatedAt: new Date().toISOString(), ...ticket });
            const rules = ctx.store.listRules();
            const winner = rules.find((r) => r.enabled && ruleMatches(r.match, subject));
            return { ticket: { key: subject.key, project: subject.project, type: subject.type, priority: subject.priority, labels: subject.labels }, matchedRule: winner ?? null, agentName: winner ? (ctx.store.getAgent(winner.agentId)?.name ?? null) : null, outcome: winner ? "queued" : "inbox" };
        },
    }),
    defineCapability({
        name: "jira.settings",
        title: "Jira intake settings",
        description:
            "How Foreman talks to Jira: site, sign-in (by secret name; the token is never shown), the JQL filter that opts tickets in, poll interval, limits, what Foreman writes back to tickets, the result of the last check and the most recent write-backs.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => {
            const settings = ctx.work.settings();
            return {
                ...settings,
                usingMock: ctx.work.isMock(),
                tokenStored: settings.auth.type === "none" || ctx.vault.has(settings.auth.secretName),
                lastPoll: ctx.work.lastPoll,
                recentWriteBacks: ctx.work.writeLog.slice(0, 20),
                mock: { issues: ctx.mockJira.list().length, generatorPerMinute: ctx.mockJira.perMinute },
            };
        },
    }),
    defineCapability({
        name: "jira.test",
        title: "Test the Jira connection",
        description: "Ask Jira who the configured credentials belong to. Changes nothing. Use it after setting the site or token.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ctx.work.testConnection(),
    }),
    defineCapability({
        name: "jira.configure",
        title: "Configure Jira intake",
        description:
            "Change how Foreman talks to Jira. Leave baseUrl empty to use the built-in mock Jira. For a real site set flavor (cloud or datacenter) and auth: {type: basic, email, secretName} for Jira Cloud with an API token, or {type: bearer, secretName} for a personal access token — store the token first with secrets.set. writeBack controls the comments and status changes Foreman makes itself; it is off until enabled. Only the fields given are changed.",
        input: JiraSettings.omit({ auth: true, writeBack: true }).partial().extend({ auth: JiraAuth.partial().optional(), writeBack: JiraWriteBack.partial().optional() }),
        handler: (ctx, _input, raw) => {
            const patch = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k in JiraSettings.shape)) as Parameters<typeof ctx.work.updateSettings>[0];
            const auth = { ...ctx.work.settings().auth, ...patch.auth };
            if (auth.type !== "none") {
                if (!auth.secretName) throw new CapabilityError("Give auth.secretName: the name of the stored token (secrets.set)", "invalid_input");
                if (!ctx.vault.has(auth.secretName)) throw new CapabilityError(`Secret "${auth.secretName}" does not exist; store the token first with secrets.set`, "invalid_input");
                if (auth.type === "basic" && !auth.email) throw new CapabilityError("Jira Cloud sign-in needs auth.email as well as the token", "invalid_input");
            }
            if (typeof patch.baseUrl === "string" && patch.baseUrl && !/^https?:\/\//i.test(patch.baseUrl)) throw new CapabilityError("baseUrl must start with http:// or https://", "invalid_input");
            return { ...ctx.work.updateSettings(patch), usingMock: ctx.work.isMock() };
        },
    }),
    defineCapability({
        name: "mockjira.create_issue",
        title: "File a mock Jira ticket",
        description: "Create a ticket in the built-in mock Jira, as a person would in the real one. Add a label like mock:flaky or mock:needs-approval to choose how the mock agent behaves on it. Leave summary empty for a generated ticket.",
        input: z.object({ summary: z.string().optional(), project: z.string().optional(), type: z.string().optional(), priority: z.string().optional(), description: z.string().optional(), labels: z.array(z.string()).optional() }),
        handler: (ctx, input) => {
            const issue = input.summary ? ctx.mockJira.create({ ...input, summary: input.summary }) : ctx.mockJira.generate();
            return { key: issue.key, summary: issue.fields.summary, labels: issue.fields.labels, note: "It reaches the board on the next Jira check (work.sync checks now)." };
        },
    }),
    defineCapability({
        name: "mockjira.generator",
        title: "Mock ticket generator",
        description: "Have the mock Jira file new tickets on its own, at a rate per minute. 0 stops it.",
        input: z.object({ perMinute: z.number().min(0).max(60) }),
        handler: (ctx, { perMinute }) => {
            ctx.mockJira.setGenerator(perMinute);
            ctx.bus.emit("change", "work");
            return { perMinute: ctx.mockJira.perMinute };
        },
    }),
];
