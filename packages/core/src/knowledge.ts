import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { builtinEmbed, BUILTIN_DIMENSIONS, ftsQuery, quantize, similarity, toPassages } from "./extract.ts";
import type { Bus } from "./registry.ts";
import type { Store } from "./store.ts";
import type { Vault } from "./vault.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kb_nodes (
    id TEXT PRIMARY KEY, parent_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
    source TEXT, external_id TEXT, url TEXT, status TEXT NOT NULL, error TEXT,
    content TEXT, content_hash TEXT, chars INTEGER NOT NULL DEFAULT 0, passages INTEGER NOT NULL DEFAULT 0,
    source_updated_at TEXT, indexed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kb_nodes_parent ON kb_nodes (parent_id);
CREATE INDEX IF NOT EXISTS kb_nodes_external ON kb_nodes (external_id);
CREATE TABLE IF NOT EXISTS kb_chunks (id INTEGER PRIMARY KEY, node_id TEXT NOT NULL, ord INTEGER NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB, embed_model TEXT);
CREATE INDEX IF NOT EXISTS kb_chunks_node ON kb_chunks (node_id);
CREATE INDEX IF NOT EXISTS kb_chunks_model ON kb_chunks (embed_model);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5 (title, heading, text, tokenize = 'porter unicode61');
`;

export const EmbeddingSettings = z.object({
    /** builtin: matches word parts, no model needed. openai: any OpenAI-compatible /embeddings endpoint. azure: Azure OpenAI. none: keyword search only. */
    kind: z.enum(["builtin", "openai", "azure", "none"]).default("builtin"),
    baseUrl: z.string().default(""),
    /** Model id, or the deployment name on Azure. */
    model: z.string().default(""),
    /** Vault secret holding the API key. Empty for an endpoint that needs none (a local model). */
    secretName: z.string().default(""),
    /** Ask for shorter vectors, for models that support it (text-embedding-3-*). */
    dimensions: z.number().int().min(32).max(4096).optional(),
    apiVersion: z.string().default("2024-10-21"),
});
export type EmbeddingSettings = z.infer<typeof EmbeddingSettings>;

export const KnowledgeSettings = z.object({
    embeddings: EmbeddingSettings.prefault({}),
});
export type KnowledgeSettings = z.infer<typeof KnowledgeSettings>;

export type NodeKind = "folder" | "page" | "file";
export type NodeStatus = "ready" | "failed" | "excluded";

export interface NodeSource {
    kind: "upload" | "text" | "confluence";
    fileName?: string;
    mediaType?: string;
    bytes?: number;
    [key: string]: unknown;
}

export interface KnowledgeNode {
    id: string;
    parentId: string | null;
    kind: NodeKind;
    title: string;
    source: NodeSource | null;
    url: string | null;
    status: NodeStatus;
    error: string | null;
    chars: number;
    passages: number;
    sourceUpdatedAt: string | null;
    indexedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SearchHit {
    nodeId: string;
    title: string;
    /** Where the document sits in the library, e.g. "Engineering › Runbooks". */
    path: string;
    heading: string;
    text: string;
    url: string | null;
    updatedAt: string;
    /** Which searches found it. */
    matchedBy: ("keyword" | "meaning")[];
    score: number;
    similarity: number | null;
}

export interface SearchResult {
    hits: SearchHit[];
    /** keyword + meaning when vectors were used, keyword alone otherwise. */
    mode: "hybrid" | "keyword";
    tookMs: number;
    /** Why meaning search was not used, when it was not. */
    note: string | null;
}

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const newId = () => `kb_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const toNode = (r: Row): KnowledgeNode => ({
    id: r.id,
    parentId: r.parent_id ?? null,
    kind: r.kind,
    title: r.title,
    source: r.source ? JSON.parse(r.source) : null,
    url: r.url ?? null,
    status: r.status,
    error: r.error ?? null,
    chars: r.chars,
    passages: r.passages,
    sourceUpdatedAt: r.source_updated_at ?? null,
    indexedAt: r.indexed_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});
const NODE_COLUMNS = "id, parent_id, kind, title, source, url, status, error, chars, passages, source_updated_at, indexed_at, created_at, updated_at";
const RRF_K = 60;
const CANDIDATES = 60;
const PART_CHARS = 12_000;
const EMBED_BATCH = 32;

