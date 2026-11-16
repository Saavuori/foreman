import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { z } from "zod";
import type { Bus } from "./registry.ts";
import type { Approval, Run, WorkItem, WorkState } from "./schemas.ts";
import type { Store } from "./store.ts";
import type { Vault } from "./vault.ts";

// ── Model ──────────────────────────────────────────────────────────────────

export const EVENT_KINDS = {
    approval_needed: "Approval needed",
    question_asked: "Question from an agent",
    ticket_review: "Ticket ready for review",
    ticket_done: "Ticket done",
    ticket_failed: "Ticket failed",
    run_failed: "Run failed",
    ticket_aging: "Ticket waiting too long",
    intake_failed: "Jira check failing",
    jira_write_failed: "Jira update failed",
    batch_done: "Batch finished",
    digest: "Daily digest",
    custom: "Message from an agent or person",
} as const;
export const EventKind = z.enum(Object.keys(EVENT_KINDS) as [keyof typeof EVENT_KINDS, ...(keyof typeof EVENT_KINDS)[]]);
export type EventKind = z.infer<typeof EventKind>;
export const Severity = z.enum(["info", "success", "warning", "error"]);
export type Severity = z.infer<typeof Severity>;

/** Something worth telling a person, before it is shaped for any particular channel. */
export interface NotifyEvent {
    kind: EventKind;
    severity: Severity;
    title: string;
    text: string;
    facts: [label: string, value: string][];
    /** Buttons that open a page. The first should be the place to act. */
    links: { title: string; url: string }[];
    /** In-app path for the inbox, e.g. `/work/wrk_1`. */
    path: string;
    /** The same key is never notified twice. */
    dedupeKey: string;
    agentId?: string;
    project?: string;
}

export const ChannelKind = z.enum(["teams", "mock_teams", "webhook"]);
export type ChannelKind = z.infer<typeof ChannelKind>;
export interface Channel {
    id: string;
    name: string;
    kind: ChannelKind;
    /** Posting address. A secret: anyone holding it can post to the channel. */
    webhookUrl: string;
    enabled: boolean;
    createdAt: string;
}
export interface NotifyRule {
    id: string;
    name: string;
    enabled: boolean;
    /** Event kinds this rule covers; empty means all. */
    events: EventKind[];
    agentId: string | null;
    project: string | null;
    channelId: string;
    createdAt: string;
}
export interface Delivery {
    id: string;
    ts: string;
    kind: EventKind;
    title: string;
    channelId: string;
    channelName: string;
    status: "sent" | "failed" | "retrying" | "skipped";
    attempts: number;
    error: string | null;
}
export interface InboxEntry {
    id: string;
    ts: string;
    kind: EventKind;
    severity: Severity;
    title: string;
    text: string;
    path: string;
    read: boolean;
}

export const NotifySettings = z.object({
    /** Tell someone when a ticket has sat in the queue this long. 0 turns it off. */
    agingMinutes: z.number().int().min(0).max(100_000).default(120),
    digestEnabled: z.boolean().default(false),
    digestCron: z.string().default("0 8 * * 1-5"),
    digestTimezone: z.string().default("UTC"),
    /** Most messages one channel gets per minute; the rest are logged as skipped. */
    ratePerMinute: z.number().int().min(1).max(600).default(20),
});
export type NotifySettings = z.infer<typeof NotifySettings>;

// ── Cards ──────────────────────────────────────────────────────────────────

const COLOR: Record<Severity, string> = { info: "Accent", success: "Good", warning: "Warning", error: "Attention" };

/** An Adaptive Card (schema 1.4, which Teams renders everywhere) for an event. */
export function toAdaptiveCard(event: NotifyEvent) {
    return {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        msteams: { width: "Full" },
        body: [
            { type: "TextBlock", text: EVENT_KINDS[event.kind].toUpperCase(), size: "Small", weight: "Bolder", color: COLOR[event.severity], spacing: "None" },
            { type: "TextBlock", text: event.title, size: "Medium", weight: "Bolder", wrap: true, spacing: "Small" },
            ...(event.text ? [{ type: "TextBlock", text: event.text, wrap: true, spacing: "Small" }] : []),
            ...(event.facts.length ? [{ type: "FactSet", spacing: "Medium", facts: event.facts.map(([title, value]) => ({ title, value })) }] : []),
        ],
        actions: event.links.map((link) => ({ type: "Action.OpenUrl", title: link.title, url: link.url })),
    };
}

