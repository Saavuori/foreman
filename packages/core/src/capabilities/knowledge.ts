import { z } from "zod";
import { fileToText, htmlToText } from "../extract.ts";
import { EmbeddingSettings, type KnowledgeNode } from "../knowledge.ts";
import { ConfluenceAuth, ConfluenceSettings, type ConfluenceRoot } from "../confluence.ts";
import { actorLabel, CapabilityError, defineCapability, type Ctx } from "../registry.ts";
import { requireAgent } from "./agents.ts";

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** Hub errors are plain Errors; "not found" becomes 404, anything else a 409 the person can act on. */
function guard<T>(fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        if (e instanceof CapabilityError) throw e;
        const message = e instanceof Error ? e.message : String(e);
        throw new CapabilityError(message, /not found|^No document/i.test(message) ? "not_found" : "conflict");
    }
}

function requireNode(ctx: Ctx, nodeId: string): KnowledgeNode {
    const node = ctx.knowledge.get(nodeId);
    if (!node) throw new CapabilityError(`Knowledge item ${nodeId} not found`, "not_found");
    return node;
}

/** Which active agents have each node assigned directly. */
function assignments(ctx: Ctx): Map<string, { agentId: string; agentName: string }[]> {
    const out = new Map<string, { agentId: string; agentName: string }[]>();
    for (const agent of ctx.store.listAgents()) {
        for (const nodeId of ctx.store.getRevision(agent.activeRevisionId)?.spec.knowledge ?? []) {
            out.set(nodeId, [...(out.get(nodeId) ?? []), { agentId: agent.id, agentName: agent.name }]);
        }
    }
    return out;
}

/** Agents that can search a node: assigned it, or something above it. */
function agentsReaching(ctx: Ctx, nodeId: string) {
    const lineage = new Set([nodeId, ...ctx.knowledge.ancestors(nodeId).map((n) => n.id)]);
    const seen = new Map<string, { agentId: string; agentName: string; via: string }>();
    for (const [assigned, agents] of assignments(ctx)) {
        if (!lineage.has(assigned)) continue;
        for (const a of agents) if (!seen.has(a.agentId)) seen.set(a.agentId, { ...a, via: assigned });
    }
    return [...seen.values()];
}

const present = (node: KnowledgeNode, ctx?: Ctx) => {
    const { source, ...rest } = node;
    const c = source?.kind === "confluence" ? (source as ConfluenceRoot) : null;
    return {
        ...rest,
        sourceKind: source?.kind ?? null,
        fileName: source?.fileName ?? null,
        confluence: c ? { pageId: c.pageId ?? null, spaceKey: c.spaceKey, version: c.version ?? null } : null,
        /** Set on the node an import starts from: what it covers and how its last sync went. */
        import: c?.scope ? { scope: c.scope, lastSyncAt: c.lastSyncAt ?? null, lastSyncError: c.lastSyncError ?? null, pages: c.pages ?? null, syncing: ctx?.confluence.progress.get(node.id) ?? null } : null,
    };
};

const settingsView = (ctx: Ctx) => {
    const settings = ctx.knowledge.settings();
    return { ...settings, embedderLabel: ctx.knowledge.embedderLabel(settings.embeddings) };
};

const ParentId = z.string().nullable().optional().describe("Folder to put it in; omit for the top level");

