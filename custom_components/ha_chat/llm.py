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


async def async_detect_context_window(
    session: aiohttp.ClientSession,
    base_url: str,
    model: str,
    api_key: str | None = None,
) -> int | None:
    """Try to read the model's context length from the /models endpoint.

    Nonstandard but widely available: llama.cpp reports meta.n_ctx,
    LM Studio max_context_length, vLLM max_model_len.
    """
    url = base_url.rstrip("/") + "/models"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with session.get(
            url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, OSError, ValueError, TimeoutError):
        return None

    entries = data.get("data") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        return None
    match = None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("id") == model or model in (entry.get("aliases") or []):
            match = entry
            break
    if match is None:
        return None
    meta = match.get("meta") or {}
    for value in (
        match.get("max_context_length"),  # LM Studio
        match.get("max_model_len"),  # vLLM
        match.get("context_length"),
        match.get("context_window"),
        meta.get("n_ctx"),  # llama.cpp: the context actually being served
        meta.get("n_ctx_train"),
    ):
        if isinstance(value, int) and value > 0:
            return value
    return None


async def async_stream_chat_completion(
    session: aiohttp.ClientSession,
    base_url: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    api_key: str | None = None,
):
    """Yield parsed SSE chunks from a streaming chat completion."""
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        # Ask for token usage in the final chunk (OpenAI, LM Studio,
        # Ollama, vLLM and llama.cpp all support this).
        "stream_options": {"include_usage": True},
    }
    if tools:
        payload["tools"] = tools

    resp: aiohttp.ClientResponse | None = None
    for attempt in (0, 1):
        try:
            resp = await session.post(
                url, json=payload, headers=headers, timeout=LLM_TIMEOUT
            )
        except (aiohttp.ClientError, OSError) as err:
            raise LLMError(f"Could not reach LLM at {url}: {err}") from err
        if resp.status == 200:
            break
        body = await resp.text()
        resp.close()
        if attempt == 0 and resp.status == 400 and "stream_options" in body:
            # Server rejects stream_options; drop it and retry once.
            payload.pop("stream_options", None)
            continue
        raise LLMError(f"LLM returned HTTP {resp.status}: {body[:500]}")

    try:
        async for raw_line in resp.content:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except ValueError:
                continue
            if isinstance(chunk, dict):
                yield chunk
    except (aiohttp.ClientError, OSError) as err:
        raise LLMError(f"LLM stream failed: {err}") from err
    except TimeoutError as err:
        raise LLMError("LLM stream timed out") from err
    finally:
        resp.close()


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
