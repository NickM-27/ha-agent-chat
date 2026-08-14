"""Constants for the HA Chat integration."""

DOMAIN = "ha_chat"
VERSION = "0.2.1"

CONF_LLM_URL = "llm_base_url"
CONF_LLM_API_KEY = "llm_api_key"
CONF_LLM_MODEL = "llm_model"
CONF_MCP_URL = "mcp_url"
CONF_MCP_TOKEN = "mcp_token"
CONF_CONTEXT_WINDOW = "context_window"

DEFAULT_LLM_URL = "http://localhost:11434/v1"
DEFAULT_CONTEXT_WINDOW = 32768

PANEL_URL_PATH = "ha-chat"
PANEL_TITLE = "HA Chat"
PANEL_ICON = "mdi:forum-outline"
PANEL_COMPONENT = "ha-chat-panel"

STATIC_URL_BASE = "/ha_chat_frontend"

# Websocket API command types
WS_TYPE_CONFIG = "ha_chat/config"
WS_TYPE_TOOLS = "ha_chat/tools"
WS_TYPE_CHAT = "ha_chat/chat"
WS_TYPE_CHAT_STREAM = "ha_chat/chat_stream"
WS_TYPE_CALL_TOOL = "ha_chat/call_tool"
