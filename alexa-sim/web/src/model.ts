import type { Elicitation, Language, ProfileId, Speech, ToolCall, ToolResult, Warning } from './api';

/* Shared shapes and fixed content for the simulator UI. */

export type Device = 'show8' | 'show15' | 'dot' | 'phone';
export type Ring = 'idle' | 'listening' | 'thinking' | 'speaking' | 'notify';
export type Layout = 'single' | 'family';

export type Item =
  | { kind: 'call'; call: ToolCall }
  | { kind: 'result'; result: ToolResult }
  | { kind: 'elicitation'; e: Elicitation }
  | { kind: 'warning'; w: Warning };

export interface Turn {
  id: number;
  user: string;
  items: Item[];
  speech?: Speech;
  error?: string;
  pending: boolean;
  /** Last protocol seq seen when the turn started; the protocol panel groups messages by it. */
  startSeq: number;
}

/** Something on the device that nobody asked for: a family alert, a dose reminder, a new summary. */
export interface Notice {
  id: string;
  kind: 'alert' | 'reminder' | 'message';
  title: string;
  text: string;
}

/** Per-person accessibility settings, kept on the device. */
export interface Prefs {
  slow: boolean;
  large: boolean;
}

export interface Pane {
  profile: ProfileId;
  device: Device;
}

export const PROFILES: { id: ProfileId; name: string; role: string; title: string }[] = [
  { id: 'rose', name: 'Rose', role: 'Mom', title: 'cared for' },
  { id: 'sam', name: 'Sam', role: 'Son', title: 'son, coordinator' },
  { id: 'maya', name: 'Maya', role: 'Daughter', title: 'daughter, helper' }
];
export const nameOf = (p: ProfileId) => PROFILES.find(x => x.id === p)!.name;
export const roleOf = (p: ProfileId) => PROFILES.find(x => x.id === p)!.role;

export const DEVICES: { id: Device; label: string; hint: string }[] = [
  { id: 'show8', label: 'Show 8', hint: '8-inch smart display, landscape' },
  { id: 'show15', label: 'Show 15', hint: '15-inch smart display, wall-mounted' },
  { id: 'dot', label: 'Dot', hint: 'Smart speaker, no screen' },
  { id: 'phone', label: 'Phone', hint: 'Phone app' }
];

/** The demo family lives in India; the server's frozen clock is shown in their time zone. */
export const FAMILY_TZ = 'Asia/Kolkata';

export const SUGGESTIONS: Record<ProfileId, Record<Language, string[]>> = {
  rose: {
    en: ['Good morning', 'I took my morning pills', 'I had a fall in the kitchen', 'Should I take an extra blood pressure tablet?', 'What do I take tonight?', 'Say that again', 'Talk to me in Hindi'],
    hi: ['सुप्रभात', 'मैंने दवा ले ली', 'मैं रसोई में गिर गई', 'एक और गोली ले लूँ?', 'आज रात कौन सी दवा लेनी है', 'फिर से बोलो', 'Speak English']
  },
  sam: {
    en: ['How is Mom today?', 'Is she running low on anything?', 'Reorder it', 'Any updates?', 'Send everyone today’s summary'],
    hi: ['माँ का आज का हाल कैसा है', 'दवाई खत्म हो रही है क्या?', 'Speak English']
  },
  maya: {
    en: ['How is Mom today?', 'What does Mom take tonight?', 'Mom says her knee hurts', 'Say that again'],
    hi: ['माँ का आज का हाल कैसा है', 'Speak English']
  }
};

export const TOOL_LABEL: Record<string, string> = {
  get_care_status: 'Checking today’s care status…',
  list_medications: 'Looking up the medicine schedule…',
  log_medication: 'Logging the dose…',
  check_refills: 'Checking supplies…',
  request_refill: 'Starting a refill…',
  log_wellbeing: 'Adding a note…',
  set_language: 'Changing the language…',
  send_daily_summary: 'Sending today’s summary…'
};

export const isHindi = (text: string) => /[ऀ-ॿ]/.test(text);
