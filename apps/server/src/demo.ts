import { AgentSpec, DEFAULT_TICKET_PROMPT, type AgentSpecInput, type createForeman, type RoutingMatch } from "@foreman/core";

type Foreman = ReturnType<typeof createForeman>;

interface DemoAgent {
    name: string;
    description: string;
    spec: AgentSpecInput;
    /** Tickets this agent takes from the mock Jira. */
    routes: { name: string; match: RoutingMatch; review?: boolean }[];
}

const AGENTS: DemoAgent[] = [
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
const modelBacked = (baseUrl: string): Omit<DemoAgent, "routes"> => ({
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

/**
 * Demo mode: sample agents on the mock runtime, routing rules, and the mock Jira filing tickets on
 * its own — so the work board is alive without Copilot, Jira or Teams. Stories are deliberately
 * left unrouted so the inbox has something in it.
 */
export function startDemo(foreman: Foreman): () => void {
    const created = new Map<string, string>();
    for (const def of AGENTS) {
        const { agent } = foreman.store.createAgent({ name: def.name, description: def.description, spec: AgentSpec.parse(def.spec), note: "Demo agent", actor: "system:demo" });
        created.set(def.name, agent.id);
        for (const route of def.routes) foreman.store.createRule({ name: route.name, match: route.match, agentId: agent.id, review: route.review ?? false, promptTemplate: DEFAULT_TICKET_PROMPT, enabled: true });
    }
    const reader = modelBacked(foreman.info.baseUrl);
    created.set(reader.name, foreman.store.createAgent({ name: reader.name, description: reader.description, spec: AgentSpec.parse(reader.spec), note: "Demo agent", actor: "system:demo" }).agent.id);
    const teams = foreman.notify.createChannel({ name: "Agents (Teams preview)", kind: "mock_teams" });
    // Approvals and questions go to the bot instead, whose cards can be answered in place.
    foreman.notify.createRule({ name: "Everything else a person should see", events: ["batch_done", "jira_write_failed", "ticket_failed", "ticket_review", "ticket_aging", "run_failed", "intake_failed", "digest", "custom"], channelId: teams.id });
    foreman.bot.configure({ enabled: true, mock: true });
    foreman.notify.configure({ agingMinutes: 2 });
    foreman.work.updateSettings({ enabled: true, pollSeconds: 30, wipPerAgent: 2, writeBack: { enabled: true, statusStarted: "In Progress", statusReview: "In Review", statusDone: "Done" } });
    foreman.mockJira.setGenerator(5);
    // New mock tickets announce themselves by webhook, so they appear at once rather than on the next poll.
    foreman.mockJira.webhookUrl = foreman.work.webhookUrl();
    void foreman.work.poll().catch(() => {});
    // One batch to watch: the documentation tickets, tracked as a single job. It is created a
    // moment after start because the mock Jira is served by this same process.
    const batch = setTimeout(() => void foreman.batches.create({ name: "Docs catch-up", jql: "project = DOC" }).catch(() => {}), 2500);
    // The mock adds the bot to a team over HTTP, as Teams would, so this also waits for the server.
    const install = setTimeout(async () => {
        const installed = await foreman.mockBot.install("Foreman demo", "Approvals").catch(() => null);
        if (installed?.status !== 200) return;
        const channel = foreman.notify.createChannel({ name: "Approvals (Teams bot)", kind: "teams_bot", webhookUrl: installed.conversationId });
        foreman.notify.createRule({ name: "Decide in Teams", events: ["approval_needed", "question_asked"], channelId: channel.id });
    }, 1500);
    // A knowledge library from the mock Confluence plus a note, given to two agents. Also over
    // HTTP to this same server, so it waits a moment too.
    const library = setTimeout(async () => {
        const kb = foreman.knowledge;
        const handbook = await foreman.confluence.import({ page: "1001", scope: "tree" }).catch(() => null);
        const payments = await foreman.confluence.import({ spaceKey: "PAY", scope: "space" }).catch(() => null);
        const notes = kb.createFolder("Team notes");
        kb.addDocument({ parentId: notes.id, title: "Release checklist", source: { kind: "text", mediaType: "text/markdown" }, text: ` Release checklist

## Before

Announce the release in the team channel an hour ahead. Check the error budget: no release when less than 20% is left.

## After

Watch the dashboards for 15 minutes and close the release ticket with the version number.` });
        const give = (agent: string, ids: (string | undefined)[]) => {
            const agentId = created.get(agent);
            const rev = agentId && foreman.store.getRevision(foreman.store.getAgent(agentId)!.activeRevisionId);
            if (rev) foreman.store.addRevision(agentId, { ...rev.spec, knowledge: ids.filter((id): id is string => !!id) }, "Knowledge from the demo library", "system:demo", true);
        };
        give("Bug triage", [payments?.id]);
        give("Release assistant", [handbook?.id, notes.id]);
        give("Model-backed reader", [handbook?.id]);
        foreman.bus.emit("change", "agents");
    }, 1200);
    return () => {
        clearTimeout(batch);
        clearTimeout(install);
        clearTimeout(library);
        foreman.mockJira.setGenerator(0);
    };
}
