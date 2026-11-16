import { z } from "zod";
import { ChannelKind, EVENT_KINDS, EventKind, maskUrl, NotifySettings, Severity, toAdaptiveCard, type Channel, type NotifyEvent } from "../notify.ts";
import { CapabilityError, defineCapability, actorLabel, type Ctx } from "../registry.ts";

/** Channels are listed without their posting address, which is a secret. */
const present = (c: Channel) => ({ id: c.id, name: c.name, kind: c.kind, enabled: c.enabled, address: c.kind === "mock_teams" ? "Built-in preview" : maskUrl(c.webhookUrl), createdAt: c.createdAt });

function requireChannel(ctx: Ctx, channelId: string): Channel {
    const channel = ctx.notify.getChannel(channelId);
    if (!channel) throw new CapabilityError(`Channel ${channelId} not found`, "not_found");
    return channel;
}
function checkUrl(kind: string, url: string | undefined) {
    if (kind === "mock_teams") return;
    if (!url || !/^https?:\/\//i.test(url)) throw new CapabilityError("A webhook address starting with http:// or https:// is required", "invalid_input");
}

const sample = (ctx: Ctx, kind: EventKind): NotifyEvent => {
    const base = ctx.info.baseUrl;
    const samples: Record<EventKind, Omit<NotifyEvent, "kind" | "dedupeKey" | "path">> = {
        approval_needed: { severity: "warning", title: "PAY-181: Release assistant needs your approval", text: "It wants to: shell: git push origin fix/session-expiry-utc", facts: [["Ticket", "PAY-181 Partial refund is rounded up"], ["Agent", "Release assistant"], ["Action", "shell"]], links: [{ title: "Review and decide", url: `${base}/#/work` }, { title: "Open in Jira", url: `${base}/mock/jira/browse/PAY-181` }] },
        question_asked: { severity: "warning", title: "PAY-185: Bug triage has a question", text: "The API and the invoice round refunds differently. Which rule is correct: half-even or half-up?", facts: [["Ticket", "PAY-185 Refund total differs between the API and the invoice"], ["Reporter", "Mock Reporter"], ["Agent", "Bug triage"]], links: [{ title: "Answer", url: `${base}/#/work` }, { title: "Open in Jira", url: `${base}/mock/jira/browse/PAY-185` }] },
        jira_write_failed: { severity: "warning", title: "Could not update PAY-181 in Jira", text: "Jira answered 403 for POST /issue/PAY-181/comment (the account is not allowed to do this)", facts: [], links: [{ title: "Open in Foreman", url: `${base}/#/work` }] },
        ticket_review: { severity: "info", title: "DOC-169 is ready for review", text: "Migration guide still describes the v3 config format", facts: [["Ticket", "DOC-169"], ["Agent", "Docs keeper"], ["Attempts", "1"], ["Took", "4 min"]], links: [{ title: "Open in Foreman", url: `${base}/#/work` }] },
        ticket_done: { severity: "success", title: "WEB-188 is done", text: "Login button unresponsive on Safari 18", facts: [["Ticket", "WEB-188"], ["Agent", "Bug triage"], ["Attempts", "1"], ["Took", "6 min"]], links: [{ title: "Open in Foreman", url: `${base}/#/work` }] },
        ticket_failed: { severity: "error", title: "PAY-184 failed: Reconcile yesterday's orders", text: "Upstream connection reset (ECONNRESET). This is usually transient — replay the run.", facts: [["Ticket", "PAY-184"], ["Agent", "Order sync"], ["Attempts", "2"]], links: [{ title: "Open in Foreman", url: `${base}/#/work` }] },
        run_failed: { severity: "error", title: "Dependency auditor failed a run", text: "Timed out after 600s (budget.timeoutSeconds)", facts: [["Agent", "Dependency auditor"], ["Started by", "schedule"]], links: [{ title: "Open the trace", url: `${base}/#/runs` }] },
        ticket_aging: { severity: "warning", title: "OPS-182 has waited 2.4 h", text: "It is queued for Release assistant but has not started.", facts: [["Ticket", "OPS-182 Weekly dependency audit"], ["Priority", "Low"]], links: [{ title: "Open in Foreman", url: `${base}/#/work` }] },
        intake_failed: { severity: "error", title: "Foreman cannot reach Jira", text: "Jira answered 401 for /rest/api/3/search/jql", facts: [], links: [{ title: "Open intake settings", url: `${base}/#/work` }] },
        batch_done: { severity: "success", title: "Batch “Payments cleanup” finished: 38 of 40 done, 2 failed", text: "Some tickets failed and need a look.", facts: [["Done", "38"], ["Failed", "2"], ["Took", "3.4 h"], ["Attempts", "44"], ["Credits", "318.5"]], links: [{ title: "Open the batch", url: `${base}/#/work` }] },
        digest: { severity: "info", title: "Last 24 hours: 14 done, 1 failed, 2 waiting on you", text: "Some tickets are waiting for a decision.", facts: [["Done", "14"], ["In review", "2"], ["Failed", "1"], ["Queued", "5"], ["Runs", "19"], ["Credits", "112.5"]], links: [{ title: "Open the board", url: `${base}/#/work` }] },
        custom: { severity: "info", title: "A message from an agent", text: "Agents and people can post their own messages with notify.send.", facts: [], links: [] },
    };
    return { kind, dedupeKey: `sample:${kind}:${Date.now()}`, path: "/notifications", ...samples[kind] };
};

export const notifyCapabilities = [
    defineCapability({
        name: "notify.inbox",
        title: "Notification inbox",
        description: "Everything Foreman has flagged for a person, newest first: approvals needed, failed or finished tickets, tickets waiting too long, Jira problems.",
        readOnly: true,
        input: z.object({ unreadOnly: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100) }),
        handler: (ctx, input) => ({ unread: ctx.notify.unreadCount(), entries: ctx.notify.inbox(input) }),
    }),
    defineCapability({
        name: "notify.mark_read",
        title: "Mark notifications read",
        description: "Mark the given inbox entries as read, or all of them when no ids are given.",
        input: z.object({ ids: z.array(z.string()).optional() }),
        handler: (ctx, { ids }) => {
            ctx.notify.markRead(ids);
            return { unread: ctx.notify.unreadCount() };
        },
    }),
    defineCapability({
        name: "notify.send",
        title: "Send a notification",
        description: "Post your own message: it goes to the inbox and to every channel whose rules cover \"custom\" messages, or straight to one channel if channelId is given.",
        input: z.object({ title: z.string().min(1).max(200), text: z.string().max(2000).default(""), severity: Severity.default("info"), channelId: z.string().optional(), link: z.string().url().optional() }),
        handler: async (ctx, input) => {
            const event: NotifyEvent = { kind: "custom", severity: input.severity, title: input.title, text: input.text, facts: [["From", actorLabel(ctx.actor)]], links: input.link ? [{ title: "Open link", url: input.link }] : [], path: "/notifications", dedupeKey: `custom:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` };
            if (input.channelId) return { delivery: await ctx.notify.deliver(requireChannel(ctx, input.channelId), event) };
            ctx.notify.emit(event);
            return { sent: true };
        },
    }),
    defineCapability({
        name: "notify.preview",
        title: "Preview a card",
        description: "Render the Teams Adaptive Card for a kind of event using sample data, without sending anything.",
        readOnly: true,
        input: z.object({ kind: EventKind.default("approval_needed") }),
        handler: (ctx, { kind }) => ({ kind, card: toAdaptiveCard(sample(ctx, kind)) }),
    }),
    defineCapability({
        name: "notify.log",
        title: "Delivery log",
        description: "Every attempt to deliver a notification to a channel: sent, retrying, failed (with the reason) or skipped by the rate limit.",
        readOnly: true,
        input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
        handler: (ctx, { limit }) => ctx.notify.listDeliveries(limit),
    }),
    defineCapability({
        name: "notify.settings",
        title: "Notification settings",
        description: "When to flag a ticket as waiting too long, the daily digest schedule, the per-channel rate limit, and the kinds of event that exist.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ({ ...ctx.notify.settings(), nextDigestAt: ctx.notify.nextDigest(), eventKinds: Object.entries(EVENT_KINDS).map(([kind, label]) => ({ kind, label })) }),
    }),
    defineCapability({
        name: "notify.configure",
        title: "Configure notifications",
        description: "Change the waiting-too-long threshold (agingMinutes, 0 = off), the daily digest (digestEnabled, digestCron, digestTimezone) or the rate limit.",
        input: NotifySettings.partial(),
        handler: (ctx, _input, raw) => {
            try {
                return ctx.notify.configure(Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k in NotifySettings.shape)));
            } catch (e) {
                throw new CapabilityError(e instanceof Error ? e.message : String(e), "invalid_input");
            }
        },
    }),
    defineCapability({
        name: "notify.send_digest",
        title: "Send the digest now",
        description: "Send the daily summary immediately, to the inbox and to channels whose rules cover the digest.",
        input: z.object({}),
        handler: (ctx) => {
            ctx.notify.sendDigest();
            return { sent: true };
        },
    }),
    defineCapability({
        name: "channels.list",
        title: "List channels",
        description: "Places notifications can be sent: Teams channels (through a Workflows webhook), the built-in Teams preview, or a generic webhook. Posting addresses are masked.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ctx.notify.listChannels().map(present),
    }),
    defineCapability({
        name: "channels.create",
        title: "Add a channel",
        description:
            "Add a destination. kind \"teams\": paste the address from a Teams Workflows flow using the trigger \"When a Teams webhook request is received\". kind \"mock_teams\": a built-in preview that needs no address. kind \"webhook\": plain JSON to any URL. A channel receives nothing until a rule points at it.",
        input: z.object({ name: z.string().min(1).max(80), kind: ChannelKind, webhookUrl: z.string().optional(), enabled: z.boolean().default(true) }),
        handler: (ctx, input) => {
            checkUrl(input.kind, input.webhookUrl);
            return present(ctx.notify.createChannel(input));
        },
    }),
    defineCapability({
        name: "channels.update",
        title: "Update a channel",
        description: "Rename a channel, replace its webhook address, or turn it on or off.",
        input: z.object({ channelId: z.string(), name: z.string().min(1).max(80).optional(), webhookUrl: z.string().optional(), enabled: z.boolean().optional() }),
        handler: (ctx, { channelId, ...patch }) => {
            const channel = requireChannel(ctx, channelId);
            if (patch.webhookUrl !== undefined) checkUrl(channel.kind, patch.webhookUrl);
            return present(ctx.notify.updateChannel(channelId, patch));
        },
    }),
    defineCapability({
        name: "channels.delete",
        title: "Delete a channel",
        description: "Delete a channel and the rules that send to it.",
        destructive: true,
        input: z.object({ channelId: z.string() }),
        handler: (ctx, { channelId }) => {
            requireChannel(ctx, channelId);
            ctx.notify.deleteChannel(channelId);
            return { deleted: true };
        },
    }),
    defineCapability({
        name: "channels.test",
        title: "Send a test message",
        description: "Send a sample card to a channel right now and report whether it was delivered.",
        input: z.object({ channelId: z.string(), kind: EventKind.default("approval_needed") }),
        handler: async (ctx, { channelId, kind }) => ctx.notify.deliver(requireChannel(ctx, channelId), sample(ctx, kind)),
    }),
    defineCapability({
        name: "notifyrules.list",
        title: "List notification rules",
        description: "Rules that decide which events go to which channel. An event goes to every channel with a matching rule, once per channel.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => {
            const channels = new Map(ctx.notify.listChannels().map((c) => [c.id, c.name]));
            const agents = new Map(ctx.store.listAgents(true).map((a) => [a.id, a.name]));
            return ctx.notify.listRules().map((r) => ({ ...r, channelName: channels.get(r.channelId) ?? r.channelId, agentName: r.agentId ? (agents.get(r.agentId) ?? r.agentId) : null }));
        },
    }),
    defineCapability({
        name: "notifyrules.create",
        title: "Add a notification rule",
        description: "Send events to a channel. Leave events empty for every kind; narrow with agentId or a Jira project key.",
        input: z.object({ name: z.string().min(1).max(80), events: z.array(EventKind).default([]), agentId: z.string().nullable().optional(), project: z.string().nullable().optional(), channelId: z.string(), enabled: z.boolean().default(true) }),
        handler: (ctx, input) => {
            requireChannel(ctx, input.channelId);
            return ctx.notify.createRule(input);
        },
    }),
    defineCapability({
        name: "notifyrules.update",
        title: "Update a notification rule",
        description: "Change which events a rule covers, its filters or channel, or turn it on or off.",
        input: z.object({ ruleId: z.string(), name: z.string().min(1).max(80).optional(), events: z.array(EventKind).optional(), agentId: z.string().nullable().optional(), project: z.string().nullable().optional(), channelId: z.string().optional(), enabled: z.boolean().optional() }),
        handler: (ctx, { ruleId, ...patch }) => {
            if (!ctx.notify.getRule(ruleId)) throw new CapabilityError(`Rule ${ruleId} not found`, "not_found");
            if (patch.channelId) requireChannel(ctx, patch.channelId);
            return ctx.notify.updateRule(ruleId, patch);
        },
    }),
    defineCapability({
        name: "notifyrules.delete",
        title: "Delete a notification rule",
        description: "Delete a rule. The channel stays.",
        destructive: true,
        input: z.object({ ruleId: z.string() }),
        handler: (ctx, { ruleId }) => {
            if (!ctx.notify.getRule(ruleId)) throw new CapabilityError(`Rule ${ruleId} not found`, "not_found");
            ctx.notify.deleteRule(ruleId);
            return { deleted: true };
        },
    }),
    defineCapability({
        name: "mockteams.messages",
        title: "Mock Teams messages",
        description: "What has been posted to the built-in Teams preview, newest first, as the Teams payloads (Adaptive Cards) that a real channel would have received.",
        readOnly: true,
        input: z.object({ channelId: z.string().optional(), limit: z.number().int().min(1).max(300).default(60) }),
        handler: (ctx, { channelId, limit }) => ctx.notify.mockTeams.list(channelId, limit),
    }),
    defineCapability({
        name: "mockteams.clear",
        title: "Clear mock Teams",
        description: "Empty the built-in Teams preview.",
        input: z.object({ channelId: z.string().optional() }),
        handler: (ctx, { channelId }) => {
            ctx.notify.mockTeams.clear(channelId);
            return { cleared: true };
        },
    }),
];
