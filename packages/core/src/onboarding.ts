import { AgentSpec, DEFAULT_TICKET_PROMPT, type AgentSpecInput, type RoutingMatch } from "./schemas.ts";
import type { EventKind } from "./notify.ts";
import type { Services } from "./registry.ts";

// ── Templates: a ready-made starting point for a new agent ─────────────────

export interface AgentTemplate {
    id: string;
    name: string;
    description: string;
    /** What a first run on the simulator shows, so a person knows what to look for. */
    firstRun: string;
    spec: AgentSpecInput;
}

/** Foreman's Jira tools are custom tools, which "propose" allows; a template promises to ask first. */
const JIRA_WRITES_ASK = ["jira_add_comment", "jira_create_subtask", "jira_transition"].map((match) => ({ match, action: "ask" as const, note: "A person approves changes to Jira" }));

/** Every template starts on the simulator with "propose" autonomy: nothing changes without a person's approval. */
export const AGENT_TEMPLATES: AgentTemplate[] = [
    {
        id: "ticket-summary",
        name: "Ticket summary",
        description: "Reads a Jira ticket and comments a short summary on it.",
        firstRun: "Reads the ticket, then stops to ask before it comments.",
        spec: {
            instructions: "Read the Jira ticket named in the task. Write a summary of at most five lines: what is asked, why, and anything unclear. Post it as a comment on the ticket. Change nothing else.",
            tools: ["jira_get_issue", "jira_add_comment"],
            policy: { rules: JIRA_WRITES_ASK },
        },
    },
    {
        id: "bug-triage",
        name: "Bug triage",
        description: "Reads a bug report, finds the likely cause in the code and proposes the smallest fix.",
        firstRun: "Searches and reads files, then stops to ask before it edits one.",
        spec: {
            instructions: "Triage the bug in the task. Find where it most likely comes from by searching and reading the code. Propose the smallest fix and make it only after approval. Say how sure you are.",
            tools: ["grep", "view", "edit"],
        },
    },
    {
        id: "ticket-planner",
        name: "Ticket planner",
        description: "Splits a Jira ticket into subtasks and comments the plan on it.",
        firstRun: "Reads the ticket, then stops to ask before it creates subtasks.",
        spec: {
            instructions: "Read the Jira ticket named in the task. Split the work into small subtasks of at most a day each and create them. Comment the plan on the ticket. Ask before changing any status.",
            tools: ["jira_get_issue", "jira_create_subtask", "jira_add_comment"],
            policy: { rules: JIRA_WRITES_ASK },
        },
    },
    {
        id: "docs-answer",
        name: "Answer from docs",
        description: "Answers a question from your documentation, with the source named.",
        firstRun: "Reads, then answers. Add your Confluence or GitHub MCP server to search real docs.",
        spec: {
            instructions: "Answer the question in the task from our documentation only. Search before answering, quote the page or file you used, and say so plainly when the docs do not cover it.\n\nWhere to look: (name the Confluence spaces or repositories here)",
            tools: ["view", "grep"],
        },
    },
];

// ── Sample data: agents and routing a person can look around in, then remove ──

interface SampleAgent {
    name: string;
    description: string;
    spec: AgentSpecInput;
    /** Tickets this agent takes from the mock Jira. */
    routes: { name: string; match: RoutingMatch; review?: boolean }[];
}

