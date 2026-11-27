import { setTimeout as sleep } from "node:timers/promises";
import { MOCK_PP_ORIGIN, MOCK_PP_TENANT, type MockPowerPlatform } from "./mockpowerplatform.ts";
import type { Bus } from "./registry.ts";
import { PowerPlatformSettings, type PowerPlatformIdentity } from "./schemas.ts";
import type { Store } from "./store.ts";
import type { Vault } from "./vault.ts";

export const PP_API_VERSION = "2024-10-01";
export type PpConnection = "reader" | "operator";

/** An environment as Foreman uses it: the API's fields Foreman needs, plus its group's name. */
export interface PpEnvironment {
    id: string;
    displayName: string;
    /** Power Platform's SKU: Default, Production, Sandbox, Developer, Trial, Teams … */
    type: string;
    state: string;
    /** The environment's Dataverse address, when it has a database. */
    url: string | null;
    domainName: string | null;
    environmentGroupId: string | null;
    groupName: string | null;
    /** `Standard` means managed environment. */
    protectionLevel: string | null;
    adminMode: string | null;
    createdDateTime: string | null;
    azureRegion: string | null;
}
export interface PpGroup {
    id: string;
    displayName: string;
    description: string;
}
export interface PpResponse {
    status: number;
    headers: Headers;
    body: any;
}
/** A lifecycle operation, as `GET /environmentmanagement/operations/{id}` reports it. */
export interface PpOperation {
    operationId: string;
    name?: string;
    status: string;
    startTime?: string;
    endTime?: string | null;
    errorDetail?: unknown;
}

const TERMINAL = new Set(["Succeeded", "Failed", "ValidationFailed", "NoOperation", "ValidationPassed"]);

/** The most useful line from any of the error shapes Power Platform and Dataverse use. */
function errorDetail(body: any): string {
    if (!body || typeof body !== "object") return "";
    if (typeof body.error === "string") return [body.error, body.error_description].filter(Boolean).join(": ");
    if (body.error?.message) return String(body.error.message);
    const fields = body.errorDetail?.fieldErrors;
    if (fields && typeof fields === "object") {
        const parts = Object.entries(fields as Record<string, { errorMessages?: string[] }>).map(([k, v]) => `${k}: ${(v.errorMessages ?? []).join(" ")}`);
        if (parts.length) return parts.join("; ");
    }
    if (body.errorDetail?.code) return String(body.errorDetail.code);
    return String(body.detail ?? body.title ?? body.message ?? "");
}

export interface PowerPlatformClientOptions {
    connection: PpConnection;
    apiUrl: string;
    loginUrl: string;
    tenantId: string;
    clientId: string;
    /** Read at the moment a token is requested, never kept. */
    secret: () => string;
    /** The network's fetch, or the practice tenant's in-process one. */
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Speaks the Power Platform API (management plane) and an environment's Dataverse Web API as one
 * app registration. Tokens are cached per scope until shortly before they expire.
 */
export class PowerPlatformClient {
    private tokens = new Map<string, { token: string; expires: number }>();
    constructor(readonly opts: PowerPlatformClientOptions) {}

    get connection() {
        return this.opts.connection;
    }

