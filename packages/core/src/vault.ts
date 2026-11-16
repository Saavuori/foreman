import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY, sealed TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
);`;
const PREFIX = "enc:v1:";
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** `{{secret:NAME}}` inside a setting is replaced by the secret's value when it is used. */
const REFERENCE = /\{\{\s*secret:([A-Za-z0-9_.-]+)\s*\}\}/g;

export interface SecretInfo {
    name: string;
    description: string;
    createdAt: string;
    updatedAt: string;
    lastUsedAt: string | null;
}

export interface VaultOptions {
    /** Where the key file lives. Not used when `secretKey` is given or for an in-memory store. */
    dataDir?: string;
    /** A passphrase to derive the key from (FOREMAN_SECRET_KEY) instead of a key file. */
    secretKey?: string;
    memory?: boolean;
}

/**
 * Credentials, encrypted at rest (AES-256-GCM). Values go in through the API and never come back
 * out of it: other settings refer to a secret by name, and the value is read only at the moment
 * it is used. Anything that looks like a stored value is scrubbed from traces.
 */
export class Vault {
    private key: Buffer;
    readonly keySource: "environment" | "key file" | "memory";
    private cache: Map<string, string> | null = null;

    constructor(
        private store: Store,
        options: VaultOptions = {},
    ) {
        store.db.exec(SCHEMA);
        if (options.secretKey) {
            this.key = createHash("sha256").update(options.secretKey).digest();
            this.keySource = "environment";
        } else if (options.memory || !options.dataDir) {
            this.key = randomBytes(32);
            this.keySource = "memory";
        } else {
            const path = join(options.dataDir, "vault.key");
            if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
            this.key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
            if (this.key.length !== 32) throw new Error(`${path} is not a valid vault key (expected 32 bytes, base64)`);
            this.keySource = "key file";
        }
    }

    // ── sealing: for values that are stored next to other data, such as a webhook address ──
    seal(plain: string): string {
        if (!plain) return "";
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        return PREFIX + [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
    }
    /** Values stored before the vault existed are plain text and are returned as they are. */
    unseal(sealed: string): string {
        if (!sealed.startsWith(PREFIX)) return sealed;
        const [iv, tag, data] = sealed.slice(PREFIX.length).split(".").map((part) => Buffer.from(part, "base64url"));
        try {
            const decipher = createDecipheriv("aes-256-gcm", this.key, iv!);
            decipher.setAuthTag(tag!);
            return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
        } catch {
            throw new Error("A stored secret cannot be decrypted: the vault key is not the one it was saved with");
        }
    }

    // ── named secrets ─────────────────────────────────────────────────────
    private rows() {
        return this.store.db.prepare("SELECT * FROM secrets ORDER BY name").all() as any[];
    }
    list(): SecretInfo[] {
        return this.rows().map((r) => ({ name: r.name, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at }));
    }
    has(name: string): boolean {
        return !!this.store.db.prepare("SELECT 1 FROM secrets WHERE name = ?").get(name);
    }
    set(name: string, value: string, description?: string): SecretInfo {
        if (!SECRET_NAME.test(name)) throw new Error("A secret name is letters, digits, dot, dash or underscore (up to 63 characters)");
        if (!value) throw new Error("A secret needs a value");
        const ts = new Date().toISOString();
        this.store.db
            .prepare("INSERT INTO secrets (name, sealed, description, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at, description = COALESCE(?, description)")
            .run(name, this.seal(value), description ?? "", ts, ts, description ?? null);
        this.cache = null;
        return this.list().find((s) => s.name === name)!;
    }
    delete(name: string): boolean {
        this.cache = null;
        return this.store.db.prepare("DELETE FROM secrets WHERE name = ?").run(name).changes > 0;
    }
    /** The value, for use in a request. Never return this from a capability. */
    use(name: string): string {
        const row = this.store.db.prepare("SELECT sealed FROM secrets WHERE name = ?").get(name) as { sealed: string } | undefined;
        if (!row) throw new Error(`Secret "${name}" does not exist`);
        this.store.db.prepare("UPDATE secrets SET last_used_at = ? WHERE name = ?").run(new Date().toISOString(), name);
        return this.unseal(row.sealed);
    }

    /** Replace every `{{secret:NAME}}` in a string. An unknown name is an error, not an empty string. */
    resolve(text: string): string {
        return text.replace(REFERENCE, (_m, name: string) => this.use(name));
    }
    /** The names a string refers to. */
    static references(text: string): string[] {
        return [...text.matchAll(REFERENCE)].map((m) => m[1]!);
    }

    private values(): Map<string, string> {
        if (!this.cache) {
            this.cache = new Map();
            for (const row of this.rows()) {
                try {
                    const value = this.unseal(row.sealed);
                    // Very short values would blank out ordinary words.
                    if (value.length >= 6) this.cache.set(row.name, value);
                } catch {
                    /* undecryptable: nothing to scrub */
                }
            }
        }
        return this.cache;
    }
    /** Remove stored secret values from text that is about to be recorded. */
    scrub(text: string): string {
        for (const [name, value] of this.values()) if (text.includes(value)) text = text.split(value).join(`«secret:${name}»`);
        return text;
    }
    /** The same, for structured data such as a trace event. */
    scrubData<T>(data: T): T {
        if (!this.values().size || data === undefined) return data;
        const before = JSON.stringify(data);
        // A value may contain characters JSON escapes, so compare against the escaped form too.
        let after = before;
        for (const [name, value] of this.values()) {
            const escaped = JSON.stringify(value).slice(1, -1);
            if (after.includes(escaped)) after = after.split(escaped).join(`«secret:${name}»`);
        }
        return after === before ? data : (JSON.parse(after) as T);
    }
}
