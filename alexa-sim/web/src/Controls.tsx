import { useEffect, useId, useRef, useState } from 'react';
import { Check, Ellipsis, Inbox, Mic, MicOff, Send } from 'lucide-react';
import type { Language, ProfileId } from './api';
import { Avatar } from './HomeScreen';
import { DEVICES, isHindi, nameOf, PROFILES, SUGGESTIONS, type Device, type Item, type Prefs, type Ring, type Turn } from './model';

/* ---------- who is talking ---------- */

interface SwitcherProps {
  profile: ProfileId;
  /** Someone on the other device in Family view can't be picked here. */
  other: ProfileId | null;
  busy: Record<ProfileId, boolean>;
  onPick: (p: ProfileId) => void;
}

export function ProfileSwitcher({ profile, other, busy, onPick }: SwitcherProps) {
  return (
    <div className="people" role="radiogroup" aria-label="Who is speaking">
      {PROFILES.map(x => (
        <button
          key={x.id}
          type="button"
          role="radio"
          aria-checked={profile === x.id}
          className={`person${profile === x.id ? ' person-on' : ''}`}
          disabled={x.id === other}
          title={x.id === other ? `${x.name} is on the other device` : x.title}
          onClick={() => profile !== x.id && onPick(x.id)}
        >
          <Avatar profile={x.id} size="md" />
          <span className="person-text">
            <span className="person-name">
              {x.name}
              {busy[x.id] && <span className="person-busy" aria-label="busy" />}
            </span>
            <span className="person-role">{x.role}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------- what to suggest next ---------- */

const resultOf = (t: Turn | undefined, name: string) =>
  t?.items.find((i): i is Extract<Item, { kind: 'result' }> => i.kind === 'result' && i.result.name === name)?.result;

/** Chips that fit the moment: the person's usual lines, led by what follows from the last reply. */
export function suggestionsFor(p: ProfileId, lang: Language, turns: Turn[]): string[] {
  const base = SUGGESTIONS[p][lang];
  const last = turns.at(-1);
  const lead: string[] = [];
  if (lang === 'en') {
    const refills = resultOf(last, 'check_refills');
    if (refills && (refills.structuredContent?.alerts ?? []).some((a: any) => !a.order)) lead.push('Reorder it');
    if (resultOf(last, 'request_refill')?.structuredContent?.order?.status === 'placed') lead.push('Any updates?');
    if (last?.speech && p !== 'sam') lead.push('Say that again');
  }
  const said = new Set(turns.map(t => t.user.toLowerCase()));
  const rest = base.filter(s => !lead.includes(s) && !said.has(s.toLowerCase()));
  return [...lead, ...rest].slice(0, 4);
}

/* ---------- the control bar under a device ---------- */

interface BarProps {
  profile: ProfileId;
  index: number;
  lang: Language;
  ring: Ring;
  busy: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onSubmit: (text: string) => void;
  onTalk: () => void;
  canListen: boolean;
  suggestions: string[];
  device: Device;
  onDevice: (d: Device) => void;
  muted: boolean;
  onMute: () => void;
  onReset: () => void;
  onLanguage: (l: Language) => void;
  prefs: Prefs;
  onPrefs: (p: Prefs) => void;
  /** Rose can ask for her reminder now; it also comes by itself after a quiet spell. */
  onRemind?: () => void;
  remindHint?: string;
  inboxCount: number;
  onInbox: () => void;
}

export function ControlBar(props: BarProps) {
  const { profile, index, lang, ring, busy, draft, onDraft, onSubmit, onTalk, canListen, suggestions } = props;
  const listening = ring === 'listening';
  const micLabel = listening ? 'Stop listening' : `Push to talk as ${nameOf(profile)}`;
  return (
    <div className="controlbar-wrap">
      <form
        className={`controlbar talk-${ring}`}
        onSubmit={ev => {
          ev.preventDefault();
          onSubmit(draft);
        }}
      >
        <button
          type="button"
          className={`mic mic-${ring}`}
          onClick={onTalk}
          disabled={!canListen || busy}
          aria-label={micLabel}
          aria-pressed={listening}
          title={canListen ? `${micLabel} (${lang === 'hi' ? 'Hindi' : 'English'})` : 'Voice input needs Chrome or Edge; type instead'}
        >
          {canListen ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
        </button>
        <label className="sr-only" htmlFor={`say-${index}`}>
          What {nameOf(profile)} says
        </label>
        <input
          id={`say-${index}`}
          value={draft}
          onChange={e => onDraft(e.target.value)}
          placeholder={listening ? 'Listening…' : `Say something as ${nameOf(profile)}…`}
          autoComplete="off"
          disabled={busy}
          lang={lang === 'hi' ? 'hi' : undefined}
        />
        <button type="submit" className="icon-btn send" disabled={!draft.trim() || busy} aria-label="Send">
          <Send aria-hidden="true" />
        </button>
        <MoreMenu {...props} />
      </form>
      <div className="suggestions" aria-label="Try saying" hidden={!!draft || !suggestions.length}>
        {!draft &&
          suggestions.map(s => (
            <button key={s} type="button" className="suggestion" disabled={busy} onClick={() => onSubmit(s)} lang={isHindi(s) ? 'hi' : undefined}>
              {s}
            </button>
          ))}
      </div>
    </div>
  );
}

/* ---------- the "…" menu ---------- */

function MoreMenu({ profile, lang, busy, device, onDevice, muted, onMute, onReset, onLanguage, prefs, onPrefs, onRemind, remindHint, inboxCount, onInbox }: BarProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };

  return (
    <div className="more" ref={box}>
      <button ref={button} type="button" className="icon-btn more-btn" aria-label={`More for ${nameOf(profile)}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        <Ellipsis aria-hidden="true" />
        {inboxCount > 0 && <span className="more-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="menu" id={id} role="group" aria-label={`${nameOf(profile)}'s device settings`}>
          <p className="menu-label">Device</p>
          <div className="menu-seg" role="radiogroup" aria-label="Device">
            {DEVICES.map(d => (
              <button key={d.id} type="button" role="radio" aria-checked={device === d.id} title={d.hint} onClick={() => onDevice(d.id)}>
                {d.label}
              </button>
            ))}
          </div>
          <p className="menu-label">Language</p>
          <div className="menu-seg" role="radiogroup" aria-label="Language">
            {(['en', 'hi'] as const).map(l => (
              <button key={l} type="button" role="radio" aria-checked={lang === l} disabled={busy} onClick={() => lang !== l && onLanguage(l)}>
                {l === 'en' ? 'English' : 'हिंदी'}
              </button>
            ))}
          </div>
          <div className="menu-list">
            <Toggle label="Slower speech" on={prefs.slow} onChange={slow => onPrefs({ ...prefs, slow })} />
            <Toggle label="Large text" on={prefs.large} onChange={large => onPrefs({ ...prefs, large })} />
            <Toggle label="Sound" on={!muted} onChange={onMute} />
            {onRemind && (
              <button type="button" className="menu-item" title={remindHint} onClick={act(onRemind)}>
                Remind now
              </button>
            )}
            {inboxCount > 0 && (
              <button type="button" className="menu-item" onClick={act(onInbox)}>
                <Inbox aria-hidden="true" /> Inbox ({inboxCount})
              </button>
            )}
            <button type="button" className="menu-item" disabled={busy} onClick={act(onReset)} aria-label={`Start a new conversation for ${nameOf(profile)}`}>
              New chat
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="menu-item menu-toggle" onClick={() => onChange(!on)}>
      <span>{label}</span>
      <span className="switch" aria-hidden="true">
        {on && <Check />}
      </span>
    </button>
  );
}
