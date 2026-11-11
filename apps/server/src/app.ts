import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { AgentSpec, CapabilityError, createForeman, type Actor, type ForemanOptions } from "@foreman/core";
import { createMcpServer } from "./mcp.ts";

export interface AppOptions extends ForemanOptions {
    /** When set, the API and MCP endpoints require `Authorization: Bearer <token>`. */
    token?: string;
    logger?: boolean;
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const STATUS: Record<string, number> = { not_found: 404, invalid_input: 400, conflict: 409, failed: 500 };

export async function buildApp(options: AppOptions): Promise<{ app: FastifyInstance; foreman: ReturnType<typeof createForeman> }> {
    const foreman = createForeman(options);
    const { registry, bus, store, triggers } = foreman;
    const app = Fastify({ logger: options.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

    const authorised = (req: FastifyRequest) => !options.token || safeEqual(req.headers.authorization ?? "", `Bearer ${options.token}`);
    app.addHook("onRequest", async (req, reply) => {
        const guarded = req.url.startsWith("/api/") || req.url.startsWith("/mcp");
        if (guarded && !authorised(req)) return reply.code(401).send({ error: "Missing or invalid bearer token" });
    });

    // ── API: a thin projection of the capability registry ─────────────────
    app.get("/api/capabilities", async () => registry.describe());
    app.post<{ Params: { name: string } }>("/api/rpc/:name", async (req, reply) => {
        // The stdio MCP bridge identifies itself so its calls are audited as MCP, not as the UI.
        const bridge = req.headers["x-foreman-client"];
        const actor: Actor = bridge ? { kind: "mcp", id: String(bridge).slice(0, 60) } : { kind: "user", id: "local" };
        try {
            return { result: await registry.invoke(req.params.name, req.body, actor) };
        } catch (e) {
            const code = e instanceof CapabilityError ? e.code : "failed";
            return reply.code(STATUS[code] ?? 500).send({ error: e instanceof Error ? e.message : String(e), code });
        }
    });

    // ── Live updates ──────────────────────────────────────────────────────
    app.get("/api/stream", (req, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
        const send = (type: string, data: unknown) => reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        const onRun = (run: { id: string; agentId: string; status: string }) => send("run", { runId: run.id, agentId: run.agentId, status: run.status });
        const onEvent = (event: { runId: string; seq: number }) => send("event", { runId: event.runId, seq: event.seq });
        const onApproval = (approval: { id: string; runId: string; status: string }) => send("approval", { approvalId: approval.id, runId: approval.runId, status: approval.status });
        const onChange = (entity: string) => send("change", { entity });
        bus.on("run", onRun).on("event", onEvent).on("approval", onApproval).on("change", onChange);
        send("hello", { version: foreman.info.version });
        const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
        req.raw.on("close", () => {
            clearInterval(heartbeat);
            bus.off("run", onRun).off("event", onEvent).off("approval", onApproval).off("change", onChange);
        });
    });

    // ── Webhook triggers: the secret in the path is the credential ────────
    app.post<{ Params: { id: string; secret: string } }>("/hooks/:id/:secret", async (req, reply) => {
        const trigger = store.getTrigger(req.params.id);
        if (!trigger || trigger.config.kind !== "webhook" || !safeEqual(trigger.secret, req.params.secret)) return reply.code(404).send({ error: "Unknown webhook" });
        const result = triggers.fire(trigger.id, req.body ?? {}, "webhook");
        return result.fired ? reply.code(202).send({ accepted: true, runId: result.run.id }) : reply.code(409).send({ accepted: false, reason: result.reason });
    });

    // ── MCP over Streamable HTTP (stateless: one server per request) ──────
    app.post("/mcp", async (req, reply) => {
        const client = String(req.headers["x-foreman-client"] ?? req.headers["user-agent"] ?? "client").slice(0, 60);
        const actor: Actor = { kind: "mcp", id: client };
        const server = createMcpServer({ describe: async () => registry.describe(), invoke: (name, input) => registry.invoke(name, input, actor) });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        reply.hijack();
        reply.raw.on("close", () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
    });
    const noSession = async (_req: FastifyRequest, reply: any) => reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "This MCP endpoint is stateless; use POST." }, id: null });
    app.get("/mcp", noSession);
    app.delete("/mcp", noSession);

    // ── Web UI (built) ────────────────────────────────────────────────────
    const webDist = resolve(fileURLToPath(import.meta.url), "../../../web/dist");
    if (existsSync(webDist)) {
        await app.register(fastifyStatic, { root: webDist });
        app.setNotFoundHandler((req, reply) => (req.method === "GET" && !/^\/(api|mcp|hooks)\b/.test(req.url) ? reply.sendFile("index.html") : reply.code(404).send({ error: "Not found" })));
    }

    return { app, foreman };
}

/** Give a fresh install something to look at and run. */
export function seedIfEmpty(foreman: ReturnType<typeof createForeman>) {
    if (foreman.store.listAgents(true).length) return;
    foreman.store.createAgent({
        name: "Hello Foreman",
        description: "A sample agent on the built-in simulator. Run it to see a trace, then make your own.",
        spec: AgentSpec.parse({
            runtime: "simulated",
            instructions: "You are a careful assistant. Read before you write, and keep answers short.",
            tools: ["view", "edit"],
            policy: { autonomy: "propose" },
        }),
        note: "Sample agent",
        actor: "system:seed",
    });
}
