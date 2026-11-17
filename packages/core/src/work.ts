import { randomBytes } from "node:crypto";
import type { Engine } from "./engine.ts";
import { JiraClient } from "./jira.ts";
import type { Actor, Bus } from "./registry.ts";
import type { Vault } from "./vault.ts";
import { ACTIVE_WORK_STATES, DEFAULT_TICKET_PROMPT, JiraAuth, JiraSettings, JiraWriteBack, type RoutingMatch, type RoutingRule, type Run, type RunEvent, type Ticket, type WorkItem, type WorkState } from "./schemas.ts";
import type { Store } from "./store.ts";
import { renderPrompt } from "./triggers.ts";

const PRIORITY_ORDER = ["highest", "high", "medium", "low", "lowest"];
const TRANSIENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|transient|\b50[234]\b|rate limit|interrupted by a server restart/i;

/** Default queue position: priority first, then arrival. Lower runs sooner. */
export function defaultRank(ticket: Ticket, receivedAtMs: number): number {
    const p = PRIORITY_ORDER.indexOf(ticket.priority.toLowerCase());
    return (p < 0 ? 2 : p) * 1e13 + receivedAtMs;
}

const same = (a: string | undefined, b: string) => !a || a.trim().toLowerCase() === b.toLowerCase();
export function ruleMatches(match: RoutingMatch, ticket: Ticket): boolean {
    return same(match.project, ticket.project) && same(match.type, ticket.type) && same(match.priority, ticket.priority) && (!match.label || ticket.labels.some((l) => l.toLowerCase() === match.label!.trim().toLowerCase()));
}

export interface WorkHubOptions {
    /** Where the built-in mock Jira is served; used until a real site is configured. */
    mockJiraUrl: string;
    /** Foreman's own address, for links written into ticket comments. */
    baseUrl: string;
    vault: Vault;
}

/** One thing Foreman wrote (or failed to write) to a ticket. */
export interface WriteBackEntry {
    at: string;
    key: string;
    action: "comment" | "status";
    detail: string;
    ok: boolean;
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * The work queue. Tickets come in from Jira, are routed to an agent, wait their turn, and are
 * attempted as runs. A work item outlives its runs: it can be retried, wait on a person, or stop
 * for review — and its state is what the board shows.
 */
export class WorkHub {
    private timer?: ReturnType<typeof setTimeout>;
    private polling = false;
    private failingSince: string | null = null;
    lastPoll: { at: string; ok: boolean; detail: string } | null = null;
    /** The most recent write-backs, newest first. Kept in memory. */
    writeLog: WriteBackEntry[] = [];
    private chains = new Map<string, Promise<void>>();
    private pollAgain = false;
    /** Webhook calls since start. */
    webhook: { received: number; lastAt: string | null } = { received: 0, lastAt: null };

    constructor(
        private store: Store,
        private engine: Engine,
        private bus: Bus,
        private options: WorkHubOptions,
    ) {}

    // ── lifecycle ─────────────────────────────────────────────────────────
    start() {
        this.bus.on("run", this.onRun);
        this.bus.on("event", this.onEvent);
        // Runs that ended while nobody was listening (a restart) still need their item moved on.
        for (const item of this.store.listWorkItems({ states: ACTIVE_WORK_STATES })) {
            const run = item.runId ? this.store.getRun(item.runId) : undefined;
            if (run) this.onRun(run);
            else this.setState(item, "queued", { note: "Re-queued after a restart" });
        }
        this.dispatch();
        this.schedule();
    }
    stop() {
        clearTimeout(this.timer);
        this.bus.off("run", this.onRun);
        this.bus.off("event", this.onEvent);
    }

