import { Ticket } from "./schemas.ts";

/** Jira Cloud returns rich text as an Atlassian Document; the mock and older sites return a string. */
export function plainText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const node = value as { type?: string; text?: string; content?: unknown[] };
    if (node.type === "text") return node.text ?? "";
    const inner = (node.content ?? []).map(plainText).join("");
    return ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(node.type ?? "") ? inner + "\n" : inner;
}

/** Jira's JQL date literal, to the minute, in UTC. */
export const jqlDate = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function toTicket(issue: any, baseUrl: string): Ticket {
    const f = issue.fields ?? {};
    return Ticket.parse({
        source: "jira",
        key: issue.key,
        url: `${baseUrl.replace(/\/$/, "")}/browse/${issue.key}`,
        title: f.summary ?? issue.key,
        description: plainText(f.description).trim(),
        type: f.issuetype?.name,
        priority: f.priority?.name,
        labels: f.labels ?? [],
        project: f.project?.key ?? String(issue.key).split("-")[0],
        reporter: f.reporter?.displayName ?? null,
        status: f.status?.name,
        updatedAt: new Date(f.updated ?? Date.now()).toISOString(),
    });
}

const FIELDS = "summary,description,issuetype,priority,labels,project,reporter,status,updated";

export interface JiraComment {
    author: string;
    body: string;
    created: string;
}
export interface JiraTransition {
    id: string;
    name: string;
    to: string;
}
export interface JiraClientOptions {
    headers?: Record<string, string>;
    /** Cloud speaks REST v3 with rich-text documents; Data Center speaks v2 with plain strings. */
    flavor?: "cloud" | "datacenter";
}

/** Plain text as the rich-text document Jira Cloud expects for comments and descriptions. */
export const toDocument = (text: string) => ({
    type: "doc",
    version: 1,
    content: text.split(/\n{2,}/).filter(Boolean).map((paragraph) => ({ type: "paragraph", content: [{ type: "text", text: paragraph }] })),
});

/** The small part of the Jira REST API Foreman needs. Points at a real site or at the built-in mock. */
export class JiraClient {
    private headers: Record<string, string>;
    private flavor: "cloud" | "datacenter";

    constructor(
        readonly baseUrl: string,
        options: JiraClientOptions = {},
    ) {
        this.headers = options.headers ?? {};
        this.flavor = options.flavor ?? "cloud";
    }
    private get api() {
        return this.flavor === "datacenter" ? "/rest/api/2" : "/rest/api/3";
    }
    private text(value: string): unknown {
        return this.flavor === "datacenter" ? value : toDocument(value);
    }

