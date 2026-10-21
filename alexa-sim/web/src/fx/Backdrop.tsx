import { lazy, Suspense, useMemo } from 'react';
import { fxEnabled, useMedia } from './support';

const ShaderBackdrop = lazy(() => import('./ShaderBackdrop'));

/**
 * Fixed, full-window backdrop. The CSS layer is always there (and is all you get with ?fx=off or
 * without WebGL2): a dark stage with a soft wash of the person's colour. The shader fades in on top
 * once three.js has loaded. A vignette keeps text readable over both.
 */
export function Backdrop({ tint }: { tint: string }) {
  const on = useMemo(() => fxEnabled(), []);
  const dark = useMedia('(prefers-color-scheme: dark)', true);
  const still = useMedia('(prefers-reduced-motion: reduce)');
  return (
    <div className="fx-backdrop" aria-hidden="true" style={{ ['--fx-tint' as string]: tint }}>
      <div className="fx-backdrop-css" />
      {on && (
        <Suspense fallback={null}>
          <div className="fx-backdrop-shader">
            <ShaderBackdrop tint={tint} dark={dark} still={still} />
          </div>
        </Suspense>
      )}
      <div className="fx-vignette" />
    </div>
  );
}
