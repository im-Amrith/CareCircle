# Task: premium polish of the simulator ("Apple product page" feel)

The redesign (PR #4) and the palette change made the simulator warmer, but it still feels like
a themed dashboard: saturated aubergine everywhere, borders on every element, flat devices, and a
log panel competing with the hero. The target is the restraint of an Apple product page. The
demo video is recorded in this UI, so this matters for the Design score.

Branch `feature/premium-ui` from `main`. This is visual only: do not change `api.ts`, the
orchestrator, the MCP server or behaviour. Read `alexa-sim/web/src/*` and `docs/screenshots/*`
first, and load the `frontend-design` skill if you have it.

## Principles

1. **One hero.** The device is the product shot. Everything else recedes.
2. **Neutral stage, colour in content.** The page is near-black (dark) or Apple grey (light).
   Colour appears only in content: avatars, status, the light ring, a soft glow behind the
   device.
3. **No borders.** Separate with space, soft fills and shadows. Hairlines (0.5px,
   white/black at 8–12%) only where truly needed.
4. **Type does the work.** A few sizes, large and tight. Weight and size create the
   hierarchy, not colour or boxes.
5. **Glass and depth.** Floating controls and on-screen panels use frosted glass
   (`backdrop-filter: blur(24px) saturate(180%)`) over a softly lit background.
6. **Motion is physical.** Spring easing, short, never decorative.

## Design tokens (replace the current ones)

- **Stage**
  - Dark: page `#000000` to `#0b0b0e`.
  - Light: page `#f5f5f7`, surfaces `#ffffff`.
  - **Remove the aubergine page.** Mocha survives only as the brand accent.
- **Text**
  - Dark: `#f5f5f7`, secondary `rgba(245,245,247,0.62)`, tertiary `0.42`.
  - Light: `#1d1d1f` and `#6e6e73`.
- **Accent:** latte `#C8A27A` in dark mode, mocha `#6F4E37` in light mode. Use it for the
  primary button, the selected state and links only.
- **Status:** Apple system colours. Taken `#30D158`, due `#FF9F0A`, missed or alert `#FF453A`,
  listening `#64D2FF`. Use the light-mode equivalents in light.
- **Per-person tint:** Rose coral `#FF7A6B`, Sam blue `#5E9EFF`, Maya violet `#B58CFF`. Use
  these for avatars and the ambient glow only.
- **Type**
  - Font: `Inter` (variable; use `Inter Display` optical sizes if available), falling back to
    `-apple-system, "SF Pro Display", "Segoe UI"`. Drop Fraunces.
  - Display: 48–64px, weight 600, letter-spacing -0.03em.
  - Title: 28px/600, -0.02em.
  - Body: 17px/400.
  - Caption: 13px/500.
  - On-device spoken reply: 30–34px/500, -0.02em.
  - Protocol log: `"SF Mono", ui-monospace, Consolas` at 12px.
- **Radius:** 28px device screen, 22px panels and cards, 999px pills.
- **Shadows** (layered, soft): an ambient shadow `0 40px 120px rgba(0,0,0,.45)` plus a contact
  shadow `0 8px 24px rgba(0,0,0,.35)` under devices.
- **Motion:** `cubic-bezier(0.32, 0.72, 0, 1)` at 450ms for sheets and cards, 250ms for hovers.
  Content enters with opacity 0→1 and translateY 8px→0. Respect `prefers-reduced-motion`.

## Layout

- **Top bar:** transparent, 52px tall. "CareCircle" wordmark left (17px/600); on the right one
  quiet status pill ("Mock mode" or "Nova 2 Lite · ap-southeast-2") with a 6px green dot. Remove
  everything else from the top bar.
- **Hero line** above the device, centred, like a product page:
  - "Care, coordinated." in display size.
  - One secondary line: "One family. One care record. Just ask."
  - It shrinks or fades once a conversation starts, so the device moves up.
- **Device:** centred, about 70% of the viewport width (Show 8). Behind it, a large blurred
  radial glow in the current person's tint at about 18% opacity. It crossfades when switching
  person.
- **People switcher:** a floating glass segmented control above the device. Each segment has a
  28px avatar, a name and a role in caption. The selected segment gets a solid glass pill that
  slides between segments with a spring.
- **Control bar:** a floating glass pill under the device.
  - A 56px circular mic: accent fill; while listening, a pulsing cyan ring.
  - The text field with no border.
  - Send and "…" as icon buttons.
- **Suggestion chips:** plain text buttons in secondary colour that turn primary on hover, no
  borders. At most 3 visible.
- **"Under the hood" panel:**
  - **Collapsed by default** into a small glass pill at the bottom-right: "Under the hood · 17
    messages" with a pulsing dot when new traffic arrives.
  - Opens as a glass sheet sliding in from the right (420px), not a permanent column.
  - Inside: grouped per turn, with SF Mono rows, a 6px coloured dot per kind (no coloured left
    borders), hairline separators, and a click to expand JSON.
  - For the video we can open it on cue.

## Devices (pure CSS, no images, no Amazon names or logos)

- **Show 8 and Show 15**
  - Bezel: near-black with a subtle top-down gradient (`#2a2a2e` → `#141416`), a 1px inner
    highlight `rgba(255,255,255,.08)` on the top edge, and a fine fabric texture at very low
    opacity.
  - Screen: a slight glass reflection, a diagonal linear gradient of white at 0→4% across the
    top third.
  - A stand with a soft contact shadow.
- **Dot:** a matte sphere top-down with a radial gradient for volume, a fine mesh pattern at low
  opacity, and a crisp light ring with glow (listening cyan pulse, speaking slow rotating sweep,
  alert amber). The caption below is in display type.
- **Phone:** a modern frame with a Dynamic Island-style pill. Content is iOS-like: glass cards
  and large titles.

## On-screen content

- **Status strip:** the time on the left (17px/600); the avatar and family name on the right,
  with no dot clutter.
- **Idle home screen**, like a StandBy screen:
  - A huge thin clock (weight 200, 120px+, tabular numbers) and the date below it.
  - A row of 3 glass widgets: Next dose (name and time), Visit (who and when), and Today (a
    progress ring "2 of 5").
- **Conversation**
  - The newest reply is large and calm, with no box around it.
  - Its card sits below as a glass panel with generous padding (24–28px).
  - Earlier turns are smaller and fade upward.
- **Cards**
  - Glass panels with an icon in a 36px rounded square tinted with the status colour at 18%.
  - Title at 17px/600, body at 15px.
  - Dose timeline: 4 columns with large status dots.
  - Supply: a thin capsule gauge.
  - Order: a 4-step progress line.
- **Notifications** (like the "Gentle reminder" in the current UI): an iOS-style banner that
  drops in from the top of the screen with a spring.
  - An app icon square, then title and body.
  - A subtle close button.
  - No yellow border.
- **Confirmation dialog:** a centred glass sheet that dims the screen behind it.
  - Question at 22px/600.
  - Two large buttons: Accept filled with the accent, Decline in tinted glass.
  - Cancel as text below.

## Quality bar

- [ ] Remove every border that isn't a hairline. Remove every colour that doesn't carry meaning.
- [ ] Look at your own screenshots after each step (Playwright, 1440×900 and 1920×1080, dark
  and light) and compare them against the principles. Iterate until it looks like it belongs
  on apple.com, not in an admin panel. Do this in a loop; don't stop after one pass.
- [ ] Text contrast WCAG AA in both modes. No clipping. No horizontal scroll.
- [ ] All 7 README demo lines still work in `npm run sim:mock`. `npm test` passes.
- [ ] Replace `docs/screenshots/*` and open a PR with before/after images.

## Order of work

1. Tokens, stage, top bar, hero line and glow.
2. Show 8 device and idle home screen. **Stop and show me screenshots.**
3. Controls, people switcher, notifications and dialog.
4. Cards, Dot, phone, Show 15.
5. Under the hood sheet.

Time box: about 3 hours. If time runs out, steps 1–3 matter most for the video.
