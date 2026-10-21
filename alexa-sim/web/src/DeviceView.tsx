import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { BellRing, MessageSquareText, TriangleAlert, X } from 'lucide-react';
import type { Elicitation, Language, ProfileId, Today } from './api';
import { Avatar, HomeScreen, timeOf, useFamilyClock } from './HomeScreen';
import { isHindi, nameOf, roleOf, SUGGESTIONS, type Item, type Notice, type Pane, type Prefs, type Ring, type Turn } from './model';

export interface DeviceViewProps {
  pane: Pane;
  turns: Turn[];
  ring: Ring;
  interim: string;
  notices: Notice[];
  prefs: Prefs;
  lang: Language;
  live: Today | null;
  connected: boolean;
  /** Set for a moment after the person changes, so the video shows someone else is talking now. */
  switchingTo: ProfileId | null;
  /** One item of a turn: the invoking line, a card, an MCP App view, a question or a warning. */
  renderItem: (t: Turn, it: Item, i: number) => ReactNode;
  /** An open question shown on the companion phone of a Dot. */
  companionQuestions: (turns: Turn[]) => { e: Elicitation; node: ReactNode }[];
  onDismissNotice: (id: string) => void;
}

/**
 * Keeps the newest exchange in view: the bottom of the conversation, unless that would push the
 * start of the newest reply off the top; then the reply's first line sits at the top and its card
 * is a scroll away. Re-applied when anything inside resizes (an MCP App view loading, a dialog
 * folding up), until the person scrolls by hand.
 */
function usePinnedConversation(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const pin = useCallback(() => {
    const el = ref.current;
    if (!el || userScrolled.current) return;
    const bottom = el.scrollHeight - el.clientHeight;
    // The reply, or before there is one, an open question waiting for an answer.
    const lead = el.querySelector<HTMLElement>('.turn-now .said-alexa') ?? el.querySelector<HTMLElement>('.turn-now .dialog-open');
    // Measured on screen, not with offsetTop, which Large text's CSS zoom throws off.
    const leadTop = lead ? el.scrollTop + lead.getBoundingClientRect().top - el.getBoundingClientRect().top : Infinity;
    // Clear of the fade along the top edge.
    el.scrollTop = Math.min(bottom, leadTop - 56);
  }, []);

  useLayoutEffect(() => {
    userScrolled.current = false;
    pin();
  }, [key, pin]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => pin());
    for (const child of el.children) ro.observe(child);
    const byHand = () => {
      userScrolled.current = true;
    };
    el.addEventListener('wheel', byHand, { passive: true });
    el.addEventListener('touchmove', byHand, { passive: true });
    el.addEventListener('keydown', byHand);
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', byHand);
      el.removeEventListener('touchmove', byHand);
      el.removeEventListener('keydown', byHand);
    };
  }, [key, pin]);

  return ref;
}

const NOTICE_ICON = { alert: TriangleAlert, reminder: BellRing, message: MessageSquareText };