export const knowledgeCapabilities = [
    defineCapability({
        name: "knowledge.tree",
        title: "Knowledge library",
        description:
            "The whole knowledge library as a flat list of folders, pages and files (parentId links them into a tree), with each item's indexing status, size, and the agents it is assigned to directly. Use it to find node ids for knowledge.search, knowledge.assign and the rest.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => {
            const assigned = assignments(ctx);
            return { nodes: ctx.knowledge.list().map((n) => ({ ...present(n, ctx), assignedTo: assigned.get(n.id) ?? [] })), stats: ctx.knowledge.stats() };
        },
    }),
    defineCapability({
        name: "knowledge.get",
        title: "Knowledge item",
        description: "One folder or document: where it sits, which agents can search it, and for a document the start of its text and the passages it was split into.",
        readOnly: true,
        input: z.object({ nodeId: z.string() }),
        handler: (ctx, { nodeId }) => {
            const node = requireNode(ctx, nodeId);
            const content = node.kind === "folder" ? "" : ctx.knowledge.content(nodeId);
            const below = node.kind === "folder" || node.kind === "page" ? ctx.knowledge.expand([nodeId]).length - 1 : 0;
            return {
                node: present(node, ctx),
                importRoot: ctx.confluence.rootOf(nodeId)?.id ?? null,
                path: ctx.knowledge.ancestors(nodeId).map((n) => ({ id: n.id, title: n.title })),
                agents: agentsReaching(ctx, nodeId),
                itemsBelow: below,
                preview: content.slice(0, 8000),
                previewTruncated: content.length > 8000,
                passages: ctx.knowledge.passages(nodeId).slice(0, 300).map((p) => ({ heading: p.heading, chars: p.text.length, start: p.text.slice(0, 220) })),
            };
        },
    }),
    defineCapability({
        name: "knowledge.create_folder",
        title: "New knowledge folder",
        description: "Make a folder in the knowledge library. Folders are how knowledge is arranged and assigned: give an agent a folder and it can search everything in it, including what is added later.",
        input: z.object({ title: z.string().min(1).max(200), parentId: ParentId }),
        handler: (ctx, input) => present(guard(() => ctx.knowledge.createFolder(input.title, input.parentId))),
    }),
    defineCapability({
        name: "knowledge.add_text",
        title: "Add a text document",
        description: "Add a document from text you give: Markdown (headings with #), plain text or HTML. It is split into passages and searchable at once. Use it for notes, how-tos and answers worth keeping.",
        input: z.object({ title: z.string().min(1).max(300), text: z.string().min(1).max(2_000_000), format: z.enum(["markdown", "text", "html"]).default("markdown"), parentId: ParentId }),
        handler: (ctx, input) => {
            const text = input.format === "html" ? htmlToText(input.text) : input.text.replace(/\r\n?/g, "\n");
            return present(guard(() => ctx.knowledge.addDocument({ parentId: input.parentId, title: input.title, text, source: { kind: "text", mediaType: input.format === "html" ? "text/html" : input.format === "text" ? "text/plain" : "text/markdown" } })));
        },
    }),
    defineCapability({
        name: "knowledge.replace_text",
        title: "Replace a document's text",
        description: "Replace the text (and optionally the title) of a document that was added as text or uploaded. Documents that come from Confluence change only through their source.",
        input: z.object({ documentId: z.string(), text: z.string().min(1).max(2_000_000), title: z.string().min(1).max(300).optional(), format: z.enum(["markdown", "text", "html"]).default("markdown") }),
        handler: (ctx, input) => {
            const node = requireNode(ctx, input.documentId);
            if (node.kind === "folder") throw new CapabilityError("That is a folder, not a document", "invalid_input");
            if (node.source?.kind === "confluence") throw new CapabilityError("This page comes from Confluence; change it there and sync", "conflict");
            const text = input.format === "html" ? htmlToText(input.text) : input.text.replace(/\r\n?/g, "\n");
            guard(() => ctx.knowledge.updateDocument(node.id, { text, title: input.title }));
            return present(ctx.knowledge.get(node.id)!);
        },
    }),
    defineCapability({
        name: "knowledge.upload",
        title: "Upload a file",
        description: `Add a file to the knowledge library: Markdown, plain text (also CSV, JSON, YAML, logs, code) or HTML, up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, sent as base64. PDF, Word and pictures are not read yet.`,
        input: z.object({ fileName: z.string().min(1).max(255), contentBase64: z.string().min(1), title: z.string().min(1).max(300).optional(), parentId: ParentId }),
        handler: (ctx, input) => {
            const bytes = Buffer.from(input.contentBase64, "base64");
            if (bytes.length > MAX_UPLOAD_BYTES) throw new CapabilityError(`${input.fileName} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, "invalid_input");
            const read = fileToText(input.fileName, bytes);
            if (!read) throw new CapabilityError(`Foreman cannot read ${input.fileName} yet. It reads Markdown, text and HTML files; PDF, Word and pictures come later.`, "invalid_input");
            if (!read.text.trim()) throw new CapabilityError(`${input.fileName} has no text in it`, "invalid_input");
            const title = input.title ?? input.fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
            return present(guard(() => ctx.knowledge.addDocument({ parentId: input.parentId, title, text: read.text, source: { kind: "upload", fileName: input.fileName, mediaType: read.mediaType, bytes: bytes.length } })));
        },
    }),
    defineCapability({
        name: "knowledge.rename",
        title: "Rename a knowledge item",
        description: "Change the title of a folder or document. A document's title is searched too, so a clear title helps it be found.",
        input: z.object({ nodeId: z.string(), title: z.string().min(1).max(300) }),
        handler: (ctx, input) => {
            requireNode(ctx, input.nodeId);
            return present(guard(() => ctx.knowledge.rename(input.nodeId, input.title)));
        },
    }),
    defineCapability({
        name: "knowledge.move",
        title: "Move a knowledge item",
        description: "Move a folder or document into another folder, or to the top level with parentId null. Agents assigned the old folder lose it; agents assigned the new one gain it.",
        input: z.object({ nodeId: z.string(), parentId: z.string().nullable() }),
        handler: (ctx, input) => {
            requireNode(ctx, input.nodeId);
            return present(guard(() => ctx.knowledge.move(input.nodeId, input.parentId)));
        },
    }),
    defineCapability({
        name: "knowledge.remove",
        title: "Remove from the knowledge library",
        description:
            "Take a folder or document, and everything beneath it, out of the library and the search index. A page inside a Confluence import is excluded instead of deleted, so the next sync does not bring it back; knowledge.include undoes that. Removing the page or folder an import starts from removes the whole import. Uploaded files and text documents cannot be brought back.",
        destructive: true,
        input: z.object({ nodeId: z.string() }),
        handler: (ctx, { nodeId }) => {
            const node = requireNode(ctx, nodeId);
            const agents = agentsReaching(ctx, nodeId).map((a) => a.agentName);
            const root = ctx.confluence.rootOf(nodeId);
            if (root && root.id !== nodeId) {
                const below = ctx.knowledge.expand([nodeId]).length;
                guard(() => ctx.knowledge.exclude(nodeId));
                return { removed: below, excluded: true, title: node.title, agentsAffected: agents };
            }
            const removed = guard(() => ctx.knowledge.remove(nodeId));
            return { removed, excluded: false, title: node.title, agentsAffected: agents };
        },
    }),
    defineCapability({
        name: "knowledge.search",
        title: "Search the knowledge base",
        description:
            "Search the knowledge library the way an agent does: keyword and meaning search combined, best passages first, at most two per document. Limit it with nodeIds (those items and everything beneath them) or agentId (exactly what that agent can search). Each hit says which search found it. Use it to check what an agent will find before giving it a task.",
        readOnly: true,
        input: z.object({ query: z.string().min(1).max(500), nodeIds: z.array(z.string()).optional(), agentId: z.string().optional(), limit: z.number().int().min(1).max(30).default(8) }),
        handler: async (ctx, input) => {
            let scope = input.nodeIds;
            if (input.agentId) {
                const agent = requireAgent(ctx, input.agentId);
                scope = ctx.store.getRevision(agent.activeRevisionId)!.spec.knowledge;
                if (!scope.length) throw new CapabilityError(`${agent.name} has no knowledge assigned`, "conflict");
            }
            return ctx.knowledge.search(input.query, { scope, limit: input.limit });
        },
    }),
    defineCapability({
        name: "knowledge.read",
        title: "Read a knowledge document",
        description: "The full text of a document, in parts of about 12,000 characters.",
        readOnly: true,
        input: z.object({ documentId: z.string(), part: z.number().int().min(1).default(1) }),
        handler: (ctx, input) => {
            const doc = guard(() => ctx.knowledge.read(input.documentId, input.part));
            return { ...doc, node: present(doc.node) };
        },
    }),
    defineCapability({
        name: "knowledge.assign",
        title: "Give knowledge to an agent",
        description:
            "Change which parts of the knowledge library an agent may search: add or remove items, or set the whole list. Each item covers everything beneath it. This saves a new active revision of the agent, like agents.update.",
        input: z.object({ agentId: z.string(), nodeIds: z.array(z.string()), mode: z.enum(["add", "remove", "set"]).default("add"), note: z.string().default("") }),
        handler: (ctx, input) => {
            const agent = requireAgent(ctx, input.agentId);
            if (input.mode !== "remove") for (const id of input.nodeIds) requireNode(ctx, id);
            const revision = ctx.store.getRevision(agent.activeRevisionId)!;
            const current = revision.spec.knowledge;
            const next = input.mode === "set" ? [...new Set(input.nodeIds)] : input.mode === "add" ? [...new Set([...current, ...input.nodeIds])] : current.filter((id) => !input.nodeIds.includes(id));
            if (JSON.stringify(next) === JSON.stringify(current)) return { agentId: agent.id, knowledge: current, revisionCreated: false };
            const created = ctx.store.addRevision(agent.id, { ...revision.spec, knowledge: next }, input.note || "Knowledge changed", actorLabel(ctx.actor), true);
            ctx.bus.emit("change", "agents");
            ctx.bus.emit("change", "knowledge");
            return { agentId: agent.id, knowledge: next, revisionCreated: true, revisionNumber: created.number };
        },
    }),
    defineCapability({
        name: "knowledge.status",
        title: "Knowledge base status",
        description: "How big the library is, how many passages have been through the embedding model, which model that is, and the last embedding error if there was one.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ({ ...ctx.knowledge.stats(), settings: settingsView(ctx), embedError: ctx.knowledge.embedState.error, embedErrorAt: ctx.knowledge.embedState.at }),
    }),
    defineCapability({
        name: "knowledge.configure",
        title: "Knowledge search settings",
        description:
            "Choose how meaning search works. embeddings.kind: builtin (no model; matches word parts, not meaning), openai (any OpenAI-compatible /embeddings endpoint such as OpenAI or a local Ollama: baseUrl like https://api.openai.com/v1 and model), azure (Azure OpenAI: baseUrl https://<resource>.openai.azure.com and the deployment name as model) or none (keyword search only). Store the key first with secrets.set and give its name as secretName. Changing the model re-embeds everything in the background; keyword search keeps working meanwhile. Only the fields given are changed.",
        input: z.object({ embeddings: EmbeddingSettings.partial().optional() }),
        handler: (ctx, _input, raw) => {
            const patch = (raw?.embeddings ?? {}) as Partial<EmbeddingSettings>;
            const next = { ...ctx.knowledge.settings().embeddings, ...patch };
            if (next.kind === "openai" || next.kind === "azure") {
                if (!next.baseUrl || !/^https?:\/\//i.test(next.baseUrl)) throw new CapabilityError("Give the embedding endpoint as an address starting with http:// or https://", "invalid_input");
                if (!next.model) throw new CapabilityError(next.kind === "azure" ? "Give the Azure deployment name as model" : "Give the embedding model's name as model", "invalid_input");
                if (next.secretName && !ctx.vault.has(next.secretName)) throw new CapabilityError(`Secret "${next.secretName}" does not exist; store the key first with secrets.set`, "invalid_input");
            }
            ctx.knowledge.configure({ embeddings: patch });
            return settingsView(ctx);
        },
    }),
    defineCapability({
        name: "knowledge.test_embeddings",
        title: "Test the embedding model",
        description: "Send one short text to the configured embedding model and report whether it answered, how long it took and how long its vectors are. Changes nothing.",
        readOnly: true,
        input: z.object({}),
        handler: async (ctx) => {
            const started = performance.now();
            try {
                const [v] = await ctx.knowledge.embed(["Foreman knowledge base connection test"]);
                return { ok: true, detail: `Answered in ${Math.round(performance.now() - started)} ms with ${v!.length}-number vectors.`, dimensions: v!.length };
            } catch (e) {
                return { ok: false, detail: e instanceof Error ? e.message : String(e), dimensions: null };
            }
        },
    }),
    defineCapability({
        name: "knowledge.reindex",
        title: "Rebuild the search index",
        description: "Split documents into passages again and re-embed them — everything, or what is under one item. Only needed after a change to how passages are made; a model change re-embeds by itself.",
        input: z.object({ nodeId: z.string().optional() }),
        handler: (ctx, input) => {
            if (input.nodeId) requireNode(ctx, input.nodeId);
            return { documents: ctx.knowledge.reindex(input.nodeId) };
        },
    }),
    defineCapability({
        name: "knowledge.include",
        title: "Include an excluded page again",
        description: "Undo knowledge.remove for a page inside a Confluence import: it and its sub-pages come back with a sync, which starts at once.",
        input: z.object({ nodeId: z.string() }),
        handler: (ctx, { nodeId }) => {
            const node = requireNode(ctx, nodeId);
            if (node.status !== "excluded") throw new CapabilityError(`“${node.title}” is not excluded`, "conflict");
            ctx.knowledge.include(nodeId);
            const root = ctx.confluence.rootOf(nodeId);
            if (root) void ctx.confluence.sync(root.id);
            return present(ctx.knowledge.get(nodeId)!, ctx);
        },
    }),
    defineCapability({
        name: "knowledge.import_confluence",
        title: "Import from Confluence",
        description:
            "Bring Confluence pages into the knowledge library and keep them current. scope page: one page. scope tree: a page and every page beneath it, including pages added later. scope space: a whole space (give spaceKey). The page may be its id or any page address. Importing runs in the background; knowledge.tree shows progress on the import. Later syncs re-read only pages whose version changed.",
        input: z.object({ page: z.string().optional().describe("Page id or address, for scope page or tree"), spaceKey: z.string().optional().describe("Space key, for scope space"), scope: z.enum(["page", "tree", "space"]).default("tree"), parentId: ParentId }),
        handler: async (ctx, input) => {
            if (input.parentId) requireNode(ctx, input.parentId);
            try {
                return present(await ctx.confluence.import(input), ctx);
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                throw new CapabilityError(message, /already/.test(message) ? "conflict" : /Cannot reach|answered/.test(message) ? "failed" : "invalid_input");
            }
        },
    }),
    defineCapability({
        name: "knowledge.sync",
        title: "Check Confluence for changes",
        description: "Sync one Confluence import (give nodeId: the import or any page in it) or all of them now, instead of waiting for the schedule. Waits for the result: pages added, updated, removed, unchanged and failed.",
        input: z.object({ nodeId: z.string().optional() }),
        handler: async (ctx, input) => {
            if (!input.nodeId) return { reports: await ctx.confluence.syncAll() };
            requireNode(ctx, input.nodeId);
            const root = ctx.confluence.rootOf(input.nodeId);
            if (!root) throw new CapabilityError("That item does not come from Confluence", "conflict");
            return { reports: [await ctx.confluence.sync(root.id)] };
        },
    }),
    defineCapability({
        name: "confluence.status",
        title: "Confluence connection",
        description: "Which Confluence site the knowledge base reads from (empty baseUrl: the built-in mock), how it signs in (never the token), how often imports are synced, and the imports with their last sync.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ({ ...ctx.confluence.settings(), usingMock: ctx.confluence.isMock(), imports: ctx.confluence.roots().map((r) => present(r, ctx)) }),
    }),
    defineCapability({
        name: "confluence.configure",
        title: "Configure the Confluence connection",
        description:
            "Point the knowledge base at Confluence. Leave baseUrl empty for the built-in mock. Data Center: flavor datacenter, auth {type: bearer, secretName} with a personal access token. Cloud: flavor cloud, auth {type: basic, email, secretName} with an API token. Store the token first with secrets.set. syncMinutes sets how often imports are checked (0: only on request). Agents can read whatever this account can read, so use an account limited to the spaces agents should see. Only the fields given are changed.",
        input: ConfluenceSettings.omit({ auth: true }).partial().extend({ auth: ConfluenceAuth.partial().optional() }),
        handler: (ctx, _input, raw) => {
            const patch = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k in ConfluenceSettings.shape)) as Parameters<typeof ctx.confluence.configure>[0];
            const auth = { ...ctx.confluence.settings().auth, ...patch.auth };
            if (auth.type !== "none") {
                if (!auth.secretName) throw new CapabilityError("Give auth.secretName: the name of the stored token (secrets.set)", "invalid_input");
                if (!ctx.vault.has(auth.secretName)) throw new CapabilityError(`Secret "${auth.secretName}" does not exist; store the token first with secrets.set`, "invalid_input");
                if (auth.type === "basic" && !auth.email) throw new CapabilityError("Confluence Cloud sign-in needs auth.email as well as the token", "invalid_input");
            }
            if (typeof patch.baseUrl === "string" && patch.baseUrl && !/^https?:\/\//i.test(patch.baseUrl)) throw new CapabilityError("baseUrl must start with http:// or https://", "invalid_input");
            return { ...ctx.confluence.configure(patch), usingMock: ctx.confluence.isMock() };
        },
    }),
    defineCapability({
        name: "confluence.test",
        title: "Test the Confluence connection",
        description: "Ask Confluence who the configured credentials belong to. Changes nothing.",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ctx.confluence.test(),
    }),
    defineCapability({
        name: "confluence.browse",
        title: "Browse Confluence",
        description: "For choosing what to import: with nothing, the spaces; with spaceKey, the top pages of that space; with pageId, the pages directly beneath it; with query, pages whose title matches (optionally within spaceKey).",
        readOnly: true,
        input: z.object({ spaceKey: z.string().optional(), pageId: z.string().optional(), query: z.string().optional() }),
        handler: async (ctx, input) => {
            const client = guard(() => ctx.confluence.client());
            try {
                if (input.query) return { pages: await client.searchTitles(input.query, input.spaceKey) };
                if (input.pageId) return { pages: await client.children(input.pageId) };
                if (input.spaceKey) return { pages: await client.rootPages(input.spaceKey) };
                return { spaces: await client.spaces() };
            } catch (e) {
                throw new CapabilityError(e instanceof Error ? e.message : String(e), "failed");
            }
        },
    }),
    defineCapability({
        name: "mockconfluence.change",
        title: "Change the mock Confluence",
        description: "Edit, add or delete a page in the built-in mock Confluence, to see a sync pick it up. edit: pageId with title and/or appendText. add: pageId of the parent, title, and appendText as the body. delete: pageId (its sub-pages go too).",
        input: z.object({ action: z.enum(["edit", "add", "delete"]), pageId: z.string(), title: z.string().optional(), appendText: z.string().optional() }),
        handler: (ctx, input) => {
            const mock = ctx.mockConfluence;
            if (input.action === "delete") {
                if (!mock.delete(input.pageId)) throw new CapabilityError(`No mock page ${input.pageId}`, "not_found");
                return { deleted: input.pageId };
            }
            const page = input.action === "add" ? mock.add(input.pageId, input.title ?? "New page", input.appendText ?? "") : mock.edit(input.pageId, { title: input.title, appendText: input.appendText });
            if (!page) throw new CapabilityError(`No mock page ${input.pageId}`, "not_found");
            return { pageId: page.id, title: page.title, version: page.version };
        },
    }),
];
