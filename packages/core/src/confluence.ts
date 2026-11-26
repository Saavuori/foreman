import { z } from "zod";
import { htmlToText } from "./extract.ts";
import type { KnowledgeHub, KnowledgeNode, NodeSource } from "./knowledge.ts";
import type { Bus } from "./registry.ts";
import type { Store } from "./store.ts";
import type { Vault } from "./vault.ts";

export const ConfluenceAuth = z.object({
    /** `bearer` is a personal access token (Data Center); `basic` is email + API token (Cloud). */
    type: z.enum(["none", "basic", "bearer"]).default("none"),
    email: z.string().default(""),
    /** Name of the vault secret holding the token. */
    secretName: z.string().default(""),
});
export const ConfluenceSettings = z.object({
    /** Empty means the built-in mock Confluence. */
    baseUrl: z.string().default(""),
    flavor: z.enum(["datacenter", "cloud"]).default("datacenter"),
    auth: ConfluenceAuth.prefault({}),
    /** How often imported pages are checked for changes. 0 turns the schedule off. */
    syncMinutes: z.number().int().min(0).max(10_080).default(60),
});
export type ConfluenceSettings = z.infer<typeof ConfluenceSettings>;

/** What an imported tree remembers about where it came from. Stored as the root node's source. */
export interface ConfluenceRoot extends NodeSource {
    kind: "confluence";
    scope: "page" | "tree" | "space";
    pageId?: string;
    spaceKey: string;
    spaceName?: string;
    version?: number;
    lastSyncAt?: string;
    lastSyncError?: string | null;
    pages?: number;
}

export interface ConfluencePage {
    id: string;
    title: string;
    version: number;
    /** Parent page id; null for a page at the top of its space. */
    parentId: string | null;
    spaceKey: string;
    updatedAt: string | null;
    url: string | null;
}

const pageFrom = (c: any, base: string): ConfluencePage => ({
    id: String(c.id),
    title: c.title ?? "(untitled)",
    version: c.version?.number ?? 0,
    parentId: c.ancestors?.length ? String(c.ancestors[c.ancestors.length - 1].id) : null,
    spaceKey: c.space?.key ?? "",
    updatedAt: c.version?.when ?? null,
    url: c._links?.webui ? `${c._links?.base ?? base}${c._links.webui}` : null,
});

/** The subset of Confluence's REST API (v1, the same on Data Center and Cloud) that the knowledge base needs. */
export class ConfluenceClient {
    private api: string;
    constructor(
        readonly baseUrl: string,
        private options: { headers?: Record<string, string>; flavor?: "datacenter" | "cloud" } = {},
    ) {
        const base = baseUrl.replace(/\/+$/, "");
        this.api = options.flavor === "cloud" && !/\/wiki$/.test(base) ? `${base}/wiki/rest/api` : `${base}/rest/api`;
    }
    private get site() {
        return this.api.replace(/\/rest\/api$/, "");
    }

    private async request(path: string): Promise<any> {
        let response: Response;
        try {
            response = await fetch(this.api + path, { headers: { accept: "application/json", ...this.options.headers }, signal: AbortSignal.timeout(30_000) });
        } catch (e) {
            throw new Error(`Cannot reach Confluence at ${this.baseUrl}: ${e instanceof Error ? e.message : e}`);
        }
        if (!response.ok) {
            const detail = await response.json().then((b: any) => b?.message ?? "", () => "");
            const hint = response.status === 401 ? " (sign-in was refused: check the token)" : response.status === 403 ? " (the account may not read this)" : response.status === 404 ? " (no such page or space, or the account cannot see it)" : "";
            throw new Error(`Confluence answered ${response.status} for ${path.split("?")[0]}${hint}${detail ? `: ${detail}` : ""}`);
        }
        return response.json();
    }
    /** Every result of a paged list. */
    private async all(path: string, max = 20_000): Promise<any[]> {
        const out: any[] = [];
        const size = 100;
        for (let start = 0; out.length < max; start += size) {
            const page = await this.request(`${path}${path.includes("?") ? "&" : "?"}limit=${size}&start=${start}`);
            const results: any[] = page.results ?? [];
            out.push(...results);
            if (results.length < size && !page._links?.next) break;
            if (!results.length) break;
        }
        return out;
    }

