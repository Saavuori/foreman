import { useEffect, useMemo, useState } from "react";
import type { AgentSpec, PolicyRule } from "@foreman/core";
import { go, rpc, useRpc } from "../api.ts";
import { Trace } from "../Trace.tsx";
import { CopyButton, Empty, ErrorBanner, Field, Lamp, relTime, Segmented, useAction, useTick } from "../ui.tsx";
import { RunRows } from "./Home.tsx";

const AUTONOMY: { value: AgentSpec["policy"]["autonomy"]; label: string; text: string }[] = [
    { value: "observe", label: "Observe", text: "Reads only. Every write, command and outside call is refused." },
    { value: "propose", label: "Propose", text: "Reads freely. Anything that changes something waits for your approval." },
    { value: "act", label: "Act", text: "Reads and writes on its own. Shell commands still wait for approval." },
    { value: "full", label: "Full", text: "No approvals. Use only in a sandbox you can throw away." },
];
const COMMON_TOOLS = ["view", "grep", "glob", "edit", "create", "shell", "web_fetch"];
const MIN_CREDITS = 30;

export function NewAgent() {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [runtime, setRuntime] = useState<"copilot" | "simulated">("simulated");
    const { busy, run } = useAction();
    const create = async (e: React.FormEvent) => {
        e.preventDefault();
        const created = await run(() => rpc<any>("agents.create", { name, description, spec: { runtime } }), "Agent created");
        if (created) go(`/agents/${created.agent.id}`);
    };
    return (
        <div className="page" style={{ maxWidth: 640 }}>
            <header className="page-head">
                <div>
                    <div className="eyebrow" style={{ marginBottom: 8 }}>
                        <a href="#/agents">Agents</a> / new
                    </div>
                    <h1>New agent</h1>
                    <p>Name the job. You will write its instructions and choose tools and guardrails next.</p>
                </div>
            </header>
            <form className="card form-section" onSubmit={create}>
                <Field label="Name">
                    <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Issue triage" autoFocus required maxLength={80} />
                </Field>
                <Field label="What it is for" hint="One line, shown in lists.">
                    <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Labels new issues and asks for missing details" maxLength={500} />
                </Field>
                <div className="field">
                    <span className="label">Runs on</span>
                    <div className="choice-grid">
                        <button type="button" className="choice" aria-pressed={runtime === "simulated"} onClick={() => setRuntime("simulated")}>
                            <b>Simulator</b>
                            <span>No model, no cost. Exercises tools, guardrails and triggers with synthetic output.</span>
                        </button>
                        <button type="button" className="choice" aria-pressed={runtime === "copilot"} onClick={() => setRuntime("copilot")}>
                            <b>Copilot</b>
                            <span>The GitHub Copilot agent runtime. Needs a Copilot-entitled sign-in.</span>
                        </button>
                    </div>
                </div>
                <div className="row">
                    <button className="btn primary" disabled={busy || !name.trim()}>
                        Create agent
                    </button>
                    <a className="btn ghost" href="#/agents">
                        Cancel
                    </a>
                </div>
            </form>
        </div>
    );
}

/** A textarea bound to a JSON value: edits apply only while the text parses. */
function JsonField({ label, hint, value, onChange, rows = 5, emptyAs }: { label: string; hint?: string; value: unknown; onChange: (v: any) => void; rows?: number; emptyAs: unknown }) {
    const canonical = value === undefined ? "" : JSON.stringify(value, null, 2);
    const [text, setText] = useState(canonical);
    const [invalid, setInvalid] = useState(false);
    useEffect(() => {
        setText(canonical);
        setInvalid(false);
    }, [canonical]);
    return (
        <Field label={label} hint={invalid ? <span style={{ color: "var(--stop)" }}>Not valid JSON yet — your last valid version is kept.</span> : hint}>
            <textarea
                className="input code"
                rows={rows}
                spellCheck={false}
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    if (!e.target.value.trim()) return (setInvalid(false), onChange(emptyAs));
                    try {
                        onChange(JSON.parse(e.target.value));
                        setInvalid(false);
                    } catch {
                        setInvalid(true);
                    }
                }}
            />
        </Field>
    );
}

