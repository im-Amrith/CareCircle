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

_SLOTS = {"morning": "morning", "breakfast": "morning", "noon": "noon", "lunch": "noon", "evening": "evening", "dinner": "evening", "night": "night", "bedtime": "night"}


@dataclass
class Plan:
    tool: str | None = None
    arguments: dict[str, Any] = field(default_factory=dict)
    reply: str | None = None


def _has(text: str, *patterns: str) -> bool:
    return any(re.search(p, text) for p in patterns)


def _slot(text: str) -> str | None:
    for word, slot in _SLOTS.items():
        if re.search(rf"\b{word}\b", text):
            return slot
    return None


def _after(text: str, pattern: str) -> str:
    m = re.search(pattern, text)
    return text[m.end():].strip(" .!?") if m else ""


def route(text: str, last: LastResult | None) -> Plan:
    t = " " + re.sub(r"\s+", " ", text.lower().replace("’", "'")).strip() + " "

    # Dosing questions are never answered and need no tool.
    if _has(t, r"\bshould i (take|stop|skip|double|increase|reduce|cut)\b", r"\b(extra|double|another) (dose|pill|tablet)", r"\bhow (much|many) .*(take|have)\b", r"\bcan i (take|stop|skip)\b"):
        return Plan(reply=SAFE_REFUSAL)

    # Answers to a question the last tool asked.
    if _has(t, r"^ (yes|yeah|yep|sure|ok|okay|please do|go ahead|do it)\b"):
        if last and last.name == "request_refill" and last.structured.get("result") == "needs_confirmation":
            order = last.structured.get("order") or {}
            args: dict[str, Any] = {"confirm": True}
            if order.get("medicationId"):
                args["medication_id"] = order["medicationId"]
            return Plan("request_refill", args)
        if last and last.name in ("check_refills", "get_care_status"):
            return Plan("request_refill", {})
    if _has(t, r"^ (no|nope|not now|don't|cancel)\b") and last and last.name == "request_refill":
        return Plan(reply=DECLINED)

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

    if _has(t, r"\brunning (low|out)\b", r"\brun out\b", r"\brefills?\b", r"\bsuppl(y|ies)\b", r"\blow on\b"):
        return Plan("check_refills", {})

    if _has(t, r"\b(feel|feeling|felt|slept|sleep|fell|fall|fallen|dizzy|pain|hurts?|ache|tired|chest|breath|faint)\b"):
        note = text.strip().rstrip(".") or text
        return Plan("log_wellbeing", {"note": note})

    if _has(t, r"\bwhat (do|does) (i|she|he|mom|mum) take\b", r"\b(medicines|medications|meds|schedule)\b", r"\bwhat .* tonight\b"):
        slot = _slot(t) or ("night" if "tonight" in t else None)
        return Plan("list_medications", {"when": slot} if slot else {})

    if _has(t, r"\bhow (is|was|are)\b", r"\bgood (morning|afternoon|evening)\b", r"\b(status|update|updates|today|hello|hi|hey)\b", r"\bhow's\b"):
        return Plan("get_care_status", {})

    return Plan(reply=NOT_SURE)
