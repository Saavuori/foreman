import { createPublicKey, generateKeyPairSync, randomUUID, sign as rsaSign, verify as rsaVerify, type JsonWebKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import { toAdaptiveCard, type MockTeams, type NotifyEvent } from "./notify.ts";
import type { Actor, Bus } from "./registry.ts";
import type { Approval } from "./schemas.ts";
import type { Store } from "./store.ts";
import type { Vault } from "./vault.ts";

// A Teams bot, spoken to over the Bot Framework REST protocol directly (no Bot Framework SDK):
// Teams POSTs activities to the messaging endpoint, Foreman verifies the Bot Framework's signed
// token, and answers card button presses with an updated card. Cards Foreman posts itself go
// through the Bot Connector API with a token from Microsoft Entra.

export const TeamsBotSettings = z.object({
    enabled: z.boolean().default(false),
    /** The bot's Microsoft App ID (from the Azure Bot resource). */
    appId: z.string().default(""),
    /** Entra tenant of a single-tenant bot. Empty means a multi-tenant bot. */
    tenantId: z.string().default(""),
    /** Vault secret holding the app's client secret. */
    secretName: z.string().default(""),
    /** Entra object ids of the people who may decide from Teams. Empty means anyone who can see the card. */
    approvers: z.array(z.string()).default([]),
    /** Talk to the built-in mock Bot Framework instead of Microsoft. */
    mock: z.boolean().default(false),
});
export type TeamsBotSettings = z.infer<typeof TeamsBotSettings>;

export interface BotConversation {
    id: string;
    name: string;
    kind: string;
    serviceUrl: string;
    seenAt: string;
}

/** What Teams sends. Only the fields Foreman reads. */
export interface Activity {
    type: string;
    name?: string;
    id?: string;
    channelId?: string;
    serviceUrl?: string;
    replyToId?: string;
    from?: { id?: string; name?: string; aadObjectId?: string };
    conversation?: { id?: string; name?: string; conversationType?: string };
    channelData?: { team?: { name?: string }; channel?: { name?: string } };
    membersAdded?: { id?: string }[];
    value?: { action?: { type?: string; verb?: string; data?: Record<string, unknown> } };
}

const MICROSOFT = { openId: "https://login.botframework.com/v1/.well-known/openidconfiguration", login: "https://login.microsoftonline.com" };
const ISSUER = "https://api.botframework.com";
const SKEW_S = 300;
const CARD = "application/vnd.microsoft.card.adaptive";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, service_url TEXT NOT NULL, seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_cards (activity_id TEXT NOT NULL, conversation_id TEXT NOT NULL, approval_id TEXT, card TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (conversation_id, activity_id));
`;

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const withSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`);

/** The card after a decision: buttons and the answer box removed, the outcome added. */
export function decidedCard(card: any, approval: Approval) {
    const by = approval.decidedBy ?? "";
    const who = by.startsWith("teams:") ? by.slice(6).replace(/ · .*$/, "") : by.startsWith("mcp:") ? `${by.slice(4)} (over MCP)` : by === "user:local" ? "someone in Foreman" : by || "someone";
    const outcome =
        approval.status === "expired"
            ? { text: "No longer waiting — the run ended or the server restarted.", color: "Default" }
            : approval.kind === "question"
              ? approval.status === "approved"
                  ? { text: `Answered by ${who}: ${approval.reason ?? ""}`, color: "Good" }
                  : { text: `Declined by ${who}`, color: "Attention" }
              : { text: `${approval.status === "approved" ? "Approved" : "Denied"} by ${who}`, color: approval.status === "approved" ? "Good" : "Attention" };
    return {
        ...card,
        body: [...(card.body ?? []).filter((el: any) => el.type !== "Input.Text"), { type: "TextBlock", text: outcome.text, weight: "Bolder", color: outcome.color, wrap: true, spacing: "Medium" }],
        actions: (card.actions ?? []).filter((a: any) => a.type !== "Action.Execute"),
    };
}

export interface TeamsBotOptions {
    baseUrl: string;
    vault: Vault;
    mock: MockBotFramework;
    fetch?: typeof fetch;
}
type Decider = (approvalId: string, approve: boolean, reason: string | undefined, actor: Actor) => Promise<unknown>;

