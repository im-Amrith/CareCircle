"""The care team: a Strands multi-agent Graph that plans appointment options.

    coordinator --+--> clinic ------+
                  +--> calendar ----+--> planner
                  +--> transport ---+

The MCP server gathers the facts (open slots, who is free to drive, travel time), sends
them here as a brief, and owns everything after: the task, the picker and the booking.
The team only ranks, and the server re-checks every pick against the facts.

In AWS mode each node is a Strands Agent on Amazon Bedrock (Nova 2 Lite). In mock mode,
and as the fallback when Bedrock fails, the same Graph runs with deterministic nodes,
so the same brief always gets the same three options.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import AsyncIterator, Callable
from datetime import date
from typing import Any

from strands import Agent, tool
from strands.agent.agent_result import AgentResult
from strands.types.tools import ToolContext
from strands.models import BedrockModel
from strands.multiagent import GraphBuilder
from strands.telemetry.metrics import EventLoopMetrics

log = logging.getLogger("carecircle.care_team")

NODES = ("coordinator", "clinic", "calendar", "transport", "planner")
PARALLEL = ("clinic", "calendar", "transport")
TIMEOUT_S = 60

# ---------- deterministic nodes ----------


def _weekday(iso: str) -> int:
    """0 = Sunday ... 6 = Saturday, as the server counts."""
    return (date.fromisoformat(iso).weekday() + 1) % 7


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _spoken(hhmm: str) -> str:
    h, m = (int(x) for x in hhmm.split(":"))
    suffix = "am" if h < 12 else "pm"
    h12 = h % 12 or 12
    return f"{h12} {suffix}" if m == 0 else f"{h12}:{m:02d} {suffix}"


def fits(slot: dict[str, Any], constraints: dict[str, Any]) -> bool:
    t = _minutes(slot["time"])
    days = constraints.get("weekdays") or []
    return _minutes(constraints.get("earliest", "00:00")) <= t <= _minutes(constraints.get("latest", "23:59")) and (
        not days or _weekday(slot["date"]) in days
    )


def rank(brief: dict[str, Any]) -> list[dict[str, Any]]:
    """Fitting slots, a family driver before a taxi, then earliest; up to maxOptions, each with a reason."""
    fitting = [s for s in brief["slots"] if fits(s, brief.get("constraints", {}))]
    fitting.sort(key=lambda s: (not s.get("drivers"), s["date"], s["time"]))
    picks = []
    for i, s in enumerate(fitting[: brief.get("maxOptions", 3)]):
        driver = (s.get("drivers") or [None])[0]
        part = "morning" if _minutes(s["time"]) < 12 * 60 else "afternoon"
        if driver:
            reason = f"{'Earliest slot with a driver, and ' if i == 0 else ''}{driver['name']} is free {s['day']} {part}."
        else:
            reason = f"No one in the family is free then, so a taxi, about {brief.get('travelMinutes', 25)} minutes each way."
        picks.append({"slotId": s["id"], "driverId": driver["id"] if driver else None, "reason": reason[0].upper() + reason[1:]})
    return picks


def _coordinator(brief: dict[str, Any], _state: dict[str, Any]) -> str:
    c, w = brief.get("constraints", {}), brief["window"]
    wanted = ", ".join(c.get("understood") or []) or "any time"
    return (
        f"Plan {brief['recipient']}'s {brief['specialty']} at {brief['clinic']['name']}, {w['label']} "
        f"({w['from']} to {w['to']}). Wanted: {wanted}. {len(brief['slots'])} open slots to check."
    )


def _clinic(brief: dict[str, Any], state: dict[str, Any]) -> str:
    ok = [s for s in brief["slots"] if fits(s, brief.get("constraints", {}))]
    state["fitting"] = [s["id"] for s in ok]
    return "Slots that fit: " + ("; ".join(f"{s['day']} {_spoken(s['time'])} with {s['doctor']}" for s in ok) or "none") + "."


def _calendar(brief: dict[str, Any], _state: dict[str, Any]) -> str:
    free = [f"{s['day']} {_spoken(s['time'])}: {', '.join(d['name'] for d in s['drivers'])}" for s in brief["slots"] if s.get("drivers")]
    return "Free to drive: " + ("; ".join(free) or "nobody this week") + "."


def _transport(brief: dict[str, Any], _state: dict[str, Any]) -> str:
    return f"About {brief.get('travelMinutes', 25)} minutes each way. Leave that long before the slot; a taxi when no one can drive."


def _planner(brief: dict[str, Any], _state: dict[str, Any]) -> str:
    return json.dumps({"options": rank(brief)})


SCRIPTS: dict[str, Callable[[dict[str, Any], dict[str, Any]], str]] = {
    "coordinator": _coordinator,
    "clinic": _clinic,
    "calendar": _calendar,
    "transport": _transport,
    "planner": _planner,
}


class ScriptedNode:
    """A deterministic Graph node (Strands AgentBase): same brief, same answer."""

    def __init__(self, name: str) -> None:
        self.name = name
        self._script = SCRIPTS[name]

    def _result(self, invocation_state: dict[str, Any] | None) -> AgentResult:
        state = invocation_state if invocation_state is not None else {}
        text = self._script(state["brief"], state)
        return AgentResult(
            stop_reason="end_turn",
            message={"role": "assistant", "content": [{"text": text}]},
            metrics=EventLoopMetrics(),
            state={},
        )

    async def stream_async(self, prompt: Any = None, *, invocation_state: dict[str, Any] | None = None, **_: Any) -> AsyncIterator[Any]:
        yield {"result": self._result(invocation_state)}

    async def invoke_async(self, prompt: Any = None, *, invocation_state: dict[str, Any] | None = None, **_: Any) -> AgentResult:
        return self._result(invocation_state)

    def __call__(self, prompt: Any = None, *, invocation_state: dict[str, Any] | None = None, **_: Any) -> AgentResult:
        return self._result(invocation_state)


# ---------- Bedrock nodes ----------
#
# Each specialist reads its facts through a tool over the brief, rather than by eye from a
# long JSON prompt: on Nova 2 Lite, reading the slots by eye missed half the fitting ones
# (friction log FL-14). The models still decide what matters and write the reasons.


def _brief(ctx: ToolContext) -> dict[str, Any]:
    return ctx.invocation_state["brief"]


def _fitting(b: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted((s for s in b["slots"] if fits(s, b.get("constraints", {}))), key=lambda s: (s["date"], s["time"]))


@tool(context=True)
def slots_that_fit(tool_context: ToolContext) -> str:
    """The clinic's open slots that fit the request's time of day and days, earliest first."""
    return json.dumps([{k: s[k] for k in ("id", "day", "date", "time", "doctor")} for s in _fitting(_brief(tool_context))])


@tool(context=True)
def who_can_drive(tool_context: ToolContext) -> str:
    """For each slot that fits, the family members free to drive for the whole round trip (empty means nobody)."""
    return json.dumps([{"id": s["id"], "day": s["day"], "time": s["time"], "drivers": s.get("drivers", [])} for s in _fitting(_brief(tool_context))])


@tool(context=True)
def ride_plan(tool_context: ToolContext) -> str:
    """For each slot that fits: when to leave home, and whether a family member drives or a taxi is needed."""
    b = _brief(tool_context)
    return json.dumps([
        {"id": s["id"], "leaveAt": s.get("leaveAt"), "ride": f"{s['drivers'][0]['name']} drives" if s.get("drivers") else "taxi", "travelMinutes": b.get("travelMinutes")}
        for s in _fitting(b)
    ])


@tool(context=True)
def candidates(tool_context: ToolContext) -> str:
    """Every slot that fits, in the family's order of preference: a family member driving first, then earliest."""
    b = _brief(tool_context)
    ordered = sorted(_fitting(b), key=lambda s: (not s.get("drivers"), s["date"], s["time"]))
    return json.dumps([{k: s.get(k) for k in ("id", "day", "date", "time", "doctor", "drivers")} for s in ordered])


