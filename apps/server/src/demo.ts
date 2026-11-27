import { loadSamples, type createForeman } from "@foreman/core";

type Foreman = ReturnType<typeof createForeman>;

/**
 * Demo mode: the sample agents and routing rules, and the mock Jira filing tickets on its own — so
 * the work board is alive without Copilot, Jira or Teams. Stories are deliberately left unrouted
 * so the inbox has something in it.
 */
export function startDemo(foreman: Foreman): () => void {
    loadSamples(foreman, "system:demo");
    // The demo is for looking around; the getting-started checklist is for a real install.
    foreman.store.setSetting("setup.hidden", true);
    // Approvals and questions go to the bot instead, whose cards can be answered in place.
    foreman.bot.configure({ enabled: true, mock: true });
    foreman.notify.configure({ agingMinutes: 2 });
    foreman.work.updateSettings({ enabled: true, pollSeconds: 30, wipPerAgent: 2, writeBack: { enabled: true, statusStarted: "In Progress", statusReview: "In Review", statusDone: "Done" } });
    foreman.mockJira.setGenerator(5);
    // New mock tickets announce themselves by webhook, so they appear at once rather than on the next poll.
    foreman.mockJira.webhookUrl = foreman.work.webhookUrl();
    void foreman.work.poll().catch(() => {});
    // One batch to watch: the documentation tickets, tracked as a single job. It is created a
    // moment after start because the mock Jira is served by this same process.
    const batch = setTimeout(() => void foreman.batches.create({ name: "Docs catch-up", jql: "project = DOC" }).catch(() => {}), 2500);
    // The mock adds the bot to a team over HTTP, as Teams would, so this also waits for the server.
    const install = setTimeout(async () => {
        const installed = await foreman.mockBot.install("Foreman demo", "Approvals").catch(() => null);
        if (installed?.status !== 200) return;
        const channel = foreman.notify.createChannel({ name: "Approvals (Teams bot)", kind: "teams_bot", webhookUrl: installed.conversationId });
        foreman.notify.createRule({ name: "Decide in Teams", events: ["approval_needed", "question_asked"], channelId: channel.id });
    }, 1500);
    return () => {
        clearTimeout(batch);
        clearTimeout(install);
        foreman.mockJira.setGenerator(0);
    };
}