export class TeamsBot {
    private keys?: { url: string; at: number; keys: (JsonWebKey & { kid?: string; endorsements?: string[] })[] };
    private token?: { value: string; until: number; key: string };
    private decide?: Decider;
    private doFetch: typeof fetch;

    constructor(
        private store: Store,
        private bus: Bus,
        private options: TeamsBotOptions,
    ) {
        store.db.exec(SCHEMA);
        this.doFetch = options.fetch ?? fetch;
    }

    /** Decisions go through the `approvals.decide` capability so they are checked and audited like any other. */
    setDecider(decide: Decider) {
        this.decide = decide;
    }
    start() {
        this.bus.on("approval", this.onApproval);
    }
    stop() {
        this.bus.off("approval", this.onApproval);
    }

    settings(): TeamsBotSettings {
        return TeamsBotSettings.parse(this.store.getSetting("teams.bot") ?? {});
    }
    configure(patch: Partial<TeamsBotSettings>): TeamsBotSettings {
        const next = TeamsBotSettings.parse({ ...this.settings(), ...patch });
        if (next.enabled && !next.mock && (!next.appId || !next.secretName)) throw new Error("Give the bot's app ID and the name of the secret holding its client secret before turning it on");
        if (next.enabled && !next.mock && !this.options.vault.has(next.secretName)) throw new Error(`Secret "${next.secretName}" does not exist; store the client secret first with secrets.set`);
        this.store.setSetting("teams.bot", next);
        this.token = undefined;
        this.bus.emit("change", "notify");
        return next;
    }
    /** The address to enter as the Azure Bot's messaging endpoint. */
    messagingEndpoint() {
        return `${this.options.baseUrl}/hooks/teams/messages`;
    }
    private endpoints() {
        return this.settings().mock ? this.options.mock.endpoints() : MICROSOFT;
    }
    private appId() {
        const s = this.settings();
        return s.mock ? this.options.mock.appId : s.appId;
    }

    listConversations(): BotConversation[] {
        return this.store.db.prepare("SELECT * FROM bot_conversations ORDER BY seen_at DESC").all().map((r: any) => ({ id: r.id, name: r.name, kind: r.kind, serviceUrl: r.service_url, seenAt: r.seen_at }));
    }
    getConversation(id: string): BotConversation | undefined {
        return this.listConversations().find((c) => c.id === id);
    }

    // ── inbound ───────────────────────────────────────────────────────────
    /** Handle one POST to the messaging endpoint. Returns the HTTP status and body to answer with. */
    async receive(authorization: string | undefined, activity: Activity): Promise<{ status: number; body: unknown }> {
        if (!this.settings().enabled) return { status: 403, body: { error: "The Teams bot is turned off in Foreman" } };
        try {
            await this.verify(authorization, activity);
        } catch (e) {
            return { status: 401, body: { error: e instanceof Error ? e.message : String(e) } };
        }
        // Only a verified activity may tell Foreman where to send things: the service URL receives the bot's token.
        this.remember(activity);
        if (activity.type === "invoke" && activity.name === "adaptiveCard/action") return { status: 200, body: await this.onAction(activity) };
        return { status: 200, body: {} };
    }

    private remember(activity: Activity) {
        const id = activity.conversation?.id;
        if (!id || !activity.serviceUrl) return;
        // Only some activities carry the team and channel names (a button press does not), so a known name is kept.
        const named = [activity.channelData?.team?.name, activity.channelData?.channel?.name ?? activity.conversation?.name].filter(Boolean).join(" › ");
        const name = named || this.getConversation(id)?.name || (activity.conversation?.conversationType === "personal" ? `Chat with ${activity.from?.name ?? "a person"}` : id.slice(0, 24));
        this.store.db
            .prepare("INSERT INTO bot_conversations (id, name, kind, service_url, seen_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, service_url = excluded.service_url, seen_at = excluded.seen_at")
            .run(id, name, activity.conversation?.conversationType ?? "channel", activity.serviceUrl, new Date().toISOString());
        this.bus.emit("change", "notify");
    }