ROLES = {
    "coordinator": (
        "You coordinate a family care team booking a doctor's appointment for an older parent. "
        "Restate the request in two or three short lines: who, which specialty, the date window, and the "
        "constraints (time of day and days). Never give medical advice."
    ),
    "clinic": "You are the clinic specialist. Call slots_that_fit, then list those slots in one short line each: day, time, doctor.",
    "calendar": "You are the family calendar specialist. Call who_can_drive, then say in one short line per slot who can drive, or nobody.",
    "transport": "You are the transport specialist. Call ride_plan, then say in one short line per slot when to leave home and how Rose gets there.",
    "planner": (
        "You are the planner. Call candidates: it lists every slot that fits, already in the family's order of "
        "preference (a family member driving first, then earliest). Choose up to {max}, keeping that order unless "
        "your team's notes give a clear reason to change it. Use only slot ids and driver ids from candidates, and "
        "only a driver listed for that slot (null for a taxi). Give each a true one-line reason; call the first "
        "pick the earliest slot with a driver, never just the earliest, unless no fitting slot is earlier. Reply with JSON only, no prose: "
        '{{"options": [{{"slotId": "...", "driverId": "maya or null", "reason": "one short sentence"}}]}}'
    ),
}

TOOLS = {"clinic": [slots_that_fit], "calendar": [who_can_drive], "transport": [ride_plan], "planner": [candidates]}


