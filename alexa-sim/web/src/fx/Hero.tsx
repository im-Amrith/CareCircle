import { lazy, Suspense, useMemo } from 'react';
import { fxEnabled, useMedia } from './support';
import BlurText from './vendor/react-bits/BlurText';

const MetallicPaint = lazy(() => import('./vendor/react-bits/MetallicPaint'));

/**
 * The product-page headline. "Care, coordinated." is cast in liquid metal (React Bits'
 * MetallicPaint, the React form of the liquid-logo shader by collidingScopes,
 * https://github.com/collidingScopes/liquid-logo, MIT), and the line below drifts in word by word
 * (React Bits' BlurText). The real text stays in the DOM for screen readers and as the fallback.
 */
export function Hero({ away }: { away: boolean }) {
  const on = useMemo(() => fxEnabled(), []);
  const dark = useMedia('(prefers-color-scheme: dark)', true);
  const still = useMedia('(prefers-reduced-motion: reduce)');
  return (
    <header className={`hero${away ? ' hero-away' : ''}`} aria-hidden={away}>
      <div className="hero-inner">
        <h2 className={`hero-title${on ? ' hero-title-metal' : ''}`}>
          <span className={on ? 'sr-only' : undefined}>Care, coordinated.</span>
          {on && (
            <Suspense fallback={<span className="hero-title-fallback" aria-hidden="true">Care, coordinated.</span>}>
              <span className="hero-metal" aria-hidden="true">
                <MetallicPaint
                  text="Care, coordinated."
                  fontFamily="Inter, -apple-system, 'SF Pro Display', 'Segoe UI', sans-serif"
                  fontWeight={600}
                  color={dark ? '#f2ede6' : '#3b2a1f'}
                  lightMode={!dark}
                  density={1.1}
                  softness={0.22}
                  dispersion={0.22}
                  distortion={0.05}
                  edgeBend={0.55}
                  angle={65}
                  speed={still ? 0 : 0.6}
                  scale={1}
                  mouseTilt={0.35}
                  paused={away || still}
                  intro
                />
              </span>
            </Suspense>
          )}
        </h2>
        <BlurText
          text="One family. One care record. Just ask."
          className="hero-sub"
          animateBy="words"
          direction="bottom"
          delay={90}
          stepDuration={0.45}
          trigger="load"
        />
      </div>
    </header>
  );
}
