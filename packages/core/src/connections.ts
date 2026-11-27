import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServerSpec, type AgentSpec, type PolicyRule } from "./schemas.ts";
import type { PolicyDecision } from "./policy.ts";
import type { Bus } from "./registry.ts";
import type { Store } from "./store.ts";

/**
 * Connections are the tools agents use — an MCP server, a command-line tool or Foreman's Jira
 * tools — set up once and switched on per agent. Their rules travel with them, so every agent
 * that uses "Azure CLI" gets the same guardrails for `az` without anyone writing them twice.
 */

/** Command-line rules are word patterns: `az * list` matches `az group list --output table`. */
export const ConnectionRules = z.object({
    allow: z.array(z.string().min(1)).default([]),
    ask: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
});
export type ConnectionRules = z.infer<typeof ConnectionRules>;

export const CliConfig = z.object({
    /** The program to run, e.g. `az`. Found on the server's PATH. */
    command: z.string().min(1).regex(/^[\w.\-\\/: ]+$/, "a program name or path, without arguments"),
    /** Extra environment for the program. Values may hold `{{secret:NAME}}` and `{{connection_home}}`. */
    env: z.record(z.string(), z.string()).default({}),
    /** Arguments for the Test button and for simulated runs, e.g. `["version"]`. */
    testArgs: z.array(z.string()).default(["--version"]),
    timeoutSeconds: z.number().int().min(5).max(1800).default(120),
});
export type CliConfig = z.infer<typeof CliConfig>;

export const JiraAccess = z.object({ writes: z.boolean().default(false) });

