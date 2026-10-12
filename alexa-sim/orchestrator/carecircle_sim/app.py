"""HTTP API for the simulator web app.

POST /turn                   {profile, text} -> SSE: transcript, tool_call, tool_result, elicitation,
                             warning, speech, rpc, done, error
POST /elicitation/{id}       {action, content} answers a pending elicitation
POST /profiles/{p}/connect   opens the profile's MCP session (initialize + tools/list)
POST /profiles/{p}/reset     ends the session and forgets the conversation
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

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import __version__
from .agent import AgentPool
from .bus import Bus
from .config import Settings, load_settings
from .mcp_link import ElicitationBroker, Links
from .speech import Speech
from .turns import TurnRunner

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("carecircle.app")


class TurnIn(BaseModel):
    profile: str
    text: str = Field(min_length=1, max_length=500)


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
        log.info(
            "CareCircle simulator %s: MCP %s, brain %s, speech %s",
            __version__,
            settings.mcp_url,
            "mock router (" + settings.mock_reason + ")" if settings.mock_aws else f"Bedrock {settings.bedrock_model_id} in {settings.aws_region}",
            speech.detail,
        )
        yield
        await links.stop_all()

    app = FastAPI(title="CareCircle Alexa+ simulator", version=__version__, lifespan=lifespan)

    def check_profile(profile: str) -> None:
        if profile not in settings.profiles:
            raise HTTPException(404, f"Unknown profile {profile!r}")

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
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
            "profiles": [{"id": k, "name": v["name"], "connected": links.get(k).connected} for k, v in settings.profiles.items()],
        }

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
                task = asyncio.create_task(runner.run(link, body.text.strip()))
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
