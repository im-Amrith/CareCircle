"""Who's speaking? The simulated voice match reaches the server, which enforces the rules. Mock mode, no AWS."""

from __future__ import annotations

import httpx

from .conftest import of, speech, turn


def test_unknown_voice_can_ask_but_not_change(sim: str) -> None:
    events = turn(sim, "sam", "Mom says her knee hurts", voice="unknown")
    assert of(events, "voice_match") == [{"confidence": "unknown", "candidates": []}]
    assert [c["name"] for c in of(events, "tool_call")] == ["log_wellbeing"]
    assert speech(events).startswith("Sorry, I don't recognise this voice, so I can't add a note about how Rose is feeling.")

    asked = turn(sim, "sam", "How is Mom today?", voice="unknown")
    assert [c["name"] for c in of(asked, "tool_call")] == ["get_care_status"]
    assert "recognise" not in speech(asked)


def test_unsure_voice_asks_who_is_speaking_then_acts_as_them(sim: str) -> None:
    asked: list[dict] = []

    def answer(e: dict) -> dict:
        asked.append(e)
        return {"action": "accept", "content": {"speaker": "maya"}}

    events = turn(sim, "sam", "Mom says she slept well", answer, voice="low")
    assert of(events, "voice_match") == [{"confidence": "low", "candidates": ["sam", "maya"]}]
    assert len(asked) == 1
    options = asked[0]["requestedSchema"]["properties"]["speaker"]["oneOf"]
    assert [o["const"] for o in options] == ["sam", "maya", "someone_else"]
    assert asked[0]["message"] == "I'm not sure who's speaking. Before I add a note about how Rose is feeling, who is this?"
    result = of(events, "tool_result")[0]
    assert not result.get("isError")

    # The next request is back to a matched voice: no question.
    after = turn(sim, "sam", "Mom says she had a good lunch")
    assert not of(after, "elicitation")
    assert of(after, "voice_match") == [{"confidence": "high", "candidates": []}]


def test_bad_voice_value_is_rejected(sim: str) -> None:
    r = httpx.post(f"{sim}/turn", json={"profile": "sam", "text": "hi", "voice": "maybe"})
    assert r.status_code == 422
