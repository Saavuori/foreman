import { z } from "zod";

/** Smallest budget the Copilot runtime accepts for a session (found in the milestone 0 spike). */
export const MIN_AI_CREDITS = 30;

export const PolicyAction = z.enum(["allow", "ask", "deny"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

export const PolicyRule = z.object({
    /** Glob matched against `kind` and `kind:toolName`, e.g. `shell`, `mcp:github-*`, `*`. */
    match: z.string().min(1),
    action: PolicyAction,
    note: z.string().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const Autonomy = z.enum(["observe", "propose", "act", "full"]);
export type Autonomy = z.infer<typeof Autonomy>;

export const McpServerSpec = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("stdio"),
        command: z.string(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
        tools: z.array(z.string()).optional(),
    }),
    z.object({
        type: z.literal("http"),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).default({}),
        tools: z.array(z.string()).optional(),
    }),
]);
export type McpServerSpec = z.infer<typeof McpServerSpec>;

export const SubAgentSpec = z.object({
    name: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
    description: z.string().default(""),
    prompt: z.string().min(1),
    tools: z.array(z.string()).optional(),
    model: z.string().optional(),
});
export type SubAgentSpec = z.infer<typeof SubAgentSpec>;

/** Run on your own model-provider key instead of a Copilot subscription. */
export const ModelProvider = z.object({
    type: z.enum(["openai", "azure", "anthropic"]).default("openai").describe("openai covers any OpenAI-compatible endpoint, including local ones"),
    baseUrl: z.string().url().describe("API endpoint, e.g. https://api.openai.com/v1"),
    /** Name of the vault secret holding the API key. Empty for an endpoint that needs none. */
    secretName: z.string().default(""),
    wireApi: z.enum(["completions", "responses"]).optional(),
});
export type ModelProvider = z.infer<typeof ModelProvider>;

