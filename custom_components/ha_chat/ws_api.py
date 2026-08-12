"""Home Assistant websocket API commands backing the HA Chat panel."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_LLM_API_KEY,
    CONF_LLM_MODEL,
    CONF_LLM_URL,
    CONF_MCP_URL,
    DOMAIN,
    WS_TYPE_CALL_TOOL,
    WS_TYPE_CHAT,
    WS_TYPE_CONFIG,
    WS_TYPE_TOOLS,
)
from .llm import LLMError, async_chat_completion
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


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    """Register the panel's websocket commands."""
    websocket_api.async_register_command(hass, ws_config)
    websocket_api.async_register_command(hass, ws_tools)
    websocket_api.async_register_command(hass, ws_chat)
    websocket_api.async_register_command(hass, ws_call_tool)


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): WS_TYPE_CONFIG})
@websocket_api.async_response
async def ws_config(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Return the non-secret parts of the configuration for display."""
    runtime = _get_runtime(hass)
    if runtime is None:
        connection.send_error(msg["id"], "not_ready", "HA Chat is not set up")
        return
    conf = _conf(runtime)
    connection.send_result(
        msg["id"],
        {
            "model": conf.get(CONF_LLM_MODEL),
            "llm_url": conf.get(CONF_LLM_URL),
            "mcp_url": conf.get(CONF_MCP_URL),
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

    messages = [
        {key: value for key, value in message.items() if key in _ALLOWED_MESSAGE_KEYS}
        for message in msg["messages"]
    ]

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
            conf[CONF_LLM_MODEL],
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
