import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotRuntime } from "@foreman/runtime-copilot";
import { buildApp } from "./app.ts";

const TOKEN = "test-token";
let base: string;
let close: () => Promise<void>;
let mcp: Client;
let foreman: Awaited<ReturnType<typeof buildApp>>["foreman"];

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
    const built = await buildApp({ dataDir: "", baseUrl: "http://test", memory: true, simulatedStepDelayMs: 0, token: TOKEN, notifyRetryDelaysMs: [5, 5], runtimes: [new CopilotRuntime({ dataDir: mkdtempSync(join(tmpdir(), "foreman-test-")) })] });
    const { app } = built;
    foreman = built.foreman;
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
        expect(first.added).toBe(14);
        expect((await rpc("work.sync")).body.result).toMatchObject({ added: 0, updated: 0 });
        expect((await rpc("work.stats")).body.result.byState.inbox).toBe(14);

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

describe("notifications", () => {
    const call = async (name: string, input: unknown = {}) => {
        const res = await rpc(name, input);
        if (res.status !== 200) throw new Error(`${name}: ${res.body.error}`);
        return res.body.result;
    };
    const cardText = (message: any) => JSON.stringify(message.payload.attachments[0].content);
    const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 4000): Promise<T> => {
        const until = Date.now() + ms;
        for (;;) {
            const value = await fn();
            if (value) return value;
            if (Date.now() > until) throw new Error("Timed out waiting");
            await new Promise((r) => setTimeout(r, 20));
        }
    };

    it("puts events in the inbox and sends matching ones to a channel as Teams cards", async () => {
        const preview = await call("channels.create", { name: "Preview", kind: "mock_teams" });
        expect(preview.address).toBe("Built-in preview");
        await call("notifyrules.create", { name: "Approvals only", events: ["approval_needed"], channelId: preview.id });

        const { agent } = await call("agents.create", { name: "Pusher", spec: { policy: { autonomy: "act" }, mock: { scenario: "needs-approval" } } });
        const run = await call("runs.start", { agentId: agent.id, prompt: "Ship it", waitSeconds: 10 });
        expect(run.status).toBe("waiting_approval");

        const [message] = await waitFor(async () => {
            const messages = await call("mockteams.messages", { channelId: preview.id });
            return messages.length ? messages : undefined;
        });
        expect(message.payload.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
        expect(cardText(message)).toContain("Pusher needs your approval");
        expect(cardText(message)).toContain("git push");
        expect(cardText(message)).toContain(`/#/runs/${run.id}`);

        // A failed run reaches the inbox but not this channel, whose rule covers approvals only.
        await call("runs.cancel", { runId: run.id });
        await call("agents.update", { agentId: agent.id, spec: { mock: { scenario: "auto" } } });
        await call("runs.start", { agentId: agent.id, prompt: "Break [fail]", waitSeconds: 10 });
        const inbox = await call("notify.inbox");
        expect(inbox.entries.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["approval_needed", "run_failed"]));
        expect(inbox.unread).toBeGreaterThan(0);
        expect(await call("mockteams.messages", { channelId: preview.id })).toHaveLength(1);
        expect((await call("notify.mark_read")).unread).toBe(0);
    });

    it("posts to a Teams webhook over HTTP, retries failures and logs every outcome", async () => {
        const teams = await call("channels.create", { name: "Real shape", kind: "teams", webhookUrl: `${base}/mock/teams/over-http` });
        expect(teams.address).not.toContain("over-http".slice(0, 4) + "-");
        const sent = await call("channels.test", { channelId: teams.id, kind: "ticket_failed" });
        expect(sent).toMatchObject({ status: "sent", attempts: 1 });
        expect(cardText((await call("mockteams.messages", { channelId: "over-http" }))[0])).toContain("PAY-184 failed");

        const broken = await call("channels.create", { name: "Broken", kind: "webhook", webhookUrl: `${base}/hooks/nope/nope` });
        const failed = await call("channels.test", { channelId: broken.id });
        expect(failed).toMatchObject({ status: "failed", attempts: 3 });
        expect(failed.error).toMatch(/404/);
        expect((await call("notify.log", { limit: 5 })).map((d: any) => d.status)).toEqual(expect.arrayContaining(["sent", "failed"]));

        // The posting address is a secret: masked when listed, redacted in the audit log.
        const listed = (await call("channels.list")).find((c: any) => c.id === teams.id);
        expect(JSON.stringify(listed)).not.toContain("over-http");
        const audit = (await call("audit.list", { limit: 20 })).find((a: any) => a.capability === "channels.create" && a.input.name === "Real shape");
        expect(audit.input.webhookUrl).toBe("•••");
        expect((await rpc("channels.create", { name: "No address", kind: "teams" })).status).toBe(400);
    });

    it("reports ticket outcomes, the digest and custom messages; validates the schedule", async () => {
        const all = await call("channels.create", { name: "Everything", kind: "mock_teams" });
        await call("notifyrules.create", { name: "All", channelId: all.id });
        const agents = await call("agents.list");
        const worker = agents.find((a: any) => a.name === "Queue worker");
        const filed = await call("mockjira.create_issue", { summary: "Notify me", project: "NTF" });
        const item = (await call("work.add", { keys: [filed.key] })).added[0];
        await call("work.assign", { itemId: item.id, agentId: worker.id });
        const texts = async () => (await call("mockteams.messages", { channelId: all.id })).map(cardText).join("\n");
        await waitFor(async () => (await texts()).includes(`${filed.key} is done`));

        await call("notify.send_digest");
        await call("notify.send", { title: "Deploy window opens at 14:00", severity: "warning" });
        await waitFor(async () => (await texts()).includes("Deploy window"));
        expect(await texts()).toMatch(/Last 24 hours: \d+ done/);

        expect((await rpc("notify.configure", { digestEnabled: true, digestCron: "not a cron" })).status).toBe(400);
        const settings = await call("notify.configure", { digestEnabled: true, digestCron: "0 8 * * 1-5", digestTimezone: "Europe/Helsinki" });
        expect(settings.digestEnabled).toBe(true);
        expect((await call("notify.settings")).nextDigestAt).toBeTruthy();
        expect((await call("notify.preview", { kind: "digest" })).card.type).toBe("AdaptiveCard");
    });
});

