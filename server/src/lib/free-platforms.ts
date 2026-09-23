import type { Platform } from '@freellmapi/shared/types.js';

/**
 * Platforms that are free to use: no payment method is required and the free
 * allowance is recurring (or the API is genuinely free, as with AI Horde and
 * OVH's anonymous tier). Backs the opt-in `?free=true` filter on
 * `GET /v1/models` (#free-models), so an agent like opencode can list only
 * models it can actually run without spending money.
 *
 * This is a CURATED allowlist, not a derivation: the bundle has no
 * machine-readable "requires payment" flag on a provider, and the closest
 * signal — the `monthly_token_budget` label — is documented budget, not
 * price. `'credits-based'` in particular means credits are *granted* free, so
 * it is not a reliable "costs money" marker either. Keeping one reviewed set
 * here beats recomputing it from prose.
 *
 * Deliberately EXCLUDED (need a card, prepaid credits, or Chinese real-name
 * verification before a key serves traffic — see the Platform comments in
 * shared/types.ts for each):
 *   sail, moondream, nvidia, cohere, baseten, reka, modelscope, qianfan,
 *   volcengine, xfyun, sambanova (free tier retired), and the catalog-managed
 *   gateways whose free allowance is not no-card/neutral (bai, aclide, ...).
 *
 * CAVEAT worth reviewing when this list is touched: OpenRouter, GitHub Models,
 * Mistral and Cloudflare Workers AI have paid tiers UNDER their free one. They
 * are free to start with no card, but individual rows on those platforms can
 * consume paid credit. They are included because the stated intent is
 * "provider makes it free to use at no cost" — remove them here if the intent
 * narrows to "cannot cost money under any circumstance".
 */
export const FREE_TO_USE_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>([
  // First-party providers with recurring no-card free tiers.
  'google',      // AI Studio free tier, no card
  'groq',        // free tier, no card
  'cerebras',    // free tier, no card
  'mistral',     // free tier, no card (la plateforme)
  'cloudflare',  // Workers AI free daily allocation
  'github',      // GitHub Models free usage allowance
  'openrouter',  // `:free` model variants at $0
  'zhipu',       // GLM free tier
  // Gateways / aggregators whose free routes are $0 with no card.
  'kilo',
  'llm7',
  'pollinations',
  'anyapi',      // $0, no card, recurring — capped at 100K tokens/day
  'radeon',      // AMD Radeon Cloud public-model roster, free w/o credits
  // Genuinely free, no account money at all.
  'ovh',         // keyless anonymous tier (2 req/min/IP)
  'aihorde',     // community-powered, kudos not tokens
]);

/**
 * A model counts as "free to be used" only when EVERY platform that could
 * serve it is on the allowlist.
 *
 * Under unify, a group's `platforms` are its members and the router may pick
 * any of them, so testing all members (rather than `ownedBy` alone) is what
 * makes a group with mixed free and paid members fall out instead of leaking a
 * paid route through. Under unify-off it is the single owning platform.
 *
 * Single source of truth for both `GET /v1/models?free=true` and the opencode
 * config writer (lib/opencode-config.ts) — if those two ever disagreed, the
 * picker would promise models the endpoint refuses to list.
 */
export function isFreeToUseModel(model: { platforms: string[] }): boolean {
  return model.platforms.length > 0 && model.platforms.every(p => FREE_TO_USE_PLATFORMS.has(p as Platform));
}
