import { setTimeout as sleep } from "node:timers/promises";
import { permissionKindForTool, type RuntimeAdapter, type RuntimeExecution, type RuntimeResult } from "./runtime.ts";
import type { AgentSpec, Run } from "./schemas.ts";
import { foremanTool } from "./tools.ts";

/**
 * One beat of a scripted run. Steps emit the same event types the Copilot SDK does, and tool steps
 * go through the real policy and approval path, so everything downstream behaves as it would live.
 */
export type MockStep =
    | { do: "think"; intent: string }
    | { do: "tool"; tool: string; kind?: string; args?: Record<string, unknown>; result?: string; fail?: string; beats?: number }
    | { do: "progress"; step: number; total: number; message: string }
    | { do: "subagent"; name: string; steps: MockStep[] }
    | { do: "usage"; inputTokens: number; outputTokens: number; cost: number }
    | { do: "wait"; beats: number }
    /** Never returns: the run ends only when its time limit or a cancel stops it. */
    | { do: "hang" }
    | { do: "say"; content: string }
    /** Ask a person through ask_for_info, then carry on with whichever branch applies. */
    | { do: "ask"; question: string; answered: (answer: string) => MockStep[]; unanswered: MockStep[] }
    | { do: "fail"; error: string };

export interface MockContext {
    run: Run;
    spec: AgentSpec;
}
export interface MockScenario {
    name: string;
    title: string;
    description: string;
    /** Build the script for one run. The last `say` is the run's result unless `output` is given. */
    script(ctx: MockContext): MockStep[];
    /** Override the result, e.g. to return something that breaks the output schema. */
    output?(ctx: MockContext): string;
}

const usage = (inputTokens: number, outputTokens: number, cost: number): MockStep => ({ do: "usage", inputTokens, outputTokens, cost });
const subject = (run: Run) => run.prompt.split("\n")[0]!.slice(0, 70);
/** The ticket a run is about: from the work queue's payload, else the first key in the prompt. */
const ticketKey = (run: Run): string | undefined => (run.payload as { key?: string } | undefined)?.key ?? /\b[A-Z][A-Z0-9]+-\d+\b/.exec(run.prompt)?.[0];

/** Foreman's own tools validate their arguments, so the "auto" scenario has to call them with real ones. */
function foremanToolArgs(tool: string, run: Run): Record<string, unknown> | undefined {
    const key = ticketKey(run) ?? "DEMO-1";
    switch (tool) {
        case "jira_get_issue":
            return { key };
        case "jira_search":
            return { jql: "status != Done", limit: 5 };
        case "jira_add_comment":
            return { key, text: `Simulated comment on ${key}: ${subject(run)}` };
        case "jira_create_subtask":
            return { parentKey: key, summary: "Simulated subtask", description: "Created by the simulator." };
        case "jira_transition":
            return { key, status: "In Review" };
        case "report_progress":
            return { step: 1, total: 1, message: "Working on it" };
        case "ask_for_info":
            return { question: "Is there anything else I should know before I start?" };
    }
    if (tool.startsWith("pp_")) return ppToolArgs(tool, run);
    return undefined;
}

/** A "Field: value" line from the request, as platform tickets are written ("Environment: HR Dev"). */
const field = (run: Run, name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "im").exec(run.prompt)?.[1];

