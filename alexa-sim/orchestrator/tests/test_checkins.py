"""Morning check-ins in mock mode against the real MCP server. No AWS calls."""

from __future__ import annotations

import httpx

from carecircle_sim.mcp_link import LastResult
from carecircle_sim.router import route

from .conftest import of, speech, turn


def test_router_understands_morning_check_ins() -> None:
    assert route("Has Mom been up this morning?", None).tool == "get_morning_rhythm"
    assert route("Is Mom up yet?", None).tool == "get_morning_rhythm"
    assert route("How have Mom's mornings been this week?", None).tool == "get_morning_rhythm"
    pause = route("Mom's staying with me till Sunday", None)
    assert pause.tool == "set_check_ins"
    assert pause.arguments == {"action": "pause", "until": "sunday", "reason": "staying with me"}
    assert route("Turn off the morning check-ins", None).arguments == {"action": "turn_off"}
    assert route("Resume the check-ins", None).arguments == {"action": "resume"}
    # Rose answering her check-in is a wellbeing note.
    assert route("I'm fine, just slept in", None).tool == "log_wellbeing"
    # Turning off needs a yes to the question the server asked.
    asked = LastResult(name="set_check_ins", text="Turn off...?", structured={"result": "needs_confirmation"}, is_error=False)
    assert route("Yes", asked).arguments == {"action": "turn_off", "confirm": True}
    assert route("No", asked).tool is None


def test_sam_asks_whether_mom_has_been_up(sim: str) -> None:
    events = turn(sim, "sam", "Has Mom been up this morning?")
    assert [c["name"] for c in of(events, "tool_call")] == ["get_morning_rhythm"]
    said = speech(events)
    assert said.startswith("Yes, Rose was up and about at 7:45 am this morning")
    assert "later than usual on Wednesday" in said


def test_clock_endpoint_checks_its_input(sim: str) -> None:
    assert httpx.post(f"{sim}/clock/advance", params={"minutes": 0}).status_code == 400