describe("secrets, real Jira sign-in and write-back", () => {
    const call = async (name: string, input: unknown = {}) => {
        const res = await rpc(name, input);
        if (res.status !== 200) throw new Error(`${name} → ${res.status}: ${res.body.error}`);
        return res.body.result;
    };
    const waitFor = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
        const until = Date.now() + ms;
        while (!(await check())) {
            if (Date.now() > until) throw new Error("timed out waiting");
            await new Promise((r) => setTimeout(r, 20));
        }
    };
    const settle = async (key: string, states: string[]) => {
        let item: any;
        await waitFor(async () => states.includes((item = (await call("work.get", { itemId: key })).item).state));
        return item;
    };
    const issue = (key: string) => foreman.mockJira.get(key)!;
    const comments = (key: string) => issue(key).fields.comment.comments.map((c) => c.body).join("\n---\n");
    const TOKEN_VALUE = "jira-tok-8f3a1c9d77";

    it("stores secrets write-only, encrypted, and keeps them out of the audit log and traces", async () => {
        const stored = await call("secrets.set", { name: "jira-token", secretValue: TOKEN_VALUE, description: "Jira API token" });
        expect(JSON.stringify(stored)).not.toContain(TOKEN_VALUE);
        const listed = await call("secrets.list");
        expect(listed.secrets.map((s: any) => s.name)).toEqual(["jira-token"]);
        expect(JSON.stringify(listed)).not.toContain(TOKEN_VALUE);
        expect((foreman.store.db.prepare("SELECT sealed FROM secrets WHERE name = 'jira-token'").get() as any).sealed).toMatch(/^enc:v1:/);
        expect(JSON.stringify(await call("audit.list", { limit: 20 }))).not.toContain(TOKEN_VALUE);
        expect((await rpc("secrets.set", { name: "bad name!", secretValue: "x" })).status).toBe(400);

        // A value that reaches a run (here through the prompt) is scrubbed from what is recorded.
        const agent = (await call("agents.create", { name: "Leaky", spec: { mock: { scenario: "auto" } } })).agent;
        const run = await call("runs.start", { agentId: agent.id, prompt: `Use ${TOKEN_VALUE} to sign in`, wait: true });
        const events = JSON.stringify(await call("runs.events", { runId: run.id }));
        expect(events).not.toContain(TOKEN_VALUE);
        expect(events).toContain("«secret:jira-token»");

        // Channel addresses are sealed at rest too.
        const channel = await call("channels.create", { name: "Sealed", kind: "webhook", webhookUrl: "https://example.test/hook/abcdef123456" });
        expect((foreman.store.db.prepare("SELECT webhook_url FROM channels WHERE id = ?").get(channel.id) as any).webhook_url).toMatch(/^enc:v1:/);
        await call("channels.delete", { channelId: channel.id });
    });

    it("signs in to Jira with a stored token, as Cloud and as Data Center", async () => {
        foreman.mockJira.requiredAuth = `Bearer ${TOKEN_VALUE}`;
        expect((await call("jira.test")).ok).toBe(false);
        expect((await rpc("work.sync")).body.error).toMatch(/401/);

        expect((await rpc("jira.configure", { auth: { type: "bearer", secretName: "missing" } })).status).toBe(400);
        expect((await rpc("jira.configure", { auth: { type: "basic", secretName: "jira-token" } })).status).toBe(400);
        const configured = await call("jira.configure", { flavor: "datacenter", auth: { type: "bearer", secretName: "jira-token" } });
        expect(JSON.stringify(configured)).not.toContain(TOKEN_VALUE);
        expect(await call("jira.test")).toMatchObject({ ok: true, detail: "Connected as Mock Jira User" });
        // Data Center: REST v2 with startAt paging.
        expect((await call("work.sync")).fetched).toBeGreaterThan(10);

        foreman.mockJira.requiredAuth = `Basic ${Buffer.from(`bot@example.test:${TOKEN_VALUE}`).toString("base64")}`;
        await call("jira.configure", { flavor: "cloud", auth: { type: "basic", email: "bot@example.test" } });
        expect((await call("jira.test")).ok).toBe(true);
        expect((await call("secrets.list")).secrets[0].usedBy).toEqual(["Jira connection"]);
    });

    it("writes progress back to the ticket and lets an agent ask a question", async () => {
        await call("jira.configure", { writeBack: { enabled: true, statusStarted: "In Progress", statusReview: "In Review", statusDone: "Done" } });
        const agent = (await call("agents.create", { name: "Asker", spec: { policy: { autonomy: "act" }, mock: { scenario: "asks-question" } } })).agent;
        const filed = await call("mockjira.create_issue", { summary: "Refund totals differ", project: "ASK" });
        const added = (await call("work.add", { keys: [filed.key] })).added[0];
        await call("work.assign", { itemId: added.id, agentId: agent.id });

        const waiting = await settle(filed.key, ["needs_you"]);
        expect(waiting.note).toMatch(/^Question: .*rounding|^Question: .*round/);
        expect(waiting.pendingApproval.kind).toBe("question");
        await waitFor(() => /needs information/.test(comments(filed.key)));
        expect(comments(filed.key)).toMatch(/Asker started on this ticket/);
        expect(issue(filed.key).fields.status.name).toBe("In Progress");
        expect((await call("notify.inbox", { limit: 50 })).entries.some((n: any) => n.kind === "question_asked")).toBe(true);

        // A question cannot be "approved" without an answer.
        expect((await rpc("approvals.decide", { approvalId: waiting.pendingApproval.id, decision: "approve" })).status).toBe(400);
        await call("work.answer", { itemId: filed.key, answer: "half-even, as finance does" });
        const done = await settle(filed.key, ["done"]);
        const run = (await call("runs.get", { runId: done.runId })).run;
        expect(run.output).toContain("half-even, as finance does");
        const steps = (await call("runs.timeline", { runId: done.runId })).steps;
        expect(steps.find((s: any) => s.title.startsWith("Question:")).detail).toBe("Answer: half-even, as finance does");
        await waitFor(() => issue(filed.key).fields.status.name === "Done");
        expect(comments(filed.key)).toMatch(/Asker finished this ticket/);
        expect((await call("work.get", { itemId: filed.key })).item.ticket.status).toBe("Done");
        expect((await call("jira.settings")).recentWriteBacks.some((w: any) => w.key === filed.key && w.action === "status" && w.ok)).toBe(true);
    });

    it("gives agents Jira tools that obey their guardrails", async () => {
        const spec = { tools: ["jira_get_issue", "jira_add_comment", "jira_create_subtask", "jira_transition"], policy: { autonomy: "act", rules: [{ match: "jira_transition", action: "ask" }] }, mock: { scenario: "jira-updates" } };
        const agent = (await call("agents.create", { name: "Planner", spec })).agent;
        const filed = await call("mockjira.create_issue", { summary: "Split the rework", project: "PLN" });
        const added = (await call("work.add", { keys: [filed.key] })).added[0];
        await call("work.assign", { itemId: added.id, agentId: agent.id });

        // Reading, commenting and creating subtasks are allowed; the status change waits for a person.
        const waiting = await settle(filed.key, ["needs_you"]);
        expect(waiting.pendingApproval.summary).toContain(`${filed.key} → In Review`);
        expect(foreman.mockJira.subtasks(filed.key)).toHaveLength(2);
        expect(comments(filed.key)).toMatch(/Plan: two subtasks/);
        await call("approvals.decide", { approvalId: waiting.pendingApproval.id, decision: "deny", reason: "leave the status to us" });
        const done = await settle(filed.key, ["done"]);
        const steps = (await call("runs.timeline", { runId: done.runId })).steps;
        expect(steps.find((s: any) => s.title === "jira_transition")).toMatchObject({ status: "error", detail: expect.stringContaining("Permission denied") });
        expect(steps.find((s: any) => s.title === "jira_get_issue").detail).toContain("Split the rework");

        // An agent without the Jira tools switched on cannot use them.
        const bare = (await call("agents.create", { name: "No Jira", spec: { policy: { autonomy: "full" }, mock: { scenario: "jira-updates" } } })).agent;
        const run = await call("runs.start", { agentId: bare.id, prompt: `Plan ${filed.key}`, wait: true });
        const refused = (await call("runs.timeline", { runId: run.id })).steps.filter((s: any) => s.kind === "tool");
        expect(refused.every((s: any) => s.status === "error" && /not switched on/.test(s.detail))).toBe(true);
        expect(foreman.mockJira.subtasks(filed.key)).toHaveLength(2);

        const page = await (await fetch(`${base}/mock/jira/browse/${filed.key}`)).text();
        expect(page).toContain("Subtasks");
        expect((await call("system.agent_tools")).map((t: any) => t.name)).toContain("ask_for_info");

        // Leave the shared server as the other suites expect it.
        foreman.mockJira.requiredAuth = null;
        await call("jira.configure", { auth: { type: "none" }, writeBack: { enabled: false } });
        await foreman.work.settled();
    });
});

