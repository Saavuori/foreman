import { randomUUID } from "node:crypto";
import type { NotifyHub } from "./notify.ts";
import type { Bus } from "./registry.ts";
import type { WorkItem, WorkState } from "./schemas.ts";
import type { Store } from "./store.ts";
import type { WorkHub } from "./work.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, name TEXT NOT NULL, jql TEXT NOT NULL DEFAULT '', agent_id TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS batch_items (batch_id TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (batch_id, item_id));
CREATE INDEX IF NOT EXISTS batch_items_item ON batch_items (item_id);
`;

export interface Batch {
    id: string;
    name: string;
    /** The Jira filter the batch was built from; empty when it was built from a list of keys. */
    jql: string;
    /** Agent that takes tickets no routing rule claims. */
    agentId: string | null;
    state: "open" | "complete";
    createdAt: string;
    completedAt: string | null;
}

export interface BatchProgress {
    total: number;
    done: number;
    working: number;
    /** Stopped for a person: an approval, a question or a review. */
    waiting: number;
    queued: number;
    failed: number;
    skipped: number;
    credits: number;
    attempts: number;
    /** A projection from how fast this batch has gone so far; null until two tickets have finished. */
    estimatedFinishAt: string | null;
}

const GROUP: Record<WorkState, keyof Pick<BatchProgress, "done" | "working" | "waiting" | "queued" | "failed" | "skipped">> = {
    inbox: "queued",
    queued: "queued",
    working: "working",
    needs_you: "waiting",
    review: "waiting",
    done: "done",
    failed: "failed",
    skipped: "skipped",
};
const mins = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/**
 * A batch is a set of tickets tracked as one job — "work through these 40". It adds nothing to how
 * tickets are worked; it watches them, reports progress and cost, and says once when all are finished.
 */
export class BatchHub {
    constructor(
        private store: Store,
        private bus: Bus,
        private work: WorkHub,
        private notify: NotifyHub,
        private options: { baseUrl: string },
    ) {
        store.db.exec(SCHEMA);
    }

    private q<T = any>(sql: string, ...params: any[]): T[] {
        return this.store.db.prepare(sql).all(...params) as T[];
    }
    private x(sql: string, ...params: any[]) {
        return this.store.db.prepare(sql).run(...params);
    }
    private toBatch = (r: any): Batch => ({ id: r.id, name: r.name, jql: r.jql, agentId: r.agent_id, state: r.state, createdAt: r.created_at, completedAt: r.completed_at });

    start() {
        this.bus.on("work", this.onWork);
    }
    stop() {
        this.bus.off("work", this.onWork);
    }

    list(): Batch[] {
        return this.q("SELECT * FROM batches ORDER BY created_at DESC").map(this.toBatch);
    }
    get(batchId: string): Batch | undefined {
        return this.q("SELECT * FROM batches WHERE id = ?", batchId).map(this.toBatch)[0];
    }
    private require(batchId: string): Batch {
        const batch = this.get(batchId);
        if (!batch) throw new Error(`Batch ${batchId} not found`);
        return batch;
    }
    itemIds(batchId: string): string[] {
        return this.q<{ item_id: string }>("SELECT item_id FROM batch_items WHERE batch_id = ?", batchId).map((r) => r.item_id);
    }
    items(batchId: string): WorkItem[] {
        return this.itemIds(batchId).map((id) => this.store.getWorkItem(id)).filter((i): i is WorkItem => !!i);
    }
    /** Which batches each work item belongs to, for labelling the board. */
    membership(): Map<string, { id: string; name: string }[]> {
        const out = new Map<string, { id: string; name: string }[]>();
        for (const r of this.q<{ item_id: string; id: string; name: string }>("SELECT bi.item_id, b.id, b.name FROM batch_items bi JOIN batches b ON b.id = bi.batch_id")) out.set(r.item_id, [...(out.get(r.item_id) ?? []), { id: r.id, name: r.name }]);
        return out;
    }

    /** Put tickets in the batch; ones that no rule routed go to the batch's agent, if it has one. */
    private adopt(batch: Batch, items: WorkItem[]): number {
        let added = 0;
        for (const item of items) {
            added += Number(this.x("INSERT OR IGNORE INTO batch_items (batch_id, item_id) VALUES (?, ?)", batch.id, item.id).changes);
            if (batch.agentId && item.state === "inbox") this.work.assign(item.id, batch.agentId);
        }
        return added;
    }

    async create(input: { name: string; jql?: string; keys?: string[]; agentId?: string | null }): Promise<{ batch: Batch; added: number; notFound: string[] }> {
        const jql = (input.jql ?? "").trim();
        if (!jql && !input.keys?.length) throw new Error("A batch needs a Jira filter (JQL) or a list of ticket keys");
        // Ask Jira before saving anything, so a filter that cannot run leaves no empty batch behind.
        const found = jql ? await this.work.jira().search(jql, undefined, 500) : [];
        const batch: Batch = { id: `bat_${randomUUID().replace(/-/g, "").slice(0, 12)}`, name: input.name, jql, agentId: input.agentId || null, state: "open", createdAt: new Date().toISOString(), completedAt: null };
        this.x("INSERT INTO batches (id, name, jql, agent_id, state, created_at) VALUES (?,?,?,?,?,?)", batch.id, batch.name, batch.jql, batch.agentId, batch.state, batch.createdAt);
        let added = this.adopt(batch, found.map((ticket) => this.work.ingest(ticket).item));
        let notFound: string[] = [];
        if (input.keys?.length) {
            const byKey = await this.work.addByKeys(input.keys);
            added += this.adopt(batch, [...byKey.added, ...byKey.existing]);
            notFound = byKey.missing;
        }
        this.work.dispatch();
        this.bus.emit("change", "work");
        return { batch, added, notFound };
    }

    /** Run the batch's filter again and take in tickets that match it now. */
    async refresh(batchId: string): Promise<{ added: number }> {
        const batch = this.require(batchId);
        if (!batch.jql) return { added: 0 };
        const added = this.adopt(batch, (await this.work.jira().search(batch.jql, undefined, 500)).map((ticket) => this.work.ingest(ticket).item));
        this.work.dispatch();
        this.check(batch.id);
        this.bus.emit("change", "work");
        return { added };
    }

    /** Stop tracking. The tickets stay on the board. */
    delete(batchId: string) {
        this.require(batchId);
        this.x("DELETE FROM batch_items WHERE batch_id = ?", batchId);
        this.x("DELETE FROM batches WHERE id = ?", batchId);
        this.bus.emit("change", "work");
    }

    retryFailed(batchId: string, actor: string): number {
        const failed = this.items(batchId).filter((i) => i.state === "failed" && i.agentId);
        for (const item of failed) this.work.retry(item.id, actor);
        return failed.length;
    }

    progress(batch: Batch): BatchProgress {
        const items = this.items(batch.id);
        const p: BatchProgress = { total: items.length, done: 0, working: 0, waiting: 0, queued: 0, failed: 0, skipped: 0, credits: 0, attempts: 0, estimatedFinishAt: null };
        for (const item of items) p[GROUP[item.state]]++;
        const cost = this.q<{ credits: number | null; runs: number }>(
            "SELECT SUM(json_extract(r.usage, '$.credits')) AS credits, COUNT(*) AS runs FROM runs r JOIN batch_items bi ON bi.item_id = json_extract(r.source, '$.workItemId') WHERE bi.batch_id = ?",
            batch.id,
        )[0];
        p.credits = Math.round((cost?.credits ?? 0) * 100) / 100;
        p.attempts = cost?.runs ?? 0;
        const finished = items.filter((i) => GROUP[i.state] !== "queued" && GROUP[i.state] !== "working" && GROUP[i.state] !== "waiting" && i.finishedAt && i.finishedAt >= batch.createdAt);
        const remaining = p.queued + p.working + p.waiting;
        if (remaining && finished.length >= 2) {
            const last = Math.max(...finished.map((i) => Date.parse(i.finishedAt!)));
            const perTicket = (last - Date.parse(batch.createdAt)) / finished.length;
            p.estimatedFinishAt = new Date(Date.now() + remaining * perTicket).toISOString();
        }
        return p;
    }

    private onWork = (item: WorkItem) => {
        for (const r of this.q<{ batch_id: string }>("SELECT batch_id FROM batch_items WHERE item_id = ?", item.id)) this.check(r.batch_id);
    };

    /** Mark the batch complete (and say so, once) when every ticket has finished; reopen it if one is retried. */
    private check(batchId: string) {
        const batch = this.get(batchId);
        if (!batch) return;
        const p = this.progress(batch);
        const complete = p.total > 0 && p.queued + p.working + p.waiting === 0;
        if (complete === (batch.state === "complete")) return;
        if (!complete) {
            this.x("UPDATE batches SET state = 'open', completed_at = NULL WHERE id = ?", batchId);
            return void this.bus.emit("change", "work");
        }
        const completedAt = new Date().toISOString();
        this.x("UPDATE batches SET state = 'complete', completed_at = ? WHERE id = ?", completedAt, batchId);
        this.bus.emit("change", "work");
        const took = Date.parse(completedAt) - Date.parse(batch.createdAt);
        this.notify.emit({
            kind: "batch_done",
            severity: p.failed ? "warning" : "success",
            title: `Batch “${batch.name}” finished: ${p.done} of ${p.total} done${p.failed ? `, ${p.failed} failed` : ""}`,
            text: p.failed ? "Some tickets failed and need a look." : "Every ticket in the batch is done.",
            facts: [["Done", String(p.done)], ["Failed", String(p.failed)], ...(p.skipped ? ([["Skipped", String(p.skipped)]] as [string, string][]) : []), ["Took", mins(took)], ["Attempts", String(p.attempts)], ["Credits", String(p.credits)]],
            links: [{ title: "Open the batch", url: `${this.options.baseUrl}/#/work/batch/${batch.id}` }],
            path: `/work/batch/${batch.id}`,
            dedupeKey: `batch:${batch.id}:${completedAt}`,
        });
    }
}
