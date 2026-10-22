"""Mock mode "brain": a small deterministic keyword router that stands in for Bedrock.

It only chooses a tool and its arguments; the MCP server, elicitation and the
protocol log stay real. It is also the fallback when a Bedrock call fails.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .mcp_link import LastResult

SAFE_REFUSAL = (
    "I can't advise on doses or changes to medicines. Please check with the doctor or pharmacist first, "
    "and if you feel unwell right now, call emergency services."
)
NOT_SURE = "Sorry, I can help with medicines, refills, visits and how someone is feeling. Try asking how things are today."
DECLINED = "Okay, I won't do that."
NOTHING_TO_REPEAT = "I haven't said anything yet. Try asking how things are today."
LATER = "Okay. I'll check with you again a bit later."

# Hindi versions, for people who chose Hindi (set_language). Alexa's voice is female.
SAFE_REFUSAL_HI = (
    "मैं दवा की मात्रा या बदलाव के बारे में सलाह नहीं दे सकती। कृपया पहले डॉक्टर या फार्मासिस्ट से पूछ लें, "
    "और अगर अभी तबीयत ठीक नहीं लग रही, तो इमरजेंसी सेवा को फ़ोन करें।"
)
NOT_SURE_HI = "माफ़ कीजिए, मैं दवाइयों, रीफ़िल, मुलाक़ातों और तबीयत के बारे में मदद कर सकती हूँ। पूछिए, आज का हाल कैसा है।"
DECLINED_HI = "ठीक है, मैं ऐसा नहीं करूँगी।"
NOTHING_TO_REPEAT_HI = "मैंने अभी तक कुछ नहीं कहा है। पूछिए, आज का हाल कैसा है।"
LATER_HI = "ठीक है, मैं थोड़ी देर बाद फिर पूछूँगी।"

_SLOTS = {"morning": "morning", "breakfast": "morning", "noon": "noon", "lunch": "noon", "evening": "evening", "dinner": "evening", "night": "night", "bedtime": "night"}


@dataclass
class Plan:
    tool: str | None = None
    arguments: dict[str, Any] = field(default_factory=dict)
    reply: str | None = None


def _has(text: str, *patterns: str) -> bool:
    return any(re.search(p, text) for p in patterns)


# Devanagari has no \b word boundaries in Python's re (vowel signs aren't \w), so Hindi patterns match substrings.
_REPEAT = (
    r"\b(say (that|it) again|repeat (that|it)|what did you say|come again|pardon|didn't (hear|catch) (that|you))\b",
    r"फिर से (बोल|कह)|दोबारा (बोल|कह)|क्या कहा",
    r"\b(phir se|dobara) (bolo|boliye|kaho)\b",
)


def is_repeat(text: str) -> bool:
    """'Say that again': the turn repeats the last reply, slower, without a tool call."""
    return _has(" " + text.lower().strip() + " ", *_REPEAT)


# Hindi or Hinglish symptoms -> an English note the family can read, with her own words kept.
_GLOSS: list[tuple[str, str]] = [
    (r"(सीने|छाती) में दर्द|\b(seene|chhati|chati) (mein|me) dard", "chest pain"),
    (r"साँस|सांस|\bsaans\b", "trouble breathing"),
    (r"गिर |गिर गई|गिर गया|गिर पड़|फिसल|\b(gir|phisal) (gayi|gai|gaya|padi)", "had a fall"),
    (r"बेहोश|\bbehosh", "fainted"),
    (r"चक्कर|\bchakkar", "feeling dizzy"),
    (r"नींद|\bneend", "slept badly"),
    (r"घुटन.*दर्द|\bghutn.*dard", "knee pain"),
    (r"बुखार|\bbukhar", "has a fever"),
    (r"थक|\bthak", "feeling tired"),
    (r"दर्द|\bdard\b", "in pain"),
]


def english_note(text: str) -> str:
    """The note to log for a Hindi or Hinglish sentence: an English gloss, plus the original words."""
    lowered = text.lower()
    for pattern, gloss in _GLOSS:
        if re.search(pattern, lowered):
            return f'{gloss[0].upper()}{gloss[1:]} (in Hindi: "{text.strip()}")'
    return text.strip()


def _hindi(text: str) -> bool:
    return bool(re.search(r"[\u0900-\u097F]", text))


def _slot(text: str) -> str | None:
    for word, slot in _SLOTS.items():
        if re.search(rf"\b{word}\b", text):
            return slot
    return None


def _after(text: str, pattern: str) -> str:
    m = re.search(pattern, text)
    return text[m.end():].strip(" .!?") if m else ""


def route(text: str, last: LastResult | None, lang: str = "en") -> Plan:
    t = " " + re.sub(r"\s+", " ", text.lower().replace("’", "'")).strip() + " "
    hi = lang == "hi"

    # Dosing questions are never answered and need no tool.
    if _has(
        t,
        r"\bshould i (take|stop|skip|double|increase|reduce|cut)\b",
        r"\b(extra|double|another) (dose|pill|tablet)",
        r"\bhow (much|many) .*(take|have)\b",
        r"\bcan i (take|stop|skip)\b",
        r"एक और (गोली|दवा|दवाई)|(ज़्यादा|ज्यादा|डबल) (गोली|दवा|दवाई)|दवा (बढ़ा|घटा|बंद)|ले लूँ|ले लूं|ले सकती|ले सकता",
        r"\b(ek aur|extra|double) (goli|dawai|dawa)\b",
    ):
        return Plan(reply=SAFE_REFUSAL_HI if hi else SAFE_REFUSAL)

    # Language: "Talk to me in Hindi", "हिंदी में बात करो", "speak English".
    if _has(t, r"(हिंदी|हिन्दी) में", r"\b(speak|talk|reply|answer)\b.*\bhindi\b", r"\bhindi (mein|me)\b", r"\bin hindi\b"):
        return Plan("set_language", {"language": "hi"})
    if _has(t, r"(अंग्रेज़ी|अंग्रेजी|इंग्लिश) में", r"\b(speak|talk|reply|answer)\b.*\benglish\b", r"\benglish (mein|me)\b", r"\bin english\b"):
        return Plan("set_language", {"language": "en"})

    yes = _has(t, r"^ (yes|yeah|yep|sure|ok|okay|please do|go ahead|do it|i have|i did)\b", r"^ (हाँ|हां|जी)", r"^ (haan|han|ha|ji)\b")
    no = _has(t, r"^ (no|nope|not now|don't|cancel|not yet)\b", r"^ (नहीं|ना |अभी नहीं)", r"^ (nahi|nahin|na)\b")

    # Answers to a gentle reminder ("Have you taken them?").
    if last and last.name == "reminder":
        if yes:
            return Plan("log_medication", {"medication_ids": list(last.structured.get("medicationIds") or [])})
        if no:
            return Plan(reply=LATER_HI if hi else LATER)

    # Answers to a question the last tool asked.
    if yes:
        if last and last.name == "request_refill" and last.structured.get("result") == "needs_confirmation":
            order = last.structured.get("order") or {}
            args: dict[str, Any] = {"confirm": True}
            if order.get("medicationId"):
                args["medication_id"] = order["medicationId"]
            return Plan("request_refill", args)
        if last and last.name in ("check_refills", "get_care_status"):
            return Plan("request_refill", {})
    if no and last and last.name == "request_refill":
        return Plan(reply=DECLINED_HI if hi else DECLINED)

    # Morning check-ins: "Turn off the check-ins" asks first; a following yes turns them off.
    if yes and last and last.name == "set_check_ins" and last.structured.get("result") == "needs_confirmation":
        return Plan("set_check_ins", {"action": "turn_off", "confirm": True})
    if no and last and last.name == "set_check_ins" and last.structured.get("result") == "needs_confirmation":
        return Plan(reply="Okay, I'll keep the morning check-ins on.")
    away = _has(t, r"\b(staying with|away|in (the )?hospital|travell?ing|on holiday|visiting)\b")
    if _has(t, r"\bcheck-? ?ins?\b", r"\bchecking in\b") or (away and _has(t, r"\b(till|until|through)\b")):
        if _has(t, r"\b(turn|switch) (the |her |my |mom's )?(morning )?check-? ?ins? off\b", r"\b(turn|switch) off\b", r"\b(stop|disable|no more)\b"):
            return Plan("set_check_ins", {"action": "turn_off"})
        if _has(t, r"\b(resume|restart|start again|back on|unpause)\b"):
            return Plan("set_check_ins", {"action": "resume"})
        if _has(t, r"\b(turn|switch) on\b", r"\benable\b"):
            return Plan("set_check_ins", {"action": "turn_on"})
        if away or _has(t, r"\bpause\b"):
            args: dict[str, Any] = {"action": "pause"}
            until = _after(t, r"\b(till|until|through)\b")
            if until:
                args["until"] = until
            m = re.search(r"\b(staying with [a-z]+|in (the )?hospital|travell?ing|on holiday|visiting [a-z]+)", t)
            if m:
                args["reason"] = m.group(1)
            return Plan("set_check_ins", args)
        return Plan("get_morning_rhythm", {})
    if _has(t, r"\b(has|is|was) (mom|mum|she|he|rose) (been )?(up|awake|woken)\b", r"\bup yet\b", r"\bmornings?\b.*\b(been|this week|lately|routine|rhythm)\b", r"\bwoke up\b"):
        return Plan("get_morning_rhythm", {})
    # Answering a morning check-in: "I'm fine", "I'm up".
    if _has(t, r"^ (i'?m|i am) (fine|up|okay|ok|good|alright|all right|awake)\b"):
        return Plan("log_wellbeing", {"note": text.strip().rstrip(".") or text})

    if _has(t, r"\bsend\b.*\bsummary\b", r"\bsummary\b.*\b(send|to the family|to everyone)\b", r"सारांश भेज", r"\bsummary bhej"):
        return Plan("send_daily_summary", {})

    # "Mom prefers mornings", "Remember she can't do Fridays", "Forget Mom's appointment preferences".
    if _has(t, r"\b(prefers?|preferences?|would rather|likes? (her |his |my )?appointments)\b", r"\bremember (that )?(she|he|mom|mum|i)\b"):
        return Plan("set_care_preference", {"preference": text.strip(), **({"forget": True} if _has(t, r"\bforget\b") else {})})

    # "Book Mom's cardiology follow-up next week, mornings only, and sort out a ride."
    if _has(t, r"\b(book|make|arrange|set up|get)\b.*\b(appointment|follow-?up|check-?up|cardiology|cardiologist)\b"):
        m = re.search(r"\b(cardiology|cardiologist|heart|[a-z]+ology)\b", t)
        specialty = (m.group(1) if m else "doctor") + (" follow-up" if re.search(r"follow-?up", t) else " appointment")
        appt: dict[str, Any] = {"specialty": specialty.replace("cardiologist", "cardiology").replace("heart", "cardiology")}
        if "this week" in t:
            appt["window"] = "this week"
        elif "next week" in t:
            appt["window"] = "next week"
        wants = [w for w, p in (("mornings only", r"\bmornings?\b"), ("afternoons only", r"\bafternoons?\b")) if re.search(p, t)]
        wants += [d.group(0).strip() for d in re.finditer(r"\b(not|except|no) (on )?(monday|tuesday|wednesday|thursday|friday)s?\b", t)]
        if wants:
            appt["constraints"] = ", ".join(wants)
        return Plan("coordinate_appointment", appt)

    if _has(t, r"(दोबारा|फिर से) (मंगा|मंगवा|ऑर्डर)|मंगा (दो|दीजिए|दें)|मंगवा (दो|दीजिए|दें)", r"\b(mangwa|manga) (do|dijiye|den)\b"):
        return Plan("request_refill", {})

    if _has(t, r"\b(re-?order|order more|order (it|them|some)|refill (it|them))\b"):
        what = _after(t, r"\b(re-?order|order more of|order more|order)\b")
        what = re.sub(r"^(it|them|some|that|those|more)\b", "", what).strip()
        return Plan("request_refill", {"spoken_name": what} if what else {})

    if _has(t, r"\b(took|taken|have had|had) (my|her|his|the|all|both)?\b.*\b(pill|pills|tablet|tablets|medicine|meds|dose|doses)\b", r"\bi took\b", r"\b(she|he|mom|mum) took\b"):
        args = {}
        what = _after(t, r"\btook\b") or _after(t, r"\btaken\b")
        if what:
            args["spoken_name"] = what
        slot = _slot(t)
        if slot:
            args["slot"] = slot
        if _has(t, r"\b(skipped|didn't take|did not take)\b"):
            args["status"] = "skipped"
        return Plan("log_medication", args)

    if _has(
        t,
        r"(दवा|दवाई|दवाइयाँ|दवाइयां|दवाएँ|गोली|गोलियाँ|गोलियां) (ले|खा) (ली|लीं|लिया|लिए)",
        r"\b(dawai|dawa|dawaiyan|goli|goliyan) (le|kha) (li|lee|liya|liye)\b",
    ):
        return Plan("log_medication", {})

    if _has(t, r"\brunning (low|out)\b", r"\brun out\b", r"\brefills?\b", r"\bsuppl(y|ies)\b", r"\blow on\b", r"(खत्म|कम) (हो|है)", r"\b(khatam|kam) (ho|hai)\b"):
        return Plan("check_refills", {})

    if (_hindi(text) or _has(t, r"\b(chakkar|dard|neend|gir gayi|gir gaya|bukhar|thakan|saans|behosh)\b")) and _has(t, *(p for p, _ in _GLOSS)):
        return Plan("log_wellbeing", {"note": english_note(text)})

    if _has(t, r"\b(feel|feeling|felt|slept|sleep|fell|fall|fallen|dizzy|pain|hurts?|ache|tired|chest|breath|faint)\b"):
        note = text.strip().rstrip(".") or text
        return Plan("log_wellbeing", {"note": note})

    if _has(t, r"\bwhat (do|does) (i|she|he|mom|mum) take\b", r"\b(medicines|medications|meds|schedule)\b", r"\bwhat .* tonight\b"):
        slot = _slot(t) or ("night" if "tonight" in t else None)
        return Plan("list_medications", {"when": slot} if slot else {})

    if _has(t, r"आज रात .*(लेना|लेनी|दवा)", r"(कौन सी|कौन-सी|क्या) .*(दवा|दवाई|लेना|लेनी)", r"\b(kaun si|kya) .*(dawai|lena|leni)\b"):
        slot = "night" if _has(t, r"रात", r"\braat\b") else "evening" if _has(t, r"शाम", r"\bshaam\b") else "morning" if _has(t, r"सुबह", r"\bsubah\b") else None
        return Plan("list_medications", {"when": slot} if slot else {})

    if _has(
        t,
        r"\bhow (is|was|are)\b",
        r"\bgood (morning|afternoon|evening)\b",
        r"\b(status|update|updates|today|hello|hi|hey)\b",
        r"\bhow's\b",
        r"सुप्रभात|नमस्ते|नमस्कार|कैसी|कैसा|कैसे|हाल|आज का",
        r"\b(namaste|namaskar|suprabhat|kaisi|kaise|kaisa|haal)\b",
    ):
        return Plan("get_care_status", {})

    return Plan(reply=NOT_SURE_HI if hi else NOT_SURE)