/**
 * The knowledge library: a tree of folders, pages and files, their text split into passages, and
 * a hybrid search over them (SQLite full-text search plus embeddings compared in memory). Agents
 * reach it through the knowledge tools, limited to the branches in their spec.
 */
export class KnowledgeHub {
    private vectors: Map<number, { nodeId: string; v: Int8Array }> | null = null;
    private vectorsKey = "";
    private queryCache = new Map<string, Int8Array>();
    private worker: Promise<void> | null = null;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private stopped = false;
    embedState = { error: null as string | null, at: null as string | null };

    constructor(
        private store: Store,
        private bus: Bus,
        private options: { vault: Vault },
    ) {
        store.db.exec(SCHEMA);
    }

    start() {
        this.stopped = false;
        this.kick();
    }
    stop() {
        this.stopped = true;
        clearTimeout(this.retryTimer);
    }
    /** Resolves when no embedding work is in flight (tests). */
    async settled() {
        while (this.worker) await this.worker;
    }

    // ── settings ──────────────────────────────────────────────────────────
    settings(): KnowledgeSettings {
        return KnowledgeSettings.parse(this.store.getSetting("knowledge") ?? {});
    }
    configure(patch: { embeddings?: Partial<EmbeddingSettings> }): KnowledgeSettings {
        const current = this.settings();
        const next = KnowledgeSettings.parse({ ...current, ...patch, embeddings: { ...current.embeddings, ...patch.embeddings } });
        this.store.setSetting("knowledge", next);
        this.queryCache.clear();
        this.embedState = { error: null, at: null };
        this.changed();
        this.kick();
        return next;
    }
    /** Identifies the vector space: vectors made by a different model are never compared. */
    embedderKey(settings = this.settings().embeddings): string | null {
        if (settings.kind === "none") return null;
        if (settings.kind === "builtin") return `builtin:${BUILTIN_DIMENSIONS}`;
        return `${settings.kind}:${settings.baseUrl}:${settings.model}:${settings.dimensions ?? ""}`;
    }
    embedderLabel(settings = this.settings().embeddings): string {
        if (settings.kind === "none") return "Off — keyword search only";
        if (settings.kind === "builtin") return "Built-in (matches word parts, not meaning)";
        return `${settings.model || "(no model)"} at ${settings.baseUrl || "(no address)"}`;
    }

    // ── the tree ──────────────────────────────────────────────────────────
    list(): KnowledgeNode[] {
        return (this.store.db.prepare(`SELECT ${NODE_COLUMNS} FROM kb_nodes ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, title COLLATE NOCASE`).all() as Row[]).map(toNode);
    }
    get(id: string): KnowledgeNode | undefined {
        const r = this.store.db.prepare(`SELECT ${NODE_COLUMNS} FROM kb_nodes WHERE id = ?`).get(id) as Row | undefined;
        return r ? toNode(r) : undefined;
    }
    content(id: string): string {
        return ((this.store.db.prepare("SELECT content FROM kb_nodes WHERE id = ?").get(id) as Row | undefined)?.content as string) ?? "";
    }
    passages(id: string): { heading: string; text: string }[] {
        return this.store.db.prepare("SELECT heading, text FROM kb_chunks WHERE node_id = ? ORDER BY ord").all(id) as { heading: string; text: string }[];
    }
    children(id: string | null): KnowledgeNode[] {
        const rows = id ? this.store.db.prepare(`SELECT ${NODE_COLUMNS} FROM kb_nodes WHERE parent_id = ?`).all(id) : this.store.db.prepare(`SELECT ${NODE_COLUMNS} FROM kb_nodes WHERE parent_id IS NULL`).all();
        return (rows as Row[]).map(toNode);
    }
    /** The ancestors of a node, root first. */
    ancestors(id: string): KnowledgeNode[] {
        const out: KnowledgeNode[] = [];
        let node = this.get(id);
        const seen = new Set<string>();
        while (node?.parentId && !seen.has(node.parentId)) {
            seen.add(node.parentId);
            node = this.get(node.parentId);
            if (node) out.unshift(node);
        }
        return out;
    }
    pathOf(id: string): string {
        return this.ancestors(id)
            .map((n) => n.title)
            .join(" › ");
    }
    /** Every node at or beneath the given ones, leaving out excluded branches. */
    expand(ids: string[]): string[] {
        if (!ids.length) return [];
        const rows = this.store.db
            .prepare(
                `WITH RECURSIVE sub(id) AS (
                    SELECT id FROM kb_nodes WHERE id IN (SELECT value FROM json_each(?)) AND status != 'excluded'
                    UNION SELECT n.id FROM kb_nodes n JOIN sub ON n.parent_id = sub.id WHERE n.status != 'excluded'
                ) SELECT id FROM sub`,
            )
            .all(JSON.stringify(ids)) as Row[];
        return rows.map((r) => r.id as string);
    }
    private findByExternal(externalId: string): KnowledgeNode | undefined {
        const r = this.store.db.prepare(`SELECT ${NODE_COLUMNS} FROM kb_nodes WHERE external_id = ?`).get(externalId) as Row | undefined;
        return r ? toNode(r) : undefined;
    }
    externalId(id: string): string | null {
        return ((this.store.db.prepare("SELECT external_id FROM kb_nodes WHERE id = ?").get(id) as Row | undefined)?.external_id as string) ?? null;
    }

