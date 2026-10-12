import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, connect, said, startServer } from './helpers.js';

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => {
  await srv.stop();
});

describe('MCP surface', () => {
  it('negotiates 2025-11-25 and lists tools with schemas and annotations', async () => {
    const c = await connect(srv.url, 'sam');
    expect(c.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(c.getServerVersion()?.name).toBe('carecircle-mcp');
    expect(c.getInstructions()).toContain('never gives medical advice');
    const { tools } = await c.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['check_refills', 'get_care_status', 'list_medications', 'log_medication', 'log_wellbeing', 'request_refill']);
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(40);
      expect(t.outputSchema).toBeDefined();
      expect(t.annotations).toBeDefined();
    }
    expect(tools.find(t => t.name === 'get_care_status')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(t => t.name === 'log_medication')?.annotations?.idempotentHint).toBe(true);
    await c.close();
  });

  it('uses only single-type JSON Schema nodes, for portable tool schemas', async () => {
    const c = await connect(srv.url, 'sam');
    const { tools } = await c.listTools();
    const arrayTypes: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray((node as { type?: unknown }).type)) arrayTypes.push(path);
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    };
    for (const t of tools) {
      walk(t.inputSchema, `${t.name}.input`);
      walk(t.outputSchema, `${t.name}.output`);
    }
    expect(arrayTypes).toEqual([]);
    await c.close();
  });

  it('exposes the care plan and daily log resources, scoped to the family', async () => {
    const c = await connect(srv.url, 'maya');
    const { resources } = await c.listResources();
    expect(resources.map(r => r.uri)).toEqual(['carecircle://family/fam-rose/care-plan']);
    const { resourceTemplates } = await c.listResourceTemplates();
    expect(resourceTemplates.map(t => t.uriTemplate).sort()).toEqual([
      'carecircle://family/{familyId}/care-plan',
      'carecircle://family/{familyId}/log/{date}'
    ]);
    const plan = await c.readResource({ uri: 'carecircle://family/fam-rose/care-plan' });
    expect((plan.contents[0] as { text: string }).text).toContain('Amlodipine 5 mg');
    const log = await c.readResource({ uri: 'carecircle://family/fam-rose/log/2026-10-09' });
    expect(JSON.parse((log.contents[0] as { text: string }).text).doses).toHaveLength(5);
    await expect(c.readResource({ uri: 'carecircle://family/fam-other/care-plan' })).rejects.toThrow();
    await c.close();
  });

  it('offers prompts', async () => {
    const c = await connect(srv.url, 'rose');
    const { prompts } = await c.listPrompts();
    expect(prompts.map(p => p.name).sort()).toEqual(['caregiver_handoff', 'morning_briefing']);
    const p = await c.getPrompt({ name: 'morning_briefing' });
    expect(JSON.stringify(p.messages)).toContain('Rose, speaking to her directly');
    const h = await c.getPrompt({ name: 'caregiver_handoff', arguments: { helper: 'Maya' } });
    expect(JSON.stringify(h.messages)).toContain('handoff for Maya');
    await c.close();
  });
});

describe('demo journeys at 9 am', () => {
  it('journey 1: Rose gets a morning check-in', async () => {
    const rose = await connect(srv.url, 'rose');
    const r = await call(rose, 'get_care_status');
    expect(r.isError).toBeFalsy();
    expect(said(r)).toMatch(/^Good morning, Rose\./);
    expect(said(r)).toContain('Metformin and Vitamin D3 are due now');
    expect(said(r)).toContain('Maya visits at 4 pm');
    expect(r.structuredContent?.counts).toMatchObject({ total: 5, due: 2, upcoming: 3, taken: 0 });
    await rose.close();
  });

  it('journey 2: "I took my morning pills" logs both, once', async () => {
    const rose = await connect(srv.url, 'rose');
    const first = await call(rose, 'log_medication', { spoken_name: 'my morning pills' });
    expect(first.structuredContent?.result).toBe('logged');
    expect(first.structuredContent?.logged.map((l: { name: string }) => l.name).sort()).toEqual(['Metformin', 'Vitamin D3']);
    expect(said(first)).toContain("I've logged Metformin and Vitamin D3");
    expect(said(first)).toContain('Next is');
    expect(srv.store.medications.get('med-metformin')?.pillsOnHand).toBe(45);

    const again = await call(rose, 'log_medication', { spoken_name: 'my pills', slot: 'morning' });
    expect(again.structuredContent?.result).toBe('already_logged');
    expect(srv.store.medications.get('med-metformin')?.pillsOnHand).toBe(45);
    await rose.close();
  });

  it('asks which medicine when a name is ambiguous', async () => {
    const rose = await connect(srv.url, 'rose');
    const r = await call(rose, 'log_medication', { spoken_name: 'the sugar one or vit d' });
    expect(r.structuredContent?.result).toBe('needs_clarification');
    expect(r.structuredContent?.options).toHaveLength(2);
    expect(said(r)).toMatch(/^Did you mean .+ or .+\?$/);
    await rose.close();
  });

  it('journey 3: Sam sees Rose\'s progress from another session', async () => {
    const sam = await connect(srv.url, 'sam');
    const r = await call(sam, 'get_care_status', { detail: 'full' });
    expect(r.structuredContent?.counts.taken).toBe(2);
    expect(said(r)).toMatch(/^Rose has taken two of her five doses so far today\./);
    expect(said(r)).toContain('She mentioned: slept badly last night');
    expect(said(r)).toContain('Amlodipine runs low');
    expect(said(r)).toContain('In the past week, one dose was missed');
    expect(r.structuredContent?.refillAlerts[0].medicationId).toBe('med-amlodipine');
    await sam.close();
  });

  it('refill check and evening schedule speak plainly', async () => {
    const sam = await connect(srv.url, 'sam');
    const refills = await call(sam, 'check_refills');
    expect(said(refills)).toContain('Amlodipine 5 mg has about three days left, enough until Monday');
    const evening = await call(sam, 'list_medications', { when: 'evening' });
    expect(said(evening)).toMatch(/^This evening at 8 pm, Rose takes /);
    await sam.close();
  });

  it('journey 7: a fall gets safety guidance and is flagged for family', async () => {
    const rose = await connect(srv.url, 'rose');
    const r = await call(rose, 'log_wellbeing', { note: 'I had a fall in the kitchen' });
    expect(r.structuredContent).toMatchObject({ redFlag: true, severity: 'high' });
    expect(said(r)).toContain('call emergency services');
    expect(said(r)).toContain('Sam and Maya will see this note');
    await rose.close();
  });

  it('every spoken reply is voice-safe and short', async () => {
    const sam = await connect(srv.url, 'sam');
    for (const [name, args] of [
      ['get_care_status', {}],
      ['list_medications', {}],
      ['check_refills', {}]
    ] as const) {
      const text = said(await call(sam, name, args));
      expect(text).not.toMatch(/[|*#`]|https?:/);
      expect(text.split(/\s+/).length).toBeLessThan(70);
    }
    await sam.close();
  });

  it('unknown users get a spoken error, not a crash', async () => {
    const stranger = await connect(srv.url, 'nobody');
    const r = await call(stranger, 'get_care_status');
    expect(r.isError).toBe(true);
    expect(said(r)).toContain("couldn't find your CareCircle account");
    await stranger.close();
  });
});