    private async token(scope: string): Promise<string> {
        const cached = this.tokens.get(scope);
        if (cached && cached.expires > Date.now() + 60_000) return cached.token;
        const url = `${this.opts.loginUrl.replace(/\/$/, "")}/${encodeURIComponent(this.opts.tenantId)}/oauth2/v2.0/token`;
        const form = new URLSearchParams({ client_id: this.opts.clientId, client_secret: this.opts.secret(), grant_type: "client_credentials", scope });
        let response: Response;
        try {
            response = await this.opts.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(20_000) });
        } catch (e) {
            throw new Error(`Cannot reach the sign-in service at ${new URL(url).host}: ${e instanceof Error ? e.message : e}`);
        }
        const body: any = await response.json().catch(() => null);
        if (!response.ok || !body?.access_token) throw new Error(`Sign-in for the ${this.connection} connection was refused (${response.status}): ${errorDetail(body) || "no detail"}. Check the tenant id, client id and the stored client secret.`);
        this.tokens.set(scope, { token: body.access_token, expires: Date.now() + Number(body.expires_in ?? 3600) * 1000 });
        return body.access_token;
    }

    /** One call. Retries after a 429 (honouring Retry-After) and once after a 401 with a fresh token. */
    async request(method: string, url: string, options: { scope: string; body?: unknown; signal?: AbortSignal } ): Promise<PpResponse> {
        const label = `${method} ${new URL(url).pathname}`;
        for (let attempt = 0; ; attempt++) {
            const token = await this.token(options.scope);
            let response: Response;
            try {
                const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
                response = await this.opts.fetch(url, {
                    method,
                    headers: { authorization: `Bearer ${token}`, accept: "application/json", "odata-version": "4.0", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
                    body: options.body === undefined ? undefined : JSON.stringify(options.body),
                    signal,
                });
            } catch (e) {
                throw new Error(`Cannot reach Power Platform at ${new URL(url).host}: ${e instanceof Error ? e.message : e}`);
            }
            if (response.status === 429 && attempt < 2) {
                const wait = Math.min(10, Number(response.headers.get("retry-after") ?? 2) || 2);
                await sleep(wait * 1000);
                continue;
            }
            if (response.status === 401 && attempt === 0) {
                this.tokens.delete(options.scope);
                continue;
            }
            const text = await response.text();
            let body: any = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                body = text;
            }
            if (!response.ok) {
                const hint =
                    response.status === 429
                        ? " (rate limit: Power Platform is throttling; try again later)"
                        : response.status === 403
                          ? this.connection === "reader"
                              ? " (the reader connection may only read)"
                              : " (the operator identity lacks the role for this; it needs Power Platform contributor, and a security role in the environment for Dataverse calls)"
                          : "";
                const detail = errorDetail(body);
                throw new PowerPlatformError(`Power Platform answered ${response.status} for ${label}${hint}${detail ? `: ${detail}` : ""}`, response.status, body);
            }
            return { status: response.status, headers: response.headers, body };
        }
    }

    // ── management plane ─────────────────────────────────────────────────
    private get apiScope() {
        // The scope is the real API's even against the practice tenant, which ignores it.
        return "https://api.powerplatform.com/.default";
    }
    apiUrl(path: string, query: Record<string, string | number | boolean | undefined> = {}) {
        const params = new URLSearchParams({ "api-version": PP_API_VERSION });
        for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
        return `${this.opts.apiUrl.replace(/\/$/, "")}${path}?${params}`;
    }
    api(method: string, path: string, options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; signal?: AbortSignal } = {}) {
        return this.request(method, this.apiUrl(path, options.query), { scope: this.apiScope, body: options.body, signal: options.signal });
    }
    /** Any GET under the API, for read-only reporting. `path` is relative to the API's address. */
    async get(pathAndQuery: string, signal?: AbortSignal): Promise<PpResponse> {
        const url = new URL(this.opts.apiUrl.replace(/\/$/, "") + pathAndQuery);
        if (!url.searchParams.has("api-version")) url.searchParams.set("api-version", PP_API_VERSION);
        return this.request("GET", url.toString(), { scope: this.apiScope, signal });
    }

    async listEnvironments(filter?: string): Promise<any[]> {
        const all: any[] = [];
        let next: string | undefined = this.apiUrl("/environmentmanagement/environments", { $filter: filter, $top: 200 });
        while (next && all.length < 5000) {
            const page: PpResponse = await this.request("GET", next, { scope: this.apiScope });
            all.push(...(page.body?.value ?? []));
            next = page.body?.["@odata.nextlink"] ?? page.body?.["@odata.nextLink"];
        }
        return all;
    }
    async listGroups(): Promise<PpGroup[]> {
        const res = await this.api("GET", "/environmentmanagement/environmentGroups");
        return (res.body?.value ?? []).map((g: any) => ({ id: g.id, displayName: g.displayName, description: g.description ?? "" }));
    }

    /** Follow a lifecycle operation until it ends or `seconds` pass. */
    async track(started: PpResponse, seconds: number, onProgress?: (op: PpOperation) => void, signal?: AbortSignal): Promise<{ operation: PpOperation | null; finished: boolean }> {
        const location = started.headers.get("operation-location") ?? started.headers.get("location");
        const id = started.body?.operationId ?? (location ? /operations\/([^/?]+)/.exec(location)?.[1] : undefined);
        if (!id) return { operation: null, finished: false };
        let op: PpOperation = started.body?.operationId ? started.body : { operationId: id, status: "Queued" };
        const deadline = Date.now() + seconds * 1000;
        while (!TERMINAL.has(op.status)) {
            if (Date.now() >= deadline || signal?.aborted) return { operation: op, finished: false };
            op = (await this.api("GET", `/environmentmanagement/operations/${encodeURIComponent(id)}`, { signal })).body;
            onProgress?.(op);
            if (!TERMINAL.has(op.status)) await sleep(Math.min(3000, Math.max(0, deadline - Date.now())), undefined, { signal }).catch(() => {});
        }
        return { operation: op, finished: true };
    }

    // ── Dataverse Web API of one environment ─────────────────────────────
    dataverse(env: Pick<PpEnvironment, "url" | "displayName">, method: string, resource: string, body?: unknown, signal?: AbortSignal) {
        if (!env.url) throw new Error(`${env.displayName} has no Dataverse database, so it has no users or security roles to manage.`);
        const base = env.url.endsWith("/") ? env.url : `${env.url}/`;
        return this.request(method, `${base}api/data/v9.2/${resource}`, { scope: `${new URL(base).origin}/.default`, body, signal });
    }
}

