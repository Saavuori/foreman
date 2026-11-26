/**
 * Turning documents into searchable text: HTML and Confluence storage format to plain text that
 * keeps its structure, plain text to passages, and the built-in embedder. No dependencies.
 */

const ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·",
    auml: "ä", ouml: "ö", aring: "å", uuml: "ü", Auml: "Ä", Ouml: "Ö", Aring: "Å", Uuml: "Ü", eacute: "é",
    euro: "€", copy: "©", reg: "®", trade: "™", times: "×", rarr: "→", larr: "←", deg: "°", shy: "",
};
export function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e: string) => {
        if (e[0] !== "#") return ENTITIES[e] ?? match;
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

const inline = (html: string) => decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// Macros that navigate or list other content rather than say anything themselves.
const NOISE_MACROS = "toc|children|pagetree|pagetreesearch|recently-updated|contentbylabel|livesearch|attachments|excerpt-include|include|space-details|create-from-template|profile|blog-posts|change-history|gallery|viewfile|roadmap";

/**
 * HTML, or Confluence's storage format (XHTML with `ac:` macros), to plain text. Headings become
 * `#` lines, list items `- ` lines, table rows `| a | b |` and code stays fenced, so the passage
 * splitter and the reader can still see the shape of the page.
 */
export function htmlToText(html: string): string {
    const kept: string[] = [];
    const keep = (text: string) => `\u0000${kept.push(text) - 1}\u0000`;
    let s = html.replace(/\r\n?/g, "\n");
    s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1>/gi, "");
    s = s.replace(/<ac:structured-macro\b[^>]*ac:name="(?:code|noformat)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_, inner: string) => {
        const body = /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/i.exec(inner)?.[1] ?? "";
        return keep(`\n\n\`\`\`\n${body.replace(/\s+$/, "")}\n\`\`\`\n\n`);
    });
    s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => keep(`\n\n\`\`\`\n${decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\s+$/, "")}\n\`\`\`\n\n`));
    s = s.replace(/<ac:structured-macro\b[^>]*ac:name="jira"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_, inner: string) => /<ac:parameter ac:name="key">([^<]*)<\/ac:parameter>/i.exec(inner)?.[1] ?? "");
    s = s.replace(new RegExp(`<ac:structured-macro\\b[^>]*ac:name="(?:${NOISE_MACROS})"[^>]*?(?:/>|>[\\s\\S]*?</ac:structured-macro>)`, "gi"), "");
    // An expand or panel keeps its title as a line of its own.
    s = s.replace(/<ac:parameter ac:name="title">([^<]*)<\/ac:parameter>/gi, (_, title: string) => `\n\n${title}\n\n`);
    s = s.replace(/<ac:parameter\b[^>]*>[\s\S]*?<\/ac:parameter>/gi, "");
    s = s.replace(/<ac:link\b[^>]*>([\s\S]*?)<\/ac:link>/gi, (_, inner: string) => {
        const body = /<ac:(?:plain-text-)?link-body>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/ac:(?:plain-text-)?link-body>/i.exec(inner)?.[1];
        if (body) return body;
        return /ri:content-title="([^"]*)"/i.exec(inner)?.[1] ?? /ri:filename="([^"]*)"/i.exec(inner)?.[1] ?? "";
    });
    s = s.replace(/<ac:image\b[^>]*>([\s\S]*?)<\/ac:image>/gi, (_, inner: string) => {
        const file = /ri:filename="([^"]*)"/i.exec(inner)?.[1] ?? /ri:value="([^"]*)"/i.exec(inner)?.[1];
        return file ? ` [image: ${file}] ` : "";
    });
    s = s.replace(/<img\b[^>]*>/gi, (tag) => {
        const alt = /\balt="([^"]*)"/i.exec(tag)?.[1];
        return alt ? ` [image: ${alt}] ` : "";
    });
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    // Tables first, so paragraphs inside cells do not break rows apart.
    s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, inner: string) => {
        const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => inline(cell[1]!).replace(/\|/g, "/")));
        const lines = rows.filter((cells) => cells.some(Boolean)).map((cells) => `| ${cells.join(" | ")} |`);
        return lines.length ? keep(`\n\n${lines.join("\n")}\n\n`) : "";
    });
    s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
        const text = inline(inner);
        return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "";
    });
    s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/(?:li|ul|ol)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\/?(?:p|div|section|article|blockquote|header|footer|main|ac:rich-text-body|ac:layout|ac:layout-section|ac:layout-cell|ac:task-list|ac:task|ac:structured-macro)\b[^>]*>/gi, "\n\n");
    s = s.replace(/<[^>]+>/g, "");
    s = decodeEntities(s);
    s = s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
    for (let pass = 0; pass < 3 && s.includes("\u0000"); pass++) s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] ?? "");
    return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** Plain text from an uploaded file, by its name. Null when the type is not one Foreman reads. */
export function fileToText(fileName: string, bytes: Uint8Array): { text: string; mediaType: string } | null {
    const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
    const utf8 = () => new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    if (["md", "markdown"].includes(ext)) return { text: utf8(), mediaType: "text/markdown" };
    if (["txt", "text", "log", "csv", "tsv", "json", "yaml", "yml", "xml", "ini", "cfg", "conf", "sql", "sh", "ps1", "py", "ts", "js", "java", "cs", "go"].includes(ext)) return { text: utf8(), mediaType: "text/plain" };
    if (["html", "htm", "xhtml"].includes(ext)) return { text: htmlToText(utf8()), mediaType: "text/html" };
    return null;
}

