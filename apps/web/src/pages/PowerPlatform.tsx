import { useEffect, useState } from "react";
import { rpc, useRpc } from "../api.ts";
import { Empty, ErrorBanner, Field, relTime, useAction, useTick } from "../ui.tsx";

type Identity = { clientId: string; secret: string };
interface ConnForm {
    apiUrl: string;
    loginUrl: string;
    tenantId: string;
    reader: Identity;
    operator: Identity;
}

const RULE_EXAMPLES: [string, string][] = [
    ["pp_env_reset@sandbox → ask", "A person confirms each sandbox reset"],
    ["destructive@production → deny", "Nothing destructive in production, whatever else is allowed"],
    ["*@group:Finance → ask", "Every action in the Finance group waits for a person"],
    ["pp_access_grant@role:Basic User → allow", "Basic User goes through without asking"],
    ["pp_access_grant@role:System Administrator → deny", "Never handed out by an agent"],
];

export function PowerPlatform() {
    useTick(30_000);
    const settings = useRpc<any>("powerplatform.settings", {}, ["powerplatform", "agents"]);
    const envs = useRpc<any>("powerplatform.environments", {}, ["powerplatform"]);
    const { busy, run } = useAction();
    const [conn, setConn] = useState<ConnForm | null>(null);
    const [test, setTest] = useState<any>(null);
    const s = settings.data;

    useEffect(() => {
        if (!s || conn) return;
        setConn({ apiUrl: s.apiUrl, loginUrl: s.loginUrl, tenantId: s.tenantId, reader: { clientId: s.reader.clientId, secret: "" }, operator: { clientId: s.operator.clientId, secret: "" } });
    }, [s, conn]);

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!conn || !s) return;
        setTest(null);
        const live = !!conn.apiUrl.trim();
        const ok = await run(async () => {
            const identities: Record<string, { clientId: string; secretName: string }> = {};
            for (const which of ["reader", "operator"] as const) {
                const secretName = s[which].secretName || `powerplatform-${which}`;
                // The client secret goes to the vault first; the connection only ever holds its name.
                if (live && conn[which].secret) await rpc("secrets.set", { name: secretName, secretValue: conn[which].secret, description: `Power Platform ${which} client secret` });
                identities[which] = { clientId: live ? conn[which].clientId.trim() : "", secretName: live && (conn[which].secret || s[which].secretName) ? secretName : "" };
            }
            await rpc("powerplatform.configure", { apiUrl: conn.apiUrl.trim(), loginUrl: live ? conn.loginUrl.trim() : "", tenantId: live ? conn.tenantId.trim() : "", ...identities });
            return true;
        }, "Connection saved");
        if (!ok) return;
        setConn({ ...conn, reader: { ...conn.reader, secret: "" }, operator: { ...conn.operator, secret: "" } });
        setTest(await rpc<any>("powerplatform.test").catch((err) => ({ reader: { ok: false, detail: String(err.message ?? err) }, operator: { ok: false, detail: "" } })));
    };
    const configure = (patch: any, message: string) => run(() => rpc("powerplatform.configure", patch), message);
    const protect = (env: any, on: boolean) => run(() => rpc("powerplatform.protect", { environment: env.id, protected: on }), on ? `${env.displayName} is protected` : `${env.displayName} is no longer on the list`);

    const environments: any[] = envs.data?.environments ?? [];
    const onList = new Set<string>(s?.protectedEnvironments ?? []);

    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Power Platform</h1>
                    <p>The tenant your platform team runs. Agents act on it only through Foreman's Power Platform tools: a reader identity for every read, an operator identity for changes, and guardrails that can name the environment.</p>
                </div>
                {s ? <span className={`tag ${s.usingPracticeTenant ? "" : "hivis"}`}>{s.usingPracticeTenant ? "Practice tenant" : "Your tenant"}</span> : null}
            </header>
            <ErrorBanner error={settings.error} />
            {s?.usingPracticeTenant ? (
                <div className="banner">
                    Using the built-in practice tenant: {s.practiceTenant?.environments ?? 0} environments with users, roles and backups, held in memory. Agents can try every tool here, changes included, without touching a real tenant. Set the API address to connect your own.
                </div>
            ) : null}

            <div className="split">
                <div className="stack">
                    <div className="card">
                        <div className="card-head">
                            <h3>Environments</h3>
                            <span className="grow" />
                            {envs.data ? <span className="hint">Read {relTime(envs.data.fetchedAt)}</span> : null}
                            <button className="btn sm" disabled={busy} onClick={() => void run(() => rpc("powerplatform.environments", { refresh: true })).then(envs.reload)}>
                                Refresh
                            </button>
                        </div>
                        <ErrorBanner error={envs.error} />
                        {environments.length ? (
                            <div className="scroll-x">
                                <table className="grid">
                                    <thead>
                                        <tr>
                                            <th>Name</th>
                                            <th>Type</th>
                                            <th>Group</th>
                                            <th>Created</th>
                                            <th>Changes</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {environments.map((e) => (
                                            <tr key={e.id}>
                                                <td title={e.id}>
                                                    <span style={{ fontWeight: 600 }}>{e.displayName}</span>
                                                    {e.protectionLevel === "Standard" ? <span className="tag" style={{ marginLeft: 6 }}>managed</span> : null}
                                                </td>
                                                <td>{e.type}</td>
                                                <td>{e.groupName ?? <span className="muted">none</span>}</td>
                                                <td className="mono" style={{ whiteSpace: "nowrap" }}>{e.createdDateTime ? e.createdDateTime.slice(0, 10) : "—"}</td>
                                                <td style={{ whiteSpace: "nowrap" }}>
                                                    {onList.has(e.id) ? (
                                                        <span className="row" style={{ gap: 8 }}>
                                                            <span title={e.protected}>Protected</span>
                                                            <button className="btn ghost sm" disabled={busy} onClick={() => protect(e, false)}>
                                                                Unprotect
                                                            </button>
                                                        </span>
                                                    ) : e.protected ? (
                                                        <span title={e.protected}>Protected <span className="muted">by type</span></span>
                                                    ) : (
                                                        <span className="row" style={{ gap: 8 }}>
                                                            <span className="muted">Guardrails</span>
                                                            <button className="btn sm" disabled={busy} onClick={() => protect(e, true)}>
                                                                Protect
                                                            </button>
                                                        </span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : !envs.error ? (
                            <Empty title={envs.loading ? "Reading the tenant…" : "No environments"}>The environments the reader identity can see appear here.</Empty>
                        ) : null}
                    </div>

                    <div className="card">
                        <div className="card-head">
                            <h3>Agents that use Power Platform</h3>
                        </div>
                        {s?.agents?.length ? (
                            <div className="list">
                                {s.agents.map((a: any) => (
                                    <a key={a.agentId} className="list-row" href={`#/agents/${a.agentId}`}>
                                        <div className="grow">
                                            <div style={{ fontWeight: 600 }}>{a.name}</div>
                                            <div className="mono muted" style={{ fontSize: 12 }}>
                                                {a.tools.join(" ")}
                                            </div>
                                        </div>
                                        <span className={`tag ${a.canChange ? "hivis" : ""}`}>{a.canChange ? "Operator: can change" : a.connection === "operator" ? "Operator, read tools only" : "Reader: read only"}</span>
                                    </a>
                                ))}
                            </div>
                        ) : (
                            <Empty title="No agent uses Power Platform yet">Switch on pp_ tools for an agent in its studio, or start from one of the Power Platform templates under New agent.</Empty>
                        )}
                    </div>
                </div>

                <div className="stack">
                    <div className="card">
                        <div className="card-head">
                            <h3>Connection</h3>
                        </div>
                        {conn && s ? (
                            <form className="card-body stack" onSubmit={save}>
                                <Field label="Power Platform API" hint="Leave empty to use the practice tenant.">
                                    <input className="input code" value={conn.apiUrl} onChange={(e) => setConn({ ...conn, apiUrl: e.target.value })} placeholder="https://api.powerplatform.com" />
                                </Field>
                                {conn.apiUrl.trim() ? (
                                    <>
                                        <Field label="Tenant id" hint="The directory (tenant) id from Microsoft Entra ID.">
                                            <input className="input code" value={conn.tenantId} onChange={(e) => setConn({ ...conn, tenantId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" required />
                                        </Field>
                                        {(["reader", "operator"] as const).map((which) => (
                                            <div key={which} className="stack" style={{ gap: 8 }}>
                                                <span className="label">{which === "reader" ? "Reader app — give it the Power Platform reader role" : "Operator app — Power Platform contributor"}</span>
                                                <input className="input code" value={conn[which].clientId} onChange={(e) => setConn({ ...conn, [which]: { ...conn[which], clientId: e.target.value } })} placeholder="Application (client) id" aria-label={`${which} client id`} />
                                                <input className="input code" type="password" value={conn[which].secret} onChange={(e) => setConn({ ...conn, [which]: { ...conn[which], secret: e.target.value } })} placeholder={s[which].secretName && s.identities[which].ok ? "••••••••  (stored)" : "Client secret"} aria-label={`${which} client secret`} autoComplete="new-password" />
                                                <span className="hint">{s.identities[which].detail}</span>
                                            </div>
                                        ))}
                                        <Field label="Sign-in address" hint="Leave empty for Microsoft Entra ID.">
                                            <input className="input code" value={conn.loginUrl} onChange={(e) => setConn({ ...conn, loginUrl: e.target.value })} placeholder="https://login.microsoftonline.com" />
                                        </Field>
                                    </>
                                ) : null}
                                <div className="row">
                                    <button className="btn primary" disabled={busy}>
                                        Save and test
                                    </button>
                                    <button type="button" className="btn" disabled={busy} onClick={async () => setTest((await run(() => rpc<any>("powerplatform.test"))) ?? null)}>
                                        Test
                                    </button>
                                </div>
                                {test
                                    ? (["reader", "operator"] as const).map((which) =>
                                          test[which] ? (
                                              <div key={which} className={`banner ${test[which].ok ? "" : "error"}`}>
                                                  <b>{which === "reader" ? "Reader" : "Operator"}:</b> {test[which].detail}
                                              </div>
                                          ) : null,
                                      )
                                    : null}
                                <span className="hint">Client secrets are stored encrypted under Secrets and never shown again. An agent never holds a token: Foreman makes every call itself.</span>
                            </form>
                        ) : null}
                    </div>

                    <div className="card">
                        <div className="card-head">
                            <h3>Protection</h3>
                        </div>
                        {s ? (
                            <div className="card-body stack">
                                <span className="hint">Protected environments refuse every change, whatever an agent's guardrails say. A backup is still allowed: it changes nothing in the environment.</span>
                                <div className="row wrap" style={{ gap: 6 }}>
                                    <button type="button" className="chip" aria-pressed={s.protectProduction} disabled={busy} onClick={() => void configure({ protectProduction: !s.protectProduction }, s.protectProduction ? "Production is no longer protected" : "Production is protected")}>
                                        All production environments
                                    </button>
                                    <button type="button" className="chip" aria-pressed={s.protectDefault} disabled={busy} onClick={() => void configure({ protectDefault: !s.protectDefault }, s.protectDefault ? "The default environment is no longer protected" : "The default environment is protected")}>
                                        The default environment
                                    </button>
                                </div>
                                <span className="hint">{onList.size ? `${onList.size} more on the list (Protect in the table).` : "Add any other environment with Protect in the table."}</span>
                                <Field label="Wait for long operations (seconds)" hint="Copy, restore, reset and create can take a long time. After this, the tool hands back the operation's id and the agent checks later.">
                                    <input className="input code" type="number" min={0} max={1800} defaultValue={s.waitSeconds} onBlur={(e) => Number(e.target.value) !== s.waitSeconds && void configure({ waitSeconds: Number(e.target.value) }, "Saved")} />
                                </Field>
                            </div>
                        ) : null}
                    </div>

                    <div className="card">
                        <div className="card-head">
                            <h3>Guardrails that name an environment</h3>
                        </div>
                        <div className="card-body stack">
                            <span className="hint">Add these as exceptions in an agent's guardrails. After the @ comes the environment's type, group:name, env:name, managed, or for access, role:name.</span>
                            {RULE_EXAMPLES.map(([rule, text]) => (
                                <div key={rule}>
                                    <code className="mono">{rule}</code>
                                    <div className="hint">{text}</div>
                                </div>
                            ))}
                            <span className="hint">Delete, reset, restore and copy are destructive: every autonomy level except Full denies them until a rule says otherwise.</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