    async myself(): Promise<{ name: string }> {
        const me = await this.request("/user/current");
        return { name: me.displayName ?? me.username ?? me.publicName ?? "unknown" };
    }
    async spaces(): Promise<{ key: string; name: string }[]> {
        return (await this.all("/space?type=global", 2000)).map((s) => ({ key: s.key, name: s.name }));
    }
    async space(key: string): Promise<{ key: string; name: string }> {
        const s = await this.request(`/space/${encodeURIComponent(key)}`);
        return { key: s.key, name: s.name };
    }
    async rootPages(spaceKey: string): Promise<{ id: string; title: string }[]> {
        return (await this.all(`/space/${encodeURIComponent(spaceKey)}/content/page?depth=root`, 2000)).map((c) => ({ id: String(c.id), title: c.title }));
    }
    async children(pageId: string): Promise<{ id: string; title: string }[]> {
        return (await this.all(`/content/${encodeURIComponent(pageId)}/child/page`, 2000)).map((c) => ({ id: String(c.id), title: c.title }));
    }
    async page(pageId: string): Promise<ConfluencePage & { body: string }> {
        const c = await this.request(`/content/${encodeURIComponent(pageId)}?expand=body.storage,version,space,ancestors`);
        return { ...pageFrom(c, this.site), body: c.body?.storage?.value ?? "" };
    }
    async pageByTitle(spaceKey: string, title: string): Promise<{ id: string } | null> {
        const r = await this.request(`/content?type=page&spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}`);
        return r.results?.[0] ? { id: String(r.results[0].id) } : null;
    }
    /** All pages beneath one page, with versions and parents but without bodies. */
    async descendants(pageId: string): Promise<ConfluencePage[]> {
        return (await this.all(`/content/${encodeURIComponent(pageId)}/descendant/page?expand=version,ancestors,space`)).map((c) => pageFrom(c, this.site));
    }
    async spacePages(spaceKey: string): Promise<ConfluencePage[]> {
        return (await this.all(`/content?type=page&spaceKey=${encodeURIComponent(spaceKey)}&expand=version,ancestors,space`)).map((c) => pageFrom(c, this.site));
    }
    async searchTitles(text: string, spaceKey?: string): Promise<{ id: string; title: string; spaceKey: string }[]> {
        const cql = `type = page AND title ~ "${text.replace(/["\\]/g, " ")}"${spaceKey ? ` AND space = "${spaceKey.replace(/"/g, "")}"` : ""}`;
        const r = await this.request(`/content/search?limit=25&expand=space&cql=${encodeURIComponent(cql)}`);
        return (r.results ?? []).map((c: any) => ({ id: String(c.id), title: c.title, spaceKey: c.space?.key ?? "" }));
    }
}

