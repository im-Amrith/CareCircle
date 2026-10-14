/** Speech in (Web Speech API, Chrome) and out (Polly MP3 from the orchestrator, else browser TTS). */

let current: HTMLAudioElement | null = null;

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? [];
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

/** Resolves when speaking ends (or immediately if speech is muted or unavailable). */
export function speak(text: string, audioBase64?: string, muted = false): Promise<void> {
  stopSpeaking();
  if (muted || !text) return Promise.resolve();
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
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.rate = 1;
    u.onend = u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
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
export function listenOnce(onInterim: (text: string) => void): { done: Promise<string>; stop: () => void } {
  const Ctor = recognitionCtor();
  if (!Ctor) return { done: Promise.reject(new Error('Speech recognition needs Chrome or Edge')), stop: () => undefined };
  const rec = new Ctor();
  rec.lang = 'en-IN';
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
