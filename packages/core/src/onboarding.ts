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

/** A template promises to ask before it changes a ticket, and keeps that promise if the agent is later moved to "act". */
const JIRA_WRITES_ASK = ["jira_add_comment", "jira_create_subtask", "jira_transition"].map((match) => ({ match, action: "ask" as const, note: "A person approves changes to Jira" }));

/** Power Platform reads every platform template needs to find its way around. */
const PP_LOOKUPS = ["pp_env_list", "pp_env_get", "pp_env_groups"];
/** Never hand out the role that can do everything, whatever else a template allows. */
const NO_SYSADMIN = { match: "pp_access_grant@role:System Administrator", action: "deny" as const, note: "System Administrator is given by a person, never by an agent" };

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
    {
        id: "pp-governance-report",
        name: "Power Platform governance report",
        description: "Reads the tenant and reports idle sandboxes, environments outside a group, people who have left but still hold roles, and missing backups.",
        firstRun: "Reads environments, groups, users and backups, then reports. It uses the read-only identity, so it cannot change anything.",
        spec: {
            instructions:
                "Report on the Power Platform tenant for the platform team. Look at every environment: flag sandboxes nobody has changed in months, environments outside any group, disabled users who still hold roles, and production environments without a recent backup. Change nothing. End with a short list of recommended actions, most important first.",
            tools: [...PP_LOOKUPS, "pp_env_users", "pp_backups", "pp_operations", "pp_api_get"],
            mock: { scenario: "pp-governance-report", speed: 1 },
        },
    },
    {
        id: "pp-environment-request",
        name: "Environment requests",
        description: "Creates the environment a ticket asks for, puts it in the right group and tells the requester.",
        firstRun: "Checks the name is free, then stops to ask before it creates the environment and before it comments. Production environments are never created by it.",
        spec: {
            instructions:
                "Handle a request for a new Power Platform environment. The ticket gives Name, Environment type (Sandbox unless it says otherwise) and Group. Check no environment has that name already. Create it in the group asked for; if no group is named, ask. Never create a production environment: say it needs a person. Comment on the ticket with what you created.",
            tools: [...PP_LOOKUPS, "pp_env_create", "pp_env_add_to_group", "pp_env_managed", "jira_get_issue", "jira_add_comment"],
            powerPlatform: { connection: "operator" },
            policy: { rules: [{ match: "pp_env_create@production", action: "deny", note: "Production environments are created by a person" }, ...JIRA_WRITES_ASK] },
            mock: { scenario: "pp-environment-request", speed: 1 },
        },
    },
    {
        id: "pp-access-request",
        name: "Access requests",
        description: "Gives a person the security role a ticket asks for in an environment, then comments on the ticket.",
        firstRun: "Looks the person up, then stops to ask before giving the role. It never gives System Administrator and never touches production or the default environment.",
        spec: {
            instructions:
                "Handle a request for access to a Power Platform environment. The ticket gives User (sign-in name), Environment and Role. Check the person exists in the environment and what roles they have now. Give only the role asked for. If the role is System Administrator, do not give it: say a person must. Comment on the ticket with the outcome.",
            tools: ["pp_env_get", "pp_env_users", "pp_env_roles", "pp_access_grant", "jira_get_issue", "jira_add_comment"],
            powerPlatform: { connection: "operator" },
            policy: { rules: [NO_SYSADMIN, ...JIRA_WRITES_ASK] },
            mock: { scenario: "pp-access-request", speed: 1 },
        },
    },
    {
        id: "pp-maintenance",
        name: "Environment maintenance",
        description: "Backs up a sandbox or developer environment, then resets it, as a ticket asks.",
        firstRun: "Stops to ask before the backup and again before the reset. Resetting anything but a sandbox or developer environment is denied, and production is protected anyway.",
        spec: {
            instructions:
                "Do the maintenance a ticket asks for on one Power Platform environment. Always take a backup first, labelled with the ticket key. Then reset the environment. Only sandbox and developer environments may be reset; for anything else, explain that a person must do it. Comment on the ticket with what was done.",
            tools: ["pp_env_get", "pp_backups", "pp_env_backup", "pp_env_reset", "jira_get_issue", "jira_add_comment"],
            powerPlatform: { connection: "operator" },
            policy: {
                rules: [
                    { match: "pp_env_reset@sandbox", action: "ask", note: "A person confirms every reset" },
                    { match: "pp_env_reset@developer", action: "ask", note: "A person confirms every reset" },
                    ...JIRA_WRITES_ASK,
                ],
            },
            mock: { scenario: "pp-maintenance", speed: 1 },
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
    {
        name: "Environment requests",
        description: "Creates the Power Platform environments platform tickets ask for. Never production.",
        spec: {
            instructions: "Create the environment the ticket asks for (Name, Environment type, Group), never a production one, and comment on the ticket.",
            tools: ["pp_env_list", "pp_env_get", "pp_env_groups", "pp_env_create", "pp_env_add_to_group", "jira_add_comment"],
            powerPlatform: { connection: "operator" },
            policy: { autonomy: "act", rules: [{ match: "pp_env_create@production", action: "deny", note: "Production environments are created by a person" }, { match: "pp_env_create", action: "ask", note: "A person confirms new environments" }], approvalTimeoutSeconds: 240 },
            mock: { scenario: "pp-environment-request", speed: 1 },
        },
        routes: [{ name: "Platform: environment requests", match: { project: "PLAT", label: "env-request" } }],
    },
    {
        name: "Access requests",
        description: "Gives people security roles in Power Platform environments. Basic User goes through; other roles need a person; System Administrator never.",
        spec: {
            instructions: "Give the person on the ticket the role asked for in the environment named, then comment on the ticket. Never give System Administrator.",
            tools: ["pp_env_get", "pp_env_users", "pp_env_roles", "pp_access_grant", "jira_add_comment"],
            powerPlatform: { connection: "operator" },
            policy: {
                autonomy: "act",
                rules: [NO_SYSADMIN, { match: "pp_access_grant@role:Basic User", action: "allow", note: "Basic User is safe to give" }, { match: "pp_access_grant", action: "ask", note: "Other roles need a person" }],
                approvalTimeoutSeconds: 240,
            },
            mock: { scenario: "pp-access-request", speed: 1 },
        },
        routes: [{ name: "Platform: access requests", match: { project: "PLAT", label: "access-request" } }],
    },
    {
        name: "Environment maintenance",
        description: "Backs up and resets sandboxes when a ticket asks. Production is protected, so asking for it there is refused.",
        spec: {
            instructions: "Back up the environment the ticket names, then reset it. Only sandboxes and developer environments. Comment on the ticket.",
            tools: ["pp_env_get", "pp_backups", "pp_env_backup", "pp_env_reset", "jira_add_comment"],
            powerPlatform: { connection: "operator" },
            policy: { autonomy: "act", rules: [{ match: "pp_env_reset@sandbox", action: "ask", note: "A person confirms every reset" }], approvalTimeoutSeconds: 240 },
            mock: { scenario: "pp-maintenance", speed: 1 },
        },
        routes: [{ name: "Platform: maintenance", match: { project: "PLAT", label: "maintenance" } }],
    },
];

/** Platform-team tickets for the sample agents above, filed in the practice Jira once. */
const PLATFORM_TICKETS: { type: string; priority: string; summary: string; description: string; labels: string[] }[] = [
    { type: "Task", priority: "Medium", summary: "New sandbox for the Atlas team", description: "Name: Atlas Dev\nEnvironment type: Sandbox\nGroup: Sandboxes\n\nRequested by Dev Patel for the Atlas pilot.", labels: ["env-request"] },
    { type: "Task", priority: "High", summary: "Carla needs to build apps in HR Dev", description: "User: carla.ruiz@contoso.test\nEnvironment: HR Dev\nRole: Environment Maker", labels: ["access-request"] },
    { type: "Task", priority: "Low", summary: "Give Dev read access to HR Dev", description: "User: dev.patel@contoso.test\nEnvironment: HR Dev\nRole: Basic User", labels: ["access-request"] },
    { type: "Task", priority: "Medium", summary: "Reset Finance Test before the January test cycle", description: "Environment: Finance Test\n\nThe test data is stale; start the cycle from a clean environment.", labels: ["maintenance"] },
    { type: "Task", priority: "Medium", summary: "Reset Finance Production to clear test data", description: "Environment: Finance Production\n\nSomeone loaded test records into production.", labels: ["maintenance"] },
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
export function loadSamples(s: Pick<Services, "store" | "notify" | "work" | "bus" | "info" | "mockJira">, actor: string): SampleRecord {
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
    // Only the practice Jira gets the platform tickets; a real site is never written to.
    if (s.work.isMock() && !s.mockJira.list().some((i) => i.fields.project.key === "PLAT")) {
        for (const t of PLATFORM_TICKETS) s.mockJira.create({ project: "PLAT", ...t, labels: ["foreman", ...t.labels] });
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
    id: "agent" | "run" | "intake" | "routing" | "tools" | "notify" | "model" | "mcp";
    title: string;
    text: string;
    done: boolean;
    optional: boolean;
    /** Where in the app the step is done (a path after `#`). */
    path: string;
    action: string;
}

/** Work out each step from what is really set up. Sample data does not count as a person's own. */
export function setupStatus(s: Pick<Services, "store" | "notify" | "work" | "connections">) {
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
    const tooled = s.connections.list().find((c) => s.connections.usedBy(c.id).some((a) => own.has(a.id)));
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
            id: "tools",
            title: "Give agents their tools",
            text: tooled
                ? `“${tooled.name}” is switched on for an agent.`
                : "Set up Jira, Confluence, the Azure CLI, the Power Platform CLI or any MCP server once, with what agents may do with it, then switch it on for the agents that need it.",
            done: !!tooled,
            optional: true,
            path: "/connections",
            action: "Connections",
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
export function exampleTask(s: Pick<Services, "work" | "mockJira" | "powerPlatform">, tools: string[]): { prompt: string; ticketKey: string | null } {
    const edits = tools.includes("edit");
    if (tools.some((t) => t.startsWith("pp_"))) {
        // Names from the practice tenant; with a real tenant the person fills in their own.
        const practice = s.powerPlatform.isMock();
        const env = practice ? "HR Dev" : "(an environment name)";
        if (tools.includes("pp_access_grant")) return { prompt: `Access request\n\nUser: ${practice ? "carla.ruiz@contoso.test" : "(sign-in name)"}\nEnvironment: ${env}\nRole: Environment Maker`, ticketKey: null };
        if (tools.includes("pp_env_create")) return { prompt: "Environment request\n\nName: Atlas Dev\nEnvironment type: Sandbox\nGroup: Sandboxes", ticketKey: null };
        if (tools.includes("pp_env_reset")) return { prompt: `Maintenance\n\nEnvironment: ${env}\n\nBack it up, then reset it for the next test cycle.`, ticketKey: null };
        return { prompt: "Report on the tenant's environments: idle sandboxes, environments outside a group, disabled users who still hold roles, and missing backups.", ticketKey: null };
    }
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