/** A page id from what a person pastes: an id, or any of the usual Confluence page addresses. */
export function parsePageRef(ref: string): { pageId: string } | { spaceKey: string; title: string } | null {
    const s = ref.trim();
    if (/^\d+$/.test(s)) return { pageId: s };
    const id = /[?&]pageId=(\d+)/.exec(s)?.[1] ?? /\/pages\/(\d+)/.exec(s)?.[1];
    if (id) return { pageId: id };
    const display = /\/display\/([^/?#]+)\/([^?#]+)/.exec(s);
    if (display) return { spaceKey: decodeURIComponent(display[1]!), title: decodeURIComponent(display[2]!.replace(/\+/g, " ")) };
    return null;
}

/**
 * Brings Confluence pages into the knowledge library and keeps them current. An import is a root
 * node (a page, or a folder for a whole space) whose source remembers what to fetch; a sync
 * fetches the list of pages with their versions, re-reads only changed pages, adds new ones,
 * removes deleted ones, and leaves excluded branches alone.
 */
export class ConfluenceSync {
    private timer?: ReturnType<typeof setInterval>;
    private running = new Map<string, Promise<SyncReport>>();
    progress = new Map<string, { done: number; total: number; startedAt: string }>();

    constructor(
        private store: Store,
        private bus: Bus,
        private kb: KnowledgeHub,
        private options: { vault: Vault; mockUrl: string },
    ) {}

    settings(): ConfluenceSettings {
        return ConfluenceSettings.parse(this.store.getSetting("confluence") ?? {});
    }
    configure(patch: Partial<ConfluenceSettings>): ConfluenceSettings {
        const current = this.settings();
        const next = ConfluenceSettings.parse({ ...current, ...patch, auth: { ...current.auth, ...patch.auth } });
        this.store.setSetting("confluence", next);
        this.schedule();
        this.bus.emit("change", "knowledge");
        return next;
    }
    isMock() {
        return !this.settings().baseUrl;
    }
    client(): ConfluenceClient {
        const { baseUrl, flavor, auth } = this.settings();
        const headers: Record<string, string> = {};
        if (baseUrl && auth.type !== "none") {
            if (!auth.secretName) throw new Error("Confluence sign-in is switched on but no token is stored. Add the token under Knowledge → Confluence.");
            const token = this.options.vault.use(auth.secretName);
            headers.authorization = auth.type === "basic" ? `Basic ${Buffer.from(`${auth.email}:${token}`).toString("base64")}` : `Bearer ${token}`;
        }
        return new ConfluenceClient(baseUrl || this.options.mockUrl, { headers, flavor: baseUrl ? flavor : "datacenter" });
    }
    async test(): Promise<{ ok: boolean; detail: string }> {
        try {
            const me = await this.client().myself();
            return { ok: true, detail: `Connected as ${me.name}${this.isMock() ? " (built-in mock Confluence)" : ""}` };
        } catch (e) {
            return { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
    }

    start() {
        this.schedule();
    }
    stop() {
        clearInterval(this.timer);
    }
    async settled() {
        await Promise.allSettled([...this.running.values()]);
    }
    private schedule() {
        clearInterval(this.timer);
        const minutes = this.settings().syncMinutes;
        if (!minutes) return;
        this.timer = setInterval(() => void this.syncAll(), minutes * 60_000);
        this.timer.unref?.();
    }

    roots(): KnowledgeNode[] {
        return this.kb.list().filter((n) => n.source?.kind === "confluence" && (n.source as ConfluenceRoot).scope !== undefined);
    }
    /** The import a node belongs to, or undefined when it does not come from Confluence. */
    rootOf(nodeId: string): KnowledgeNode | undefined {
        return [this.kb.get(nodeId), ...this.kb.ancestors(nodeId).reverse()].find((n) => n?.source?.kind === "confluence" && (n.source as ConfluenceRoot).scope !== undefined);
    }

    /** Add a page, a page with everything beneath it, or a whole space, then sync it in the background. */
    async import(input: { page?: string; spaceKey?: string; scope: "page" | "tree" | "space"; parentId?: string | null }): Promise<KnowledgeNode> {
        const client = this.client();
        if (input.scope === "space") {
            if (!input.spaceKey) throw new Error("Give the space key to import a whole space");
            const space = await client.space(input.spaceKey);
            if (this.roots().some((r) => (r.source as ConfluenceRoot).scope === "space" && (r.source as ConfluenceRoot).spaceKey === space.key)) throw new Error(`The space ${space.key} is already in the library`);
            const folder = this.kb.createFolder(space.name, input.parentId);
            this.kb.updateDocument(folder.id, { source: { kind: "confluence", scope: "space", spaceKey: space.key, spaceName: space.name } satisfies ConfluenceRoot });
            void this.sync(folder.id);
            return this.kb.get(folder.id)!;
        }
        if (!input.page) throw new Error("Give the page: its id or its address");
        const ref = parsePageRef(input.page);
        if (!ref) throw new Error("That does not look like a Confluence page id or page address");
        const pageId = "pageId" in ref ? ref.pageId : (await client.pageByTitle(ref.spaceKey, ref.title))?.id;
        if (!pageId) throw new Error(`No page called “${"title" in ref ? ref.title : ""}” in that space`);
        if (this.roots().some((r) => (r.source as ConfluenceRoot).pageId === pageId)) throw new Error("That page is already imported; sync it instead");
        const page = await client.page(pageId);
        const source: ConfluenceRoot = { kind: "confluence", scope: input.scope, pageId: page.id, spaceKey: page.spaceKey, version: page.version };
        const node = this.kb.addDocument({ parentId: input.parentId, kind: "page", title: page.title, text: htmlToText(page.body), source, url: page.url, externalId: `confluence:${page.id}`, sourceUpdatedAt: page.updatedAt });
        if (input.scope === "tree") void this.sync(node.id);
        else this.finish(node.id, { pages: 1, lastSyncAt: new Date().toISOString(), lastSyncError: null });
        return this.kb.get(node.id)!;
    }

    async syncAll(): Promise<SyncReport[]> {
        const reports: SyncReport[] = [];
        for (const root of this.roots()) reports.push(await this.sync(root.id));
        return reports;
    }

    /** Bring one import up to date. A second call while one runs waits for the first. */
    sync(rootId: string): Promise<SyncReport> {
        const running = this.running.get(rootId);
        if (running) return running;
        const job = this.doSync(rootId).finally(() => {
            this.running.delete(rootId);
            this.progress.delete(rootId);
            this.bus.emit("change", "knowledge");
        });
        this.running.set(rootId, job);
        return job;
    }

    private finish(rootId: string, patch: Partial<ConfluenceRoot>) {
        const root = this.kb.get(rootId);
        if (!root) return;
        this.kb.updateDocument(rootId, { source: { ...(root.source as ConfluenceRoot), ...patch } });
    }

    private async doSync(rootId: string): Promise<SyncReport> {
        const report: SyncReport = { rootId, added: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, error: null };
        const root = this.kb.get(rootId);
        const source = root?.source as ConfluenceRoot | undefined;
        if (!root || source?.kind !== "confluence") throw new Error(`Knowledge item ${rootId} is not a Confluence import`);
        try {
            const client = this.client();
            this.progress.set(rootId, { done: 0, total: 0, startedAt: new Date().toISOString() });
            this.bus.emit("change", "knowledge");
            let listing: ConfluencePage[];
            if (source.scope === "space") listing = await client.spacePages(source.spaceKey);
            else {
                const top = await client.page(source.pageId!);
                listing = [{ ...top, parentId: null }, ...(source.scope === "tree" ? await client.descendants(source.pageId!) : [])];
            }
            const byId = new Map(listing.map((p) => [p.id, p]));
            const topId = source.scope === "space" ? null : source.pageId!;

            // What is already here, by Confluence page id.
            const existing = new Map<string, KnowledgeNode>();
            for (const id of this.kb.expandAll(rootId)) {
                const ext = this.kb.externalId(id);
                if (ext?.startsWith("confluence:")) existing.set(ext.slice("confluence:".length), this.kb.get(id)!);
            }
            const excluded = new Set([...existing].filter(([, n]) => n.status === "excluded").map(([id]) => id));
            const isExcluded = (id: string): boolean => {
                for (let at: string | null = id, hops = 0; at && hops < 200; at = byId.get(at)?.parentId ?? null, hops++) if (excluded.has(at)) return true;
                return false;
            };
            const depth = (p: ConfluencePage) => {
                let d = 0;
                for (let at = p.parentId; at && byId.has(at) && d < 200; at = byId.get(at)!.parentId) d++;
                return d;
            };
            const wanted = listing.filter((p) => !isExcluded(p.id)).sort((a, b) => depth(a) - depth(b));
            this.progress.set(rootId, { done: 0, total: wanted.length, startedAt: this.progress.get(rootId)!.startedAt });

            const nodeFor = new Map<string, string>();
            if (topId) nodeFor.set(topId, rootId);
            const parentNode = (p: ConfluencePage) => (p.parentId && nodeFor.has(p.parentId) ? nodeFor.get(p.parentId)! : rootId);
            for (const p of wanted) if (existing.has(p.id)) nodeFor.set(p.id, p.id === topId ? rootId : existing.get(p.id)!.id);

            // Bodies only for new and changed pages, a few at a time.
            const work = wanted.filter((p) => {
                const node = p.id === topId ? root : existing.get(p.id);
                const changed = !node || node.status === "failed" || (node.source as ConfluenceRoot | null)?.version !== p.version;
                if (!changed) report.unchanged++;
                return changed;
            });
            let done = wanted.length - work.length;
            const byDepth = new Map<number, ConfluencePage[]>();
            for (const p of work) byDepth.set(depth(p), [...(byDepth.get(depth(p)) ?? []), p]);
            for (const level of [...byDepth.keys()].sort((a, b) => a - b)) {
                const queue = [...byDepth.get(level)!];
                await Promise.all(
                    Array.from({ length: 4 }, async () => {
                        for (let p = queue.shift(); p; p = queue.shift()) {
                            await this.syncPage(client, p, { rootId, topId, existing, nodeFor, parent: parentNode(p), report });
                            this.progress.set(rootId, { ...this.progress.get(rootId)!, done: ++done });
                        }
                    }),
                );
            }
            // Pages that moved to another parent within the import.
            for (const p of wanted) {
                const node = existing.get(p.id);
                if (node && p.id !== topId && node.parentId !== parentNode(p)) this.kb.updateDocument(node.id, { parentId: parentNode(p) });
            }
            // Pages that are gone from Confluence, or moved out of this import.
            for (const [pageId, node] of existing) {
                if (pageId === topId || byId.has(pageId) || !this.kb.get(node.id)) continue;
                report.removed += this.kb.remove(node.id);
            }
            this.finish(rootId, { lastSyncAt: new Date().toISOString(), lastSyncError: report.failed ? `${report.failed} pages could not be read` : null, pages: wanted.length, ...(topId ? { version: byId.get(topId)?.version } : {}) });
        } catch (e) {
            report.error = e instanceof Error ? e.message : String(e);
            this.finish(rootId, { lastSyncAt: new Date().toISOString(), lastSyncError: report.error });
        }
        return report;
    }

    private async syncPage(client: ConfluenceClient, p: ConfluencePage, x: { rootId: string; topId: string | null; existing: Map<string, KnowledgeNode>; nodeFor: Map<string, string>; parent: string; report: SyncReport }) {
        const nodeId = p.id === x.topId ? x.rootId : x.existing.get(p.id)?.id;
        try {
            const page = await client.page(p.id);
            const text = htmlToText(page.body);
            if (nodeId) {
                const node = this.kb.get(nodeId)!;
                this.kb.updateDocument(nodeId, { title: page.title, text, url: page.url, sourceUpdatedAt: page.updatedAt, source: { ...(node.source as ConfluenceRoot), kind: "confluence", spaceKey: page.spaceKey, pageId: page.id, version: page.version } as NodeSource });
                x.report.updated++;
            } else {
                const node = this.kb.addDocument({ parentId: x.parent, kind: "page", title: page.title, text, url: page.url, externalId: `confluence:${page.id}`, sourceUpdatedAt: page.updatedAt, source: { kind: "confluence", spaceKey: page.spaceKey, pageId: page.id, version: page.version } });
                x.nodeFor.set(p.id, node.id);
                x.report.added++;
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (nodeId) this.kb.markFailed(nodeId, message);
            else {
                const node = this.kb.addDocument({ parentId: x.parent, kind: "page", title: p.title, text: "", url: p.url, externalId: `confluence:${p.id}`, source: { kind: "confluence", spaceKey: p.spaceKey, pageId: p.id, version: -1 } });
                x.nodeFor.set(p.id, node.id);
                this.kb.markFailed(node.id, message);
            }
            x.report.failed++;
        }
    }
}

export interface SyncReport {
    rootId: string;
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    failed: number;
    error: string | null;
}

// ── Mock Confluence ─────────────────────────────────────────────────────────

interface MockPage {
    id: string;
    spaceKey: string;
    parentId: string | null;
    title: string;
    body: string;
    version: number;
    when: string;
}

const p = (...paragraphs: string[]) => paragraphs.map((t) => (t.startsWith("<") ? t : `<p>${t}</p>`)).join("");
const SEED: Omit<MockPage, "version" | "when">[] = [
    { id: "1001", spaceKey: "ENG", parentId: null, title: "Engineering handbook", body: p("How the engineering teams work. Start with the runbooks when something is on fire, and with the standards when writing code.", `<ac:structured-macro ac:name="children"/>`) },
    { id: "1002", spaceKey: "ENG", parentId: "1001", title: "Runbooks", body: p("Step-by-step instructions for operating our services. Every alert links to one of these pages.") },
    { id: "1003", spaceKey: "ENG", parentId: "1002", title: "Deploying a service", body: p("<h2>Before you deploy</h2>", "Check that the release pipeline is green and that nobody else is deploying the same service. Deployments are frozen on Fridays after 14:00.", "<h2>Steps</h2>", "<ol><li>Merge to main.</li><li>Approve the production stage in the release pipeline.</li><li>Watch the error rate dashboard for 15 minutes.</li></ol>", "<h2>Rolling back</h2>", "Use the Rollback button in the pipeline. Rolling back is always safe for stateless services; for the billing service talk to the payments on-call first.", `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[deployctl rollback billing --to previous]]></ac:plain-text-body></ac:structured-macro>`) },
    { id: "1004", spaceKey: "ENG", parentId: "1002", title: "Incident response", body: p("<h2>Severity levels</h2>", `<table><tbody><tr><th><p>Level</p></th><th><p>Meaning</p></th><th><p>Response</p></th></tr><tr><td><p>SEV1</p></td><td><p>Customers cannot pay or log in</p></td><td><p>Page on-call immediately, open a bridge</p></td></tr><tr><td><p>SEV2</p></td><td><p>A feature is broken for many customers</p></td><td><p>Page on-call during working hours</p></td></tr><tr><td><p>SEV3</p></td><td><p>Minor bug, workaround exists</p></td><td><p>Ticket in the team backlog</p></td></tr></tbody></table>`, "<h2>During an incident</h2>", "One incident commander decides; everyone else reports to them. Write a timeline in the incident ticket as you go.") },
    { id: "1005", spaceKey: "ENG", parentId: "1001", title: "Coding standards", body: p("<h2>Reviews</h2>", "Every change needs one approving review. Changes to payments code need a reviewer from the payments team.", "<h2>Tests</h2>", "New behaviour comes with a test. Flaky tests are quarantined within a day and fixed within a week.") },
    { id: "1006", spaceKey: "ENG", parentId: "1005", title: "Error handling", body: p("Errors shown to customers say what to do next. Log the technical detail with the request id; never log card numbers or personal data.", "Retry only idempotent calls, with exponential backoff and at most three attempts.") },
    { id: "2001", spaceKey: "PAY", parentId: null, title: "Payments", body: p("Everything about how money moves: refunds, invoices, the ledger.") },
    { id: "2002", spaceKey: "PAY", parentId: "2001", title: "Refund policy", body: p("<h2>Who can refund</h2>", "Support agents can refund up to 200 EUR without approval. Larger refunds need a team lead.", "<h2>Rounding</h2>", "Refunds are rounded half-even (banker's rounding) so that they match the ledger. Never round half-up: it makes credit notes differ from the original invoice by one cent.", "<h2>Timing</h2>", `Refunds reach the customer within 5 banking days. See <ac:link><ri:page ri:content-title="Ledger rules"/></ac:link> for how they are booked.`) },
    { id: "2003", spaceKey: "PAY", parentId: "2001", title: "Ledger rules", body: p("Every money movement is two entries that sum to zero. Corrections are new entries, never edits.", "<h2>Currencies</h2>", "Amounts are stored in minor units (cents) as integers. Conversion uses the daily ECB rate fixed at 16:00 CET.") },
    { id: "2004", spaceKey: "PAY", parentId: "2002", title: "Refund FAQ", body: p("<h2>Can a refund be cancelled?</h2>", "Only before the nightly payout run at 22:00. After that, create a new charge instead.", "<h2>Partial refunds</h2>", "Allowed; the remaining amount stays refundable for 180 days.") },
];

/** A stand-in for Confluence Data Center: two spaces of sample pages, editable for demos and tests. */
export class MockConfluence {
    pages = new Map<string, MockPage>();
    spaces = new Map([
        ["ENG", "Engineering"],
        ["PAY", "Payments"],
    ]);
    requiredAuth: string | null = null;
    private nextId = 3000;

    constructor() {
        const when = new Date(Date.now() - 20 * 86_400_000).toISOString();
        for (const page of SEED) this.pages.set(page.id, { ...page, version: 1, when });
    }

    private ancestors(page: MockPage): MockPage[] {
        const out: MockPage[] = [];
        for (let at = page.parentId; at && this.pages.has(at); at = this.pages.get(at)!.parentId) out.unshift(this.pages.get(at)!);
        return out;
    }
    /** A page in Confluence's REST shape. */
    content(page: MockPage, base: string, expand = "") {
        return {
            id: page.id,
            type: "page",
            status: "current",
            title: page.title,
            space: { key: page.spaceKey, name: this.spaces.get(page.spaceKey) },
            version: { number: page.version, when: page.when },
            ...(expand.includes("ancestors") ? { ancestors: this.ancestors(page).map((a) => ({ id: a.id, title: a.title })) } : {}),
            ...(expand.includes("body.storage") ? { body: { storage: { value: page.body, representation: "storage" } } } : {}),
            _links: { webui: `/pages/viewpage.action?pageId=${page.id}`, base },
        };
    }
    children(parentId: string | null, spaceKey?: string) {
        return [...this.pages.values()].filter((pg) => pg.parentId === parentId && (!spaceKey || pg.spaceKey === spaceKey));
    }
    descendants(pageId: string): MockPage[] {
        const out: MockPage[] = [];
        const walk = (id: string) => this.children(id).forEach((c) => (out.push(c), walk(c.id)));
        walk(pageId);
        return out;
    }
    search(cql: string): MockPage[] {
        const title = /title\s*~\s*"([^"]*)"/i.exec(cql)?.[1]?.toLowerCase().trim() ?? "";
        const space = /space\s*=\s*"?([A-Z0-9]+)"?/i.exec(cql)?.[1];
        return [...this.pages.values()].filter((pg) => (!space || pg.spaceKey === space) && title.split(/\s+/).every((w) => pg.title.toLowerCase().includes(w)));
    }

    /** Change a page as an editor would: the version goes up, so the next sync re-reads it. */
    edit(pageId: string, change: { title?: string; appendText?: string; body?: string }) {
        const page = this.pages.get(pageId);
        if (!page) return null;
        if (change.title) page.title = change.title;
        if (change.body !== undefined) page.body = change.body;
        if (change.appendText) page.body += `<p>${change.appendText.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`;
        page.version++;
        page.when = new Date().toISOString();
        return page;
    }
    add(parentId: string, title: string, text: string) {
        const parent = this.pages.get(parentId);
        if (!parent) return null;
        const page: MockPage = { id: String(this.nextId++), spaceKey: parent.spaceKey, parentId, title, body: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`, version: 1, when: new Date().toISOString() };
        this.pages.set(page.id, page);
        return page;
    }
    delete(pageId: string) {
        if (!this.pages.has(pageId)) return false;
        for (const d of this.descendants(pageId)) this.pages.delete(d.id);
        this.pages.delete(pageId);
        return true;
    }
}