export class PowerPlatformError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body: unknown,
    ) {
        super(message);
    }
}

export interface PowerPlatformHubOptions {
    vault: Vault;
    mock: MockPowerPlatform;
}

const toEnvironment = (e: any, groups: Map<string, string>): PpEnvironment => ({
    id: e.id,
    displayName: e.displayName ?? e.id,
    type: e.type ?? "Unknown",
    state: e.state ?? "Unknown",
    url: e.url ?? null,
    domainName: e.domainName ?? null,
    environmentGroupId: e.environmentGroupId ?? null,
    groupName: e.environmentGroupId ? (groups.get(e.environmentGroupId) ?? null) : null,
    protectionLevel: e.protectionLevel ?? null,
    adminMode: e.adminMode ?? null,
    createdDateTime: e.createdDateTime ?? null,
    azureRegion: e.azureRegion ?? null,
});

/**
 * Power Platform administration as Foreman sees it: two identities (reader and operator), the
 * practice tenant until a real one is set up, a cached directory of environments, and the
 * protection rules that refuse changes whatever an agent's guardrails say.
 */
export class PowerPlatformHub {
    private clients = new Map<string, PowerPlatformClient>();
    private cache: { at: number; environments: PpEnvironment[]; groups: PpGroup[] } | null = null;

    constructor(
        private store: Store,
        private bus: Bus,
        private options: PowerPlatformHubOptions,
    ) {}

    settings(): PowerPlatformSettings {
        return PowerPlatformSettings.parse(this.store.getSetting<Partial<PowerPlatformSettings>>("powerplatform") ?? {});
    }
    updateSettings(patch: Partial<Omit<PowerPlatformSettings, "reader" | "operator">> & { reader?: Partial<PowerPlatformIdentity>; operator?: Partial<PowerPlatformIdentity> }): PowerPlatformSettings {
        const current = this.settings();
        const next = PowerPlatformSettings.parse({ ...current, ...patch, reader: { ...current.reader, ...patch.reader }, operator: { ...current.operator, ...patch.operator } });
        this.store.setSetting("powerplatform", next);
        this.clients.clear();
        this.cache = null;
        this.bus.emit("change", "powerplatform");
        return next;
    }
    /** True while no tenant is set up: everything goes to the built-in practice tenant. */
    isMock() {
        return !this.settings().apiUrl;
    }
    get mock() {
        return this.options.mock;
    }

    /** Whether an identity is set up well enough to try. */
    identityReady(connection: PpConnection): { ok: boolean; detail: string } {
        if (this.isMock()) return { ok: true, detail: `Practice tenant (mock-${connection})` };
        const s = this.settings();
        const id = s[connection];
        if (!s.tenantId) return { ok: false, detail: "No tenant id is set" };
        if (!id.clientId) return { ok: false, detail: `No client id is set for the ${connection} connection` };
        if (!id.secretName) return { ok: false, detail: `No client secret is chosen for the ${connection} connection` };
        if (!this.options.vault.has(id.secretName)) return { ok: false, detail: `Secret "${id.secretName}" does not exist; store it under Secrets` };
        return { ok: true, detail: `Client ${id.clientId}` };
    }

    client(connection: PpConnection): PowerPlatformClient {
        const s = this.settings();
        const key = `${connection}:${JSON.stringify([s.apiUrl, s.loginUrl, s.tenantId, s[connection]])}`;
        const existing = this.clients.get(key);
        if (existing) return existing;
        const ready = this.identityReady(connection);
        if (!ready.ok) throw new Error(`The Power Platform ${connection} connection is not set up: ${ready.detail}. Set it up under Power Platform.`);
        const mock = this.isMock();
        const identity = s[connection];
        const client = new PowerPlatformClient({
            connection,
            apiUrl: mock ? MOCK_PP_ORIGIN : s.apiUrl,
            loginUrl: mock ? `${MOCK_PP_ORIGIN}/login` : s.loginUrl || "https://login.microsoftonline.com",
            tenantId: mock ? MOCK_PP_TENANT : s.tenantId,
            clientId: mock ? `mock-${connection}` : identity.clientId,
            secret: () => (mock ? "practice" : this.options.vault.use(identity.secretName)),
            fetch: mock ? this.options.mock.fetch : (url, init) => globalThis.fetch(url, init),
        });
        this.clients.set(key, client);
        return client;
    }

