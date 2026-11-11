import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
    AgentSpec,
    emptyUsage,
    type Agent,
    type Approval,
    type AuditEntry,
    type Revision,
    type RoutingMatch,
    type RoutingRule,
    type Ticket,
    type WorkItem,
    type WorkState,
    type Run,
    type RunEvent,
    type RunSource,
    type RunStatus,
    type RunUsage,
    type Trigger,
    type TriggerConfig,
} from "./schemas.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  active_revision_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, number INTEGER NOT NULL, spec TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (agent_id, number)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, revision_id TEXT NOT NULL, revision_number INTEGER NOT NULL,
  status TEXT NOT NULL, source TEXT NOT NULL, prompt TEXT NOT NULL, payload TEXT,
  output TEXT, error TEXT, session_id TEXT, usage TEXT NOT NULL,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, tool_name TEXT,
  summary TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
  decided_by TEXT, reason TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status);
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL, prompt_template TEXT NOT NULL, secret TEXT NOT NULL,
  last_fired_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, key TEXT NOT NULL, ticket TEXT NOT NULL, state TEXT NOT NULL,
  agent_id TEXT, rule_id TEXT, review INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, rank REAL NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, run_id TEXT, progress TEXT, note TEXT,
  received_at TEXT NOT NULL, queued_at TEXT, started_at TEXT, finished_at TEXT,
  UNIQUE (source, key)
);
CREATE INDEX IF NOT EXISTS work_state ON work_items (state, rank);
CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL,
  match TEXT NOT NULL, agent_id TEXT NOT NULL, review INTEGER NOT NULL DEFAULT 0, prompt_template TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, capability TEXT NOT NULL,
  input TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT
);
`;

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const json = (v: unknown) => JSON.stringify(v ?? null);

const toAgent = (r: Row): Agent => ({
    id: r.id,
    name: r.name,
    description: r.description,
    activeRevisionId: r.active_revision_id,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});
const toRevision = (r: Row): Revision => ({
    id: r.id,
    agentId: r.agent_id,
    number: r.number,
    spec: AgentSpec.parse(JSON.parse(r.spec)),
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
});
const toRun = (r: Row): Run => ({
    id: r.id,
    agentId: r.agent_id,
    revisionId: r.revision_id,
    revisionNumber: r.revision_number,
    status: r.status,
    source: JSON.parse(r.source),
    prompt: r.prompt,
    payload: r.payload ? JSON.parse(r.payload) : undefined,
    output: r.output,
    error: r.error,
    sessionId: r.session_id,
    usage: JSON.parse(r.usage),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
});
const toEvent = (r: Row): RunEvent => ({ runId: r.run_id, seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) });
const toApproval = (r: Row): Approval => ({
    id: r.id,
    runId: r.run_id,
    agentId: r.agent_id,
    kind: r.kind,
    toolName: r.tool_name,
    summary: r.summary,
    request: JSON.parse(r.request),
    status: r.status,
    decidedBy: r.decided_by,
    reason: r.reason,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
});
const toTrigger = (r: Row): Trigger => ({
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    enabled: !!r.enabled,
    config: JSON.parse(r.config),
    promptTemplate: r.prompt_template,
    secret: r.secret,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
});

const toWorkItem = (r: Row): WorkItem => ({
    id: r.id,
    ticket: JSON.parse(r.ticket),
    state: r.state,
    agentId: r.agent_id,
    ruleId: r.rule_id,
    review: !!r.review,
    held: !!r.held,
    rank: r.rank,
    attempts: r.attempts,
    runId: r.run_id,
    progress: r.progress ? JSON.parse(r.progress) : null,
    note: r.note,
    receivedAt: r.received_at,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
});
const toRule = (r: Row): RoutingRule => ({
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    position: r.position,
    match: JSON.parse(r.match),
    agentId: r.agent_id,
    review: !!r.review,
    promptTemplate: r.prompt_template,
    createdAt: r.created_at,
});

export class Store {
    readonly db: DatabaseSync;

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        this.db.exec(SCHEMA);
    }

    close() {
        this.db.close();
    }

    private all(sql: string, ...params: any[]): Row[] {
        return this.db.prepare(sql).all(...params) as Row[];
    }
    private one(sql: string, ...params: any[]): Row | undefined {
        return this.db.prepare(sql).get(...params) as Row | undefined;
    }
    private run(sql: string, ...params: any[]) {
        return this.db.prepare(sql).run(...params);
    }
    private tx<T>(fn: () => T): T {
        this.db.exec("BEGIN");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }

    // ── agents & revisions ────────────────────────────────────────────────
    listAgents(includeArchived = false): Agent[] {
        return this.all(`SELECT * FROM agents ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY name COLLATE NOCASE`).map(toAgent);
    }
    getAgent(agentId: string): Agent | undefined {
        const r = this.one("SELECT * FROM agents WHERE id = ?", agentId);
        return r && toAgent(r);
    }
    createAgent(input: { name: string; description: string; spec: AgentSpec; note: string; actor: string }): { agent: Agent; revision: Revision } {
        return this.tx(() => {
            const agentId = id("agt");
            const revisionId = id("rev");
            const ts = now();
            this.run("INSERT INTO revisions (id, agent_id, number, spec, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)", revisionId, agentId, 1, json(input.spec), input.note, input.actor, ts);
            this.run("INSERT INTO agents (id, name, description, active_revision_id, created_at, updated_at) VALUES (?,?,?,?,?,?)", agentId, input.name, input.description, revisionId, ts, ts);
            return { agent: this.getAgent(agentId)!, revision: this.getRevision(revisionId)! };
        });
    }
    updateAgentMeta(agentId: string, patch: { name?: string; description?: string; archived?: boolean; activeRevisionId?: string }) {
        const a = this.getAgent(agentId);
        if (!a) throw new Error(`Agent ${agentId} not found`);
        this.run(
            "UPDATE agents SET name = ?, description = ?, archived = ?, active_revision_id = ?, updated_at = ? WHERE id = ?",
            patch.name ?? a.name,
            patch.description ?? a.description,
            (patch.archived ?? a.archived) ? 1 : 0,
            patch.activeRevisionId ?? a.activeRevisionId,
            now(),
            agentId,
        );
        return this.getAgent(agentId)!;
    }
    addRevision(agentId: string, spec: AgentSpec, note: string, actor: string, activate: boolean): Revision {
        return this.tx(() => {
            const next = (this.one("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM revisions WHERE agent_id = ?", agentId)!.n as number) ?? 1;
            const revisionId = id("rev");
            this.run("INSERT INTO revisions (id, agent_id, number, spec, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)", revisionId, agentId, next, json(spec), note, actor, now());
            if (activate) this.updateAgentMeta(agentId, { activeRevisionId: revisionId });
            return this.getRevision(revisionId)!;
        });
    }
    getRevision(revisionId: string): Revision | undefined {
        const r = this.one("SELECT * FROM revisions WHERE id = ?", revisionId);
        return r && toRevision(r);
    }
    listRevisions(agentId: string): Revision[] {
        return this.all("SELECT * FROM revisions WHERE agent_id = ? ORDER BY number DESC", agentId).map(toRevision);
    }

    // ── runs ──────────────────────────────────────────────────────────────
    createRun(input: { agentId: string; revision: Revision; source: RunSource; prompt: string; payload?: unknown }): Run {
        const runId = id("run");
        this.run(
            "INSERT INTO runs (id, agent_id, revision_id, revision_number, status, source, prompt, payload, usage, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            runId,
            input.agentId,
            input.revision.id,
            input.revision.number,
            "queued",
            json(input.source),
            input.prompt,
            input.payload === undefined ? null : json(input.payload),
            json(emptyUsage()),
            now(),
        );
        return this.getRun(runId)!;
    }
    getRun(runId: string): Run | undefined {
        const r = this.one("SELECT * FROM runs WHERE id = ?", runId);
        return r && toRun(r);
    }
    listRuns(filter: { agentId?: string; status?: RunStatus[]; limit?: number; before?: string } = {}): Run[] {
        const where: string[] = [];
        const params: any[] = [];
        if (filter.agentId) (where.push("agent_id = ?"), params.push(filter.agentId));
        if (filter.status?.length) (where.push(`status IN (${filter.status.map(() => "?").join(",")})`), params.push(...filter.status));
        if (filter.before) (where.push("created_at < ?"), params.push(filter.before));
        params.push(Math.min(filter.limit ?? 50, 500));
        return this.all(`SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`, ...params).map(toRun);
    }
    updateRun(runId: string, patch: Partial<Pick<Run, "status" | "output" | "error" | "sessionId" | "startedAt" | "finishedAt">> & { usage?: RunUsage }): Run {
        const map: Record<string, string> = { status: "status", output: "output", error: "error", sessionId: "session_id", startedAt: "started_at", finishedAt: "finished_at", usage: "usage" };
        const sets: string[] = [];
        const params: any[] = [];
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) continue;
            sets.push(`${map[k]} = ?`);
            params.push(k === "usage" ? json(v) : v);
        }
        if (sets.length) this.run(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, ...params, runId);
        return this.getRun(runId)!;
    }

    // ── events ────────────────────────────────────────────────────────────
    appendEvent(runId: string, type: string, data: unknown): RunEvent {
        const seq = (this.one("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE run_id = ?", runId)!.n as number) ?? 1;
        const ts = now();
        this.run("INSERT INTO events (run_id, seq, ts, type, data) VALUES (?,?,?,?,?)", runId, seq, ts, type, json(data));
        return { runId, seq, ts, type, data };
    }
    listEvents(runId: string, opts: { afterSeq?: number; limit?: number; types?: string[] } = {}): RunEvent[] {
        const where = ["run_id = ?", "seq > ?"];
        const params: any[] = [runId, opts.afterSeq ?? 0];
        if (opts.types?.length) (where.push(`type IN (${opts.types.map(() => "?").join(",")})`), params.push(...opts.types));
        params.push(Math.min(opts.limit ?? 2000, 10_000));
        return this.all(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`, ...params).map(toEvent);
    }

    // ── approvals ─────────────────────────────────────────────────────────
    createApproval(input: { runId: string; agentId: string; kind: string; toolName?: string; summary: string; request: unknown }): Approval {
        const approvalId = id("apr");
        this.run(
            "INSERT INTO approvals (id, run_id, agent_id, kind, tool_name, summary, request, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            approvalId,
            input.runId,
            input.agentId,
            input.kind,
            input.toolName ?? null,
            input.summary,
            json(input.request),
            "pending",
            now(),
        );
        return this.getApproval(approvalId)!;
    }
    getApproval(approvalId: string): Approval | undefined {
        const r = this.one("SELECT * FROM approvals WHERE id = ?", approvalId);
        return r && toApproval(r);
    }
    listApprovals(filter: { status?: Approval["status"]; runId?: string; limit?: number } = {}): Approval[] {
        const where: string[] = [];
        const params: any[] = [];
        if (filter.status) (where.push("status = ?"), params.push(filter.status));
        if (filter.runId) (where.push("run_id = ?"), params.push(filter.runId));
        params.push(Math.min(filter.limit ?? 100, 500));
        return this.all(`SELECT * FROM approvals ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`, ...params).map(toApproval);
    }
    decideApproval(approvalId: string, status: "approved" | "denied" | "expired", decidedBy: string, reason?: string): Approval {
        const res = this.run("UPDATE approvals SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'", status, decidedBy, reason ?? null, now(), approvalId);
        if (res.changes === 0) throw new Error(`Approval ${approvalId} is not pending`);
        return this.getApproval(approvalId)!;
    }

    // ── triggers ──────────────────────────────────────────────────────────
    createTrigger(input: { agentId: string; name: string; config: TriggerConfig; promptTemplate: string; enabled: boolean }): Trigger {
        const triggerId = id("trg");
        this.run(
            "INSERT INTO triggers (id, agent_id, name, enabled, config, prompt_template, secret, created_at) VALUES (?,?,?,?,?,?,?,?)",
            triggerId,
            input.agentId,
            input.name,
            input.enabled ? 1 : 0,
            json(input.config),
            input.promptTemplate,
            randomBytes(18).toString("base64url"),
            now(),
        );
        return this.getTrigger(triggerId)!;
    }
    getTrigger(triggerId: string): Trigger | undefined {
        const r = this.one("SELECT * FROM triggers WHERE id = ?", triggerId);
        return r && toTrigger(r);
    }
    listTriggers(agentId?: string): Trigger[] {
        return (agentId ? this.all("SELECT * FROM triggers WHERE agent_id = ? ORDER BY created_at", agentId) : this.all("SELECT * FROM triggers ORDER BY created_at")).map(toTrigger);
    }
    updateTrigger(triggerId: string, patch: { name?: string; enabled?: boolean; config?: TriggerConfig; promptTemplate?: string; lastFiredAt?: string }): Trigger {
        const t = this.getTrigger(triggerId);
        if (!t) throw new Error(`Trigger ${triggerId} not found`);
        this.run(
            "UPDATE triggers SET name = ?, enabled = ?, config = ?, prompt_template = ?, last_fired_at = ? WHERE id = ?",
            patch.name ?? t.name,
            (patch.enabled ?? t.enabled) ? 1 : 0,
            json(patch.config ?? t.config),
            patch.promptTemplate ?? t.promptTemplate,
            patch.lastFiredAt ?? t.lastFiredAt,
            triggerId,
        );
        return this.getTrigger(triggerId)!;
    }
    deleteTrigger(triggerId: string) {
        this.run("DELETE FROM triggers WHERE id = ?", triggerId);
    }

    // ── audit ─────────────────────────────────────────────────────────────
    audit(entry: { actor: string; capability: string; input: unknown; ok: boolean; error?: string }) {
        this.run("INSERT INTO audit (ts, actor, capability, input, ok, error) VALUES (?,?,?,?,?,?)", now(), entry.actor, entry.capability, json(entry.input), entry.ok ? 1 : 0, entry.error ?? null);
    }
    listAudit(limit = 100): AuditEntry[] {
        return this.all("SELECT * FROM audit ORDER BY id DESC LIMIT ?", Math.min(limit, 1000)).map((r) => ({
            id: r.id,
            ts: r.ts,
            actor: r.actor,
            capability: r.capability,
            input: JSON.parse(r.input),
            ok: !!r.ok,
            error: r.error,
        }));
    }

    // ── work items ────────────────────────────────────────────────────────
    createWorkItem(input: { ticket: Ticket; state: WorkState; agentId: string | null; ruleId: string | null; review: boolean; rank: number }): WorkItem {
        const itemId = id("wrk");
        const ts = now();
        this.run(
            "INSERT INTO work_items (id, source, key, ticket, state, agent_id, rule_id, review, rank, received_at, queued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            itemId,
            input.ticket.source,
            input.ticket.key,
            json(input.ticket),
            input.state,
            input.agentId,
            input.ruleId,
            input.review ? 1 : 0,
            input.rank,
            ts,
            input.state === "queued" ? ts : null,
        );
        return this.getWorkItem(itemId)!;
    }
    getWorkItem(itemId: string): WorkItem | undefined {
        const r = this.one("SELECT * FROM work_items WHERE id = ?", itemId);
        return r && toWorkItem(r);
    }
    findWorkItem(source: string, key: string): WorkItem | undefined {
        const r = this.one("SELECT * FROM work_items WHERE source = ? AND key = ? COLLATE NOCASE", source, key);
        return r && toWorkItem(r);
    }
    findWorkItemByRun(runId: string): WorkItem | undefined {
        const r = this.one("SELECT * FROM work_items WHERE run_id = ?", runId);
        return r && toWorkItem(r);
    }
    listWorkItems(filter: { states?: WorkState[]; agentId?: string; project?: string; finishedSince?: string; limit?: number } = {}): WorkItem[] {
        const where: string[] = [];
        const params: any[] = [];
        if (filter.states?.length) (where.push(`state IN (${filter.states.map(() => "?").join(",")})`), params.push(...filter.states));
        if (filter.agentId) (where.push("agent_id = ?"), params.push(filter.agentId));
        if (filter.project) (where.push("json_extract(ticket, '$.project') = ? COLLATE NOCASE"), params.push(filter.project));
        if (filter.finishedSince) (where.push("(finished_at IS NULL OR finished_at >= ?)"), params.push(filter.finishedSince));
        params.push(Math.min(filter.limit ?? 500, 2000));
        return this.all(`SELECT * FROM work_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY rank, received_at LIMIT ?`, ...params).map(toWorkItem);
    }
    updateWorkItem(
        itemId: string,
        patch: Partial<Pick<WorkItem, "ticket" | "state" | "agentId" | "ruleId" | "review" | "held" | "rank" | "attempts" | "runId" | "progress" | "note" | "queuedAt" | "startedAt" | "finishedAt">>,
    ): WorkItem {
        const map: Record<string, string> = {
            ticket: "ticket",
            state: "state",
            agentId: "agent_id",
            ruleId: "rule_id",
            review: "review",
            held: "held",
            rank: "rank",
            attempts: "attempts",
            runId: "run_id",
            progress: "progress",
            note: "note",
            queuedAt: "queued_at",
            startedAt: "started_at",
            finishedAt: "finished_at",
        };
        const sets: string[] = [];
        const params: any[] = [];
        for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) continue;
            sets.push(`${map[k]} = ?`);
            params.push(k === "ticket" || (k === "progress" && v !== null) ? json(v) : typeof v === "boolean" ? (v ? 1 : 0) : v);
        }
        if (sets.length) this.run(`UPDATE work_items SET ${sets.join(", ")} WHERE id = ?`, ...params, itemId);
        return this.getWorkItem(itemId)!;
    }
    rankBounds(): { min: number; max: number } {
        const r = this.one("SELECT COALESCE(MIN(rank), 0) AS min, COALESCE(MAX(rank), 0) AS max FROM work_items WHERE state IN ('queued','inbox')")!;
        return { min: r.min, max: r.max };
    }
    listRunsForWorkItem(itemId: string): Run[] {
        return this.all("SELECT * FROM runs WHERE json_extract(source, '$.workItemId') = ? ORDER BY created_at DESC, rowid DESC", itemId).map(toRun);
    }

    // ── routing rules ─────────────────────────────────────────────────────
    listRules(): RoutingRule[] {
        return this.all("SELECT * FROM routing_rules ORDER BY position, created_at").map(toRule);
    }
    getRule(ruleId: string): RoutingRule | undefined {
        const r = this.one("SELECT * FROM routing_rules WHERE id = ?", ruleId);
        return r && toRule(r);
    }
    createRule(input: { name: string; match: RoutingMatch; agentId: string; review: boolean; promptTemplate: string; enabled: boolean }): RoutingRule {
        const ruleId = id("rul");
        const position = (this.one("SELECT COALESCE(MAX(position), 0) + 1 AS n FROM routing_rules")!.n as number) ?? 1;
        this.run(
            "INSERT INTO routing_rules (id, name, enabled, position, match, agent_id, review, prompt_template, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ruleId,
            input.name,
            input.enabled ? 1 : 0,
            position,
            json(input.match),
            input.agentId,
            input.review ? 1 : 0,
            input.promptTemplate,
            now(),
        );
        return this.getRule(ruleId)!;
    }
    updateRule(ruleId: string, patch: Partial<Pick<RoutingRule, "name" | "enabled" | "position" | "match" | "agentId" | "review" | "promptTemplate">>): RoutingRule {
        const r = this.getRule(ruleId);
        if (!r) throw new Error(`Rule ${ruleId} not found`);
        const n = { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
        this.run(
            "UPDATE routing_rules SET name = ?, enabled = ?, position = ?, match = ?, agent_id = ?, review = ?, prompt_template = ? WHERE id = ?",
            n.name,
            n.enabled ? 1 : 0,
            n.position,
            json(n.match),
            n.agentId,
            n.review ? 1 : 0,
            n.promptTemplate,
            ruleId,
        );
        return this.getRule(ruleId)!;
    }
    deleteRule(ruleId: string) {
        this.run("DELETE FROM routing_rules WHERE id = ?", ruleId);
    }

    // ── settings ──────────────────────────────────────────────────────────
    getSetting<T>(key: string): T | undefined {
        const r = this.one("SELECT value FROM settings WHERE key = ?", key);
        return r ? (JSON.parse(r.value) as T) : undefined;
    }
    setSetting(key: string, value: unknown) {
        this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, json(value));
    }

    // ── insights ──────────────────────────────────────────────────────────
    runStats(sinceIso: string, agentId?: string) {
        const rows = this.all(`SELECT agent_id, status, usage, started_at, finished_at FROM runs WHERE created_at >= ? ${agentId ? "AND agent_id = ?" : ""}`, ...(agentId ? [sinceIso, agentId] : [sinceIso]));
        return rows.map((r) => ({
            agentId: r.agent_id as string,
            status: r.status as RunStatus,
            usage: JSON.parse(r.usage) as RunUsage,
            durationMs: r.started_at && r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null,
        }));
    }
    toolEvents(sinceIso: string, agentId?: string): { runId: string; type: string; data: any }[] {
        return this.all(
            `SELECT e.run_id, e.type, e.data FROM events e JOIN runs r ON r.id = e.run_id
             WHERE r.created_at >= ? ${agentId ? "AND r.agent_id = ?" : ""} AND e.type IN ('tool.execution_start','tool.execution_complete') ORDER BY e.run_id, e.seq`,
            ...(agentId ? [sinceIso, agentId] : [sinceIso]),
        ).map((r) => ({ runId: r.run_id, type: r.type, data: JSON.parse(r.data) }));
    }
}
