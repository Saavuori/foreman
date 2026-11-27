import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * A practice Power Platform tenant: the management API (`/environmentmanagement/...`, api-version
 * 2024-10-01), a small part of each environment's Dataverse Web API, and the Entra token endpoint.
 * Shapes follow Microsoft's REST reference. It answers in-process through `fetch` (so core tests
 * and the default setup need no network) and over HTTP under `/mock/powerplatform`.
 *
 * It also plays Power Platform's role-based access: a token for a "reader" principal may only GET.
 */

export interface MockEnvironment {
    id: string;
    displayName: string;
    type: "Default" | "Production" | "Sandbox" | "Developer" | "Trial";
    state: "Ready" | "Deleted";
    domainName: string;
    environmentGroupId: string | null;
    protectionLevel: "Basic" | "Standard";
    adminMode: "Enabled" | "Disabled";
    createdDateTime: string;
    createdBy: { id: string; type: string };
    azureRegion: string;
    geo: string;
    dataverseId: string;
    users: MockUser[];
    backups: MockBackup[];
}
export interface MockUser {
    systemuserid: string;
    fullname: string;
    domainname: string;
    azureactivedirectoryobjectid: string;
    isdisabled: boolean;
    roles: string[];
}
export interface MockBackup {
    id: string;
    label: string;
    backupPointDateTime: string;
    backupExpiryDateTime: string;
    createdBy: { userId: string; displayName: string; type: string };
}
interface MockOperation {
    operationId: string;
    name: string;
    environmentId: string;
    requestedBy: string;
    startTime: string;
    finishAt: number;
    /** What the operation does once it finishes. */
    effect?: () => void;
    done: boolean;
}
export interface MockCall {
    method: string;
    path: string;
    /** Which client id signed the call, or null for the sign-in itself. */
    clientId: string | null;
    status: number;
}
export interface MockHttpRequest {
    method: string;
    /** Everything before the API's own paths, e.g. `http://127.0.0.1:4517/mock/powerplatform`. */
    origin: string;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string | undefined>;
    body: unknown;
}
export interface MockHttpResponse {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
}

export const MOCK_PP_ORIGIN = "https://powerplatform.mock";
export const MOCK_PP_TENANT = "7d1c3a52-9f1e-4f8b-a0c4-3f5e2b9d0a11";
/** Built-in principals of the practice tenant and the role each one holds. */
export const MOCK_PP_PRINCIPALS: Record<string, "reader" | "contributor"> = { "mock-reader": "reader", "mock-operator": "contributor" };

