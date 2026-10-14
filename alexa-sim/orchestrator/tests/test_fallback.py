"""When Bedrock fails, the turn warns and falls back to the mock router. No AWS calls."""

from __future__ import annotations

import asyncio
from typing import Any

from carecircle_sim.bus import Bus
from carecircle_sim.config import Settings
from carecircle_sim.mcp_link import ElicitationBroker, ProfileLink
from carecircle_sim.speech import Speech
from carecircle_sim.turns import TurnRunner


class FailingAgent:
    def __init__(self) -> None:
        self.messages: list[Any] = [{"role": "user", "content": [{"text": "earlier"}]}]

    async def invoke_async(self, _text: str) -> Any:
        self.messages.append({"role": "user", "content": [{"text": "half-finished"}]})
        raise RuntimeError("ThrottlingException: Too many requests")


class FailingPool:
    def __init__(self) -> None:
        self.agent = FailingAgent()

    def get(self, *_args: Any) -> FailingAgent:
        return self.agent


def test_bedrock_failure_falls_back_with_a_warning(mcp_server: str) -> None:
    async def run() -> tuple[list[tuple[str, dict]], FailingPool]:
        bus = Bus()
        bus.loop = asyncio.get_running_loop()
        link = ProfileLink("maya", f"{mcp_server}/mcp", bus, ElicitationBroker())
        pool = FailingPool()
        runner = TurnRunner(Settings(mock_aws=False), bus, Speech(), pool)  # type: ignore[arg-type]
        queue = bus.subscribe("maya")
        try:
            await runner.run(link, "How is Mom today?")
            await asyncio.sleep(0.05)
        finally:
            await link.stop()
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
        return events, pool

    events, pool = asyncio.run(run())
    warnings = [d for k, d in events if k == "warning"]
    assert len(warnings) == 1
    assert warnings[0]["source"] == "bedrock"
    assert warnings[0]["message"].startswith("AWS Bedrock failed, so this turn used the offline router.")
    assert "ThrottlingException" in warnings[0]["message"]
    assert [d["name"] for k, d in events if k == "tool_call"] == ["get_care_status"]
    speech = [d for k, d in events if k == "speech"][0]["text"]
    assert speech.startswith("Rose has taken")
    # The failed exchange is not kept in the agent's history.
    assert pool.agent.messages == [{"role": "user", "content": [{"text": "earlier"}]}]
