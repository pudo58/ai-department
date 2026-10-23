import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_MODELS, codexModels } from '../src/runtime/agentclis.js';

describe('model lists for the role picker', () => {
  it('reads the Codex account models from models_cache.json in Codex order, without hidden ones', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'aidept-codex-'));
    writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-old', display_name: 'GPT-Old', description: 'Older model.', visibility: 'list', priority: 9 },
      { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
      { slug: 'gpt-new', display_name: 'GPT-New', description: 'Latest workhorse.', visibility: 'list', priority: 1 },
    ] }));
    expect(await codexModels(home)).toEqual([
      { id: 'gpt-new', label: 'GPT-New', hint: 'Latest workhorse.' },
      { id: 'gpt-old', label: 'GPT-Old', hint: 'Older model.' },
    ]);
  });

  it('is empty, not an error, before Codex has fetched its list', async () => {
    expect(await codexModels(mkdtempSync(path.join(tmpdir(), 'aidept-codex-')))).toEqual([]);
  });

  it('offers Claude aliases first, then pinned versions', () => {
    expect(CLAUDE_MODELS.slice(0, 3).map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet']);
    expect(CLAUDE_MODELS.some((m) => m.id === 'claude-opus-5-5')).toBe(true);
  });
});
