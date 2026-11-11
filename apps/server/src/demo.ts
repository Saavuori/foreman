import { AgentSpec, type AgentSpecInput, type createForeman } from "@foreman/core";

type Foreman = ReturnType<typeof createForeman>;

const AGENTS: { name: string; description: string; spec: AgentSpecInput; feed: string[]; weight: number; cron?: string }[] = [
    {
        name: "Bug triage",
        description: "Reads new bug reports, finds the likely cause and proposes a fix.",
        weight: 5,
        spec: { instructions: "Triage the bug: reproduce from the report, find the likely cause, propose the smallest fix.", tools: ["view", "grep", "edit"], policy: { autonomy: "act", approvalTimeoutSeconds: 180 }, mock: { scenario: "random", speed: 2 } },
        feed: [
            "PAY-311 Partial refund is rounded up instead of down",
            "PAY-298 Invoice PDF shows the wrong VAT rate for Åland",
            "WEB-142 Login button unresponsive on Safari 18",
            "PAY-301 Duplicate webhook delivery creates two payments",
            "WEB-150 Date picker ignores the user's locale",
            "API-77 429 responses are missing the Retry-After header",
        ],
    },
    {
        name: "Release assistant",
        description: "Prepares release branches and publishes them. Pushes need a person's approval.",
        weight: 2,
        spec: { instructions: "Prepare the release branch, update the changelog and push. Never push without approval.", tools: ["view", "edit", "shell"], policy: { autonomy: "act", approvalTimeoutSeconds: 180 }, mock: { scenario: "needs-approval", speed: 2 } },
        feed: ["OPS-51 Cut release 4.12 from main", "OPS-60 Backport the session-expiry fix to 4.11", "OPS-49 Publish hotfix 4.11.3"],
    },
    {
        name: "Dependency auditor",
        description: "Walks every service and reports outdated or risky dependencies. Read-only.",
        weight: 1,
        cron: "*/3 * * * *",
        spec: { instructions: "Audit dependencies across all services. Report only; change nothing.", tools: ["view", "grep"], policy: { autonomy: "observe" }, mock: { scenario: "slow", speed: 1.5 } },
        feed: ["Weekly dependency audit for the payments services", "Audit the web frontend after the framework upgrade"],
    },
    {
        name: "Order sync",
        description: "Pulls yesterday's orders from the upstream API and reconciles them.",
        weight: 2,
        spec: { instructions: "Fetch orders, reconcile against the ledger, report mismatches.", tools: ["web_fetch", "view"], policy: { autonomy: "act" }, mock: { scenario: "flaky", speed: 2 }, outputSchema: undefined },
        feed: ["Reconcile yesterday's orders for the Nordic region", "Reconcile orders after the 14:00 outage", "Re-run reconciliation for partner 2291"],
    },
    {
        name: "Docs keeper",
        description: "Keeps the migration guide in step with the code, delegating research and writing.",
        weight: 2,
        spec: { instructions: "Keep docs current. Delegate research and writing to sub-agents.", tools: ["view", "grep", "edit"], subAgents: [{ name: "researcher", description: "Finds what changed", prompt: "Find what changed.", tools: ["view", "grep"] }, { name: "writer", description: "Rewrites sections", prompt: "Rewrite clearly.", tools: ["edit"] }], policy: { autonomy: "act" }, mock: { scenario: "sub-agents", speed: 2 } },
        feed: ["DOC-18 Migration guide still describes the v3 config format", "DOC-22 Document the new retry settings"],
    },
];

/**
 * Demo mode: sample agents on the mock runtime plus a steady feed of incoming work, so every
 * screen has live data to show without Copilot, Jira or Teams.
 */
export function startDemo(foreman: Foreman): () => void {
    const feeds = AGENTS.map((def) => {
        const { agent } = foreman.store.createAgent({ name: def.name, description: def.description, spec: AgentSpec.parse(def.spec), note: "Demo agent", actor: "system:demo" });
        const trigger = foreman.store.createTrigger({ agentId: agent.id, name: "Demo feed", config: { kind: "webhook" }, promptTemplate: "{{payload.title}}", enabled: true });
        if (def.cron) foreman.triggers.sync(foreman.store.createTrigger({ agentId: agent.id, name: "Every 3 minutes", config: { kind: "schedule", cron: def.cron, timezone: "UTC" }, promptTemplate: def.feed[0]!, enabled: true }));
        return { triggerId: trigger.id, def, next: 0 };
    });
    const lottery = feeds.flatMap((feed) => Array<typeof feed>(feed.def.weight).fill(feed));

    const fire = () => {
        const { queued, running } = foreman.engine.stats();
        if (queued + running >= 5) return;
        const feed = lottery[Math.floor(Math.random() * lottery.length)]!;
        foreman.triggers.fire(feed.triggerId, { title: feed.def.feed[feed.next++ % feed.def.feed.length] }, "webhook");
    };

    // A burst at start so the board is not empty, then a trickle.
    for (let i = 0; i < 4; i++) setTimeout(fire, 400 * i);
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
        fire();
        timer = setTimeout(loop, 7000 + Math.random() * 9000);
    };
    timer = setTimeout(loop, 6000);
    return () => clearTimeout(timer);
}
