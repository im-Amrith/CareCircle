"""AWS mode "brain": a Strands agent on Amazon Bedrock with the CareCircle MCP tools."""

from __future__ import annotations

from typing import Any

from strands import Agent
from strands.models import BedrockModel

SYSTEM_PROMPT = """You are Alexa+, a voice assistant on an Echo device, helping a family coordinate care for Rose, an older parent, through the CareCircle tools.

You are speaking with {about}

How to answer:
- Reply in one or two short spoken sentences. No lists, Markdown, emoji or headings.
- When a tool returns text, prefer saying that text as it is.
- Never read a URL, link or ID aloud. If there is a checkout link, say it is on screen.
- Never give medical advice, doses, dose changes or diagnoses. For symptoms suggest the doctor; for anything urgent, emergency services. You do not need a tool to refuse.
- Never order anything without a clear yes. If request_refill returns needs_confirmation, ask its question and only call it again with confirm true after the person says yes.
- If log_medication or request_refill asks which medicine, ask the person, then call again with the id they chose.
- Use get_care_status for greetings, "how is Mom" and "any updates"; check_refills for supplies; request_refill to reorder; log_medication when someone took or skipped medicine; log_wellbeing for how someone feels; list_medications for schedules."""


class AgentPool:
    """One Strands agent per profile, so each keeps its own conversation."""

    def __init__(self, model_id: str, region: str) -> None:
        self.model_id, self.region = model_id, region
        self._agents: dict[str, Agent] = {}

    def get(self, profile: str, about: str, tools: list[Any]) -> Agent:
        agent = self._agents.get(profile)
        if agent is None:
            model = BedrockModel(model_id=self.model_id, region_name=self.region, temperature=0.2, max_tokens=400)
            agent = Agent(model=model, tools=tools, system_prompt=SYSTEM_PROMPT.format(about=about), callback_handler=None)
            self._agents[profile] = agent
        return agent

    def reset(self, profile: str) -> None:
        self._agents.pop(profile, None)
