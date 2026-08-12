"""Client for an OpenAI-compatible chat completions endpoint."""

from __future__ import annotations

import json
import logging
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)

# Local models can be slow, especially with a large tool schema in context.
LLM_TIMEOUT = aiohttp.ClientTimeout(total=600, connect=15)


class LLMError(Exception):
    """The LLM endpoint failed or returned an unexpected response."""


async def async_chat_completion(
    session: aiohttp.ClientSession,
    base_url: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    """Send a chat completion request and return the assistant message."""
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload: dict[str, Any] = {"model": model, "messages": messages}
    if tools:
        payload["tools"] = tools

    try:
        async with session.post(
            url, json=payload, headers=headers, timeout=LLM_TIMEOUT
        ) as resp:
            body = await resp.text()
            if resp.status != 200:
                raise LLMError(f"LLM returned HTTP {resp.status}: {body[:500]}")
    except (aiohttp.ClientError, OSError) as err:
        raise LLMError(f"Could not reach LLM at {url}: {err}") from err
    except TimeoutError as err:
        raise LLMError("LLM request timed out") from err

    try:
        data = json.loads(body)
        message = data["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError) as err:
        raise LLMError(f"Unexpected LLM response: {body[:500]}") from err
    if not isinstance(message, dict):
        raise LLMError(f"Unexpected LLM message payload: {str(message)[:300]}")
    return message
