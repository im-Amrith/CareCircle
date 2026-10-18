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
- Use get_care_status for greetings, "how is Mom" and "any updates"; check_refills for supplies; request_refill to reorder; log_medication when someone took or skipped medicine; log_wellbeing for how someone feels; list_medications for schedules; set_language when they ask you to speak Hindi or English; send_daily_summary to send the family today's written summary.
- {language}"""

LANGUAGE = {
    "en": "Speak English. If they speak Hindi or ask for it, call set_language with hi.",
    "hi": (
        "This person prefers Hindi: always reply in simple spoken Hindi (Devanagari), keeping medicine names in English. "
        "Tool replies already come in Hindi; say them as they are. When logging how they feel, write the note in English "
        "and add their own words in brackets."
    ),
}


class AgentPool:
    """One Strands agent per profile, so each keeps its own conversation."""

    def __init__(self, model_id: str, region: str) -> None:
        self.model_id, self.region = model_id, region
        self._agents: dict[str, Agent] = {}

    def get(self, profile: str, about: str, tools: list[Any], language: str = "en") -> Agent:
        prompt = SYSTEM_PROMPT.format(about=about, language=LANGUAGE.get(language, LANGUAGE["en"]))
        agent = self._agents.get(profile)
        if agent is None:
            model = BedrockModel(model_id=self.model_id, region_name=self.region, temperature=0.2, max_tokens=400)
            agent = Agent(model=model, tools=tools, system_prompt=prompt, callback_handler=None)
            self._agents[profile] = agent
        elif agent.system_prompt != prompt:
            agent.system_prompt = prompt  # the person switched language; keep the conversation
        return agent

    def note_proactive(self, profile: str, said: str) -> None:
        """Adds something the device said on its own (a reminder) to the conversation, so a
        following "yes" makes sense to the model. Bedrock needs user/assistant turns to alternate."""
        agent = self._agents.get(profile)
        if agent is None:
            return
        if agent.messages and agent.messages[-1].get("role") == "user":
            return  # a turn is mid-flight; don't interleave
        agent.messages.append({"role": "user", "content": [{"text": "(The device checks in on its own.)"}]})
        agent.messages.append({"role": "assistant", "content": [{"text": said}]})

    def reset(self, profile: str) -> None:
        self._agents.pop(profile, None)