describe("batches and flow", () => {
    const call = async (name: string, input: unknown = {}) => {
        const res = await rpc(name, input);
        if (res.status !== 200) throw new Error(`${name} → ${res.status}: ${res.body.error}`);
        return res.body.result;
    };
    const waitFor = async (check: () => Promise<boolean> | boolean, ms = 15000) => {
        const until = Date.now() + ms;
        while (!(await check())) {
            if (Date.now() > until) throw new Error("timed out waiting");
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    it("tracks a 40-ticket batch to the end and says so once", async () => {
        await call("jira.configure", { wipPerAgent: 4 });
        const agent = (await call("agents.create", { name: "Batch worker", spec: { policy: { autonomy: "act" }, mock: { scenario: "happy" } } })).agent;
        for (let i = 1; i <= 39; i++) foreman.mockJira.create({ project: "BAT", summary: `Batch ticket ${i}`, labels: [] });
        // One ticket fails for good, so the summary has something to report.
        const bad = foreman.mockJira.create({ project: "BAT", summary: "Batch ticket that fails", labels: ["mock:over-budget"] });

        expect((await rpc("batches.create", { name: "Empty" })).status).toBe(400);
        const created = await call("batches.create", { name: "Forty", jql: "project = BAT", agentId: agent.id });
        expect(created.ticketsAdded).toBe(40);
        expect(created.batch.progress.total).toBe(40);
        expect(await call("work.list", { batchId: created.batch.id })).toHaveLength(40);

        let batch: any;
        await waitFor(async () => (batch = (await call("batches.get", { batchId: created.batch.id })).batch).state === "complete");
        expect(batch.progress).toMatchObject({ total: 40, done: 39, failed: 1, queued: 0, working: 0, waiting: 0 });
        expect(batch.progress.credits).toBeGreaterThan(0);
        expect(batch.completedAt).toBeTruthy();
        const summaries = () => call("notify.inbox", { limit: 500 }).then((inbox: any) => inbox.entries.filter((n: any) => n.kind === "batch_done" && n.title.includes("Forty")));
        expect(await summaries()).toHaveLength(1);
        expect((await summaries())[0].title).toContain("39 of 40 done, 1 failed");

        // Retrying the failure reopens the batch; a new ticket joins on refresh.
        expect((await call("batches.retry_failed", { batchId: batch.id })).retried).toBe(1);
        foreman.mockJira.create({ project: "BAT", summary: "A late arrival", labels: [] });
        expect((await call("batches.refresh", { batchId: batch.id })).ticketsAdded).toBe(1);
        await waitFor(async () => (batch = (await call("batches.get", { batchId: batch.id })).batch).state === "complete");
        expect(batch.progress).toMatchObject({ total: 41, done: 40, failed: 1 });
        expect((await call("work.get", { itemId: bad.key })).item.batches[0].name).toBe("Forty");

        expect((await call("batches.delete", { batchId: batch.id })).deleted).toBe(true);
        expect((await rpc("batches.get", { batchId: batch.id })).status).toBe(404);
        expect((await call("work.get", { itemId: bad.key })).item.state).toBe("failed");
    });

    it("reports flow metrics and the agent timeline", async () => {
        const flow = await call("work.flow", { days: 7, hours: 1 });
        expect(flow.done).toBeGreaterThanOrEqual(40);
        expect(flow.throughput.at(-1).done).toBeGreaterThanOrEqual(40);
        expect(flow.throughput.length).toBeGreaterThanOrEqual(7);
        expect(flow.cycle.medianMs).toBeGreaterThanOrEqual(0);
        expect(flow.queueDepth).toHaveLength(49);
        const worker = flow.perAgent.find((a: any) => a.agentName === "Batch worker");
        expect(worker).toMatchObject({ failed: 1, wipLimit: 4 });
        expect(worker.done).toBeGreaterThanOrEqual(40);
        expect(worker.creditsPerTicket).toBeGreaterThan(0);
        expect(flow.neededPersonRate).toBeGreaterThan(0);
        expect(flow.cost.perTicket).toBeGreaterThan(0);

        const timeline = await call("work.timeline", { hours: 1 });
        const lane = timeline.lanes.find((l: any) => l.agentName === "Batch worker");
        expect(lane.runs.length).toBeGreaterThanOrEqual(41);
        expect(lane.runs[0]).toMatchObject({ kind: "work", key: expect.stringMatching(/^BAT-/) });
        const asker = timeline.lanes.find((l: any) => l.agentName === "Asker");
        expect(asker.runs[0].waits).toHaveLength(1);
    });
});

describe("webhook intake and your own model key", () => {
    const call = async (name: string, input: unknown = {}) => {
        const res = await rpc(name, input);
        if (res.status !== 200) throw new Error(`${name} → ${res.status}: ${res.body.error}`);
        return res.body.result;
    };
    const waitFor = async (check: () => Promise<boolean> | boolean, ms = 15000) => {
        const until = Date.now() + ms;
        while (!(await check())) {
            if (Date.now() > until) throw new Error("timed out waiting");
            await new Promise((r) => setTimeout(r, 25));
        }
    };

    it("picks a ticket up the moment Jira's webhook fires", async () => {
        // Polling is effectively off (an hour), so only the webhook can bring the ticket in.
        await call("jira.configure", { baseUrl: `${base}/mock/jira`, enabled: true, pollSeconds: 3600, jql: "labels = foreman AND status != Done" });
        const hook = await call("jira.webhook");
        const url = hook.url.replace("http://test", base);
        expect((await fetch(url.slice(0, -4) + "nope", { method: "POST" })).status).toBe(404);

        const filed = await call("mockjira.create_issue", { summary: "Arrives by webhook", project: "HOOK" });
        expect((await rpc("work.get", { itemId: filed.key })).status).toBe(404);
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ webhookEvent: "jira:issue_created", issue: { key: "EVIL-1" } }) });
        expect(res.status).toBe(202);
        await waitFor(async () => (await rpc("work.get", { itemId: filed.key })).status === 200);
        // The body named a ticket outside the filter; it is ignored.
        expect((await rpc("work.get", { itemId: "EVIL-1" })).status).toBe(404);
        expect((await call("jira.webhook")).received).toBeGreaterThanOrEqual(1);

        // The mock Jira can call the webhook itself, as a real site would.
        expect((await call("mockjira.webhooks", { enabled: true })).enabled).toBe(true);
        foreman.mockJira.webhookUrl = url; // the test server is not reachable at its configured public address
        const second = await call("mockjira.create_issue", { summary: "Arrives on its own", project: "HOOK" });
        await waitFor(async () => (await rpc("work.get", { itemId: second.key })).status === 200);

        // A new address replaces the old one.
        const rotated = await call("jira.rotate_webhook");
        expect(rotated.url).not.toBe(hook.url);
        expect((await fetch(url, { method: "POST" })).status).toBe(404);
        await call("mockjira.webhooks", { enabled: false });
        await call("jira.configure", { enabled: false });
    }, 30_000);

    it("runs the real Copilot runtime on a model endpoint of your own, behind the guardrails", async () => {
        const spec = { runtime: "copilot", model: "gpt-4o", provider: { type: "openai", baseUrl: `${base}/mock/model/v1` }, tools: ["jira_get_issue", "jira_add_comment"], policy: { autonomy: "act", rules: [{ match: "jira_add_comment", action: "deny" }] } };
        await call("jira.configure", { baseUrl: `${base}/mock/jira` });
        expect((await rpc("agents.create", { name: "No model named", spec: { ...spec, model: "auto" } })).status).toBe(400);
        const agent = (await call("agents.create", { name: "Own key", spec })).agent;
        const run = await call("runs.start", { agentId: agent.id, prompt: "Look at PAY-181 and note what you find.", waitSeconds: 90 });
        expect(run.error).toBeNull();
        expect(run.status).toBe("succeeded");
        expect(run.output).toContain("Mock model finished");
        expect(run.usage.modelCalls).toBeGreaterThanOrEqual(2);

        const steps = (await call("runs.timeline", { runId: run.id })).steps;
        // The runtime's own GitHub MCP server would act as this machine's GitHub user with no guardrail.
        expect(steps.some((s: any) => s.kind === "tool" && /github/i.test(s.title))).toBe(false);
        // The read was allowed and really reached (mock) Jira; the comment was stopped by the guardrail.
        expect(steps.find((s: any) => s.kind === "tool" && s.title === "jira_get_issue")).toMatchObject({ status: "ok", detail: expect.stringContaining("Partial refund") });
        expect(steps.find((s: any) => s.kind === "tool" && s.title === "jira_add_comment").status).toBe("error");
        expect(steps.some((s: any) => s.kind === "policy" && /Denied/.test(s.title))).toBe(true);
        expect(foreman.mockJira.get("PAY-181")!.fields.comment.comments).toHaveLength(0);
    }, 120_000);
});

