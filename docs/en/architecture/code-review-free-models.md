# Code Review: free-models feature (git range `1346b7d..742b7d6`)

> Reviewed: 2026-09-24. Scope: the 3 commits implementing `?free=true` + the opencode picker sync
> (`bfadec9`, `462ca77`, `742b7d6`). Independent model reviewers were unavailable, so this is a
> direct full-file review of all six changed source files plus their tests.

## Purpose of the changes (recap)

1. **`?free=true`** on `GET /v1/models` — opt-in filter; the default listing is unchanged.
2. **opencode picker sync** — after each 2h catalog sync, `syncOpencodeConfig()` rewrites only
   `provider.freellmapi-router.models` in `~/.config/opencode/opencode.json` (enabled by
   `OPENCODE_CONFIG_PATH`; off by default). Keeps `auto` verbatim, drops `fusion`, leaves the 4
   other providers (with plaintext keys) untouched.
3. **`supportsVision`** now flows through `model-listing.ts` so picker entries can say which
   models accept images.
4. **Schema conformance** — legacy keys only (`tool_call`, `modalities`, `limit{context,output}`);
   `capabilities` would make opencode reject the whole provider (bug fixed in `742b7d6`).

---

## Findings

### F1 — HIGH (reliability): a throw inside the sync hook can kill the whole process

`catalog-sync.ts:856-864`:

```ts
void syncCatalog().then(() => {
  const res = syncOpencodeConfig();
  ...
});
```

`syncCatalog()` never throws (it catches internally), but **`syncOpencodeConfig()` is not
guaranteed not to throw**: `pickFreeUsable()` → `buildModelListing()` hits the SQLite database,
and a DB error (locked, corrupted, disk) escapes `syncOpencodeConfig` — every fs/JSON failure is
wrapped in try/catch, but the model listing call is not. A synchronous throw inside a `.then()`
callback rejects the surrounding promise, there is no `.catch()`, and on modern Node
(≥15 default) an unhandled rejection **terminates the process** — taking the proxy, the tray's
backend, and every active request with it, every 2 hours, until someone notices.

**Fix:** wrap the hook body in try/catch AND add `.catch()` on the chain, so a DB blip at worst
skips one picker refresh.

### F2 — MEDIUM (security): `__proto__` lookup on the provider map

`opencode-config.ts:122`:

```ts
const provider = (providers as Record<string, unknown>)[providerId];
```

If `OPENCODE_PROVIDER_ID` is `__proto__` (or the env var is unset-with-weird-value paths), the
lookup returns `Object.prototype` — which passes the `typeof === 'object'` guard. The subsequent
`providerObj.models = models` then assigns **onto `Object.prototype`**, polluting every object in
the process, and the function reports `written: true` while the serialized `root` (which never
owned that key) is written out unchanged — a confusing silent no-op at best.

**Fix:** use `Object.prototype.hasOwnProperty.call(providers, providerId)` so only own keys are
accepted.

### F3 — MEDIUM (correctness/security): unsafe model ids used as object keys

`opencode-config.ts:155`:

```ts
models[m.id] = entry;
```

`m.id` originates from the remote catalog. Two problems:

- `m.id === '__proto__'` → the assignment **sets the prototype** of `models` instead of creating a
  key. The model silently vanishes from the picker (JSON.stringify skips it).
- `m.id === 'auto'` → the catalog entry **overwrites the verbatim `auto` entry** that was just
  preserved at line 144, defeating the "keep the user's default router entry" guarantee.

The catalog is Ed25519-signed, so exploitation requires a compromised upstream — but the guard
is two lines and removes the whole class.

**Fix:** skip `__proto__`, `constructor`, `prototype`, and `AUTO_MODEL_ID` as emitted ids.

### F4 — LOW (hygiene): stale `.tmp-<pid>` file left behind on write failure

`opencode-config.ts:174-183`: if `renameSync` fails (or the process dies between write and
rename), `${configPath}.tmp-<pid>` is left on disk. Harmless but accumulates across crashes.

**Fix:** `fs.rmSync(tmp, { force: true })` in the catch (and best-effort before writing).

### F5 — LOW (robustness): a non-object `models` block silently drops `auto`

`opencode-config.ts:130-132`: if `provider.<id>.models` exists but is an **array** (or other
non-object), the code falls back to `{}` and `existingAuto` becomes `undefined` — the `auto`
entry vanishes from the rewritten config and the user's default model stops resolving, with no
diagnostic. The shape is invalid for opencode anyway, but silently discarding the configured
default is the wrong failure mode for a file that carries credentials.

**Fix:** treat "models exists but is not an object" as a skip-with-reason like the other rails.

---

## Verified safe (checked, no action needed)

- **Secrets**: no key/hash/token appears in any of the 11 committed files; `sk-must-survive` /
  `sk-test-fake...` are deliberate test fixtures. `.env` and `freeapi.db` are gitignored and were
  never tracked (audited 2026-09-23).
- **Atomicity**: crash windows are safe — `.bak` is taken first, temp file + `renameSync` means
  the original is never truncated; a crash between write and rename leaves the original intact.
- **JSON injection**: `JSON.stringify` escapes catalog-controlled `name` strings; no
  string-concatenated JSON anywhere.
- **Dedup check**: both sides of the `JSON.stringify` comparison come from parsed/built objects,
  so formatting cannot cause spurious rewrites.
- **`?free=true` parsing**: `String(...).toLowerCase()` handles `TRUE`/`True`; only
  `1|true|yes` enable it; unknown values are ignored (fail-open to the unfiltered default, which
  is the documented default behavior — not a bypass of a security boundary).
- **Empty-list rail**: refuses to wipe the picker when zero free+available models exist.
- **Vision semantics**: `infos.some(i => i.supports_vision === 1)` claims vision for a group if
  ANY member has it — a known, documented tradeoff matching how the router dispatches.
- **Path traversal via `OPENCODE_CONFIG_PATH`**: the variable is set by the local user in a
  gitignored `.env`; it is not attacker-reachable in any supported deployment.

## Known accepted tradeoffs (documented, not bugs)

- `DEFAULT_OUTPUT_LIMIT = 32000` is opencode's own documented default, not a per-model fact —
  models with a lower real cap may error on very long outputs. No per-model column exists.
- `.bak` is single-generation: each successful write replaces the previous backup. A manual
  pre-feature copy exists at `opencode.json.manual-bak`.
- Lost-update window: a user editing the config in the milliseconds between our read and rename
  would have those edits overwritten (the window is one function call, every 2h).

---

## Fix plan

| # | Severity | Fix | Test |
|---|----------|-----|------|
| F1 | HIGH | try/catch + `.catch()` around the sync hook | test that a throwing listing doesn't reject the chain |
| F2 | MEDIUM | `hasOwnProperty` provider lookup | test `OPENCODE_PROVIDER_ID='__proto__'` skips safely |
| F3 | MEDIUM | skip unsafe ids (`__proto__`, `constructor`, `prototype`, `auto`) | test catalog model named `auto`/`__proto__` cannot clobber |
| F4 | LOW | remove stale tmp on failure | covered by code path review |
| F5 | LOW | skip-with-reason when `models` is a non-object | test array-shaped `models` bails out |

## Status

- [x] Review complete (2026-09-24)
- [x] Fixes implemented — see commit history after `742b7d6`
- [x] All tests + tsc + eslint green after fixes
- [x] Live re-verified: picker still lists 22 entries, server healthy
