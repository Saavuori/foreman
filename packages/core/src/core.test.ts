import { describe, expect, it } from "vitest";
import { createForeman, evaluatePolicy, renderPrompt, type Actor, type Run } from "./index.ts";

const user: Actor = { kind: "user", id: "test" };
const boot = () => {
    const f = createForeman({ dataDir: "", baseUrl: "http://localhost:0", memory: true, simulatedStepDelayMs: 0 });
    f.start();
    const call = <T = any>(name: string, input?: unknown) => f.registry.invoke(name, input, user) as Promise<T>;
    return { f, call };
};
const sim = { runtime: "simulated" as const };

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

describe("getting started", () => {
    const step = (status: any, id: string) => status.steps.find((s: any) => s.id === id);

    it("ticks each step off from what is really set up", async () => {
        const { f, call } = boot();
        let status = await call("setup.status");
        expect(status).toMatchObject({ requiredDone: 0, requiredTotal: 4, next: "agent", hidden: false, samples: null });

        const templates = await call<any[]>("agents.templates");
        expect(templates.length).toBeGreaterThanOrEqual(4);
        for (const t of templates) expect(t.spec).toMatchObject({ runtime: "simulated", policy: { autonomy: "propose" } });
        const summary = templates.find((t) => t.id === "ticket-summary")!;
        const { agent } = await call("agents.create", { name: summary.name, description: summary.description, spec: summary.spec });
        status = await call("setup.status");
        expect(step(status, "agent").done).toBe(true);
        expect(status.next).toBe("run");
        expect(step(status, "run").path).toBe(`/agents/${agent.id}`);

        // The example task names a real practice ticket, and a template's first run stops to ask before it writes.
        const example = await call("agents.example_task", { agentId: agent.id });
        expect(example.ticketKey).toMatch(/^[A-Z]+-\d+$/);
        expect(example.prompt).toContain(example.ticketKey);
        const run = await call<Run>("runs.start", { agentId: agent.id, prompt: example.prompt, waitSeconds: 10 });
        expect(run.status).toBe("waiting_approval");
        status = await call("setup.status");
        expect(status.next).toBe("intake");

        await call("jira.configure", { enabled: true });
        await call("routing.create", { name: "All tickets", agentId: agent.id });
        status = await call("setup.status");
        expect(status).toMatchObject({ requiredDone: 4, next: null });
        expect(step(status, "model").done).toBe(false);

        // The first call from an MCP client ticks the MCP step.
        await f.registry.invoke("system.info", {}, { kind: "mcp", id: "test-client" });
        expect(step(await call("setup.status"), "mcp").done).toBe(true);

        await call("setup.hide", { hidden: true });
        expect((await call("setup.status")).hidden).toBe(true);
        await f.stop();
    });

    it("loads sample data that does not count as done, and removes it again", async () => {
        const { f, call } = boot();
        const loaded = await call("samples.load");
        expect(loaded).toMatchObject({ agents: 9, intakeSwitchedOn: true });
        await expect(call("samples.load")).rejects.toThrow(/already loaded/);
        expect((await call<any[]>("agents.list")).length).toBe(9);
        expect((await call<any[]>("routing.list")).length).toBe(loaded.rules);

        let status = await call("setup.status");
        expect(status).toMatchObject({ requiredDone: 0, next: "agent", samples: { agents: 9 } });
        expect(step(status, "notify").done).toBe(false);

        const { agent } = await call("agents.create", { name: "Mine", spec: sim });
        await call("samples.remove");
        expect((await call<any[]>("agents.list")).map((a) => a.name)).toEqual(["Mine"]);
        expect(await call<any[]>("routing.list")).toEqual([]);
        expect(await call<any[]>("channels.list")).toEqual([]);
        expect((await call("jira.settings")).enabled).toBe(false);
        status = await call("setup.status");
        expect(status.samples).toBeNull();
        expect(step(status, "run").path).toBe(`/agents/${agent.id}`);
        await expect(call("samples.remove")).rejects.toThrow(/No sample data/);
        await f.stop();
    });
});