    private checkParent(parentId: string | null | undefined): string | null {
        if (!parentId) return null;
        const parent = this.get(parentId);
        if (!parent) throw new Error(`Knowledge item ${parentId} not found`);
        if (parent.kind === "file") throw new Error(`“${parent.title}” is a file; put things in a folder instead`);
        return parent.id;
    }

    createFolder(title: string, parentId?: string | null): KnowledgeNode {
        const parent = this.checkParent(parentId);
        const id = newId();
        const at = now();
        this.store.db.prepare("INSERT INTO kb_nodes (id, parent_id, kind, title, status, created_at, updated_at) VALUES (?, ?, 'folder', ?, 'ready', ?, ?)").run(id, parent, title.trim(), at, at);
        this.changed();
        return this.get(id)!;
    }

    /** Add a document and index it. `externalId` lets a source find it again on the next sync. */
    addDocument(doc: { parentId?: string | null; kind?: "page" | "file"; title: string; text: string; source: NodeSource; url?: string | null; externalId?: string; sourceUpdatedAt?: string | null }): KnowledgeNode {
        const parent = this.checkParent(doc.parentId);
        const id = newId();
        const at = now();
        this.store.db
            .prepare("INSERT INTO kb_nodes (id, parent_id, kind, title, source, external_id, url, status, source_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)")
            .run(id, parent, doc.kind ?? "file", doc.title.trim(), JSON.stringify(doc.source), doc.externalId ?? null, doc.url ?? null, doc.sourceUpdatedAt ?? null, at, at);
        this.index(id, doc.text);
        this.changed();
        return this.get(id)!;
    }