    private async request(method: string, path: string, body?: unknown): Promise<any> {
        let response: Response;
        try {
            response = await fetch(this.baseUrl.replace(/\/$/, "") + this.api + path, {
                method,
                headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...this.headers },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(20_000),
            });
        } catch (e) {
            throw new Error(`Cannot reach Jira at ${this.baseUrl}: ${e instanceof Error ? e.message : e}`);
        }
        if (!response.ok) {
            const detail = await response.json().then((b: any) => [...(b?.errorMessages ?? []), ...Object.values(b?.errors ?? {})].join("; "), () => "");
            const hint = response.status === 401 ? " (sign-in was refused: check the email and token)" : response.status === 403 ? " (the account is not allowed to do this)" : "";
            throw new Error(`Jira answered ${response.status} for ${method} ${path.split("?")[0]}${hint}${detail ? `: ${detail}` : ""}`);
        }
        return response.status === 204 ? null : response.json().catch(() => null);
    }

    /** Who the configured credentials belong to. The cheapest call that proves they work. */
    async myself(): Promise<{ name: string; email: string | null }> {
        const me = await this.request("GET", "/myself");
        return { name: me?.displayName ?? me?.name ?? "unknown", email: me?.emailAddress ?? null };
    }

    async getIssue(key: string): Promise<Ticket> {
        return toTicket(await this.request("GET", `/issue/${encodeURIComponent(key)}?fields=${FIELDS}`), this.baseUrl);
    }

    /** A ticket with its most recent comments, for an agent that needs the whole conversation. */
    async getIssueWithComments(key: string): Promise<{ ticket: Ticket; comments: JiraComment[] }> {
        const issue = await this.request("GET", `/issue/${encodeURIComponent(key)}?fields=${FIELDS},comment`);
        const comments: JiraComment[] = (issue.fields?.comment?.comments ?? []).slice(-20).map((c: any) => ({ author: c.author?.displayName ?? "unknown", body: plainText(c.body).trim(), created: c.created }));
        return { ticket: toTicket(issue, this.baseUrl), comments };
    }

    /** All tickets matching `jql`, optionally only those updated since a moment, oldest change first. */
    async search(jql: string, updatedSince?: string, limit = 1000): Promise<Ticket[]> {
        const base = jql.replace(/\s+order\s+by\s+.*$/i, "").trim();
        const full = `${base ? `(${base})` : ""}${updatedSince ? `${base ? " AND " : ""}updated >= "${jqlDate(updatedSince)}"` : ""} ORDER BY updated ASC`;
        const size = Math.min(50, limit);
        const tickets: Ticket[] = [];
        if (this.flavor === "datacenter") {
            for (let startAt = 0; tickets.length < limit; ) {
                const page = await this.request("GET", `/search?jql=${encodeURIComponent(full)}&maxResults=${size}&startAt=${startAt}&fields=${FIELDS}`);
                const issues = page.issues ?? [];
                for (const issue of issues) tickets.push(toTicket(issue, this.baseUrl));
                startAt += issues.length;
                if (!issues.length || startAt >= (page.total ?? 0)) break;
            }
            return tickets.slice(0, limit);
        }
        let token: string | undefined;
        do {
            const page = await this.request("GET", `/search/jql?jql=${encodeURIComponent(full)}&maxResults=${size}&fields=${FIELDS}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ""}`);
            for (const issue of page.issues ?? []) tickets.push(toTicket(issue, this.baseUrl));
            token = page.isLast === false ? page.nextPageToken : undefined;
        } while (token && tickets.length < limit);
        return tickets.slice(0, limit);
    }

    async addComment(key: string, text: string): Promise<void> {
        await this.request("POST", `/issue/${encodeURIComponent(key)}/comment`, { body: this.text(text) });
    }

    async transitions(key: string): Promise<JiraTransition[]> {
        const result = await this.request("GET", `/issue/${encodeURIComponent(key)}/transitions`);
        return (result?.transitions ?? []).map((t: any) => ({ id: String(t.id), name: t.name, to: t.to?.name ?? t.name }));
    }

    /**
     * Move a ticket to a status, named either by the status ("In Progress") or by the transition
     * ("Start progress"). Returns the status it ended in, or null when it was already there.
     */
    async transition(key: string, target: string): Promise<string | null> {
        const wanted = target.trim().toLowerCase();
        const available = await this.transitions(key);
        const match = available.find((t) => t.to.toLowerCase() === wanted) ?? available.find((t) => t.name.toLowerCase() === wanted);
        if (!match) {
            const current = (await this.getIssue(key)).status;
            if (current.toLowerCase() === wanted) return null;
            throw new Error(`${key} cannot move to "${target}" from "${current}". Possible: ${available.map((t) => t.to).join(", ") || "nothing"}`);
        }
        await this.request("POST", `/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: match.id } });
        return match.to;
    }

    async createSubtask(parentKey: string, summary: string, description = ""): Promise<{ key: string; url: string }> {
        const project = parentKey.split("-")[0]!;
        const fields = (type: string) => ({ project: { key: project }, parent: { key: parentKey }, summary, issuetype: { name: type }, ...(description ? { description: this.text(description) } : {}) });
        let created: any;
        try {
            created = await this.request("POST", "/issue", { fields: fields("Sub-task") });
        } catch (e) {
            // Newer Jira projects call the type "Subtask".
            if (!/issuetype|issue type/i.test(String(e))) throw e;
            created = await this.request("POST", "/issue", { fields: fields("Subtask") });
        }
        return { key: created.key, url: `${this.baseUrl.replace(/\/$/, "")}/browse/${created.key}` };
    }
}

// ── Mock Jira ──────────────────────────────────────────────────────────────

export interface MockIssue {
    key: string;
    fields: {
        summary: string;
        description: string;
        issuetype: { name: string };
        priority: { name: string };
        labels: string[];
        project: { key: string };
        reporter: { displayName: string };
        status: { name: string };
        updated: string;
        created: string;
        comment: { comments: { id: string; author: { displayName: string }; body: string; created: string }[] };
        parent?: { key: string };
    };
}
/** The mock's workflow: every status can be reached from every other. */
export const MOCK_STATUSES = ["To Do", "In Progress", "In Review", "Done"];

const SEED: [project: string, type: string, priority: string, summary: string, description: string, labels?: string[]][] = [
    ["PAY", "Bug", "High", "Partial refund is rounded up instead of down", "Refunding 33.335 EUR gives 33.34. Finance expects 33.33 (round half-even). Seen on invoices since the last release."],
    ["PAY", "Bug", "Highest", "Duplicate webhook delivery creates two payments", "When the provider retries a webhook within a second, we record the payment twice. Needs an idempotency key check."],
    ["PAY", "Bug", "Medium", "Invoice PDF shows the wrong VAT rate for Åland", "Åland is outside the EU VAT area; the PDF prints 25.5% instead of 0%."],
    ["PAY", "Task", "Low", "Reconcile yesterday's orders for the Nordic region", "Daily reconciliation against the ledger. Report mismatches only.", ["mock:flaky"]],
    ["WEB", "Bug", "High", "Login button unresponsive on Safari 18", "Tapping Log in does nothing on iOS Safari 18.1. Works in Chrome. Console shows a passive listener warning."],
    ["WEB", "Bug", "Medium", "Date picker ignores the user's locale", "Finnish users see MM/DD/YYYY. Should follow the profile locale."],
    ["WEB", "Story", "Medium", "Add keyboard shortcuts to the order table", "J/K to move, Enter to open, as in the issue tracker."],
    ["OPS", "Task", "High", "Cut release 4.12 from main", "Branch, update changelog, tag, push.", ["mock:needs-approval"]],
    ["OPS", "Task", "Medium", "Backport the session-expiry fix to 4.11", "Cherry-pick the UTC comparison fix to release/4.11 and publish 4.11.3.", ["mock:needs-approval"]],
    ["OPS", "Task", "Low", "Weekly dependency audit for the payments services", "Walk every service, list outdated and risky dependencies. Read-only.", ["mock:slow"]],
    ["DOC", "Task", "Medium", "Migration guide still describes the v3 config format", "Section 3 of docs/migration.md predates the v4 config. Rewrite it.", ["mock:sub-agents"]],
    ["DOC", "Task", "Low", "Document the new retry settings", "retry.maxAttempts and retry.backoff are undocumented."],
    ["API", "Bug", "Medium", "429 responses are missing the Retry-After header", "Clients cannot back off correctly. Add the header from the rate limiter's reset time.", ["mock:tool-failure"]],
    ["API", "Bug", "Low", "OpenAPI spec lists a removed endpoint", "GET /v1/legacy-orders was removed in March but is still in the spec.", []],
    ["PAY", "Bug", "Medium", "Refund total differs between the API and the invoice", "The API returns 12.35, the invoice PDF says 12.34. The report does not say which one finance treats as correct.", ["mock:asks-question"]],
    ["API", "Task", "Medium", "Split the rate-limit rework into subtasks", "The rework touches the limiter, the headers and the docs. Break it down and note the plan on the ticket.", ["mock:jira-updates"]],
];
const GENERATED: [project: string, type: string, summary: string][] = [
    ["PAY", "Bug", "Currency conversion uses yesterday's rate after midnight UTC"],
    ["WEB", "Bug", "Table header overlaps the first row when zoomed to 125%"],
    ["API", "Bug", "Pagination cursor breaks when an item is deleted mid-scan"],
    ["OPS", "Task", "Rotate the staging database credentials"],
    ["DOC", "Task", "Add a troubleshooting page for webhook signature errors"],
    ["PAY", "Bug", "Refund email is sent twice when the request times out"],
    ["WEB", "Story", "Remember the last used filter on the orders page"],
    ["API", "Bug", "Timestamps in the export are missing the timezone offset"],
    ["OPS", "Task", "Publish hotfix 4.11.4"],
    ["PAY", "Task", "Reconcile orders after the 14:00 outage"],
    ["API", "Task", "Plan the deprecation of the v1 export endpoint"],
];
const PRIORITIES = ["Highest", "High", "Medium", "Medium", "Medium", "Low", "Lowest"];
const GENERATED_SCENARIOS = [[], [], [], [], ["mock:needs-approval"], ["mock:slow"], ["mock:flaky"], ["mock:tool-failure"], ["mock:sub-agents"], ["mock:asks-question"]];

/**
 * An in-memory Jira that speaks the same REST shapes as Jira Cloud for the calls Foreman makes.
 * The real client is pointed at it by URL, so the production code path is what gets exercised.
 */
export class MockJira {
    private issues = new Map<string, MockIssue>();
    private counters = new Map<string, number>();
    private timer?: ReturnType<typeof setInterval>;
    private generated = 0;
    private commentSeq = 0;
    perMinute = 0;
    /** When set, the mock calls this address on every new or edited ticket, as a Jira webhook would. */
    webhookUrl: string | null = null;
    private announce(event: string, issue: MockIssue) {
        if (!this.webhookUrl) return;
        void fetch(this.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ webhookEvent: event, issue: { key: issue.key } }), signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    /** When set, every request must carry exactly this Authorization header (tests use it). */
    requiredAuth: string | null = null;

    constructor(seed = true) {
        if (!seed) return;
        // Opt-in label on most seeded tickets; a couple are left out to show what is not picked up.
        SEED.forEach(([project, type, priority, summary, description, labels], i) => this.create({ project, type, priority, summary, description, labels: [...(i === 6 || i === 13 ? [] : ["foreman"]), ...(labels ?? [])] }));
    }

    create(input: { project?: string; type?: string; priority?: string; summary: string; description?: string; labels?: string[]; parent?: string }): MockIssue {
        const project = (input.project ?? "PAY").toUpperCase();
        const n = (this.counters.get(project) ?? 100 + project.charCodeAt(0)) + 1;
        this.counters.set(project, n);
        const now = new Date().toISOString();
        const issue: MockIssue = {
            key: `${project}-${n}`,
            fields: {
                summary: input.summary,
                description: input.description ?? "",
                issuetype: { name: input.type ?? "Task" },
                priority: { name: input.priority ?? "Medium" },
                labels: input.labels ?? ["foreman"],
                project: { key: project },
                reporter: { displayName: "Mock Reporter" },
                status: { name: "To Do" },
                updated: now,
                created: now,
                comment: { comments: [] },
                ...(input.parent ? { parent: { key: input.parent } } : {}),
            },
        };
        this.issues.set(issue.key, issue);
        this.announce("jira:issue_created", issue);
        return issue;
    }

    /** File one plausible ticket, as a person would. */
    generate(): MockIssue {
        const [project, type, summary] = GENERATED[this.generated % GENERATED.length]!;
        const round = Math.floor(this.generated / GENERATED.length);
        const labels = ["foreman", ...GENERATED_SCENARIOS[(this.generated * 7 + 3) % GENERATED_SCENARIOS.length]!];
        const priority = PRIORITIES[(this.generated * 5 + 2) % PRIORITIES.length]!;
        this.generated++;
        return this.create({ project, type, priority, summary: round ? `${summary} (${round + 1})` : summary, description: "Filed by the mock ticket generator.", labels });
    }

    /** Start or stop filing tickets on a timer. */
    setGenerator(perMinute: number) {
        clearInterval(this.timer);
        this.perMinute = Math.max(0, Math.min(perMinute, 60));
        if (this.perMinute > 0) {
            this.timer = setInterval(() => this.generate(), 60_000 / this.perMinute);
            this.timer.unref?.();
        }
    }

    get(key: string): MockIssue | undefined {
        return this.issues.get(key.toUpperCase());
    }
    update(key: string, patch: Partial<MockIssue["fields"]>): MockIssue | undefined {
        const issue = this.get(key);
        if (issue) Object.assign(issue.fields, patch, { updated: new Date().toISOString() });
        return issue;
    }
    list(): MockIssue[] {
        return [...this.issues.values()];
    }
    addComment(key: string, body: string, author = "Foreman"): boolean {
        const issue = this.get(key);
        if (!issue) return false;
        const now = new Date().toISOString();
        issue.fields.comment.comments.push({ id: String(++this.commentSeq), author: { displayName: author }, body, created: now });
        issue.fields.updated = now;
        return true;
    }
    transitions(key: string) {
        const issue = this.get(key);
        return issue ? MOCK_STATUSES.filter((s) => s !== issue.fields.status.name).map((s) => ({ id: String(MOCK_STATUSES.indexOf(s) + 1), name: s, to: { name: s } })) : undefined;
    }
    transition(key: string, id: string): boolean {
        const status = MOCK_STATUSES[Number(id) - 1];
        return !!status && !!this.update(key, { status: { name: status } });
    }
    subtasks(key: string): MockIssue[] {
        return this.list().filter((i) => i.fields.parent?.key === key.toUpperCase());
    }

    /**
     * A deliberately small JQL: clauses joined by AND over project, labels, status, type, priority
     * and updated. Clauses it does not understand are ignored rather than rejected.
     */
    search(jql: string): MockIssue[] {
        const [where = "", order = ""] = jql.split(/\s+order\s+by\s+/i);
        const clauses = where.replace(/[()]/g, " ").split(/\s+and\s+/i).map((c) => c.trim()).filter(Boolean);
        const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "");
        const list = (v: string) => v.split(",").map((x) => unquote(x).toLowerCase());
        const field = (issue: MockIssue, name: string): string[] => {
            const f = issue.fields;
            switch (name) {
                case "project": return [f.project.key];
                case "labels": case "label": return f.labels;
                case "status": return [f.status.name];
                case "type": case "issuetype": return [f.issuetype.name];
                case "priority": return [f.priority.name];
                default: return [];
            }
        };
        const matches = (issue: MockIssue) =>
            clauses.every((clause) => {
                const updated = /^updated\s*(>=|>)\s*(.+)$/i.exec(clause);
                if (updated) return Date.parse(issue.fields.updated) >= Date.parse(unquote(updated[2]!).replace(" ", "T") + ":00Z");
                const m = /^(\w+)\s*(!=|=|not in|in)\s*(.+)$/i.exec(clause);
                if (!m) return true;
                const values = field(issue, m[1]!.toLowerCase()).map((v) => v.toLowerCase());
                const wanted = list(m[3]!);
                const hit = wanted.some((w) => values.includes(w));
                return /^(!=|not in)$/i.test(m[2]!) ? !hit : hit;
            });
        const found = this.list().filter(matches);
        const desc = /desc/i.test(order);
        return found.sort((a, b) => (desc ? -1 : 1) * a.fields.updated.localeCompare(b.fields.updated));
    }
}
