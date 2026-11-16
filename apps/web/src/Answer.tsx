import { useState } from "react";
import { rpc } from "./api.ts";
import { useAction } from "./ui.tsx";

/** Reply to a question an agent asked. The run continues with the text the moment it is sent. */
export function AnswerBox({ approvalId, autoFocus }: { approvalId: string; autoFocus?: boolean }) {
    const [text, setText] = useState("");
    const { busy, run } = useAction();
    const send = () => run(() => rpc("approvals.decide", { approvalId, decision: "approve", reason: text.trim() }), "Answer sent");
    return (
        <form
            className="answer"
            onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void send();
            }}
        >
            <textarea
                className="input"
                rows={2}
                value={text}
                autoFocus={autoFocus}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && void send()}
                placeholder="Type your answer…"
                aria-label="Your answer"
            />
            <div className="row" style={{ gap: 6 }}>
                <button className="btn sm hivis" disabled={busy || !text.trim()}>
                    Send answer
                </button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => rpc("approvals.decide", { approvalId, decision: "deny", reason: "No answer available" }), "Told the agent no answer is coming")}>
                    Can't answer
                </button>
            </div>
        </form>
    );
}
