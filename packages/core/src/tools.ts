import { z, type ZodType } from "zod";
import type { JiraClient } from "./jira.ts";
import type { Run } from "./schemas.ts";

/** What a Foreman tool can reach while it runs for one run. */
export interface ToolContext {
    run: Run;
    emit(type: string, data: unknown): void;
    /** Put a question to a person and wait. Null when nobody answered in time. */
    ask(question: string): Promise<string | null>;
    jira(): JiraClient;
}

export interface ForemanTool<I extends ZodType = ZodType> {
    name: string;
    title: string;
    description: string;
    /** `read` and `custom-tool` go through the agent's guardrails; `internal` tools only talk to Foreman. */
    kind: "read" | "custom-tool" | "internal";
    input: I;
    /** One line a person can approve from. */
    summary(args: z.output<I>): string;
    handler(ctx: ToolContext, args: z.output<I>): Promise<string>;
}
const tool = <I extends ZodType>(t: ForemanTool<I>) => t as unknown as ForemanTool;

const Key = z.string().min(1).describe("Ticket key, e.g. PAY-123");
const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Tools Foreman itself gives to agents, on any runtime. Progress and questions are always there;
 * the Jira tools are switched on per agent, and the ones that change a ticket obey its guardrails
 * (`jira_transition → ask` is a one-line rule).
 */
export const FOREMAN_TOOLS: ForemanTool[] = [
    tool({
        name: "report_progress",
        title: "Report progress",
        description: "Tell the people watching how far along the task is. Call it at each stage of a longer job.",
        kind: "internal",
        input: z.object({ step: z.number().int().min(0), total: z.number().int().min(1), message: z.string().min(1).max(200) }),
        summary: (a) => `${a.step} of ${a.total}: ${a.message}`,
        handler: async (ctx, a) => {
            ctx.emit("foreman.progress", { step: Math.min(a.step, a.total), total: a.total, message: a.message });
            return "Noted.";
        },
    }),
    tool({
        name: "ask_for_info",
        title: "Ask a person",
        description: "Ask a person a question and wait for the answer. Use it when the task cannot be done safely without information you do not have. Ask one clear question.",
        kind: "internal",
        input: z.object({ question: z.string().min(3).max(2000) }),
        summary: (a) => clip(a.question),
        handler: async (ctx, a) => {
            const answer = await ctx.ask(a.question);
            if (answer === null) throw new Error("Nobody answered in time.");
            return answer;
        },
    }),
    tool({
        name: "jira_get_issue",
        title: "Jira: read a ticket",
        description: "Read a Jira ticket: fields, status and its most recent comments.",
        kind: "read",
        input: z.object({ key: Key }),
        summary: (a) => a.key,
        handler: async (ctx, a) => JSON.stringify(await ctx.jira().getIssueWithComments(a.key), null, 1),
    }),
    tool({
        name: "jira_search",
        title: "Jira: search",
        description: "Find Jira tickets with a JQL query. Returns key, title, type, priority and status.",
        kind: "read",
        input: z.object({ jql: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) }),
        summary: (a) => clip(a.jql),
        handler: async (ctx, a) => {
            const tickets = await ctx.jira().search(a.jql, undefined, a.limit);
            return tickets.length ? tickets.map((t) => `${t.key} [${t.status}] ${t.type}/${t.priority}: ${t.title}`).join("\n") : "No tickets match.";
        },
    }),
    tool({
        name: "jira_add_comment",
        title: "Jira: comment",
        description: "Add a comment to a Jira ticket.",
        kind: "custom-tool",
        input: z.object({ key: Key, text: z.string().min(1).max(8000) }),
        summary: (a) => `${a.key}: ${clip(a.text, 100)}`,
        handler: async (ctx, a) => {
            await ctx.jira().addComment(a.key, a.text);
            return `Comment added to ${a.key}.`;
        },
    }),
    tool({
        name: "jira_transition",
        title: "Jira: change status",
        description: "Move a Jira ticket to another status, e.g. In Progress or Done.",
        kind: "custom-tool",
        input: z.object({ key: Key, status: z.string().min(1).describe("Target status or transition name") }),
        summary: (a) => `${a.key} → ${a.status}`,
        handler: async (ctx, a) => {
            const to = await ctx.jira().transition(a.key, a.status);
            return to ? `${a.key} is now ${to}.` : `${a.key} was already ${a.status}.`;
        },
    }),
    tool({
        name: "jira_create_subtask",
        title: "Jira: create a subtask",
        description: "Create a subtask under a Jira ticket.",
        kind: "custom-tool",
        input: z.object({ parentKey: Key, summary: z.string().min(1).max(250), description: z.string().max(8000).default("") }),
        summary: (a) => `under ${a.parentKey}: ${clip(a.summary, 90)}`,
        handler: async (ctx, a) => {
            const created = await ctx.jira().createSubtask(a.parentKey, a.summary, a.description);
            return `Created ${created.key} (${created.url}).`;
        },
    }),
];

export const foremanTool = (name: string) => FOREMAN_TOOLS.find((t) => t.name === name);
/** Whether an agent may call a Foreman tool: internal ones always, the rest when switched on. */
export const toolEnabled = (t: ForemanTool, enabled: string[]) => t.kind === "internal" || enabled.includes(t.name);

export interface ToolInfo {
    name: string;
    title: string;
    description: string;
    kind: ForemanTool["kind"];
    parameters: Record<string, unknown>;
    /** Arguments a simulated run calls the tool with. */
    example?: Record<string, unknown>;
}
export const toolInfo = (t: ForemanTool): ToolInfo => ({ name: t.name, title: t.title, description: t.description, kind: t.kind, parameters: z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown> });
