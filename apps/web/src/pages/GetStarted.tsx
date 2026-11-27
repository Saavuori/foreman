import { go, rpc, useRpc } from "../api.ts";
import { useAction } from "../ui.tsx";

const TOPICS = ["agents", "run", "work", "notify", "setup", "connections"];

interface Step {
    id: string;
    title: string;
    text: string;
    done: boolean;
    optional: boolean;
    path: string;
    action: string;
}

/** The getting-started checklist on the board. Every tick comes from setup.status, never from clicks. */
export function GetStarted() {
    const status = useRpc<any>("setup.status", {}, TOPICS);
    const { busy, run } = useAction();
    const s = status.data;
    if (!s || s.hidden) return null;
    const steps: Step[] = s.steps;
    const required = steps.filter((st) => !st.optional);
    const optional = steps.filter((st) => st.optional);
    const basicsDone = s.next === null;

    return (
        <section className="card get-started" aria-label="Get started">
            <div className="card-head">
                <h3>{basicsDone ? "The basics are set up" : "Get started"}</h3>
                <span className="eyebrow">
                    {s.requiredDone} of {s.requiredTotal} done
                </span>
                <div className="setup-meter" aria-hidden="true">
                    {required.map((st) => (
                        <i key={st.id} className={st.done ? "on" : ""} />
                    ))}
                </div>
                <span className="grow" />
                <button className="btn ghost sm" disabled={busy} onClick={() => run(() => rpc("setup.hide", { hidden: true }))}>
                    Hide
                </button>
            </div>
            {basicsDone ? null : (
                <ol className="setup-steps">
                    {required.map((st, i) => (
                        <StepRow key={st.id} step={st} number={i + 1} next={st.id === s.next} />
                    ))}
                </ol>
            )}
            <div className="setup-more">
                <span className="eyebrow">{basicsDone ? "Next, when you are ready" : "Later, when you are ready"}</span>
                <ol className="setup-steps compact">
                    {optional.map((st) => (
                        <StepRow key={st.id} step={st} next={false} />
                    ))}
                </ol>
            </div>
            <div className="setup-foot">
                {s.samples ? (
                    <>
                        <span className="grow">Sample data is loaded: {s.samples.agents} sample agents with routing rules for the practice Jira. It does not count towards the steps above.</span>
                        <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("samples.remove"), "Sample data removed")}>
                            Remove sample data
                        </button>
                    </>
                ) : (
                    <>
                        <span className="grow">Want to look around first? Load sample agents and tickets from the practice Jira. You can remove them again in one click.</span>
                        <button className="btn sm" disabled={busy} onClick={() => run(() => rpc("samples.load"), "Sample data loaded")}>
                            Load sample data
                        </button>
                    </>
                )}
            </div>
        </section>
    );
}

function StepRow({ step, number, next }: { step: Step; number?: number; next: boolean }) {
    return (
        <li className={`setup-step${step.done ? " done" : ""}${next ? " next" : ""}`}>
            <span className="setup-mark" aria-label={step.done ? "Done" : "Not done yet"}>
                {step.done ? "✓" : (number ?? "·")}
            </span>
            <div className="grow">
                <b>{step.title}</b>
                <p>{step.text}</p>
            </div>
            {step.done ? null : (
                <button className={`btn sm${next ? " primary" : ""}`} onClick={() => go(step.path)}>
                    {step.action}
                </button>
            )}
        </li>
    );
}

/** A way back to the checklist once it has been hidden. */
export function ShowGetStarted() {
    const status = useRpc<any>("setup.status", {}, TOPICS);
    const { busy, run } = useAction();
    if (!status.data?.hidden) return null;
    return (
        <button className="btn ghost" disabled={busy} onClick={() => run(() => rpc("setup.hide", { hidden: false }))}>
            Getting started
        </button>
    );
}