describe("Teams bot", () => {
    const call = async (name: string, input: unknown = {}) => {
        const res = await rpc(name, input);
        if (res.status !== 200) throw new Error(`${name} → ${res.status}: ${res.body.error}`);
        return res.body.result;
    };
    const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> => {
        const until = Date.now() + ms;
        for (;;) {
            const value = await fn();
            if (value) return value;
            if (Date.now() > until) throw new Error("timed out waiting");
            await new Promise((r) => setTimeout(r, 25));
        }
    };
    const card = (message: any) => message.payload.attachments[0].content;
    const botCard = (conversationId: string, text: string) => waitFor(async () => (await call("mockteams.messages", { channelId: conversationId })).find((m: any) => m.via === "bot" && JSON.stringify(m.payload).includes(text)));

    it("checks every message Teams sends and will not turn on half set up", async () => {
        expect((await rpc("teamsbot.configure", { enabled: true })).status).toBe(400);
        // The test server is not at http://test; the mock has to call it where it really listens.
        foreman.mockBot.serverUrl = base;
        await call("teamsbot.configure", { enabled: true, mock: true });
        const post = (authorization?: string) =>
            fetch(`${base}/hooks/teams/messages`, { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ type: "conversationUpdate", serviceUrl: "https://evil.example/", conversation: { id: "19:evil" } }) });
        expect((await post()).status).toBe(401);
        expect((await post("Bearer e30.e30.c2ln")).status).toBe(401);
        // An unverified message never becomes a place the bot sends its token to.
        expect((await call("teamsbot.status")).conversations).toHaveLength(0);
    });

    it("approves, denies and answers from a card, as the Teams user", async () => {
        const conversation = await call("mockteams.install", { team: "Payments", channel: "Approvals" });
        expect((await call("teamsbot.status")).conversations.map((c: any) => c.name)).toContain("Payments › Approvals");
        const channel = await call("channels.create", { name: "Payments approvals", kind: "teams_bot", conversationId: conversation.id });
        expect(channel.address).toBe("Bot · Payments › Approvals");
        await call("notifyrules.create", { name: "Decide in Teams", events: ["approval_needed", "question_asked"], channelId: channel.id });

        const pusher = (await call("agents.create", { name: "Bot pusher", spec: { policy: { autonomy: "act" }, mock: { scenario: "needs-approval" } } })).agent;
        const run = await call("runs.start", { agentId: pusher.id, prompt: "Ship it", waitSeconds: 10 });
        expect(run.status).toBe("waiting_approval");
        const message = await botCard(conversation.id, "Bot pusher");
        expect(card(message).actions.map((a: any) => a.title)).toEqual(["Approve", "Deny", "Open in Foreman"]);

        // Someone who is not on the approver list is turned away and the card stays as it is.
        await call("teamsbot.configure", { approvers: ["11111111-2222-3333-4444-555555555555"] });
        expect(await call("mockteams.press", { messageId: message.id, verb: "approve" })).toMatchObject({ updated: false, message: expect.stringContaining("not on Foreman's list") });
        await call("teamsbot.configure", { approvers: [] });

        expect(await call("mockteams.press", { messageId: message.id, verb: "approve", userName: "Megan Bowen" })).toEqual({ updated: true });
        await waitFor(async () => (await call("runs.get", { runId: run.id })).run.status === "succeeded");
        const [approval] = await call("approvals.list", { runId: run.id, status: "approved" });
        expect(approval.decidedBy).toMatch(/^teams:Megan Bowen · /);
        expect((await call("audit.list", { limit: 50 })).some((e: any) => e.capability === "approvals.decide" && e.actor.startsWith("teams:Megan Bowen"))).toBe(true);
        const decided = card((await call("mockteams.messages", { channelId: conversation.id })).find((m: any) => m.id === message.id));
        expect(JSON.stringify(decided)).toContain("Approved by Megan Bowen");
        expect(decided.actions.some((a: any) => a.type === "Action.Execute")).toBe(false);
        expect((await rpc("mockteams.press", { messageId: message.id, verb: "deny" })).status).toBe(409);
        // The press carried no channel name; the one learned at install is kept.
        expect((await call("teamsbot.status")).conversations.find((c: any) => c.id === conversation.id).name).toBe("Payments › Approvals");

        // Decided in Foreman instead: the card in Teams is updated to match.
        const second = await call("runs.start", { agentId: pusher.id, prompt: "Ship it again", waitSeconds: 10 });
        const [pending] = await call("approvals.list", { runId: second.id });
        const other = await waitFor(async () => (await call("mockteams.messages", { channelId: conversation.id })).find((m: any) => m.id !== message.id && JSON.stringify(m.payload).includes("Approve") && m.ts >= approval.decidedAt));
        await call("approvals.decide", { approvalId: pending.id, decision: "deny" });
        await waitFor(async () => JSON.stringify((await call("mockteams.messages", { channelId: conversation.id })).find((m: any) => m.id === other.id).payload).includes("Denied by someone in Foreman"));

        // A question gets an answer box; the answer reaches the waiting agent.
        const asker = (await call("agents.create", { name: "Bot asker", spec: { policy: { autonomy: "act" }, mock: { scenario: "asks-question" } } })).agent;
        const asked = await call("runs.start", { agentId: asker.id, prompt: "Settle the rounding rule", waitSeconds: 10 });
        expect(asked.status).toBe("waiting_approval");
        const question = await botCard(conversation.id, "Bot asker");
        expect(card(question).body.some((el: any) => el.type === "Input.Text")).toBe(true);
        expect(await call("mockteams.press", { messageId: question.id, verb: "answer", answer: "  " })).toMatchObject({ updated: false, message: "Write an answer first." });
        expect(await call("mockteams.press", { messageId: question.id, verb: "answer", answer: "half-even", userName: "Megan Bowen" })).toEqual({ updated: true });
        const answered = await waitFor(async () => {
            const r = (await call("runs.get", { runId: asked.id })).run;
            return r.status === "succeeded" ? r : undefined;
        });
        expect(answered.output).toContain("half-even");

        await call("channels.delete", { channelId: channel.id });
        await call("teamsbot.configure", { enabled: false });
    });
});