export function AgentStudio({ agentId }: { agentId: string }) {
    useTick();
    const scenarios = useRpc<any[]>("system.mock_scenarios", {}, []);
    const detail = useRpc<any>("agents.get", { agentId }, ["agents", "triggers"]);
    const revisions = useRpc<any[]>("revisions.list", { agentId }, ["agents"]);
    const runs = useRpc<any[]>("runs.list", { agentId, limit: 8 }, ["run"]);
    const models = useRpc<any[]>("system.models", {}, []);
    const ownTools = useRpc<any[]>("system.agent_tools", {}, []);
    const secrets = useRpc<any>("secrets.list", {}, ["audit"]);
    const { busy, run: act } = useAction();

    const saved = detail.data?.revision;
    const [spec, setSpec] = useState<AgentSpec | null>(null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [note, setNote] = useState("");
    const [draft, setDraft] = useState<{ id: string; json: string } | null>(null);
    const [toolInput, setToolInput] = useState("");

    useEffect(() => {
        if (!saved) return;
        setSpec(saved.spec);
        setName(detail.data.agent.name);
        setDescription(detail.data.agent.description);
        setNote("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [saved?.id]);

    const specJson = useMemo(() => JSON.stringify(spec), [spec]);
    if (detail.error && !detail.data) return <div className="page"><ErrorBanner error={detail.error} /></div>;
    if (!spec || !saved) return <div className="page" />;
    const agent = detail.data.agent;
    const specDirty = specJson !== JSON.stringify(saved.spec);
    const dirty = specDirty || name !== agent.name || description !== agent.description;
    const set = (patch: Partial<AgentSpec>) => setSpec({ ...spec, ...patch });
    const setPolicy = (patch: Partial<AgentSpec["policy"]>) => set({ policy: { ...spec.policy, ...patch } });
    const setBudget = (patch: Partial<AgentSpec["budget"]>) => set({ budget: { ...spec.budget, ...patch } });
    const ownNames = new Set((ownTools.data ?? []).map((t) => t.name));
    const toggleTool = (tool: string) => set({ tools: spec.tools.includes(tool) ? spec.tools.filter((t) => t !== tool) : [...spec.tools, tool] });
    const setRule = (i: number, patch: Partial<PolicyRule>) => setPolicy({ rules: spec.policy.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
    const patchOf = (s: AgentSpec) => ({ ...s, outputSchema: s.outputSchema ?? null, reasoningEffort: s.reasoningEffort ?? null, provider: s.provider ?? null });
    const setProvider = (patch: Partial<NonNullable<AgentSpec["provider"]>>) => set({ provider: { type: "openai", baseUrl: "", secretName: "", ...spec.provider, ...patch } });
    const modelIds = (models.data ?? []).find((m) => m.runtime === spec.runtime)?.models ?? [];

    const save = () =>
        act(async () => {
            // A draft already saved by the test bench is promoted instead of duplicated.
            if (specDirty && draft?.json === specJson) await rpc("revisions.activate", { revisionId: draft.id });
            await rpc("agents.update", { agentId, name, description, spec: specDirty && draft?.json !== specJson ? patchOf(spec) : undefined, note });
            setDraft(null);
        }, specDirty ? "Saved as a new revision" : "Saved");
    const discard = () => (setSpec(saved.spec), setName(agent.name), setDescription(agent.description));
    /** The revision the test bench should run: the active one, or a draft holding unsaved edits. */
    const revisionForTest = async (): Promise<string> => {
        if (!specDirty) return saved.id;
        if (draft?.json === specJson) return draft.id;
        const result = await rpc<any>("agents.update", { agentId, spec: patchOf(spec), note: "Draft from test bench", activate: false });
        setDraft({ id: result.revision.id, json: specJson });
        return result.revision.id;
    };

    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <div className="eyebrow" style={{ marginBottom: 8 }}>
                        <a href="#/agents">Agents</a> / <span className="mono">{agent.id}</span>
                    </div>
                    <input className="input" style={{ font: "600 30px/1.1 var(--display)", letterSpacing: "0.02em", textTransform: "uppercase", border: 0, background: "transparent", padding: 0, minHeight: 0 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Agent name" />
                    <input className="input" style={{ border: 0, background: "transparent", padding: 0, minHeight: 0, color: "var(--ink-3)", marginTop: 4 }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add a one-line description" aria-label="Agent description" />
                </div>
                <span className="tag">active revision {saved.number}</span>
                {agent.archived ? <span className="tag hivis">archived</span> : null}
                <button className="btn ghost danger" disabled={busy} onClick={() => act(() => rpc("agents.archive", { agentId, archived: !agent.archived }), agent.archived ? "Restored" : "Archived")}>
                    {agent.archived ? "Restore" : "Archive"}
                </button>
            </header>

            <div className="studio">
                <div>
                    <div className="card">
                        <section className="form-section">
                            <h3>Instructions</h3>
                            <Field label="What this agent does and how" hint="Added to the runtime's system prompt. Say what done looks like and what it must never do.">
                                <textarea className="input" rows={8} value={spec.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="You triage new issues. For each one: read it, add one label from the list below, and ask for a reproduction if none is given…" />
                            </Field>
                        </section>

                        <section className="form-section">
                            <h3>Runtime</h3>
                            <div className="cols">
                                <div className="field">
                                    <span className="label">Runs on</span>
                                    <Segmented label="Runtime" value={spec.runtime} onChange={(runtime) => set({ runtime })} options={[{ value: "simulated", label: "Simulator" }, { value: "copilot", label: "Copilot" }]} />
                                    <span className="hint">{spec.runtime === "simulated" ? "Synthetic output, no model calls." : "GitHub Copilot agent runtime."}</span>
                                </div>
                                <Field label="Model" hint={spec.provider ? "The provider's own model id, e.g. gpt-4o." : modelIds.length ? "“auto” lets Copilot route." : "Type a model id, or “auto”."}>
                                    <input className="input code" list="models" value={spec.model} onChange={(e) => set({ model: e.target.value })} />
                                    <datalist id="models">
                                        <option value="auto" />
                                        {modelIds.map((m: any) => (
                                            <option key={m.id} value={m.id}>
                                                {m.label}
                                            </option>
                                        ))}
                                    </datalist>
                                </Field>
                                <Field label="Reasoning effort">
                                    <select className="input" value={spec.reasoningEffort ?? ""} onChange={(e) => set({ reasoningEffort: (e.target.value || undefined) as AgentSpec["reasoningEffort"] })}>
                                        <option value="">Model default</option>
                                        <option value="low">Low</option>
                                        <option value="medium">Medium</option>
                                        <option value="high">High</option>
                                    </select>
                                </Field>
                            </div>
                            {spec.runtime === "copilot" ? (
                                <div className="stack" style={{ marginTop: 14 }}>
                                    <label className="row" style={{ gap: 8 }}>
                                        <input type="checkbox" checked={!!spec.provider} onChange={(e) => set({ provider: e.target.checked ? { type: "openai", baseUrl: "", secretName: "" } : undefined, model: e.target.checked && spec.model === "auto" ? "" : spec.model })} />
                                        <span>Use my own model key instead of a Copilot subscription</span>
                                    </label>
                                    {spec.provider ? (
                                        <>
                                            <div className="field">
                                                <span className="label">Provider</span>
                                                <Segmented label="Provider" value={spec.provider.type} onChange={(type) => setProvider({ type })} options={[{ value: "openai", label: "OpenAI-compatible" }, { value: "azure", label: "Azure OpenAI" }, { value: "anthropic", label: "Anthropic" }]} />
                                            </div>
                                            <div className="cols" style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)" }}>
                                                <Field label="Endpoint" hint="The API's base address, e.g. https://api.openai.com/v1.">
                                                    <input className="input code" type="url" value={spec.provider.baseUrl} onChange={(e) => setProvider({ baseUrl: e.target.value })} placeholder="https://…" />
                                                </Field>
                                                <Field label="API key" hint={<>A stored secret; values are added under <a href="#/secrets">Secrets</a>. Leave empty for an endpoint without a key.</>}>
                                                    <select className="input" value={spec.provider.secretName} onChange={(e) => setProvider({ secretName: e.target.value })}>
                                                        <option value="">No key</option>
                                                        {(secrets.data?.secrets ?? []).map((s: any) => (
                                                            <option key={s.name} value={s.name}>
                                                                {s.name}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </Field>
                                            </div>
                                            <span className="hint">
                                                The Copilot runtime then talks to this provider directly. Agents' own MCP servers are not started in this mode (the runtime allows them only with a Copilot account); Foreman's tools still work. For a try-out without a key, use the built-in mock endpoint <code className="mono">{location.origin}/mock/model/v1</code>.
                                            </span>
                                        </>
                                    ) : null}
                                </div>
                            ) : null}
                        </section>

                        {spec.runtime === "simulated" ? (
                            <section className="form-section">
                                <h3>Mock behaviour</h3>
                                <div className="cols">
                                    <Field label="Scenario" hint={(scenarios.data ?? []).find((s) => s.name === spec.mock.scenario)?.description ?? "How the mock agent behaves on each run."}>
                                        <select className="input" value={spec.mock.scenario} onChange={(e) => set({ mock: { ...spec.mock, scenario: e.target.value } })}>
                                            {(scenarios.data ?? [{ name: spec.mock.scenario, title: spec.mock.scenario }]).map((s) => (
                                                <option key={s.name} value={s.name}>
                                                    {s.title}
                                                </option>
                                            ))}
                                        </select>
                                    </Field>
                                    <div className="field">
                                        <span className="label">Speed</span>
                                        <Segmented label="Mock speed" value={String(spec.mock.speed)} onChange={(v) => set({ mock: { ...spec.mock, speed: Number(v) } })} options={[{ value: "0.5", label: "Slow" }, { value: "1", label: "Normal" }, { value: "4", label: "Fast" }, { value: "20", label: "Instant" }]} />
                                        <span className="hint">
                                            Put <span className="mono">[mock:name]</span> in a prompt to choose a scenario for one run.
                                        </span>
                                    </div>
                                </div>
                            </section>
                        ) : null}

                        <section className="form-section">
                            <h3>Tools</h3>
                            <div className="field">
                                <span className="label">Built-in tools</span>
                                <div className="row wrap" style={{ gap: 6 }}>
                                    {[...new Set([...COMMON_TOOLS, ...spec.tools])].filter((tool) => !ownNames.has(tool)).map((tool) => (
                                        <button key={tool} type="button" className="chip" aria-pressed={spec.tools.includes(tool)} onClick={() => toggleTool(tool)}>
                                            {tool}
                                        </button>
                                    ))}
                                    <form
                                        className="row"
                                        style={{ gap: 6 }}
                                        onSubmit={(e) => {
                                            e.preventDefault();
                                            const tool = toolInput.trim();
                                            if (tool && !spec.tools.includes(tool)) set({ tools: [...spec.tools, tool] });
                                            setToolInput("");
                                        }}
                                    >
                                        <input className="input code" style={{ width: 150, minHeight: 26, padding: "2px 8px" }} value={toolInput} onChange={(e) => setToolInput(e.target.value)} placeholder="add by name" aria-label="Add a tool by name" />
                                    </form>
                                </div>
                                <span className="hint">The agent starts with nothing and gets only what is switched on here. Names must match the runtime's own tool names. Scripted mock scenarios use their own fixed tools; guardrails still apply to them.</span>
                            </div>
                            <div className="field">
                                <span className="label">Foreman tools</span>
                                <div className="row wrap" style={{ gap: 6 }}>
                                    {(ownTools.data ?? []).map((t) => (
                                        <button key={t.name} type="button" className="chip" aria-pressed={t.alwaysOn || spec.tools.includes(t.name)} disabled={t.alwaysOn} title={`${t.description}${t.alwaysOn ? " Always available." : t.guarded ? " Changes a ticket, so the guardrails apply." : ""}`} onClick={() => toggleTool(t.name)}>
                                            {t.name}
                                        </button>
                                    ))}
                                </div>
                                <span className="hint">
                                    Work on any runtime. Every agent can report progress and ask a person a question. The Jira tools act on the site set under Work → Routing &amp; intake; add a guardrail such as <code className="mono">jira_transition → ask</code> to keep a person in the loop.
                                </span>
                            </div>
                            <JsonField label="MCP servers" rows={4} emptyAs={{}} value={Object.keys(spec.mcpServers).length ? spec.mcpServers : undefined} onChange={(mcpServers) => set({ mcpServers })} hint='Keyed by name, e.g. {"github": {"type": "http", "url": "https://…"}} or {"files": {"type": "stdio", "command": "npx", "args": ["…"]}}. Put {{secret:NAME}} where a key goes; the value comes from Secrets when the run starts.' />
                            <JsonField label="Sub-agents" rows={3} emptyAs={[]} value={spec.subAgents.length ? spec.subAgents : undefined} onChange={(subAgents) => set({ subAgents })} hint='Specialists this agent can delegate to, e.g. [{"name": "researcher", "description": "…", "prompt": "…", "tools": ["view"]}]' />
                        </section>

                        <section className="form-section">
                            <h3>Guardrails</h3>
                            <div className="field">
                                <span className="label">Autonomy</span>
                                <div className="choice-grid">
                                    {AUTONOMY.map((a) => (
                                        <button key={a.value} type="button" className="choice" aria-pressed={spec.policy.autonomy === a.value} onClick={() => setPolicy({ autonomy: a.value })}>
                                            <b>{a.label}</b>
                                            <span>{a.text}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="field">
                                <span className="label">Exceptions</span>
                                {spec.policy.rules.map((rule, i) => (
                                    <div key={i} className="row">
                                        <input className="input code grow" value={rule.match} onChange={(e) => setRule(i, { match: e.target.value })} placeholder="shell, write, mcp:github-*, …" aria-label="Rule pattern" />
                                        <select className="input" style={{ width: 110 }} value={rule.action} onChange={(e) => setRule(i, { action: e.target.value as PolicyRule["action"] })} aria-label="Rule action">
                                            <option value="allow">Allow</option>
                                            <option value="ask">Ask me</option>
                                            <option value="deny">Deny</option>
                                        </select>
                                        <button type="button" className="btn ghost sm" onClick={() => setPolicy({ rules: spec.policy.rules.filter((_, j) => j !== i) })} aria-label="Remove rule">
                                            Remove
                                        </button>
                                    </div>
                                ))}
                                <div>
                                    <button type="button" className="btn sm" onClick={() => setPolicy({ rules: [...spec.policy.rules, { match: "", action: "ask" }] })}>
                                        Add exception
                                    </button>
                                </div>
                                <span className="hint">
                                    Checked top to bottom before the autonomy level. Patterns match an action kind (<span className="mono">read write shell mcp url</span>) or <span className="mono">kind:tool</span>; <span className="mono">*</span> is a wildcard.
                                </span>
                            </div>
                        </section>

                        <section className="form-section">
                            <h3>Limits and result</h3>
                            <div className="cols">
                                <Field label="Credit budget per run" hint={`Soft cap in AI Credits. The runtime's minimum is ${MIN_CREDITS}.`}>
                                    <input className="input code" type="number" min={MIN_CREDITS} value={spec.budget.maxAiCredits} onChange={(e) => setBudget({ maxAiCredits: Number(e.target.value) })} />
                                </Field>
                                <Field label="Time limit (seconds)" hint="The run is stopped and marked failed after this.">
                                    <input className="input code" type="number" min={10} value={spec.budget.timeoutSeconds} onChange={(e) => setBudget({ timeoutSeconds: Number(e.target.value) })} />
                                </Field>
                                <Field label="Approval wait (seconds)" hint="An unanswered approval is treated as a no.">
                                    <input className="input code" type="number" min={10} value={spec.policy.approvalTimeoutSeconds} onChange={(e) => setPolicy({ approvalTimeoutSeconds: Number(e.target.value) })} />
                                </Field>
                            </div>
                            <JsonField label="Result shape" rows={4} emptyAs={undefined} value={spec.outputSchema} onChange={(outputSchema) => set({ outputSchema })} hint="Optional JSON Schema. When set, the final answer is JSON that matches it — useful when another system reads the result." />
                        </section>
                    </div>

                    {dirty ? (
                        <div className="savebar">
                            <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{specDirty ? `Unsaved changes → revision ${(revisions.data?.[0]?.number ?? saved.number) + (draft?.json === specJson ? 0 : 1)}` : "Unsaved changes"}</span>
                            <input className="input grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? (optional)" aria-label="Revision note" />
                            <button className="btn ghost" onClick={discard}>
                                Discard
                            </button>
                            <button className="btn hivis" disabled={busy} onClick={save}>
                                Save changes
                            </button>
                        </div>
                    ) : null}

                    <h2 className="section-title">Latest runs</h2>
                    <div className="card">{runs.data?.length ? <RunRows runs={runs.data} showAgent={false} /> : <Empty title="No runs yet">Use the test bench, or attach a trigger.</Empty>}</div>
                </div>

                <aside>
                    <TestBench agentId={agentId} dirty={specDirty} revisionForTest={revisionForTest} archived={agent.archived} />
                    <Triggers agentId={agentId} triggers={detail.data.triggers} />
                    <Revisions revisions={revisions.data ?? []} activeId={saved.id} />
                </aside>
            </div>
        </div>
    );
}

function TestBench({ agentId, dirty, revisionForTest, archived }: { agentId: string; dirty: boolean; revisionForTest: () => Promise<string>; archived: boolean }) {
    const [prompt, setPrompt] = useState("");
    const [runId, setRunId] = useState<string | null>(null);
    const { busy, run: act } = useAction();
    const timeline = useRpc<any>(runId ? "runs.timeline" : null, { runId }, runId ? [`run:${runId}`] : []);
    const start = async (e: React.FormEvent) => {
        e.preventDefault();
        const started = await act(async () => rpc<any>("runs.start", { agentId, prompt, revisionId: await revisionForTest() }));
        if (started) setRunId(started.id);
    };
    const status = timeline.data?.run.status;
    return (
        <div className="card">
            <div className="card-head">
                <h3>Test bench</h3>
                <span className="grow" />
                {status ? <Lamp status={status} /> : null}
            </div>
            <form className="card-body stack" onSubmit={start}>
                <textarea className="input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Give the agent a task, as a trigger would…" aria-label="Test prompt" />
                <div className="row">
                    <button className="btn primary" disabled={busy || !prompt.trim() || archived}>
                        {dirty ? "Run with unsaved changes" : "Run"}
                    </button>
                    {runId ? (
                        <a className="btn ghost sm" href={`#/runs/${runId}`}>
                            Open full trace
                        </a>
                    ) : null}
                </div>
                {dirty ? <span className="hint">Unsaved changes run as a draft revision. Triggers keep using the active one until you save.</span> : null}
                {runId && timeline.data ? (
                    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10, maxHeight: 420, overflow: "auto" }}>
                        <Trace steps={timeline.data.steps} compact />
                    </div>
                ) : null}
            </form>
        </div>
    );
}

function Triggers({ agentId, triggers }: { agentId: string; triggers: any[] }) {
    const list = useRpc<any[]>("triggers.list", { agentId }, ["triggers"]);
    const [adding, setAdding] = useState(false);
    const [kind, setKind] = useState<"schedule" | "webhook">("schedule");
    const [name, setName] = useState("");
    const [cron, setCron] = useState("0 8 * * 1-5");
    const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    const [concurrencyKey, setConcurrencyKey] = useState("");
    const [template, setTemplate] = useState("");
    const { busy, run: act } = useAction();
    const rows = list.data ?? triggers;

    const create = async (e: React.FormEvent) => {
        e.preventDefault();
        const config = kind === "schedule" ? { kind, cron, timezone } : { kind, concurrencyKey: concurrencyKey.trim() || undefined };
        const created = await act(() => rpc("triggers.create", { agentId, name, config, promptTemplate: template }), "Trigger added");
        if (created) (setAdding(false), setName(""), setTemplate(""));
    };
    return (
        <div className="card">
            <div className="card-head">
                <h3>Triggers</h3>
                <span className="grow" />
                <button className="btn sm" onClick={() => setAdding(!adding)}>
                    {adding ? "Cancel" : "Add trigger"}
                </button>
            </div>
            {adding ? (
                <form className="card-body stack" onSubmit={create} style={{ borderBottom: "1px solid var(--line)" }}>
                    <Segmented label="Trigger kind" value={kind} onChange={setKind} options={[{ value: "schedule", label: "On a schedule" }, { value: "webhook", label: "On a webhook" }]} />
                    <Field label="Name">
                        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "schedule" ? "Weekday morning" : "GitHub issues"} required />
                    </Field>
                    {kind === "schedule" ? (
                        <div className="cols" style={{ gridTemplateColumns: "1fr 1fr" }}>
                            <Field label="Cron" hint="minute hour day month weekday">
                                <input className="input code" value={cron} onChange={(e) => setCron(e.target.value)} required />
                            </Field>
                            <Field label="Time zone">
                                <input className="input code" value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
                            </Field>
                        </div>
                    ) : (
                        <Field label="One run at a time per" hint="Optional path into the payload, e.g. issue.number. A second event for the same value is refused while a run is active.">
                            <input className="input code" value={concurrencyKey} onChange={(e) => setConcurrencyKey(e.target.value)} placeholder="issue.number" />
                        </Field>
                    )}
                    <Field label="Prompt" hint={kind === "webhook" ? "Use {{payload}} for the whole body or {{payload.some.path}} for one value. Payload text is marked as untrusted data for the agent." : "Sent to the agent each time the schedule fires."}>
                        <textarea className="input" rows={3} value={template} onChange={(e) => setTemplate(e.target.value)} placeholder={kind === "webhook" ? "Triage this issue: {{payload.issue.title}}\n\n{{payload}}" : "Write the daily status summary."} required />
                    </Field>
                    <div>
                        <button className="btn primary" disabled={busy}>
                            Add trigger
                        </button>
                    </div>
                </form>
            ) : null}
            <div className="list">
                {rows.length ? (
                    rows.map((t) => (
                        <div key={t.id} className="list-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 8 }}>
                            <div className="row" style={{ width: "100%" }}>
                                <Lamp status={t.enabled ? "ok" : "idle"} bare />
                                <span className="grow truncate" style={{ fontWeight: 600 }}>
                                    {t.name}
                                </span>
                                <span className="tag">{t.config.kind === "schedule" ? t.config.cron : "webhook"}</span>
                            </div>
                            <div className="muted" style={{ fontSize: 12.5 }}>
                                {t.config.kind === "schedule" ? (t.enabled ? `Next ${relTime(t.nextRunAt)} · ${t.config.timezone}` : "Paused") : t.enabled ? "Listening" : "Paused"}
                                {t.lastFiredAt ? ` · last fired ${relTime(t.lastFiredAt)}` : " · never fired"}
                            </div>
                            <div className="row wrap" style={{ gap: 6 }}>
                                <button className="btn sm" disabled={busy} onClick={() => act(() => rpc("triggers.fire", { triggerId: t.id }), "Fired with a test payload")}>
                                    Fire now
                                </button>
                                <button className="btn sm" disabled={busy} onClick={() => act(() => rpc("triggers.update", { triggerId: t.id, enabled: !t.enabled }))}>
                                    {t.enabled ? "Pause" : "Resume"}
                                </button>
                                {t.webhookUrl ? <CopyButton text={t.webhookUrl} label="Copy URL" /> : null}
                                <button className="btn sm ghost danger" disabled={busy} onClick={() => confirm(`Delete trigger “${t.name}”?`) && act(() => rpc("triggers.delete", { triggerId: t.id }), "Trigger deleted")}>
                                    Delete
                                </button>
                            </div>
                        </div>
                    ))
                ) : adding ? null : (
                    <div className="card-body muted">No triggers. This agent only runs when someone starts it.</div>
                )}
            </div>
        </div>
    );
}

function Revisions({ revisions, activeId }: { revisions: any[]; activeId: string }) {
    const { busy, run: act } = useAction();
    const [diff, setDiff] = useState<{ id: string; changes: any[] } | null>(null);
    const compare = async (id: string) => {
        if (diff?.id === id) return setDiff(null);
        const result = await act(() => rpc<any>("revisions.diff", { fromRevisionId: activeId, toRevisionId: id }));
        if (result) setDiff({ id, changes: result.changes });
    };
    return (
        <div className="card">
            <div className="card-head">
                <h3>Revisions</h3>
            </div>
            <div className="list" style={{ maxHeight: 340, overflow: "auto" }}>
                {revisions.map((r) => (
                    <div key={r.id} className="list-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                        <div className="row">
                            <span className="mono" style={{ fontWeight: 600 }}>
                                r{r.number}
                            </span>
                            <span className="grow truncate">{r.note || <span className="muted">No note</span>}</span>
                            {r.active ? (
                                <span className="tag hivis">active</span>
                            ) : (
                                <>
                                    <button className="btn sm ghost" disabled={busy} onClick={() => compare(r.id)}>
                                        {diff?.id === r.id ? "Hide" : "Compare"}
                                    </button>
                                    <button className="btn sm" disabled={busy} onClick={() => act(() => rpc("revisions.activate", { revisionId: r.id }), `Revision ${r.number} is now active`)}>
                                        Make active
                                    </button>
                                </>
                            )}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                            {r.createdBy} · {relTime(r.createdAt)}
                        </div>
                        {diff && diff.id === r.id ? (
                            <pre className="pre">{diff.changes.length ? diff.changes.map((c) => `${c.path}\n  active: ${JSON.stringify(c.before)}\n  r${r.number}: ${JSON.stringify(c.after)}`).join("\n") : "Identical to the active revision."}</pre>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
}
