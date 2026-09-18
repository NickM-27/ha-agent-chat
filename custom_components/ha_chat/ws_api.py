"""Home Assistant websocket API commands backing the HA Chat panel."""

from __future__ import annotations

import logging
import time
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_CONTEXT_WINDOW,
    CONF_LLM_API_KEY,
    CONF_LLM_MODEL,
    CONF_LLM_URL,
    CONF_MCP_URL,
    DEFAULT_CONTEXT_WINDOW,
    DOMAIN,
    WS_TYPE_CALL_TOOL,
    WS_TYPE_CHAT,
    WS_TYPE_CHAT_STREAM,
    WS_TYPE_CONFIG,
    WS_TYPE_TOOLS,
)
from .llm_client import (
    LLMError,
    async_chat_completion,
    async_fetch_models,
    async_stream_chat_completion,
    probe_model_entry,
)
from .mcp_client import MCPError, extract_tool_text

_LOGGER = logging.getLogger(__name__)

# Only forward standard OpenAI message fields; the frontend stores extra
# UI metadata on messages that some strict servers reject.
_ALLOWED_MESSAGE_KEYS = {"role", "content", "tool_calls", "tool_call_id", "name"}


def _get_runtime(hass: HomeAssistant):
    for value in hass.data.get(DOMAIN, {}).values():
        if hasattr(value, "mcp"):
            return value
    return None


def _conf(runtime) -> dict[str, Any]:
    entry = runtime.entry
    return {**entry.data, **entry.options}


def _openai_tools(mcp_tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tools = []
    for tool in mcp_tools:
        parameters = tool.get("inputSchema") or {"type": "object", "properties": {}}
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description") or "",
                    "parameters": parameters,
                },
            }
        )
    return tools


def _sanitize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {key: value for key, value in message.items() if key in _ALLOWED_MESSAGE_KEYS}
        for message in messages
    ]