    /** The checks the Bot Connector authentication guide lists, all of them. */
    private async verify(authorization: string | undefined, activity: Activity) {
        const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
        if (!token) throw new Error("No Bot Framework token");
        const [h, p, s] = token.split(".");
        if (!h || !p || !s) throw new Error("Malformed token");
        const header = JSON.parse(Buffer.from(h, "base64url").toString());
        const claims = JSON.parse(Buffer.from(p, "base64url").toString());
        if (header.alg !== "RS256") throw new Error("Unexpected signing algorithm");
        const key = (await this.signingKeys()).find((k) => k.kid === header.kid);
        if (!key) throw new Error("Token signed with an unknown key");
        if (!rsaVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key, format: "jwk" }), Buffer.from(s, "base64url"))) throw new Error("Bad token signature");
        const now = Date.now() / 1000;
        if (claims.iss !== ISSUER) throw new Error("Token from the wrong issuer");
        if (claims.aud !== this.appId()) throw new Error("Token meant for another bot");
        if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now || (claims.nbf ?? 0) - SKEW_S > now) throw new Error("Token expired or not yet valid");
        if (claims.serviceUrl !== activity.serviceUrl) throw new Error("Token does not match the activity's service URL");
        if (key.endorsements && activity.channelId && !key.endorsements.includes(activity.channelId)) throw new Error("Signing key is not endorsed for this channel");
    }

    private async signingKeys() {
        const url = this.endpoints().openId;
        // Microsoft asks for a refresh at least daily; new keys may appear at any time.
        if (this.keys?.url === url && Date.now() - this.keys.at < 6 * 3600_000) return this.keys.keys;
        const meta = (await (await this.doFetch(url, { signal: AbortSignal.timeout(10_000) })).json()) as { jwks_uri: string };
        const keys = ((await (await this.doFetch(meta.jwks_uri, { signal: AbortSignal.timeout(10_000) })).json()) as { keys: any[] }).keys;
        this.keys = { url, at: Date.now(), keys };
        return keys;
    }

    private async onAction(activity: Activity) {
        const message = (text: string) => ({ statusCode: 200, type: "application/vnd.microsoft.activity.message", value: text });
        const action = activity.value?.action;
        const approvalId = String(action?.data?.approvalId ?? "");
        const approval = approvalId ? this.store.getApproval(approvalId) : undefined;
        if (!approval) return message("Foreman does not know this request any more.");
        const stored = activity.replyToId && activity.conversation?.id ? this.cardRow(activity.conversation.id, activity.replyToId) : undefined;
        const card = stored ? JSON.parse(stored.card) : { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text: approval.summary, wrap: true }], actions: [] };
        if (approval.status !== "pending") return { statusCode: 200, type: CARD, value: decidedCard(card, approval) };

        const from = activity.from ?? {};
        const { approvers } = this.settings();
        if (approvers.length && !approvers.includes(from.aadObjectId ?? "")) return message(`${from.name ?? "You"} is not on Foreman's list of people who may decide from Teams. Open Foreman to decide.`);
        const verb = action?.verb;
        const answer = typeof action?.data?.answer === "string" ? action.data.answer.trim() : "";
        if (verb === "answer" && !answer) return message("Write an answer first.");
        if (!this.decide) return message("Foreman is not ready to take decisions yet.");
        const actor: Actor = { kind: "teams", id: `${from.name ?? "unknown"}${from.aadObjectId ? ` · ${from.aadObjectId}` : ""}` };
        try {
            await this.decide(approval.id, verb === "approve" || verb === "answer", verb === "answer" ? answer : verb === "deny" ? "Denied in Teams" : undefined, actor);
        } catch (e) {
            return message(e instanceof Error ? e.message : String(e));
        }
        return { statusCode: 200, type: CARD, value: decidedCard(card, this.store.getApproval(approval.id)!) };
    }

    private cardRow(conversationId: string, activityId: string) {
        return this.store.db.prepare("SELECT * FROM bot_cards WHERE conversation_id = ? AND activity_id = ?").get(conversationId, activityId) as { card: string; approval_id: string | null } | undefined;
    }

    // ── outbound ──────────────────────────────────────────────────────────
    private async accessToken(): Promise<string> {
        const s = this.settings();
        const key = `${s.mock}:${s.appId}:${s.tenantId}`;
        if (this.token?.key === key && this.token.until > Date.now()) return this.token.value;
        const secret = s.mock ? this.options.mock.appSecret : this.options.vault.use(s.secretName);
        const url = `${this.endpoints().login}/${encodeURIComponent(s.tenantId || "botframework.com")}/oauth2/v2.0/token`;
        const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.appId(), client_secret: secret, scope: "https://api.botframework.com/.default" });
        const res = await this.doFetch(url, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
        const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
        if (!res.ok || !json.access_token) throw new Error(`Microsoft Entra refused the bot's sign-in (${res.status}${json.error_description ? `: ${json.error_description.split("\r")[0]}` : ""})`);
        this.token = { value: json.access_token, until: Date.now() + ((json.expires_in ?? 3600) - 120) * 1000, key };
        return json.access_token;
    }

    private async connector(method: "POST" | "PUT", conversation: BotConversation, path: string, body: unknown) {
        const res = await this.doFetch(`${withSlash(conversation.serviceUrl)}v3/conversations/${encodeURIComponent(conversation.id)}/activities${path}`, {
            method,
            headers: { "content-type": "application/json", authorization: `Bearer ${await this.accessToken()}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Teams answered ${res.status}${res.status === 403 || res.status === 404 ? " — the bot may have been removed from this conversation" : ""}`);
        return (await res.json().catch(() => ({}))) as { id?: string };
    }

    /** Post an event as a card the reader can act on. */
    async post(conversationId: string, event: NotifyEvent) {
        if (!this.settings().enabled) throw new Error("The Teams bot is turned off");
        const conversation = this.getConversation(conversationId);
        if (!conversation) throw new Error("The bot has not been added to this conversation yet");
        const card = toAdaptiveCard(event, { interactive: true });
        const sent = await this.connector("POST", conversation, "", { type: "message", attachments: [{ contentType: CARD, content: card }] });
        if (sent.id) this.store.db.prepare("INSERT OR REPLACE INTO bot_cards (activity_id, conversation_id, approval_id, card, created_at) VALUES (?,?,?,?,?)").run(sent.id, conversationId, event.decision?.approvalId ?? null, JSON.stringify(card), new Date().toISOString());
    }

    /** Once an approval is settled anywhere, every card that offered it shows the outcome instead of buttons. */
    private onApproval = (approval: Approval) => {
        if (approval.status === "pending") return;
        const rows = this.store.db.prepare("SELECT * FROM bot_cards WHERE approval_id = ?").all(approval.id) as { activity_id: string; conversation_id: string; card: string }[];
        for (const row of rows) {
            const conversation = this.getConversation(row.conversation_id);
            const card = decidedCard(JSON.parse(row.card), approval);
            this.store.db.prepare("UPDATE bot_cards SET approval_id = NULL, card = ? WHERE conversation_id = ? AND activity_id = ?").run(JSON.stringify(card), row.conversation_id, row.activity_id);
            if (conversation) void this.connector("PUT", conversation, `/${encodeURIComponent(row.activity_id)}`, { type: "message", id: row.activity_id, attachments: [{ contentType: CARD, content: card }] }).catch(() => {});
        }
    };
}

// ── Mock Bot Framework ─────────────────────────────────────────────────────

/**
 * A stand-in for the Bot Framework and Teams: it signs activities with its own key, publishes that
 * key the way Microsoft does, issues tokens and receives the bot's messages into the Teams preview.
 * Foreman's bot code takes the same path against it as against Microsoft, only at another address.
 */
export class MockBotFramework {
    readonly appId = "00000000-0000-4000-8000-00000000b075";
    readonly appSecret = randomUUID();
    /** Where Foreman can be reached, for calls in both directions. Tests point it at their port. */
    serverUrl: string;
    private privateKey: KeyObject;
    private jwk: JsonWebKey & { kid: string; use: string; endorsements: string[] };
    private issued = new Set<string>();

    constructor(
        baseUrl: string,
        private teams: MockTeams,
    ) {
        this.serverUrl = baseUrl;
        const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        this.privateKey = privateKey;
        this.jwk = { ...publicKey.export({ format: "jwk" }), kid: "mock-botframework-1", use: "sig", endorsements: ["msteams"] };
    }

    private root() {
        return `${this.serverUrl}/mock/botframework`;
    }
    endpoints() {
        return { openId: `${this.root()}/openid`, login: `${this.root()}/login` };
    }
    serviceUrl() {
        return `${this.root()}/`;
    }
    openIdDocument() {
        return { issuer: ISSUER, jwks_uri: `${this.root()}/keys`, id_token_signing_alg_values_supported: ["RS256"] };
    }
    keys() {
        return { keys: [this.jwk] };
    }

    /** Client-credentials sign-in for the bot. */
    issueToken(clientId: string, clientSecret: string): { access_token: string; expires_in: number; token_type: string } | null {
        if (clientId !== this.appId || clientSecret !== this.appSecret) return null;
        const token = `mock-${randomUUID()}`;
        this.issued.add(token);
        return { access_token: token, expires_in: 3600, token_type: "Bearer" };
    }
    authorised(header: string | undefined) {
        return this.issued.has(/^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "");
    }

    /** The bot posted or replaced a message in a conversation. */
    receive(conversationId: string, activity: any, replaceId?: string) {
        const payload = { type: "message", attachments: activity.attachments ?? [] };
        if (replaceId) return this.teams.update(replaceId, payload) ? { id: replaceId } : null;
        return { id: this.teams.post(conversationId, payload, "bot").id };
    }

    private sign(serviceUrl: string) {
        const now = Math.floor(Date.now() / 1000);
        const head = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: this.jwk.kid }));
        const body = b64url(JSON.stringify({ iss: ISSUER, aud: this.appId, serviceUrl, nbf: now - 5, exp: now + 3600 }));
        return `${head}.${body}.${b64url(rsaSign("RSA-SHA256", Buffer.from(`${head}.${body}`), this.privateKey))}`;
    }

    /** Deliver an activity to Foreman's messaging endpoint, signed, as Teams would. */
    async send(activity: Activity): Promise<{ status: number; body: any }> {
        const res = await fetch(`${this.serverUrl}/hooks/teams/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.sign(activity.serviceUrl ?? "")}` },
            body: JSON.stringify(activity),
            signal: AbortSignal.timeout(10_000),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    }

    /** Add the bot to a mock team channel, which is how a real bot learns where it may post. */
    install(team: string, channel: string) {
        const conversationId = `19:mock-${team}-${channel}`.toLowerCase().replace(/[^a-z0-9:-]+/g, "-") + "@thread.tacv2";
        return this.send({ type: "conversationUpdate", channelId: "msteams", serviceUrl: this.serviceUrl(), conversation: { id: conversationId, conversationType: "channel" }, channelData: { team: { name: team }, channel: { name: channel } }, membersAdded: [{ id: `28:${this.appId}` }], from: { id: "29:mock-admin", name: "Mock Admin" } }).then((r) => ({ ...r, conversationId }));
    }

    /** Press a button on a card in the preview, as the named person. */
    async press(messageId: string, verb: string, inputs: Record<string, string>, user: { name: string; aadObjectId: string }) {
        const message = this.teams.get(messageId);
        if (!message) throw new Error(`Message ${messageId} not found in the Teams preview`);
        const card = (message.payload as any).attachments?.[0]?.content;
        const action = (card?.actions ?? []).find((a: any) => a.type === "Action.Execute" && a.verb === verb);
        if (!action) throw new Error(`The card has no "${verb}" button (it may have been decided already)`);
        const result = await this.send({
            type: "invoke",
            name: "adaptiveCard/action",
            channelId: "msteams",
            serviceUrl: this.serviceUrl(),
            replyToId: messageId,
            conversation: { id: message.channel, conversationType: "channel" },
            from: { id: `29:${user.aadObjectId}`, name: user.name, aadObjectId: user.aadObjectId },
            value: { action: { type: "Action.Execute", verb, data: { ...action.data, ...inputs } } },
        });
        // Teams swaps the card in place when the bot answers with one.
        if (result.status === 200 && result.body?.type === CARD) this.teams.update(messageId, { type: "message", attachments: [{ contentType: CARD, content: result.body.value }] });
        return result;
    }
}