/** The body a Teams Workflows webhook ("When a Teams webhook request is received") expects. */
export function toTeamsPayload(event: NotifyEvent) {
    return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: toAdaptiveCard(event) }] };
}
/** A plain JSON shape for any other system. */
export function toWebhookPayload(event: NotifyEvent) {
    return { event: event.kind, severity: event.severity, title: event.title, text: event.text, facts: Object.fromEntries(event.facts), links: event.links };
}

export interface MockTeamsMessage {
    id: string;
    ts: string;
    channel: string;
    payload: unknown;
}
/** A stand-in for a Teams channel: keeps what was posted so the cards can be previewed. */
export class MockTeams {
    private messages: MockTeamsMessage[] = [];
    constructor(private onChange: () => void = () => {}) {}
    post(channel: string, payload: unknown): MockTeamsMessage {
        const message = { id: randomUUID().slice(0, 8), ts: new Date().toISOString(), channel, payload };
        this.messages.push(message);
        if (this.messages.length > 300) this.messages.shift();
        this.onChange();
        return message;
    }
    list(channel?: string, limit = 100): MockTeamsMessage[] {
        return this.messages.filter((m) => !channel || m.channel === channel).slice(-limit).reverse();
    }
    clear(channel?: string) {
        this.messages = channel ? this.messages.filter((m) => m.channel !== channel) : [];
        this.onChange();
    }
}

