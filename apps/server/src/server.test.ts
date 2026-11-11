import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

const TOKEN = "test-token";
let base: string;
let close: () => Promise<void>;
let mcp: Client;

const rpc = async (name: string, input: unknown = {}, token = TOKEN) => {
    const res = await fetch(`${base}/api/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(input) });
    return { status: res.status, body: (await res.json()) as any };
};
const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as any;
    if (res.isError) throw new Error(res.content[0].text);
    return JSON.parse(res.content[0].text);
};

beforeAll(async () => {
    const { app, foreman } = await buildApp({ dataDir: "", baseUrl: "http://test", memory: true, simulatedStepDelayMs: 0, token: TOKEN });
    foreman.start();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
    mcp = new Client({ name: "test-client", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-foreman-client": "test-client" } } }));
    close = async () => {
        await mcp.close();
        await app.close();
        await foreman.stop();
    };
});
afterAll(() => close());

describe("http api", () => {
    it("requires the bearer token", async () => {
        expect((await rpc("agents.list", {}, "wrong")).status).toBe(401);
        expect((await rpc("agents.list")).status).toBe(200);
    });
    it("maps capability errors to status codes", async () => {
        expect((await rpc("agents.get", { agentId: "nope" })).status).toBe(404);
        expect((await rpc("agents.create", {})).status).toBe(400);
        expect((await rpc("does.not.exist")).status).toBe(404);
    });
});

describe("mcp", () => {
    it("exposes exactly the capabilities the API exposes", async () => {
        const caps = (await (await fetch(`${base}/api/capabilities`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any[];
        const { tools } = await mcp.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(caps.map((c) => c.toolName).sort());
        const archive = tools.find((t) => t.name === "agents_archive")!;
        expect(archive.annotations?.destructiveHint).toBe(true);
        expect(tools.find((t) => t.name === "runs_timeline")!.annotations?.readOnlyHint).toBe(true);
    });

    it("builds, runs, approves and debugs an agent using MCP alone", async () => {
        const { agent } = await tool("agents_create", { name: "MCP built", spec: { runtime: "simulated", tools: ["view", "edit"] } });
        const trigger = await tool("triggers_create", { agentId: agent.id, name: "hook", config: { kind: "webhook" }, promptTemplate: "Handle {{payload.title}}" });

        const hook = await fetch(trigger.webhookUrl.replace("http://test", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Broken build" }) });
        expect(hook.status).toBe(202);
        const { runId } = (await hook.json()) as any;

        const waiting = await tool("runs_wait", { runId, timeoutSeconds: 10 });
        expect(waiting.status).toBe("waiting_approval");
        expect(waiting.prompt).toContain("Handle Broken build");
        const [approval] = await tool("approvals_list", { runId });
        await tool("approvals_decide", { approvalId: approval.id, decision: "deny", reason: "not now" });
        const done = await tool("runs_wait", { runId, timeoutSeconds: 10 });
        expect(done.status).toBe("succeeded");

        const why = await tool("runs_explain_failure", { runId });
        expect(why.signals.join("\n")).toMatch(/Not approved|Permission denied/);

        const audit = await tool("audit_list", { limit: 10 });
        expect(audit.find((a: any) => a.capability === "approvals.decide").actor).toBe("mcp:test-client");
    });

    it("rejects a wrong webhook secret", async () => {
        const res = await fetch(`${base}/hooks/trg_missing/nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        expect(res.status).toBe(404);
    });

    it("serves resources and prompts", async () => {
        const { resources } = await mcp.listResources();
        expect(resources.length).toBeGreaterThan(0);
        const read = await mcp.readResource({ uri: resources[0]!.uri });
        expect(JSON.parse((read.contents[0] as any).text).agent.id).toBeTruthy();
        const { prompts } = await mcp.listPrompts();
        expect(prompts.map((p) => p.name)).toContain("investigate-run");
        const prompt = await mcp.getPrompt({ name: "investigate-run", arguments: { runId: "run_1" } });
        expect((prompt.messages[0]!.content as any).text).toContain("run_1");
    });
});
