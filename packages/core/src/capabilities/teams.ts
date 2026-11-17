import { z } from "zod";
import { CapabilityError, defineCapability } from "../registry.ts";
import { TeamsBotSettings } from "../teamsbot.ts";

const failed = (e: unknown, code: "invalid_input" | "conflict" | "failed" = "invalid_input") => new CapabilityError(e instanceof Error ? e.message : String(e), code);

export const teamsCapabilities = [
    defineCapability({
        name: "teamsbot.status",
        title: "Teams bot",
        description:
            "The Teams bot that lets people Approve, Deny or answer an agent's question inside a Teams card. Shows its settings, the messaging endpoint to enter in the Azure Bot resource, and the Teams conversations the bot has been added to (a notification channel of kind \"teams_bot\" sends to one of these).",
        readOnly: true,
        input: z.object({}),
        handler: (ctx) => ({ ...ctx.bot.settings(), messagingEndpoint: ctx.bot.messagingEndpoint(), conversations: ctx.bot.listConversations().map(({ serviceUrl: _hidden, ...c }) => c) }),
    }),
    defineCapability({
        name: "teamsbot.configure",
        title: "Configure the Teams bot",
        description:
            "Set up the Teams bot: appId (the Azure Bot's Microsoft App ID), tenantId (for a single-tenant bot), secretName (a stored secret holding the app's client secret), approvers (Entra object ids allowed to decide from Teams; empty lets anyone who sees the card decide), enabled. mock: true uses the built-in mock Bot Framework and needs none of the Microsoft settings.",
        input: TeamsBotSettings.partial(),
        handler: (ctx, _input, raw) => {
            try {
                return ctx.bot.configure(Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k in TeamsBotSettings.shape)));
            } catch (e) {
                throw failed(e);
            }
        },
    }),
    defineCapability({
        name: "mockteams.install",
        title: "Add the bot to a mock channel",
        description: "Mock only: add the Teams bot to a channel of the built-in Teams preview, the way a person adds a real bot to a team. Afterwards the channel can be chosen for a \"teams_bot\" notification channel. The bot must be on with mock: true.",
        input: z.object({ team: z.string().min(1).max(60).default("Foreman demo"), channel: z.string().min(1).max(60).default("Approvals") }),
        handler: async (ctx, { team, channel }) => {
            const s = ctx.bot.settings();
            if (!s.enabled || !s.mock) throw new CapabilityError("Turn the Teams bot on in mock mode first (teamsbot.configure with enabled and mock)", "conflict");
            const res = await ctx.mockBot.install(team, channel);
            if (res.status !== 200) throw new CapabilityError(`The bot refused the mock install (${res.status}): ${res.body?.error ?? ""}`, "failed");
            return ctx.bot.getConversation(res.conversationId);
        },
    }),
    defineCapability({
        name: "mockteams.press",
        title: "Press a button in mock Teams",
        description:
            "Mock only: press Approve, Deny or Send answer on a bot card in the Teams preview, as a named Teams user. The press travels to Foreman's bot endpoint signed like a real Teams request, so the decision is recorded as that Teams user. verb is approve, deny or answer (answer needs the text).",
        input: z.object({ messageId: z.string(), verb: z.enum(["approve", "deny", "answer"]), answer: z.string().max(4000).optional(), userName: z.string().min(1).max(80).default("Mock Approver"), aadObjectId: z.string().default("6f1c1a51-0000-4000-8000-00000000a001") }),
        handler: async (ctx, { messageId, verb, answer, userName, aadObjectId }) => {
            let res;
            try {
                res = await ctx.mockBot.press(messageId, verb, answer !== undefined ? { answer } : {}, { name: userName, aadObjectId });
            } catch (e) {
                throw failed(e, "conflict");
            }
            if (res.status !== 200) throw new CapabilityError(`The bot refused the press (${res.status}): ${res.body?.error ?? ""}`, "failed");
            // Either the card was replaced, or Teams shows the bot's one-line reply.
            return res.body?.type === "application/vnd.microsoft.activity.message" ? { updated: false, message: res.body.value } : { updated: true };
        },
    }),
];