    /** Replace a document's text (and optionally its title and source details). Re-indexes only when the text changed. */
    updateDocument(id: string, patch: { title?: string; text?: string; source?: NodeSource; url?: string | null; sourceUpdatedAt?: string | null; parentId?: string | null }) {
        const node = this.get(id);
        if (!node) throw new Error(`Knowledge item ${id} not found`);
        const sets: string[] = ["updated_at = ?"];
        const params: any[] = [now()];
        if (patch.title !== undefined) (sets.push("title = ?"), params.push(patch.title.trim()));
        if (patch.source !== undefined) (sets.push("source = ?"), params.push(JSON.stringify(patch.source)));
        if (patch.url !== undefined) (sets.push("url = ?"), params.push(patch.url));
        if (patch.sourceUpdatedAt !== undefined) (sets.push("source_updated_at = ?"), params.push(patch.sourceUpdatedAt));
        if (patch.parentId !== undefined) (sets.push("parent_id = ?"), params.push(patch.parentId));
        this.store.db.prepare(`UPDATE kb_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
        if (node.kind !== "folder" && (patch.text !== undefined || (patch.title !== undefined && patch.title.trim() !== node.title))) this.index(id, patch.text ?? this.content(id), patch.title !== undefined);
        this.changed();
    }

    markFailed(id: string, error: string) {
        this.store.db.prepare("UPDATE kb_nodes SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
        this.changed();
    }

    rename(id: string, title: string) {
        const node = this.get(id);
        if (!node) throw new Error(`Knowledge item ${id} not found`);
        if (node.kind === "folder") {
            this.store.db.prepare("UPDATE kb_nodes SET title = ?, updated_at = ? WHERE id = ?").run(title.trim(), now(), id);
            this.changed();
        } else this.updateDocument(id, { title });
        return this.get(id)!;
    }

    move(id: string, parentId: string | null) {
        const node = this.get(id);
        if (!node) throw new Error(`Knowledge item ${id} not found`);
        const parent = this.checkParent(parentId);
        if (parent && this.expand([id]).includes(parent)) throw new Error("A folder cannot be moved into itself");
        this.store.db.prepare("UPDATE kb_nodes SET parent_id = ?, updated_at = ? WHERE id = ?").run(parent, now(), id);
        this.changed();
        return this.get(id)!;
    }

    /** Delete a node and everything beneath it, passages included. */
    remove(id: string): number {
        const ids = this.subtree(id);
        const db = this.store.db;
        db.exec("BEGIN");
        try {
            for (const nodeId of ids) this.dropPassages(nodeId);
            db.prepare("DELETE FROM kb_nodes WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
            db.exec("COMMIT");
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        this.changed();
        return ids.length;
    }

    /** Keep a node in the tree but out of search, with nothing beneath it. A sync leaves it alone. */
    exclude(id: string) {
        const below = this.subtree(id).filter((n) => n !== id);
        for (const nodeId of below) this.dropPassages(nodeId);
        this.store.db.prepare("DELETE FROM kb_nodes WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(below));
        this.dropPassages(id);
        this.store.db.prepare("UPDATE kb_nodes SET status = 'excluded', content = NULL, content_hash = NULL, chars = 0, passages = 0, updated_at = ? WHERE id = ?").run(now(), id);
        this.changed();
    }

    /** Undo `exclude`. The text comes back with the next sync of its source. */
    include(id: string) {
        this.store.db.prepare("UPDATE kb_nodes SET status = 'ready', error = NULL, updated_at = ? WHERE id = ?").run(now(), id);
        this.changed();
    }

    /** All ids in a subtree, the node itself included, excluded branches too. */
    expandAll(id: string): string[] {
        return this.subtree(id);
    }
    private subtree(id: string): string[] {
        const rows = this.store.db.prepare("WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT n.id FROM kb_nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub").all(id) as Row[];
        return rows.map((r) => r.id as string);
    }

    // ── indexing ──────────────────────────────────────────────────────────
    private dropPassages(nodeId: string) {
        const db = this.store.db;
        const ids = (db.prepare("SELECT id FROM kb_chunks WHERE node_id = ?").all(nodeId) as Row[]).map((r) => r.id as number);
        if (!ids.length) return;
        db.prepare("DELETE FROM kb_fts WHERE rowid IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
        db.prepare("DELETE FROM kb_chunks WHERE node_id = ?").run(nodeId);
        for (const id of ids) this.vectors?.delete(id);
    }

    private index(id: string, text: string, force = false) {
        const node = this.get(id)!;
        const contentHash = hash(`${node.title}\n${text}`);
        const old = this.store.db.prepare("SELECT content_hash FROM kb_nodes WHERE id = ?").get(id) as Row | undefined;
        if (!force && old?.content_hash === contentHash && node.status === "ready" && node.passages) return;
        const passages = toPassages(text);
        const db = this.store.db;
        db.exec("BEGIN");
        try {
            this.dropPassages(id);
            const insertChunk = db.prepare("INSERT INTO kb_chunks (node_id, ord, heading, text) VALUES (?, ?, ?, ?)");
            const insertFts = db.prepare("INSERT INTO kb_fts (rowid, title, heading, text) VALUES (?, ?, ?, ?)");
            passages.forEach((p, ord) => {
                const chunkId = Number(insertChunk.run(id, ord, p.heading, p.text).lastInsertRowid);
                insertFts.run(chunkId, node.title, p.heading, p.text);
            });
            db.prepare("UPDATE kb_nodes SET content = ?, content_hash = ?, chars = ?, passages = ?, status = 'ready', error = NULL, indexed_at = ?, updated_at = ? WHERE id = ?").run(text, contentHash, text.length, passages.length, now(), now(), id);
            db.exec("COMMIT");
        } catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        this.kick();
    }

    /** Re-split and re-embed documents, all of them or those under one node. */
    reindex(id?: string): number {
        const ids = id ? this.expand([id]) : (this.store.db.prepare("SELECT id FROM kb_nodes WHERE kind != 'folder' AND status != 'excluded'").all() as Row[]).map((r) => r.id as string);
        let n = 0;
        for (const nodeId of ids) {
            const node = this.get(nodeId);
            if (!node || node.kind === "folder" || node.status === "excluded") continue;
            this.index(nodeId, this.content(nodeId), true);
            n++;
        }
        this.changed();
        return n;
    }

    // ── embeddings ────────────────────────────────────────────────────────
    async embed(texts: string[], settings = this.settings().embeddings): Promise<Int8Array[]> {
        if (settings.kind === "none") throw new Error("Meaning search is off");
        if (settings.kind === "builtin") return texts.map((t) => quantize(builtinEmbed(t)));
        if (!settings.baseUrl) throw new Error("No embedding endpoint is set. Give its address under Knowledge → Search settings.");
        if (!settings.model) throw new Error(settings.kind === "azure" ? "Give the Azure deployment name of the embedding model" : "Give the embedding model's name");
        const base = settings.baseUrl.replace(/\/+$/, "");
        const key = settings.secretName ? this.options.vault.use(settings.secretName) : "";
        const url = settings.kind === "azure" ? `${base}/openai/deployments/${encodeURIComponent(settings.model)}/embeddings?api-version=${encodeURIComponent(settings.apiVersion)}` : `${base}/embeddings`;
        const headers: Record<string, string> = { "content-type": "application/json", ...(key ? (settings.kind === "azure" ? { "api-key": key } : { authorization: `Bearer ${key}` }) : {}) };
        const body = { input: texts.map((t) => t.slice(0, 8000)), ...(settings.kind === "openai" ? { model: settings.model } : {}), ...(settings.dimensions ? { dimensions: settings.dimensions } : {}) };
        let response: Response;
        try {
            response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
        } catch (e) {
            throw new Error(`Cannot reach the embedding endpoint at ${base}: ${e instanceof Error ? e.message : e}`);
        }
        if (!response.ok) {
            const detail = await response.text().then((t) => t.slice(0, 200), () => "");
            const hint = response.status === 401 || response.status === 403 ? " (the key was refused)" : response.status === 404 ? " (check the address and the model or deployment name)" : "";
            throw new Error(`The embedding endpoint answered ${response.status}${hint}${detail ? `: ${detail}` : ""}`);
        }
        const json = (await response.json()) as { data?: { index?: number; embedding: number[] }[] };
        const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (data.length !== texts.length) throw new Error(`The embedding endpoint returned ${data.length} vectors for ${texts.length} texts`);
        return data.map((d) => quantize(d.embedding));
    }

    /** Embed every passage that has no vector from the current model. Runs in the background. */
    private kick() {
        if (this.worker || this.stopped) return;
        this.worker = this.embedPending()
            .catch((e) => {
                this.embedState = { error: e instanceof Error ? e.message : String(e), at: now() };
                this.changed();
                clearTimeout(this.retryTimer);
                this.retryTimer = setTimeout(() => this.kick(), 60_000);
                this.retryTimer.unref?.();
            })
            .finally(() => {
                this.worker = null;
            });
    }

    private async embedPending() {
        const db = this.store.db;
        let since = Date.now();
        for (;;) {
            if (this.stopped) return;
            const settings = this.settings().embeddings;
            const key = this.embedderKey(settings);
            if (!key) return;
            const rows = db.prepare("SELECT c.id, c.node_id, c.heading, c.text, n.title FROM kb_chunks c JOIN kb_nodes n ON n.id = c.node_id WHERE c.embed_model IS NOT ? LIMIT ?").all(key, EMBED_BATCH) as Row[];
            if (!rows.length) {
                if (this.embedState.error) (this.embedState = { error: null, at: null }), this.changed();
                return;
            }
            const paths = new Map<string, string>();
            const inputs = rows.map((r) => {
                if (!paths.has(r.node_id)) paths.set(r.node_id, this.pathOf(r.node_id));
                return [paths.get(r.node_id), r.title, r.heading].filter(Boolean).join(" › ") + "\n\n" + r.text;
            });
            const vectors = await this.embed(inputs, settings);
            if (this.embedderKey() !== key) continue;
            const update = db.prepare("UPDATE kb_chunks SET embedding = ?, embed_model = ? WHERE id = ?");
            db.exec("BEGIN");
            try {
                rows.forEach((r, i) => update.run(new Uint8Array(vectors[i]!.buffer, vectors[i]!.byteOffset, vectors[i]!.byteLength), key, r.id));
                db.exec("COMMIT");
            } catch (e) {
                db.exec("ROLLBACK");
                throw e;
            }
            if (this.vectors && this.vectorsKey === key) rows.forEach((r, i) => this.vectors!.set(r.id, { nodeId: r.node_id, v: vectors[i]! }));
            if (Date.now() - since > 1500) (this.changed(), (since = Date.now()));
            // Built-in vectors are instant; give other work a turn between batches.
            await new Promise((r) => setImmediate(r));
        }
    }

    private loadVectors(key: string) {
        if (this.vectors && this.vectorsKey === key) return this.vectors;
        const map = new Map<number, { nodeId: string; v: Int8Array }>();
        for (const r of this.store.db.prepare("SELECT id, node_id, embedding FROM kb_chunks WHERE embed_model = ?").iterate(key) as Iterable<Row>) {
            const bytes = r.embedding as Uint8Array;
            map.set(r.id as number, { nodeId: r.node_id, v: new Int8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) });
        }
        this.vectors = map;
        this.vectorsKey = key;
        return map;
    }

    // ── search ────────────────────────────────────────────────────────────
    /**
     * Hybrid search: full-text (BM25) and vector similarity, merged by reciprocal rank, at most two
     * passages per document. `scope` limits it to those nodes and everything beneath them.
     */
    async search(query: string, options: { scope?: string[]; limit?: number } = {}): Promise<SearchResult> {
        const started = performance.now();
        const limit = Math.min(Math.max(options.limit ?? 6, 1), 30);
        const scope = options.scope ? this.expand(options.scope) : null;
        if (scope && !scope.length) return { hits: [], mode: "keyword", tookMs: 0, note: "Nothing is in scope." };
        const db = this.store.db;
        const scopeSet = scope ? new Set(scope) : null;
        const ranked = new Map<number, { nodeId: string; score: number; by: Set<"keyword" | "meaning">; similarity: number | null }>();
        const credit = (id: number, nodeId: string, rank: number, by: "keyword" | "meaning", sim: number | null = null) => {
            const entry = ranked.get(id) ?? { nodeId, score: 0, by: new Set(), similarity: null };
            entry.score += 1 / (RRF_K + rank);
            entry.by.add(by);
            if (sim !== null) entry.similarity = sim;
            ranked.set(id, entry);
        };

        const match = ftsQuery(query);
        if (match) {
            const scoped = scope ? "AND c.node_id IN (SELECT value FROM json_each(?))" : "";
            const rows = db.prepare(`SELECT c.id, c.node_id FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.rowid WHERE kb_fts MATCH ? ${scoped} ORDER BY bm25(kb_fts, 4.0, 2.0, 1.0) LIMIT ${CANDIDATES}`).all(...(scope ? [match, JSON.stringify(scope)] : [match])) as Row[];
            rows.forEach((r, rank) => credit(r.id, r.node_id, rank, "keyword"));
        }

        let note: string | null = null;
        let mode: SearchResult["mode"] = "keyword";
        const settings = this.settings().embeddings;
        const key = this.embedderKey(settings);
        if (!key) note = "Meaning search is off; keyword results only.";
        else {
            try {
                const vectors = this.loadVectors(key);
                if (!vectors.size) note = this.embedState.error ? `Meaning search is unavailable, so keyword results only: ${this.embedState.error}` : "No passages have been through the embedding model yet, so keyword results only.";
                else {
                    const cacheKey = `${key}\n${query}`;
                    let q = this.queryCache.get(cacheKey);
                    if (!q) {
                        q = (await this.embed([query], settings))[0]!;
                        this.queryCache.set(cacheKey, q);
                        if (this.queryCache.size > 500) this.queryCache.delete(this.queryCache.keys().next().value!);
                    }
                    const best: { id: number; nodeId: string; sim: number }[] = [];
                    for (const [id, { nodeId, v }] of vectors) {
                        if (scopeSet && !scopeSet.has(nodeId)) continue;
                        const sim = similarity(q, v);
                        if (best.length < CANDIDATES) best.push({ id, nodeId, sim });
                        else if (sim > best[best.length - 1]!.sim) best[best.length - 1] = { id, nodeId, sim };
                        else continue;
                        best.sort((a, b) => b.sim - a.sim);
                    }
                    // The built-in embedder scores word overlap; below this it is noise.
                    const floor = settings.kind === "builtin" ? 0.12 : 0;
                    best.filter((b) => b.sim > floor).forEach((b, rank) => credit(b.id, b.nodeId, rank, "meaning", b.sim));
                    mode = "hybrid";
                    const pending = (db.prepare("SELECT COUNT(*) n FROM kb_chunks WHERE embed_model IS NOT ?").get(key) as Row).n as number;
                    if (pending) note = `${pending} passages are still waiting for the embedding model; they are found by keyword only.`;
                }
            } catch (e) {
                note = `Meaning search failed, so keyword results only: ${e instanceof Error ? e.message : e}`;
            }
        }

        const perNode = new Map<string, number>();
        const chosen: { id: number; entry: NonNullable<ReturnType<typeof ranked.get>> }[] = [];
        for (const [id, entry] of [...ranked].sort((a, b) => b[1].score - a[1].score)) {
            const n = perNode.get(entry.nodeId) ?? 0;
            if (n >= 2) continue;
            perNode.set(entry.nodeId, n + 1);
            chosen.push({ id, entry });
            if (chosen.length >= limit) break;
        }
        const hits: SearchHit[] = chosen.map(({ id, entry }) => {
            const chunk = db.prepare("SELECT heading, text FROM kb_chunks WHERE id = ?").get(id) as Row;
            const node = this.get(entry.nodeId)!;
            return {
                nodeId: node.id,
                title: node.title,
                path: this.pathOf(node.id),
                heading: chunk.heading,
                text: chunk.text,
                url: node.url,
                updatedAt: node.sourceUpdatedAt ?? node.updatedAt,
                matchedBy: [...entry.by],
                score: Math.round(entry.score * 10000) / 10000,
                similarity: entry.similarity === null ? null : Math.round(entry.similarity * 1000) / 1000,
            };
        });
        return { hits, mode, tookMs: Math.round(performance.now() - started), note };
    }

    /** One part of a document's text, for reading beyond a passage. */
    read(id: string, part = 1): { node: KnowledgeNode; path: string; part: number; parts: number; text: string } {
        const node = this.get(id);
        if (!node || node.kind === "folder") throw new Error(`No document ${id}`);
        const text = this.content(id);
        const pieces: string[] = [];
        let rest = text;
        while (rest.length > PART_CHARS) {
            let at = rest.lastIndexOf("\n\n", PART_CHARS);
            if (at < PART_CHARS / 2) at = PART_CHARS;
            pieces.push(rest.slice(0, at));
            rest = rest.slice(at).replace(/^\n+/, "");
        }
        pieces.push(rest);
        const n = Math.min(Math.max(part, 1), pieces.length);
        return { node, path: this.pathOf(id), part: n, parts: pieces.length, text: pieces[n - 1]! };
    }

    stats() {
        const db = this.store.db;
        const key = this.embedderKey();
        const count = (sql: string, ...p: any[]) => ((db.prepare(sql).get(...p) as Row).n as number) ?? 0;
        return {
            folders: count("SELECT COUNT(*) n FROM kb_nodes WHERE kind = 'folder'"),
            documents: count("SELECT COUNT(*) n FROM kb_nodes WHERE kind != 'folder' AND status != 'excluded'"),
            failed: count("SELECT COUNT(*) n FROM kb_nodes WHERE status = 'failed'"),
            excluded: count("SELECT COUNT(*) n FROM kb_nodes WHERE status = 'excluded'"),
            passages: count("SELECT COUNT(*) n FROM kb_chunks"),
            chars: count("SELECT COALESCE(SUM(chars), 0) n FROM kb_nodes"),
            embedded: key ? count("SELECT COUNT(*) n FROM kb_chunks WHERE embed_model = ?", key) : 0,
            embedding: !!this.worker,
        };
    }

    findExternal(externalId: string) {
        return this.findByExternal(externalId);
    }

    private changed() {
        this.bus.emit("change", "knowledge");
    }
}