export const AgentSpec = z.object({
    instructions: z.string().default(""),
    model: z.string().default("auto"),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    /** Which runtime executes runs. `simulated` needs no Copilot access and is deterministic. */
    runtime: z.enum(["copilot", "simulated"]).default("simulated"),
    /** Copilot runtime only: use this provider and key instead of Copilot's own models. */
    provider: ModelProvider.optional(),
    /** How the mock runtime behaves for this agent. Ignored by real runtimes. */
    mock: z
        .object({
            /** A scenario name from system.mock_scenarios, or `random` for a seeded mix. */
            scenario: z.string().default("auto"),
            /** Playback speed: 1 is real-time-ish, 4 is four times faster. */
            speed: z.number().min(0.1).max(20).default(1),
        })
        .default({ scenario: "auto", speed: 1 }),
    /** Built-in runtime tools to enable. Empty means none (the runtime runs in `mode: "empty"`). */
    tools: z.array(z.string()).default([]),
    mcpServers: z.record(z.string(), McpServerSpec).default({}),
    subAgents: z.array(SubAgentSpec).default([]),
    policy: z
        .object({
            autonomy: Autonomy.default("propose"),
            /** Evaluated top to bottom, first match wins; falls back to the autonomy preset. */
            rules: z.array(PolicyRule).default([]),
            approvalTimeoutSeconds: z.number().int().min(10).max(86_400).default(900),
        })
        .default({ autonomy: "propose", rules: [], approvalTimeoutSeconds: 900 }),
    budget: z
        .object({
            maxAiCredits: z.number().min(MIN_AI_CREDITS).default(MIN_AI_CREDITS),
            timeoutSeconds: z.number().int().min(10).max(86_400).default(600),
        })
        .default({ maxAiCredits: MIN_AI_CREDITS, timeoutSeconds: 600 }),
    /** Optional JSON Schema the final answer must satisfy. */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type AgentSpec = z.infer<typeof AgentSpec>;
export type AgentSpecInput = z.input<typeof AgentSpec>;

export const Agent = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    activeRevisionId: z.string(),
    archived: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Agent = z.infer<typeof Agent>;

export const Revision = z.object({
    id: z.string(),
    agentId: z.string(),
    number: z.number().int(),
    spec: AgentSpec,
    note: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
});
export type Revision = z.infer<typeof Revision>;

export const RunStatus = z.enum(["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;
export const TERMINAL_STATUSES: RunStatus[] = ["succeeded", "failed", "cancelled"];

export const RunUsage = z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    credits: z.number(),
    modelCalls: z.number(),
    toolCalls: z.number(),
});
export type RunUsage = z.infer<typeof RunUsage>;
export const emptyUsage = (): RunUsage => ({ inputTokens: 0, outputTokens: 0, credits: 0, modelCalls: 0, toolCalls: 0 });

export const RunSource = z.object({
    kind: z.enum(["manual", "mcp", "schedule", "webhook", "replay", "agent", "work"]),
    /** Set when the run is an attempt at a work item (a ticket). */
    workItemId: z.string().optional(),
    triggerId: z.string().optional(),
    replayOf: z.string().optional(),
    actor: z.string().optional(),
});
export type RunSource = z.infer<typeof RunSource>;

export const Run = z.object({
    id: z.string(),
    agentId: z.string(),
    revisionId: z.string(),
    revisionNumber: z.number().int(),
    status: RunStatus,
    source: RunSource,
    prompt: z.string(),
    /** Raw trigger payload, kept so the run can be replayed against another revision. */
    payload: z.unknown().optional(),
    output: z.string().nullable(),
    error: z.string().nullable(),
    sessionId: z.string().nullable(),
    usage: RunUsage,
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

export const RunEvent = z.object({
    runId: z.string(),
    seq: z.number().int(),
    ts: z.string(),
    /** SDK event type (`assistant.message`, `tool.execution_start`, …) or a `foreman.*` event. */
    type: z.string(),
    data: z.unknown(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const Approval = z.object({
    id: z.string(),
    runId: z.string(),
    agentId: z.string(),
    kind: z.string(),
    toolName: z.string().nullable(),
    summary: z.string(),
    request: z.unknown(),
    status: z.enum(["pending", "approved", "denied", "expired"]),
    decidedBy: z.string().nullable(),
    reason: z.string().nullable(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

export const TriggerConfig = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("schedule"),
        cron: z.string().min(1).describe("Cron expression, e.g. `0 8 * * 1-5`"),
        timezone: z.string().default("UTC"),
    }),
    z.object({
        kind: z.literal("webhook"),
        /** Optional dot-path into the payload; runs with the same key never overlap. */
        concurrencyKey: z.string().optional(),
    }),
]);
export type TriggerConfig = z.infer<typeof TriggerConfig>;

export const Trigger = z.object({
    id: z.string(),
    agentId: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    config: TriggerConfig,
    /** Prompt sent to the agent. `{{payload}}` and `{{payload.some.path}}` are substituted. */
    promptTemplate: z.string(),
    secret: z.string(),
    lastFiredAt: z.string().nullable(),
    createdAt: z.string(),
});
export type Trigger = z.infer<typeof Trigger>;

export const AuditEntry = z.object({
    id: z.number().int(),
    ts: z.string(),
    actor: z.string(),
    capability: z.string(),
    input: z.unknown(),
    ok: z.boolean(),
    error: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ── Work queue ─────────────────────────────────────────────────────────────

/** A ticket as Foreman sees it, whatever system it came from. */
export const Ticket = z.object({
    source: z.literal("jira").default("jira"),
    key: z.string(),
    url: z.string(),
    title: z.string(),
    description: z.string().default(""),
    type: z.string().default("Task"),
    priority: z.string().default("Medium"),
    labels: z.array(z.string()).default([]),
    project: z.string(),
    reporter: z.string().nullable().default(null),
    status: z.string().default("To Do"),
    updatedAt: z.string(),
});
export type Ticket = z.infer<typeof Ticket>;

export const WorkState = z.enum(["inbox", "queued", "working", "needs_you", "review", "done", "failed", "skipped"]);
export type WorkState = z.infer<typeof WorkState>;
export const ACTIVE_WORK_STATES: WorkState[] = ["working", "needs_you"];

export const WorkItem = z.object({
    id: z.string(),
    ticket: Ticket,
    state: WorkState,
    agentId: z.string().nullable(),
    ruleId: z.string().nullable(),
    /** Stop in "review" for a human check instead of going straight to done. */
    review: z.boolean(),
    /** A held item keeps its place in the queue but is not started. */
    held: z.boolean(),
    /** Queue order, lowest first. Defaults to priority then arrival; changes when someone reorders. */
    rank: z.number(),
    attempts: z.number().int(),
    /** The current or most recent attempt. */
    runId: z.string().nullable(),
    progress: z.object({ step: z.number(), total: z.number(), message: z.string() }).nullable(),
    /** Why it is waiting or why it failed, in one line. */
    note: z.string().nullable(),
    receivedAt: z.string(),
    queuedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
});
export type WorkItem = z.infer<typeof WorkItem>;

export const RoutingMatch = z.object({
    project: z.string().optional().describe("Jira project key, e.g. PAY"),
    type: z.string().optional().describe("Issue type, e.g. Bug"),
    label: z.string().optional().describe("A label the ticket must carry"),
    priority: z.string().optional().describe("Priority name, e.g. High"),
});
export type RoutingMatch = z.infer<typeof RoutingMatch>;

export const RoutingRule = z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    /** Rules are tried in this order; the first match wins. */
    position: z.number().int(),
    match: RoutingMatch,
    agentId: z.string(),
    review: z.boolean(),
    /** Prompt for the agent. `{{payload.key}}`, `{{payload.title}}`, `{{payload}}` insert ticket data. */
    promptTemplate: z.string(),
    createdAt: z.string(),
});
export type RoutingRule = z.infer<typeof RoutingRule>;

export const JiraAuth = z.object({
    /** `basic` is Jira Cloud (email + API token); `bearer` is a personal access token (Data Center). */
    type: z.enum(["none", "basic", "bearer"]).default("none"),
    email: z.string().default(""),
    /** Name of the vault secret holding the token. The token itself is never stored here. */
    secretName: z.string().default(""),
});
export type JiraAuth = z.infer<typeof JiraAuth>;

/** What Foreman itself writes to a ticket as it moves through the queue. Off until switched on. */
export const JiraWriteBack = z.object({
    enabled: z.boolean().default(false),
    commentOnStart: z.boolean().default(true),
    commentOnDone: z.boolean().default(true),
    commentOnFailed: z.boolean().default(true),
    commentOnQuestion: z.boolean().default(true),
    /** Status to move the ticket to at each point. Empty leaves the status alone. */
    statusStarted: z.string().default(""),
    statusReview: z.string().default(""),
    statusDone: z.string().default(""),
    statusFailed: z.string().default(""),
});
export type JiraWriteBack = z.infer<typeof JiraWriteBack>;

export const JiraSettings = z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default(""),
    flavor: z.enum(["cloud", "datacenter"]).default("cloud"),
    auth: JiraAuth.prefault({}),
    writeBack: JiraWriteBack.prefault({}),
    /** Which tickets Foreman takes. Keep it an explicit opt-in such as a label. */
    jql: z.string().default("labels = foreman AND status != Done"),
    pollSeconds: z.number().int().min(2).max(3600).default(60),
    /** How many tickets one agent works on at once. */
    wipPerAgent: z.number().int().min(1).max(50).default(2),
    /** Attempts per ticket before it stops in "failed" (transient failures only). */
    maxAttempts: z.number().int().min(1).max(10).default(2),
});
export type JiraSettings = z.infer<typeof JiraSettings>;

export const DEFAULT_TICKET_PROMPT = `Work on Jira ticket {{payload.key}}: {{payload.title}}

Type: {{payload.type}} · Priority: {{payload.priority}} · Labels: {{payload.labels}}

{{payload.description}}`;
