import type { ReactNode } from 'react';
import type { Elicitation, Language, Today } from './api';
import { isHindi, nameOf, SUGGESTIONS, type Item, type Notice, type Pane, type Prefs, type Ring, type Turn } from './model';

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
  /** One item of a turn: the invoking line, a card, an MCP App view, a question or a warning. */
  renderItem: (t: Turn, it: Item, i: number) => ReactNode;
  /** An open question shown on the companion phone of a Dot. */
  companionQuestions: (turns: Turn[]) => { e: Elicitation; node: ReactNode }[];
  onDismissNotice: (id: string) => void;
  /** The scrolling conversation, so the app can keep the newest turn in view. */
  bodyRef: (el: HTMLDivElement | null) => void;
}

function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: string) => void }) {
  if (!notices.length) return null;
  return (
    <div className="notices" role="region" aria-label="Notifications">
      {notices.map(n => (
        <div key={n.id} className={`notice notice-${n.kind}`} role={n.kind === 'alert' ? 'alert' : 'status'}>
          <div className="notice-head">
            <strong>{n.kind === 'message' ? `Message · ${n.title}` : n.title}</strong>
            <button type="button" className="btn btn-ghost notice-close" onClick={() => onDismiss(n.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
          <p className={n.kind === 'message' ? 'notice-text notice-pre' : 'notice-text'} lang={isHindi(n.text) ? 'hi' : undefined}>
            {n.kind === 'message' ? n.text.split('\n').slice(2).join('\n') : n.text}
          </p>
        </div>
      ))}
    </div>
  );
}

export function DeviceView(props: DeviceViewProps) {
  const { pane, turns, ring, interim, notices, prefs, lang, connected, renderItem, companionQuestions, onDismissNotice, bodyRef } = props;
  const p = pane.profile;
  const ringEl = <div className={`ring ring-${ring}`} aria-hidden="true" />;
  const lastTurn = turns.at(-1);

  if (pane.device === 'dot') {
    const notice = notices.at(-1);
    return (
      <div className="dot-wrap">
        <div className={`dot dot-${ring}`}>
          {ringEl}
          <div className="dot-top" />
        </div>
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

  const suggestion = SUGGESTIONS[p][lang][0];
  return (
    <div className={`frame frame-${pane.device}`}>
      <div className={`screen${prefs.large ? ' screen-large' : ''}`}>
        <header className="screen-bar">
          <span>{pane.device === 'phone' ? `CareCircle · ${nameOf(p)}` : nameOf(p)}</span>
          <span className="screen-time">{connected ? 'Connected' : 'Offline'}</span>
        </header>
        <div className="screen-body" aria-live="polite" ref={bodyRef}>
          {turns.length === 0 && !notices.length && (
            <div className="screen-idle">
              <p className="idle-hello">{lang === 'hi' ? `नमस्ते ${nameOf(p)}` : `Hi ${nameOf(p)}`}</p>
              <p className="muted">Try “{suggestion}”</p>
            </div>
          )}
          {turns.map(t => (
            <article key={t.id} className="turn" aria-busy={t.pending}>
              <p className="said-user">
                <span className="sr-only">{nameOf(p)} said: </span>“{t.user}”
              </p>
              {t.items.map((it, i) => renderItem(t, it, i))}
              {t.speech && (
                <p className="said-alexa" lang={t.speech.lang === 'hi' ? 'hi' : undefined}>
                  {t.speech.text}
                </p>
              )}
              {t.pending && !t.speech && !t.items.length && (
                <p className="invoking" role="status">
                  Thinking…
                </p>
              )}
              {t.error && (
                <p className="turn-error" role="alert">
                  {t.error}
                </p>
              )}
            </article>
          ))}
          {interim && <p className="said-user said-interim">“{interim}”</p>}
          <Notices notices={notices} onDismiss={onDismissNotice} />
        </div>
        {ringEl}
      </div>
    </div>
  );
}
