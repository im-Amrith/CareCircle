"""The care team (Strands Graph) in mock mode: deterministic nodes, real Graph. No AWS calls."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from carecircle_sim import care_team
from carecircle_sim.care_team import ScriptedNode, plan_appointment

WEEK = {
    "2026-10-12": ("Monday", [("09:30", "Dr Mehta"), ("14:00", "Dr Rao")]),
    "2026-10-13": ("Tuesday", [("10:30", "Dr Rao"), ("15:00", "Dr Mehta")]),
    "2026-10-14": ("Wednesday", [("11:00", "Dr Rao"), ("16:00", "Dr Rao")]),
    "2026-10-15": ("Thursday", [("09:15", "Dr Mehta"), ("11:30", "Dr Rao"), ("14:30", "Dr Mehta")]),
    "2026-10-16": ("Friday", [("10:00", "Dr Mehta"), ("15:30", "Dr Rao")]),
}
MAYA = [{"id": "maya", "name": "Maya"}]


def brief(earliest: str = "08:00", latest: str = "17:00", weekdays: list[int] | None = None, understood: list[str] | None = None) -> dict[str, Any]:
    """The same facts the MCP server sends: Maya can drive on Tuesday and Thursday mornings."""
    slots = []
    for day, (name, times) in WEEK.items():
        for t, doctor in times:
            morning = int(t[:2]) < 12
            slots.append({
                "id": f"{day}T{t}-riverside-heart-{doctor.lower().replace(' ', '-')}",
                "date": day,
                "day": name,
                "time": t,
                "doctor": doctor,
                "leaveAt": "",
                "drivers": MAYA if name in ("Tuesday", "Thursday") and morning else [],
            })
    return {
        "recipient": "Rose",
        "specialty": "cardiology follow-up",
        "window": {"from": "2026-10-12", "to": "2026-10-18", "label": "next week"},
        "constraints": {"earliest": earliest, "latest": latest, "weekdays": weekdays or [], "understood": understood or []},
        "clinic": {"id": "riverside-heart", "name": "Riverside Heart Clinic", "specialty": "cardiology"},
        "travelMinutes": 25,
        "maxOptions": 3,
        "slots": slots,
    }


def test_mock_planner_returns_three_morning_options_from_the_graph(sim: str) -> None:
    r = httpx.post(f"{sim}/plan/appointment", json=brief(latest="11:59", understood=["mornings"]), timeout=30)
    assert r.status_code == 200
    body = r.json()
    assert body["engine"] == "strands-graph:deterministic"
    assert [(o["slotId"][:16], o["driverId"]) for o in body["options"]] == [
        ("2026-10-13T10:30", "maya"),
        ("2026-10-15T09:15", "maya"),
        ("2026-10-15T11:30", "maya"),
    ]
    assert all(int(o["slotId"][11:13]) < 12 for o in body["options"])
    assert body["options"][0]["reason"] == "Earliest slot with a driver, and Maya is free Tuesday morning."
    # Every agent ran: the coordinator first, the three specialists, then the planner.
    order = [t["node"] for t in body["trace"]]
    assert order[0] == "coordinator" and order[-1] == "planner"
    assert sorted(order[1:4]) == ["calendar", "clinic", "transport"]
    assert "Wanted: mornings" in body["trace"][0]["said"]


def test_mock_planner_respects_days_and_falls_back_to_a_taxi() -> None:
    # Afternoons, not Thursday (weekdays as the server sends them: 0 = Sunday).
    result = asyncio.run(plan_appointment(brief(earliest="12:00", weekdays=[1, 2, 3, 5]), bedrock=None))
    days = [o["slotId"][:10] for o in result["options"]]
    assert "2026-10-15" not in days
    assert all(o["driverId"] is None for o in result["options"])
    assert result["options"][0]["reason"].startswith("No one in the family is free then, so a taxi")


def test_bad_briefs_are_rejected(sim: str) -> None:
    assert httpx.post(f"{sim}/plan/appointment", json={"slots": "nope"}, timeout=10).status_code == 400


class Talkative(ScriptedNode):
    """Stands in for a Bedrock agent: chatty text, and the planner wraps its JSON in prose."""

    def _result(self, invocation_state: dict[str, Any] | None) -> Any:
        result = super()._result(invocation_state)
        if self.name == "planner":
            text = result.message["content"][0]["text"]
            result.message["content"][0]["text"] = f"Here are the best options:\n```json\n{text}\n```\nLet me know!"
        return result


class Failing(ScriptedNode):
    def _result(self, invocation_state: dict[str, Any] | None) -> Any:
        raise RuntimeError("ThrottlingException: Too many requests")


def test_bedrock_team_output_is_parsed_and_failures_fall_back(monkeypatch: Any) -> None:
    monkeypatch.setattr(care_team, "_bedrock_node", lambda name, *_: Talkative(name))
    ok = asyncio.run(plan_appointment(brief(latest="11:59"), bedrock=("global.amazon.nova-2-lite-v1:0", "ap-southeast-2")))
    assert ok["engine"] == "strands-graph:bedrock:global.amazon.nova-2-lite-v1:0"
    assert len(ok["options"]) == 3

    monkeypatch.setattr(care_team, "_bedrock_node", lambda name, *_: Failing(name))
    fell_back = asyncio.run(plan_appointment(brief(latest="11:59"), bedrock=("global.amazon.nova-2-lite-v1:0", "ap-southeast-2")))
    assert fell_back["engine"].startswith("strands-graph:deterministic (fallback:")
    assert [o["slotId"] for o in fell_back["options"]] == [o["slotId"] for o in ok["options"]]


def test_bedrock_agents_tools_ground_them_in_the_brief() -> None:
    import json
    from types import SimpleNamespace

    ctx = SimpleNamespace(invocation_state={"brief": brief(latest="11:59")})
    fitting = json.loads(care_team.slots_that_fit(tool_context=ctx))
    assert [s["day"] for s in fitting] == ["Monday", "Tuesday", "Wednesday", "Thursday", "Thursday", "Friday"]
    ordered = json.loads(care_team.candidates(tool_context=ctx))
    assert [(c["day"], c["time"], bool(c["drivers"])) for c in ordered[:4]] == [
        ("Tuesday", "10:30", True),
        ("Thursday", "09:15", True),
        ("Thursday", "11:30", True),
        ("Monday", "09:30", False),
    ]
    rides = json.loads(care_team.ride_plan(tool_context=ctx))
    assert {r["ride"] for r in rides} == {"Maya drives", "taxi"}