/** Arguments for the Power Platform tools against the practice tenant, taken from the request where it says. */
function ppToolArgs(tool: string, run: Run): Record<string, unknown> | undefined {
    const environment = field(run, "Environment") ?? "HR Dev";
    const user = field(run, "User") ?? "carla.ruiz@contoso.test";
    const role = field(run, "Role") ?? "Environment Maker";
    switch (tool) {
        case "pp_env_list":
        case "pp_env_groups":
            return {};
        case "pp_env_get":
        case "pp_backups":
        case "pp_settings_get":
        case "pp_env_roles":
        case "pp_env_managed":
        case "pp_env_reset":
        case "pp_env_delete":
            return { environment };
        case "pp_operations":
            return { environment };
        case "pp_env_users":
            return { environment, user };
        case "pp_api_get":
            return { path: "/environmentmanagement/environmentGroups" };
        case "pp_env_backup":
            return { environment, label: `Simulated backup for ${ticketKey(run) ?? "a test run"}` };
        case "pp_env_create":
            return { name: field(run, "Name") ?? "Simulated sandbox", type: field(run, "Environment type") ?? "Sandbox", ...(field(run, "Group") ? { group: field(run, "Group") } : {}) };
        case "pp_env_add_to_group":
            return { environment, group: field(run, "Group") ?? "Sandboxes" };
        case "pp_access_grant":
        case "pp_access_revoke":
            return { environment, user, role };
        case "pp_env_copy":
            return { source: field(run, "Source") ?? "Finance Production", target: field(run, "Target") ?? "Finance Test" };
        case "pp_env_restore":
            return { environment, pointInTime: new Date(Date.now() - 86_400_000).toISOString() };
    }
    return undefined;
}
const pp = (tool: string, run: Run, extra: Record<string, unknown> = {}): MockStep => ({ do: "tool", tool, args: { ...ppToolArgs(tool, run), ...extra } });
const commentOn = (run: Run, text: string): MockStep[] => {
    const key = ticketKey(run);
    return key ? [{ do: "tool", tool: "jira_add_comment", args: { key, text } }] : [];
};

