# Secrets vault and redaction

Files: `src/vault.ts`, `src/capabilities/vault.ts`. Used by `work.ts` (Jira token),
`notify.ts` (channel addresses), `engine.ts` (scrubbing, reference resolution).

## Guarantees

Keep all of these true. A change that breaks one is a security regression.

1. **Encrypted at rest.** AES-256-GCM, a fresh 12-byte IV per value, stored as
   `enc:v1:<iv>.<tag>.<data>` (base64url).
2. **Write-only.** No capability returns a secret value. `Vault.use(name)` is the only way to
   read one, and its result must go straight into an outgoing request.
3. **Not in the audit log.** `secrets.set` takes the value in a field named `secretValue`, which
   `redact()` blanks by name.
4. **Not in traces.** `scrubData` replaces any stored value (6 characters or longer) found in a
   trace event, a run's output or its error with `«secret:NAME»`.
5. **Referenced by name.** Settings hold a secret's name, never its value.

Known gap, stated honestly: a run's stored `prompt` is not scrubbed, only its trace and output.

## The key

| Situation | Key | `keySource` |
|---|---|---|
| `FOREMAN_SECRET_KEY` set | SHA-256 of that passphrase | `environment` |
| otherwise, on disk | 32 random bytes in `<dataDir>/vault.key` (created on first start, mode 0600) | `key file` |
| in-memory store (tests, demo) | random, lost on exit | `memory` |

Changing the key makes existing values unreadable: `unseal` throws "cannot be decrypted". There
is no re-keying tool. `data/` is git-ignored — never commit `vault.key`.

## API

| Method | Use |
|---|---|
| `set(name, value, description?)` | Store or replace a named secret |
| `list()` | Names and timestamps only |
| `has(name)`, `delete(name)` | — |
| `use(name)` | The value, for an outgoing request. Updates `last_used_at`. Throws if missing |
| `resolve(text)` | Replace every `{{secret:NAME}}`. An unknown name throws rather than becoming empty |
| `Vault.references(text)` | The names a string refers to |
| `seal(plain)` / `unseal(sealed)` | For a credential stored beside other data (channel addresses). `unseal` passes plain text through, so values saved before the vault existed still work |
| `scrub(text)` / `scrubData(data)` | Remove stored values from text or structured data |

Names match `SECRET_NAME`: letters, digits, dot, dash, underscore; up to 63 characters.

## Using a secret in new code

- **A setting that needs a credential:** store only `secretName` in the setting. Read with
  `vault.use(secretName)` when building the request, as `WorkHub.client()` does. In the
  capability that saves the setting, check `vault.has(name)` and fail with a message that says
  to call `secrets.set` first.
- **A credential that is one field of a row:** `seal` on write, `unseal` on read, mask it when
  listing, and name the input field so `redact()` catches it. See channels in `notify.ts`.
- **A value inside an agent's spec** (MCP server header or env): the spec holds
  `{{secret:NAME}}`; the runtime calls `x.resolveSecrets(value)` when it starts the session.
- **Tell `secrets.list` about it:** add the reference to `usage()` in
  `capabilities/vault.ts`, so people see what a secret is used by before deleting it.

Never log a resolved value, put it in an error message, or pass it to `emit`.

## Testing

Assert on absence: after a flow that handles a secret, check the value does not appear in the
capability's result, in `audit.list`, or in `runs.events`, and that the stored column starts
with `enc:v1:`. See the "stores secrets write-only…" test in
`apps/server/src/server.test.ts`. Use obviously fake values.
