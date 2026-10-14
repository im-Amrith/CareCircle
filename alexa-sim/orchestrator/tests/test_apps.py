"""MCP Apps: the simulator declares the extension, loads the dashboard view and relays the view's
tool calls, allowing only tools whose `_meta.ui.visibility` includes "app". No AWS calls."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from carecircle_sim.mcp_link import APP_ORIGIN_META, UI_EXTENSION, UI_MIME_TYPE

from .conftest import of, running_mcp_server, running_sim, turn

DASHBOARD = "ui://carecircle/care-dashboard"


@pytest.fixture(scope="module")
def apps_sim() -> Iterator[str]:
    """Its own server, so logging doses here doesn't change what the demo-script tests expect."""
    with running_mcp_server() as mcp_url, running_sim(mcp_url) as url:
        yield url


def rpc_log(sim: str, profile: str) -> list[dict[str, Any]]:
    return httpx.get(f"{sim}/rpc", params={"profile": profile}).json()["entries"]


def app_call(sim: str, profile: str, name: str, arguments: dict[str, Any] | None = None) -> httpx.Response:
    return httpx.post(f"{sim}/profiles/{profile}/app/tools/call", json={"name": name, "arguments": arguments or {}}, timeout=30)


def test_initialize_declares_mcp_apps(apps_sim: str) -> None:
    assert httpx.post(f"{apps_sim}/profiles/rose/connect", timeout=30).status_code == 200
    init = next(e for e in rpc_log(apps_sim, "rose") if e["method"] == "initialize" and e["dir"] == "out")
    caps = init["body"]["params"]["capabilities"]
    assert caps["extensions"][UI_EXTENSION] == {"mimeTypes": [UI_MIME_TYPE]}
    assert caps["elicitation"] == {"form": {}, "url": {}}


def test_status_result_carries_the_view_and_it_loads_once(apps_sim: str) -> None:
    events = turn(apps_sim, "rose", "Good morning")
    assert of(events, "tool_result")[0]["uiResourceUri"] == DASHBOARD

    for _ in range(2):
        r = httpx.get(f"{apps_sim}/profiles/rose/ui-resource", params={"uri": DASHBOARD}, timeout=30)
        assert r.status_code == 200, r.text
        view = r.json()
        assert view["html"].lower().startswith("<!doctype html>")
        assert view["csp"] == {"connectDomains": [], "resourceDomains": []}
    reads = [e for e in rpc_log(apps_sim, "rose") if e["method"] == "resources/read" and e["dir"] == "out"]
    assert len(reads) == 1  # cached for the session

    assert httpx.get(f"{apps_sim}/profiles/rose/ui-resource", params={"uri": "carecircle://family/fam-rose/care-plan"}).status_code == 400


def test_view_marks_a_dose_taken_without_adding_conversation_cards(apps_sim: str) -> None:
    r = app_call(apps_sim, "rose", "log_medication", {"medication_ids": ["med-metformin"], "slot": "morning", "status": "taken"})
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["isError"] is False
    assert result["structuredContent"]["result"] == "logged"
    assert "Metformin" in result["content"][0]["text"]

    calls = [e for e in rpc_log(apps_sim, "rose") if e["method"] == "tools/call" and e["dir"] == "out"]
    assert calls[-1]["body"]["params"]["_meta"][APP_ORIGIN_META] == "app"

    # The next conversation turn sees the logged dose, and shows only its own card.
    events = turn(apps_sim, "rose", "How am I doing today?")
    assert [r["name"] for r in of(events, "tool_result")] == ["get_care_status"]
    taken = {d["medicationId"] for d in of(events, "tool_result")[0]["structuredContent"]["doses"] if d["status"] == "taken"}
    assert "med-metformin" in taken


def test_view_cannot_order_or_call_unknown_tools(apps_sim: str) -> None:
    for name in ("request_refill", "check_refills", "delete_everything"):
        r = app_call(apps_sim, "sam", name, {"spoken_name": "amlodipine", "confirm": True})
        assert r.status_code == 403, (name, r.text)
    sent = [e["body"]["params"]["name"] for e in rpc_log(apps_sim, "sam") if e["method"] == "tools/call" and e["dir"] == "out"]
    assert sent == []  # refused before anything reached the server


def test_sandbox_proxy_only_serves_known_hosts(apps_sim: str) -> None:
    ok = httpx.get(f"{apps_sim}/sandbox", params={"host": "http://127.0.0.1:5173"})
    assert ok.status_code == 200
    assert "frame-ancestors http://127.0.0.1:5173 http://localhost:5173" in ok.headers["content-security-policy"]
    assert "sandbox-proxy-ready" in ok.text
    assert httpx.get(f"{apps_sim}/sandbox", params={"host": "https://evil.example"}).status_code == 400
    assert httpx.get(f"{apps_sim}/healthz").json()["sandboxUrl"] == f"{apps_sim}/sandbox"