    settings(): JiraSettings {
        const saved = this.store.getSetting<Partial<JiraSettings>>("jira") ?? {};
        const settings = JiraSettings.parse(saved);
        return { ...settings, baseUrl: settings.baseUrl || this.options.mockJiraUrl };
    }
    updateSettings(patch: Partial<Omit<JiraSettings, "auth" | "writeBack">> & { auth?: Partial<JiraAuth>; writeBack?: Partial<JiraWriteBack> }): JiraSettings {
        const current = this.settings();
        const next = JiraSettings.parse({ ...current, ...patch, auth: { ...current.auth, ...patch.auth }, writeBack: { ...current.writeBack, ...patch.writeBack } });
        // The mock is the default; do not pin its address, which changes with the port.
        if (next.baseUrl === this.options.mockJiraUrl) next.baseUrl = "";
        this.store.setSetting("jira", next);
        // A different site or filter means the old "changed since" cursor no longer applies.
        if (patch.baseUrl !== undefined || patch.jql !== undefined || patch.flavor !== undefined) this.store.setSetting("jira.cursor", null);
        this.schedule();
        this.dispatch();
        this.bus.emit("change", "work");
        return this.settings();
    }
    isMock() {
        return this.settings().baseUrl === this.options.mockJiraUrl;
    }
    private client() {
        const { baseUrl, flavor, auth } = this.settings();
        const headers: Record<string, string> = {};
        if (auth.type !== "none") {
            if (!auth.secretName) throw new Error("Jira sign-in is switched on but no token is stored. Add the token under Jira connection.");
            const token = this.options.vault.use(auth.secretName);
            headers.authorization = auth.type === "basic" ? `Basic ${Buffer.from(`${auth.email}:${token}`).toString("base64")}` : `Bearer ${token}`;
        }
        return new JiraClient(baseUrl, { headers, flavor });
    }
    /** A client for the configured site, for Foreman's agent tools. */
    jira(): JiraClient {
        return this.client();
    }
    /** Prove the site and credentials work, without changing anything. */
    async testConnection(): Promise<{ ok: boolean; detail: string }> {
        try {
            const me = await this.client().myself();
            return { ok: true, detail: `Connected as ${me.name}${me.email ? ` (${me.email})` : ""}` };
        } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
    }

    private schedule() {
        clearTimeout(this.timer);
        const settings = this.settings();
        if (!settings.enabled) return;
        this.timer = setTimeout(() => void this.poll().finally(() => this.schedule()), settings.pollSeconds * 1000);
        this.timer.unref?.();
    }

    // ── webhook: instant pickup ───────────────────────────────────────────
    /** The secret in the webhook address. Created on first use and stored sealed. */
    webhookSecret(): string {
        const sealed = this.store.getSetting<string>("jira.webhookSecret");
        if (sealed) return this.options.vault.unseal(sealed);
        return this.rotateWebhookSecret();
    }
    rotateWebhookSecret(): string {
        const secret = randomBytes(24).toString("base64url");
        this.store.setSetting("jira.webhookSecret", this.options.vault.seal(secret));
        this.bus.emit("change", "work");
        return secret;
    }
    webhookUrl(): string {
        return `${this.options.baseUrl}/hooks/jira/${this.webhookSecret()}`;
    }
    /**
     * Jira says something changed. The call's content is not trusted or used: it only makes Foreman
     * check Jira now, so the intake filter stays the one thing that decides which tickets are taken.
     */
    nudge(): { accepted: boolean; reason?: string } {
        this.webhook = { received: this.webhook.received + 1, lastAt: new Date().toISOString() };
        this.bus.emit("change", "work");
        if (!this.settings().enabled) return { accepted: false, reason: "Intake is switched off" };
        if (this.polling) this.pollAgain = true;
        else void this.poll().catch(() => {});
        return { accepted: true };
    }

    // ── intake ────────────────────────────────────────────────────────────
    /** Ask Jira for tickets matching the filter that changed since the last poll. */
    async poll(): Promise<{ fetched: number; added: number; updated: number }> {
        if (this.polling) return { fetched: 0, added: 0, updated: 0 };
        this.polling = true;
        const settings = this.settings();
        try {
            const cursor = this.store.getSetting<string | null>("jira.cursor") ?? undefined;
            const startedAt = new Date().toISOString();
            // Jira compares to the minute, so step back one to never miss a change on the boundary.
            const tickets = await this.client().search(settings.jql, cursor ? new Date(Date.parse(cursor) - 60_000).toISOString() : undefined);
            let added = 0;
            let updated = 0;
            for (const ticket of tickets) {
                const result = this.ingest(ticket);
                if (result.created) added++;
                else if (result.changed) updated++;
            }
            this.store.setSetting("jira.cursor", startedAt);
            this.failingSince = null;
            this.lastPoll = { at: startedAt, ok: true, detail: `${tickets.length} matching, ${added} new, ${updated} updated` };
            if (added || updated) this.dispatch();
            return { fetched: tickets.length, added, updated };
        } catch (e) {
            this.lastPoll = { at: new Date().toISOString(), ok: false, detail: e instanceof Error ? e.message : String(e) };
            // One notice per outage, not one per failed poll.
            if (!this.failingSince) {
                this.failingSince = this.lastPoll.at;
                this.bus.emit("notice", { kind: "intake_failed", severity: "error", title: "Foreman cannot reach Jira", text: this.lastPoll.detail, path: "/work", dedupeKey: `intake:${this.failingSince}` });
            }
            throw e;
        } finally {
            this.polling = false;
            this.bus.emit("change", "work");
            // A webhook arrived while this check was running: look again so nothing is missed.
            if (this.pollAgain) {
                this.pollAgain = false;
                void this.poll().catch(() => {});
            }
        }
    }