const SAMPLE_AGENTS: SampleAgent[] = [
    {
        name: "Bug triage",
        description: "Reads new bug reports, finds the likely cause and proposes a fix.",
        spec: { instructions: "Triage the bug: reproduce from the report, find the likely cause, propose the smallest fix.", tools: ["view", "grep", "edit"], policy: { autonomy: "act", approvalTimeoutSeconds: 240 }, mock: { scenario: "happy", speed: 1 } },
        routes: [{ name: "Bugs go to triage", match: { type: "Bug" } }],
    },
    {
        name: "Release assistant",
        description: "Prepares release branches and publishes them. Pushes need a person's approval.",
        spec: { instructions: "Prepare the release branch, update the changelog and push. Never push without approval.", tools: ["view", "edit", "shell"], policy: { autonomy: "act", approvalTimeoutSeconds: 240 }, mock: { scenario: "needs-approval", speed: 1 } },
        routes: [{ name: "Operations tasks", match: { project: "OPS" }, review: true }],
    },
    {
        name: "Order sync",
        description: "Pulls orders from the upstream API and reconciles them against the ledger.",
        spec: { instructions: "Fetch orders, reconcile against the ledger, report mismatches.", tools: ["web_fetch", "view"], policy: { autonomy: "act" }, mock: { scenario: "flaky", speed: 1 } },
        routes: [{ name: "Payment chores", match: { project: "PAY", type: "Task" } }],
    },
    {
        name: "Docs keeper",
        description: "Keeps the guides in step with the code, delegating research and writing.",
        spec: {
            instructions: "Keep docs current. Delegate research and writing to sub-agents.",
            tools: ["view", "grep", "edit"],
            subAgents: [
                { name: "researcher", description: "Finds what changed", prompt: "Find what changed.", tools: ["view", "grep"] },
                { name: "writer", description: "Rewrites sections", prompt: "Rewrite clearly.", tools: ["edit"] },
            ],
            policy: { autonomy: "act" },
            mock: { scenario: "sub-agents", speed: 1 },
        },
        routes: [{ name: "Documentation", match: { project: "DOC" }, review: true }],
    },
    {
        name: "Ticket planner",
        description: "Breaks a ticket into subtasks and notes the plan in Jira. Changing a ticket's status needs a person's approval.",
        spec: {
            instructions: "Read the ticket, split it into subtasks, comment the plan on the ticket. Ask before changing a status.",
            tools: ["jira_get_issue", "jira_search", "jira_add_comment", "jira_create_subtask", "jira_transition"],
            policy: { autonomy: "act", rules: [{ match: "jira_transition", action: "ask", note: "A person confirms status changes" }], approvalTimeoutSeconds: 240 },
            mock: { scenario: "jira-updates", speed: 1 },
        },
        routes: [{ name: "API planning tasks", match: { project: "API", type: "Task" } }],
    },
];

/** Runs on the real Copilot runtime against the built-in mock model endpoint: no subscription, no key. */
const modelBacked = (baseUrl: string): Omit<SampleAgent, "routes"> => ({
    name: "Model-backed reader",
    description: "Runs on the real Copilot runtime with its own model endpoint (the built-in mock model). Reads a ticket; may not comment.",
    spec: {
        runtime: "copilot",
        model: "gpt-4o",
        provider: { type: "openai", baseUrl: `${baseUrl}/mock/model/v1` },
        instructions: "Read the ticket named in the task and summarise it. Do not change anything.",
        tools: ["jira_get_issue", "jira_add_comment"],
        policy: { autonomy: "act", rules: [{ match: "jira_add_comment", action: "deny", note: "Read-only agent" }] },
    },
});

const SAMPLE_EVENTS: EventKind[] = ["batch_done", "jira_write_failed", "ticket_failed", "ticket_review", "ticket_aging", "run_failed", "intake_failed", "digest", "custom"];

/** What the sample loader created, so it can be told apart from a person's own setup and removed. */
export interface SampleRecord {
    loadedAt: string;
    agentIds: string[];
    ruleIds: string[];
    channelIds: string[];
    /** Whether loading switched ticket intake on, so removing switches it back off. */
    enabledIntake: boolean;
}

export const sampleRecord = (s: Pick<Services, "store">) => s.store.getSetting<SampleRecord>("samples") ?? null;

/**
 * Load sample agents, routing rules and a Teams preview channel. Ticket intake from the built-in
 * mock Jira is switched on too, so the work board fills up; a real Jira site is never touched.
 */
