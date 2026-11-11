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
];

/**
 * Demo mode: sample agents on the mock runtime, routing rules, and the mock Jira filing tickets on
 * its own — so the work board is alive without Copilot, Jira or Teams. Stories are deliberately
 * left unrouted so the inbox has something in it.
 */
export function startDemo(foreman: Foreman): () => void {
    for (const def of AGENTS) {
        const { agent } = foreman.store.createAgent({ name: def.name, description: def.description, spec: AgentSpec.parse(def.spec), note: "Demo agent", actor: "system:demo" });
        for (const route of def.routes) foreman.store.createRule({ name: route.name, match: route.match, agentId: agent.id, review: route.review ?? false, promptTemplate: DEFAULT_TICKET_PROMPT, enabled: true });
    }
    foreman.work.updateSettings({ enabled: true, pollSeconds: 4, wipPerAgent: 2 });
    foreman.mockJira.setGenerator(5);
    void foreman.work.poll().catch(() => {});
    return () => foreman.mockJira.setGenerator(0);
}
