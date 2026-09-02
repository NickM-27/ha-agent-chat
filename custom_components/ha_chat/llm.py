"""Client for an OpenAI-compatible chat completions endpoint."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)

# Local models can be slow, especially with a large tool schema in context.
LLM_TIMEOUT = aiohttp.ClientTimeout(total=600, connect=15)


class LLMError(Exception):
    """The LLM endpoint failed or returned an unexpected response."""


_OFF_VALUES = ("off", "0", "false", "none", "disabled")


def _detect_reasoning(entry: dict[str, Any]) -> tuple[bool, bool]:
    """Best-effort reasoning detection from a model entry.

    Returns (supports_reasoning, enabled_by_default).
    """
    supports = False
    default_on = True

    capabilities = entry.get("capabilities")
    if isinstance(capabilities, list) and any(
        cap in ("reasoning", "thinking") for cap in capabilities
    ):
        supports = True
    if isinstance(capabilities, dict) and (
        capabilities.get("reasoning") or capabilities.get("thinking")
    ):
        supports = True

    meta = entry.get("meta") or {}
    for source in (entry, meta):
        for key in ("reasoning", "thinking", "supports_reasoning", "has_reasoning"):
            if source.get(key) is True:
                supports = True
        template = source.get("chat_template")
        if isinstance(template, str) and (
            "<think>" in template or "enable_thinking" in template
        ):
            supports = True

    # llama.cpp preset managers (llama-swap style) expose the launch config: a
    # "--reasoning on/off" arg or "reasoning = ..." preset line marks the model
    # as reasoning-capable and tells us the server-side default. The unrelated
    # "--reasoning-budget-message" flag appears on every model, so match exactly.
    status = entry.get("status") or {}
    args = status.get("args")
    if isinstance(args, list) and "--reasoning" in args:
        supports = True
        index = args.index("--reasoning")
        if index + 1 < len(args):
            default_on = str(args[index + 1]).lower() not in _OFF_VALUES
    preset = status.get("preset")
    if isinstance(preset, str):
        match = re.search(r"^reasoning\s*=\s*(\S+)", preset, re.MULTILINE)
        if match:
            supports = True
            default_on = match.group(1).lower() not in _OFF_VALUES

    return supports, default_on


async def async_fetch_models(
    session: aiohttp.ClientSession,
    base_url: str,
    api_key: str | None = None,
) -> list[dict[str, Any]]:
    """Return the raw model entries from the /models endpoint ([] on failure)."""
    url = base_url.rstrip("/") + "/models"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with session.get(
            url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, OSError, ValueError, TimeoutError):
        return []

    entries = data.get("data") if isinstance(data, dict) else data
    return [e for e in entries if isinstance(e, dict)] if isinstance(entries, list) else []


def probe_model_entry(
    entries: list[dict[str, Any]], model: str | None
) -> dict[str, Any]:
    """Extract metadata for one model from /models entries.

    Returns {"context_window": int | None, "supports_reasoning": bool,
    "reasoning_default": bool}. Nonstandard but widely available: llama.cpp
    reports meta.n_ctx, LM Studio max_context_length, vLLM max_model_len.
    """
    result: dict[str, Any] = {
        "context_window": None,
        "supports_reasoning": False,
        "reasoning_default": True,
    }
    match = None
    for entry in entries:
        if entry.get("id") == model or model in (entry.get("aliases") or []):
            match = entry
            break
    if match is None:
        return result

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
            result["context_window"] = value
            break
    supports, default_on = _detect_reasoning(match)
    result["supports_reasoning"] = supports
    result["reasoning_default"] = default_on
    return result


async def async_stream_chat_completion(
    session: aiohttp.ClientSession,
    base_url: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    api_key: str | None = None,
    reasoning: bool | None = None,
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
        # llama.cpp: attach prompt/KV-cache/speed timings to each chunk so the
        # panel can show live context stats. Other servers ignore it or reject
        # it with a 400, which the retry below handles.
        "timings_per_token": True,
    }
    if tools:
        payload["tools"] = tools
    if reasoning is False:
        # llama.cpp honors reasoning_effort "none"; Qwen-style templates
        # (llama.cpp, vLLM) honor enable_thinking=False.
        payload["reasoning_effort"] = "none"
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    elif reasoning is True:
        # Explicit enable so the toggle can override a server-side default of off.
        payload["chat_template_kwargs"] = {"enable_thinking": True}

    # Nonstandard fields some servers reject with a 400; drop the ones the
    # error message names and retry.
    optional_fields = [
        "stream_options",
        "chat_template_kwargs",
        "reasoning_effort",
        "timings_per_token",
    ]
    resp: aiohttp.ClientResponse | None = None
    for _ in range(len(optional_fields) + 1):
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
        if resp.status == 400:
            dropped = False
            for field in list(optional_fields):
                if field in payload and field in body:
                    payload.pop(field)
                    optional_fields.remove(field)
                    dropped = True
            if dropped:
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
