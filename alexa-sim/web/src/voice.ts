/** Speech in (Web Speech API, Chrome) and out (Polly MP3 from the orchestrator, else browser TTS). */

import type { Language } from './api';

let current: HTMLAudioElement | null = null;
/** Resolves when whatever is speaking now has finished. Announcements wait on it. */
let speaking: Promise<void> = Promise.resolve();

export interface SpeakOptions {
  muted?: boolean;
  lang?: Language;
  /** Slower speech for older listeners. Polly audio already carries it; this is for browser speech. */
  slow?: boolean;
}

function pickVoice(lang: Language): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  if (lang === 'hi') return voices.find(v => v.lang === 'hi-IN') ?? voices.find(v => v.lang.startsWith('hi'));
  return (
    voices.find(v => v.lang === 'en-IN') ??
    voices.find(v => /female|samantha|zira|jenny|aria/i.test(v.name) && v.lang.startsWith('en')) ??
    voices.find(v => v.lang.startsWith('en'))
  );
}

export function stopSpeaking() {
  current?.pause();
  current = null;
  window.speechSynthesis?.cancel();
}

function play(text: string, audioBase64: string | undefined, opts: SpeakOptions): Promise<void> {
  if (opts.muted || !text) return Promise.resolve();
  if (audioBase64) {
    return new Promise(resolve => {
      const audio = new Audio(`data:audio/mpeg;base64,${audioBase64}`);
      current = audio;
      audio.onended = audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
  }
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise(resolve => {
    const lang = opts.lang ?? 'en';
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
    u.rate = opts.slow ? 0.85 : 1;
    u.onend = u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

/** Speaks a reply, cutting off anything still speaking. Resolves when it ends (or at once if muted). */
export function speak(text: string, audioBase64?: string, opts: SpeakOptions = {}): Promise<void> {
  stopSpeaking();
  speaking = play(text, audioBase64, opts);
  return speaking;
}

/** Speaks an announcement after whatever is speaking now, the way an Echo waits to chime in. */
export function announce(text: string, audioBase64?: string, opts: SpeakOptions = {}): Promise<void> {
  speaking = speaking.then(() => play(text, audioBase64, opts));
  return speaking;
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => Recognition) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const canListen = () => !!recognitionCtor();

/** Listens for one utterance. Calls onInterim while speaking; resolves with the final text ('' if nothing heard). */
export function listenOnce(onInterim: (text: string) => void, lang: Language = 'en'): { done: Promise<string>; stop: () => void } {
  const Ctor = recognitionCtor();
  if (!Ctor) return { done: Promise.reject(new Error('Speech recognition needs Chrome or Edge')), stop: () => undefined };
  const rec = new Ctor();
  rec.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  const done = new Promise<string>((resolve, reject) => {
    rec.onresult = e => {
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterim((finalText + interim).trim());
    };
    rec.onerror = e => (e.error === 'no-speech' || e.error === 'aborted' ? resolve('') : reject(new Error(`Microphone: ${e.error}`)));
    rec.onend = () => resolve(finalText.trim());
  });
  rec.start();
  return { done, stop: () => rec.stop() };
}