describe("power platform", () => {
    const base = { rules: [], approvalTimeoutSeconds: 60 };
    const sub = (targets: string[]) => ({ kind: "destructive", toolName: "pp_env_reset", targets });

    it("matches rules against the environment, and never lets a preset destroy", () => {
        expect(evaluatePolicy({ ...base, autonomy: "act" }, sub(["sandbox"])).action).toBe("deny");
        expect(evaluatePolicy({ ...base, autonomy: "full" }, sub(["sandbox"])).action).toBe("allow");
        const policy = { ...base, autonomy: "full" as const, rules: [{ match: "*@production", action: "deny" as const }, { match: "pp_env_reset@sandbox", action: "ask" as const }, { match: "destructive@group:HR", action: "allow" as const }] };
        expect(evaluatePolicy(policy, sub(["production", "group:Finance"])).action).toBe("deny");
        expect(evaluatePolicy(policy, sub(["sandbox", "group:HR"])).action).toBe("ask");
        expect(evaluatePolicy(policy, sub(["developer", "group:HR"])).action).toBe("allow");
        // A plain pattern still applies whatever the target, and "*" does not swallow the targeted forms.
        expect(evaluatePolicy({ ...policy, rules: [{ match: "pp_env_reset", action: "ask" }] }, sub(["production"])).action).toBe("ask");
        expect(evaluatePolicy({ ...base, autonomy: "act", rules: [{ match: "*@sandbox", action: "allow" }] }, { kind: "custom-tool", toolName: "x" }).action).toBe("allow");
    });

    const agent = async (call: ReturnType<typeof boot>["call"], spec: Record<string, unknown>) => (await call("agents.create", { name: `pp ${Math.random()}`, spec: { ...sim, ...spec } })).agent;

    it("reads the practice tenant with the reader identity only", async () => {
        const { f, call } = boot();
        const template = (await call<any[]>("agents.templates")).find((t) => t.id === "pp-governance-report")!;
        const a = await agent(call, template.spec);
        f.powerPlatform.mock.calls.length = 0;
        const run = await call<Run>("runs.start", { agentId: a.id, prompt: "Weekly report", waitSeconds: 10 });
        expect(run.status).toBe("succeeded");
        const { steps } = await call("runs.timeline", { runId: run.id });
        expect(steps.filter((s: any) => s.kind === "tool" && s.status === "ok").length).toBeGreaterThanOrEqual(5);
        const signedBy = new Set(f.powerPlatform.mock.calls.filter((c) => c.clientId).map((c) => c.clientId));
        expect([...signedBy]).toEqual(["mock-reader"]);
        const settings = await call("powerplatform.settings");
        expect(settings).toMatchObject({ usingPracticeTenant: true, identities: { reader: { ok: true }, operator: { ok: true } } });
        expect(settings.agents.find((x: any) => x.agentId === a.id)).toMatchObject({ connection: "reader", canChange: false });
        await f.stop();
    });

    it("asks before giving a role, names it plainly, and never gives System Administrator", async () => {
        const { f, call } = boot();
        const template = (await call<any[]>("agents.templates")).find((t) => t.id === "pp-access-request")!;
        const a = await agent(call, template.spec);
        const carla = () => f.powerPlatform.mock.find("HR Dev")!.users.find((u) => u.domainname === "carla.ruiz@contoso.test")!;
        expect(carla().roles).toEqual([]);

        const example = await call("agents.example_task", { agentId: a.id });
        const run = await call<Run>("runs.start", { agentId: a.id, prompt: example.prompt, waitSeconds: 10 });
        expect(run.status).toBe("waiting_approval");
        const [approval] = await call<any[]>("approvals.list", { runId: run.id });
        expect(approval.summary).toBe("Power Platform: give a security role — Give Carla Ruiz (carla.ruiz@contoso.test) the role Environment Maker in HR Dev (sandbox, group HR)");
        expect((approval.request as any).targets).toEqual(expect.arrayContaining(["sandbox", "group:HR", "role:Environment Maker"]));
        expect(carla().roles).toEqual([]);
        await call("approvals.decide", { approvalId: approval.id, decision: "approve" });
        expect((await call<Run>("runs.wait", { runId: run.id, timeoutSeconds: 10 })).status).toBe("succeeded");
        expect(carla().roles).toEqual(["Environment Maker"]);
        expect(f.powerPlatform.mock.calls.some((c) => c.method === "POST" && c.path.includes("systemuserroles_association") && c.clientId === "mock-operator")).toBe(true);

        const sysadmin = await call<Run>("runs.start", { agentId: a.id, prompt: "User: carla.ruiz@contoso.test\nEnvironment: HR Dev\nRole: System Administrator", waitSeconds: 10 });
        expect(sysadmin.status).toBe("succeeded");
        const explained = await call("runs.timeline", { runId: sysadmin.id });
        expect(JSON.stringify(explained)).toMatch(/pp_access_grant@role:System Administrator/);
        expect(carla().roles).not.toContain("System Administrator");
        await f.stop();
    });

    it("refuses changes to protected environments and to agents on the read-only connection", async () => {
        const { f, call } = boot();
        const template = (await call<any[]>("agents.templates")).find((t) => t.id === "pp-maintenance")!;
        const maint = await agent(call, { ...template.spec, policy: { autonomy: "act", rules: [{ match: "pp_env_reset@sandbox", action: "allow" }] } });
        const prod = f.powerPlatform.mock.find("Finance Production")!;
        const before = prod.users.length;
        const run = await call<Run>("runs.start", { agentId: maint.id, prompt: "Environment: Finance Production", waitSeconds: 10 });
        expect(run.status).toBe("succeeded");
        const events = await call("runs.events", { runId: run.id, limit: 500 });
        const reset = events.events.find((e: any) => e.type === "tool.execution_complete" && e.data.toolName === "pp_env_reset");
        expect(reset.data.error.message).toMatch(/^Refused: Finance Production is a production environment/);
        expect(await call<any[]>("approvals.list", { runId: run.id })).toEqual([]);
        expect(prod.users.length).toBe(before);
        // The backup ran: it changes nothing in the environment, so protection allows it.
        expect(prod.backups[0]!.label).toMatch(/Simulated backup/);

        // A person can protect any environment by name; the same sandbox reset is then refused.
        await call("powerplatform.protect", { environment: "HR Dev" });
        const hr = await call<Run>("runs.start", { agentId: maint.id, prompt: "Environment: HR Dev", waitSeconds: 10 });
        expect(JSON.stringify(await call("runs.events", { runId: hr.id, limit: 500 }))).toMatch(/Refused: HR Dev is on the list of protected environments/);
        await call("powerplatform.protect", { environment: "HR Dev", protected: false });
        const hr2 = await call<Run>("runs.start", { agentId: maint.id, prompt: "Environment: HR Dev", waitSeconds: 10 });
        expect(JSON.stringify(await call("runs.events", { runId: hr2.id, limit: 500 }))).toMatch(/Reset HR Dev: done/);

        const reader = await agent(call, { tools: ["pp_env_create"], policy: { autonomy: "full" }, mock: { scenario: "pp-environment-request" } });
        const refused = await call<Run>("runs.start", { agentId: reader.id, prompt: "Name: Should Not Exist", waitSeconds: 10 });
        expect(JSON.stringify(await call("runs.events", { runId: refused.id, limit: 500 }))).toMatch(/read-only Power Platform connection/);
        expect(f.powerPlatform.mock.find("Should Not Exist")).toBeUndefined();
        await f.stop();
    });

    it("creates an environment, follows long operations and validates its settings", async () => {
        const { f, call } = boot();
        const creator = await agent(call, { tools: ["pp_env_list", "pp_env_create"], powerPlatform: { connection: "operator" }, policy: { autonomy: "act" }, mock: { scenario: "pp-environment-request" } });
        const run = await call<Run>("runs.start", { agentId: creator.id, prompt: "Name: Atlas Dev\nEnvironment type: Sandbox\nGroup: Sandboxes", waitSeconds: 10 });
        expect(run.status).toBe("succeeded");
        const listed = await call("powerplatform.environments");
        expect(listed.environments.find((e: any) => e.displayName === "Atlas Dev")).toMatchObject({ type: "Sandbox", groupName: "Sandboxes", protected: null });
        // Asking for a group that does not exist fails before anyone is asked, with the groups that do.
        const bad = await call<Run>("runs.start", { agentId: creator.id, prompt: "Name: Nowhere\nGroup: Marketing", waitSeconds: 10 });
        expect(JSON.stringify(await call("runs.events", { runId: bad.id, limit: 500 }))).toMatch(/No environment group called \\"Marketing\\". Groups: Finance, HR, Sandboxes/);

        // A slow operation hands back its id instead of holding the run.
        f.powerPlatform.mock.opDelayMs = 60_000;
        await call("powerplatform.configure", { waitSeconds: 0 });
        const slow = await call<Run>("runs.start", { agentId: creator.id, prompt: "Name: Slow One", waitSeconds: 10 });
        expect(JSON.stringify(await call("runs.events", { runId: slow.id, limit: 500 }))).toMatch(/still InProgress after 0s\. Check later with pp_operations/);

        await expect(call("powerplatform.configure", { reader: { secretName: "missing" } })).rejects.toThrow(/Secret "missing" does not exist/);
        await expect(call("powerplatform.configure", { apiUrl: "api.powerplatform.com" })).rejects.toThrow(/must start with http/);
        await call("powerplatform.configure", { protectProduction: false });
        expect((await call("powerplatform.environments")).environments.find((e: any) => e.displayName === "Finance Production").protected).toBeNull();
        await f.stop();
    });
});
