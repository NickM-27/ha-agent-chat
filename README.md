# HA Chat

A Home Assistant custom integration that adds a **chat panel to the sidebar**, wired to:

- a **local OpenAI-compatible LLM** (Ollama, LM Studio, llama.cpp, vLLM, …), and
- the **[ha-mcp](https://github.com/homeassistant-ai/ha-mcp) MCP server** (installed via HACS), giving the model tools to inspect entities and build automations, scripts, scenes, and helpers.

The headline feature is **tool-call approval**: every MCP tool call the model wants to make is shown in the chat with **Approve / Always allow / Reject** buttons before it runs. "Always allow" auto-approves that specific tool from then on (per browser, manageable in the panel's ⚙ settings).

## How it's put together

- **LLM + MCP config lives in the integration** (config entry), so it persists across devices and browsers. Editable any time via *Settings → Devices & services → HA Chat → Configure*.
- **Chats persist in browser localStorage** — no server-side storage.
- The backend proxies chat completions and MCP tool calls over Home Assistant's own websocket API, so the panel needs no extra auth and your LLM/MCP endpoints never need to be reachable from the browser, only from Home Assistant.
- MCP transport is picked from the URL scheme: `http(s)://` → streamable HTTP (what ha-mcp uses), `ws(s)://` → plain WebSocket JSON-RPC.
- The panel and its websocket API are **admin-only**, since the tools can modify your Home Assistant configuration.

## Installation

### Manual

1. Copy `custom_components/ha_chat/` into your Home Assistant `config/custom_components/` directory.
2. Restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration → HA Chat**.

### HACS (custom repository)

1. HACS → ⋮ → *Custom repositories* → add this repo (category: Integration) → Download.
2. Restart Home Assistant and add the integration as above.

## Configuration

| Field | Example | Notes |
|---|---|---|
| LLM base URL | `http://192.168.1.10:11434/v1` | OpenAI-compatible base URL (must support `/chat/completions` with tools) |
| Model name | `qwen3:32b` | Whatever your server expects in `model` |
| LLM API key | *(optional)* | Sent as `Authorization: Bearer …` if set |
| MCP server URL | `http://homeassistant.local:9584/private_xxxx` | ha-mcp connect URL from its *Configure* screen; `ws://` URLs also work |
| MCP bearer token | *(optional)* | Only if your MCP server requires it |

> **Tip:** the ha-mcp integration prints its connect URL in the Home Assistant log and shows it on the integration's Configure page.

## Usage

- **HA Chat** appears in the sidebar. Type a request like *"Create an automation that turns on the porch light at sunset"*.
- When the model wants to call a tool, a card appears showing the tool name and its exact arguments:
  - **Approve** — run it once
  - **Always allow** — run it and auto-approve this tool from now on
  - **Reject** — skip it; the model is told the call was rejected
- The ⚙ settings dialog shows the configured model/endpoints, the tool count, and lets you revoke "always allow" tools.
- Chats live in the left column (hamburger menu on mobile) and are stored only in that browser.

## Notes & limitations

- Responses are not streamed (a typing indicator shows while the model works); local models with big tool schemas can take a while on first token.
- A safety cap stops after 15 consecutive tool rounds without user input.
- Tool auto-approvals and chat history are per-browser by design; the model/MCP settings are server-side.
