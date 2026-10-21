import { useEffect, useState } from 'react';

/**
 * When to run the WebGL effects. They are decoration, so the app must look complete without them:
 * ?fx=off (or localStorage "cc-fx" = "off") turns them off, no WebGL2 turns them off, and
 * prefers-reduced-motion keeps them but holds them still.
 */

const query = () => new URLSearchParams(window.location.search);

export function fxEnabled(): boolean {
  try {
    const q = query().get('fx');
    if (q === 'off' || q === '0') return false;
    if (q === 'on' || q === '1') return true;
    if (window.localStorage.getItem('cc-fx') === 'off') return false;
  } catch {
    /* storage can be blocked; effects stay on */
  }
  return hasWebGL2();
}

let webgl2: boolean | null = null;
export function hasWebGL2(): boolean {
  if (webgl2 !== null) return webgl2;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

/** Live value of a media query, for React. */
export function useMedia(queryText: string, fallback = false): boolean {
  const [on, setOn] = useState(() => window.matchMedia?.(queryText).matches ?? fallback);
  useEffect(() => {
    const m = window.matchMedia?.(queryText);
    if (!m) return;
    const update = () => setOn(m.matches);
    m.addEventListener('change', update);
    return () => m.removeEventListener('change', update);
  }, [queryText]);
  return on;
}