    /** Fetch specific tickets by key and put them on the board, whether or not the filter matches. */
    async addByKeys(keys: string[]): Promise<{ added: WorkItem[]; existing: WorkItem[]; missing: string[] }> {
        const out = { added: [] as WorkItem[], existing: [] as WorkItem[], missing: [] as string[] };
        for (const key of keys.map((k) => k.trim()).filter(Boolean)) {
            try {
                const result = this.ingest(await this.client().getIssue(key));
                (result.created ? out.added : out.existing).push(result.item);
            } catch {
                out.missing.push(key);
            }
        }
        this.dispatch();
        return out;
    }

    route(ticket: Ticket): RoutingRule | undefined {
        return this.store.listRules().find((rule) => rule.enabled && ruleMatches(rule.match, ticket) && !this.store.getAgent(rule.agentId)?.archived && this.store.getAgent(rule.agentId));
    }

    /** Add a ticket, or refresh the snapshot of one already known. Never creates a duplicate. */
    ingest(ticket: Ticket): { item: WorkItem; created: boolean; changed: boolean } {
        const existing = this.store.findWorkItem(ticket.source, ticket.key);
        if (existing) {
            if (existing.ticket.updatedAt === ticket.updatedAt) return { item: existing, created: false, changed: false };
            let item = this.store.updateWorkItem(existing.id, { ticket });
            // An inbox item may match a rule now that the ticket (or the rules) changed.
            if (item.state === "inbox") {
                const rule = this.route(ticket);
                if (rule) item = this.setState(item, "queued", { agentId: rule.agentId, ruleId: rule.id, review: rule.review, note: null });
            }
            this.bus.emit("change", "work");
            return { item, created: false, changed: true };
        }
        const rule = this.route(ticket);
        const item = this.store.createWorkItem({ ticket, state: rule ? "queued" : "inbox", agentId: rule?.agentId ?? null, ruleId: rule?.id ?? null, review: rule?.review ?? false, rank: defaultRank(ticket, Date.now()) });
        this.bus.emit("change", "work");
        return { item, created: true, changed: false };
    }

    /** Re-run routing for everything in the inbox, e.g. after a rule was added. */
    rerouteInbox(): number {
        let moved = 0;
        for (const item of this.store.listWorkItems({ states: ["inbox"] })) {
            const rule = this.route(item.ticket);
            if (!rule) continue;
            this.setState(item, "queued", { agentId: rule.agentId, ruleId: rule.id, review: rule.review, note: null });
            moved++;
        }
        if (moved) this.dispatch();
        return moved;
    }

    // ── queue ─────────────────────────────────────────────────────────────
    private setState(item: WorkItem, state: WorkState, patch: Parameters<Store["updateWorkItem"]>[1] = {}): WorkItem {
        const ts = new Date().toISOString();
        const stamps: Parameters<Store["updateWorkItem"]>[1] = {};
        if (state === "queued" && item.state !== "queued") stamps.queuedAt = ts;
        if (state === "working" && !ACTIVE_WORK_STATES.includes(item.state)) stamps.startedAt = ts;
        if (["done", "failed", "skipped", "review"].includes(state)) stamps.finishedAt = ts;
        const updated = this.store.updateWorkItem(item.id, { state, ...stamps, ...patch });
        this.bus.emit("change", "work");
        this.bus.emit("work", updated, item.state);
        this.writeBack(updated, item.state);
        return updated;
    }

