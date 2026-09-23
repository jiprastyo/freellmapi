import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { syncOpencodeConfig, opencodeSyncEnabled } from '../../lib/opencode-config.js';

// Realistic sample of the shape opencode writes: another provider carrying an
// apiKey, permissions and plugins at the root. The writer must leave all of it
// standing — the file holds credentials we did not put there.
const SAMPLE_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freellmapi-router": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:3001/v1" },
      "models": {
        "auto": { "name": "Auto (best available)", "limit": { "context": 200000, "output": 64000 } },
        "fusion": { "name": "Fusion" },
        "stale-paid-model": { "name": "Stale Paid Model" }
      }
    },
    "other": { "options": { "apiKey": "sk-must-survive" } }
  },
  "permissions": [ { "action": "shell", "resource": "rm -rf *", "effect": "ask" } ],
  "plugins": ["@tarquinen/opencode-dcp"]
}`;

function addModel(platform: string, modelId: string, displayName: string, priority: number, vision = 0): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 5, 5, 'Large', 100, NULL, NULL, NULL, '~10M', 131072, 1, ?, 1)
  `).run(platform, modelId, displayName, vision);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  return id;
}

function addKey(platform: string): void {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(`test-key-${platform}`);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, `${platform}-key`, encrypted, iv, authTag);
}