    /** Every environment and group, read with the reader identity and reused for a few minutes. */
    async directory(force = false): Promise<{ environments: PpEnvironment[]; groups: PpGroup[]; fetchedAt: string }> {
        const ttl = this.settings().directoryTtlSeconds * 1000;
        if (!force && this.cache && Date.now() - this.cache.at < ttl) return { ...this.cache, fetchedAt: new Date(this.cache.at).toISOString() };
        const reader = this.client("reader");
        const [raw, groups] = await Promise.all([reader.listEnvironments(), reader.listGroups().catch(() => [] as PpGroup[])]);
        const names = new Map(groups.map((g) => [g.id, g.displayName]));
        this.cache = { at: Date.now(), environments: raw.map((e) => toEnvironment(e, names)), groups };
        return { ...this.cache, fetchedAt: new Date(this.cache.at).toISOString() };
    }
    /** Forget the directory after a change, so the next lookup sees it. */
    invalidate() {
        this.cache = null;
        this.bus.emit("change", "powerplatform");
    }

    /** Find an environment by id, display name or domain name. Ambiguous or unknown names fail with suggestions. */
    async resolve(nameOrId: string): Promise<PpEnvironment> {
        const wanted = nameOrId.trim();
        const lower = wanted.toLowerCase();
        const pick = (list: PpEnvironment[]) => list.find((e) => e.id.toLowerCase() === lower) ?? list.filter((e) => e.displayName.toLowerCase() === lower || e.domainName?.toLowerCase() === lower);
        let { environments } = await this.directory();
        let found = pick(environments);
        if (Array.isArray(found) && !found.length) {
            ({ environments } = await this.directory(true));
            found = pick(environments);
        }
        if (!Array.isArray(found)) return found;
        if (found.length === 1) return found[0]!;
        if (found.length > 1) throw new Error(`"${wanted}" matches ${found.length} environments (${found.map((e) => `${e.displayName} ${e.id}`).join(", ")}); give the id instead.`);
        const close = environments.filter((e) => e.displayName.toLowerCase().includes(lower) || lower.includes(e.displayName.toLowerCase())).slice(0, 5);
        throw new Error(`No environment called "${wanted}".${close.length ? ` Did you mean ${close.map((e) => `"${e.displayName}"`).join(" or ")}?` : " Use pp_env_list to see them."}`);
    }

    async group(nameOrId: string): Promise<PpGroup> {
        const { groups } = await this.directory();
        const lower = nameOrId.trim().toLowerCase();
        const found = groups.find((g) => g.id.toLowerCase() === lower || g.displayName.toLowerCase() === lower);
        if (!found) throw new Error(`No environment group called "${nameOrId}". Groups: ${groups.map((g) => g.displayName).join(", ") || "none"}.`);
        return found;
    }

    /** Why changes to this environment are refused, or null when they are not. */
    protection(env: PpEnvironment): string | null {
        const s = this.settings();
        if (s.protectedEnvironments.includes(env.id)) return `${env.displayName} is on the list of protected environments`;
        if (s.protectDefault && env.type.toLowerCase() === "default") return `${env.displayName} is the default environment, which is protected`;
        if (s.protectProduction && env.type.toLowerCase() === "production") return `${env.displayName} is a production environment, and production is protected`;
        return null;
    }

    /** The facts a guardrail rule can match: `sandbox`, `group:HR`, `env:HR Dev`, `managed`. */
    targets(env: PpEnvironment): string[] {
        return [env.type.toLowerCase(), ...(env.groupName ? [`group:${env.groupName}`] : ["no-group"]), `env:${env.displayName}`, ...(env.protectionLevel === "Standard" ? ["managed"] : []), ...(this.protection(env) ? ["protected"] : [])];
    }

    /** "HR Dev (sandbox, group HR)" — how an environment is named to a person approving. */
    describe(env: PpEnvironment): string {
        return `${env.displayName} (${env.type.toLowerCase()}${env.groupName ? `, group ${env.groupName}` : ""}${env.protectionLevel === "Standard" ? ", managed" : ""})`;
    }

    /** Sign in with each identity and make one cheap read, without changing anything. */
    async test(): Promise<Record<PpConnection, { ok: boolean; detail: string }>> {
        const one = async (connection: PpConnection) => {
            const ready = this.identityReady(connection);
            if (!ready.ok) return ready;
            try {
                const client = this.client(connection);
                const res = await client.api("GET", "/environmentmanagement/environments", { query: { $top: 1 } });
                return { ok: true, detail: `Signed in; can see environments${res.body?.value?.length ? "" : " (none returned — check the identity's role)"}` };
            } catch (e) {
                return { ok: false, detail: e instanceof Error ? e.message : String(e) };
            }
        };
        const [reader, operator] = await Promise.all([one("reader"), one("operator")]);
        return { reader, operator };
    }
}
