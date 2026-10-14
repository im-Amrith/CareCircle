"""One MCP session per family member, as a standard MCP client.

Each profile gets a Strands `MCPClient` (Streamable HTTP, `Authorization: Bearer
dev:<profile>`) that advertises form and URL elicitation. The transport is wrapped
so every JSON-RPC message in either direction lands in the protocol log, and the
UI's tool_call / tool_result events are derived from that same wire traffic, so
they look the same whether Bedrock or the mock router chose the tool.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from mcp import types
from strands.tools.mcp import MCPClient
from strands.tools.mcp.mcp_client import streamable_http_transport

from . import __version__
from .bus import Bus

log = logging.getLogger("carecircle.mcp")

CLIENT_NAME = "CareCircle Alexa+ Simulator"
ELICITATION_TIMEOUT_S = 600

# MCP Apps (spec 2026-01-26): the simulator renders `ui://` views, so it declares the extension.
UI_EXTENSION = "io.modelcontextprotocol/ui"
UI_MIME_TYPE = "text/html;profile=mcp-app"
# Marks tools/call requests that came from an MCP App view rather than the model.
APP_ORIGIN_META = "carecircle.sim/origin"


class AppToolDenied(Exception):
    """The view asked for a tool whose `_meta.ui.visibility` doesn't include "app"."""


def app_visible(meta: dict[str, Any]) -> bool:
    visibility = (meta.get("ui") or {}).get("visibility")
    return visibility is None or "app" in visibility  # the spec default is ["model", "app"]


def _dump(message: Any) -> dict[str, Any]:
    inner = getattr(message, "message", message)
    if hasattr(inner, "model_dump"):
        return inner.model_dump(by_alias=True, exclude_none=True, mode="json")
    return {"error": repr(inner)}


@dataclass
class PendingElicitation:
    id: str
    profile: str
    mode: str
    future: concurrent.futures.Future[tuple[str, dict[str, Any] | None]] = field(default_factory=concurrent.futures.Future)


class ElicitationBroker:
    """Elicitations waiting for the browser. Resolved from the app loop, awaited on an MCP thread."""

    def __init__(self) -> None:
        self._pending: dict[str, PendingElicitation] = {}
        self._lock = threading.Lock()

    def open(self, profile: str, mode: str) -> PendingElicitation:
        p = PendingElicitation(id=uuid.uuid4().hex[:12], profile=profile, mode=mode)
        with self._lock:
            self._pending[p.id] = p
        return p

    def resolve(self, elicitation_id: str, action: str, content: dict[str, Any] | None) -> bool:
        with self._lock:
            p = self._pending.pop(elicitation_id, None)
        if p is None or p.future.done():
            return False
        p.future.set_result((action, content))
        return True

    def cancel_profile(self, profile: str) -> None:
        """Cancels anything still waiting for this profile, e.g. when the browser goes away."""
        with self._lock:
            ids = [i for i, p in self._pending.items() if p.profile == profile]
        for i in ids:
            self.resolve(i, "cancel", None)

    def pending_ids(self, profile: str) -> list[str]:
        with self._lock:
            return [i for i, p in self._pending.items() if p.profile == profile]


class _LoggedRead:
    def __init__(self, inner: Any, link: ProfileLink) -> None:
        self._inner, self._link = inner, link

    def __aiter__(self) -> _LoggedRead:
        return self

    async def __anext__(self) -> Any:
        m = await self._inner.__anext__()
        self._link._observe("in", m)
        return m

    async def receive(self) -> Any:
        m = await self._inner.receive()
        self._link._observe("in", m)
        return m

    async def __aenter__(self) -> _LoggedRead:
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        return await self._inner.__aexit__(*exc)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _declare_ui_extension(m: Any) -> None:
    """Strands' MCPClient builds the ClientSession without a way to pass `extensions` (FL-11),
    so the simulator adds MCP Apps support to the initialize request on its way out."""
    inner = getattr(m, "message", None)
    if getattr(inner, "method", None) != "initialize" or not isinstance(getattr(inner, "params", None), dict):
        return
    caps = inner.params.setdefault("capabilities", {})
    caps.setdefault("extensions", {})[UI_EXTENSION] = {"mimeTypes": [UI_MIME_TYPE]}


class _LoggedWrite:
    def __init__(self, inner: Any, link: ProfileLink) -> None:
        self._inner, self._link = inner, link

    async def send(self, m: Any) -> None:
        _declare_ui_extension(m)
        self._link._observe("out", m)
        await self._inner.send(m)

    async def __aenter__(self) -> _LoggedWrite:
        await self._inner.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        return await self._inner.__aexit__(*exc)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _from_app(body: dict[str, Any]) -> bool:
    return ((body.get("params") or {}).get("_meta") or {}).get(APP_ORIGIN_META) == "app"


