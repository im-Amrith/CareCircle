# Task: redesign the CareCircle simulator UI for the demo video

The simulator (`alexa-sim/web`, React + Vite) works, but it looks like a generic dark admin panel.
Judges score **Design** ("a complete, coherent product experience, intuitive for the target
device") as one of four equal criteria, and the demo video is recorded in this UI. Make it look
like a real, warm, well-made product. This is a visual and interaction redesign. **Do not change
the orchestrator API, the MCP server, or behaviour.**

Read `alexa-sim/web/src/*` and `docs/screenshots/*.png` first. Load and follow the
`frontend-design` skill if you have it.

## Problems to fix (seen in `docs/screenshots/sim-reorder-form.png`)

1. **Clipping.** Alexa's reply text is cut off at the top of the device screen ("run out soon. It
   comes from…"). The conversation must scroll inside the screen, auto-scroll to the newest turn,
   and never clip a line.
2. **Not a device.** The "Show 8" frame is a rounded rectangle. It should read instantly as a
   smart display, a speaker and a phone.
3. **No identity.** Everything is cyan on navy. Nothing says family or care.
4. **Crowded chrome.** Device picker, profile picker, text box, Mute, New chat and suggestion chips
   compete with the device.
5. **Protocol panel.** It's useful but reads as a raw log, and the error row for `server/discover`
   looks like a failure to a judge.

## Design direction

- **Two zones.**
  - A calm stage on the left with the device large and centred.
  - A slim "Under the hood" panel on the right: the MCP protocol log, collapsible, collapsed by
    default on narrow screens.
  - The stage background is soft and warm, not pure black, so the device pops.
- **Palette.**
  - Warm and humane: deep ink or charcoal for device bezels, a soft warm off-white or sand page in
    light mode, and a deep plum-navy page in dark mode.
  - One brand accent, for example a warm coral or teal-green; pick one and use it sparingly.
  - Status colours keep their meaning only: green for taken, amber for due, red for missed or
    alert.
  - The cyan light ring is the only cyan, used only while listening or speaking.
  - Support light and dark mode with CSS variables and default to the OS.
- **Type.**
  - One distinctive but readable family for headings (for example "Fraunces" or "DM Serif
    Display" via Google Fonts) and a clean sans for body ("Inter" or "Atkinson Hyperlegible",
    which is good for older eyes).
  - On-device text is large: Alexa's spoken line at about 28–32px on Show 8, cards 18–20px. The
    on-screen text is read from across a kitchen.
- **Devices** (pure CSS, no images, no Amazon logos or names):
  - **Show 8**: a landscape screen in a thick fabric-textured bezel (subtle CSS noise or gradient),
    with a slanted stand implied by a shadow. A light bar at the top glows during listening.
  - **Show 15**: a larger, thinner bezel; it looks wall-mounted.
  - **Dot**: a round speaker seen from above with a fabric mesh look and an animated light ring
    (idle off, listening cyan pulse, speaking slow sweep, alert amber). Below it, a minimal live
    caption of the last exchange.
  - **Phone**: a phone frame with a notch, the conversation as chat bubbles, and cards inline.
- **Screen layout on Show devices** (like Alexa's own visual style):
  - A top strip with the time (frozen demo clock), the profile avatar and the family name
    ("Rose's CareCircle").
  - The newest reply big and centred.
  - The card for that reply below it.
  - Earlier turns fade upward and are reachable by scrolling.
  - When idle, show an ambient home screen: the date and time, "Next: Amlodipine at 8 pm",
    "Maya visits at 4 pm", and a small adherence ring for today (for example "2 of 5 doses").
    This idle screen is a big visual win in the video.
- **Profiles.** Avatars with initials and a colour per person (Rose, Sam, Maya) and their role
  underneath (Mom · Son · Daughter). Switching profile animates a short "Switching to Sam's
  device" transition, so the video shows clearly that different people are talking.
- **Controls.**
  - One floating control bar under the device: a large mic button (push-to-talk, with an animated
    state), the text box, and a "…" menu holding Mute, New chat, Language and Device.
  - Suggestion chips appear only when the input is empty, and change per profile and per moment
    (for example after a low-supply reply, show "Reorder it").
- **Cards.**
  - Redesign every card in `cards/Cards.tsx` with large type, clear hierarchy, icons (use an
    inline SVG icon set or `lucide-react`) and colour only for status.
  - Care status: a dose timeline for the day (morning, noon, evening, night) with taken, due and
    missed markers.
  - Refill: a supply gauge (days left).
  - Order: a status stepper (requested → checkout → placed → arriving).
  - Wellbeing alerts: unmistakable but calm.
  - The confirmation (elicitation) card looks like a system dialog on the device: a clear
    question, big Accept/Decline buttons, and Cancel as a text button.
- **Motion.** Subtle and purposeful only: the light ring, card slide-in, the profile switch
  transition, and the speaking indicator. Respect `prefers-reduced-motion`.
- **"Under the hood" panel.**
  - Group messages per turn: "Rose said: I took my morning pills" → `tools/call log_medication` →
    response time.
  - Colour by kind (request, response, notification, elicitation).
  - Click a row to expand pretty-printed JSON.
  - Show the version probe (`server/discover` falling back to `initialize`) as a neutral info row
    with a one-line explanation, not a red error.
  - A header chip shows "MCP 2025-11-25 · Streamable HTTP · session 3f2a…".
- **Top bar.** Small: logo mark, "CareCircle", and status pills (MCP connected, Bedrock model or
  Mock mode, voice). Put the "Simulated Alexa+ experience" label here, quietly.
- **Accessibility.**
  - WCAG AA contrast in both themes.
  - Every control keyboard-reachable with visible focus.
  - Buttons labelled.
  - Captions always visible, also on Dot.

## Non-goals

- No change to `api.ts` contracts, the orchestrator or the server.
- No new runtime dependencies besides a font, an icon library and, if needed, a tiny animation
  helper. No UI framework migration.

## Done when

- [ ] All 7 demo lines in the README still work in `npm run sim:mock` and `npm run sim:demo`.
- [ ] No text clipping at 1280×800, 1440×900 and 1920×1080 browser sizes.
- [ ] `npm run build` and `npm test` pass.
- [ ] New screenshots replace the old ones in `docs/screenshots/`: idle home screen, care status,
  reorder confirmation, checkout complete, Dot, phone, safety alert, protocol panel expanded.
  Capture them headless with Playwright if available.
- [ ] Work is on branch `feature/ui-redesign` with a PR that includes before/after screenshots.

Work in small commits. Show me the idle home screen and the Show 8 conversation first, before
restyling every card.