describe('syncOpencodeConfig (writes the free picker into opencode.json)', () => {
  let dir = '';
  let cfg = '';
  const OLD = { ...process.env };

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // Migrations seed 25 default models (6 on groq). Leaving them in place means
    // adding a groq key in a test also makes those seeds free+available, so
    // `count` stops being 1 and the assertions stop describing this module.
    // Wipe to an empty catalog first — same clearChain pattern the routing
    // tests use (fallback_config and profile_models both FK-reference models).
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocfg-'));
    cfg = path.join(dir, 'opencode.json');
  });

  afterEach(() => {
    process.env = { ...OLD };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: string) => fs.writeFileSync(cfg, content, 'utf8');
  const read = () => fs.readFileSync(cfg, 'utf8');
  const modelsOf = (raw: string) => (JSON.parse(raw) as any).provider['freellmapi-router'].models;

  it('is disabled unless OPENCODE_CONFIG_PATH is set (opt-in)', () => {
    delete process.env.OPENCODE_CONFIG_PATH;
    expect(opencodeSyncEnabled()).toBe(false);
    expect(syncOpencodeConfig()).toEqual({ enabled: false });
  });

  it('writes free+available models, keeps auto, drops fusion and stale entries', () => {
    process.env.OPENCODE_CONFIG_PATH = cfg;
    write(SAMPLE_CONFIG);

    addModel('groq', 'free-usable', 'Free Usable', 1, 1);
    addKey('groq');
    // Free platform but no key → not "free to be used", must not appear.
    // Keys are platform-wide, so this one must sit on a platform we did NOT
    // add a key for — putting it on groq would make it available too.
    addModel('mistral', 'free-keyless', 'Free Keyless', 2);
    // Paid platform with a key → must not appear.
    addModel('cohere', 'paid-model', 'Paid Model', 3);
    addKey('cohere');

    const res = syncOpencodeConfig();
    expect(res).toEqual({ enabled: true, written: true, count: 1 });

    const models = modelsOf(read());
    expect(models.auto).toEqual({ name: 'Auto (best available)', limit: { context: 200000, output: 64000 } });
    expect(Object.keys(models)).toEqual(['auto', 'free-usable']);
    expect(models.fusion).toBeUndefined();
    expect(models['stale-paid-model']).toBeUndefined();
    expect(models['free-keyless']).toBeUndefined();
    expect(models['paid-model']).toBeUndefined();

    expect(models['free-usable'].name).toBe('Free Usable');
    // `limit` MUST carry both context and output — opencode's schema marks them
    // required, and a partial limit makes it reject the whole provider.
    expect(models['free-usable'].limit).toEqual({ context: 131072, output: 32000 });
    // Legacy field names only: `capabilities` is not an allowed key here.
    expect(models['free-usable'].tool_call).toBe(true);
    expect(models['free-usable'].modalities).toEqual({
      input: ['text', 'image'], output: ['text'],
    });
    expect(models['free-usable'].capabilities).toBeUndefined();
  });

  it('drops a model from the picker once its platform stops being free', () => {
    process.env.OPENCODE_CONFIG_PATH = cfg;
    write(SAMPLE_CONFIG);
    addModel('cohere', 'was-free', 'Was Free', 1);
    addKey('cohere');

    // First pass: paid platform → nothing free to write → refuses to wipe.
    expect(syncOpencodeConfig()).toEqual({
      enabled: true, skipped: 'free+available list was empty — refusing to wipe the picker',
    });
    expect(read()).toBe(SAMPLE_CONFIG);
  });

  it('preserves other providers, apiKeys, permissions and plugins', () => {
    process.env.OPENCODE_CONFIG_PATH = cfg;
    write(SAMPLE_CONFIG);
    addModel('groq', 'free-usable', 'Free Usable', 1);
    addKey('groq');

    expect(syncOpencodeConfig().written).toBe(true);
    const after = read();

    const parsed = JSON.parse(after);
    expect(parsed.provider.other.options.apiKey).toBe('sk-must-survive');
    expect(parsed.permissions).toEqual([{ action: 'shell', resource: 'rm -rf *', effect: 'ask' }]);
    expect(parsed.plugins).toEqual(['@tarquinen/opencode-dcp']);
    expect(parsed['$schema']).toBe('https://opencode.ai/config.json');
    expect(parsed.provider['freellmapi-router'].npm).toBe('@ai-sdk/openai-compatible');
  });

  it('writes atomically and leaves a .bak of the previous file', () => {
    process.env.OPENCODE_CONFIG_PATH = cfg;
    write(SAMPLE_CONFIG);
    addModel('groq', 'free-usable', 'Free Usable', 1);
    addKey('groq');

    expect(syncOpencodeConfig().written).toBe(true);
    expect(fs.existsSync(`${cfg}.bak`)).toBe(true);
    expect(fs.readFileSync(`${cfg}.bak`, 'utf8')).toBe(SAMPLE_CONFIG);
    // No temp file left behind.
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp-'))).toEqual([]);
    expect(JSON.parse(read()).provider['freellmapi-router'].models['free-usable']).toBeTruthy();
  });

  it('skips when the result is unchanged, so opencode is not reloaded every tick', () => {
    process.env.OPENCODE_CONFIG_PATH = cfg;
    write(SAMPLE_CONFIG);
    addModel('groq', 'free-usable', 'Free Usable', 1);
    addKey('groq');

    expect(syncOpencodeConfig().written).toBe(true);
    const afterFirst = read();
    const second = syncOpencodeConfig();
    expect(second.written).toBe(false);
    expect(second.count).toBe(1);
    expect(read()).toBe(afterFirst);
    // Only one .bak — the first write's, still the pre-sync original.
    expect(fs.readFileSync(`${cfg}.bak`, 'utf8')).toBe(SAMPLE_CONFIG);
  });

  it('never overwrites an unparseable (JSONC) config', () => {
    process.env.OPENCODE_CONFIG_PATH = cfg;
    const jsonc = `{
  // keep my comment
  "provider": { "freellmapi-router": { "models": { "auto": {} } } }
}`;
    write(jsonc);
    addModel('groq', 'free-usable', 'Free Usable', 1);
    addKey('groq');

    const res = syncOpencodeConfig();
    expect(res.skipped).toContain('not plain JSON');
    expect(read()).toBe(jsonc);
  });

  it('skips when the file, provider block or models block is missing', () => {
    process.env.OPENCODE_CONFIG_PATH = path.join(dir, 'absent.json');
    expect(syncOpencodeConfig().skipped).toBe('config file not found');

    process.env.OPENCODE_CONFIG_PATH = cfg;
    write('{"provider":{}}');
    expect(syncOpencodeConfig().skipped).toBe('provider "freellmapi-router" not present in config');
    expect(read()).toBe('{"provider":{}}');

    write('{"hello":"world"}');
    expect(syncOpencodeConfig().skipped).toBe('no "provider" block');
    expect(read()).toBe('{"hello":"world"}');
  });

  it('honours OPENCODE_PROVIDER_ID instead of the default provider', () => {
    process.env.OPENCODE_CONFIG_PATH = cfg;
    process.env.OPENCODE_PROVIDER_ID = 'my-router';
    write(JSON.stringify({
      provider: { 'my-router': { models: { fusion: { name: 'Fusion' } } } },
    }, null, 2));
    addModel('groq', 'free-usable', 'Free Usable', 1);
    addKey('groq');

    expect(syncOpencodeConfig()).toEqual({ enabled: true, written: true, count: 1 });
    const parsed = JSON.parse(read());
    expect(Object.keys(parsed.provider['my-router'].models)).toEqual(['free-usable']);
    // fusion is dropped even when it is the only pre-existing entry.
    expect(parsed.provider['my-router'].models.fusion).toBeUndefined();
  });

  it('emits image input only for vision models', () => {
    process.env.OPENCODE_CONFIG_PATH = cfg;
    write(SAMPLE_CONFIG);
    addModel('groq', 'text-only', 'Text Only', 1, 0);
    addModel('cerebras', 'sees-image', 'Sees Image', 2, 1);
    addKey('groq');
    addKey('cerebras');

    expect(syncOpencodeConfig().written).toBe(true);
    const models = modelsOf(read());
    expect(models['text-only'].modalities.input).toEqual(['text']);
    expect(models['sees-image'].modalities.input).toEqual(['text', 'image']);
  });

  it('every emitted entry satisfies opencode\'s own ProviderConfig schema', () => {
    // Regression guard for a bug that shipped: emitting the V2 names
    // (`capabilities`) and a partial `limit` made opencode reject the WHOLE
    // provider ("skipped malformed recognized value") and the picker showed
    // zero freellmapi models. These two rules are verbatim from
    // https://opencode.ai/config.json → ProviderConfig.models.additionalProperties,
    // which sets additionalProperties:false and required:["context","output"]
    // on limit. `auto` is carried through verbatim, so it is covered too.
    const ALLOWED = new Set([
      'id', 'name', 'family', 'release_date', 'attachment', 'reasoning',
      'temperature', 'tool_call', 'interleaved', 'cost', 'limit', 'modalities',
      'experimental', 'status', 'provider', 'options', 'headers', 'variants',
    ]);

    process.env.OPENCODE_CONFIG_PATH = cfg;
    write(SAMPLE_CONFIG);
    addModel('groq', 'free-usable', 'Free Usable', 1, 1);
    addKey('groq');

    expect(syncOpencodeConfig().written).toBe(true);
    const models = modelsOf(read());
    expect(Object.keys(models).length).toBeGreaterThan(1);

    for (const [id, entry] of Object.entries(models) as [string, Record<string, unknown>][]) {
      const keys = Object.keys(entry);
      const unknown = keys.filter(k => !ALLOWED.has(k));
      expect(unknown, `model "${id}" has keys opencode will reject: ${unknown.join(', ')}`).toEqual([]);

      if (entry.limit !== undefined) {
        const limit = entry.limit as Record<string, unknown>;
        expect(typeof limit.context, `model "${id}" limit.context`).toBe('number');
        expect(typeof limit.output, `model "${id}" limit.output (required by schema)`).toBe('number');
      }
    }
  });
});