export function loadSamples(s: Pick<Services, "store" | "notify" | "work" | "bus" | "info">, actor: string): SampleRecord {
    const record: SampleRecord = { loadedAt: new Date().toISOString(), agentIds: [], ruleIds: [], channelIds: [], enabledIntake: false };
    for (const def of SAMPLE_AGENTS) {
        const { agent } = s.store.createAgent({ name: def.name, description: def.description, spec: AgentSpec.parse(def.spec), note: "Sample agent", actor });
        record.agentIds.push(agent.id);
        for (const route of def.routes) record.ruleIds.push(s.store.createRule({ name: route.name, match: route.match, agentId: agent.id, review: route.review ?? false, promptTemplate: DEFAULT_TICKET_PROMPT, enabled: true }).id);
    }
    const reader = modelBacked(s.info.baseUrl);
    record.agentIds.push(s.store.createAgent({ name: reader.name, description: reader.description, spec: AgentSpec.parse(reader.spec), note: "Sample agent", actor }).agent.id);
    const teams = s.notify.createChannel({ name: "Agents (Teams preview)", kind: "mock_teams" });
    record.channelIds.push(teams.id);
    s.notify.createRule({ name: "Everything else a person should see", events: SAMPLE_EVENTS, channelId: teams.id });
    if (s.work.isMock() && !s.work.settings().enabled) {
        s.work.updateSettings({ enabled: true });
        record.enabledIntake = true;
    }
    s.store.setSetting("samples", record);
    s.bus.emit("change", "agents");
    s.bus.emit("change", "work");
    s.bus.emit("change", "notify");
    return record;
}

/** Undo `loadSamples`: archive the sample agents (their runs stay in history), delete their rules and channel. */
export function removeSamples(s: Pick<Services, "store" | "notify" | "work" | "bus">): { agents: number; rules: number; channels: number } {
    const record = sampleRecord(s);
    if (!record) return { agents: 0, rules: 0, channels: 0 };
    for (const ruleId of record.ruleIds) if (s.store.getRule(ruleId)) s.store.deleteRule(ruleId);
    const channels = new Set(record.channelIds);
    for (const rule of s.notify.listRules()) if (channels.has(rule.channelId)) s.notify.deleteRule(rule.id);
    for (const channelId of record.channelIds) if (s.notify.listChannels().some((c) => c.id === channelId)) s.notify.deleteChannel(channelId);
    for (const agentId of record.agentIds) if (s.store.getAgent(agentId)) s.store.updateAgentMeta(agentId, { archived: true });
    // Switch intake back off only if the samples switched it on and nothing else depends on it.
    if (record.enabledIntake && s.work.isMock() && !s.store.listRules().some((r) => r.enabled)) s.work.updateSettings({ enabled: false });
    s.store.setSetting("samples", null);
    s.bus.emit("change", "agents");
    s.bus.emit("change", "work");
    s.bus.emit("change", "notify");
    return { agents: record.agentIds.length, rules: record.ruleIds.length, channels: record.channelIds.length };
}

// ── The "Get started" checklist ────────────────────────────────────────────

export interface SetupStep {
    id: "agent" | "run" | "intake" | "routing" | "notify" | "model" | "mcp";
    title: string;
    text: string;
    done: boolean;
    optional: boolean;
    /** Where in the app the step is done (a path after `#`). */
    path: string;
    action: string;
}

