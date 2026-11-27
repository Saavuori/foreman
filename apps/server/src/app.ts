import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { CapabilityError, createForeman, mockModelReply, plainText, type Actor, type ForemanOptions } from "@foreman/core";
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

    // ── Jira webhook: authenticated by the secret in the path. The body is ignored on purpose. ──
    app.post<{ Params: { secret: string } }>("/hooks/jira/:secret", async (req, reply) => {
        if (!safeEqual(req.params.secret, foreman.work.webhookSecret())) return reply.code(404).send({ error: "Unknown webhook" });
        return reply.code(202).send(foreman.work.nudge());
    });

    // ── Teams bot messaging endpoint: authenticated by the Bot Framework's signed token, checked in core ──
    app.post("/hooks/teams/messages", async (req, reply) => {
        const { status, body } = await foreman.bot.receive(req.headers.authorization, (req.body ?? {}) as any);
        return reply.code(status).send(body);
    });

    // ── Mock Bot Framework (unauthenticated discovery, like Microsoft's; the connector checks its own tokens) ──
    const { mockBot } = foreman;
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    app.get("/mock/botframework/openid", async () => mockBot.openIdDocument());
    app.get("/mock/botframework/keys", async () => mockBot.keys());
    app.post<{ Body: Record<string, string> }>("/mock/botframework/login/:tenant/oauth2/v2.0/token", async (req, reply) => {
        const token = mockBot.issueToken(req.body?.client_id ?? "", req.body?.client_secret ?? "");
        return token ?? reply.code(401).send({ error: "invalid_client", error_description: "Mock Bot Framework: wrong app ID or client secret" });
    });
    app.post<{ Params: { conversation: string } }>("/mock/botframework/v3/conversations/:conversation/activities", async (req, reply) => {
        if (!mockBot.authorised(req.headers.authorization)) return reply.code(401).send({ error: { code: "Unauthorized", message: "Mock Bot Framework: missing or unknown token" } });
        return mockBot.receive(req.params.conversation, req.body);
    });
    app.put<{ Params: { conversation: string; id: string } }>("/mock/botframework/v3/conversations/:conversation/activities/:id", async (req, reply) => {
        if (!mockBot.authorised(req.headers.authorization)) return reply.code(401).send({ error: { code: "Unauthorized", message: "Mock Bot Framework: missing or unknown token" } });
        return mockBot.receive(req.params.conversation, req.body, req.params.id) ?? reply.code(404).send({ error: { code: "NotFound", message: "No such message" } });
    });

    // ── Mock model: an OpenAI-compatible endpoint that needs no key (unauthenticated, like the other mocks) ──
    app.post("/mock/model/v1/chat/completions", async (req, reply) => {
        const body = (req.body ?? {}) as { model?: string; messages?: unknown[]; stream?: boolean };
        const { message, finish } = mockModelReply(body);
        const base = { id: "chatcmpl-mock", created: Math.floor(Date.now() / 1000), model: body.model ?? "mock" };
        const prompt = Math.round(200 + JSON.stringify(body.messages ?? []).length / 4);
        const usage = { prompt_tokens: prompt, completion_tokens: 20, total_tokens: prompt + 20 };
        if (!body.stream) return { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage };
        const calls = message.tool_calls as any[] | undefined;
        const delta = calls ? { role: "assistant", tool_calls: calls.map((c, index) => ({ index, ...c })) } : message;
        reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        reply.raw.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
        reply.raw.end("data: [DONE]\n\n");
        return reply.hijack();
    });

    // ── Mock Jira: the REST shapes of Jira Cloud, backed by memory ─────────
    const { mockJira } = foreman;
    // Both API versions are served: v3 as Jira Cloud speaks it, v2 as Data Center does.
    const J = "/mock/jira/rest/api/:v";
    const missing = (reply: any) => reply.code(404).send({ errorMessages: ["Issue does not exist"] });
    app.addHook("preHandler", async (req, reply) => {
        if (mockJira.requiredAuth && req.url.startsWith("/mock/jira/rest/") && req.headers.authorization !== mockJira.requiredAuth) return reply.code(401).send({ errorMessages: ["Mock Jira: wrong or missing credentials"] });
    });
    app.get(`${J}/myself`, async (req) => ({ displayName: req.headers.authorization ? "Mock Jira User" : "Anonymous (mock)", emailAddress: null }));
    app.get<{ Querystring: { jql?: string; maxResults?: string } }>(`${J}/search/jql`, async (req) => {
        const issues = mockJira.search(req.query.jql ?? "").slice(0, Number(req.query.maxResults ?? 50) || 50);
        return { issues, isLast: true };
    });
    app.get<{ Querystring: { jql?: string; maxResults?: string; startAt?: string } }>(`${J}/search`, async (req) => {
        const all = mockJira.search(req.query.jql ?? "");
        const startAt = Number(req.query.startAt ?? 0) || 0;
        return { issues: all.slice(startAt, startAt + (Number(req.query.maxResults ?? 50) || 50)), startAt, total: all.length };
    });
    app.get<{ Params: { key: string } }>(`${J}/issue/:key`, async (req, reply) => mockJira.get(req.params.key) ?? missing(reply));
    app.post<{ Params: { key: string }; Body: { body?: unknown } }>(`${J}/issue/:key/comment`, async (req, reply) => {
        const text = plainText(req.body?.body).trim();
        if (!text) return reply.code(400).send({ errorMessages: ["Comment body is empty"] });
        return mockJira.addComment(req.params.key, text) ? reply.code(201).send({ created: true }) : missing(reply);
    });
    app.get<{ Params: { key: string } }>(`${J}/issue/:key/transitions`, async (req, reply) => {
        const transitions = mockJira.transitions(req.params.key);
        return transitions ? { transitions } : missing(reply);
    });
    app.post<{ Params: { key: string }; Body: { transition?: { id?: string } } }>(`${J}/issue/:key/transitions`, async (req, reply) => {
        if (!mockJira.get(req.params.key)) return missing(reply);
        return mockJira.transition(req.params.key, String(req.body?.transition?.id ?? "")) ? reply.code(204).send() : reply.code(400).send({ errorMessages: ["No such transition"] });
    });
    app.post<{ Body: { fields?: any } }>(`${J}/issue`, async (req, reply) => {
        const f = req.body?.fields ?? {};
        if (!f.summary) return reply.code(400).send({ errors: { summary: "You must specify a summary of the issue." } });
        if (f.parent?.key && !mockJira.get(f.parent.key)) return reply.code(400).send({ errors: { parent: "Parent issue does not exist." } });
        const issue = mockJira.create({ project: f.project?.key, type: f.issuetype?.name, summary: f.summary, description: plainText(f.description).trim(), labels: f.labels ?? [], parent: f.parent?.key?.toUpperCase() });
        return reply.code(201).send({ id: issue.key, key: issue.key });
    });
    app.get<{ Params: { key: string } }>("/mock/jira/browse/:key", async (req, reply) => {
        const issue = mockJira.get(req.params.key);
        if (!issue) return reply.code(404).type("text/plain").send("No such mock ticket");
        const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
        const f = issue.fields;
        return reply.type("text/html").send(
            `<!doctype html><meta charset="utf-8"><title>${esc(issue.key)} · Mock Jira</title><body style="font:15px/1.5 system-ui;max-width:680px;margin:48px auto;padding:0 20px;color:#16202b">
<p style="color:#74818e;font-size:13px">Mock Jira · ${esc(f.project.key)} · ${esc(f.issuetype.name)} · ${esc(f.priority.name)} · ${esc(f.status.name)}</p>
<h1 style="font-size:22px;margin:4px 0 16px">${esc(issue.key)} ${esc(f.summary)}</h1><p>${esc(f.description)}</p>
<p style="color:#74818e;font-size:13px">Labels: ${esc(f.labels.join(", ") || "none")}${f.parent ? ` · Subtask of <a href="${esc(f.parent.key)}">${esc(f.parent.key)}</a>` : ""}</p>
${mockJira.subtasks(issue.key).length ? `<h2 style="font-size:15px;margin:28px 0 6px">Subtasks</h2><ul style="padding-left:20px;margin:0">${mockJira.subtasks(issue.key).map((s) => `<li><a href="${esc(s.key)}">${esc(s.key)}</a> ${esc(s.fields.summary)} <span style="color:#74818e">· ${esc(s.fields.status.name)}</span></li>`).join("")}</ul>` : ""}
<h2 style="font-size:15px;margin:28px 0 6px">Comments (${f.comment.comments.length})</h2>
${f.comment.comments.map((c) => `<div style="border-left:3px solid #d5dbe1;padding:2px 12px;margin:10px 0"><p style="color:#74818e;font-size:12.5px;margin:0">${esc(c.author.displayName)} · ${esc(c.created.slice(0, 16).replace("T", " "))} UTC</p><p style="margin:4px 0;white-space:pre-wrap">${esc(c.body)}</p></div>`).join("") || '<p style="color:#74818e">None yet.</p>'}</body>`,
        );
    });

    // ── Practice Power Platform tenant: management API, Dataverse and sign-in (unauthenticated, like the other mocks) ──
    // The same handler answers Foreman in-process; serving it here lets the real HTTP path be exercised too.
    app.all("/mock/powerplatform/*", async (req, reply) => {
        const url = new URL(req.url, "http://local");
        const origin = `${req.protocol}://${req.headers.host}/mock/powerplatform`;
        const res = foreman.powerPlatform.mock.handle({ method: req.method, origin, path: url.pathname.slice("/mock/powerplatform".length), query: url.searchParams, headers: req.headers as Record<string, string | undefined>, body: req.body });
        reply.code(res.status).headers(res.headers ?? {});
        return res.body === undefined || res.status === 204 ? reply.send() : reply.send(res.body);
    });

    // ── Mock Teams: accepts what a Teams Workflows webhook accepts ────────
    app.post<{ Params: { channel: string } }>("/mock/teams/:channel", async (req, reply) => {
        const body = req.body as { attachments?: unknown[] } | undefined;
        if (!body || !Array.isArray(body.attachments)) return reply.code(400).send({ error: "Expected a Teams message with attachments" });
        foreman.notify.mockTeams.post(req.params.channel, body);
        return reply.code(202).send();
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
        app.setNotFoundHandler((req, reply) => (req.method === "GET" && !/^\/(api|mcp|hooks|mock)\b/.test(req.url) ? reply.sendFile("index.html") : reply.code(404).send({ error: "Not found" })));
    }

    return { app, foreman };
}