const ROLES = ["System Administrator", "System Customizer", "Environment Maker", "Basic User", "Delegate"];
const PEOPLE: [name: string, upn: string, disabled?: boolean][] = [
    ["Ana Lindqvist", "ana.lindqvist@contoso.test"],
    ["Ben Okafor", "ben.okafor@contoso.test"],
    ["Carla Ruiz", "carla.ruiz@contoso.test"],
    ["Dev Patel", "dev.patel@contoso.test"],
    ["Erik Nyman", "erik.nyman@contoso.test", true],
];
const guid = (seed: string) => {
    const h = createHash("sha256").update(seed).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const err = (status: number, code: string, message: string): MockHttpResponse => ({ status, body: { error: { code, message } } });
const invalid = (field: string, message: string): MockHttpResponse => ({ status: 400, body: { errorDetail: { code: "ValidationFailed", fieldErrors: { [field]: { errorMessages: [message] } } } } });

export class MockPowerPlatform {
    readonly tenantId = MOCK_PP_TENANT;
    private environments = new Map<string, MockEnvironment>();
    private groups = new Map<string, { id: string; displayName: string; description: string }>();
    private operations = new Map<string, MockOperation>();
    private tokens = new Map<string, { clientId: string; role: "reader" | "contributor" }>();
    /** How long a lifecycle operation (copy, reset …) takes. Tests use 0. */
    opDelayMs = 0;
    /** The most recent calls, newest last. Tests use it to see which identity made a call. */
    calls: MockCall[] = [];

    constructor(seed = true) {
        if (seed) this.seed();
    }

    private seed() {
        for (const [name, description] of [["Finance", "Finance apps and their test copies"], ["HR", "People and recruiting apps"], ["Sandboxes", "Short-lived team sandboxes"]] as const) {
            const id = guid(`group:${name}`);
            this.groups.set(id, { id, displayName: name, description });
        }
        const group = (name: string) => [...this.groups.values()].find((g) => g.displayName === name)!.id;
        const envs: [string, MockEnvironment["type"], string | null, number][] = [
            ["Contoso (default)", "Default", null, 1500],
            ["Finance Production", "Production", "Finance", 900],
            ["Finance Test", "Sandbox", "Finance", 400],
            ["HR Production", "Production", "HR", 800],
            ["HR Dev", "Sandbox", "HR", 120],
            ["Sales Old", "Sandbox", null, 700],
            ["Mika Developer", "Developer", null, 30],
        ];
        for (const [name, type, groupName, age] of envs) {
            const id = type === "Default" ? `Default-${MOCK_PP_TENANT}` : guid(`env:${name}`);
            this.addEnvironment({ id, displayName: name, type, environmentGroupId: groupName ? group(groupName) : null, createdDateTime: daysAgo(age), protectionLevel: type === "Production" ? "Standard" : "Basic" });
        }
        // Some people have roles; Carla and Dev have none in HR Dev, which is what access requests are for.
        const roleOf: Record<string, Record<string, string[]>> = {
            "ana.lindqvist@contoso.test": { "*": ["System Administrator"] },
            "ben.okafor@contoso.test": { "*": ["Basic User"], "Finance Test": ["Basic User", "Environment Maker"] },
            "carla.ruiz@contoso.test": { "*": ["Basic User"], "HR Dev": [] },
            "dev.patel@contoso.test": { "*": ["Basic User"], "Mika Developer": ["System Administrator"], "HR Dev": [] },
            "erik.nyman@contoso.test": { "*": ["Environment Maker"] },
        };
        for (const env of this.environments.values()) {
            for (const [name, upn, disabled] of PEOPLE) {
                const roles = roleOf[upn]![env.displayName] ?? roleOf[upn]!["*"]!;
                env.users.push({ systemuserid: guid(`user:${env.id}:${upn}`), fullname: name, domainname: upn, azureactivedirectoryobjectid: guid(`aad:${upn}`), isdisabled: !!disabled, roles: [...roles] });
            }
        }
    }

    private addEnvironment(input: { id?: string; displayName: string; type: MockEnvironment["type"]; environmentGroupId?: string | null; createdDateTime?: string; protectionLevel?: MockEnvironment["protectionLevel"]; domainName?: string; requestedBy?: string }): MockEnvironment {
        const id = input.id ?? randomUUID();
        let domain = input.domainName || `contoso-${input.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
        while ([...this.environments.values()].some((e) => e.domainName === domain && e.state !== "Deleted")) domain += "0";
        const env: MockEnvironment = {
            id,
            displayName: input.displayName,
            type: input.type,
            state: "Ready",
            domainName: domain,
            environmentGroupId: input.environmentGroupId ?? null,
            protectionLevel: input.protectionLevel ?? "Basic",
            adminMode: "Disabled",
            createdDateTime: input.createdDateTime ?? new Date().toISOString(),
            createdBy: { id: input.requestedBy ?? guid("aad:ana.lindqvist@contoso.test"), type: "User" },
            azureRegion: "northeurope",
            geo: "europe",
            dataverseId: guid(`org:${id}`),
            users: [],
            backups: input.type === "Default" ? [] : [1, 3].map((d) => ({ id: guid(`backup:${id}:${d}`), label: "System backup", backupPointDateTime: daysAgo(d), backupExpiryDateTime: daysAgo(d - 7), createdBy: { userId: "system", displayName: "System", type: "Application" } })),
        };
        this.environments.set(id, env);
        return env;
    }

    // ── helpers for tests and the UI ─────────────────────────────────────
    list(): MockEnvironment[] {
        return [...this.environments.values()].filter((e) => e.state !== "Deleted");
    }
    find(nameOrId: string): MockEnvironment | undefined {
        return this.environments.get(nameOrId) ?? this.list().find((e) => e.displayName.toLowerCase() === nameOrId.toLowerCase());
    }
    groupList() {
        return [...this.groups.values()];
    }

    /** The mock as `fetch`: the same Request/Response path as the network, without the network. */
    fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
        const url = new URL(String(input));
        if (!url.href.startsWith(MOCK_PP_ORIGIN)) throw new Error(`The practice tenant does not answer ${url.origin}`);
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        let body: unknown;
        if (typeof init.body === "string" && init.body) body = /form-urlencoded/.test(headers["content-type"] ?? "") ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
        const res = this.handle({ method: (init.method ?? "GET").toUpperCase(), origin: MOCK_PP_ORIGIN, path: url.pathname, query: url.searchParams, headers, body });
        const hasBody = res.body !== undefined && res.status !== 204;
        return new Response(hasBody ? JSON.stringify(res.body) : null, { status: res.status, headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...res.headers } });
    };

    handle(req: MockHttpRequest): MockHttpResponse {
        const res = this.route(req);
        const clientId = req.path.startsWith("/login/") ? null : (this.tokens.get((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))?.clientId ?? null);
        this.calls.push({ method: req.method, path: req.path, clientId, status: res.status });
        if (this.calls.length > 300) this.calls.splice(0, this.calls.length - 300);
        return res;
    }

    private route(req: MockHttpRequest): MockHttpResponse {
        const { method, path } = req;
        const login = /^\/login\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(path);
        if (login && method === "POST") return this.token(login[1]!, (req.body ?? {}) as Record<string, string>);

        const principal = this.tokens.get((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
        if (!principal) return err(401, "Unauthorized", "Missing or unknown access token (practice tenant).");
        if (method !== "GET" && principal.role === "reader") return err(403, "Forbidden", `The principal ${principal.clientId} holds the Power Platform reader role, which only allows reading.`);

        const dv = /^\/dataverse\/([^/]+)\/api\/data\/v9\.2\/(.+)$/.exec(path);
        if (dv) return this.dataverse(req, decodeURIComponent(dv[1]!), dv[2]!, principal.clientId);
        if (req.query.get("api-version") !== "2024-10-01") return err(400, "InvalidApiVersion", "Use api-version=2024-10-01.");
        return this.management(req, principal.clientId);
    }

    private token(tenant: string, form: Record<string, string>): MockHttpResponse {
        if (tenant !== MOCK_PP_TENANT && tenant !== "organizations") return { status: 400, body: { error: "invalid_request", error_description: `AADSTS90002: Tenant '${tenant}' not found (practice tenant is ${MOCK_PP_TENANT}).` } };
        if (form.grant_type !== "client_credentials") return { status: 400, body: { error: "unsupported_grant_type", error_description: "Only client_credentials is supported here." } };
        const role = MOCK_PP_PRINCIPALS[form.client_id ?? ""];
        if (!role || !form.client_secret) return { status: 401, body: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret or unknown application (practice tenant knows mock-reader and mock-operator)." } };
        const token = `mockpp.${randomBytes(18).toString("base64url")}`;
        this.tokens.set(token, { clientId: form.client_id!, role });
        return { status: 200, body: { token_type: "Bearer", expires_in: 3599, access_token: token } };
    }

    // ── management plane ─────────────────────────────────────────────────
    private present(env: MockEnvironment, origin: string) {
        const { users: _u, backups: _b, ...rest } = env;
        return { ...rest, tenantId: this.tenantId, url: `${origin}/dataverse/${encodeURIComponent(env.id)}/`, version: "9.2.26111.00000" };
    }

    private startOperation(name: string, env: MockEnvironment | string, requestedBy: string, origin: string, effect?: () => void): MockHttpResponse {
        const operationId = randomUUID();
        const op: MockOperation = { operationId, name, environmentId: typeof env === "string" ? env : env.id, requestedBy, startTime: new Date().toISOString(), finishAt: Date.now() + this.opDelayMs, effect, done: false };
        this.operations.set(operationId, op);
        this.settle(op);
        return { status: 202, headers: { "operation-location": `${origin}/environmentmanagement/operations/${operationId}?api-version=2024-10-01` }, body: this.operationView(op) };
    }
    private settle(op: MockOperation) {
        if (op.done || Date.now() < op.finishAt) return;
        op.done = true;
        op.effect?.();
    }
    private operationView(op: MockOperation) {
        this.settle(op);
        const env = this.environments.get(op.environmentId);
        return {
            operationId: op.operationId,
            name: op.name,
            status: op.done ? "Succeeded" : "InProgress",
            startTime: op.startTime,
            endTime: op.done ? new Date(Math.max(op.finishAt, Date.parse(op.startTime))).toISOString() : null,
            requestedBy: { userId: op.requestedBy, type: "ServicePrincipal" },
            stageStatuses: [{ name: op.name, status: op.done ? "Succeeded" : "InProgress" }],
            errorDetail: null,
            updatedEnvironment: env ? { environmentId: env.id, displayName: env.displayName } : null,
        };
    }

    private filterEnvironments(filter: string | null): MockEnvironment[] {
        let list = this.list();
        if (!filter) return list;
        for (const clause of filter.split(/\s+and\s+/i)) {
            const m = /^\s*(\w+)\s+eq\s+'([^']*)'\s*$/i.exec(clause);
            if (!m) continue;
            const [, field, value] = m;
            list = list.filter((e) => String((e as unknown as Record<string, unknown>)[field!] ?? "").toLowerCase() === value!.toLowerCase());
        }
        return list;
    }

    private management(req: MockHttpRequest, clientId: string): MockHttpResponse {
        const { method, path, query, origin } = req;
        const body = (req.body ?? {}) as Record<string, any>;
        const validateOnly = /^true$/i.test(query.get("ValidateOnly") ?? "");
        const passed = { status: 200, body: { status: "ValidationPassed" } };
        const base = "/environmentmanagement";

        if (method === "GET" && path === `${base}/environments`) {
            const all = this.filterEnvironments(query.get("$filter"));
            const skip = Number(query.get("$skip") ?? 0) || 0;
            const top = Number(query.get("$top") ?? 0) || 50;
            const page = all.slice(skip, skip + top);
            const next = skip + top < all.length ? `${origin}${base}/environments?api-version=2024-10-01&$top=${top}&$skip=${skip + top}${query.get("$filter") ? `&$filter=${encodeURIComponent(query.get("$filter")!)}` : ""}` : undefined;
            return { status: 200, body: { value: page.map((e) => this.present(e, origin)), ...(next ? { "@odata.nextlink": next } : {}) } };
        }
        if (method === "GET" && path === `${base}/environmentGroups`) return { status: 200, body: { value: this.groupList().map((g) => ({ ...g, parentGroupId: null, childrenGroupIds: [] })) } };
        if (method === "POST" && path === `${base}/provisioning/environments`) {
            if (!body.displayName) return invalid("displayName", "The display name is required.");
            const sku = String(body.environmentSku ?? "");
            if (!["Sandbox", "Production", "Developer", "Trial"].includes(sku)) return invalid("environmentSku", `Use Sandbox, Production, Developer or Trial (got "${sku}").`);
            const groupId = body.parentEnvironmentGroup?.id ?? null;
            if (groupId && !this.groups.has(groupId)) return invalid("parentEnvironmentGroup", "No such environment group.");
            if (validateOnly) return passed;
            const env = this.addEnvironment({ displayName: body.displayName, type: sku as MockEnvironment["type"], environmentGroupId: groupId, protectionLevel: body.governanceConfiguration?.protectionLevel === "Standard" ? "Standard" : "Basic", domainName: body.linkedEnvironmentMetadata?.domainName, requestedBy: clientId });
            for (const [name, upn] of PEOPLE.slice(0, 1)) env.users.push({ systemuserid: guid(`user:${env.id}:${upn}`), fullname: name, domainname: upn, azureactivedirectoryobjectid: guid(`aad:${upn}`), isdisabled: false, roles: ["System Administrator"] });
            const started = this.startOperation("ProvisionEnvironment", env, clientId, origin);
            return { ...started, status: 201 };
        }
        const op = new RegExp(`^${base}/operations/([^/]+)$`).exec(path);
        if (method === "GET" && op) {
            const found = this.operations.get(op[1]!);
            return found ? { status: 200, body: this.operationView(found) } : err(404, "NotFound", "No such operation.");
        }
        const addToGroup = new RegExp(`^${base}/environmentGroups/([^/]+)/addEnvironment/([^/]+)$`).exec(path);
        if (method === "POST" && addToGroup) {
            const group = this.groups.get(addToGroup[1]!);
            const env = this.environments.get(decodeURIComponent(addToGroup[2]!));
            if (!group) return { status: 400, body: { title: "Bad Request", status: 400, detail: "No such environment group." } };
            if (!env || env.state === "Deleted") return { status: 400, body: { title: "Bad Request", status: 400, detail: "No such environment." } };
            if (env.type === "Default") return { status: 400, body: { title: "Bad Request", status: 400, detail: "The default environment cannot join an environment group." } };
            return this.startOperation("AddEnvironmentToGroup", env, clientId, origin, () => (env.environmentGroupId = group.id));
        }

        const m = new RegExp(`^${base}/environments/([^/]+)(/.*)?$`).exec(path);
        if (!m) return err(404, "NotFound", `No route for ${method} ${path} in the practice tenant.`);
        const env = this.environments.get(decodeURIComponent(m[1]!));
        if (!env || env.state === "Deleted") return err(404, "EnvironmentNotFound", `Environment ${decodeURIComponent(m[1]!)} was not found.`);
        const rest = m[2] ?? "";

        if (method === "GET" && rest === "") return { status: 200, body: this.present(env, origin) };
        if (method === "DELETE" && rest === "") {
            if (env.type === "Default") return invalid("environmentId", "The default environment cannot be deleted.");
            if (validateOnly) return passed;
            return this.startOperation("DeleteEnvironment", env, clientId, origin, () => (env.state = "Deleted"));
        }
        if (method === "GET" && rest === "/backups") return { status: 200, body: { collection: env.backups, continuationToken: null } };
        if (method === "POST" && rest === "/backups") {
            if (!body.label) return invalid("label", "A backup needs a label.");
            if (env.type === "Default") return invalid("environmentId", "Manual backups are not available for the default environment.");
            const backup: MockBackup = { id: randomUUID(), label: String(body.label), backupPointDateTime: new Date().toISOString(), backupExpiryDateTime: new Date(Date.now() + 7 * 86_400_000).toISOString(), createdBy: { userId: clientId, displayName: clientId, type: "ServicePrincipal" } };
            env.backups.unshift(backup);
            return { status: 201, body: backup };
        }
        if (method === "GET" && rest === "/operations") {
            const list = [...this.operations.values()].filter((o) => o.environmentId === env.id).reverse();
            return { status: 200, body: { collection: list.slice(0, Number(query.get("limit") ?? 20) || 20).map((o) => this.operationView(o)), continuationToken: null } };
        }
        if (method === "GET" && rest === "/settings") return { status: 200, body: { objectResult: [{ id: guid(`settings:${env.id}`), tenantId: this.tenantId, powerApps_CopilotChat: true, powerApps_NLSearch: true, enableIpBasedStorageAccessSignatureRule: false }], nextLink: null } };
        if (method === "POST" && rest === "/governanceSetting/enableManaged") {
            if (env.protectionLevel === "Standard") return invalid("protectionLevel", "The environment is already managed.");
            if (validateOnly) return passed;
            return this.startOperation("EnableManagedEnvironment", env, clientId, origin, () => (env.protectionLevel = "Standard"));
        }
        if (method === "POST" && rest === "/reset") {
            if (!["Sandbox", "Developer", "Trial"].includes(env.type)) return invalid("environmentId", `Only sandbox, developer and trial environments can be reset; ${env.displayName} is ${env.type}.`);
            if (validateOnly) return passed;
            return this.startOperation("ResetEnvironment", env, clientId, origin, () => {
                if (body.displayName) env.displayName = String(body.displayName);
                env.users = env.users.filter((u) => u.roles.includes("System Administrator"));
                env.backups = [];
            });
        }
        if (method === "POST" && (rest === "/copy" || rest === "/restore")) {
            const source = this.environments.get(String(body.sourceEnvironmentId ?? ""));
            if (!source || source.state === "Deleted") return invalid("sourceEnvironmentId", "No such source environment.");
            if (env.type === "Default" || env.type === "Production" && rest === "/copy") return invalid("targetEnvironmentId", `${env.displayName} (${env.type}) cannot be overwritten by a copy.`);
            if (rest === "/copy") {
                if (source.id === env.id) return invalid("sourceEnvironmentId", "An environment cannot be copied onto itself.");
                if (!["Minimal", "Full"].includes(body.copyType)) return invalid("copyType", "Use Minimal or Full.");
                if (source.protectionLevel !== env.protectionLevel) return invalid("protectionLevel", "Source and target must both be managed or both unmanaged.");
            } else {
                const at = Date.parse(String(body.restorePointDateTime ?? ""));
                if (Number.isNaN(at)) return invalid("restorePointDateTime", "Give a restore point as a date and time.");
                if (at > Date.now() || at < Date.now() - 28 * 86_400_000) return invalid("restorePointDateTime", "The restore point must be within the last 28 days.");
            }
            if (validateOnly) return passed;
            return this.startOperation(rest === "/copy" ? "CopyEnvironment" : "RestoreEnvironment", env, clientId, origin, () => {
                env.users = source.users.map((u) => ({ ...u, systemuserid: guid(`user:${env.id}:${u.domainname}`), roles: [...u.roles] }));
                const override = body.copyOptions?.environmentNameToOverride ?? body.restoreOptions?.environmentNameToOverride;
                if (override) env.displayName = String(override);
            });
        }
        return err(404, "NotFound", `No route for ${method} ${path} in the practice tenant.`);
    }

    // ── Dataverse Web API (a small part) ─────────────────────────────────
    private roleId(env: MockEnvironment, name: string) {
        return guid(`role:${env.id}:${name}`);
    }
    private userView(env: MockEnvironment, u: MockUser, expandRoles: boolean) {
        const { roles, ...rest } = u;
        return { ...rest, ...(expandRoles ? { systemuserroles_association: roles.map((r) => ({ roleid: this.roleId(env, r), name: r })) } : {}) };
    }

    private dataverse(req: MockHttpRequest, envId: string, resource: string, clientId: string): MockHttpResponse {
        const env = this.environments.get(envId);
        if (!env || env.state === "Deleted") return err(404, "0x80040217", "The environment's database was not found.");
        const { method, query } = req;
        const filter = query.get("$filter") ?? "";
        const eq = (field: string) => new RegExp(`${field}\\s+eq\\s+'([^']*)'`, "i").exec(filter)?.[1];
        if (method === "GET" && resource === "WhoAmI") return { status: 200, body: { UserId: guid(`app:${clientId}`), BusinessUnitId: guid(`bu:${env.id}`), OrganizationId: env.dataverseId } };
        if (method === "GET" && resource === "systemusers") {
            let users = env.users;
            const upn = eq("domainname");
            const aad = /azureactivedirectoryobjectid\s+eq\s+'?([0-9a-f-]+)'?/i.exec(filter)?.[1];
            if (upn) users = users.filter((u) => u.domainname.toLowerCase() === upn.toLowerCase());
            if (aad) users = users.filter((u) => u.azureactivedirectoryobjectid === aad);
            if (/isdisabled\s+eq\s+false/i.test(filter)) users = users.filter((u) => !u.isdisabled);
            const top = Number(query.get("$top") ?? 0) || 5000;
            return { status: 200, body: { value: users.slice(0, top).map((u) => this.userView(env, u, /systemuserroles_association/.test(query.get("$expand") ?? ""))) } };
        }
        if (method === "GET" && resource === "roles") {
            const name = eq("name");
            const roles = ROLES.filter((r) => !name || r.toLowerCase() === name.toLowerCase());
            return { status: 200, body: { value: roles.map((r) => ({ roleid: this.roleId(env, r), name: r })) } };
        }
        const assoc = /^systemusers\(([0-9a-f-]+)\)\/systemuserroles_association(?:\(([0-9a-f-]+)\))?\/\$ref$/i.exec(resource);
        if (assoc) {
            const user = env.users.find((u) => u.systemuserid === assoc[1]);
            if (!user) return err(404, "0x80040217", "systemuser With Id = " + assoc[1] + " Does Not Exist");
            if (method === "POST" && !assoc[2]) {
                const ref = String((req.body as { "@odata.id"?: string } | undefined)?.["@odata.id"] ?? "");
                const roleId = /roles\(([0-9a-f-]+)\)/i.exec(ref)?.[1];
                const role = ROLES.find((r) => this.roleId(env, r) === roleId);
                if (!role) return err(400, "0x80040217", "role With Id = " + roleId + " Does Not Exist");
                if (user.isdisabled) return err(400, "0x80040225", "The user is disabled and cannot be given a role.");
                if (!user.roles.includes(role)) user.roles.push(role);
                return { status: 204 };
            }
            if (method === "DELETE" && assoc[2]) {
                const role = ROLES.find((r) => this.roleId(env, r) === assoc[2]);
                if (role) user.roles = user.roles.filter((r) => r !== role);
                return { status: 204 };
            }
        }
        return err(404, "0x8006088a", `Resource not found for the segment '${resource.split("?")[0]}' (practice tenant).`);
    }
}
