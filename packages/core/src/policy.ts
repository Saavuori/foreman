import type { AgentSpec, Autonomy, PolicyAction } from "./schemas.ts";

/** What an agent is asking to do, normalised from the runtime's permission request. */
export interface PermissionSubject {
    /** Runtime permission kind: `shell`, `write`, `read`, `mcp`, `url`, `memory`, `custom-tool`, `destructive`, … */
    kind: string;
    toolName?: string;
    /**
     * Facts about what the action is aimed at, looked up by Foreman before asking — for a Power
     * Platform environment its type (`sandbox`, `production` …), `group:<name>` and `env:<name>`.
     * Rules match them as `tool@fact` or `kind@fact`.
     */
    targets?: string[];
}

const READ_KINDS = new Set(["read"]);
const WRITE_KINDS = new Set(["write", "shell", "mcp", "url", "memory", "custom-tool"]);

/** Default decision for each autonomy preset when no explicit rule matches. */
export function presetAction(autonomy: Autonomy, subject: PermissionSubject): PolicyAction {
    // Deleting, resetting or overwriting something is never a preset's call: a person writes a rule for it.
    if (subject.kind === "destructive") return autonomy === "full" ? "allow" : "deny";
    switch (autonomy) {
        case "observe":
            return READ_KINDS.has(subject.kind) ? "allow" : "deny";
        case "propose":
            return READ_KINDS.has(subject.kind) ? "allow" : "ask";
        case "act":
            // Shell stays behind a human: it is the one kind whose blast radius is unbounded.
            if (subject.kind === "shell") return "ask";
            return READ_KINDS.has(subject.kind) || WRITE_KINDS.has(subject.kind) ? "allow" : "ask";
        case "full":
            return "allow";
    }
}

export function globToRegExp(glob: string): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
}

export interface PolicyDecision {
    action: PolicyAction;
    /** Which rule decided, for the trace. */
    reason: string;
}

/** Every string a rule's pattern is tested against, most specific last. */
export function policyCandidates(subject: PermissionSubject): string[] {
    const plain = [subject.kind];
    if (subject.toolName) plain.push(`${subject.kind}:${subject.toolName}`, subject.toolName);
    const targeted = (subject.targets ?? []).flatMap((t) => plain.map((c) => `${c}@${t}`));
    return [...plain, ...targeted];
}

export function evaluatePolicy(policy: AgentSpec["policy"], subject: PermissionSubject): PolicyDecision {
    const candidates = policyCandidates(subject);
    for (const rule of policy.rules) {
        const re = globToRegExp(rule.match);
        // A pattern with "@" is about a target, so it is tested only against targeted candidates;
        // otherwise "*@production" would never match and "*" would swallow the target forms.
        const pool = rule.match.includes("@") ? candidates.filter((c) => c.includes("@")) : candidates.filter((c) => !c.includes("@"));
        if (pool.some((c) => re.test(c))) {
            return { action: rule.action, reason: `rule "${rule.match}" → ${rule.action}` };
        }
    }
    const action = presetAction(policy.autonomy, subject);
    return { action, reason: `autonomy preset "${policy.autonomy}" → ${action}` };
}