    // ── writing back to Jira ──────────────────────────────────────────────
    /**
     * Keep the ticket in step with the queue: Foreman does this itself, so the ticket shows what
     * happened even when an agent says nothing. Never throws; failures are logged and notified.
     */
    private writeBack(item: WorkItem, previous: WorkState) {
        const wb = this.settings().writeBack;
        if (!wb.enabled || item.state === previous) return;
        const agent = (item.agentId && this.store.getAgent(item.agentId)?.name) || "An agent";
        const link = `${this.options.baseUrl}/#/work/${item.id}`;
        const result = () => clip(((item.runId && this.store.getRun(item.runId)?.output) || "").trim(), 1500);
        let comment: string | null = null;
        let status = "";
        switch (item.state) {
            case "working":
                if (ACTIVE_WORK_STATES.includes(previous)) return; // back from an approval, not a new attempt
                if (wb.commentOnStart) comment = `Foreman: ${agent} started on this ticket${item.attempts > 1 ? ` (attempt ${item.attempts})` : ""}.\n\nFollow it here: ${link}`;
                status = wb.statusStarted;
                break;
            case "needs_you": {
                const question = item.runId ? this.store.listApprovals({ runId: item.runId, status: "pending" }).find((a) => a.kind === "question") : undefined;
                if (!question || !wb.commentOnQuestion) return;
                comment = `Foreman: ${agent} needs information before it can continue.\n\n${question.summary}\n\nAnswer here: ${link}`;
                break;
            }
            case "review":
                if (wb.commentOnDone) comment = `Foreman: ${agent} finished, and the result is waiting for a person to check.\n\n${result()}\n\nReview it here: ${link}`;
                status = wb.statusReview;
                break;
            case "done":
                if (wb.commentOnDone) comment = ACTIVE_WORK_STATES.includes(previous) ? `Foreman: ${agent} finished this ticket.\n\n${result()}` : "Foreman: the result was accepted.";
                status = wb.statusDone;
                break;
            case "failed":
                if (wb.commentOnFailed) comment = `Foreman: ${agent} could not finish this ticket after ${item.attempts} attempt${item.attempts === 1 ? "" : "s"}.\n\n${clip(item.note ?? "The run failed.", 800)}\n\nDetails: ${link}`;
                status = wb.statusFailed;
                break;
            default:
                return;
        }
        if (!comment && !status) return;
        const key = item.ticket.key;
        const log = (action: WriteBackEntry["action"], detail: string, ok: boolean) => {
            this.writeLog.unshift({ at: new Date().toISOString(), key, action, detail, ok });
            this.writeLog.length = Math.min(this.writeLog.length, 60);
            this.bus.emit("change", "work");
        };
        // One ticket's updates go out in order, so "started" never lands after "finished".
        const job = (this.chains.get(key) ?? Promise.resolve()).then(async () => {
            let doing: WriteBackEntry["action"] = "comment";
            try {
                const client = this.client();
                if (comment) {
                    await client.addComment(key, comment);
                    log("comment", clip(comment.split("\n")[0]!, 120), true);
                }
                if (status) {
                    doing = "status";
                    const to = await client.transition(key, status);
                    if (to) {
                        const fresh = this.store.getWorkItem(item.id);
                        if (fresh) this.store.updateWorkItem(item.id, { ticket: { ...fresh.ticket, status: to } });
                        log("status", `Moved to ${to}`, true);
                    }
                }
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                log(doing, message, false);
                this.bus.emit("notice", { kind: "jira_write_failed", severity: "warning", title: `Could not update ${key} in Jira`, text: message, path: `/work/${item.id}`, dedupeKey: `jira-write:${key}:${item.state}:${item.attempts}` });
            }
        });
        this.chains.set(key, job);
        void job.finally(() => this.chains.get(key) === job && this.chains.delete(key));
    }
    /** Resolves when no write-back is in flight. For tests and shutdown. */
    async settled() {
        while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
    }

