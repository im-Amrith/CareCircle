/**
 * Helpers for the speakable `content` text every tool returns. Alexa+ reads this
 * aloud on screenless devices, so it must be short, plain sentences: no Markdown,
 * no tables, no pipes, no URLs.
 */

export function listJoin(items: string[], conjunction: 'and' | 'or' = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export function countWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${countWord(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Removes characters that read badly aloud and collapses whitespace. */
export function voiceSafe(text: string): string {
  return text
    .replace(/[|*_#`>[\]]/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

export function sentences(...parts: (string | false | undefined | null)[]): string {
  return voiceSafe(parts.filter(Boolean).join(' '));
}

export function greeting(minutesSinceMidnight: number): string {
  if (minutesSinceMidnight < 12 * 60) return 'Good morning';
  if (minutesSinceMidnight < 17 * 60) return 'Good afternoon';
  return 'Good evening';
}
