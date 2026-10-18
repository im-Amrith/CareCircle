"""Per-profile event bus.

MCP traffic is observed on each MCP client's background thread; turns run on the
FastAPI event loop. The bus hops events onto the app loop thread-safely and fans
them out to whoever is listening (the open /turn stream), and keeps a protocol log
backlog so the browser can reload it.
"""

from __future__ import annotations

import asyncio
import itertools
import threading
from collections import defaultdict, deque
from typing import Any

Event = tuple[str, dict[str, Any]]


class Bus:
    def __init__(self, backlog: int = 500) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self._subs: dict[str, set[asyncio.Queue[Event]]] = defaultdict(set)
        self._rpc: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=backlog))
        self._seq = itertools.count(1)
        self._lock = threading.Lock()

    def next_seq(self) -> int:
        with self._lock:
            return next(self._seq)

    def publish(self, profile: str, kind: str, data: dict[str, Any]) -> None:
        """Safe to call from any thread."""
        if kind == "rpc":
            with self._lock:
                self._rpc[profile].append(data)
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._fan_out(profile, (kind, data))
        else:
            loop.call_soon_threadsafe(self._fan_out, profile, (kind, data))

    def _fan_out(self, profile: str, event: Event) -> None:
        for q in list(self._subs[profile]):
            q.put_nowait(event)

    def subscribe(self, profile: str) -> asyncio.Queue[Event]:
        q: asyncio.Queue[Event] = asyncio.Queue()
        self._subs[profile].add(q)
        return q

    def unsubscribe(self, profile: str, q: asyncio.Queue[Event]) -> None:
        self._subs[profile].discard(q)

    def has_listeners(self, profile: str) -> bool:
        return bool(self._subs[profile])

    def rpc_backlog(self, profile: str, after: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            return [e for e in self._rpc[profile] if e["seq"] > after]
