/**
 * Hindi phrasing for spoken replies. Medicine names, strengths and people's names stay as
 * written (that's how they're said in Indian homes); everything around them is Hindi.
 * Alexa's voice is female, so first-person verbs use the feminine form (मैंने दर्ज कर ली).
 */
import type { Slot } from '../store/types.js';
import { daysBetween } from './time.js';

export const SLOT_HI: Record<Slot, string> = { morning: 'सुबह', noon: 'दोपहर', evening: 'शाम', night: 'रात' };

export function listJoinHi(items: string[], conjunction: 'और' | 'या' = 'और'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;
}

function period(h: number): string {
  if (h < 4) return 'रात';
  if (h < 12) return 'सुबह';
  if (h < 16) return 'दोपहर';
  if (h < 19) return 'शाम';
  return 'रात';
}

/** "20:00" -> "रात 8 बजे", "07:45" -> "सुबह 7 बजकर 45 मिनट". */
export function timeHi(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${period(h)} ${h12} बजे` : `${period(h)} ${h12} बजकर ${m} मिनट`;
}

const WEEKDAYS_HI = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
const MONTHS_HI = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];

/** आज, कल, परसों, or "गुरुवार, 8 अक्टूबर". Hindi uses कल for both yesterday and tomorrow. */
export function dateHi(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'आज';
  if (diff === 1 || diff === -1) return 'कल';
  if (diff === 2 || diff === -2) return 'परसों';
  const [y, m, d] = date.split('-').map(Number);
  const weekday = WEEKDAYS_HI[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return diff > 2 && diff < 7 ? weekday : `${weekday}, ${d} ${MONTHS_HI[m - 1]}`;
}

/** Red-flag labels from safetyCheck, in Hindi. */
export const REASON_HI: Record<string, string> = {
  'chest pain': 'सीने में दर्द',
  'breathing difficulty': 'साँस लेने में तकलीफ़',
  'a fall': 'गिरना',
  fainting: 'बेहोशी',
  'stroke signs': 'स्ट्रोक के लक्षण',
  'heavy bleeding': 'बहुत खून बहना',
  'possible medication error': 'दवा की गलती'
};

/** Visits: "Maya शाम 4 बजे आएंगी" (she) or "आएंगे" (he, they). */
export function willComeHi(pronoun: 'she' | 'he' | 'they' | undefined): string {
  return pronoun === 'she' ? 'आएंगी' : 'आएंगे';
}
