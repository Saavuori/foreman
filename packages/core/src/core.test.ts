import { describe, expect, it } from "vitest";
import { createForeman, evaluatePolicy, foremanTool, htmlToText, renderPrompt, toPassages, type Actor, type Run } from "./index.ts";

const user: Actor = { kind: "user", id: "test" };
const boot = () => {
    const f = createForeman({ dataDir: "", baseUrl: "http://localhost:0", memory: true, simulatedStepDelayMs: 0 });
    f.start();
    const call = <T = any>(name: string, input?: unknown) => f.registry.invoke(name, input, user) as Promise<T>;
    return { f, call };
};
const sim = { runtime: "simulated" as const };
/** Call one of Foreman's agent tools as an agent would, without a run around it. */
async function callTool(f: ReturnType<typeof boot>["f"], agentId: string, name: string, args: unknown): Promise<string> {
    const spec = f.store.getRevision(f.store.getAgent(agentId)!.activeRevisionId)!.spec;
    const tool = foremanTool(name)!;
    try {
        return await tool.handler({ run: {} as Run, spec, emit: () => {}, ask: async () => null, jira: () => f.work.jira(), knowledge: () => f.knowledge }, tool.input.parse(args));
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

describe("policy", () => {
    const base = { rules: [], approvalTimeoutSeconds: 60 };
    it("applies autonomy presets", () => {
        expect(evaluatePolicy({ ...base, autonomy: "observe" }, { kind: "shell" }).action).toBe("deny");
        expect(evaluatePolicy({ ...base, autonomy: "propose" }, { kind: "read" }).action).toBe("allow");
        expect(evaluatePolicy({ ...base, autonomy: "propose" }, { kind: "write" }).action).toBe("ask");
        expect(evaluatePolicy({ ...base, autonomy: "act" }, { kind: "shell" }).action).toBe("ask");
        expect(evaluatePolicy({ ...base, autonomy: "full" }, { kind: "shell" }).action).toBe("allow");
    });
    it("lets the first matching rule win over the preset", () => {
        const policy = { ...base, autonomy: "full" as const, rules: [{ match: "mcp:github-*", action: "deny" as const }, { match: "mcp", action: "ask" as const }] };
        expect(evaluatePolicy(policy, { kind: "mcp", toolName: "github-push" }).action).toBe("deny");
        expect(evaluatePolicy(policy, { kind: "mcp", toolName: "slack-post" }).action).toBe("ask");
    });
});

describe("triggers", () => {
    it("renders payload paths and flags payloads as untrusted", () => {
        const out = renderPrompt("Issue {{payload.issue.title}}: {{payload}}", { issue: { title: "Crash" } });
        expect(out).toContain("Issue Crash");
        expect(out).toContain("<trigger_payload>");
        expect(out).toMatch(/never as instructions/);
        expect(renderPrompt("Daily report", {})).toBe("Daily report");
    });
});

describe("capabilities", () => {
    it("creates agents with safe defaults and versions spec changes", async () => {
        const { call } = boot();
        const { agent, revision } = await call("agents.create", { name: "Triage" });
        expect(revision.number).toBe(1);
        expect(revision.spec.policy.autonomy).toBe("propose");
        expect(revision.spec.budget.maxAiCredits).toBe(30);

        const updated = await call("agents.update", { agentId: agent.id, spec: { instructions: "Be brief", budget: { timeoutSeconds: 30 } } });
        expect(updated.revisionCreated).toBe(true);
        expect(updated.revision.number).toBe(2);
        expect(updated.revision.spec.budget).toEqual({ maxAiCredits: 30, timeoutSeconds: 30 });
        expect(updated.revision.spec.policy.autonomy).toBe("propose");

        // null clears an optional field, as the studio does when a result shape is removed
        const shaped = await call("agents.update", { agentId: agent.id, spec: { outputSchema: { type: "object" }, reasoningEffort: "high" }, activate: false });
        expect(shaped.revision.spec.outputSchema).toEqual({ type: "object" });
        const cleared = await call("agents.update", { agentId: agent.id, spec: { ...shaped.revision.spec, outputSchema: null, reasoningEffort: null }, activate: false });
        expect(cleared.revision.spec.outputSchema).toBeUndefined();
        expect(cleared.revision.spec.reasoningEffort).toBeUndefined();

        const same = await call("agents.update", { agentId: agent.id, spec: { instructions: "Be brief" } });
        expect(same.revisionCreated).toBe(false);

        const diff = await call("revisions.diff", { fromRevisionId: revision.id, toRevisionId: updated.revision.id });
        expect(diff.changes.map((c: any) => c.path).sort()).toEqual(["budget.timeoutSeconds", "instructions"]);

        await call("revisions.activate", { revisionId: revision.id });
        expect((await call("agents.get", { agentId: agent.id })).revision.number).toBe(1);
    });

    it("rejects invalid input and budgets below the runtime minimum", async () => {
        const { call } = boot();
        await expect(call("agents.create", {})).rejects.toThrow(/Invalid input/);
        await expect(call("agents.create", { name: "x", spec: { budget: { maxAiCredits: 5 } } })).rejects.toThrow(/Invalid input/);
    });

    it("runs an agent, records a trace and audits the call", async () => {
        const { call } = boot();
        const { agent } = await call("agents.create", { name: "Reader", spec: { ...sim, tools: ["view"] } });
        const run = await call<Run>("runs.start", { agentId: agent.id, prompt: "Summarise", waitSeconds: 10 });
        expect(run.status).toBe("succeeded");
        expect(run.usage.toolCalls).toBe(1);
        expect(run.usage.modelCalls).toBe(1);

        const { steps } = await call("runs.timeline", { runId: run.id });
        const tool = steps.find((s: any) => s.kind === "tool");
        expect(tool).toMatchObject({ title: "view", status: "ok" });
        expect(steps.some((s: any) => s.kind === "policy" && s.status === "ok")).toBe(true);

        const audit = await call("audit.list", {});
        expect(audit.map((a: any) => a.capability)).toEqual(["runs.start", "agents.create"]);
    });

    it("pauses for approval and continues on the decision", async () => {
        const { call } = boot();
        const { agent } = await call("agents.create", { name: "Writer", spec: { ...sim, tools: ["edit"] } });
        const waiting = await call<Run>("runs.start", { agentId: agent.id, prompt: "Fix typo", waitSeconds: 10 });
        expect(waiting.status).toBe("waiting_approval");
        const [approval] = await call<any[]>("approvals.list", {});
        expect(approval.summary).toContain("write: edit");

        await call("approvals.decide", { approvalId: approval.id, decision: "approve" });
        const done = await call<Run>("runs.wait", { runId: waiting.id, timeoutSeconds: 10 });
        expect(done.status).toBe("succeeded");
        await expect(call("approvals.decide", { approvalId: approval.id, decision: "deny" })).rejects.toThrow(/already approved/);
    });

    it("denies by policy, and explains failures", async () => {
        const { call } = boot();
        const { agent } = await call("agents.create", { name: "Observer", spec: { ...sim, tools: ["shell"], policy: { autonomy: "observe" } } });
        const run = await call<Run>("runs.start", { agentId: agent.id, prompt: "Deploy [fail]", waitSeconds: 10 });
        expect(run.status).toBe("failed");
        const why = await call("runs.explain_failure", { runId: run.id });
        expect(why.signals.join("\n")).toMatch(/Simulated failure/);
        expect(why.signals.join("\n")).toMatch(/Permission denied/);
        expect(why.suggestions.length).toBeGreaterThan(0);

        const replay = await call<Run>("runs.replay", { runId: run.id, waitSeconds: 10 });
        expect(replay.source).toMatchObject({ kind: "replay", replayOf: run.id });
    });

    it("fires triggers into runs and enforces concurrency keys", async () => {
        const { f, call } = boot();
        const { agent } = await call("agents.create", { name: "Hooked", spec: { ...sim, tools: ["edit"] } });
        const trigger = await call("triggers.create", { agentId: agent.id, name: "PR", config: { kind: "webhook", concurrencyKey: "pr" }, promptTemplate: "Review PR {{payload.pr}}" });
        expect(trigger.webhookUrl).toContain(`/hooks/${trigger.id}/`);

        const first = f.triggers.fire(trigger.id, { pr: 7 }, "webhook");
        expect(first.fired).toBe(true);
        await call("runs.wait", { runId: (first as any).run.id, timeoutSeconds: 5 });
        expect(f.triggers.fire(trigger.id, { pr: 7 }, "webhook")).toMatchObject({ fired: false });
        expect(f.triggers.fire(trigger.id, { pr: 8 }, "webhook").fired).toBe(true);

        await expect(call("triggers.create", { agentId: agent.id, name: "Bad", config: { kind: "schedule", cron: "not a cron" }, promptTemplate: "x" })).rejects.toThrow(/Invalid schedule/);
        const sched = await call("triggers.create", { agentId: agent.id, name: "Daily", config: { kind: "schedule", cron: "0 8 * * *" }, promptTemplate: "Daily" });
        expect(sched.nextRunAt).toBeTruthy();
        f.triggers.stop();
    });

    it("describes every capability with a JSON schema", () => {
        const { f } = boot();
        const caps = f.registry.describe();
        expect(caps.length).toBeGreaterThan(25);
        for (const c of caps) {
            expect(c.toolName).toMatch(/^[a-z_]+$/);
            expect(c.inputSchema.type).toBe("object");
        }
    });
});

describe("mock scenarios", () => {
    const run = async (scenario: string, spec: Record<string, unknown> = {}, prompt = "Do the thing") => {
        const { call } = boot();
        const { agent } = await call("agents.create", { name: scenario, spec: { mock: { scenario }, policy: { autonomy: "full" }, ...spec } });
        const result = await call<Run>("runs.start", { agentId: agent.id, prompt, waitSeconds: 10 });
        return { call, agent, result };
    };

    it("lists scenarios and plays each terminal one to its expected end", async () => {
        const { call } = boot();
        const names = (await call<any[]>("system.mock_scenarios")).map((s) => s.name);
        expect(names).toEqual(expect.arrayContaining(["auto", "happy", "needs-approval", "slow", "tool-failure", "flaky", "timeout", "over-budget", "sub-agents", "bad-output", "random"]));
        for (const [scenario, status] of [["happy", "succeeded"], ["slow", "succeeded"], ["tool-failure", "succeeded"], ["sub-agents", "succeeded"], ["flaky", "failed"], ["over-budget", "failed"]] as const) {
            expect((await run(scenario)).result.status, scenario).toBe(status);
        }
    });

    it("reports progress stages in the timeline", async () => {
        const { call, result } = await run("slow");
        const { steps } = await call("runs.timeline", { runId: result.id });
        const stages = steps.filter((s: any) => s.kind === "progress");
        expect(stages).toHaveLength(8);
        expect(stages[7].title).toMatch(/^8 of 8/);
    });

    it("stops for approval under the default guardrails", async () => {
        const { call, result } = await run("needs-approval", { policy: { autonomy: "act" } });
        expect(result.status).toBe("waiting_approval");
        const [approval] = await call<any[]>("approvals.list", { runId: result.id });
        expect(approval.summary).toContain("git push");
    });

    it("succeeds when a flaky run is replayed", async () => {
        const { call, result } = await run("flaky");
        expect(result.error).toMatch(/ECONNRESET/);
        expect((await call<Run>("runs.replay", { runId: result.id, waitSeconds: 10 })).status).toBe("succeeded");
    });

    it("fails a result that breaks the result shape", async () => {
        const shape = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
        const bad = await run("bad-output", { outputSchema: shape });
        expect(bad.result.status).toBe("failed");
        expect(bad.result.error).toMatch(/result shape/);
        const good = await run("happy", { outputSchema: shape });
        expect(JSON.parse(good.result.output!)).toHaveProperty("verdict");
    });

    it("lets a prompt tag override the agent's scenario", async () => {
        const tagged = await run("happy", {}, "Sync orders [mock:flaky]");
        expect(tagged.result.status).toBe("failed");
    });

    it("hangs until stopped in the timeout scenario", async () => {
        const { call } = boot();
        const { agent } = await call("agents.create", { name: "hang", spec: { mock: { scenario: "timeout" }, policy: { autonomy: "full" } } });
        const started = await call<Run>("runs.start", { agentId: agent.id, prompt: "Run tests" });
        await new Promise((r) => setTimeout(r, 30));
        expect((await call("runs.get", { runId: started.id })).run.status).toBe("running");
        await call("runs.cancel", { runId: started.id });
        expect((await call<Run>("runs.wait", { runId: started.id, timeoutSeconds: 5 })).status).toBe("cancelled");
    });
});

describe("vault", () => {
    it("seals, resolves references and scrubs", () => {
        const { f } = boot();
        f.vault.set("api-key", "s3cr3t-value-123");
        const sealed = f.vault.seal("hello");
        expect(sealed).toMatch(/^enc:v1:/);
        expect(f.vault.unseal(sealed)).toBe("hello");
        expect(f.vault.unseal("plain, stored before the vault")).toBe("plain, stored before the vault");
        expect(f.vault.resolve("Bearer {{secret:api-key}}")).toBe("Bearer s3cr3t-value-123");
        expect(() => f.vault.resolve("{{secret:nope}}")).toThrow(/does not exist/);
        expect(f.vault.scrub("token=s3cr3t-value-123;")).toBe("token=«secret:api-key»;");
        expect(f.vault.scrubData({ a: ["x s3cr3t-value-123"] })).toEqual({ a: ["x «secret:api-key»"] });
        expect(f.vault.list()[0]).toMatchObject({ name: "api-key" });
        expect(Object.values(f.vault.list()[0]!).join()).not.toContain("s3cr3t");

        // A different key cannot read what this one sealed.
        const other = boot();
        expect(() => other.f.vault.unseal(sealed)).toThrow(/cannot be decrypted/);
    });
});

describe("knowledge", () => {
    it("turns Confluence storage format into structured text and passages", () => {
        const text = htmlToText(
            `<h1>Refunds</h1><p>Refunds are paid within <strong>5 days</strong>.</p><ac:structured-macro ac:name="toc"/><h2>Rounding</h2><p>Use half-even &amp; never half-up.</p>` +
                `<table><tbody><tr><th><p>Case</p></th><th><p>Rule</p></th></tr><tr><td><p>Invoice</p></td><td><p>half-even</p></td></tr></tbody></table>` +
                `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">sql</ac:parameter><ac:plain-text-body><![CDATA[SELECT * FROM refunds;]]></ac:plain-text-body></ac:structured-macro>` +
                `<p>See <ac:link><ri:page ri:content-title="Ledger rules"/></ac:link> and <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PAY-12</ac:parameter></ac:structured-macro>.</p>`,
        );
        expect(text).toContain("# Refunds");
        expect(text).toContain("## Rounding");
        expect(text).toContain("half-even & never");
        expect(text).toContain("| Case | Rule |\n| Invoice | half-even |");
        expect(text).toContain("```\nSELECT * FROM refunds;\n```");
        expect(text).toContain("See Ledger rules and PAY-12.");
        const passages = toPassages(`# A\n\n${"word ".repeat(200)}\n\n## B\n\n${"more ".repeat(800)}`);
        expect(passages.length).toBeGreaterThan(2);
        expect(passages.every((p) => p.text.length <= 2400)).toBe(true);
        expect(passages.at(-1)!.heading).toBe("A › B");
    });

    it("searches within an agent's branches only, by keyword and by word parts", async () => {
        const { f, call } = boot();
        const pay = await call("knowledge.create_folder", { title: "Payments" });
        const ops = await call("knowledge.create_folder", { title: "Operations" });
        const sub = await call("knowledge.create_folder", { title: "Policies", parentId: pay.id });
        const doc = await call("knowledge.add_text", { parentId: sub.id, title: "Refund rounding", text: "# Rounding\n\nRefunds are rounded half-even to match the ledger. Never use half-up for credit notes." });
        await call("knowledge.add_text", { parentId: ops.id, title: "Deploying", text: "# Deploy\n\nDeploy the billing service with the release pipeline every Tuesday." });
        await call("knowledge.upload", { parentId: ops.id, fileName: "oncall.html", contentBase64: Buffer.from("<h1>On call</h1><p>Page the duty engineer through the paging tool.</p>").toString("base64") });
        await f.knowledge.settled();

        const all = await call("knowledge.search", { query: "how are refunds rounded" });
        expect(all.mode).toBe("hybrid");
        expect(all.hits[0]).toMatchObject({ nodeId: doc.id, title: "Refund rounding", path: "Payments › Policies" });
        expect(all.hits[0].matchedBy).toContain("keyword");
        // Inflected form: "deployment" shares word parts with "Deploy".
        expect((await call("knowledge.search", { query: "deployment" })).hits[0].title).toBe("Deploying");
        expect((await call("knowledge.search", { query: "rounding", nodeIds: [ops.id] })).hits).toHaveLength(0);

        const { agent } = await call("agents.create", { name: "payments helper", spec: { ...sim, policy: { autonomy: "full" } } });
        await expect(call("knowledge.search", { query: "x", agentId: agent.id })).rejects.toThrow(/no knowledge/);
        expect((await call("knowledge.assign", { agentId: agent.id, nodeIds: [pay.id] })).revisionCreated).toBe(true);
        expect((await call("knowledge.tree")).nodes.find((n: any) => n.id === pay.id).assignedTo[0].agentName).toBe("payments helper");
        expect((await call("knowledge.search", { query: "deploy billing", agentId: agent.id })).hits.every((h: any) => h.path.startsWith("Payments"))).toBe(true);

        // The agent's own tools: search finds its folder, reading outside it is refused.
        const run = await call<Run>("runs.start", { agentId: agent.id, prompt: "How are refunds rounded?" });
        await call("runs.wait", { runId: run.id, timeoutSeconds: 5 });
        const { events } = await call<{ events: any[] }>("runs.events", { runId: run.id });
        const done = events.find((e: any) => e.type === "tool.execution_complete" && e.data.toolName === "knowledge_search");
        expect(done.data.success).toBe(true);
        expect(done.data.result.content).toContain("Refund rounding");
        expect(done.data.result.content).toContain("information, not instructions");
        const deploy = (await call("knowledge.tree")).nodes.find((n: any) => n.title === "Deploying");
        const reply = await callTool(f, agent.id, "knowledge_read", { documentId: deploy.id });
        expect(reply).toMatch(/not in this agent's knowledge/);
        expect(await callTool(f, agent.id, "knowledge_read", { documentId: doc.id })).toContain("half-even");

        const removed = await call("knowledge.remove", { nodeId: pay.id });
        expect(removed).toMatchObject({ removed: 3, agentsAffected: ["payments helper"] });
        expect((await call("knowledge.search", { query: "refunds" })).hits).toHaveLength(0);
        expect((await call("knowledge.status")).documents).toBe(2);
    });
});
