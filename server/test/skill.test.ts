import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, startServer } from './helpers.js';

const SKILL = readFileSync(resolve(import.meta.dirname, '../../skills/carecircle/SKILL.md'), 'utf8');

describe('Agent Skill (skills/carecircle/SKILL.md)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv.stop();
  });

  it('has Agent Skills front matter: a name matching its folder and a description', () => {
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(SKILL)?.[1] ?? '';
    expect(/^name: (.+)$/m.exec(front)?.[1]).toBe('carecircle');
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('names every tool the server offers, and the safety rules', async () => {
    const sam = await connect(srv.url, 'sam');
    const { tools } = await sam.listTools();
    for (const t of tools) expect(SKILL, `SKILL.md should cover ${t.name}`).toContain(`\`${t.name}\``);
    await sam.close();
    expect(SKILL).toMatch(/No medical advice/);
    expect(SKILL).toMatch(/Never read a URL aloud/);
    expect(SKILL).toMatch(/Bearer dev:<user>/);
  });
});
