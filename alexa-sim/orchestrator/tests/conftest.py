"""Fixtures: the real CareCircle MCP server (frozen at 9 am IST) and the orchestrator in mock mode."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn

from carecircle_sim.app import create_app
from carecircle_sim.config import Settings

REPO = Path(__file__).resolve().parents[3]
SERVER_DIR = REPO / "server"
NINE_AM_IST = "2026-10-10T03:30:00Z"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(url: str, timeout: float = 30) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(url, timeout=1).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"{url} did not come up")


@contextlib.contextmanager
def running_mcp_server(planner_url: str | None = None) -> Iterator[str]:
    """Starts server/src/index.ts with tsx on a free port. Requires `npm install` in server/."""
    tsx = SERVER_DIR / "node_modules" / "tsx" / "dist" / "cli.mjs"
    if not tsx.exists():
        pytest.exit("Run `npm install` in server/ first (tsx not found)", returncode=1)
    port = free_port()
    env = {**os.environ, "PORT": str(port), "HOST": "127.0.0.1", "CARECIRCLE_NOW": NINE_AM_IST}
    if planner_url:
        env["CARECIRCLE_PLANNER_URL"] = planner_url
    proc = subprocess.Popen(
        [shutil.which("node") or "node", str(tsx), "src/index.ts"],
        cwd=SERVER_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        wait_for(f"http://127.0.0.1:{port}/healthz")
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()


@contextlib.contextmanager
def running_sim(mcp_url: str, port: int | None = None) -> Iterator[str]:
    """The orchestrator in mock mode, in a background thread."""
    settings = Settings(mcp_url=f"{mcp_url}/mcp", mock_aws=True, mock_reason="tests")
    port = port or free_port()
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        wait_for(f"http://127.0.0.1:{port}/healthz")
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(10)


@pytest.fixture(scope="session")
def sim_port() -> int:
    """Chosen up front, so the MCP server can be told where the care team planner is."""
    return free_port()


@pytest.fixture(scope="session")
def mcp_server(sim_port: int) -> Iterator[str]:
    with running_mcp_server(planner_url=f"http://127.0.0.1:{sim_port}/plan/appointment") as url:
        yield url


@pytest.fixture(scope="session")
def sim(mcp_server: str, sim_port: int) -> Iterator[str]:
    with running_sim(mcp_server, sim_port) as url:
        yield url


Answer = Callable[[dict[str, Any]], dict[str, Any]]


def turn(sim: str, profile: str, text: str, answer: Answer | None = None, voice: str = "high") -> list[tuple[str, dict[str, Any]]]:
    """Runs one /turn with a simulated voice match, answering elicitations with `answer`, and returns every SSE event."""
    events: list[tuple[str, dict[str, Any]]] = []
    body = {"profile": profile, "text": text, "voice": voice}
    with httpx.Client(timeout=30) as client, client.stream("POST", f"{sim}/turn", json=body) as resp:
        assert resp.status_code == 200, resp.read()
        kind = None
        for line in resp.iter_lines():
            if line.startswith("event: "):
                kind = line[7:]
            elif line.startswith("data: ") and kind:
                data = json.loads(line[6:])
                events.append((kind, data))
                if kind == "elicitation":
                    assert answer is not None, f"unexpected elicitation: {data}"
                    r = httpx.post(f"{sim}/elicitation/{data['id']}", json=answer(data), timeout=10)
                    assert r.status_code == 200, r.text
                kind = None
    return events


def of(events: list[tuple[str, dict[str, Any]]], kind: str) -> list[dict[str, Any]]:
    return [d for k, d in events if k == kind]


def speech(events: list[tuple[str, dict[str, Any]]]) -> str:
    said = of(events, "speech")
    assert len(said) == 1, events
    return said[0]["text"]


if sys.platform == "win32":
    # Proactor loop noise on interpreter shutdown is harmless for these tests.
    import warnings

    warnings.filterwarnings("ignore", category=ResourceWarning)