    /** Start as many queued items as the limits allow, in rank order. */
    dispatch() {
        const { wipPerAgent } = this.settings();
        const active = this.store.listWorkItems({ states: ACTIVE_WORK_STATES });
        const load = new Map<string, number>();
        for (const item of active) if (item.agentId) load.set(item.agentId, (load.get(item.agentId) ?? 0) + 1);

        for (const item of this.store.listWorkItems({ states: ["queued"] })) {
            if (item.held || !item.agentId) continue;
            if ((load.get(item.agentId) ?? 0) >= wipPerAgent) continue;
            const agent = this.store.getAgent(item.agentId);
            const revision = agent && !agent.archived ? this.store.getRevision(agent.activeRevisionId) : undefined;
            if (!agent || !revision) {
                this.setState(item, "inbox", { agentId: null, ruleId: null, note: "Its agent is archived or gone; assign another" });
                continue;
            }
            const template = (item.ruleId && this.store.getRule(item.ruleId)?.promptTemplate) || DEFAULT_TICKET_PROMPT;
            const run = this.store.createRun({ agentId: agent.id, revision, source: { kind: "work", workItemId: item.id }, prompt: renderPrompt(template, item.ticket), payload: item.ticket });
            this.setState(item, "working", { runId: run.id, attempts: item.attempts + 1, progress: null, note: null, finishedAt: null });
            load.set(agent.id, (load.get(agent.id) ?? 0) + 1);
            this.engine.enqueue(run);
        }
    }

    private onRun = (run: Run) => {
        if (run.source.kind !== "work" || !run.source.workItemId) return;
        const item = this.store.getWorkItem(run.source.workItemId);
        // Only the item's current attempt may move it; a late event from an old run must not.
        if (!item || item.runId !== run.id || !ACTIVE_WORK_STATES.includes(item.state)) return;
        switch (run.status) {
            case "running":
                if (item.state !== "working") this.setState(item, "working", { note: null });
                break;
            case "waiting_approval": {
                const approval = this.store.listApprovals({ runId: run.id, status: "pending" })[0];
                this.setState(item, "needs_you", { note: approval ? `${approval.kind === "question" ? "Question" : "Approve"}: ${approval.summary}` : "Waiting for an approval" });
                break;
            }
            case "succeeded":
                this.setState(item, item.review ? "review" : "done", { note: null, progress: null });
                this.dispatch();
                break;
            case "failed": {
                const retry = TRANSIENT.test(run.error ?? "") && item.attempts < this.settings().maxAttempts;
                if (retry) this.setState(item, "queued", { note: `Retrying after: ${run.error}`, progress: null });
                else this.setState(item, "failed", { note: run.error ?? "The run failed", progress: null });
                this.dispatch();
                break;
            }
            case "cancelled":
                this.setState(item, "failed", { note: "The run was cancelled", progress: null });
                this.dispatch();
                break;
        }
    };

    private onEvent = (event: RunEvent) => {
        if (event.type !== "foreman.progress") return;
        const item = this.store.findWorkItemByRun(event.runId);
        if (!item || !ACTIVE_WORK_STATES.includes(item.state)) return;
        const d = event.data as { step: number; total: number; message: string };
        this.store.updateWorkItem(item.id, { progress: { step: d.step, total: d.total, message: d.message } });
        this.bus.emit("change", "work");
    };

    // ── actions ───────────────────────────────────────────────────────────
    private require(itemId: string): WorkItem {
        const item = this.store.getWorkItem(itemId);
        if (!item) throw new Error(`Work item ${itemId} not found`);
        return item;
    }
    private stopRun(item: WorkItem, actor: string) {
        if (item.runId && ACTIVE_WORK_STATES.includes(item.state)) {
            // Detach first so the cancelled run cannot mark the item failed.
            this.store.updateWorkItem(item.id, { runId: null });
            this.engine.cancel(item.runId, { kind: "system", id: actor });
        }
    }

