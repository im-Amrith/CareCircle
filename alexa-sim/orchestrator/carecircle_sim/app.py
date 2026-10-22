"""HTTP API for the simulator web app.

POST /turn                   {profile, text} -> SSE: transcript, tool_call, tool_result, elicitation,
                             warning, speech, rpc, done, error
POST /elicitation/{id}       {action, content} answers a pending elicitation
POST /profiles/{p}/connect   opens the profile's MCP session (initialize + tools/list)
POST /profiles/{p}/reset     ends the session and forgets the conversation
GET  /events?profile=        SSE for one device outside turns: today (live family status), inbox, announcement
POST /profiles/{p}/remind    says the current dose reminder now (the device otherwise waits until it's idle)
POST /profiles/{p}/language  {language}: set_language over MCP (en or hi)
POST /profiles/{p}/summary   send_daily_summary over MCP, as if asked aloud
GET  /profiles/{p}/ui-resource?uri=ui://...   an MCP App view (resources/read, cached per session)
POST /profiles/{p}/app/tools/call             {name, arguments}: a view's tools/call, app-visible tools only
GET  /sandbox?host=<origin>  the MCP Apps sandbox proxy page; the web app frames it from this other origin
GET  /rpc?profile=&after=    protocol log backlog
GET  /healthz                MCP reachability, brain mode, speech mode
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections import defaultdict
from collections.abc import AsyncIterator
from typing import Any, Literal

from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__
from .agent import AgentPool
from .bus import Bus
from .care_team import plan_appointment
from .config import Settings, load_settings
from .mcp_link import AppToolDenied, ElicitationBroker, Links
from .proactive import Proactive
from .speech import Speech
from .turns import TurnRunner

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("carecircle.app")


class TurnIn(BaseModel):
    profile: str
    text: str = Field(min_length=1, max_length=500)
    # Slower speech for older listeners (Polly prosody rate).
    slow: bool = False


class LanguageIn(BaseModel):
    language: Literal["en", "hi"]


# Events a device hears outside its own turns.
DEVICE_EVENTS = {"today", "inbox", "announcement"}


class AppToolCall(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    arguments: dict[str, Any] | None = None


SANDBOX_HTML = (Path(__file__).parent / "sandbox.html").read_text(encoding="utf-8")


class ElicitationAnswer(BaseModel):
    action: Literal["accept", "decline", "cancel"]
    content: dict[str, Any] | None = None


def _sse(kind: str, data: dict[str, Any]) -> bytes:
    return f"event: {kind}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    bus = Bus()
    broker = ElicitationBroker()
    links = Links(settings.mcp_url, bus, broker)
    locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
    state: dict[str, Any] = {}

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        bus.loop = asyncio.get_running_loop()
        speech = await asyncio.to_thread(Speech.start, settings.aws_region, settings.polly_voices, not settings.mock_aws)
        agents = None if settings.mock_aws else AgentPool(settings.bedrock_model_id, settings.aws_region)
        state["speech"] = speech
        state["agents"] = agents
        state["runner"] = TurnRunner(settings, bus, speech, agents)
        proactive = Proactive(links, bus, state["runner"], agents, locks, settings.reminder_idle_s)
        state["proactive"] = proactive
        links.on_today = proactive.on_today
        for link in links.all():
            link.on_today = proactive.on_today
        reminders = asyncio.create_task(proactive.loop())
        log.info(
            "CareCircle simulator %s: MCP %s, brain %s, speech %s",
            __version__,
            settings.mcp_url,
            "mock router (" + settings.mock_reason + ")" if settings.mock_aws else f"Bedrock {settings.bedrock_model_id} in {settings.aws_region}",
            speech.detail,
        )
        yield
        reminders.cancel()
        await links.stop_all()

    app = FastAPI(title="CareCircle Alexa+ simulator", version=__version__, lifespan=lifespan)

    def check_profile(profile: str) -> None:
        if profile not in settings.profiles:
            raise HTTPException(404, f"Unknown profile {profile!r}")

    @app.get("/healthz")
    async def healthz(request: Request) -> dict[str, Any]:
        base = settings.mcp_url.rsplit("/mcp", 1)[0]
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                r = await client.get(f"{base}/healthz")
            mcp = {"reachable": r.status_code == 200, "url": settings.mcp_url, **(r.json() if r.status_code == 200 else {})}
        except Exception as err:  # noqa: BLE001
            mcp = {"reachable": False, "url": settings.mcp_url, "error": str(err)}
        speech: Speech = state["speech"]
        return {
            "ok": mcp["reachable"],
            "version": __version__,
            "mcp": mcp,
            "brain": (
                {"mode": "mock", "reason": settings.mock_reason}
                if settings.mock_aws
                else {"mode": "bedrock", "model": settings.bedrock_model_id, "region": settings.aws_region, "fallback": "mock router"}
            ),
            "speech": {"mode": speech.mode, "voice": speech.voice, "detail": speech.detail},
            # The web app reaches us through its /api proxy, which keeps our host, so this is our own origin.
            "sandboxUrl": f"{str(request.base_url).rstrip('/')}/sandbox",
            "reminders": {"idleSeconds": settings.reminder_idle_s},
            "profiles": [{"id": k, "name": v["name"], "connected": links.get(k).connected} for k, v in settings.profiles.items()],
        }

    @app.post("/plan/appointment")
    async def plan(brief: dict[str, Any]) -> dict[str, Any]:
        """The care team (a Strands Graph) ranks appointment options from the MCP server's brief.
        Local only: the server calls this; it books nothing and the server re-checks every pick."""
        if not isinstance(brief.get("slots"), list) or not isinstance(brief.get("window"), dict) or not isinstance(brief.get("clinic"), dict):
            raise HTTPException(400, "Expected a planning brief with slots, window and clinic")
        result = await plan_appointment(brief, bedrock=None if settings.mock_aws else (settings.bedrock_model_id, settings.aws_region))
        log.info("care team planned %d options with %s in %d ms", len(result["options"]), result["engine"], result["ms"])
        return result

    @app.post("/profiles/{profile}/connect")
    async def connect(profile: str) -> dict[str, Any]:
        check_profile(profile)
        link = links.get(profile)
        try:
            await link.ensure_started()
        except Exception as err:  # noqa: BLE001
            raise HTTPException(502, f"Could not connect to the CareCircle MCP server at {settings.mcp_url}: {err}") from err
        return {"profile": profile, "tools": [t.tool_name for t in link.tools]}

    @app.post("/profiles/{profile}/reset")
    async def reset(profile: str) -> dict[str, Any]:
        check_profile(profile)
        await links.get(profile).stop()
        links.get(profile).last_result = None
        if state.get("agents"):
            state["agents"].reset(profile)
        return {"profile": profile, "reset": True}

    @app.get("/events")
    async def events(profile: str, request: Request) -> StreamingResponse:
        check_profile(profile)
        link = links.get(profile)

        async def stream() -> AsyncIterator[bytes]:
            queue = bus.subscribe(profile)
            try:
                # Start from the current state, then follow changes.
                with contextlib.suppress(Exception):
                    await link.ensure_started()
                if link.today is not None:
                    yield _sse("today", link.today)
                yield _sse("inbox", {"messages": link.inbox})
                while True:
                    try:
                        kind, data = await asyncio.wait_for(queue.get(), timeout=15)
                    except TimeoutError:
                        if await request.is_disconnected():
                            return
                        yield b": keepalive\n\n"
                        continue
                    if kind in DEVICE_EVENTS:
                        yield _sse(kind, data)
            finally:
                bus.unsubscribe(profile, queue)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/profiles/{profile}/remind")
    async def remind(profile: str) -> dict[str, Any]:
        check_profile(profile)
        link = links.get(profile)
        await link.ensure_started()
        event = await state["proactive"].remind(link, force=True)
        return {"reminded": event is not None, "text": event["text"] if event else None}

    @app.post("/profiles/{profile}/language")
    async def language(profile: str, body: LanguageIn) -> dict[str, Any]:
        check_profile(profile)
        link = links.get(profile)
        result = await link.call_tool("set_language", {"language": body.language})
        if result.is_error:
            raise HTTPException(502, result.text)
        link.language = body.language
        return {"language": body.language, "text": result.text}

    @app.post("/profiles/{profile}/summary")
    async def summary(profile: str) -> dict[str, Any]:
        check_profile(profile)
        result = await links.get(profile).call_tool("send_daily_summary", {})
        if result.is_error:
            raise HTTPException(502, result.text)
        return {"text": result.text, "message": result.structured}

    @app.get("/profiles/{profile}/ui-resource")
    async def ui_resource(profile: str, uri: str) -> dict[str, Any]:
        check_profile(profile)
        try:
            return await links.get(profile).ui_resource(uri)
        except ValueError as err:
            raise HTTPException(400, str(err)) from err
        except Exception as err:  # noqa: BLE001
            raise HTTPException(502, f"Could not read {uri}: {err}") from err

    @app.post("/profiles/{profile}/app/tools/call")
    async def app_tool_call(profile: str, body: AppToolCall) -> dict[str, Any]:
        check_profile(profile)
        try:
            return await links.get(profile).app_call_tool(body.name, body.arguments)
        except AppToolDenied as err:
            raise HTTPException(403, str(err)) from err

    @app.get("/sandbox")
    async def sandbox(host: str) -> HTMLResponse:
        # The proxy only ever talks to the simulator page that framed it.
        if host not in settings.web_origins:
            raise HTTPException(400, "Unknown host origin")
        return HTMLResponse(
            SANDBOX_HTML,
            headers={
                "Content-Security-Policy": (
                    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
                    f"frame-ancestors {' '.join(settings.web_origins)}"
                ),
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/rpc")
    async def rpc(profile: str, after: int = 0) -> dict[str, Any]:
        check_profile(profile)
        return {"entries": bus.rpc_backlog(profile, after)}

    @app.post("/elicitation/{elicitation_id}")
    async def answer(elicitation_id: str, body: ElicitationAnswer) -> dict[str, Any]:
        if not broker.resolve(elicitation_id, body.action, body.content):
            raise HTTPException(404, "No pending elicitation with that id")
        return {"ok": True}

    @app.post("/turn")
    async def turn(body: TurnIn, request: Request) -> StreamingResponse:
        check_profile(body.profile)
        lock = locks[body.profile]
        if lock.locked():
            raise HTTPException(409, f"{settings.profiles[body.profile]['name']} already has a turn in progress")
        link = links.get(body.profile)
        runner: TurnRunner = state["runner"]

        async def stream() -> AsyncIterator[bytes]:
            async with lock:
                queue = bus.subscribe(body.profile)
                task = asyncio.create_task(runner.run(link, body.text.strip(), body.slow))
                try:
                    while True:
                        getter = asyncio.create_task(queue.get())
                        done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
                        if getter in done:
                            yield _sse(*getter.result())
                            continue
                        getter.cancel()
                        # Let events hopped over from MCP threads land before closing.
                        for _ in range(3):
                            await asyncio.sleep(0.01)
                        while not queue.empty():
                            yield _sse(*queue.get_nowait())
                        err = task.exception()
                        if err is not None:
                            log.error("turn failed", exc_info=err)
                            yield _sse("error", {"message": f"{type(err).__name__}: {err}"})
                        yield _sse("done", {})
                        return
                finally:
                    bus.unsubscribe(body.profile, queue)
                    if not task.done():
                        broker.cancel_profile(body.profile)
                        task.cancel()

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


app = create_app()
