import fs from 'node:fs';
import { buildModelListing } from '../services/model-listing.js';
import { isFreeToUseModel } from './free-platforms.js';

/**
 * opencode-config — keeps opencode's own model picker in step with this
 * install's free catalog.
 *
 * WHY THIS EXISTS. opencode does NOT call `GET /v1/models`. For a generic
 * OpenAI-compatible endpoint its docs are explicit: list the models yourself in
 * `opencode.json`. Auto-discovery is built in only for Ollama, LM Studio and
 * vLLM. So an opt-in `?free=true` on the endpoint can never reach opencode's
 * picker — the picker shows whatever is hardcoded in the config file, which
 * drifts into listing models that are no longer free (or no longer present)
 * within weeks.
 *
 * WHAT IT DOES. When OPENCODE_CONFIG_PATH is set, after every catalog sync we
 * rewrite exactly one key — `provider.<id>.models` — so the picker lists the
 * same models `GET /v1/models?free=true&available=true` would return: free
 * platform, AND an enabled key for this install means it is actually usable
 * ("free models AND free to be used"). `auto` is kept because it is the
 * router entry users select as a default; `fusion` and the `auto:<chain>`
 * aliases are dropped because they dispatch to whatever ranks best, a paid
 * platform included — same rule the endpoint applies.
 *
 * EVERYTHING ELSE IN THE FILE IS PRESERVED BYTE-FOR-BYTE in meaning: the other
 * providers, every apiKey, permissions, plugins. Only the one models map is
 * replaced. This matters because the file carries credentials for other
 * providers, so a bug here must not be able to lose them.
 *
 * SAFETY RAILS (each one exists because the alternative loses user data):
 *   - disabled entirely unless OPENCODE_CONFIG_PATH is set — opt-in, so the
 *     public repo changes nothing for anyone who did not ask for this;
 *   - JSONC / unparseable config → skip, never overwrite what we cannot read;
 *   - provider block absent → skip (we will not invent credentials);
 *   - empty result → skip (an empty list is far more likely a bug or a transient
 *     DB state than a real "zero free models" day — do not wipe on suspicion);
 *   - identical result → skip, so we do not churn the file and make opencode
 *     reload on every 2h tick;
 *   - `.bak` taken, then written via temp file + rename so a crash mid-write
 *     cannot leave a truncated config behind;
 *   - plain JSON only: a parse/mutate/stringify round-trip is used, which is
 *     lossless for every value but cannot represent comments — so JSONC input
 *     is refused rather than silently stripped.
 */

const AUTO_MODEL_ID = 'auto';

/** Free-to-use AND enabled here. `available` not `executionStatus==='ready'`: the
 *  latter flips on cooldowns and would make models blink in and out of the
 *  picker between syncs, while `available` only changes when keys do. */
function pickFreeUsable(): ReturnType<typeof buildModelListing>['models'] {
  return buildModelListing().models.filter(m => m.available === 1 && isFreeToUseModel(m));
}

export interface OpencodeSyncResult {
  /** false when the feature is not switched on for this install */
  enabled: boolean;
  /** set when we deliberately did not write, and why */
  skipped?: string;
  /** true only when the file was actually rewritten */
  written?: boolean;
  /** models written into the picker (excludes `auto`) */
  count?: number;
}

// opencode's schema for this (legacy `provider`, not `providers`) block is
// additionalProperties:false and only accepts the LEGACY model keys — see
// https://opencode.ai/config.json → ProviderConfig.models.additionalProperties.
// Two traps that were discovered the hard way by shipping the V2 names:
//   - `capabilities` is not an allowed key at all;
//   - `limit` declares required:["context","output"], so a partial limit is
//     "malformed". Either one makes opencode reject the WHOLE provider
//     (`kind=invalid action="skipped malformed recognized value"`) and the
//     picker then shows zero models for it.
interface ModelEntry {
  name?: string;
  tool_call?: boolean;
  modalities?: { input: string[]; output: string[] };
  limit?: { context: number; output: number };
}

// Nothing in this install knows a per-model output cap (there is no column for
// it), and `limit.output` is mandatory above — so emit opencode's own documented
// default for an unknown model rather than inventing 64k and provoking upstream
// 400s on models that actually cap lower.
const DEFAULT_OUTPUT_LIMIT = 32000;

