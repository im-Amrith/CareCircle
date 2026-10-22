"""Demo script lines 1-4 in mock mode against the real MCP server. No AWS calls."""

from __future__ import annotations

import httpx

from carecircle_sim.router import SAFE_REFUSAL, route

from .conftest import of, speech, turn


def test_health_reports_mock_mode(sim: str) -> None:
    h = httpx.get(f"{sim}/healthz").json()
    assert h["ok"] is True
    assert h["mcp"]["protocol"] == "2025-11-25"
    assert h["brain"]["mode"] == "mock"
    assert h["speech"]["mode"] == "browser"


def test_line1_rose_good_morning(sim: str) -> None:
    events = turn(sim, "rose", "Good morning")
    assert of(events, "transcript") == [{"profile": "rose", "text": "Good morning"}]
    assert [c["name"] for c in of(events, "tool_call")] == ["get_care_status"]
    result = of(events, "tool_result")[0]
    assert result["structuredContent"]["counts"]["due"] == 2
    said = speech(events)
    assert said.startswith("Good morning, Rose.")
    assert "Metformin and Vitamin D3 are due now" in said
    assert "audio" not in of(events, "speech")[0]  # browser speech in mock mode
    assert events[-1][0] == "done"

    # The protocol log shows the handshake and the call, captured at the transport.
    rpc = of(events, "rpc")
    methods = [(e["dir"], e["method"], e["kind"]) for e in rpc]
    assert ("out", "initialize", "request") in methods
    assert ("in", "initialize", "response") in methods
    assert ("out", "tools/list", "request") in methods
    assert ("out", "tools/call", "request") in methods
    assert ("in", "tools/call", "response") in methods
    init = next(e for e in rpc if e["method"] == "initialize" and e["dir"] == "out")
    assert init["body"]["params"]["clientInfo"]["name"] == "CareCircle Alexa+ Simulator"
    assert init["body"]["params"]["capabilities"]["elicitation"] == {"form": {}, "url": {}}
    call = next(e for e in rpc if e["method"] == "tools/call" and e["dir"] == "in")
    assert call["ms"] is not None


def test_line2_rose_took_morning_pills(sim: str) -> None:
    events = turn(sim, "rose", "I took my morning pills")
    call = of(events, "tool_call")[0]
    assert call["name"] == "log_medication"
    assert call["arguments"]["slot"] == "morning"
    assert of(events, "tool_result")[0]["structuredContent"]["result"] == "logged"
    assert "I've logged Metformin and Vitamin D3" in speech(events)


def test_line3_sam_how_is_mom(sim: str) -> None:
    events = turn(sim, "sam", "How is Mom today?")
    assert [c["name"] for c in of(events, "tool_call")] == ["get_care_status"]
    said = speech(events)
    assert said.startswith("Rose has taken two of her five doses so far today.")
    assert "Maya visits at 4 pm" in said


def test_line4_sam_refill_with_elicitation_and_checkout(sim: str, mcp_server: str) -> None:
    low = turn(sim, "sam", "Is she running low on anything?")
    assert [c["name"] for c in of(low, "tool_call")] == ["check_refills"]
    assert "Amlodipine 5 mg has about three days left" in speech(low)
    assert "Want me to reorder it?" in speech(low)

    asked: list[dict] = []

    def answer(e: dict) -> dict:
        asked.append(e)
        if e["mode"] == "form":
            return {"action": "accept", "content": {"reorder": True, "fulfilment": "delivery"}}
        return {"action": "accept"}

    events = turn(sim, "sam", "Reorder it", answer)
    assert [c["name"] for c in of(events, "tool_call")] == ["request_refill"]
    assert [e["mode"] for e in asked] == ["form", "url"]
    assert "Should I reorder Amlodipine 5 mg, 30 tablets" in asked[0]["message"]
    assert asked[0]["requestedSchema"]["properties"]["reorder"]["type"] == "boolean"
    checkout_url = asked[1]["url"]
    assert checkout_url.startswith(f"{mcp_server}/checkout/")
    result = of(events, "tool_result")[0]["structuredContent"]
    assert result["result"] == "checkout_ready"
    assert result["checkoutUrl"] == checkout_url
    said = speech(events)
    assert "I've started a refill of Amlodipine 5 mg" in said
    assert "http" not in said and "checkout/" not in said
    rpc_methods = [(e["dir"], e["method"]) for e in of(events, "rpc")]
    assert ("in", "elicitation/create") in rpc_methods
    assert ("out", "elicitation/create") in rpc_methods

    # Place the order on the checkout page, as the browser would.
    placed = httpx.post(
        checkout_url,
        data={"action": "place", "fulfilment": "delivery"},
        headers={"Origin": mcp_server},
        follow_redirects=False,
    )
    assert placed.status_code == 303

    # The server tells the session the URL elicitation is complete; it shows in the protocol log.
    log = httpx.get(f"{sim}/rpc", params={"profile": "sam"}).json()["entries"]
    assert any(e["method"] == "notifications/elicitation/complete" for e in log)

    update = turn(sim, "sam", "Any updates?")
    assert "A refill arrives tomorrow." in speech(update)