// ── Hub ────────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, webhook_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notify_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, events TEXT NOT NULL, agent_id TEXT, project TEXT, channel_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, path TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notifications_ts ON notifications (ts DESC);
`;
const RETRY_DELAYS_MS = [2000, 10_000];
const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const mins = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

export interface NotifyHubOptions {
    baseUrl: string;
    /** Retry delays; tests shorten them. */
    retryDelaysMs?: number[];
    fetch?: typeof fetch;
    /** Encrypts channel addresses at rest. */
    vault?: Vault;
}

/**
 * Turns things that happen (an approval is needed, a ticket failed, Jira stopped answering) into
 * messages: always into the in-app inbox, and into Teams or a webhook where a rule says so.
 * Every delivery is recorded, so "was anyone told?" always has an answer.
 */
export class NotifyHub {
    readonly mockTeams: MockTeams;
    private digestJob?: Cron;
    private agingTimer?: ReturnType<typeof setInterval>;
    private sentAt = new Map<string, number[]>();
    private pending = new Set<Promise<unknown>>();
    private retryDelays: number[];
    private doFetch: typeof fetch;

    constructor(
        private store: Store,
        private bus: Bus,
        private options: NotifyHubOptions,
    ) {
        store.db.exec(SCHEMA);
        // Addresses saved before the vault existed are sealed on first start.
        if (options.vault) for (const row of this.q<{ id: string; webhook_url: string }>("SELECT id, webhook_url FROM channels WHERE webhook_url != '' AND webhook_url NOT LIKE 'enc:%'")) this.x("UPDATE channels SET webhook_url = ? WHERE id = ?", options.vault.seal(row.webhook_url), row.id);
        this.mockTeams = new MockTeams(() => bus.emit("change", "notify"));
        this.retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
        this.doFetch = options.fetch ?? fetch;
    }

    private q<T = any>(sql: string, ...params: any[]): T[] {
        return this.store.db.prepare(sql).all(...params) as T[];
    }
    private x(sql: string, ...params: any[]) {
        return this.store.db.prepare(sql).run(...params);
    }
    private url(path: string) {
        return `${this.options.baseUrl}/#${path}`;
    }

    // ── lifecycle and event sources ───────────────────────────────────────
    start() {
        this.bus.on("approval", this.onApproval);
        this.bus.on("work", this.onWork);
        this.bus.on("run", this.onRun);
        this.bus.on("notice", this.onNotice);
        this.agingTimer = setInterval(() => this.checkAging(), 60_000);
        this.agingTimer.unref?.();
        this.scheduleDigest();
    }
    stop() {
        this.bus.off("approval", this.onApproval);
        this.bus.off("work", this.onWork);
        this.bus.off("run", this.onRun);
        this.bus.off("notice", this.onNotice);
        clearInterval(this.agingTimer);
        this.digestJob?.stop();
    }
    /** Resolves when no delivery is in flight. For tests and shutdown. */
    async settled() {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
    }

    private onApproval = (approval: Approval) => {
        if (approval.status !== "pending") return;
        const run = this.store.getRun(approval.runId);
        const agent = this.store.getAgent(approval.agentId);
        const item = run?.source.workItemId ? this.store.getWorkItem(run.source.workItemId) : undefined;
        if (approval.kind === "question") {
            return void this.emit({
                kind: "question_asked",
                severity: "warning",
                title: item ? `${item.ticket.key}: ${agent?.name ?? "An agent"} has a question` : `${agent?.name ?? "An agent"} has a question`,
                text: clip(approval.summary, 600),
                facts: [...(item ? ([["Ticket", `${item.ticket.key} ${clip(item.ticket.title, 80)}`], ["Reporter", item.ticket.reporter ?? "unknown"]] as [string, string][]) : []), ["Agent", agent?.name ?? approval.agentId]],
                links: [{ title: "Answer", url: this.url(item ? `/work/${item.id}` : `/runs/${approval.runId}`) }, ...(item ? [{ title: "Open in Jira", url: item.ticket.url }] : [])],
                path: item ? `/work/${item.id}` : `/runs/${approval.runId}`,
                dedupeKey: `approval:${approval.id}`,
                agentId: approval.agentId,
                project: item?.ticket.project,
            });
        }
        this.emit({
            kind: "approval_needed",
            severity: "warning",
            title: item ? `${item.ticket.key}: ${agent?.name ?? "An agent"} needs your approval` : `${agent?.name ?? "An agent"} needs your approval`,
            text: `It wants to: ${approval.summary}`,
            facts: [...(item ? ([["Ticket", `${item.ticket.key} ${clip(item.ticket.title, 80)}`]] as [string, string][]) : []), ["Agent", agent?.name ?? approval.agentId], ["Action", approval.kind]],
            links: [{ title: "Review and decide", url: this.url(item ? `/work/${item.id}` : `/runs/${approval.runId}`) }, ...(item ? [{ title: "Open in Jira", url: item.ticket.url }] : [])],
            path: item ? `/work/${item.id}` : `/runs/${approval.runId}`,
            dedupeKey: `approval:${approval.id}`,
            agentId: approval.agentId,
            project: item?.ticket.project,
        });
    };

    private onWork = (item: WorkItem, previous: WorkState) => {
        if (item.state === previous) return;
        const agent = item.agentId ? this.store.getAgent(item.agentId) : undefined;
        const base = {
            facts: [["Ticket", item.ticket.key], ["Agent", agent?.name ?? "Unassigned"], ["Attempts", String(item.attempts)], ...(item.queuedAt && item.finishedAt ? ([["Took", mins(Date.parse(item.finishedAt) - Date.parse(item.queuedAt))]] as [string, string][]) : [])] as [string, string][],
            links: [{ title: "Open in Foreman", url: this.url(`/work/${item.id}`) }, { title: "Open in Jira", url: item.ticket.url }],
            path: `/work/${item.id}`,
            agentId: item.agentId ?? undefined,
            project: item.ticket.project,
        };
        const stamp = `${item.id}:${item.attempts}`;
        if (item.state === "failed") this.emit({ ...base, kind: "ticket_failed", severity: "error", title: `${item.ticket.key} failed: ${clip(item.ticket.title, 90)}`, text: clip(item.note ?? "The last attempt failed."), dedupeKey: `failed:${stamp}` });
        else if (item.state === "review") this.emit({ ...base, kind: "ticket_review", severity: "info", title: `${item.ticket.key} is ready for review`, text: clip(item.ticket.title, 200), dedupeKey: `review:${stamp}` });
        else if (item.state === "done") this.emit({ ...base, kind: "ticket_done", severity: "success", title: `${item.ticket.key} is done`, text: clip(item.ticket.title, 200), dedupeKey: `done:${stamp}` });
    };

    private onRun = (run: Run) => {
        // Ticket runs are reported through their work item, which knows about retries.
        if (run.status !== "failed" || run.source.kind === "work") return;
        const agent = this.store.getAgent(run.agentId);
        this.emit({
            kind: "run_failed",
            severity: "error",
            title: `${agent?.name ?? "An agent"} failed a run`,
            text: clip(run.error ?? "The run failed."),
            facts: [["Agent", agent?.name ?? run.agentId], ["Started by", run.source.kind], ["Task", clip(run.prompt.split("\n")[0]!, 100)]],
            links: [{ title: "Open the trace", url: this.url(`/runs/${run.id}`) }],
            path: `/runs/${run.id}`,
            dedupeKey: `run:${run.id}`,
            agentId: run.agentId,
        });
    };

    private onNotice = (notice: { kind: EventKind; severity: Severity; title: string; text: string; path: string; dedupeKey: string }) => {
        this.emit({ ...notice, facts: [], links: [{ title: "Open in Foreman", url: this.url(notice.path) }] });
    };

    checkAging(now = Date.now()) {
        const { agingMinutes } = this.settings();
        if (!agingMinutes) return;
        for (const item of this.store.listWorkItems({ states: ["queued", "inbox"] })) {
            const since = Date.parse(item.queuedAt ?? item.receivedAt);
            if (item.held || now - since < agingMinutes * 60_000) continue;
            const agent = item.agentId ? this.store.getAgent(item.agentId) : undefined;
            this.emit({
                kind: "ticket_aging",
                severity: "warning",
                title: `${item.ticket.key} has waited ${mins(now - since)}`,
                text: item.state === "inbox" ? "No routing rule matched it. Assign an agent or skip it." : `It is queued for ${agent?.name ?? "an agent"} but has not started.`,
                facts: [["Ticket", `${item.ticket.key} ${clip(item.ticket.title, 80)}`], ["Priority", item.ticket.priority]],
                links: [{ title: "Open in Foreman", url: this.url(`/work/${item.id}`) }, { title: "Open in Jira", url: item.ticket.url }],
                path: `/work/${item.id}`,
                dedupeKey: `aging:${item.id}:${item.queuedAt ?? item.receivedAt}`,
                agentId: item.agentId ?? undefined,
                project: item.ticket.project,
            });
        }
    }

    private scheduleDigest() {
        this.digestJob?.stop();
        const s = this.settings();
        if (!s.digestEnabled) return;
        try {
            this.digestJob = new Cron(s.digestCron, { timezone: s.digestTimezone, protect: true }, () => this.sendDigest());
        } catch {
            /* an invalid schedule is rejected in configure(); nothing to do here */
        }
    }

    /** One message summing up the last day. */
    sendDigest(now = Date.now()) {
        const since = new Date(now - 86_400_000).toISOString();
        const items = this.store.listWorkItems({ limit: 2000 });
        const recent = (state: WorkState) => items.filter((i) => i.state === state && i.finishedAt && i.finishedAt >= since).length;
        const waiting = items.filter((i) => i.state === "needs_you").length;
        const runs = this.store.runStats(since);
        const credits = Math.round(runs.reduce((sum, r) => sum + r.usage.credits, 0) * 10) / 10;
        const done = recent("done");
        const failed = recent("failed");
        this.emit({
            kind: "digest",
            severity: failed ? "warning" : "info",
            title: `Last 24 hours: ${done} done, ${failed} failed, ${waiting} waiting on you`,
            text: waiting ? "Some tickets are waiting for a decision." : "Nothing is waiting for a decision.",
            facts: [["Done", String(done)], ["In review", String(items.filter((i) => i.state === "review").length)], ["Failed", String(failed)], ["Queued", String(items.filter((i) => i.state === "queued").length)], ["Runs", String(runs.length)], ["Credits", String(credits)]],
            links: [{ title: "Open the board", url: this.url("/work") }],
            path: "/work",
            dedupeKey: `digest:${new Date(now).toISOString().slice(0, 13)}`,
        });
    }

    // ── emit and deliver ──────────────────────────────────────────────────
    /** Record an event in the inbox and send it wherever a rule says. Returns false for a repeat. */
    emit(event: NotifyEvent): boolean {
        try {
            this.x("INSERT INTO notifications (id, ts, kind, severity, title, text, path, dedupe_key) VALUES (?,?,?,?,?,?,?,?)", id("ntf"), new Date().toISOString(), event.kind, event.severity, event.title, event.text, event.path, event.dedupeKey);
        } catch {
            return false; // the dedupe key was already notified
        }
        const channels = new Map<string, Channel>();
        for (const rule of this.listRules()) {
            if (!rule.enabled) continue;
            if (rule.events.length && !rule.events.includes(event.kind)) continue;
            if (rule.agentId && rule.agentId !== event.agentId) continue;
            if (rule.project && rule.project.toLowerCase() !== (event.project ?? "").toLowerCase()) continue;
            const channel = this.getChannel(rule.channelId);
            if (channel?.enabled) channels.set(channel.id, channel);
        }
        for (const channel of channels.values()) this.track(this.deliver(channel, event));
        this.bus.emit("change", "notify");
        return true;
    }

    private track(p: Promise<unknown>) {
        this.pending.add(p);
        void p.finally(() => this.pending.delete(p));
    }

    private allowed(channelId: string): boolean {
        const now = Date.now();
        const recent = (this.sentAt.get(channelId) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= this.settings().ratePerMinute) return (this.sentAt.set(channelId, recent), false);
        recent.push(now);
        this.sentAt.set(channelId, recent);
        return true;
    }

    /** Send one event to one channel, retrying a failure twice. Every outcome is logged. */
    async deliver(channel: Channel, event: NotifyEvent): Promise<Delivery> {
        const deliveryId = id("dlv");
        const log = (status: Delivery["status"], attempts: number, error: string | null) => {
            this.x(
                "INSERT INTO deliveries (id, ts, kind, title, channel_id, channel_name, status, attempts, error) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, error = excluded.error",
                deliveryId, new Date().toISOString(), event.kind, event.title, channel.id, channel.name, status, attempts, error,
            );
            this.bus.emit("change", "notify");
        };
        if (!this.allowed(channel.id)) {
            log("skipped", 0, `Rate limit of ${this.settings().ratePerMinute} per minute reached for this channel`);
            return this.getDelivery(deliveryId)!;
        }
        for (let attempt = 1; ; attempt++) {
            try {
                await this.post(channel, event);
                log("sent", attempt, null);
                break;
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                const delay = this.retryDelays[attempt - 1];
                if (delay === undefined) {
                    log("failed", attempt, message);
                    break;
                }
                log("retrying", attempt, message);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        return this.getDelivery(deliveryId)!;
    }

    private async post(channel: Channel, event: NotifyEvent) {
        if (channel.kind === "mock_teams") return void this.mockTeams.post(channel.id, toTeamsPayload(event));
        const body = channel.kind === "teams" ? toTeamsPayload(event) : toWebhookPayload(event);
        if (!channel.webhookUrl) throw new Error("The channel has no usable address — enter it again");
        let response: Response;
        try {
            response = await this.doFetch(channel.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
        } catch (e) {
            throw new Error(`Could not reach the channel: ${e instanceof Error ? e.message : e}`);
        }
        if (!response.ok) throw new Error(`The channel answered ${response.status}${response.status === 404 || response.status === 410 ? " — the webhook address may have been removed" : ""}`);
    }

    // ── channels, rules, log, inbox, settings ─────────────────────────────
    private seal = (url: string) => this.options.vault?.seal(url) ?? url;
    private unseal(sealed: string): string {
        try {
            return this.options.vault?.unseal(sealed) ?? sealed;
        } catch {
            return ""; // the vault key changed; the address has to be entered again
        }
    }
    private toChannel = (r: any): Channel => ({ id: r.id, name: r.name, kind: r.kind, webhookUrl: this.unseal(r.webhook_url), enabled: !!r.enabled, createdAt: r.created_at });
    listChannels(): Channel[] {
        return this.q("SELECT * FROM channels ORDER BY created_at").map(this.toChannel);
    }
    getChannel(channelId: string): Channel | undefined {
        return this.q("SELECT * FROM channels WHERE id = ?", channelId).map(this.toChannel)[0];
    }
    createChannel(input: { name: string; kind: ChannelKind; webhookUrl?: string; enabled?: boolean }): Channel {
        const channelId = id("chn");
        this.x("INSERT INTO channels (id, name, kind, webhook_url, enabled, created_at) VALUES (?,?,?,?,?,?)", channelId, input.name, input.kind, input.kind === "mock_teams" ? "" : this.seal(input.webhookUrl ?? ""), input.enabled === false ? 0 : 1, new Date().toISOString());
        this.bus.emit("change", "notify");
        return this.getChannel(channelId)!;
    }
    updateChannel(channelId: string, patch: { name?: string; webhookUrl?: string; enabled?: boolean }): Channel {
        const c = this.getChannel(channelId);
        if (!c) throw new Error(`Channel ${channelId} not found`);
        this.x("UPDATE channels SET name = ?, webhook_url = ?, enabled = ? WHERE id = ?", patch.name ?? c.name, this.seal(patch.webhookUrl ?? c.webhookUrl), (patch.enabled ?? c.enabled) ? 1 : 0, channelId);
        this.bus.emit("change", "notify");
        return this.getChannel(channelId)!;
    }
    deleteChannel(channelId: string) {
        this.x("DELETE FROM channels WHERE id = ?", channelId);
        this.x("DELETE FROM notify_rules WHERE channel_id = ?", channelId);
        this.mockTeams.clear(channelId);
        this.bus.emit("change", "notify");
    }

    private toRule = (r: any): NotifyRule => ({ id: r.id, name: r.name, enabled: !!r.enabled, events: JSON.parse(r.events), agentId: r.agent_id, project: r.project, channelId: r.channel_id, createdAt: r.created_at });
    listRules(): NotifyRule[] {
        return this.q("SELECT * FROM notify_rules ORDER BY created_at").map(this.toRule);
    }
    getRule(ruleId: string): NotifyRule | undefined {
        return this.q("SELECT * FROM notify_rules WHERE id = ?", ruleId).map(this.toRule)[0];
    }
    createRule(input: { name: string; events: EventKind[]; agentId?: string | null; project?: string | null; channelId: string; enabled?: boolean }): NotifyRule {
        const ruleId = id("nrl");
        this.x("INSERT INTO notify_rules (id, name, enabled, events, agent_id, project, channel_id, created_at) VALUES (?,?,?,?,?,?,?,?)", ruleId, input.name, input.enabled === false ? 0 : 1, JSON.stringify(input.events), input.agentId || null, input.project || null, input.channelId, new Date().toISOString());
        this.bus.emit("change", "notify");
        return this.getRule(ruleId)!;
    }
    updateRule(ruleId: string, patch: Partial<Pick<NotifyRule, "name" | "enabled" | "events" | "agentId" | "project" | "channelId">>): NotifyRule {
        const r = this.getRule(ruleId);
        if (!r) throw new Error(`Rule ${ruleId} not found`);
        const n = { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
        this.x("UPDATE notify_rules SET name = ?, enabled = ?, events = ?, agent_id = ?, project = ?, channel_id = ? WHERE id = ?", n.name, n.enabled ? 1 : 0, JSON.stringify(n.events), n.agentId || null, n.project || null, n.channelId, ruleId);
        this.bus.emit("change", "notify");
        return this.getRule(ruleId)!;
    }
    deleteRule(ruleId: string) {
        this.x("DELETE FROM notify_rules WHERE id = ?", ruleId);
        this.bus.emit("change", "notify");
    }

    private toDelivery = (r: any): Delivery => ({ id: r.id, ts: r.ts, kind: r.kind, title: r.title, channelId: r.channel_id, channelName: r.channel_name, status: r.status, attempts: r.attempts, error: r.error });
    getDelivery(deliveryId: string): Delivery | undefined {
        return this.q("SELECT * FROM deliveries WHERE id = ?", deliveryId).map(this.toDelivery)[0];
    }
    listDeliveries(limit = 100): Delivery[] {
        return this.q("SELECT * FROM deliveries ORDER BY ts DESC, rowid DESC LIMIT ?", Math.min(limit, 500)).map(this.toDelivery);
    }

    inbox(opts: { unreadOnly?: boolean; limit?: number } = {}): InboxEntry[] {
        return this.q(`SELECT * FROM notifications ${opts.unreadOnly ? "WHERE read = 0" : ""} ORDER BY ts DESC, rowid DESC LIMIT ?`, Math.min(opts.limit ?? 100, 500)).map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, severity: r.severity, title: r.title, text: r.text, path: r.path, read: !!r.read }));
    }
    unreadCount(): number {
        return this.q<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE read = 0")[0]!.n;
    }
    markRead(ids?: string[]) {
        if (ids?.length) this.x(`UPDATE notifications SET read = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
        else this.x("UPDATE notifications SET read = 1");
        this.bus.emit("change", "notify");
    }

    settings(): NotifySettings {
        return NotifySettings.parse(this.store.getSetting("notify") ?? {});
    }
    configure(patch: Partial<NotifySettings>): NotifySettings {
        const next = NotifySettings.parse({ ...this.settings(), ...patch });
        if (next.digestEnabled) {
            try {
                new Cron(next.digestCron, { timezone: next.digestTimezone, paused: true }).stop();
            } catch (e) {
                throw new Error(`Invalid digest schedule "${next.digestCron}" (${next.digestTimezone}): ${e instanceof Error ? e.message : e}`);
            }
        }
        this.store.setSetting("notify", next);
        this.scheduleDigest();
        this.bus.emit("change", "notify");
        return next;
    }
    nextDigest(): string | null {
        return this.digestJob?.nextRun()?.toISOString() ?? null;
    }
}

/** Hide most of a webhook address: enough to recognise it, not enough to use it. */
export function maskUrl(url: string): string {
    if (!url) return "";
    try {
        const u = new URL(url);
        return `${u.origin}/…${url.slice(-6)}`;
    } catch {
        return "…" + url.slice(-6);
    }
}