export const ConnectionKind = z.enum(["mcp", "cli", "jira"]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export const ConnectionInput = z.object({
    name: z.string().min(1).max(60),
    description: z.string().max(500).default(""),
    kind: ConnectionKind,
    preset: z.string().nullable().default(null),
    mcp: McpServerSpec.optional(),
    cli: CliConfig.optional(),
    jira: JiraAccess.optional(),
    rules: ConnectionRules.prefault({}),
    /** What a person has to do once, outside Foreman, e.g. sign in. Shown on the connection. */
    setupNote: z.string().max(2000).default(""),
});
export type ConnectionInput = z.infer<typeof ConnectionInput>;

export type Connection = ConnectionInput & { id: string; key: string; createdAt: string; updatedAt: string };

/** Foreman's Jira tools that change a ticket. */
const JIRA_WRITE_TOOLS = ["jira_add_comment", "jira_create_subtask", "jira_transition"];
const JIRA_READ_TOOLS = ["jira_get_issue", "jira_search"];

// ── Presets ────────────────────────────────────────────────────────────────

export interface PresetField {
    key: string;
    label: string;
    hint?: string;
    /** `secret` holds the name of a stored secret; the form stores the value first. */
    type: "text" | "secret" | "boolean";
    required?: boolean;
    default?: string | boolean;
    placeholder?: string;
}

export interface ConnectionPreset {
    id: string;
    name: string;
    kind: ConnectionKind;
    description: string;
    /** What has to be on the server for it to work. */
    needs: string;
    fields: PresetField[];
    build(values: Record<string, string | boolean | undefined>): Omit<ConnectionInput, "name" | "kind" | "preset">;
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v.trim() : "");
const secretRef = (name: string) => `{{secret:${name}}}`;
const optionalEnv = (pairs: [string, string][]): Record<string, string> => Object.fromEntries(pairs.filter(([, v]) => v));

const AZ_RULES: ConnectionRules = {
    allow: ["az version", "az account show", "az account list", "az * list", "az * * list", "az * show", "az * * show"],
    ask: [],
    deny: ["az * delete", "az * * delete", "az * * * delete", "az login", "az logout"],
};
const PAC_RULES: ConnectionRules = {
    allow: ["pac help", "pac org who", "pac auth list", "pac * list", "pac * * list"],
    ask: [],
    deny: ["pac * delete", "pac * * delete", "pac admin reset", "pac auth create", "pac auth clear", "pac auth delete"],
};

export const CONNECTION_PRESETS: ConnectionPreset[] = [
    {
        id: "jira",
        name: "Jira",
        kind: "jira",
        description: "Foreman's own Jira tools: read tickets, and optionally comment, create subtasks and move tickets. Uses the Jira site set under Work → Routing & intake.",
        needs: "Nothing extra. Works with the practice Jira and with your own Jira.",
        fields: [{ key: "writes", label: "Let agents change tickets", hint: "Comment, create subtasks and change status. Each change waits for a person's approval unless you allow it below.", type: "boolean", default: true }],
        build: (v) => ({
            description: "Read tickets" + (v.writes ? "; comment, create subtasks and change status after approval" : ""),
            jira: { writes: !!v.writes },
            rules: { allow: [], ask: v.writes ? [...JIRA_WRITE_TOOLS] : [], deny: [] },
            setupNote: "",
        }),
    },
    {
        id: "confluence-dc",
        name: "Confluence (Data Center)",
        kind: "mcp",
        description: "Search and read Confluence pages through the mcp-atlassian MCP server, signed in with a personal access token.",
        needs: "uv on the server (it runs `uvx mcp-atlassian`), and the Copilot runtime with a Copilot account: MCP servers do not load otherwise.",
        fields: [
            { key: "url", label: "Confluence address", type: "text", required: true, placeholder: "https://confluence.example.com" },
            { key: "token", label: "Personal access token", hint: "Confluence → your profile → Personal Access Tokens.", type: "secret", required: true },
            { key: "spaces", label: "Only these spaces", hint: "Space keys separated by commas, e.g. ENG,OPS. Empty means every space the token can see.", type: "text" },
            { key: "readOnly", label: "Read only", hint: "Switch off creating and editing pages.", type: "boolean", default: true },
        ],
        build: (v) => ({
            description: `Confluence at ${str(v.url)}${str(v.spaces) ? `, spaces ${str(v.spaces)}` : ""}${v.readOnly ? ", read only" : ""}`,
            mcp: { type: "stdio", command: "uvx", args: ["mcp-atlassian"], env: optionalEnv([["CONFLUENCE_URL", str(v.url)], ["CONFLUENCE_PERSONAL_TOKEN", secretRef(str(v.token))], ["CONFLUENCE_SPACES_FILTER", str(v.spaces)], ["READ_ONLY_MODE", v.readOnly ? "true" : "false"]]) },
            rules: { allow: [], ask: [], deny: [] },
            setupNote: "Install uv once on the server: winget install astral-sh.uv",
        }),
    },
    {
        id: "confluence-cloud",
        name: "Confluence (Cloud)",
        kind: "mcp",
        description: "Search and read Confluence Cloud pages through the mcp-atlassian MCP server, signed in with your email and an API token.",
        needs: "uv on the server (it runs `uvx mcp-atlassian`), and the Copilot runtime with a Copilot account: MCP servers do not load otherwise.",
        fields: [
            { key: "url", label: "Confluence address", type: "text", required: true, placeholder: "https://your-team.atlassian.net/wiki" },
            { key: "email", label: "Atlassian account email", type: "text", required: true },
            { key: "token", label: "API token", hint: "id.atlassian.com → Security → API tokens.", type: "secret", required: true },
            { key: "spaces", label: "Only these spaces", hint: "Space keys separated by commas. Empty means every space.", type: "text" },
            { key: "readOnly", label: "Read only", type: "boolean", default: true },
        ],
        build: (v) => ({
            description: `Confluence Cloud at ${str(v.url)}${str(v.spaces) ? `, spaces ${str(v.spaces)}` : ""}${v.readOnly ? ", read only" : ""}`,
            mcp: { type: "stdio", command: "uvx", args: ["mcp-atlassian"], env: optionalEnv([["CONFLUENCE_URL", str(v.url)], ["CONFLUENCE_USERNAME", str(v.email)], ["CONFLUENCE_API_TOKEN", secretRef(str(v.token))], ["CONFLUENCE_SPACES_FILTER", str(v.spaces)], ["READ_ONLY_MODE", v.readOnly ? "true" : "false"]]) },
            rules: { allow: [], ask: [], deny: [] },
            setupNote: "Install uv once on the server: winget install astral-sh.uv",
        }),
    },
    {
        id: "azure-cli",
        name: "Azure CLI (az)",
        kind: "cli",
        description: "Runs `az` commands for the agent. Listing and showing are allowed, deleting is refused, anything else waits for approval. Foreman runs the program itself, without a shell.",
        needs: "The Azure CLI on the server.",
        fields: [{ key: "ownSignIn", label: "Own sign-in", hint: "Keep this connection's Azure sign-in apart from the one on this computer. You sign it in once with the command shown after saving.", type: "boolean", default: true }],
        build: (v) => ({
            description: "Azure CLI" + (v.ownSignIn ? " with its own sign-in" : " signed in as this computer's user"),
            cli: { command: "az", env: optionalEnv([["AZURE_CONFIG_DIR", v.ownSignIn ? "{{connection_home}}" : ""]]), testArgs: ["account", "show"], timeoutSeconds: 300 },
            rules: AZ_RULES,
            setupNote: v.ownSignIn
                ? 'Sign this connection in once, in PowerShell on the server: $env:AZURE_CONFIG_DIR = "{{connection_home}}"; az login --service-principal --username <app id> --tenant <tenant id> --password <secret>   (or plain `az login` for a person\'s account)'
                : "Uses whoever ran `az login` on the server.",
        }),
    },
    {
        id: "power-platform-cli",
        name: "Power Platform CLI (pac)",
        kind: "cli",
        description: "Runs `pac` commands for the agent. Listing is allowed, deleting and changing sign-in are refused, anything else waits for approval.",
        needs: "The Power Platform CLI on the server, signed in with `pac auth create`.",
        fields: [],
        build: () => ({
            description: "Power Platform CLI, using the auth profile selected on the server",
            cli: { command: "pac", env: {}, testArgs: ["org", "who"], timeoutSeconds: 600 },
            rules: PAC_RULES,
            setupNote: "pac keeps its sign-in per user on the server: run `pac auth create` there (with --applicationId, --clientSecret and --tenant for an app registration). Every pac connection uses the profile selected with `pac auth select`.",
        }),
    },
    {
        id: "azure-mcp",
        name: "Azure MCP server",
        kind: "mcp",
        description: "Microsoft's Azure MCP server: Azure resources as tools. An alternative to the Azure CLI that can sign in with its own app registration.",
        needs: "Node.js on the server (it runs `npx @azure/mcp`), and the Copilot runtime with a Copilot account: MCP servers do not load otherwise.",
        fields: [
            { key: "readOnly", label: "Read only", hint: "Only tools that do not change anything.", type: "boolean", default: true },
            { key: "tenantId", label: "Tenant id", hint: "With client id and secret: sign in as this app registration. Leave all three empty to use the server's `az login`.", type: "text" },
            { key: "clientId", label: "Client (app) id", type: "text" },
            { key: "clientSecret", label: "Client secret", type: "secret" },
        ],
        build: (v) => ({
            description: "Azure MCP server" + (v.readOnly ? ", read only" : "") + (str(v.clientId) ? ", own app registration" : ""),
            mcp: { type: "stdio", command: "npx", args: ["-y", "@azure/mcp@latest", "server", "start", ...(v.readOnly ? ["--read-only"] : [])], env: optionalEnv([["AZURE_TENANT_ID", str(v.tenantId)], ["AZURE_CLIENT_ID", str(v.clientId)], ["AZURE_CLIENT_SECRET", str(v.clientSecret) ? secretRef(str(v.clientSecret)) : ""]]) },
            rules: { allow: [], ask: [], deny: [] },
            setupNote: "",
        }),
    },
    {
        id: "custom-cli",
        name: "Other command-line tool",
        kind: "cli",
        description: "Any program on the server, run without a shell. Add rules for which commands are allowed.",
        needs: "The program on the server's PATH.",
        fields: [
            { key: "command", label: "Program", type: "text", required: true, placeholder: "kubectl" },
            { key: "testArgs", label: "Test with", hint: "Arguments that only read, e.g. --version.", type: "text", default: "--version" },
        ],
        build: (v) => ({
            description: `Runs ${str(v.command)}`,
            cli: { command: str(v.command), env: {}, testArgs: splitArgs(str(v.testArgs) || "--version"), timeoutSeconds: 120 },
            rules: { allow: [], ask: [], deny: [] },
            setupNote: "",
        }),
    },
    {
        id: "custom-mcp",
        name: "Other MCP server",
        kind: "mcp",
        description: "Any MCP server: a program the server starts (stdio) or an address (http).",
        needs: "The Copilot runtime with a Copilot account: MCP servers do not load otherwise.",
        fields: [
            { key: "command", label: "Program (stdio)", hint: "For a server Foreman starts, e.g. npx. Leave empty for an address.", type: "text", placeholder: "npx" },
            { key: "args", label: "Arguments", type: "text", placeholder: "-y @some/mcp-server" },
            { key: "url", label: "Address (http)", hint: "For a server that is already running.", type: "text", placeholder: "https://example.com/mcp" },
            { key: "token", label: "Bearer token", hint: "Sent as the Authorization header to an http server.", type: "secret" },
        ],
        build: (v) => ({
            description: str(v.url) ? `MCP server at ${str(v.url)}` : `MCP server: ${str(v.command)} ${str(v.args)}`.trim(),
            mcp: str(v.url)
                ? { type: "http", url: str(v.url), headers: optionalEnv([["Authorization", str(v.token) ? `Bearer ${secretRef(str(v.token))}` : ""]]) }
                : { type: "stdio", command: str(v.command), args: splitArgs(str(v.args)), env: {} },
            rules: { allow: [], ask: [], deny: [] },
            setupNote: "",
        }),
    },
];

// ── Command lines ──────────────────────────────────────────────────────────

/** Characters a shell would act on. Arguments holding them are refused, so nothing can be chained. */
const SHELL_CHARS = /[&|;<>`$^%!\r\n"]/;

/** Split a command line into arguments, honouring single and double quotes. No escapes, no expansion. */
export function splitArgs(line: string): string[] {
    const args: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) args.push(m[1] ?? m[2] ?? m[3]!);
    return args;
}

/** Word-pattern match: `*` is exactly one word, and the command may carry more arguments after the pattern. */
export function commandMatches(pattern: string, words: string[]): boolean {
    const parts = pattern.trim().split(/\s+/);
    if (parts.length > words.length) return false;
    return parts.every((p, i) => p === "*" || p.toLowerCase() === words[i]!.toLowerCase());
}

/** The connection's own verdict on a command, or null when none of its rules match. Deny wins, then ask, then allow. */
export function cliDecision(rules: ConnectionRules, words: string[]): PolicyDecision | null {
    for (const action of ["deny", "ask", "allow"] as const) {
        const hit = rules[action].find((p) => commandMatches(p, words));
        if (hit) return { action, reason: `connection rule "${hit}" → ${action}` };
    }
    return null;
}

export interface CliResult {
    exitCode: number | null;
    output: string;
    timedOut: boolean;
}

/** Why these arguments cannot be run, or null. Checked before a person is asked to approve them. */
export function unsafeArgs(args: string[]): string | null {
    const bad = args.find((a) => SHELL_CHARS.test(a));
    return bad === undefined ? null : `The argument ${JSON.stringify(bad)} contains a character a shell would act on (& | ; < > \` $ ^ % ! or a quote inside). Run one plain command.`;
}

/** Run a program without a shell (Windows needs one for .cmd launchers; the arguments are checked first). */
export function runProgram(command: string, args: string[], opts: { env: Record<string, string>; timeoutSeconds: number; signal?: AbortSignal; maxChars?: number }): Promise<CliResult> {
    const unsafe = unsafeArgs(args);
    if (unsafe) return Promise.reject(new Error(unsafe));
    const max = opts.maxChars ?? 20_000;
    const windows = process.platform === "win32";
    const quoted = windows ? args.map((a) => (/[\s]/.test(a) || a === "" ? `"${a}"` : a)) : args;
    return new Promise((resolve, reject) => {
        const child = spawn(command, quoted, { env: { ...process.env, ...opts.env }, shell: windows, windowsHide: true, cwd: tmpdir() });
        let output = "";
        let timedOut = false;
        const add = (chunk: Buffer) => {
            if (output.length < max) output += chunk.toString("utf8");
        };
        child.stdout.on("data", add);
        child.stderr.on("data", add);
        const stop = () => child.kill();
        const timer = setTimeout(() => ((timedOut = true), stop()), opts.timeoutSeconds * 1000);
        opts.signal?.addEventListener("abort", stop, { once: true });
        child.on("error", (e) => (clearTimeout(timer), reject(new Error(`Could not start ${command}: ${e.message}`))));
        child.on("close", (code) => {
            clearTimeout(timer);
            opts.signal?.removeEventListener("abort", stop);
            resolve({ exitCode: code, output: output.length > max ? output.slice(0, max) + "\n… (output cut)" : output, timedOut });
        });
    });
}

// ── The hub ────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);`;

/** A command-line tool as one agent sees it during a run. */
export interface CliTool {
    name: string;
    connection: Connection;
}

/** What applying an agent's connections to its spec produced. */
export interface AppliedConnections {
    spec: AgentSpec;
    cliTools: CliTool[];
    used: { id: string; name: string; kind: ConnectionKind }[];
    missing: string[];
}

/** Start an MCP server (secrets already filled in) and list its tool names. */
export type McpProbe = (server: McpServerSpec, signal: AbortSignal) => Promise<string[]>;

export const cliToolName = (key: string) => `run_${key.replace(/-/g, "_")}`;

export class ConnectionHub {
    constructor(
        private store: Store,
        private bus: Bus,
        readonly options: { dataDir: string; memory?: boolean; probeMcp?: McpProbe },
    ) {
        store.db.exec(SCHEMA);
    }

    list(): Connection[] {
        return (this.store.db.prepare("SELECT * FROM connections ORDER BY created_at").all() as any[]).map(toConnection);
    }
    get(id: string): Connection | undefined {
        const row = this.store.db.prepare("SELECT * FROM connections WHERE id = ? OR key = ?").get(id, id) as any;
        return row ? toConnection(row) : undefined;
    }

    create(input: ConnectionInput): Connection {
        check(input);
        const key = this.uniqueKey(input.name);
        const ts = new Date().toISOString();
        const id = `con_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        this.store.db.prepare("INSERT INTO connections (id, key, data, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, key, JSON.stringify(input), ts, ts);
        this.bus.emit("change", "connections");
        return this.get(id)!;
    }

    update(id: string, input: ConnectionInput): Connection {
        const current = this.get(id);
        if (!current) throw new Error(`Connection ${id} not found`);
        check(input);
        this.store.db.prepare("UPDATE connections SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(input), new Date().toISOString(), current.id);
        this.bus.emit("change", "connections");
        return this.get(current.id)!;
    }

    delete(id: string) {
        const current = this.get(id);
        if (!current) throw new Error(`Connection ${id} not found`);
        this.store.db.prepare("DELETE FROM connections WHERE id = ?").run(current.id);
        this.bus.emit("change", "connections");
    }

    /** Agents whose active revision uses a connection. */
    usedBy(id: string) {
        return this.store.listAgents().filter((a) => this.store.getRevision(a.activeRevisionId)?.spec.connections.includes(id));
    }

    /** Where a command-line connection keeps its own files, such as a separate sign-in. */
    home(connection: Pick<Connection, "key">): string {
        const dir = join(this.options.memory ? join(tmpdir(), "foreman-connections") : join(this.options.dataDir, "connections"), connection.key);
        mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Fill `{{connection_home}}` in a connection's text, e.g. its environment or setup note. */
    localise(connection: Connection, text: string): string {
        return text.includes("{{connection_home}}") ? text.replaceAll("{{connection_home}}", this.home(connection)) : text;
    }

    /**
     * Merge an agent's connections into its spec for one run. The agent's own rules stay first, so
     * a person can still tighten or loosen one agent; the connections' rules follow them.
     */
    apply(spec: AgentSpec): AppliedConnections {
        const out: AgentSpec = { ...spec, tools: [...spec.tools], mcpServers: { ...spec.mcpServers }, policy: { ...spec.policy, rules: [...spec.policy.rules] } };
        const cliTools: CliTool[] = [];
        const used: AppliedConnections["used"] = [];
        const missing: string[] = [];
        const extraRules: PolicyRule[] = [];
        for (const id of spec.connections) {
            const c = this.get(id);
            if (!c) {
                missing.push(id);
                continue;
            }
            used.push({ id: c.id, name: c.name, kind: c.kind });
            if (c.kind === "jira") {
                for (const tool of [...JIRA_READ_TOOLS, ...(c.jira?.writes ? JIRA_WRITE_TOOLS : [])]) if (!out.tools.includes(tool)) out.tools.push(tool);
                extraRules.push(...rulesFor(c.rules, (p) => p, c.name));
            } else if (c.kind === "mcp" && c.mcp) {
                if (!(c.key in out.mcpServers)) out.mcpServers[c.key] = c.mcp;
                // The runtime names an MCP tool `<server>-<tool>`; patterns are written as the tool's own name.
                extraRules.push(...rulesFor(c.rules, (p) => `mcp:${c.key}-${p}`, c.name));
            } else if (c.kind === "cli" && c.cli) {
                cliTools.push({ name: cliToolName(c.key), connection: c });
            }
        }
        out.policy.rules.push(...extraRules);
        return { spec: out, cliTools, used, missing };
    }

    private uniqueKey(name: string) {
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "connection";
        let key = base;
        for (let i = 2; this.get(key); i++) key = `${base}-${i}`;
        return key;
    }
}

function rulesFor(rules: ConnectionRules, match: (pattern: string) => string, name: string): PolicyRule[] {
    return (["deny", "ask", "allow"] as const).flatMap((action) => rules[action].map((p) => ({ match: match(p), action, note: `From connection “${name}”` })));
}

function check(input: ConnectionInput) {
    if (input.kind === "mcp" && !input.mcp) throw new Error("An MCP connection needs its server settings (mcp)");
    if (input.kind === "cli" && !input.cli) throw new Error("A command-line connection needs its program (cli.command)");
}

function toConnection(row: any): Connection {
    return { ...ConnectionInput.parse(JSON.parse(row.data)), id: row.id, key: row.key, createdAt: row.created_at, updatedAt: row.updated_at };
}