    assign(itemId: string, agentId: string): WorkItem {
        const item = this.require(itemId);
        if (ACTIVE_WORK_STATES.includes(item.state)) throw new Error("Stop the current attempt before reassigning (retry or skip it first)");
        const updated = this.setState(item, "queued", { agentId, ruleId: null, note: null, held: false });
        this.dispatch();
        return this.store.getWorkItem(updated.id)!;
    }
    /** Answer the question an agent asked about this ticket; its run continues with the answer. */
    answer(itemId: string, answer: string, actor: Actor): WorkItem {
        const item = this.require(itemId);
        const question = item.runId ? this.store.listApprovals({ runId: item.runId, status: "pending" }).find((a) => a.kind === "question") : undefined;
        if (!question) throw new Error("No question is waiting on this ticket");
        this.engine.decideApproval(question.id, true, actor, answer);
        return this.store.getWorkItem(item.id)!;
    }
    retry(itemId: string, actor = "work"): WorkItem {
        const item = this.require(itemId);
        if (!item.agentId) throw new Error("Assign an agent first");
        this.stopRun(item, actor);
        const updated = this.setState(item, "queued", { note: null, progress: null, held: false });
        this.dispatch();
        return this.store.getWorkItem(updated.id)!;
    }
    hold(itemId: string, held: boolean): WorkItem {
        const item = this.require(itemId);
        const updated = this.store.updateWorkItem(item.id, { held });
        this.bus.emit("change", "work");
        if (!held) this.dispatch();
        return this.store.getWorkItem(updated.id)!;
    }
    skip(itemId: string, reason?: string, actor = "work"): WorkItem {
        const item = this.require(itemId);
        this.stopRun(item, actor);
        const updated = this.setState(item, "skipped", { note: reason ?? "Skipped", progress: null });
        this.dispatch();
        return updated;
    }
    complete(itemId: string): WorkItem {
        const item = this.require(itemId);
        if (ACTIVE_WORK_STATES.includes(item.state)) throw new Error("An attempt is still running");
        return this.setState(item, "done", { note: null });
    }
    /** Move within the queue: to the top, the bottom, or just ahead of another item. */
    rank(itemId: string, where: { position?: "top" | "bottom"; beforeItemId?: string }): WorkItem {
        const item = this.require(itemId);
        const { min, max } = this.store.rankBounds();
        let rank: number;
        if (where.beforeItemId) {
            const queue = this.store.listWorkItems({ states: ["queued", "inbox"] }).filter((i) => i.id !== item.id);
            const index = queue.findIndex((i) => i.id === where.beforeItemId);
            if (index < 0) throw new Error("The item to move ahead of is not in the queue");
            const next = queue[index]!.rank;
            rank = index === 0 ? next - 1e6 : (queue[index - 1]!.rank + next) / 2;
        } else rank = where.position === "bottom" ? max + 1e6 : min - 1e6;
        const updated = this.store.updateWorkItem(item.id, { rank });
        this.bus.emit("change", "work");
        return updated;
    }

    // ── numbers ───────────────────────────────────────────────────────────
    stats() {
        const items = this.store.listWorkItems({ limit: 2000 });
        const count = (state: WorkState) => items.filter((i) => i.state === state).length;
        const dayAgo = Date.now() - 86_400_000;
        const weekAgo = Date.now() - 7 * 86_400_000;
        const done = items.filter((i) => i.state === "done" && i.finishedAt);
        const cycle = done.filter((i) => Date.parse(i.finishedAt!) >= weekAgo && i.queuedAt).map((i) => Date.parse(i.finishedAt!) - Date.parse(i.queuedAt!)).sort((a, b) => a - b);
        const queued = items.filter((i) => i.state === "queued");
        const finished = items.filter((i) => ["done", "review", "failed"].includes(i.state));
        return {
            byState: { inbox: count("inbox"), queued: count("queued"), working: count("working"), needs_you: count("needs_you"), review: count("review"), done: count("done"), failed: count("failed"), skipped: count("skipped") },
            doneLast24h: done.filter((i) => Date.parse(i.finishedAt!) >= dayAgo).length,
            medianCycleMs: cycle.length ? cycle[Math.floor(cycle.length / 2)]! : null,
            p90CycleMs: cycle.length ? cycle[Math.min(cycle.length - 1, Math.floor(cycle.length * 0.9))]! : null,
            oldestQueuedAt: queued.map((i) => i.queuedAt ?? i.receivedAt).sort()[0] ?? null,
            firstTimeRate: finished.length ? finished.filter((i) => i.state !== "failed" && i.attempts <= 1).length / finished.length : null,
            held: items.filter((i) => i.held && i.state === "queued").length,
        };
    }
}
