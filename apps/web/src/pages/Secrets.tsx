import { useRef, useState } from "react";
import { rpc, useRpc } from "../api.ts";
import { Empty, ErrorBanner, Field, relTime, useAction, useTick } from "../ui.tsx";

const KEY_SOURCE: Record<string, string> = {
    "key file": "Encrypted with a key kept in vault.key in the data directory. Back that file up with the database; without it the secrets cannot be read.",
    environment: "Encrypted with the key from FOREMAN_SECRET_KEY.",
    memory: "This server keeps nothing on disk, so secrets last only until it stops.",
};

export function Secrets() {
    useTick(15_000);
    const list = useRpc<any>("secrets.list", {}, ["audit"]);
    const { busy, run } = useAction();
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    const [description, setDescription] = useState("");
    const nameInput = useRef<HTMLInputElement>(null);
    const valueInput = useRef<HTMLInputElement>(null);
    const secrets: any[] = list.data?.secrets ?? [];
    const replacing = secrets.some((s) => s.name === name.trim());

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        const out = await run(() => rpc<any>("secrets.set", { name: name.trim(), secretValue: value, ...(description.trim() ? { description: description.trim() } : {}) }), replacing ? "Secret replaced" : "Secret stored");
        if (out) (setName(""), setValue(""), setDescription(""), list.reload());
    };
    const remove = (s: any) => {
        const used = s.usedBy.length ? `\n\nIt is used by: ${s.usedBy.join(", ")}. That will stop working.` : "";
        if (confirm(`Delete the secret “${s.name}”? This cannot be undone.${used}`)) void run(() => rpc("secrets.delete", { name: s.name }), "Secret deleted").then(list.reload);
    };

    return (
        <div className="page">
            <header className="page-head">
                <div className="grow">
                    <h1>Secrets</h1>
                    <p>Tokens and keys Foreman signs in with. A secret can be stored, replaced and used — never read back, here or over MCP.</p>
                </div>
            </header>
            <ErrorBanner error={list.error} />
            <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
                <div className="stack">
                    <div className="card">
                        {secrets.length ? (
                            <div className="scroll-x">
                                <table className="grid">
                                    <thead>
                                        <tr>
                                            <th>Name</th>
                                            <th>Used by</th>
                                            <th className="num">Changed</th>
                                            <th className="num">Last used</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {secrets.map((s) => (
                                            <tr key={s.name}>
                                                <td>
                                                    <div className="mono" style={{ fontWeight: 600 }}>
                                                        {s.name}
                                                    </div>
                                                    {s.description ? (
                                                        <div className="muted" style={{ fontSize: 12.5 }}>
                                                            {s.description}
                                                        </div>
                                                    ) : null}
                                                </td>
                                                <td>
                                                    {s.usedBy.length ? (
                                                        <div className="row wrap" style={{ gap: 6 }}>
                                                            {s.usedBy.map((u: string) => (
                                                                <span key={u} className="tag">
                                                                    {u}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    ) : (
                                                        <span className="muted">Nothing yet</span>
                                                    )}
                                                </td>
                                                <td className="num">{relTime(s.updatedAt)}</td>
                                                <td className="num">{s.lastUsedAt ? relTime(s.lastUsedAt) : "never"}</td>
                                                <td>
                                                    <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                                                        <button
                                                            className="btn sm"
                                                            onClick={() => {
                                                                setName(s.name);
                                                                setDescription(s.description);
                                                                valueInput.current?.focus();
                                                            }}
                                                        >
                                                            Replace
                                                        </button>
                                                        <button className="btn sm ghost danger" disabled={busy} onClick={() => remove(s)}>
                                                            Delete
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <Empty title="No secrets stored">Store a Jira API token here, or a key an MCP server needs, then refer to it by name.</Empty>
                        )}
                    </div>
                    <p className="hint">{list.data ? KEY_SOURCE[list.data.keySource] : ""} Stored values are also removed from run traces if they ever appear in one.</p>
                </div>

                <div className="stack">
                    <form className="card" onSubmit={save}>
                        <div className="card-head">
                            <h3>{replacing ? "Replace a secret" : "Store a secret"}</h3>
                        </div>
                        <div className="card-body stack">
                            <Field label="Name" hint="Letters, digits, dot, dash or underscore. This is what other settings refer to.">
                                <input ref={nameInput} className="input code" value={name} onChange={(e) => setName(e.target.value)} placeholder="jira-token" pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,62}" required autoComplete="off" />
                            </Field>
                            <Field label="Value" hint={replacing ? "The current value is replaced. It cannot be shown." : "Shown as dots, encrypted when saved."}>
                                <input ref={valueInput} className="input code" type="password" value={value} onChange={(e) => setValue(e.target.value)} required autoComplete="new-password" />
                            </Field>
                            <Field label="What it is for">
                                <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Jira API token for the bot account" maxLength={200} />
                            </Field>
                            <div className="row">
                                <button className="btn primary" disabled={busy || !name.trim() || !value}>
                                    {replacing ? "Replace" : "Store"}
                                </button>
                                {name || value ? (
                                    <button type="button" className="btn ghost" onClick={() => (setName(""), setValue(""), setDescription(""))}>
                                        Clear
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    </form>
                    <div className="card">
                        <div className="card-head">
                            <h3>Using a secret</h3>
                        </div>
                        <div className="card-body stack" style={{ fontSize: 13.5 }}>
                            <div>
                                <b>Jira.</b> Under Work → Routing &amp; intake, type the token into the Jira connection; it is stored here for you.
                            </div>
                            <div>
                                <b>MCP servers.</b> In an agent's MCP server settings, put <code className="mono">{"{{secret:NAME}}"}</code> where the value goes, for example in a header or an environment variable.
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
