import { describe, expect, it } from 'vitest';
import {
  doseStates,
  isGenericPhrase,
  matchMedication,
  refillAlerts,
  safetyCheck,
  slotToLog
} from '../src/domain/care.js';
import { addDays, localParts, spokenTime, zonedToUtc } from '../src/domain/time.js';
import { voiceSafe } from '../src/domain/speech.js';
import { NINE_AM_IST, seededStore } from './helpers.js';

const store = seededStore();
const family = store.families.get('fam-rose')!;
const meds = [...store.medications.values()];
const today = '2026-10-10';

describe('time helpers', () => {
  it('converts wall-clock IST to UTC and back', () => {
    const utc = zonedToUtc('2026-10-10', '09:00', 'Asia/Kolkata');
    expect(utc.toISOString()).toBe(NINE_AM_IST.replace('Z', '.000Z'));
    expect(localParts(utc, 'Asia/Kolkata')).toMatchObject({ date: '2026-10-10', time: '09:00', minutes: 540 });
  });

  it('handles daylight saving time zones', () => {
    // New York switches to EDT on 2026-03-08 at 02:00.
    expect(zonedToUtc('2026-03-08', '12:00', 'America/New_York').toISOString()).toBe('2026-03-08T16:00:00.000Z');
    expect(zonedToUtc('2026-03-07', '12:00', 'America/New_York').toISOString()).toBe('2026-03-07T17:00:00.000Z');
  });

  it('speaks times naturally', () => {
    expect(spokenTime('20:00')).toBe('8 pm');
    expect(spokenTime('07:45')).toBe('7:45 am');
    expect(spokenTime('12:00')).toBe('noon');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('dose states', () => {
  it('at 9 am the morning doses are due and the rest upcoming', () => {
    const states = doseStates(family, meds, [], today, new Date(NINE_AM_IST));
    const morning = states.filter(s => s.slot === 'morning');
    expect(morning.map(s => s.name).sort()).toEqual(['Metformin', 'Vitamin D3']);
    expect(morning.every(s => s.status === 'due')).toBe(true);
    expect(states.filter(s => s.slot !== 'morning').every(s => s.status === 'upcoming')).toBe(true);
  });

  it('marks an untaken morning dose missed after 11 am', () => {
    const noon = zonedToUtc(today, '12:00', 'Asia/Kolkata');
    const states = doseStates(family, meds, [], today, noon);
    expect(states.filter(s => s.slot === 'morning').every(s => s.status === 'missed')).toBe(true);
    expect(slotToLog(states, family, noon)).toBe('morning');
  });

  it('seeded history has exactly the two planned misses', async () => {
    const from = addDays(today, -14);
    const logs = await store.listDoseLogs('fam-rose', from, addDays(today, -1));
    let missed = 0;
    for (let i = 1; i <= 14; i++) {
      missed += doseStates(family, meds, logs, addDays(today, -i), new Date(NINE_AM_IST)).filter(s => s.status === 'missed').length;
    }
    expect(missed).toBe(2);
  });
});

describe('refills', () => {
  it('flags amlodipine with three days left', () => {
    const alerts = refillAlerts(meds, today);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ medicationId: 'med-amlodipine', daysLeft: 3, runsOutOn: '2026-10-12' });
  });
});

describe('spoken medicine names', () => {
  it('matches aliases and purposes', () => {
    expect(matchMedication(meds, 'my blood pressure tablet').matches.map(m => m.id)).toEqual(['med-amlodipine']);
    expect(matchMedication(meds, 'the vitamin').matches.map(m => m.id)).toEqual(['med-vitd']);
    expect(matchMedication(meds, 'Metformin').kind).toBe('single');
  });

  it('reports ambiguity and no-match', () => {
    const r = matchMedication(meds, 'the sugar one or vit d');
    expect(r.kind).toBe('ambiguous');
    expect(r.matches.map(m => m.id).sort()).toEqual(['med-metformin', 'med-vitd']);
    expect(matchMedication(meds, 'aspirin').kind).toBe('none');
  });

  it('treats "my pills" as generic', () => {
    expect(isGenericPhrase('my morning pills')).toBe(true);
    expect(isGenericPhrase('her morning pills')).toBe(true);
    expect(isGenericPhrase('the vitamin')).toBe(false);
  });
});

describe('safety check', () => {
  it.each([
    ['I had a fall in the bathroom', 'a fall'],
    ["I can't breathe properly", 'breathing difficulty'],
    ['my chest feels tight', 'chest pain'],
    ['I think I took too many tablets', 'possible medication error']
  ])('flags "%s"', (note, reason) => {
    const r = safetyCheck(note);
    expect(r.redFlag).toBe(true);
    expect(r.reasons).toContain(reason);
  });

  it('does not flag ordinary notes', () => {
    expect(safetyCheck('Slept badly last night').redFlag).toBe(false);
    expect(safetyCheck('knee is a bit stiff').redFlag).toBe(false);
  });
});

describe('voice safety', () => {
  it('strips characters that read badly aloud', () => {
    expect(voiceSafe('Taken | **twice** see https://x.y/z .')).toBe('Taken twice see.');
  });
});