export function syncOpencodeConfig(): OpencodeSyncResult {
  const configPath = process.env.OPENCODE_CONFIG_PATH?.trim();
  if (!configPath) return { enabled: false };

  const providerId = process.env.OPENCODE_PROVIDER_ID?.trim() || 'freellmapi-router';

  let raw: string;
  try {
    // Reads as text, not JSON.parse directly: we must distinguish "missing
    // file" (nothing to do) from "unparseable file" (must not touch).
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { enabled: true, skipped: 'config file not found' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // opencode.jsonc allows comments; JSON.parse cannot read those. Overwriting
    // it would delete the user's comments, so leave it alone.
    return { enabled: true, skipped: 'config is not plain JSON (JSONC?) — left untouched' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { enabled: true, skipped: 'config root is not an object' };
  }

  const root = parsed as Record<string, unknown>;
  const providers = root.provider;
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return { enabled: true, skipped: `no "provider" block` };
  }
  // Own-property lookup only: a bracket access with a key like `__proto__`
  // would hand back Object.prototype, which passes the object shape guard and
  // would then get `models` assigned onto the prototype of every object.
  const hasProvider = Object.prototype.hasOwnProperty.call(providers, providerId);
  const provider = hasProvider ? (providers as Record<string, unknown>)[providerId] : undefined;
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
    // Creating this block would mean also writing apiKey/baseURL/npm, which we
    // would be guessing. The provider is expected to already exist.
    return { enabled: true, skipped: `provider "${providerId}" not present in config` };
  }

  const providerObj = provider as Record<string, unknown>;
  if (providerObj.models !== undefined &&
      (typeof providerObj.models !== 'object' || providerObj.models === null || Array.isArray(providerObj.models))) {
    // An array/other non-object here is invalid for opencode too. Rewriting it
    // would silently discard whatever the user had — including `auto`, their
    // configured default model — so refuse instead of "fixing" the shape.
    return { enabled: true, skipped: 'provider "models" block is not an object — left untouched' };
  }
  const existingModels = (typeof providerObj.models === 'object' && providerObj.models !== null && !Array.isArray(providerObj.models))
    ? providerObj.models as Record<string, unknown>
    : {};
  const existingAuto = existingModels[AUTO_MODEL_ID];

  const freeUsable = pickFreeUsable();
  if (freeUsable.length === 0) {
    return { enabled: true, skipped: 'free+available list was empty — refusing to wipe the picker' };
  }

  // Rebuild rather than merge: a merge would let a model that stopped being
  // free linger forever. `auto` alone is carried across so the configured
  // default (freellmapi-router/auto) keeps resolving.
  const models: Record<string, ModelEntry> = {};
  if (existingAuto !== undefined) models[AUTO_MODEL_ID] = existingAuto as ModelEntry;

  // Model ids come from the REMOTE catalog. Two hazards as object keys:
  //   - `__proto__`/`constructor`/`prototype` would set the prototype of the
  //     map instead of adding a key (the model would silently vanish from the
  //     serialized output);
  //   - a catalog model literally named `auto` would overwrite the user's
  //     verbatim `auto` entry carried across above.
  // The catalog is signed, but the guard is two lines and removes the class.
  const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
  let written = 0;

  for (const m of freeUsable) {
    if (UNSAFE_IDS.has(m.id) || m.id === AUTO_MODEL_ID) continue;
    const entry: ModelEntry = { name: m.name };
    // Legacy names for what V2 calls capabilities.tools / capabilities.input.
    entry.tool_call = m.supportsTools;
    entry.modalities = {
      input: m.supportsVision ? ['text', 'image'] : ['text'],
      output: ['text'],
    };
    if (m.contextWindow != null) entry.limit = { context: m.contextWindow, output: DEFAULT_OUTPUT_LIMIT };
    models[m.id] = entry;
    written++;
  }

  // If every candidate id was unsafe (pathological), refuse to write rather
  // than emit a picker stripped of every real model — same spirit as the
  // empty-list rail. (`models` may still hold the carried-over `auto`, so the
  // test is on how many NEW entries were written, not on the map size.)
  if (written === 0) {
    return { enabled: true, skipped: 'no safe model ids in the free+available list — refusing to write' };
  }

  // Compare against what is already there so an unchanged result does not
  // rewrite the file (a rewrite makes opencode reload on every 2h tick for no
  // reason). Both sides come from parsed objects, so formatting style cannot
  // make them differ spuriously.
  if (JSON.stringify(existingModels, null, 2) === JSON.stringify(models, null, 2)) {
    // `written` (not freeUsable.length): the count must describe the file, and
    // with unsafe ids filtered out freeUsable can be larger than the map.
    return { enabled: true, written: false, count: written };
  }

  // Replace only this provider's models map, then re-serialize the document we
  // already parsed above. JSON.parse succeeded, so the file is plain JSON —
  // there are no comments to destroy (JSONC bails out earlier) and a
  // parse/mutate/stringify round-trip keeps every other value exactly: the
  // other providers, their apiKeys, permissions, plugins. Only whitespace style
  // may be normalised to two-space indent, which opencode reads back fine.
  providerObj.models = models;

  let tmp: string | undefined;
  try {
    // .bak first: this file holds other providers' API keys.
    fs.copyFileSync(configPath, `${configPath}.bak`);
    tmp = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (err) {
    // Do not leave a stale .tmp-<pid> behind on a failed write.
    if (tmp !== undefined) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } }
    const message = err instanceof Error ? err.message : String(err);
    return { enabled: true, skipped: `write failed: ${message}` };
  }

  return { enabled: true, written: true, count: written };
}

/** Test seam: does this install have the feature switched on? */
export function opencodeSyncEnabled(): boolean {
  return Boolean(process.env.OPENCODE_CONFIG_PATH?.trim());
}