/** Work out each step from what is really set up. Sample data does not count as a person's own. */
export function setupStatus(s: Pick<Services, "store" | "notify" | "work">) {
    const record = sampleRecord(s);
    const sample = new Set([...(record?.agentIds ?? []), ...(record?.ruleIds ?? []), ...(record?.channelIds ?? [])]);
    const agents = s.store.listAgents().filter((a) => !sample.has(a.id));
    const first = agents[0];
    const ran = agents.find((a) => s.store.listRuns({ agentId: a.id, limit: 1 }).length);
    const jira = s.work.settings();
    const mock = s.work.isMock();
    const own = new Set(agents.map((a) => a.id));
    const routed = s.store.listRules().some((r) => r.enabled && own.has(r.agentId) && !sample.has(r.id));
    const channel = s.notify.listChannels().some((c) => !sample.has(c.id));
    const onModel = agents.find((a) => s.store.getRevision(a.activeRevisionId)?.spec.runtime === "copilot" && s.store.listRuns({ agentId: a.id, status: ["succeeded"], limit: 1 }).length);
    const mcpSeen = s.store.getSetting<string>("setup.mcpSeen");
    const steps: SetupStep[] = [
        {
            id: "agent",
            title: "Create your first agent",
            text: first ? `“${first.name}” is ready.` : "Pick a ready-made agent and change it later. It starts on the simulator: no model, no cost, nothing changes without your approval.",
            done: !!first,
            optional: false,
            path: "/agents/new",
            action: "New agent",
        },
        {
            id: "run",
            title: "Try it on the test bench",
            text: ran ? `“${ran.name}” has run. Its trace shows every step and decision.` : "Give the agent a task and run it. Watch the trace, and approve the step it stops to ask about.",
            done: !!ran,
            optional: false,
            path: first ? `/agents/${first.id}` : "/agents",
            action: "Open the test bench",
        },
        {
            id: "intake",
            title: "Choose where tickets come from",
            text: jira.enabled ? (mock ? "Tickets come from the built-in practice Jira. Connect your own Jira here when you are ready." : "Tickets come from your Jira.") : "Switch on ticket pickup. The built-in practice Jira works straight away; your own Jira needs its address and a token.",
            // Pickup switched on by the sample data is not a choice the person made.
            done: jira.enabled && !record?.enabledIntake,
            optional: false,
            path: "/work/setup",
            action: "Routing & intake",
        },
        {
            id: "routing",
            title: "Send tickets to an agent",
            text: routed ? "A routing rule hands tickets to your agent." : "Add a routing rule, for example “bugs go to Bug triage”. Tickets no rule matches wait in the inbox.",
            done: routed,
            optional: false,
            path: "/work/setup",
            action: "Add a rule",
        },
        {
            id: "notify",
            title: "Hear about what needs you",
            text: channel ? "Notifications go to a channel." : "Send approvals, questions and failures to Teams or a webhook. The Teams preview shows the cards without a Teams account.",
            done: channel,
            optional: true,
            path: "/notifications/setup",
            action: "Channels & rules",
        },
        {
            id: "model",
            title: "Use a real model",
            text: onModel
                ? `“${onModel.name}” has finished a run on a real model.`
                : "Needs a GitHub Copilot subscription, or a model key of your own (an OpenAI-compatible endpoint, Azure OpenAI, Anthropic or a local model). With your own key, the agent's MCP servers do not load. The simulator keeps working without either.",
            done: !!onModel,
            optional: true,
            path: "/connect",
            action: "Check runtimes",
        },
        {
            id: "mcp",
            title: "Connect an MCP client",
            text: mcpSeen ? "An MCP client has called Foreman." : "Everything here is also an MCP tool. Point Claude Code or another MCP client at Foreman to work with it from there.",
            done: !!mcpSeen,
            optional: true,
            path: "/connect",
            action: "Connect",
        },
    ];
    const required = steps.filter((st) => !st.optional);
    return {
        steps,
        requiredDone: required.filter((st) => st.done).length,
        requiredTotal: required.length,
        /** The first required step not yet done; null once the basics are set up. */
        next: required.find((st) => !st.done)?.id ?? null,
        hidden: s.store.getSetting<boolean>("setup.hidden") ?? false,
        samples: record ? { loadedAt: record.loadedAt, agents: record.agentIds.length } : null,
    };
}

// ── An example task for the test bench ─────────────────────────────────────

/** Something sensible to try an agent with, judged from its tools. */
export function exampleTask(s: Pick<Services, "work" | "mockJira">, tools: string[]): { prompt: string; ticketKey: string | null } {
    const edits = tools.includes("edit");
    if (tools.some((t) => t.startsWith("jira_"))) {
        if (!s.work.isMock()) return { prompt: "Work on Jira ticket ABC-123 (replace with one of your own ticket keys).", ticketKey: null };
        const open = s.mockJira.list().filter((i) => i.fields.status.name !== "Done" && !i.fields.parent);
        const issue = open.find((i) => i.fields.issuetype.name === (edits ? "Bug" : "Task")) ?? open[0];
        if (issue) {
            const f = issue.fields;
            return { prompt: `Work on Jira ticket ${issue.key}: ${f.summary}\n\nType: ${f.issuetype.name} · Priority: ${f.priority.name}\n\n${f.description}`.trim(), ticketKey: issue.key };
        }
    }
    if (edits) return { prompt: "Customers report that invoice totals are off by one cent when a line has a discount. Find the likely cause and propose a fix.", ticketKey: null };
    return { prompt: "How do we deploy a new version of the billing service, and who has to approve it?", ticketKey: null };
}