def _resolve_model(msg: dict, conf: dict[str, Any]) -> str | None:
    """Model for this request: the panel's choice, else the legacy config value."""
    return msg.get("model") or conf.get(CONF_LLM_MODEL)


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    """Register the panel's websocket commands."""
    websocket_api.async_register_command(hass, ws_config)
    websocket_api.async_register_command(hass, ws_tools)
    websocket_api.async_register_command(hass, ws_chat)
    websocket_api.async_register_command(hass, ws_chat_stream)
    websocket_api.async_register_command(hass, ws_call_tool)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_CONFIG,
        # The panel's selected model; omitted on first load.
        vol.Optional("model"): str,
    }
)
@websocket_api.async_response
async def ws_config(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return the non-secret configuration plus the LLM server's model list."""
    runtime = _get_runtime(hass)
    if runtime is None:
        connection.send_error(msg["id"], "not_ready", "HA Chat is not set up")
        return
    conf = _conf(runtime)
    entries = await async_fetch_models(
        async_get_clientsession(hass),
        conf[CONF_LLM_URL],
        conf.get(CONF_LLM_API_KEY),
    )
    models: list[str] = []
    for entry in entries:
        model_id = entry.get("id")
        if isinstance(model_id, str) and model_id not in models:
            models.append(model_id)
    model = _resolve_model(msg, conf) or (models[0] if models else None)
    probe = probe_model_entry(entries, model)
    detected = probe["context_window"]
    connection.send_result(
        msg["id"],
        {
            "model": model,
            "models": models,
            "llm_url": conf.get(CONF_LLM_URL),
            "mcp_url": conf.get(CONF_MCP_URL),
            "context_window": detected
            or conf.get(CONF_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW),
            "context_window_source": "detected" if detected else "configured",
            "supports_reasoning": probe["supports_reasoning"],
            "reasoning_default": probe["reasoning_default"],
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_TOOLS,
        vol.Optional("refresh", default=False): bool,
    }
)
@websocket_api.async_response
async def ws_tools(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """List the tools available on the MCP server."""
    runtime = _get_runtime(hass)
    if runtime is None:
        connection.send_error(msg["id"], "not_ready", "HA Chat is not set up")
        return
    try:
        tools = await runtime.mcp.async_list_tools(force=msg["refresh"])
    except MCPError as err:
        connection.send_error(msg["id"], "mcp_error", str(err))
        return
    connection.send_result(
        msg["id"],
        {
            "tools": [
                {
                    "name": tool["name"],
                    "description": tool.get("description") or "",
                    "input_schema": tool.get("inputSchema"),
                }
                for tool in tools
            ]
        },
    )


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_CHAT,
        vol.Required("messages"): [dict],
        vol.Optional("model"): str,
    }
)
@websocket_api.async_response
async def ws_chat(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Send the conversation to the LLM and return the assistant message."""
    runtime = _get_runtime(hass)
    if runtime is None:
        connection.send_error(msg["id"], "not_ready", "HA Chat is not set up")
        return
    conf = _conf(runtime)
    model = _resolve_model(msg, conf)
    if not model:
        connection.send_error(msg["id"], "no_model", "No model selected")
        return

    messages = _sanitize_messages(msg["messages"])

    warning = None
    tools: list[dict[str, Any]] = []
    try:
        tools = _openai_tools(await runtime.mcp.async_list_tools())
    except MCPError as err:
        # Degrade to plain chat rather than failing outright.
        warning = f"MCP server unavailable, chatting without tools: {err}"
        _LOGGER.warning(warning)

    try:
        message = await async_chat_completion(
            async_get_clientsession(hass),
            conf[CONF_LLM_URL],
            model,
            messages,
            tools=tools or None,
            api_key=conf.get(CONF_LLM_API_KEY),
        )
    except LLMError as err:
        connection.send_error(msg["id"], "llm_error", str(err))
        return

    result: dict[str, Any] = {"message": message}
    if warning:
        result["warning"] = warning
    connection.send_result(msg["id"], result)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_CHAT_STREAM,
        vol.Required("messages"): [dict],
        vol.Optional("model"): str,
        # True/False force reasoning on/off; omitted leaves the server default.
        vol.Optional("reasoning"): vol.Any(bool, None),
        # Compaction asks for a plain summary; the tool schema is the bulk of
        # the prompt and a summary has no use for it.
        vol.Optional("with_tools", default=True): bool,
    }
)
@websocket_api.async_response
async def ws_chat_stream(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Stream a chat completion as subscription events.

    Events: {type: "delta", content} for each token,
    {type: "stats", timings} at most once a second when the server reports
    prompt/cache timings (llama.cpp),
    {type: "done", message, usage, token_rate, ...} at the end, or
    {type: "error", error}. Unsubscribing cancels the LLM request.
    """
    runtime = _get_runtime(hass)
    if runtime is None:
        connection.send_error(msg["id"], "not_ready", "HA Chat is not set up")
        return
    conf = _conf(runtime)
    model = _resolve_model(msg, conf)
    if not model:
        connection.send_error(msg["id"], "no_model", "No model selected")
        return
    messages = _sanitize_messages(msg["messages"])
    msg_id = msg["id"]

    warning = None
    tools: list[dict[str, Any]] = []
    if msg["with_tools"]:
        try:
            tools = _openai_tools(await runtime.mcp.async_list_tools())
        except MCPError as err:
            warning = f"MCP server unavailable, chatting without tools: {err}"
            _LOGGER.warning(warning)

    def _send_event(payload: dict[str, Any]) -> None:
        try:
            connection.send_message(websocket_api.event_message(msg_id, payload))
        except Exception:  # noqa: BLE001 - client may already be gone
            pass

    async def _run() -> None:
        started = time.monotonic()
        first_token: float | None = None
        content_parts: list[str] = []
        think_parts: list[str] = []
        tool_calls: dict[int, dict[str, Any]] = {}
        usage: dict[str, Any] | None = None
        timings: dict[str, Any] | None = None
        last_stats = 0.0
        chunk_count = 0
        try:
            stream = async_stream_chat_completion(
                async_get_clientsession(hass),
                conf[CONF_LLM_URL],
                model,
                messages,
                tools=tools or None,
                api_key=conf.get(CONF_LLM_API_KEY),
                reasoning=msg.get("reasoning"),
            )
            async for chunk in stream:
                if chunk.get("usage"):
                    usage = chunk["usage"]
                if isinstance(chunk.get("timings"), dict):
                    timings = chunk["timings"]
                    now_ts = time.monotonic()
                    if now_ts - last_stats >= 1.0:
                        last_stats = now_ts
                        _send_event({"type": "stats", "timings": timings})
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                thinking = delta.get("reasoning_content") or delta.get("reasoning")
                if isinstance(thinking, str) and thinking:
                    if first_token is None:
                        first_token = time.monotonic()
                    chunk_count += 1
                    think_parts.append(thinking)
                    _send_event({"type": "think", "content": thinking})
                content = delta.get("content")
                if content:
                    if first_token is None:
                        first_token = time.monotonic()
                    chunk_count += 1
                    content_parts.append(content)
                    _send_event({"type": "delta", "content": content})
                for tool_chunk in delta.get("tool_calls") or []:
                    if first_token is None:
                        first_token = time.monotonic()
                    chunk_count += 1
                    index = tool_chunk.get("index", 0)
                    entry = tool_calls.setdefault(
                        index,
                        {
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        },
                    )
                    if tool_chunk.get("id"):
                        entry["id"] = tool_chunk["id"]
                    function = tool_chunk.get("function") or {}
                    if function.get("name"):
                        entry["function"]["name"] += function["name"]
                    if function.get("arguments"):
                        entry["function"]["arguments"] += function["arguments"]
        except LLMError as err:
            _send_event({"type": "error", "error": str(err)})
            return

        now = time.monotonic()
        generation_time = now - (first_token if first_token is not None else started)
        message: dict[str, Any] = {
            "role": "assistant",
            "content": "".join(content_parts),
        }
        if tool_calls:
            message["tool_calls"] = [
                {**entry, "id": entry["id"] or f"call_{index}"}
                for index, entry in sorted(tool_calls.items())
            ]
        completion_tokens = (usage or {}).get("completion_tokens")
        estimated = completion_tokens is None
        if estimated and timings and isinstance(timings.get("predicted_n"), int):
            completion_tokens = timings["predicted_n"]
            estimated = False
        if completion_tokens is None:
            # No usage from the server; delta chunks roughly equal tokens.
            completion_tokens = chunk_count
        token_rate = (
            round(completion_tokens / generation_time, 1)
            if completion_tokens and generation_time > 0.05
            else None
        )
        if timings:
            # The server's own measurement beats our wall-clock estimate.
            speed = timings.get("predicted_per_second")
            if isinstance(speed, (int, float)) and speed > 0:
                token_rate = round(speed, 1)
        payload: dict[str, Any] = {
            "type": "done",
            "message": message,
            "usage": usage,
            "completion_tokens": completion_tokens,
            "estimated": estimated,
            "elapsed": round(now - started, 2),
            "token_rate": token_rate,
        }
        if timings:
            payload["timings"] = timings
        if think_parts:
            payload["reasoning"] = "".join(think_parts)
        if warning:
            payload["warning"] = warning
        _send_event(payload)

    task = hass.async_create_task(_run(), "ha_chat_chat_stream")

    @callback
    def _abort() -> None:
        task.cancel()

    connection.subscriptions[msg_id] = _abort
    connection.send_result(msg_id)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_CALL_TOOL,
        vol.Required("name"): str,
        vol.Optional("arguments", default=dict): dict,
    }
)
@websocket_api.async_response
async def ws_call_tool(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Execute an approved MCP tool call and return its output."""
    runtime = _get_runtime(hass)
    if runtime is None:
        connection.send_error(msg["id"], "not_ready", "HA Chat is not set up")
        return
    try:
        result = await runtime.mcp.async_call_tool(msg["name"], msg["arguments"])
    except MCPError as err:
        connection.send_error(msg["id"], "mcp_error", str(err))
        return
    content, is_error = extract_tool_text(result)
    connection.send_result(msg["id"], {"content": content, "is_error": is_error})