export const MOCK_SCENARIOS: MockScenario[] = [
    {
        name: "auto",
        title: "Follow the tool list",
        description: "Calls each tool switched on for the agent once, then answers. The default.",
        script: ({ run, spec }) => {
            const tools = [...spec.tools.map((tool) => ({ tool, kind: permissionKindForTool(tool) })), ...Object.keys(spec.mcpServers).map((s) => ({ tool: `${s}-call`, kind: "mcp" }))].slice(0, 4);
            const toolError = /\[tool-error\]/.test(run.prompt);
            return [
                { do: "think", intent: "Working out which tools the task needs" },
                ...tools.map((t): MockStep => ({ do: "tool", ...t, args: foremanToolArgs(t.tool, run) ?? { input: run.prompt.slice(0, 80) }, result: `Simulated result from ${t.tool}`, fail: toolError ? "Simulated tool failure (prompt contained [tool-error])" : undefined })),
                usage(400 + run.prompt.length + spec.instructions.length, 120 + tools.length * 40, 1 + tools.length * 0.5),
                ...(/\[fail\]/.test(run.prompt) ? [{ do: "fail", error: "Simulated failure (prompt contained [fail])" } as MockStep] : []),
                { do: "say", content: `Simulated run complete. ${tools.length ? `Used ${tools.map((t) => t.tool).join(", ")}.` : "No tools were needed."}` },
            ];
        },
    },
    {
        name: "happy",
        title: "Clean success",
        description: "Reads, plans, makes one edit, verifies and reports. Only read and write actions.",
        script: ({ run }) => [
            { do: "think", intent: "Reading the request and the relevant files" },
            { do: "progress", step: 1, total: 4, message: "Understanding the task" },
            { do: "tool", tool: "grep", args: { pattern: "TODO|FIXME", path: "src/" }, result: "src/billing/invoice.ts:88: // FIXME rounding\nsrc/billing/tax.ts:14: // TODO handle zero rate" },
            { do: "tool", tool: "view", args: { path: "src/billing/invoice.ts" }, result: "export function total(lines) { … } // 142 lines" },
            usage(2100, 310, 2.5),
            { do: "progress", step: 2, total: 4, message: "Making the change" },
            { do: "tool", tool: "edit", args: { path: "src/billing/invoice.ts", change: "round half-even at 2 decimals" }, result: "1 file changed, 6 insertions, 2 deletions", beats: 2 },
            { do: "progress", step: 3, total: 4, message: "Checking the result" },
            { do: "tool", tool: "view", args: { path: "src/billing/invoice.test.ts" }, result: "12 tests, all cover total()" },
            usage(3400, 420, 3),
            { do: "progress", step: 4, total: 4, message: "Writing up" },
            { do: "say", content: `Done: ${subject(run)}\n\nChanged src/billing/invoice.ts to round half-even at two decimals. Existing tests cover the function; no behaviour outside rounding changed.` },
        ],
    },
    {
        name: "needs-approval",
        title: "Stops for approval",
        description: "Does the work, then wants to run a shell command that pushes a branch — which most guardrails send to a person.",
        script: ({ run }) => [
            { do: "think", intent: "Preparing a fix on a branch" },
            { do: "tool", tool: "view", args: { path: "services/auth/session.ts" }, result: "Session expiry is compared in local time" },
            { do: "tool", tool: "edit", args: { path: "services/auth/session.ts", change: "compare expiry in UTC" }, result: "1 file changed" },
            usage(2600, 380, 3),
            { do: "progress", step: 2, total: 3, message: "Publishing the branch" },
            { do: "tool", tool: "shell", args: { command: "git push origin fix/session-expiry-utc" }, result: "branch 'fix/session-expiry-utc' pushed", beats: 2 },
            usage(1800, 220, 2),
            { do: "say", content: `Finished: ${subject(run)}\n\nSession expiry is now compared in UTC. If the push was approved the branch fix/session-expiry-utc is on the remote; if not, the change exists only in the workspace.` },
        ],
    },
    {
        name: "slow",
        title: "Long job with progress",
        description: "Eight reported stages over a longer stretch. Good for watching live progress.",
        script: ({ run }) => {
            const stages = ["Listing services", "Reading configs", "Checking dependencies", "Running the audit", "Comparing with last week", "Grouping findings", "Drafting the report", "Final checks"];
            return [
                { do: "think", intent: "This is a multi-stage job; reporting progress as I go" },
                ...stages.flatMap((message, i): MockStep[] => [
                    { do: "progress", step: i + 1, total: stages.length, message },
                    { do: "tool", tool: i % 3 === 2 ? "grep" : "view", args: { target: message.toLowerCase() }, result: `${3 + i} items examined`, beats: 3 },
                    ...(i % 3 === 2 ? [usage(1500 + i * 200, 180, 1.5)] : []),
                ]),
                { do: "say", content: `Completed: ${subject(run)}\n\n8 stages, 60 items examined, 3 findings worth a look: an expired certificate in staging, two services on an unsupported runtime.` },
            ];
        },
    },
    {
        name: "tool-failure",
        title: "A tool fails, agent recovers",
        description: "The first attempt at a tool errors; the agent tries another way and succeeds.",
        script: ({ run }) => [
            { do: "think", intent: "Fetching the latest build log" },
            { do: "tool", tool: "web_fetch", args: { url: "https://ci.example.test/builds/latest/log" }, fail: "HTTP 503 from ci.example.test after 3 retries" },
            usage(1200, 150, 1.5),
            { do: "think", intent: "The CI API is down; reading the cached log instead" },
            { do: "tool", tool: "view", args: { path: ".cache/ci/latest.log" }, result: "FAIL test/payments.spec.ts › refunds › partial refund rounds down" },
            usage(1900, 260, 2),
            { do: "say", content: `Done, with a detour: ${subject(run)}\n\nThe CI API returned 503, so I used the cached log. The failing test is "partial refund rounds down" in test/payments.spec.ts.` },
        ],
    },
    {
        name: "flaky",
        title: "Fails first, succeeds on replay",
        description: "The first attempt fails with a transient error. Replaying the run succeeds.",
        script: ({ run }) =>
            run.source.kind === "replay"
                ? [
                      { do: "think", intent: "Retrying the upstream call" },
                      { do: "tool", tool: "web_fetch", args: { url: "https://api.example.test/v2/orders?since=yesterday" }, result: "200 OK, 48 orders" },
                      usage(1400, 190, 1.5),
                      { do: "say", content: `Done on retry: ${subject(run)}\n\n48 orders fetched and summarised.` },
                  ]
                : [
                      { do: "think", intent: "Calling the orders API" },
                      { do: "tool", tool: "web_fetch", args: { url: "https://api.example.test/v2/orders?since=yesterday" }, fail: "ECONNRESET: socket hang up" },
                      usage(1300, 90, 1),
                      { do: "fail", error: "Upstream connection reset (ECONNRESET). This is usually transient — replay the run." },
                  ],
    },
    {
        name: "timeout",
        title: "Runs past the time limit",
        description: "Hangs on a tool until the agent's time limit stops it. Set a short time limit to see it quickly.",
        script: () => [
            { do: "think", intent: "Starting the full test suite" },
            { do: "tool", tool: "view", args: { path: "package.json" }, result: '"test": "vitest run"' },
            { do: "tool", tool: "view", args: { path: "vitest.config.ts" }, result: "testTimeout: 0" },
            { do: "hang" },
        ],
    },
    {
        name: "over-budget",
        title: "Hits the credit budget",
        description: "Keeps calling the model until it passes the agent's credit budget, then is stopped.",
        script: ({ spec }) => {
            const perCall = Math.ceil(spec.budget.maxAiCredits / 3);
            return [
                { do: "think", intent: "Reading the whole repository to be thorough" },
                ...[1, 2, 3, 4].flatMap((i): MockStep[] => [{ do: "tool", tool: "view", args: { path: `packages/module-${i}/` }, result: "214 files" }, usage(48_000, 900, perCall)]),
                { do: "fail", error: `AI Credits budget of ${spec.budget.maxAiCredits} reached (used ${perCall * 4}). Raise the budget or narrow the task.` },
            ];
        },
    },
    {
        name: "sub-agents",
        title: "Delegates to sub-agents",
        description: "Hands research and writing to two sub-agents, then combines their work.",
        script: ({ run }) => [
            { do: "think", intent: "Splitting this into research and writing" },
            { do: "subagent", name: "researcher", steps: [{ do: "tool", tool: "grep", args: { pattern: "deprecated", path: "." }, result: "17 matches in 6 files" }, { do: "tool", tool: "view", args: { path: "docs/migration.md" }, result: "Migration guide, last updated 14 months ago" }] },
            usage(2800, 340, 3),
            { do: "subagent", name: "writer", steps: [{ do: "tool", tool: "edit", args: { path: "docs/migration.md", change: "rewrite section 3" }, result: "1 file changed, 41 insertions, 28 deletions", beats: 2 }] },
            usage(3100, 520, 3.5),
            { do: "say", content: `Done: ${subject(run)}\n\nThe researcher found 17 deprecated usages in 6 files; the writer rewrote section 3 of docs/migration.md to cover them.` },
        ],
    },
    {
        name: "asks-question",
        title: "Asks a person a question",
        description: "Finds it cannot decide something on its own, asks through ask_for_info and waits. Continues with the answer, or fails if none comes.",
        script: ({ run }) => [
            { do: "think", intent: "Checking what the ticket leaves open" },
            { do: "tool", tool: "view", args: { path: "src/billing/refund.ts" }, result: "Refund totals are rounded in two places with different rules" },
            usage(1900, 240, 2),
            { do: "progress", step: 1, total: 3, message: "Waiting for an answer" },
            {
                do: "ask",
                question: "The API and the invoice round refunds differently. Which rule is correct: half-even (12.34) or half-up (12.35)?",
                answered: (answer) => [
                    { do: "progress", step: 2, total: 3, message: "Applying the answer" },
                    { do: "tool", tool: "edit", args: { path: "src/billing/refund.ts", change: `one rounding rule, as answered: ${answer.slice(0, 80)}` }, result: "1 file changed, 9 insertions, 7 deletions", beats: 2 },
                    usage(2400, 330, 2.5),
                    { do: "progress", step: 3, total: 3, message: "Writing up" },
                    { do: "say", content: `Done: ${subject(run)}\n\nI asked which rounding rule applies and was told: "${answer}". Both code paths now use that rule.` },
                ],
                unanswered: [{ do: "fail", error: "Nobody answered the question, and guessing a rounding rule for money is not safe. Retry once someone can answer." }],
            },
        ],
    },
    {
        name: "jira-updates",
        title: "Works in Jira",
        description: "Reads the ticket, creates two subtasks, comments its plan and moves the ticket to In Review — for real, against the configured Jira. Needs the Jira tools switched on for the agent.",
        script: ({ run }) => {
            const key = ticketKey(run);
            if (!key) return [{ do: "think", intent: "No ticket was named; listing open tickets instead" }, { do: "tool", tool: "jira_search", args: { jql: "status != Done", limit: 5 } }, usage(900, 120, 1), { do: "say", content: "No ticket was named in the request, so I only listed open tickets." }];
            return [
                { do: "think", intent: `Reading ${key} and its comments` },
                { do: "tool", tool: "jira_get_issue", args: { key } },
                usage(1700, 210, 2),
                { do: "progress", step: 1, total: 3, message: "Breaking the work down" },
                { do: "tool", tool: "jira_create_subtask", args: { parentKey: key, summary: "Change the code", description: "The smallest change that satisfies the ticket." } },
                { do: "tool", tool: "jira_create_subtask", args: { parentKey: key, summary: "Update the documentation", description: "Describe the new behaviour." } },
                { do: "progress", step: 2, total: 3, message: "Noting the plan on the ticket" },
                { do: "tool", tool: "jira_add_comment", args: { key, text: "Plan: two subtasks — the code change, then the documentation. Nothing else is affected." } },
                usage(2100, 300, 2.5),
                { do: "progress", step: 3, total: 3, message: "Handing over for review" },
                { do: "tool", tool: "jira_transition", args: { key, status: "In Review" } },
                { do: "say", content: `Planned: ${subject(run)}\n\nCreated two subtasks under ${key}, commented the plan and asked to move the ticket to In Review. Any step the guardrails refused is marked in the trace.` },
            ];
        },
    },
    {
        name: "pp-governance-report",
        title: "Power Platform: governance report",
        description: "Reads the tenant: environments, groups, idle sandboxes, people who have left, backups of production. Changes nothing. Needs the Power Platform read tools.",
        script: ({ run }) => [
            { do: "think", intent: "Listing environments and groups" },
            { do: "progress", step: 1, total: 3, message: "Reading the tenant" },
            pp("pp_env_list", run),
            pp("pp_env_groups", run),
            usage(1800, 240, 2),
            { do: "progress", step: 2, total: 3, message: "Checking sandboxes and people" },
            pp("pp_env_get", run, { environment: "Sales Old" }),
            pp("pp_env_users", run, { environment: "Sales Old", user: undefined }),
            pp("pp_backups", run, { environment: "Finance Production" }),
            usage(2400, 380, 2.5),
            { do: "progress", step: 3, total: 3, message: "Writing the report" },
            {
                do: "say",
                content:
                    "Governance report\n\n- Sales Old: sandbox in no group, created long ago — candidate for removal; ask its owner first.\n- Erik Nyman's account is disabled but still holds Environment Maker in several environments — review and take the role away.\n- Finance Production has recent system backups.\n- Mika Developer is outside every group; consider the Sandboxes group.",
            },
        ],
    },
    {
        name: "pp-environment-request",
        title: "Power Platform: environment request",
        description: "Creates the environment a ticket asks for (Name:, Environment type:, Group: lines), then comments on the ticket. Creating needs approval under the template's guardrails.",
        script: ({ run }) => {
            const name = field(run, "Name") ?? "Simulated sandbox";
            return [
                { do: "think", intent: `Checking that “${name}” does not exist yet` },
                pp("pp_env_list", run, { search: name }),
                usage(1400, 200, 1.5),
                { do: "progress", step: 1, total: 2, message: "Creating the environment" },
                pp("pp_env_create", run),
                usage(1200, 160, 1),
                { do: "progress", step: 2, total: 2, message: "Telling the requester" },
                ...commentOn(run, `Created the environment “${name}”${field(run, "Group") ? ` in group ${field(run, "Group")}` : ""}. If any step was refused, the reason is in Foreman's trace.`),
                { do: "say", content: `Environment request handled: “${name}”. Anything the guardrails refused is marked in the trace.` },
            ];
        },
    },
    {
        name: "pp-access-request",
        title: "Power Platform: access request",
        description: "Gives the person named in the ticket (User:, Environment:, Role: lines) the role asked for, then comments on the ticket.",
        script: ({ run }) => [
            { do: "think", intent: "Checking the person's current roles" },
            pp("pp_env_users", run),
            usage(1100, 150, 1),
            pp("pp_access_grant", run),
            ...commentOn(run, `Access: ${field(run, "User") ?? "the requester"} → ${field(run, "Role") ?? "the role asked for"} in ${field(run, "Environment") ?? "the environment"}.`),
            { do: "say", content: "Access request handled. Whether the role was given, or why not, is in the trace." },
        ],
    },
    {
        name: "pp-maintenance",
        title: "Power Platform: back up, then reset",
        description: "Backs up the environment named in the ticket, then resets it. Reset is destructive: denied unless a guardrail rule allows or asks.",
        script: ({ run }) => [
            { do: "think", intent: "Reading the environment and its backups first" },
            pp("pp_env_get", run),
            pp("pp_backups", run),
            usage(1300, 180, 1.5),
            { do: "progress", step: 1, total: 2, message: "Taking a backup" },
            pp("pp_env_backup", run),
            { do: "progress", step: 2, total: 2, message: "Resetting" },
            pp("pp_env_reset", run),
            usage(900, 140, 1),
            ...commentOn(run, `Maintenance on ${field(run, "Environment") ?? "the environment"}: backup taken, then reset (unless the guardrails stopped it — see Foreman's trace).`),
            { do: "say", content: "Backed up the environment and asked to reset it. A refused step is marked in the trace." },
        ],
    },
    {
        name: "bad-output",
        title: "Returns the wrong shape",
        description: "Answers in prose although the agent has a result shape. Fails validation when a result shape is set.",
        script: () => [{ do: "think", intent: "Summarising" }, usage(900, 140, 1), { do: "say", content: "Sure! Here is a summary of what I found, in plain words rather than the JSON you asked for." }],
        output: () => "Sure! Here is a summary of what I found, in plain words rather than the JSON you asked for.",
    },
];