def _bedrock_node(name: str, model_id: str, region: str, max_options: int) -> Agent:
    model = BedrockModel(model_id=model_id, region_name=region, temperature=0, max_tokens=900)
    return Agent(name=name, model=model, system_prompt=ROLES[name].format(max=max_options), tools=TOOLS.get(name, []), callback_handler=None)


# ---------- the Graph ----------


def build_graph(make_node: Callable[[str], Any]):
    b = GraphBuilder()
    for name in NODES:
        b.add_node(make_node(name), name)
    for name in PARALLEL:
        b.add_edge("coordinator", name)
        b.add_edge(name, "planner")
    b.set_entry_point("coordinator")
    b.set_execution_timeout(TIMEOUT_S)
    return b.build()


def _json_object(text: str) -> dict[str, Any]:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("planner reply has no JSON object")
    return json.loads(m.group(0))


async def _run(brief: dict[str, Any], make_node: Callable[[str], Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    graph = build_graph(make_node)
    task = "Appointment planning brief (JSON):\n" + json.dumps(brief, ensure_ascii=False)
    result = await graph.invoke_async(task, invocation_state={"brief": brief})
    trace = [
        {"node": n.node_id, "ms": result.results[n.node_id].execution_time, "said": str(result.results[n.node_id].result)[:400]}
        for n in result.execution_order
    ]
    planned = _json_object(str(result.results["planner"].result)).get("options")
    if not isinstance(planned, list):
        raise ValueError("planner reply has no options list")
    return planned, trace


async def plan_appointment(brief: dict[str, Any], *, bedrock: tuple[str, str] | None) -> dict[str, Any]:
    """Runs the care team. `bedrock` is (model_id, region), or None for the deterministic team."""
    started = time.monotonic()
    if bedrock:
        model_id, region = bedrock
        try:
            options, trace = await _run(brief, lambda n: _bedrock_node(n, model_id, region, brief.get("maxOptions", 3)))
            return {"engine": f"strands-graph:bedrock:{model_id}", "options": options, "trace": trace, "ms": int((time.monotonic() - started) * 1000)}
        except Exception as err:  # noqa: BLE001 - any model failure falls back to the deterministic team
            log.warning("care team on Bedrock failed, using the deterministic team: %s", err)
            fallback = f" (fallback: {type(err).__name__})"
    else:
        fallback = ""
    options, trace = await _run(brief, ScriptedNode)
    return {"engine": "strands-graph:deterministic" + fallback, "options": options, "trace": trace, "ms": int((time.monotonic() - started) * 1000)}
