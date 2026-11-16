import type { WorkItem } from "./schemas.ts";
import type { Store } from "./store.ts";

const median = (sorted: number[]) => (sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null);
const p90 = (sorted: number[]) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]! : null);
const round = (n: number) => Math.round(n * 100) / 100;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface FlowOptions {
    /** Days of history for throughput and the per-agent table. */
    days: number;
    /** Hours shown in the queue-depth series. */
    hours: number;
    /** Minutes after which a waiting ticket counts as ageing. */
    agingMinutes: number;
    wipPerAgent: number;
    now?: number;
}

/**
 * Flow numbers for the work queue, computed from what is stored — nothing is sampled. The
 * queue-depth series is rebuilt from each ticket's latest timestamps, so a ticket that was retried
 * is drawn as one stretch of waiting and one of work; treat it as a good approximation.
 */
export function flowMetrics(store: Store, o: FlowOptions) {
    const now = o.now ?? Date.now();
    const since = now - o.days * 86_400_000;
    const items = store.listWorkItems({ limit: 2000 });
    const agents = new Map(store.listAgents(true).map((a) => [a.id, a.name]));

    // Cost and attempts per ticket, and which tickets ever stopped for a person.
    const cost = new Map<string, { credits: number; runs: number }>();
    for (const r of store.db.prepare("SELECT json_extract(source, '$.workItemId') AS item, SUM(json_extract(usage, '$.credits')) AS credits, COUNT(*) AS runs FROM runs WHERE json_extract(source, '$.kind') = 'work' GROUP BY item").all() as any[]) cost.set(r.item, { credits: r.credits ?? 0, runs: r.runs });
    const asked = new Set((store.db.prepare("SELECT DISTINCT json_extract(r.source, '$.workItemId') AS item FROM approvals a JOIN runs r ON r.id = a.run_id WHERE json_extract(r.source, '$.kind') = 'work'").all() as any[]).map((r) => r.item as string));

    const finished = items.filter((i) => (i.state === "done" || i.state === "failed") && i.finishedAt && Date.parse(i.finishedAt) >= since);
    const done = finished.filter((i) => i.state === "done");
    const cycleOf = (i: WorkItem) => Date.parse(i.finishedAt!) - Date.parse(i.queuedAt ?? i.receivedAt);
    const cycles = done.map(cycleOf).sort((a, b) => a - b);

    // Throughput: one bucket per calendar day (UTC), oldest first, including empty days.
    const perDay = new Map<string, { date: string; done: number; failed: number }>();
    for (let t = since + 86_400_000; t <= now + 1; t += 86_400_000) perDay.set(day(t), { date: day(t), done: 0, failed: 0 });
    perDay.set(day(now), perDay.get(day(now)) ?? { date: day(now), done: 0, failed: 0 });
    for (const i of finished) {
        const bucket = perDay.get(day(Date.parse(i.finishedAt!)));
        if (bucket) bucket[i.state === "done" ? "done" : "failed"]++;
    }

    // Queue depth: how many tickets were waiting, and how many were being worked on, at each point.
    const points = 48;
    const span = o.hours * 3_600_000;
    const stretch = items.map((i) => {
        const queuedAt = Date.parse(i.queuedAt ?? i.receivedAt);
        const startedAt = i.startedAt ? Date.parse(i.startedAt) : null;
        const finishedAt = i.finishedAt && ["done", "failed", "skipped", "review"].includes(i.state) ? Date.parse(i.finishedAt) : null;
        return { queuedAt, startedAt, finishedAt, unrouted: i.state === "inbox" };
    });
    const depth = Array.from({ length: points + 1 }, (_, n) => {
        const t = now - span + (span * n) / points;
        let queued = 0;
        let inProgress = 0;
        for (const s of stretch) {
            if (s.queuedAt > t || (s.finishedAt !== null && s.finishedAt <= t)) continue;
            if (s.startedAt !== null && s.startedAt <= t) inProgress++;
            else if (!s.unrouted) queued++;
        }
        return { at: new Date(t).toISOString(), queued, inProgress };
    });

    // Per agent: load now, and results over the window.
    const perAgent = new Map<string, { agentId: string; agentName: string; working: number; waiting: number; queued: number; done: number; failed: number; cycles: number[]; credits: number; firstTime: number }>();
    const row = (agentId: string) => {
        if (!perAgent.has(agentId)) perAgent.set(agentId, { agentId, agentName: agents.get(agentId) ?? agentId, working: 0, waiting: 0, queued: 0, done: 0, failed: 0, cycles: [], credits: 0, firstTime: 0 });
        return perAgent.get(agentId)!;
    };
    for (const i of items) {
        if (!i.agentId) continue;
        const a = row(i.agentId);
        if (i.state === "working") a.working++;
        else if (i.state === "needs_you") a.waiting++;
        else if (i.state === "queued") a.queued++;
    }
    for (const i of finished) {
        if (!i.agentId) continue;
        const a = row(i.agentId);
        a[i.state === "done" ? "done" : "failed"]++;
        a.credits += cost.get(i.id)?.credits ?? 0;
        if (i.state === "done") {
            a.cycles.push(cycleOf(i));
            if (i.attempts <= 1) a.firstTime++;
        }
    }

    const waitingStates = ["queued", "inbox", "needs_you", "review"];
    const waitedSince = (i: WorkItem) => (i.state === "needs_you" ? i.startedAt : i.state === "review" ? i.finishedAt : (i.queuedAt ?? i.receivedAt)) ?? i.receivedAt;
    const ageing = items
        .filter((i) => waitingStates.includes(i.state) && !i.held && now - Date.parse(waitedSince(i)) > o.agingMinutes * 60_000)
        .map((i) => ({ itemId: i.id, key: i.ticket.key, title: i.ticket.title, state: i.state, agentName: i.agentId ? (agents.get(i.agentId) ?? null) : null, waitingSince: waitedSince(i) }))
        .sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));

    const credits = finished.reduce((sum, i) => sum + (cost.get(i.id)?.credits ?? 0), 0);
    const neededPerson = finished.filter((i) => asked.has(i.id) || i.review).length;
    return {
        window: { days: o.days, hours: o.hours, since: new Date(since).toISOString() },
        finished: finished.length,
        done: done.length,
        failed: finished.length - done.length,
        throughput: [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
        cycle: { medianMs: median(cycles), p90Ms: p90(cycles) },
        queueDepth: depth,
        perAgent: [...perAgent.values()]
            .map(({ cycles: c, firstTime, ...a }) => ({ ...a, credits: round(a.credits), wipLimit: o.wipPerAgent, medianCycleMs: median(c.sort((x, y) => x - y)), creditsPerTicket: a.done + a.failed ? round(a.credits / (a.done + a.failed)) : null, firstTimeRate: a.done ? firstTime / a.done : null }))
            .sort((a, b) => b.done + b.working - (a.done + a.working)),
        /** Share of finished tickets that stopped for an approval, a question or a review. */
        neededPersonRate: finished.length ? neededPerson / finished.length : null,
        neededPerson,
        ageing: { thresholdMinutes: o.agingMinutes, count: ageing.length, oldest: ageing.slice(0, 10) },
        cost: { credits: round(credits), perTicket: finished.length ? round(credits / finished.length) : null, attemptsPerTicket: finished.length ? round(finished.reduce((n, i) => n + (cost.get(i.id)?.runs ?? 0), 0) / finished.length) : null },
    };
}

