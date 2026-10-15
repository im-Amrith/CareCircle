"""Settings from environment variables (and an optional .env file next to the package)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROFILES: dict[str, dict[str, str]] = {
    "rose": {"name": "Rose", "about": "Rose herself, the person being cared for. Speak to her directly as 'you'."},
    "sam": {"name": "Sam", "about": "Sam, Rose's son and the family coordinator. Refer to Rose as Mom or Rose."},
    "maya": {"name": "Maya", "about": "Maya, Rose's daughter, who helps with visits. Refer to Rose as Mom or Rose."},
}


def _load_dotenv() -> None:
    """Minimal .env loader: KEY=VALUE lines, existing environment wins."""
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def _has_aws_credentials() -> bool:
    try:
        import boto3

        return boto3.Session().get_credentials() is not None
    except Exception:  # noqa: BLE001 - any failure means "no usable credentials"
        return False


@dataclass(frozen=True)
class Settings:
    mcp_url: str = "http://127.0.0.1:8000/mcp"
    mock_aws: bool = True
    mock_reason: str = "MOCK_AWS=1"
    bedrock_model_id: str = "global.amazon.nova-2-lite-v1:0"
    aws_region: str = "ap-southeast-2"
    polly_voices: tuple[str, ...] = ("Kajal", "Joanna")
    port: int = 8100
    # Pages allowed to embed the MCP Apps sandbox proxy (the simulator web app).
    web_origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173")
    # Seconds a device must be quiet before it gives a gentle dose reminder; 0 turns reminders off.
    reminder_idle_s: float = 45
    profiles: dict[str, dict[str, str]] = field(default_factory=lambda: dict(PROFILES))


def load_settings() -> Settings:
    _load_dotenv()
    env = os.environ
    raw = env.get("MOCK_AWS", "").strip().lower()
    if raw in ("1", "true", "yes"):
        mock, reason = True, "MOCK_AWS=1"
    elif raw in ("0", "false", "no"):
        mock, reason = False, "MOCK_AWS=0"
    elif _has_aws_credentials():
        mock, reason = False, "AWS credentials found"
    else:
        mock, reason = True, "no AWS credentials found"
    return Settings(
        mcp_url=env.get("MCP_URL", Settings.mcp_url),
        mock_aws=mock,
        mock_reason=reason,
        bedrock_model_id=env.get("BEDROCK_MODEL_ID", Settings.bedrock_model_id),
        aws_region=env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION") or Settings.aws_region,
        polly_voices=tuple(v.strip() for v in env.get("POLLY_VOICES", "Kajal,Joanna").split(",") if v.strip()),
        port=int(env.get("PORT", Settings.port)),
        reminder_idle_s=float(env.get("REMINDER_IDLE_S", Settings.reminder_idle_s)),
        web_origins=tuple(o.strip().rstrip("/") for o in env.get("WEB_ORIGINS", ",".join(Settings.web_origins)).split(",") if o.strip()),
    )