export interface Passage {
    /** Heading path within the document, e.g. "Refunds › Rounding". Empty before the first heading. */
    heading: string;
    text: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/**
 * Split a document into passages for search. A passage starts at a heading when the one before is
 * already a useful size, long sections are cut at paragraph boundaries, code blocks and tables are
 * never cut in the middle unless they alone are too long.
 */
export function toPassages(text: string, { min = 400, max = 2400 } = {}): Passage[] {
    const sections: { path: string[]; paragraphs: string[] }[] = [];
    const stack: string[] = [];
    let current = { path: [] as string[], paragraphs: [] as string[] };
    let paragraph: string[] = [];
    let fenced = false;
    const endParagraph = () => {
        const p = paragraph.join("\n").trim();
        if (p) current.paragraphs.push(p);
        paragraph = [];
    };
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        const heading = !fenced ? HEADING.exec(line) : null;
        if (heading) {
            endParagraph();
            if (current.paragraphs.length || current.path.length) sections.push(current);
            const level = heading[1]!.length;
            stack.length = Math.min(stack.length, level - 1);
            while (stack.length < level - 1) stack.push("");
            stack.push(heading[2]!.trim());
            current = { path: stack.filter(Boolean), paragraphs: [line.trim()] };
        } else if (!fenced && !line.trim()) {
            endParagraph();
        } else {
            paragraph.push(line);
        }
    }
    endParagraph();
    if (current.paragraphs.length) sections.push(current);

    const passages: Passage[] = [];
    let heading = "";
    let parts: string[] = [];
    let size = 0;
    // A heading with nothing under it yet rides along into the next passage instead of standing alone.
    const flush = (final = false) => {
        const onlyHeadings = parts.every((p) => HEADING.test(p));
        if (onlyHeadings && !final) return;
        const body = parts.join("\n\n").trim();
        if (body && !onlyHeadings) passages.push({ heading, text: body });
        parts = [];
        size = 0;
    };
    for (const section of sections) {
        if (size >= min) flush();
        if (!size) heading = section.path.join(" › ");
        for (const p of section.paragraphs) {
            // Leave room for a heading carried in from the section above.
            for (const piece of p.length > max - 200 ? cut(p, max - 200) : [p]) {
                if (size && size + piece.length > max) {
                    flush();
                    heading = section.path.join(" › ");
                }
                parts.push(piece);
                size += piece.length + 2;
            }
        }
    }
    flush(true);
    return passages;
}

/** Cut an over-long paragraph at line, then sentence, then word boundaries. */
function cut(text: string, max: number): string[] {
    const out: string[] = [];
    let rest = text;
    while (rest.length > max) {
        const window = rest.slice(0, max);
        let at = window.lastIndexOf("\n");
        if (at < max * 0.5) at = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! ")) + 1;
        if (at < max * 0.5) at = window.lastIndexOf(" ");
        if (at < max * 0.5) at = max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
    return out;
}

// Words too common to help a search. Short on purpose: BM25 already discounts common words.
const STOP = new Set(
    "a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to was we what when where which who why will with you your ja on ei se ne että tai kun jos mitä miten mikä kuka myös sekä ole oli olla".split(" "),
);

/** An FTS5 query from free text: any word may match, longer words also by prefix. Null when nothing is left. */
export function ftsQuery(query: string): string | null {
    const words = (query.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
    const unique = [...new Set(words)].slice(0, 16);
    if (!unique.length) return null;
    return unique.map((w) => (w.length >= 4 ? `"${w}"*` : `"${w}"`)).join(" OR ");
}

// ── Vectors ────────────────────────────────────────────────────────────────

export const BUILTIN_DIMENSIONS = 384;
function fnv(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

/**
 * The built-in embedder: hashed words and four-letter word pieces. It matches shared word parts,
 * not meaning, but it needs no model and copes with inflected and compound words, which plain
 * keyword search does not.
 */
export function builtinEmbed(text: string): Float32Array {
    const v = new Float32Array(BUILTIN_DIMENSIONS);
    const add = (token: string, weight: number) => {
        const h = fnv(token);
        v[h % BUILTIN_DIMENSIONS]! += h & 0x80000000 ? -weight : weight;
    };
    for (const word of text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (STOP.has(word)) continue;
        add(`w:${word}`, 1);
        const padded = ` ${word} `;
        for (let i = 0; i + 4 <= padded.length; i++) add(padded.slice(i, i + 4), 0.6);
    }
    return v;
}

/** Normalise and store in 8 bits: a quarter of the memory, and the ranking barely moves. */
export function quantize(vector: ArrayLike<number>): Int8Array {
    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i]! * vector[i]!;
    norm = Math.sqrt(norm) || 1;
    const out = new Int8Array(vector.length);
    for (let i = 0; i < vector.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round((vector[i]! / norm) * 127)));
    return out;
}

/** Cosine similarity of two quantised, normalised vectors. */
export function similarity(a: Int8Array, b: Int8Array): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
    return dot / (127 * 127);
}
