# HA Chat

A Home Assistant custom integration that adds a **chat panel to the sidebar**, wired to:

- a **local OpenAI-compatible LLM** (Ollama, LM Studio, llama.cpp, vLLM, …), and
- the **[ha-mcp](https://github.com/homeassistant-ai/ha-mcp) MCP server** (installed via HACS), giving the model tools to inspect entities and build automations, scripts, scenes, and helpers.

The headline feature is **tool-call approval**: every MCP tool call the model wants to make is shown in the chat with **Approve / Always allow / Reject** buttons before it runs. "Always allow" auto-approves that specific tool from then on (per browser, manageable in the panel's ⚙ settings).

<img width="904" height="482" alt="Example Chat" src="https://github.com/user-attachments/assets/abf84679-36e0-49d9-a9d0-e6b8a6843644" />

## Installation

### HACS

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=NickM-27&repository=ha-agent-chat&category=integration)

Or manually: HACS → ⋮ → *Custom repositories* → add this repo (category: Integration) → Download, then restart Home Assistant.

### Manual

1. Copy `custom_components/ha_chat/` into your Home Assistant `config/custom_components/` directory.
2. Restart Home Assistant.

Then go to **Settings → Devices & services → Add integration → HA Chat**.

## Configuration

| Field | Example | Notes |
| --- | --- | --- |
| LLM base URL | `http://192.168.1.10:11434/v1` | OpenAI-compatible base URL (must support `/chat/completions` with tools) |
| LLM API key | *(optional)* | Sent as `Authorization: Bearer …` if set |
| MCP server URL | `http://homeassistant.local:9584/private_xxxx` | ha-mcp connect URL from its *Configure* screen; `ws://` URLs also work |
| MCP bearer token | *(optional)* | Only if your MCP server requires it |
| Context window | `32768` | Fallback for the utilization gauge when the LLM server doesn't report a context length |

> **Tip:** the ha-mcp integration prints its connect URL in the Home Assistant log and shows it on the integration's Configure page.

The **model** is picked in the panel itself: click the model chip in the chat header to choose from the models your LLM server reports on `/models`. The choice persists per browser.

Settings are stored server-side in the integration, so they apply on every device. Chats and tool auto-approvals persist per browser.

## Usage

- **HA Chat** appears in the sidebar. Type a request like *"Create an automation that turns on the porch light at sunset"*.
- When the model wants to call a tool, a card appears showing the tool name and its exact arguments:
  - **Approve** — run it once
  - **Always allow** — run it and auto-approve this tool from now on
  - **Reject** — skip it; the model is told the call was rejected
- Responses stream in with a live tokens/s readout; the ■ button stops generation mid-response.
- The ring gauge next to the send button shows context utilization — click it for a token breakdown
  and a **Compact conversation** button.
- The ⚙ settings dialog shows the active model, the configured endpoints, the tool count, lets you revoke
  "always allow" tools, and toggles automatic compaction.

### Compaction

Long conversations eventually fill the model's context window. **Compacting** asks the model to summarize
the conversation so far; later turns then continue from that summary instead of the full history.

- Click the context gauge → **Compact conversation** to do it on demand.
- It also happens on its own once context passes **85%**, after a turn finishes. Turn that off in ⚙ → *Compaction*.
- Nothing is deleted: the full history stays in the chat, dimmed, above a collapsible card holding the summary.
- Stopping mid-summary, an error, or an empty summary rolls back and leaves the chat untouched.

## Notes & limitations

- The panel and its API are admin-only, since the tools can modify your Home Assistant configuration.
- A safety cap stops after 15 consecutive tool rounds without user input.
- Automatic compaction only triggers between turns, never partway through a run of tool calls.
- Tokens/s and the context gauge use real usage numbers when your LLM server reports them, and `~`-prefixed estimates otherwise.