def test_declined_form_orders_nothing(sim: str) -> None:
    events = turn(sim, "rose", "Reorder my blood pressure tablets", lambda e: {"action": "decline"})
    # Sam's order from line 4 already covers it, or Rose declines: either way nothing new is ordered.
    assert of(events, "tool_result")[0]["structuredContent"]["result"] in ("already_ordered", "declined")


def test_safe_refusal_needs_no_tool(sim: str) -> None:
    events = turn(sim, "rose", "Should I take an extra blood pressure tablet?")
    assert of(events, "tool_call") == []
    assert speech(events) == SAFE_REFUSAL


def test_unknown_profile_and_elicitation(sim: str) -> None:
    assert httpx.post(f"{sim}/turn", json={"profile": "eve", "text": "hi"}).status_code == 404
    assert httpx.post(f"{sim}/elicitation/nope", json={"action": "accept"}).status_code == 404


def test_router_covers_the_demo_script() -> None:
    assert route("Good morning", None).tool == "get_care_status"
    assert route("I took my morning pills", None).tool == "log_medication"
    assert route("How is Mom today?", None).tool == "get_care_status"
    assert route("Is she running low on anything?", None).tool == "check_refills"
    assert route("Reorder it", None).tool == "request_refill"
    assert route("Any updates?", None).tool == "get_care_status"
    assert route("I had a fall in the kitchen", None).tool == "log_wellbeing"
    assert route("Should I take an extra blood pressure tablet?", None).tool is None
    assert route("What do I take tonight?", None).arguments == {"when": "night"}


def test_line5_sam_books_a_cardiology_follow_up_and_a_ride(sim: str) -> None:
    asked: list[dict] = []

    def pick_first(e: dict) -> dict:
        asked.append(e)
        return {"action": "accept", "content": {"option": e["requestedSchema"]["properties"]["option"]["oneOf"][0]["const"]}}

    events = turn(sim, "sam", "Book Mom's cardiology follow-up next week, mornings only, and sort out a ride.", pick_first)
    call = of(events, "tool_call")[0]
    assert call["name"] == "coordinate_appointment"
    assert call["arguments"] == {"specialty": "cardiology follow-up", "window": "next week", "constraints": "mornings only"}
    options = asked[0]["requestedSchema"]["properties"]["option"]["oneOf"]
    assert [o["title"] for o in options] == [
        "Tue 10:30 am with Dr Rao, Maya drives",
        "Thu 9:15 am with Dr Mehta, Maya drives",
        "Thu 11:30 am with Dr Rao, Maya drives",
    ]
    assert of(events, "tool_result")[0]["structuredContent"]["result"] == "booked"
    assert speech(events) == (
        "Booked: Rose's cardiology follow-up with Dr Rao at Riverside Heart Clinic, Tuesday at 10:30 am. "
        "Maya is driving, leaving at 10:05 am."
    )

    # It shows up for the family, and Maya hears she's driving.
    assert "You're driving." in speech(turn(sim, "maya", "How is Mom today?"))


def test_router_sends_preferences_and_bookings_to_the_right_tools() -> None:
    assert route("Mom prefers mornings", None).tool == "set_care_preference"
    assert route("Mom prefers mornings", None).arguments == {"preference": "Mom prefers mornings"}
    assert route("Forget Mom's appointment preferences", None).arguments["forget"] is True
    book = route("Book Mom's cardiology follow-up next week, mornings only, and sort out a ride.", None)
    assert (book.tool, book.arguments["specialty"]) == ("coordinate_appointment", "cardiology follow-up")
    # Still the medication schedule, not a booking.
    assert route("What's her schedule tonight?", None).tool == "list_medications"