/** Runs laid out per agent on a time axis: what each agent was doing, and when it waited on a person. */
export function runTimeline(store: Store, hours: number, now = Date.now()) {
    const since = new Date(now - hours * 3_600_000).toISOString();
    const agents = new Map(store.listAgents(true).map((a) => [a.id, a.name]));
    const rows = store.db
        .prepare("SELECT id, agent_id, status, source, started_at, finished_at, created_at FROM runs WHERE started_at IS NOT NULL AND (finished_at IS NULL OR finished_at >= ?) ORDER BY started_at LIMIT 3000")
        .all(since) as any[];
    const waits = new Map<string, { from: string; to: string | null }[]>();
    for (const a of store.db.prepare("SELECT run_id, created_at, decided_at FROM approvals WHERE decided_at IS NULL OR decided_at >= ?").all(since) as any[]) waits.set(a.run_id, [...(waits.get(a.run_id) ?? []), { from: a.created_at, to: a.decided_at }]);
    const tickets = new Map<string, { key: string; title: string }>();
    const lanes = new Map<string, { agentId: string; agentName: string; runs: any[] }>();
    for (const r of rows) {
        const source = JSON.parse(r.source);
        let ticket = source.workItemId ? tickets.get(source.workItemId) : undefined;
        if (source.workItemId && !ticket) {
            const item = store.getWorkItem(source.workItemId);
            if (item) tickets.set(source.workItemId, (ticket = { key: item.ticket.key, title: item.ticket.title }));
        }
        if (!lanes.has(r.agent_id)) lanes.set(r.agent_id, { agentId: r.agent_id, agentName: agents.get(r.agent_id) ?? r.agent_id, runs: [] });
        lanes.get(r.agent_id)!.runs.push({ runId: r.id, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, kind: source.kind, itemId: source.workItemId ?? null, key: ticket?.key ?? null, title: ticket?.title ?? null, waits: waits.get(r.id) ?? [] });
    }
    return { from: since, to: new Date(now).toISOString(), lanes: [...lanes.values()].sort((a, b) => a.agentName.localeCompare(b.agentName)) };
}