const RANDOM_POOL = ["happy", "happy", "happy", "needs-approval", "slow", "tool-failure", "flaky", "sub-agents"];
function hash(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

/** Which scenario a run plays: a `[mock:name]` tag in the prompt wins, then the agent's setting. */
export function pickScenario(run: Run, spec: AgentSpec): MockScenario {
    // Matches both a "[mock:name]" tag and a "mock:name" ticket label rendered into the prompt.
    const tagged = /\bmock:([\w-]+)/.exec(run.prompt)?.[1];
    let name = tagged ?? spec.mock.scenario;
    // "random" is seeded by the run's prompt and creation time, so a given run always plays the same way.
    if (name === "random") name = RANDOM_POOL[hash(run.prompt + run.createdAt) % RANDOM_POOL.length]!;
    return MOCK_SCENARIOS.find((s) => s.name === name) ?? MOCK_SCENARIOS[0]!;
}

/**
 * The mock runtime: plays a scripted scenario instead of calling a model. It needs no Copilot
 * access and costs nothing, yet exercises policy, approvals, budgets, traces and triggers for real.
 */
export class SimulatedRuntime implements RuntimeAdapter {
    readonly name = "simulated";
    /** @param beatMs Length of one beat at speed 1. Tests pass 0 to run instantly. */
    constructor(private beatMs = 350) {}

    async status() {
        return { ok: true, detail: `Mock runtime with ${MOCK_SCENARIOS.length} scripted scenarios. No model is called; output is synthetic.` };
    }
    async listModels() {
        return [{ id: "auto", label: "Auto (mock)" }];
    }

    async execute(x: RuntimeExecution): Promise<RuntimeResult> {
        const { spec, run, emit, signal } = x;
        const scenario = pickScenario(run, spec);
        const beat = this.beatMs / Math.max(spec.mock.speed, 0.1);
        const pause = (beats = 1) => (this.beatMs ? sleep(beat * beats, undefined, { signal }) : Promise.resolve());
        const sessionId = `mock-${run.id}`;
        let calls = 0;
        let last = "";

        const play = async (steps: MockStep[], parent?: string): Promise<void> => {
            for (const step of steps) {
                signal.throwIfAborted();
                switch (step.do) {
                    case "think":
                        emit("assistant.intent", { intent: step.intent });
                        await pause();
                        break;
                    case "progress":
                        emit("foreman.progress", { step: step.step, total: step.total, message: step.message });
                        break;
                    case "hang":
                        await new Promise<never>((_resolve, reject) => {
                            if (signal.aborted) return reject(signal.reason);
                            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                        });
                        break;
                    case "wait":
                        await pause(step.beats);
                        break;
                    case "usage":
                        emit("assistant.usage", { model: spec.model, inputTokens: step.inputTokens, outputTokens: step.outputTokens, cost: step.cost, simulated: true });
                        break;
                    case "say":
                        last = step.content;
                        break;
                    case "fail":
                        throw new Error(step.error);
                    case "subagent": {
                        const toolCallId = `call_${++calls}`;
                        emit("subagent.started", { toolCallId, agentName: step.name });
                        await play(step.steps, toolCallId);
                        emit("subagent.completed", { toolCallId, agentName: step.name, summary: `${step.steps.length} steps` });
                        break;
                    }
                    case "ask": {
                        const toolCallId = `call_${++calls}`;
                        emit("tool.execution_start", { toolCallId, toolName: "ask_for_info", arguments: { question: step.question }, parentToolCallId: parent });
                        const reply = await x.tools.call("ask_for_info", { question: step.question });
                        emit("tool.execution_complete", reply.ok ? { toolCallId, toolName: "ask_for_info", success: true, result: { content: reply.content } } : { toolCallId, toolName: "ask_for_info", success: false, error: { message: reply.content } });
                        await play(reply.ok ? step.answered(reply.content) : step.unanswered, parent);
                        break;
                    }
                    case "tool": {
                        const toolCallId = `call_${++calls}`;
                        const args = step.args ?? {};
                        if (foremanTool(step.tool)) {
                            // One of Foreman's own tools: really call it, guardrails included.
                            emit("tool.execution_start", { toolCallId, toolName: step.tool, arguments: args, parentToolCallId: parent });
                            await pause(step.beats ?? 1);
                            const reply = await x.tools.call(step.tool, args);
                            emit("tool.execution_complete", reply.ok ? { toolCallId, toolName: step.tool, success: true, result: { content: reply.content } } : { toolCallId, toolName: step.tool, success: false, error: { message: reply.content } });
                            break;
                        }
                        const kind = step.kind ?? permissionKindForTool(step.tool);
                        const preview = Object.values(args)[0];
                        const verdict = await x.authorize({ kind, toolName: step.tool, summary: `${kind}: ${step.tool === kind ? "" : step.tool}${preview !== undefined ? ` ${typeof preview === "string" ? preview : JSON.stringify(preview)}` : ""}`.slice(0, 160), request: { kind, toolName: step.tool, arguments: args } });
                        emit("tool.execution_start", { toolCallId, toolName: step.tool, arguments: args, parentToolCallId: parent });
                        await pause(step.beats ?? 1);
                        if (!verdict.allowed) emit("tool.execution_complete", { toolCallId, toolName: step.tool, success: false, error: { message: `Permission denied: ${verdict.reason}` } });
                        else if (step.fail) emit("tool.execution_complete", { toolCallId, toolName: step.tool, success: false, error: { message: step.fail } });
                        else emit("tool.execution_complete", { toolCallId, toolName: step.tool, success: true, result: { content: step.result ?? "ok" } });
                        break;
                    }
                }
            }
        };

        emit("session.start", { sessionId, model: spec.model, simulated: true, scenario: scenario.name });
        emit("user.message", { content: run.prompt, source: `automation-${run.source.kind}` });
        emit("assistant.turn_start", { turnId: "1" });
        await play(scenario.script({ run, spec }));

        const output = scenario.output?.({ run, spec }) ?? (spec.outputSchema ? JSON.stringify(sampleFromSchema(spec.outputSchema)) : `${last}\n\n(Mock scenario "${scenario.name}" — no model was called.)`);
        emit("assistant.message", { content: output });
        emit("assistant.turn_end", { turnId: "1" });
        emit("session.idle", {});
        return { output, sessionId };
    }
}

/** Build a minimal value that satisfies a JSON Schema, for mock structured output. */
export function sampleFromSchema(schema: any): unknown {
    if (!schema || typeof schema !== "object") return null;
    if (schema.enum?.length) return schema.enum[0];
    switch (schema.type) {
        case "object":
            return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sampleFromSchema(v)]));
        case "array":
            return [];
        case "number":
        case "integer":
            return 0;
        case "boolean":
            return false;
        case "string":
            return "simulated";
        default:
            return null;
    }
}

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
/**
 * Answer one OpenAI-style chat-completions request the way a very predictable model would: call
 * each offered tool once (never ask_for_info, which would wait for a person), then say what it
 * did. It lets the real Copilot runtime — sessions, tools, permissions — run without any model key.
 */
