---
name: carecircle
description: Coordinate an older person's daily care through the CareCircle MCP server. Covers medication doses, refills, doctor's appointments with a ride, wellbeing notes and family updates. Use when someone asks how a family member is doing, says they took their medicine, asks to reorder tablets or book an appointment, or wants to tell the family something. Never gives medical advice.
---

# CareCircle

CareCircle is an MCP server that helps a family look after one person (the *care recipient*,
"Rose" in the demo data). Everyone in the family talks to it as themselves: Rose, her son
Sam (coordinator) and her daughter Maya (helper). Every tool returns two things:

- `structuredContent`, for your reasoning and for on-screen cards.
- One short sentence in `content`, written to be spoken aloud. Prefer to say it as is.

All demo data is synthetic. No real people or patient records are involved.

## Connect

- **Transport:** Streamable HTTP (MCP 2025-11-25) at `http://127.0.0.1:8000/mcp`.
- **Start it locally:** `cd server && npm install && npm run dev`. To freeze the clock at 9 am
  in India for a repeatable demo, set `CARECIRCLE_NOW=2026-10-10T03:30:00Z`.
- **Who you are:** send `Authorization: Bearer dev:<user>`, where `<user>` is `rose`, `sam` or
  `maya`. With no header you are Sam. This is dev auth only. A deployed server uses real tokens.
- **Elicitation:** declare form elicitation (`capabilities.elicitation.form`) if your client can
  show a form. Then the server asks the person directly before ordering or booking anything.
  URL elicitation lets it open the refill checkout page without the link passing through you.
- **Language:** replies come in the caller's language (English or Hindi). Keep that language
  when you speak. Medicine names stay as they are.

## Pick the tool

| The person says | Tool | Arguments |
| --- | --- | --- |
| "How is Mom today?", "Good morning", "Any updates?" | `get_care_status` | `detail: "brief"` (or `"full"` if they ask for more) |
| "What do I take tonight?", "What medicines is she on?" | `list_medications` | `when`: `morning`, `noon`, `evening` or `night`, if said |
| "I took my morning pills", "Mom took the blood pressure one" | `log_medication` | `spoken_name` as said, `slot` if said; `status: "skipped"` for a skipped dose |
| "Is she running low on anything?" | `check_refills` | none |
| "Reorder her blood pressure tablets", "Yes" after a low-supply warning | `request_refill` | `spoken_name` as said; see [Orders and bookings](#orders-and-bookings) |
| "Book Mom's cardiology follow-up next week, mornings only, and sort out a ride" | `coordinate_appointment` | `specialty`, `window`, `constraints`; see below |
| "I slept badly", "Mom says her knee hurts", "I had a fall" | `log_wellbeing` | `note`, in plain English words (translate if needed) |
| "Talk to me in Hindi", "Speak English" | `set_language` | `language: "hi"` or `"en"` |
| "Send everyone today's summary" | `send_daily_summary` | none |
| "Should I take an extra tablet?", "Can I stop my statin?" | **no tool** | Refuse kindly; see the safety rules |

Also available:

- **Resources:** `carecircle://family/{familyId}/care-plan`, `.../log/{date}`, and the live
  `.../today` and `.../inbox`. Subscribe to the live ones to hear when anyone in the family logs
  something.
- **Prompts:** `morning_briefing` and `caregiver_handoff`.

When a result asks something back, ask the person, then call again with their answer:

- `log_medication` returns `needs_clarification` with `options`. Ask which one they meant, then
  call again with `medication_ids`.
- `request_refill` returns `needs_confirmation` with a `question`.
- `coordinate_appointment` returns `needs_choice` with `options` and a `question`.

## Safety rules

1. **No medical advice.** Never suggest a dose, a change to a medicine, a diagnosis or whether a
   symptom is serious. For symptoms, suggest the doctor. For an emergency (a fall with injury,
   chest pain, trouble breathing), say to call emergency services now. `log_wellbeing` already
   returns safety guidance for red-flag words, so speak it.
2. **Orders and bookings only after a human yes.** Never set `confirm: true`, or pick an
   appointment option, on the person's behalf. "Reorder it" is a request, not a yes: let the
   tool ask its question first. If the client supports form elicitation, the server shows the
   person a form and ignores `confirm`. Either way, the yes must come from the person.
3. **Never read a URL aloud.** The refill checkout link is in `structuredContent.checkoutUrl`.
   Show it on screen if you can, and say "open the checkout link". The spoken `content` never
   contains it.
4. **Keep it short.** One or two sentences per reply, no lists, tables or Markdown in speech.
5. **Respect roles.** Helpers can't order refills or book appointments. If a tool refuses, speak
   its refusal; don't retry as someone else.

## Orders and bookings

**Refills (`request_refill`).** Ordering needs two separate yeses: one to the question, and one on
the checkout page.

1. Call it with `spoken_name` (or no arguments for whatever runs out first).
2. If it returns `needs_confirmation`, ask its `question` word for word. Only after a clear yes,
   call again with `medication_id` from the result and `confirm: true`.
3. `checkout_ready`: speak `content`, show the checkout link on screen. Nothing is ordered until
   the person completes checkout there.
4. `already_ordered`: an order is already on its way. Say so; it won't order twice.

**Appointments (`coordinate_appointment`).**

1. Call it with `specialty` (e.g. "cardiology follow-up"), `window` (e.g. "next week") and
   `constraints` (e.g. "mornings only").
2. With form elicitation, the person picks one of up to three options on a form, or declines and
   nothing is booked.
3. Without it, you get `needs_choice`. Read the options (the `content` already does), and ask
   which one. Only after a clear choice and yes, call again with that option's `option_id` and
   `confirm: true`.
4. `booked`: speak `content`. It names the time and who drives.

This tool can also run as an MCP Task. Send a `task` param with `tools/call` and follow the
status with `tasks/get`. When the status is `input_required`, call `tasks/result`: the picker
arrives as an elicitation on that request. `tasks/cancel` stops it, and nothing is booked.

## Worked examples

### "How is Mom today?" (Sam)

1. Call `get_care_status` with `{ "detail": "brief" }` as `dev:sam`.
2. Speak `content`. With the demo clock at 9 am: "Rose has taken none of her five doses so far
   today. Metformin and Vitamin D3 are due now. Maya visits at 4 pm. She mentioned: slept badly
   last night. Amlodipine runs low: about three days left."
3. Use `structuredContent` for anything else he asks. `doses` has each dose's status,
   `refillAlerts` has supplies and any open order, `appointments` has booked visits and who
   drives.
4. If he then says "Reorder it", go to the next example. Don't treat that as a yes.

### "Reorder her blood pressure tablets" (Sam)

1. Call `request_refill` with `{ "spoken_name": "blood pressure tablets" }`.
2. If the client has form elicitation, the server asks Sam on a form, then returns
   `checkout_ready` or `declined`. Skip to step 5.
3. Otherwise it returns `needs_confirmation`. Ask its question: "Amlodipine has about three days
   left. Should I reorder Amlodipine 5 mg, 30 tablets, from Riverside Pharmacy for delivery?"
4. Sam says "Yes, go ahead". Call `request_refill` with `{ "medication_id": "med-amlodipine",
   "confirm": true }`. If he says no, or anything unclear, don't call it again.
5. On `checkout_ready`, say the `content` ("Okay. I've started a refill of Amlodipine 5 mg… To
   place it, open the checkout link."). Show `checkoutUrl` on screen. Never read it out.
6. Later, `get_care_status` says "A refill arrives tomorrow." once checkout is complete.
