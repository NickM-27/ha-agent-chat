"""HA Chat: a sidebar chat panel wired to a local LLM and an MCP server."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import ws_api
from .const import (
    CONF_MCP_TOKEN,
    CONF_MCP_URL,
    DOMAIN,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL_BASE,
)
from .mcp_client import create_mcp_client

_LOGGER = logging.getLogger(__name__)

_KEY_WS_REGISTERED = "_ws_registered"
_KEY_STATIC_REGISTERED = "_static_registered"
_KEY_PANEL_REGISTERED = "_panel_registered"

_FRONTEND_DIR = Path(__file__).parent / "frontend"
_PANEL_FILE = _FRONTEND_DIR / "ha-chat-panel.js"


def _panel_cache_key() -> str:
    """Short hash of the panel source, used as a cache-busting query param.

    Computed at setup so every change to the JS file gets a fresh URL without
    having to remember to bump a version constant.
    """
    return hashlib.sha256(_PANEL_FILE.read_bytes()).hexdigest()[:12]


def get_config(entry: ConfigEntry) -> dict:
    """Merged config: options (editable) override initial data."""
    return {**entry.data, **entry.options}


class HaChatRuntime:
    """Per-entry runtime objects shared with the websocket API."""

    def __init__(self, entry: ConfigEntry, mcp) -> None:
        self.entry = entry
        self.mcp = mcp


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up HA Chat from a config entry."""
    conf = get_config(entry)
    mcp = create_mcp_client(hass, conf[CONF_MCP_URL], conf.get(CONF_MCP_TOKEN))

    domain_data = hass.data.setdefault(DOMAIN, {})
    domain_data[entry.entry_id] = HaChatRuntime(entry, mcp)

    if not domain_data.get(_KEY_WS_REGISTERED):
        ws_api.async_register_commands(hass)
        domain_data[_KEY_WS_REGISTERED] = True

    if not domain_data.get(_KEY_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    STATIC_URL_BASE,
                    str(_FRONTEND_DIR),
                    False,
                )
            ]
        )
        domain_data[_KEY_STATIC_REGISTERED] = True

    if not domain_data.get(_KEY_PANEL_REGISTERED):
        cache_key = await hass.async_add_executor_job(_panel_cache_key)
        await panel_custom.async_register_panel(
            hass,
            webcomponent_name=PANEL_COMPONENT,
            frontend_url_path=PANEL_URL_PATH,
            module_url=f"{STATIC_URL_BASE}/ha-chat-panel.js?v={cache_key}",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=True,
            config={},
        )
        domain_data[_KEY_PANEL_REGISTERED] = True

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    async def _warm_up() -> None:
        try:
            tools = await mcp.async_list_tools()
        except Exception as err:  # noqa: BLE001 - warmup is best-effort
            _LOGGER.warning("HA Chat could not reach the MCP server yet: %s", err)
        else:
            _LOGGER.info("HA Chat connected to MCP server, %d tools", len(tools))

    entry.async_create_background_task(hass, _warm_up(), "ha_chat_mcp_warmup")
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    domain_data = hass.data.get(DOMAIN, {})
    runtime = domain_data.pop(entry.entry_id, None)
    if runtime is not None:
        await runtime.mcp.async_close()
    if domain_data.get(_KEY_PANEL_REGISTERED):
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
        domain_data[_KEY_PANEL_REGISTERED] = False
    return True
