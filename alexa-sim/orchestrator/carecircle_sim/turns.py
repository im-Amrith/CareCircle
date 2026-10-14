"""Runs one conversational turn: choose a tool (Bedrock or the mock router), call it over MCP, speak.

Events go out on the profile's bus channel; app.py streams them to the browser.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import re
from collections.abc import Callable
from typing import Any

from .agent import AgentPool
from .bus import Bus
from .config import Settings
from .mcp_link import ProfileLink
from .router import route
from .speech import Speech

log = logging.getLogger("carecircle.turns")

Emit = Callable[[str, dict[str, Any]], None]


def _short(err: BaseException) -> str:
    return re.sub(r"\s+", " ", f"{type(err).__name__}: {err}")[:240]


def spoken(text: str) -> str:
    """Last line of defence: no URLs or Markdown in anything spoken."""
    text = re.sub(r"https?://\S+", "the link on screen", text)
    text = re.sub(r"[*_#`|>]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


class TurnRunner:
    def __init__(self, settings: Settings, bus: Bus, speech: Speech, agents: AgentPool | None) -> None:
        self.settings, self.bus, self.speech, self.agents = settings, bus, speech, agents

    async def run(self, link: ProfileLink, text: str) -> None:
        def emit(kind: str, data: dict[str, Any]) -> None:
            self.bus.publish(link.profile, kind, data)

        emit("transcript", {"profile": link.profile, "text": text})
        await link.ensure_started()

        reply: str | None = None
        if self.agents is not None:
            reply = await self._bedrock(link, text, emit)
        if reply is None:
            reply = await self._mock(link, text)

        reply = spoken(reply) or "Sorry, I didn't catch that."
        audio = None
        if self.speech.mode == "polly":
            try:
                audio = await asyncio.to_thread(self.speech.synthesize, reply)
            except Exception as err:  # noqa: BLE001
                emit("warning", {"source": "polly", "message": f"Amazon Polly failed, using browser speech. {_short(err)}"})
        emit("speech", {"text": reply, **({"audio": audio, "format": "mp3", "voice": self.speech.voice} if audio else {})})

    async def _mock(self, link: ProfileLink, text: str) -> str:
        plan = route(text, link.last_result)
        if plan.tool is None:
            return plan.reply or ""
        result = await link.call_tool(plan.tool, plan.arguments)
        return result.text

    async def _bedrock(self, link: ProfileLink, text: str, emit: Emit) -> str | None:
        """Returns the reply, or None to fall back to the mock router (after a warning)."""
        assert self.agents is not None
        agent = self.agents.get(link.profile, self.settings.profiles[link.profile]["about"], link.tools)
        snapshot = copy.deepcopy(agent.messages)
        before = link.last_result
        try:
            result = await agent.invoke_async(text)
            reply = str(result).strip()
            if not reply:
                raise RuntimeError("Bedrock returned an empty reply")
            return reply
        except Exception as err:  # noqa: BLE001 - any Bedrock failure falls back
            log.warning("Bedrock turn failed for %s: %s", link.profile, err)
            agent.messages[:] = snapshot  # never keep a half-finished tool exchange in history
            emit("warning", {"source": "bedrock", "message": f"AWS Bedrock failed, so this turn used the offline router. {_short(err)}"})
            after = link.last_result
            if after is not None and after is not before:
                # A tool already ran this turn: don't repeat it, just say its result.
                return after.text
            return None
