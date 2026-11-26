import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentCapabilities } from "./capabilities/agents.ts";
import { opsCapabilities } from "./capabilities/ops.ts";
import { runCapabilities } from "./capabilities/runs.ts";
import { workCapabilities } from "./capabilities/work.ts";
import { notifyCapabilities } from "./capabilities/notify.ts";
import { vaultCapabilities } from "./capabilities/vault.ts";
import { flowCapabilities } from "./capabilities/flow.ts";
import { BatchHub } from "./batches.ts";
import { Vault } from "./vault.ts";
import { NotifyHub } from "./notify.ts";
import { MockBotFramework, TeamsBot } from "./teamsbot.ts";
import { teamsCapabilities } from "./capabilities/teams.ts";
import { knowledgeCapabilities } from "./capabilities/knowledge.ts";
import { KnowledgeHub } from "./knowledge.ts";
import { ConfluenceSync, MockConfluence } from "./confluence.ts";
import { MockJira } from "./jira.ts";
import { WorkHub } from "./work.ts";
import { Engine } from "./engine.ts";
import { Bus, Registry, type Services } from "./registry.ts";
import { SimulatedRuntime } from "./mock.ts";
import type { RuntimeAdapter } from "./runtime.ts";
import { Store } from "./store.ts";
import { TriggerHub } from "./triggers.ts";

export * from "./schemas.ts";
export * from "./policy.ts";
export * from "./registry.ts";
export * from "./runtime.ts";
export * from "./mock.ts";
export * from "./timeline.ts";
export { renderPrompt, TriggerHub } from "./triggers.ts";
export { Engine } from "./engine.ts";
export { JiraClient, MockJira, MOCK_STATUSES, plainText, toDocument, toTicket } from "./jira.ts";
export { Vault } from "./vault.ts";
export { BatchHub, type Batch, type BatchProgress } from "./batches.ts";
export { flowMetrics, runTimeline } from "./flow.ts";
export * from "./tools.ts";
export { WorkHub, defaultRank, ruleMatches } from "./work.ts";
export * from "./notify.ts";
export { TeamsBot, MockBotFramework, TeamsBotSettings, decidedCard, type Activity, type BotConversation } from "./teamsbot.ts";
export { Store } from "./store.ts";
export { KnowledgeHub, KnowledgeSettings, EmbeddingSettings, type KnowledgeNode, type SearchHit, type SearchResult } from "./knowledge.ts";
export { ConfluenceClient, ConfluenceSync, ConfluenceSettings, MockConfluence, parsePageRef, type ConfluenceRoot, type SyncReport } from "./confluence.ts";
export { htmlToText, toPassages, builtinEmbed, ftsQuery } from "./extract.ts";

export interface ForemanOptions {
    dataDir: string;
    baseUrl: string;
    /** Extra runtimes besides the built-in simulator, e.g. the Copilot adapter. */
    runtimes?: RuntimeAdapter[];
    concurrency?: number;
    /** Use an in-memory database (tests). */
    memory?: boolean;
    simulatedStepDelayMs?: number;
    /** Delays between notification delivery retries (tests shorten them). */
    notifyRetryDelaysMs?: number[];
    /** How long Confluence webhook calls are gathered before checking (tests shorten it). */
    confluenceWebhookDelayMs?: number;
    /** Passphrase for the secrets vault. Without it a key file is kept in the data directory. */
    secretKey?: string;
}

/** Wire the store, engine, trigger hub and capability registry together. */
export function createForeman(options: ForemanOptions): Services & { start(): void; stop(): Promise<void> } {
    if (!options.memory) mkdirSync(options.dataDir, { recursive: true });
    const store = new Store(options.memory ? ":memory:" : join(options.dataDir, "foreman.db"));
    const bus = new Bus();
    const runtimes: Record<string, RuntimeAdapter> = { simulated: new SimulatedRuntime(options.simulatedStepDelayMs) };
    for (const runtime of options.runtimes ?? []) runtimes[runtime.name] = runtime;
    const vault = new Vault(store, { dataDir: options.dataDir, secretKey: options.secretKey, memory: options.memory });
    const engine = new Engine(store, bus, runtimes, { concurrency: options.concurrency ?? 4, scrub: (data) => vault.scrubData(data), resolveSecrets: (text) => vault.resolve(text) });
    const triggers = new TriggerHub(store, engine, bus);
    const mockJira = new MockJira();
    const work = new WorkHub(store, engine, bus, { mockJiraUrl: `${options.baseUrl}/mock/jira`, baseUrl: options.baseUrl, vault });
    const knowledge = new KnowledgeHub(store, bus, { vault });
    const mockConfluence = new MockConfluence();
    const confluence = new ConfluenceSync(store, bus, knowledge, { vault, mockUrl: `${options.baseUrl}/mock/confluence`, baseUrl: options.baseUrl, webhookDelayMs: options.confluenceWebhookDelayMs });
    engine.setToolHost({ jira: () => work.jira(), knowledge: () => knowledge });
    const notify = new NotifyHub(store, bus, { baseUrl: options.baseUrl, retryDelaysMs: options.notifyRetryDelaysMs, vault });
    const mockBot = new MockBotFramework(options.baseUrl, notify.mockTeams);
    const bot = new TeamsBot(store, bus, { baseUrl: options.baseUrl, vault, mock: mockBot });
    notify.setBot(bot);
    const batches = new BatchHub(store, bus, work, notify, { baseUrl: options.baseUrl });
    const registry = new Registry();
    registry.register(...agentCapabilities, ...runCapabilities, ...workCapabilities, ...notifyCapabilities, ...teamsCapabilities, ...knowledgeCapabilities, ...vaultCapabilities, ...flowCapabilities, ...opsCapabilities);
    const services: Services = { store, bus, engine, triggers, work, mockJira, notify, vault, batches, bot, mockBot, knowledge, confluence, mockConfluence, runtimes, registry, info: { version: "0.1.0", dataDir: options.memory ? "memory (nothing is saved)" : options.dataDir, baseUrl: options.baseUrl, startedAt: new Date().toISOString() } };
    registry.bind(services);
    // A press in Teams is decided by the same capability as a click in Foreman, audited as the Teams user.
    bot.setDecider((approvalId, approve, reason, actor) => registry.invoke("approvals.decide", { approvalId, decision: approve ? "approve" : "deny", reason }, actor));
    return {
        ...services,
        start() {
            engine.recover();
            triggers.start();
            notify.start();
            bot.start();
            knowledge.start();
            confluence.start();
            batches.start();
            work.start();
        },
        async stop() {
            triggers.stop();
            work.stop();
            batches.stop();
            bot.stop();
            confluence.stop();
            await confluence.settled();
            knowledge.stop();
            await knowledge.settled();
            notify.stop();
            await notify.settled();
            await work.settled();
            mockJira.setGenerator(0);
            await Promise.all(Object.values(runtimes).map((r) => r.dispose?.()));
            store.close();
        },
    };
}
