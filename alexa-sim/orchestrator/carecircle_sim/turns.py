"""Runs one conversational turn: choose a tool (Bedrock or the mock router), call it over MCP, speak.

Events go out on the profile's bus channel; app.py streams them to the browser.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import re
import time
from collections.abc import Callable
from typing import Any

from .agent import AgentPool
from .bus import Bus
from .config import Settings
from .mcp_link import ProfileLink
from .router import NOTHING_TO_REPEAT, NOTHING_TO_REPEAT_HI, is_repeat, route
from .speech import Speech

log = logging.getLogger("carecircle.turns")

Emit = Callable[[str, dict[str, Any]], None]


def _short(err: BaseException) -> str:
    return re.sub(r"\s+", " ", f"{type(err).__name__}: {err}")[:240]


def language_of(text: str) -> str:
    """Hindi if the reply is written in Devanagari. The person's preference can change mid-turn
    (set_language), so speech follows what was actually said."""
    return "hi" if re.search(r"[ऀ-ॿ]", text) else "en"


def spoken(text: str) -> str:
    """Last line of defence: no URLs or Markdown in anything spoken."""
    text = re.sub(r"https?://\S+", "the link on screen", text)
    text = re.sub(r"[*_#`|>]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


class TurnRunner:
    def __init__(self, settings: Settings, bus: Bus, speech: Speech, agents: AgentPool | None) -> None:
        self.settings, self.bus, self.speech, self.agents = settings, bus, speech, agents

    async def run(self, link: ProfileLink, text: str, slow: bool = False) -> None:
        def emit(kind: str, data: dict[str, Any]) -> None:
            self.bus.publish(link.profile, kind, data)

        link.last_activity = time.time()
        emit("transcript", {"profile": link.profile, "text": text})
        await link.ensure_started()
        try:
            if is_repeat(text):
                # "Say that again": the same words, a little slower, and no tool call.
                reply = link.last_reply or (NOTHING_TO_REPEAT_HI if link.language == "hi" else NOTHING_TO_REPEAT)
                await self.say(link, reply, slow=True, repeat=True)
                return

            reply: str | None = None
            if self.agents is not None:
                reply = await self._bedrock(link, text, emit)
            if reply is None:
                reply = await self._mock(link, text)

            reply = spoken(reply) or "Sorry, I didn't catch that."
            link.last_reply = reply
            await self.say(link, reply, slow=slow)
        finally:
            link.last_activity = time.time()

    async def voice(self, link: ProfileLink, text: str, slow: bool) -> tuple[dict[str, Any], str | None]:
        """Polly audio for `text` in its language, or None for browser speech, plus a warning if Polly failed."""
        lang = language_of(text)
        extra: dict[str, Any] = {"lang": lang, "slow": slow}
        if not self.speech.can_speak(lang):
            return extra, None
        try:
            audio = await asyncio.to_thread(self.speech.synthesize, text, lang, slow)
        except Exception as err:  # noqa: BLE001
            return extra, f"Amazon Polly failed, using browser speech. {_short(err)}"
        if audio:
            extra.update({"audio": audio, "format": "mp3", "voice": self.speech.voice})
        return extra, None

    async def say(self, link: ProfileLink, reply: str, slow: bool = False, repeat: bool = False) -> None:
        extra, warning = await self.voice(link, reply, slow)
        if warning:
            self.bus.publish(link.profile, "warning", {"source": "polly", "message": warning})
        self.bus.publish(link.profile, "speech", {"text": reply, **extra, **({"repeat": True} if repeat else {})})

    async def _mock(self, link: ProfileLink, text: str) -> str:
        plan = route(text, link.last_result, link.language)
        if plan.tool is None:
            return plan.reply or ""
        result = await link.call_tool(plan.tool, plan.arguments)
        return result.text

    async def _bedrock(self, link: ProfileLink, text: str, emit: Emit) -> str | None:
        """Returns the reply, or None to fall back to the mock router (after a warning)."""
        assert self.agents is not None
        agent = self.agents.get(link.profile, self.settings.profiles[link.profile]["about"], link.tools, link.language)
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