@dataclass
class LastResult:
    name: str
    text: str
    structured: dict[str, Any]
    is_error: bool


class ProfileLink:
    def __init__(self, profile: str, mcp_url: str, bus: Bus, broker: ElicitationBroker) -> None:
        self.profile = profile
        self.mcp_url = mcp_url
        self.bus = bus
        self.broker = broker
        self.last_result: LastResult | None = None
        self.tools: list[Any] = []
        self._tool_meta: dict[str, dict[str, Any]] = {}
        self._inflight: dict[tuple[str, Any], tuple[float, str, dict[str, Any]]] = {}
        self._ui_resources: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._client: MCPClient | None = None
        self._start_lock = asyncio.Lock()

    # ---------- lifecycle ----------

    @property
    def connected(self) -> bool:
        return self._client is not None

    def _transport(self) -> contextlib.AbstractAsyncContextManager[Any]:
        @contextlib.asynccontextmanager
        async def logged():
            async with streamable_http_transport(
                url=self.mcp_url, headers={"Authorization": f"Bearer dev:{self.profile}"}
            ) as streams:
                read, write, *rest = streams
                yield (_LoggedRead(read, self), _LoggedWrite(write, self), *rest)

        return logged()

    async def ensure_started(self) -> None:
        async with self._start_lock:
            if self._client is not None:
                return
            client = MCPClient(
                self._transport,
                application_name=CLIENT_NAME,
                application_version=__version__,
                elicitation_callback=self._on_elicit,
                startup_timeout=15,
            )
            await asyncio.to_thread(client.start)
            try:
                self.tools = await asyncio.to_thread(client.list_tools_sync)
            except Exception:
                await asyncio.to_thread(client.stop, None, None, None)
                raise
            self._client = client

    async def stop(self) -> None:
        client, self._client = self._client, None
        self.broker.cancel_profile(self.profile)
        if client is not None:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(client.stop, None, None, None)

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> LastResult:
        await self.ensure_started()
        assert self._client is not None
        result = await self._client.call_tool_async(f"sim-{uuid.uuid4().hex[:8]}", name, arguments or {})
        text = " ".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict)).strip()
        return LastResult(
            name=name,
            text=text,
            structured=dict(result.get("structuredContent") or {}),
            is_error=result.get("status") == "error",
        )

    # ---------- MCP Apps ----------

    async def ui_resource(self, uri: str) -> dict[str, Any]:
        """Reads a `ui://` view once per session; the protocol log shows the resources/read."""
        if not uri.startswith("ui://"):
            raise ValueError("MCP App views must use a ui:// URI")
        cached = self._ui_resources.get(uri)
        if cached is not None:
            return cached
        await self.ensure_started()
        assert self._client is not None
        result = await asyncio.to_thread(self._client.read_resource_sync, uri)
        page = next(
            (c for c in result.model_dump(by_alias=True, exclude_none=True, mode="json")["contents"] if c.get("mimeType") == UI_MIME_TYPE and "text" in c),
            None,
        )
        if page is None:
            raise ValueError(f"{uri} has no {UI_MIME_TYPE} content")
        ui = (page.get("_meta") or {}).get("ui") or {}
        view = {"uri": uri, "html": page["text"], "csp": ui.get("csp") or {}, "prefersBorder": ui.get("prefersBorder")}
        self._ui_resources[uri] = view
        return view

    async def app_call_tool(self, name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
        """A tools/call from an MCP App view, allowed only for tools visible to apps."""
        await self.ensure_started()
        assert self._client is not None
        if name not in self._tool_meta or not app_visible(self._tool_meta[name]):
            raise AppToolDenied(f"{name} is not available to apps")
        result = await self._client.call_tool_async(
            f"app-{uuid.uuid4().hex[:8]}", name, arguments or {}, meta={APP_ORIGIN_META: "app"}
        )
        out: dict[str, Any] = {
            "content": [{"type": "text", "text": c["text"]} for c in result.get("content", []) if isinstance(c, dict) and "text" in c],
            "isError": result.get("status") == "error",
        }
        if result.get("structuredContent") is not None:
            out["structuredContent"] = result["structuredContent"]
        return out

    # ---------- elicitation ----------

    async def _on_elicit(self, _ctx: Any, params: Any) -> types.ElicitResult:
        raw = params.model_dump(by_alias=True, exclude_none=True, mode="json")
        mode = raw.get("mode") or "form"
        pending = self.broker.open(self.profile, mode)
        event: dict[str, Any] = {"id": pending.id, "mode": mode, "message": raw.get("message", "")}
        if mode == "url":
            event["url"] = raw.get("url")
            event["elicitationId"] = raw.get("elicitationId")
        else:
            event["requestedSchema"] = raw.get("requestedSchema", {})
        self.bus.publish(self.profile, "elicitation", event)
        try:
            action, content = await asyncio.wait_for(asyncio.wrap_future(pending.future), ELICITATION_TIMEOUT_S)
        except TimeoutError:
            self.broker.resolve(pending.id, "cancel", None)
            action, content = "cancel", None
        if action not in ("accept", "decline", "cancel"):
            action = "cancel"
        if action == "accept" and mode == "form":
            return types.ElicitResult(action="accept", content=content or {})
        return types.ElicitResult(action=action)

    # ---------- wire observation ----------

    def _observe(self, direction: str, message: Any) -> None:
        try:
            self._record(direction, message)
        except Exception:  # never let logging break the session
            log.exception("protocol log failed")

    def _record(self, direction: str, message: Any) -> None:
        now = time.time()
        body = _dump(message)
        method = body.get("method")
        msg_id = body.get("id")
        if method and msg_id is not None:
            kind = "request"
        elif method:
            kind = "notification"
        elif "error" in body:
            kind = "error"
        else:
            kind = "response"

        ms: float | None = None
        note: str | None = None
        if kind == "request":
            with self._lock:
                self._inflight[(direction, msg_id)] = (now, method, body.get("params") or {})
        elif kind in ("response", "error") and msg_id is not None:
            origin = "out" if direction == "in" else "in"
            with self._lock:
                started = self._inflight.pop((origin, msg_id), None)
            if started:
                ms = round((now - started[0]) * 1000, 1)
                method = started[1]
                self._derive_tool_events(started, body)
            if method == "server/discover" and kind == "error":
                note = "Version probe for MCP 2026-07-28. The server speaks 2025-11-25, so the client falls back to initialize."

        if kind == "request" and method == "tools/call" and direction == "out" and not _from_app(body):
            params = body.get("params") or {}
            name = params.get("name", "")
            meta = self._tool_meta.get(name, {})
            invoking = (meta.get("ui") or {}).get("invoking") or meta.get("openai/toolInvocation/invoking")
            self.bus.publish(
                self.profile,
                "tool_call",
                {"id": msg_id, "name": name, "arguments": params.get("arguments") or {}, **({"invoking": invoking} if invoking else {})},
            )

        entry: dict[str, Any] = {
            "seq": self.bus.next_seq(),
            "profile": self.profile,
            "dir": direction,
            "kind": kind,
            "method": method,
            "id": msg_id,
            "ms": ms,
            "t": round(now * 1000),
            "body": body,
        }
        if note:
            entry["note"] = note
        self.bus.publish(self.profile, "rpc", entry)

    def _derive_tool_events(self, started: tuple[float, str, dict[str, Any]], body: dict[str, Any]) -> None:
        _, method, params = started
        result = body.get("result") or {}
        if method == "tools/list":
            for tool in result.get("tools", []):
                self._tool_meta[tool.get("name", "")] = tool.get("_meta") or {}
            return
        if method != "tools/call" or ((params.get("_meta") or {}).get(APP_ORIGIN_META) == "app"):
            return  # the view renders its own calls; they aren't conversation cards
        name = params.get("name", "")
        if "error" in body:
            text, structured, is_error, meta = body["error"].get("message", "Error"), {}, True, {}
        else:
            text = " ".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text").strip()
            structured = result.get("structuredContent") or {}
            is_error = bool(result.get("isError"))
            meta = result.get("_meta") or {}
        self.last_result = LastResult(name=name, text=text, structured=structured, is_error=is_error)
        ui_uri = (meta.get("ui") or {}).get("resourceUri") or (self._tool_meta.get(name, {}).get("ui") or {}).get("resourceUri")
        self.bus.publish(
            self.profile,
            "tool_result",
            {
                "id": body.get("id"),
                "name": name,
                "text": text,
                "structuredContent": structured,
                "isError": is_error,
                **({"uiResourceUri": ui_uri} if ui_uri else {}),
            },
        )


class Links:
    """All profile links, created lazily."""

    def __init__(self, mcp_url: str, bus: Bus, broker: ElicitationBroker) -> None:
        self.mcp_url, self.bus, self.broker = mcp_url, bus, broker
        self._links: dict[str, ProfileLink] = {}

    def get(self, profile: str) -> ProfileLink:
        link = self._links.get(profile)
        if link is None:
            link = self._links[profile] = ProfileLink(profile, self.mcp_url, self.bus, self.broker)
        return link

    async def stop_all(self) -> None:
        await asyncio.gather(*(link.stop() for link in self._links.values()), return_exceptions=True)
