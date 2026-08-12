"""Minimal MCP client supporting WebSocket and Streamable HTTP transports.

The ha-mcp HACS integration exposes MCP over streamable HTTP
(e.g. http://<ha-ip>:9584/private_<secret> or a HA webhook URL), while other
servers use a plain WebSocket JSON-RPC transport. The transport is picked from
the URL scheme: ws:// / wss:// -> WebSocket, http:// / https:// -> streamable HTTP.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)

PROTOCOL_VERSION = "2025-03-26"
CLIENT_INFO = {"name": "ha-chat", "version": "0.1.0"}

DEFAULT_TIMEOUT = 60
TOOL_CALL_TIMEOUT = 180


class MCPError(Exception):
    """The MCP server returned an error or sent an invalid response."""


class MCPConnectionError(MCPError):
    """The MCP server could not be reached or the connection dropped."""


def create_mcp_client(hass: HomeAssistant, url: str, token: str | None = None):
    """Create an MCP client for the given URL, picking transport by scheme."""
    if url.startswith(("ws://", "wss://")):
        return MCPWebSocketClient(hass, url, token)
    return MCPHttpClient(hass, url, token)


def extract_tool_text(result: dict[str, Any]) -> tuple[str, bool]:
    """Flatten an MCP tools/call result into text plus an is_error flag."""
    is_error = bool(result.get("isError"))
    parts: list[str] = []
    for item in result.get("content") or []:
        item_type = item.get("type")
        if item_type == "text":
            parts.append(item.get("text", ""))
        elif item_type == "resource":
            resource = item.get("resource", {})
            parts.append(resource.get("text") or json.dumps(resource))
        else:
            parts.append(json.dumps(item))
    if not parts and "structuredContent" in result:
        parts.append(json.dumps(result["structuredContent"]))
    return "\n".join(part for part in parts if part) or "(no output)", is_error


class MCPBaseClient:
    """Shared request/caching logic for both transports."""

    def __init__(self, hass: HomeAssistant, url: str, token: str | None) -> None:
        self._hass = hass
        self._url = url
        self._token = token
        self._lock = asyncio.Lock()
        self._id_counter = 0
        self._tools: list[dict[str, Any]] | None = None

    @property
    def _auth_headers(self) -> dict[str, str]:
        if self._token:
            return {"Authorization": f"Bearer {self._token}"}
        return {}

    def _next_id(self) -> int:
        self._id_counter += 1
        return self._id_counter

    async def async_list_tools(self, force: bool = False) -> list[dict[str, Any]]:
        """Return the server's tools, cached after the first fetch."""
        if self._tools is not None and not force:
            return self._tools
        result = await self._call_with_retry("tools/list", {})
        tools = list(result.get("tools", []))
        cursor = result.get("nextCursor")
        while cursor:
            result = await self._call_with_retry("tools/list", {"cursor": cursor})
            tools.extend(result.get("tools", []))
            cursor = result.get("nextCursor")
        self._tools = tools
        return tools

    async def async_call_tool(
        self, name: str, arguments: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Call a tool and return the raw MCP result."""
        return await self._call_with_retry(
            "tools/call",
            {"name": name, "arguments": arguments or {}},
            timeout=TOOL_CALL_TIMEOUT,
        )

    async def _call_with_retry(
        self, method: str, params: dict[str, Any], timeout: int = DEFAULT_TIMEOUT
    ) -> dict[str, Any]:
        """Send a request, resetting the connection and retrying once on transport failure."""
        try:
            return await self._request(method, params, timeout)
        except MCPConnectionError:
            await self._reset()
            return await self._request(method, params, timeout)

    async def _request(
        self, method: str, params: dict[str, Any], timeout: int
    ) -> dict[str, Any]:
        raise NotImplementedError

    async def _reset(self) -> None:
        raise NotImplementedError

    async def async_close(self) -> None:
        raise NotImplementedError


class MCPWebSocketClient(MCPBaseClient):
    """MCP over a plain WebSocket carrying JSON-RPC 2.0 messages."""

    def __init__(self, hass: HomeAssistant, url: str, token: str | None) -> None:
        super().__init__(hass, url, token)
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._listen_task: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._initialized = False

    async def _ensure_connected(self) -> None:
        async with self._lock:
            if self._ws is not None and not self._ws.closed and self._initialized:
                return
            await self._teardown()
            session = async_get_clientsession(self._hass)
            try:
                self._ws = await session.ws_connect(
                    self._url, headers=self._auth_headers, heartbeat=25
                )
            except (aiohttp.ClientError, OSError) as err:
                raise MCPConnectionError(
                    f"Could not connect to MCP server at {self._url}: {err}"
                ) from err
            self._listen_task = self._hass.async_create_background_task(
                self._listen(self._ws), "ha_chat_mcp_listen"
            )
            init_result = await self._send_request(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": CLIENT_INFO,
                },
                DEFAULT_TIMEOUT,
            )
            _LOGGER.debug("MCP initialize result: %s", init_result)
            await self._ws.send_str(
                json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
            )
            self._initialized = True

    async def _listen(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if not isinstance(data, dict):
                    continue
                if "id" in data and ("result" in data or "error" in data):
                    future = self._pending.pop(data["id"], None)
                    if future is not None and not future.done():
                        future.set_result(data)
                elif "id" in data and "method" in data:
                    # Server-to-client request; we only support ping.
                    if data["method"] == "ping":
                        reply: dict[str, Any] = {
                            "jsonrpc": "2.0",
                            "id": data["id"],
                            "result": {},
                        }
                    else:
                        reply = {
                            "jsonrpc": "2.0",
                            "id": data["id"],
                            "error": {"code": -32601, "message": "Method not supported"},
                        }
                    await ws.send_str(json.dumps(reply))
        except Exception:  # noqa: BLE001 - listener must never crash silently
            _LOGGER.debug("MCP websocket listener ended", exc_info=True)
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(MCPConnectionError("MCP connection closed"))
            self._pending.clear()
            self._initialized = False

    async def _send_request(
        self, method: str, params: dict[str, Any], timeout: int
    ) -> dict[str, Any]:
        if self._ws is None or self._ws.closed:
            raise MCPConnectionError("MCP websocket is not connected")
        request_id = self._next_id()
        future: asyncio.Future = self._hass.loop.create_future()
        self._pending[request_id] = future
        try:
            await self._ws.send_str(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": method,
                        "params": params,
                    }
                )
            )
            async with asyncio.timeout(timeout):
                data = await future
        except (aiohttp.ClientError, ConnectionResetError) as err:
            raise MCPConnectionError(f"MCP send failed: {err}") from err
        except TimeoutError as err:
            raise MCPError(f"MCP request {method} timed out after {timeout}s") from err
        finally:
            self._pending.pop(request_id, None)
        if "error" in data:
            error = data["error"] or {}
            raise MCPError(error.get("message") or f"MCP error on {method}")
        return data.get("result") or {}

    async def _request(
        self, method: str, params: dict[str, Any], timeout: int
    ) -> dict[str, Any]:
        await self._ensure_connected()
        return await self._send_request(method, params, timeout)

    async def _teardown(self) -> None:
        if self._listen_task is not None:
            self._listen_task.cancel()
            self._listen_task = None
        if self._ws is not None and not self._ws.closed:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        self._ws = None
        self._initialized = False

    async def _reset(self) -> None:
        async with self._lock:
            await self._teardown()

    async def async_close(self) -> None:
        await self._reset()


class MCPHttpClient(MCPBaseClient):
    """MCP over Streamable HTTP (the transport ha-mcp uses)."""

    def __init__(self, hass: HomeAssistant, url: str, token: str | None) -> None:
        super().__init__(hass, url, token)
        self._session_id: str | None = None
        self._initialized = False

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            **self._auth_headers,
        }
        if self._initialized:
            headers["MCP-Protocol-Version"] = PROTOCOL_VERSION
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        return headers

    async def _ensure_initialized(self) -> None:
        async with self._lock:
            if self._initialized:
                return
            request_id = self._next_id()
            result = await self._post_and_read(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": CLIENT_INFO,
                    },
                },
                request_id,
                DEFAULT_TIMEOUT,
                capture_session=True,
            )
            _LOGGER.debug("MCP initialize result: %s", result)
            self._initialized = True
            # Best-effort initialized notification; some servers require it.
            try:
                await self._post_and_read(
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    None,
                    DEFAULT_TIMEOUT,
                )
            except MCPError:
                _LOGGER.debug("initialized notification rejected", exc_info=True)

    async def _post_and_read(
        self,
        payload: dict[str, Any],
        request_id: int | None,
        timeout: int,
        capture_session: bool = False,
    ) -> dict[str, Any] | None:
        session = async_get_clientsession(self._hass)
        try:
            async with asyncio.timeout(timeout):
                async with session.post(
                    self._url, json=payload, headers=self._headers()
                ) as resp:
                    if capture_session:
                        self._session_id = resp.headers.get("mcp-session-id")
                    if resp.status == 404 and self._session_id:
                        # Session expired; force re-initialization on retry.
                        raise MCPConnectionError("MCP session expired")
                    if resp.status >= 400:
                        body = (await resp.text())[:300]
                        raise MCPError(
                            f"MCP server returned HTTP {resp.status}: {body}"
                        )
                    if request_id is None:
                        return None
                    content_type = resp.headers.get("Content-Type", "")
                    if "text/event-stream" in content_type:
                        return await self._read_sse_response(resp, request_id)
                    data = await resp.json(content_type=None)
        except (aiohttp.ClientError, OSError) as err:
            raise MCPConnectionError(
                f"Could not reach MCP server at {self._url}: {err}"
            ) from err
        except TimeoutError as err:
            raise MCPError(f"MCP request timed out after {timeout}s") from err
        return self._unwrap(data, request_id)

    async def _read_sse_response(
        self, resp: aiohttp.ClientResponse, request_id: int
    ) -> dict[str, Any]:
        data_lines: list[str] = []
        async for raw_line in resp.content:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if line == "":
                data = "\n".join(data_lines)
                data_lines = []
                if not data:
                    continue
                try:
                    message = json.loads(data)
                except ValueError:
                    continue
                if (
                    isinstance(message, dict)
                    and message.get("id") == request_id
                    and ("result" in message or "error" in message)
                ):
                    return self._unwrap(message, request_id)
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        raise MCPConnectionError("MCP SSE stream ended without a response")

    @staticmethod
    def _unwrap(data: Any, request_id: int) -> dict[str, Any]:
        if not isinstance(data, dict) or data.get("id") != request_id:
            raise MCPError(f"Unexpected MCP response: {str(data)[:300]}")
        if "error" in data:
            error = data["error"] or {}
            raise MCPError(error.get("message") or "MCP server returned an error")
        return data.get("result") or {}

    async def _request(
        self, method: str, params: dict[str, Any], timeout: int
    ) -> dict[str, Any]:
        await self._ensure_initialized()
        request_id = self._next_id()
        result = await self._post_and_read(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
            request_id,
            timeout,
        )
        return result or {}

    async def _reset(self) -> None:
        async with self._lock:
            self._session_id = None
            self._initialized = False

    async def async_close(self) -> None:
        await self._reset()