function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: string) => void }) {
  if (!notices.length) return null;
  return (
    <div className="notices" role="region" aria-label="Notifications">
      {notices.map(n => {
        const Icon = NOTICE_ICON[n.kind];
        return (
          <div key={n.id} className={`notice notice-${n.kind}`} role={n.kind === 'alert' ? 'alert' : 'status'}>
            <Icon className="notice-icon" aria-hidden="true" />
            <div className="notice-content">
              <strong className="notice-title">{n.kind === 'message' ? `Message · ${n.title}` : n.title}</strong>
              <p className={n.kind === 'message' ? 'notice-text notice-pre' : 'notice-text'} lang={isHindi(n.text) ? 'hi' : undefined}>
                {n.kind === 'message' ? n.text.split('\n').slice(2).join('\n') : n.text}
              </p>
            </div>
            <button type="button" className="icon-btn notice-close" onClick={() => onDismiss(n.id)} aria-label="Dismiss">
              <X aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The device's own status line: time, who is using it and whose CareCircle it is. */
function Strip({ pane, live, lang, connected }: { pane: Pane; live: Today | null; lang: Language; connected: boolean }) {
  const now = useFamilyClock(live);
  const recipient: string = live?.status?.recipient?.name ?? 'Rose';
  return (
    <header className="strip">
      <span className="strip-time">{timeOf(now, lang)}</span>
      <span className="strip-family">
        <Avatar profile={pane.profile} size="sm" />
        <span>
          {recipient}’s CareCircle
          <span className="sr-only">, {nameOf(pane.profile)} is using this device</span>
        </span>
      </span>
      <span className={`strip-link ${connected ? 'strip-link-on' : ''}`} title={connected ? 'Connected to CareCircle' : 'Offline'}>
        <span className="sr-only">{connected ? 'Connected' : 'Offline'}</span>
      </span>
    </header>
  );
}

function TurnView({ t, now, who, renderItem }: { t: Turn; now: boolean; who: string; renderItem: DeviceViewProps['renderItem'] }) {
  const calls = t.items.map((it, i) => (it.kind === 'call' ? renderItem(t, it, i) : null));
  const cards = t.items.map((it, i) => (it.kind === 'call' ? null : renderItem(t, it, i)));
  return (
    <article className={`turn ${now ? 'turn-now' : 'turn-past'}`} aria-busy={t.pending}>
      <p className="said-user">
        <span className="sr-only">{who} said: </span>“{t.user}”
      </p>
      {calls}
      {t.pending && !t.speech && !t.items.length && (
        <p className="invoking" role="status">
          Thinking…
        </p>
      )}
      {t.speech && (
        <p className={`said-alexa${t.speech.text.length > 170 ? ' said-long' : ''}`} lang={t.speech.lang === 'hi' ? 'hi' : undefined}>
          {t.speech.text}
        </p>
      )}
      <div className="turn-cards">{cards}</div>
      {t.error && (
        <p className="turn-error" role="alert">
          {t.error}
        </p>
      )}
    </article>
  );
}

export function DeviceView(props: DeviceViewProps) {
  const { pane, turns, ring, interim, notices, prefs, lang, live, connected, switchingTo, renderItem, companionQuestions, onDismissNotice } = props;
  const p = pane.profile;
  const lastTurn = turns.at(-1);
  const convoRef = usePinnedConversation(
    JSON.stringify([pane.device, turns.map(t => [t.id, t.items.length, !!t.speech, t.pending]), interim, notices.length])
  );
  const switchEl = switchingTo && (
    <div className="switching" role="status">
      <Avatar profile={switchingTo} size="lg" />
      <p>
        Switching to {nameOf(switchingTo)}’s device
        <span className="switching-role">{roleOf(switchingTo)}</span>
      </p>
    </div>
  );

  if (pane.device === 'dot') {
    const ringEl = <div className={`ring ring-${ring}`} aria-hidden="true" />;
    const notice = notices.at(-1);
    return (
      <div className="dot-wrap">
        <div className={`dot dot-${ring}`}>
          {ringEl}
          <div className="dot-top" />
        </div>
        {switchEl}
        <div className="dot-caption" aria-live="polite">
          {notice && <p className={`said-alexa dot-notice-${notice.kind}`}>{notice.kind === 'message' ? `New message: ${notice.title}` : notice.text}</p>}
          {interim && <p className="said-user">“{interim}”</p>}
          {lastTurn && !interim && <p className="said-user">“{lastTurn.user}”</p>}
          {lastTurn?.speech && <p className="said-alexa">{lastTurn.speech.text}</p>}
          {lastTurn?.items.map((it, k) =>
            it.kind === 'warning' ? (
              <p key={k} className="turn-warning" role="alert">
                ⚠ {it.w.message}
              </p>
            ) : null
          )}
        </div>
        {companionQuestions(turns).map(q => (
          <div key={q.e.id} className="dot-companion">
            <p className="muted">On the companion phone:</p>
            {q.node}
          </div>
        ))}
      </div>
    );
  }

  const idle = turns.length === 0 && !notices.length && !interim;
  const kind = pane.device === 'phone' ? 'phone' : 'show';
  const screen = (
    <div className={`screen${prefs.large ? ' screen-large' : ''}`}>
      <Strip pane={pane} live={live} lang={lang} connected={connected} />
      {idle ? (
        <HomeScreen profile={p} live={live} lang={lang} suggestion={SUGGESTIONS[p][lang][0]} />
      ) : (
        <div className="convo" aria-live="polite" ref={convoRef}>
          {turns.map(t => (
            <TurnView key={t.id} t={t} now={t === lastTurn && !interim} who={nameOf(p)} renderItem={renderItem} />
          ))}
          {interim && (
            <article className="turn turn-now">
              <p className="said-user said-interim">“{interim}”</p>
            </article>
          )}
          <Notices notices={notices} onDismiss={onDismissNotice} />
        </div>
      )}
      {switchEl}
    </div>
  );

  if (kind === 'phone') {
    return (
      <div className={`phone ring-${ring}`}>
        <span className="phone-notch" aria-hidden="true" />
        {screen}
      </div>
    );
  }
  return (
    <div className={`show ${pane.device}`}>
      <div className="show-bezel">
        <span className={`lightbar ring-${ring}`} aria-hidden="true" />
        {screen}
      </div>
      {pane.device === 'show8' && <span className="show-base" aria-hidden="true" />}
    </div>
  );
}
