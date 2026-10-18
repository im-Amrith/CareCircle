"""Things the device says without being asked, the way an Echo announces a notification.

- Safety alerts: when the family's `today` resource shows a red flag someone else logged,
  every other family device announces it once.
- Gentle reminders: when the person being cared for has an overdue dose and their device
  has been quiet for a while, it asks whether they've taken it. A "yes" logs it.

The server decides what an alert or reminder says (in the listener's language); the
simulator only decides when to say it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .agent import AgentPool
from .bus import Bus
from .mcp_link import LastResult, Links, ProfileLink
from .turns import TurnRunner

log = logging.getLogger("carecircle.proactive")


class Proactive:
    def __init__(self, links: Links, bus: Bus, runner: TurnRunner, agents: AgentPool | None, locks: dict[str, asyncio.Lock], idle_s: float) -> None:
        self.links, self.bus, self.runner, self.agents, self.locks, self.idle_s = links, bus, runner, agents, locks, idle_s

    async def on_today(self, link: ProfileLink) -> None:
        for alert in link.new_alerts():
            extra, _ = await self.runner.voice(link, alert["text"], slow=False)
            self.bus.publish(link.profile, "announcement", {"kind": "alert", "id": alert["id"], "text": alert["text"], **extra})

    async def remind(self, link: ProfileLink, force: bool = False) -> dict[str, Any] | None:
        """Says the current reminder, if there is one. Without force: once per dose slot, only when idle."""
        reminder = (link.today or {}).get("reminder")
        if not reminder:
            return None
        if not force:
            busy = self.locks[link.profile].locked()
            idle = time.time() - link.last_activity >= self.idle_s
            if reminder["key"] in link.reminded or busy or not idle or not self.bus.has_listeners(link.profile):
                return None
        link.reminded.add(reminder["key"])
        text = reminder["text"]
        # A following "yes" logs these doses (mock router), and the model sees what was asked (Bedrock).
        link.last_result = LastResult(name="reminder", text=text, structured={"medicationIds": reminder["medicationIds"]}, is_error=False)
        link.last_reply = text
        link.last_activity = time.time()
        if self.agents is not None:
            self.agents.note_proactive(link.profile, text)
        extra, _ = await self.runner.voice(link, text, slow=False)
        event = {"kind": "reminder", "id": reminder["key"], "text": text, **extra}
        self.bus.publish(link.profile, "announcement", event)
        return event

    async def loop(self) -> None:
        if self.idle_s <= 0:
            return
        while True:
            await asyncio.sleep(5)
            for link in self.links.all():
                if not link.connected:
                    continue
                try:
                    await self.remind(link)
                except Exception:  # noqa: BLE001 - a reminder must never take the loop down
                    log.exception("reminder failed for %s", link.profile)