export function mockModelReply(body: any): { message: Record<string, unknown>; finish: "stop" | "tool_calls" } {
    const messages: any[] = body?.messages ?? [];
    const tools: any[] = (body?.tools ?? []).map((t: any) => t.function ?? t).filter((t: any) => t?.name && t.name !== "ask_for_info");
    const called = new Set(messages.flatMap((m) => (m.tool_calls ?? []).map((c: any) => c.function?.name)));
    const next = tools.slice(0, 4).find((t) => !called.has(t.name));
    if (next) {
        const text = messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
        const key = TICKET_KEY.exec(text)?.[0];
        const args = (sampleFromSchema(next.parameters ?? { type: "object" }) ?? {}) as Record<string, unknown>;
        for (const name of Object.keys(args)) {
            if (key && /key$/i.test(name)) args[name] = key;
            else if (name === "total") args[name] = 1;
            else if (name === "jql") args[name] = "status != Done";
        }
        return { message: { role: "assistant", content: null, tool_calls: [{ id: `call_${called.size + 1}`, type: "function", function: { name: next.name, arguments: JSON.stringify(args) } }] }, finish: "tool_calls" };
    }
    const schema = body?.response_format?.json_schema?.schema;
    const content = schema ? JSON.stringify(sampleFromSchema(schema)) : `Mock model finished. ${called.size ? `Called ${[...called].join(", ")}.` : "No tools were offered."} (No real model was used.)`;
    return { message: { role: "assistant", content }, finish: "stop" };
}
