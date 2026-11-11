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

describe("work queue", () => {
    const settle = async (key: string, states: string[], ms = 8000) => {
        const until = Date.now() + ms;
        for (;;) {
            const { item } = (await rpc("work.get", { itemId: key })).body.result;
            if (states.includes(item.state) || Date.now() > until) return item;
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    it("takes tickets from Jira, routes, runs and tracks them", async () => {
        const agent = (await rpc("agents.create", { name: "Queue worker", spec: { policy: { autonomy: "act" }, mock: { scenario: "happy" } } })).body.result.agent;
        await rpc("jira.configure", { baseUrl: `${base}/mock/jira`, enabled: false, wipPerAgent: 1, jql: "labels = foreman AND status != Done" });

        // No rules yet: everything the filter matches lands in the inbox, and unlabelled tickets are left alone.
        const first = (await rpc("work.sync")).body.result;
        expect(first.added).toBe(12);
        expect((await rpc("work.sync")).body.result).toMatchObject({ added: 0, updated: 0 });
        expect((await rpc("work.stats")).body.result.byState.inbox).toBe(12);

        expect((await rpc("routing.test", { ticket: { project: "DOC", type: "Task" } })).body.result.outcome).toBe("inbox");
        const created = (await rpc("routing.create", { name: "Docs", match: { project: "doc" }, agentId: agent.id, review: true })).body.result;
        expect(created.inboxItemsRouted).toBe(2);

        // Both DOC tickets are routed, but the per-agent limit of 1 runs them one at a time.
        const doc = await tool("work_list", { project: "DOC" });
        expect(doc).toHaveLength(2);
        const reviewed = await settle(doc[0].ticket.key, ["review"]);
        expect(reviewed).toMatchObject({ state: "review", attempts: 1, agentName: "Queue worker" });
        await settle(doc[1].ticket.key, ["review"]);
        const runs = (await rpc("runs.list", { agentId: agent.id })).body.result.sort((a: any, b: any) => a.startedAt.localeCompare(b.startedAt));
        expect(runs).toHaveLength(2);
        expect(runs[1].startedAt >= runs[0].finishedAt).toBe(true);
        expect((await rpc("work.complete", { itemId: reviewed.id })).body.result.state).toBe("done");

        const detail = (await rpc("work.get", { itemId: reviewed.ticket.key })).body.result;
        expect(detail.attempts).toHaveLength(1);
        expect(detail.attempts[0].source).toMatchObject({ kind: "work", workItemId: reviewed.id });
        expect(detail.rule.name).toBe("Docs");
    });

    it("stops for approval, retries transient failures, and supports manual control", async () => {
        const agents = (await rpc("agents.list")).body.result;
        const agent = agents.find((a: any) => a.name === "Queue worker");

        // A new ticket whose label makes the mock agent push a branch → needs a person.
        const filed = (await rpc("mockjira.create_issue", { summary: "Cut release 9.9", project: "REL", labels: ["foreman", "mock:needs-approval"] })).body.result;
        await rpc("work.sync");
        const inbox = (await rpc("work.get", { itemId: filed.key })).body.result.item;
        expect(inbox.state).toBe("inbox");
        await rpc("work.assign", { itemId: inbox.id, agentId: agent.id });
        const waiting = await settle(filed.key, ["needs_you"]);
        expect(waiting.pendingApproval.summary).toContain("git push");
        await rpc("approvals.decide", { approvalId: waiting.pendingApproval.id, decision: "approve" });
        expect((await settle(filed.key, ["done", "review"])).state).toBe("done");

        // Flaky: the first attempt fails with a transient error and is retried automatically.
        const flaky = (await rpc("mockjira.create_issue", { summary: "Sync orders", project: "REL", labels: ["foreman", "mock:flaky"] })).body.result;
        const added = (await rpc("work.add", { keys: [flaky.key, "NOPE-1"] })).body.result;
        expect(added.notFound).toEqual(["NOPE-1"]);
        await rpc("work.assign", { itemId: added.added[0].id, agentId: agent.id });
        const failed = await settle(flaky.key, ["failed"]);
        expect(failed.attempts).toBe(2);
        expect(failed.note).toMatch(/ECONNRESET/);

        // Manual control: hold keeps a queued item from starting; skip and reorder work.
        const held = (await rpc("mockjira.create_issue", { summary: "Hold me", project: "REL" })).body.result;
        const item = (await rpc("work.add", { keys: [held.key] })).body.result.added[0];
        await rpc("work.hold", { itemId: item.id });
        await rpc("work.assign", { itemId: item.id, agentId: agent.id });
        await rpc("work.hold", { itemId: item.id, held: true });
        expect((await rpc("work.rank", { itemId: item.id, position: "top" })).status).toBe(200);
        expect((await rpc("work.skip", { itemId: item.id, reason: "not ours" })).body.result).toMatchObject({ state: "skipped", note: "not ours" });
        expect((await rpc("work.assign", { itemId: "wrk_nope", agentId: agent.id })).status).toBe(404);
    });

    it("serves the mock ticket page", async () => {
        const res = await fetch(`${base}/mock/jira/browse/PAY-181`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("Partial refund");
    });
});
