/* HA Chat sidebar panel.
 *
 * Plain web component, no build step. Talks to the ha_chat integration via
 * Home Assistant websocket commands. Chats and the auto-approve list persist
 * in this browser's localStorage; the LLM/MCP config lives in the integration.
 */

const STORAGE_CHATS = "ha-chat:chats:v1";
const STORAGE_AUTO_APPROVE = "ha-chat:auto-approve:v1";
const MAX_AUTO_TURNS = 15;

const SYSTEM_PROMPT = [
  "You are HA Chat, an assistant embedded in Home Assistant.",
  "You have tools provided by the Home Assistant MCP server; use them to inspect entities, devices, areas, and existing automations, and to create or modify automations, scripts, scenes, and helpers when the user asks.",
  "Before creating or editing anything, look up the real entity IDs involved instead of guessing.",
  "Every tool call is shown to the user for approval before it runs, so do not ask for permission in text - just make the call.",
  "Be concise. Use markdown code blocks for YAML or JSON.",
].join(" ");

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
  }
  return String(content);
}

function renderMarkdown(raw) {
  let text = contentToText(raw).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const codeBlocks = [];
  text = text.replace(/```\w*\n?([\s\S]*?)```/g, (m, code) => {
    codeBlocks.push(code.replace(/\n$/, ""));
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });
  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/^#{1,4} (.*)$/gm, "<strong>$1</strong>");
  text = text.replace(/^[-*] (.*)$/gm, "&nbsp;•&nbsp;$1");
  text = text.replace(
    /\[([^\]]+)\]\((https?:[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  text = text.replace(/\n/g, "<br>");
  text = text.replace(
    /\u0000(\d+)\u0000/g,
    (m, i) => `<pre><code>${escapeHtml(codeBlocks[+i])}</code></pre>`
  );
  return text;
}

function prettyArgs(argsJson) {
  try {
    return JSON.stringify(JSON.parse(argsJson || "{}"), null, 2);
  } catch (e) {
    return argsJson || "{}";
  }
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("ha-chat: failed to persist to localStorage", e);
  }
}

class HaChatPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._initialized = false;
    this._narrow = false;
    this._sidebarOpen = false;
    this._busy = false;
    this._executing = false;
    this._autoTurns = 0;
    this._error = null;
    this._warning = null;
    this._serverConfig = null;
    this._tools = null;
    this._toolsError = null;

    this.chats = loadJson(STORAGE_CHATS, []);
    this.autoApprove = new Set(loadJson(STORAGE_AUTO_APPROVE, []));
    // Executions can't survive a page reload; anything mid-run goes back to approved.
    for (const chat of this.chats) {
      if (chat.pending) {
        for (const call of chat.pending.calls) {
          if (call.status === "running") call.status = "approved";
        }
      }
    }
    this.currentId = this.chats.length ? this.chats[0].id : null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._buildUI();
      this._loadServerInfo();
      this._render();
    }
  }

  get hass() {
    return this._hass;
  }

  set narrow(value) {
    const changed = this._narrow !== value;
    this._narrow = value;
    if (changed && this._initialized) this._render();
  }

  /* ---------- server communication ---------- */

  _ws(message) {
    return this._hass.connection.sendMessagePromise(message);
  }

  async _loadServerInfo() {
    try {
      this._serverConfig = await this._ws({ type: "ha_chat/config" });
    } catch (e) {
      this._serverConfig = null;
    }
    await this._loadTools(false);
    this._render();
  }

  async _loadTools(refresh) {
    try {
      const result = await this._ws({ type: "ha_chat/tools", refresh });
      this._tools = result.tools;
      this._toolsError = null;
    } catch (e) {
      this._tools = null;
      this._toolsError = e?.message || "MCP server unreachable";
    }
  }

  /* ---------- chat state ---------- */

  _save() {
    saveJson(STORAGE_CHATS, this.chats);
  }

  _saveAutoApprove() {
    saveJson(STORAGE_AUTO_APPROVE, [...this.autoApprove]);
  }

  _currentChat() {
    return this.chats.find((chat) => chat.id === this.currentId) || null;
  }

  _newChat() {
    const chat = {
      id: uid(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      pending: null,
    };
    this.chats.unshift(chat);
    this.currentId = chat.id;
    this._sidebarOpen = false;
    this._error = null;
    this._warning = null;
    this._save();
    this._render();
    this._focusInput();
  }

  _deleteChat(id) {
    const chat = this.chats.find((c) => c.id === id);
    if (!chat) return;
    if (!confirm(`Delete "${chat.title}"?`)) return;
    this.chats = this.chats.filter((c) => c.id !== id);
    if (this.currentId === id) {
      this.currentId = this.chats.length ? this.chats[0].id : null;
    }
    this._save();
    this._render();
  }

  _selectChat(id) {
    this.currentId = id;
    this._sidebarOpen = false;
    this._error = null;
    this._warning = null;
    this._render();
    this._focusInput();
  }

  _touch(chat) {
    chat.updatedAt = Date.now();
    this.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /* ---------- conversation loop ---------- */

  async _sendUserMessage(text) {
    let chat = this._currentChat();
    if (!chat) {
      this._newChat();
      chat = this._currentChat();
    }
    if (chat.messages.length === 0) {
      chat.title = text.length > 42 ? `${text.slice(0, 42)}…` : text;
    }
    chat.messages.push({ role: "user", content: text });
    this._autoTurns = 0;
    this._touch(chat);
    this._save();
    this._render();
    await this._runLLM(chat);
  }

  async _runLLM(chat) {
    this._busy = true;
    this._error = null;
    this._render();
    let response;
    try {
      response = await this._ws({
        type: "ha_chat/chat",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...chat.messages],
      });
    } catch (e) {
      this._busy = false;
      this._error = e?.message || "Request failed";
      this._render();
      return;
    }
    this._busy = false;
    this._warning = response.warning || null;
    const message = response.message;
    chat.messages.push(message);
    this._touch(chat);

    const toolCalls = message.tool_calls || [];
    if (toolCalls.length) {
      chat.pending = {
        calls: toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name || "unknown",
          args: tc.function?.arguments || "{}",
          status: this.autoApprove.has(tc.function?.name) ? "approved" : "pending",
          result: null,
        })),
      };
      this._save();
      this._render();
      this._maybeExecute(chat);
    } else {
      chat.pending = null;
      this._save();
      this._render();
    }
  }

  _setCallStatus(chat, callId, status) {
    const call = chat.pending?.calls.find((c) => c.id === callId);
    if (!call || call.status !== "pending") return;
    call.status = status;
    this._save();
    this._render();
    this._maybeExecute(chat);
  }

  _alwaysAllow(chat, callId) {
    const call = chat.pending?.calls.find((c) => c.id === callId);
    if (!call) return;
    this.autoApprove.add(call.name);
    this._saveAutoApprove();
    // Approve every pending call for this tool, not just the clicked one.
    for (const other of chat.pending.calls) {
      if (other.name === call.name && other.status === "pending") {
        other.status = "approved";
      }
    }
    this._save();
    this._render();
    this._maybeExecute(chat);
  }

  async _maybeExecute(chat) {
    if (!chat.pending || this._executing || this._busy) return;
    const calls = chat.pending.calls;
    if (calls.some((c) => c.status === "pending")) return;

    this._executing = true;
    for (const call of calls) {
      if (call.status !== "approved") continue;
      call.status = "running";
      this._render();
      try {
        const result = await this._ws({
          type: "ha_chat/call_tool",
          name: call.name,
          arguments: JSON.parse(call.args || "{}"),
        });
        call.status = result.is_error ? "error" : "done";
        call.result = result.content;
      } catch (e) {
        call.status = "error";
        call.result = e?.message || "Tool call failed";
      }
      this._save();
      this._render();
    }

    for (const call of calls) {
      let content;
      if (call.status === "rejected") {
        content = "The user rejected this tool call. Do not retry it unless asked.";
      } else {
        content = call.result ?? "(no output)";
      }
      chat.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(content),
        _ui: { name: call.name, status: call.status },
      });
    }
    chat.pending = null;
    this._executing = false;
    this._touch(chat);
    this._save();

    this._autoTurns += 1;
    if (this._autoTurns >= MAX_AUTO_TURNS) {
      this._error = `Stopped after ${MAX_AUTO_TURNS} consecutive tool rounds. Send a message to continue.`;
      this._render();
      return;
    }
    await this._runLLM(chat);
  }

  /* ---------- UI skeleton ---------- */

  _buildUI() {
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div id="layout">
        <div id="sidebar">
          <div id="sidebar-head">
            <button id="new-chat" class="primary">+ New chat</button>
          </div>
          <div id="chat-list"></div>
        </div>
        <div id="scrim"></div>
        <div id="main">
          <div id="header">
            <button id="menu-btn" class="icon-btn" title="Chats">☰</button>
            <div id="header-title">HA Chat</div>
            <div id="header-status"></div>
            <button id="settings-btn" class="icon-btn" title="Settings">⚙</button>
          </div>
          <div id="banner-area"></div>
          <div id="messages"></div>
          <div id="composer">
            <textarea id="input" rows="1" placeholder="Message…"></textarea>
            <button id="send" class="primary" title="Send">➤</button>
          </div>
        </div>
      </div>
      <div id="settings-overlay" hidden>
        <div id="settings-dialog">
          <div class="dialog-head">
            <span>Settings</span>
            <button id="settings-close" class="icon-btn">✕</button>
          </div>
          <div id="settings-body"></div>
        </div>
      </div>
    `;
    this.$ = (sel) => this.shadowRoot.querySelector(sel);

    this.$("#new-chat").addEventListener("click", () => this._newChat());
    this.$("#menu-btn").addEventListener("click", () => {
      this._sidebarOpen = !this._sidebarOpen;
      this._render();
    });
    this.$("#scrim").addEventListener("click", () => {
      this._sidebarOpen = false;
      this._render();
    });
    this.$("#settings-btn").addEventListener("click", () => this._openSettings());
    this.$("#settings-close").addEventListener("click", () =>
      this.$("#settings-overlay").setAttribute("hidden", "")
    );

    const input = this.$("#input");
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        this._handleSend();
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    });
    this.$("#send").addEventListener("click", () => this._handleSend());
  }

  _handleSend() {
    const input = this.$("#input");
    const text = input.value.trim();
    if (!text || this._busy || this._executing) return;
    const chat = this._currentChat();
    if (chat?.pending) return;
    input.value = "";
    input.style.height = "auto";
    this._sendUserMessage(text);
  }

  _focusInput() {
    setTimeout(() => this.$("#input")?.focus(), 0);
  }

  /* ---------- rendering ---------- */

  _render() {
    if (!this._initialized) return;
    const layout = this.$("#layout");
    layout.classList.toggle("narrow", !!this._narrow);
    layout.classList.toggle("sidebar-open", !!this._sidebarOpen);
    this._renderHeader();
    this._renderChatList();
    this._renderBanners();
    this._renderMessages();
    this._renderComposerState();
  }

  _renderHeader() {
    const status = this.$("#header-status");
    status.textContent = "";
    const model = this._serverConfig?.model;
    if (model) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = model;
      status.appendChild(chip);
    }
    const toolsChip = document.createElement("span");
    toolsChip.className = "chip";
    if (this._tools) {
      toolsChip.textContent = `${this._tools.length} tools`;
    } else if (this._toolsError) {
      toolsChip.textContent = "MCP offline";
      toolsChip.classList.add("chip-error");
      toolsChip.title = this._toolsError;
    } else {
      toolsChip.textContent = "…";
    }
    status.appendChild(toolsChip);
  }

  _renderChatList() {
    const list = this.$("#chat-list");
    list.textContent = "";
    for (const chat of this.chats) {
      const item = document.createElement("div");
      item.className = "chat-item" + (chat.id === this.currentId ? " active" : "");
      const title = document.createElement("span");
      title.className = "chat-title";
      title.textContent = chat.title;
      const time = document.createElement("span");
      time.className = "chat-time";
      time.textContent = relTime(chat.updatedAt);
      const del = document.createElement("button");
      del.className = "icon-btn chat-del";
      del.textContent = "🗑";
      del.title = "Delete chat";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._deleteChat(chat.id);
      });
      item.append(title, time, del);
      item.addEventListener("click", () => this._selectChat(chat.id));
      list.appendChild(item);
    }
    if (!this.chats.length) {
      const empty = document.createElement("div");
      empty.className = "muted pad";
      empty.textContent = "No chats yet";
      list.appendChild(empty);
    }
  }

  _renderBanners() {
    const area = this.$("#banner-area");
    area.textContent = "";
    for (const [text, cls] of [
      [this._error, "banner-error"],
      [this._warning, "banner-warn"],
    ]) {
      if (!text) continue;
      const banner = document.createElement("div");
      banner.className = `banner ${cls}`;
      const span = document.createElement("span");
      span.textContent = text;
      const close = document.createElement("button");
      close.className = "icon-btn";
      close.textContent = "✕";
      close.addEventListener("click", () => {
        if (cls === "banner-error") this._error = null;
        else this._warning = null;
        this._render();
      });
      banner.append(span, close);
      area.appendChild(banner);
    }
  }

  _renderMessages() {
    const container = this.$("#messages");
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    container.textContent = "";
    const chat = this._currentChat();

    if (!chat || !chat.messages.length) {
      const welcome = document.createElement("div");
      welcome.className = "welcome";
      welcome.innerHTML = `
        <h2>HA Chat</h2>
        <p>Ask about your entities, or have it build automations, scripts and
        scenes through the MCP server. Tool calls wait for your approval before
        they run.</p>`;
      container.appendChild(welcome);
      return;
    }

    // Map tool results back to their originating call for inline display.
    const toolResults = new Map();
    for (const message of chat.messages) {
      if (message.role === "tool") toolResults.set(message.tool_call_id, message);
    }

    for (const message of chat.messages) {
      if (message.role === "system" || message.role === "tool") continue;

      if (message.role === "user") {
        const row = document.createElement("div");
        row.className = "msg-row user";
        const bubble = document.createElement("div");
        bubble.className = "bubble user";
        bubble.textContent = contentToText(message.content);
        row.appendChild(bubble);
        container.appendChild(row);
        continue;
      }

      // assistant
      const text = contentToText(message.content);
      if (text && text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()) {
        const row = document.createElement("div");
        row.className = "msg-row assistant";
        const bubble = document.createElement("div");
        bubble.className = "bubble assistant";
        bubble.innerHTML = renderMarkdown(text);
        row.appendChild(bubble);
        container.appendChild(row);
      }
      for (const tc of message.tool_calls || []) {
        const isPending = chat.pending?.calls.some((c) => c.id === tc.id);
        if (isPending) continue; // rendered as an approval card below
        container.appendChild(
          this._toolHistoryCard(tc, toolResults.get(tc.id))
        );
      }
    }

    if (chat.pending) {
      for (const call of chat.pending.calls) {
        container.appendChild(this._approvalCard(chat, call));
      }
      const unresolved = chat.pending.calls.some((c) => c.status === "pending");
      const running = chat.pending.calls.some((c) => c.status === "running");
      if (!unresolved && !running && !this._executing && !this._busy) {
        const btn = document.createElement("button");
        btn.className = "primary continue-btn";
        btn.textContent = "Continue";
        btn.addEventListener("click", () => this._maybeExecute(chat));
        container.appendChild(btn);
      }
    }

    if (this._busy) {
      const typing = document.createElement("div");
      typing.className = "typing";
      typing.innerHTML = "<span></span><span></span><span></span>";
      container.appendChild(typing);
    }

    if (atBottom) container.scrollTop = container.scrollHeight;
  }

  _toolHistoryCard(toolCall, resultMessage) {
    const card = document.createElement("div");
    card.className = "tool-card done";
    const status = resultMessage?._ui?.status || (resultMessage ? "done" : "error");
    const icon = { done: "✓", error: "✗", rejected: "⊘" }[status] || "✓";

    const head = document.createElement("div");
    head.className = "tool-head";
    head.innerHTML = `<span class="tool-status ${status}">${icon}</span>`;
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = toolCall.function?.name || "tool";
    head.appendChild(name);
    card.appendChild(head);

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "arguments & result";
    details.appendChild(summary);
    const args = document.createElement("pre");
    args.textContent = prettyArgs(toolCall.function?.arguments);
    details.appendChild(args);
    if (resultMessage) {
      const result = document.createElement("pre");
      result.className = "tool-result";
      result.textContent = contentToText(resultMessage.content);
      details.appendChild(result);
    }
    card.appendChild(details);
    return card;
  }

  _approvalCard(chat, call) {
    const card = document.createElement("div");
    card.className = `tool-card pending-card ${call.status}`;

    const head = document.createElement("div");
    head.className = "tool-head";
    const label = {
      pending: "Wants to run",
      approved: "Approved",
      running: "Running…",
      rejected: "Rejected",
      done: "Finished",
      error: "Failed",
    }[call.status];
    head.innerHTML = `<span class="tool-status ${call.status}">${
      call.status === "running" ? "⏳" : call.status === "pending" ? "🔧" : ""
    }</span>`;
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = call.name;
    const state = document.createElement("span");
    state.className = "muted";
    state.textContent = label;
    head.append(name, state);
    card.appendChild(head);

    const args = document.createElement("pre");
    args.textContent = prettyArgs(call.args);
    card.appendChild(args);

    if (call.result != null) {
      const result = document.createElement("pre");
      result.className = "tool-result";
      result.textContent = contentToText(call.result);
      card.appendChild(result);
    }

    if (call.status === "pending") {
      const actions = document.createElement("div");
      actions.className = "tool-actions";
      const approve = document.createElement("button");
      approve.className = "primary";
      approve.textContent = "Approve";
      approve.addEventListener("click", () =>
        this._setCallStatus(chat, call.id, "approved")
      );
      const always = document.createElement("button");
      always.className = "secondary";
      always.textContent = "Always allow";
      always.title = `Auto-approve every future "${call.name}" call in this browser`;
      always.addEventListener("click", () => this._alwaysAllow(chat, call.id));
      const reject = document.createElement("button");
      reject.className = "danger";
      reject.textContent = "Reject";
      reject.addEventListener("click", () =>
        this._setCallStatus(chat, call.id, "rejected")
      );
      actions.append(approve, always, reject);
      card.appendChild(actions);
    } else if (call.status === "approved" && this.autoApprove.has(call.name)) {
      const note = document.createElement("div");
      note.className = "muted small";
      note.textContent = "Auto-approved";
      card.appendChild(note);
    }
    return card;
  }

  _renderComposerState() {
    const chat = this._currentChat();
    const blocked = this._busy || this._executing || !!chat?.pending;
    const send = this.$("#send");
    const input = this.$("#input");
    send.disabled = blocked;
    input.placeholder = chat?.pending
      ? "Resolve the pending tool calls first…"
      : this._busy
        ? "Waiting for the model…"
        : "Message…";
  }

  /* ---------- settings dialog ---------- */

  _openSettings() {
    const overlay = this.$("#settings-overlay");
    const body = this.$("#settings-body");
    body.textContent = "";

    const info = document.createElement("div");
    info.className = "settings-section";
    const conf = this._serverConfig;
    info.innerHTML = `
      <h3>Connection</h3>
      <div class="kv"><span>Model</span><span>${escapeHtml(conf?.model || "?")}</span></div>
      <div class="kv"><span>LLM</span><span>${escapeHtml(conf?.llm_url || "?")}</span></div>
      <div class="kv"><span>MCP</span><span>${escapeHtml(conf?.mcp_url || "?")}</span></div>
      <div class="kv"><span>Tools</span><span>${
        this._tools ? this._tools.length : escapeHtml(this._toolsError || "…")
      }</span></div>
      <p class="muted small">Endpoints are configured on the HA Chat integration
      (Settings → Devices &amp; services → HA Chat → Configure).</p>`;
    const refresh = document.createElement("button");
    refresh.className = "secondary";
    refresh.textContent = "Refresh tools";
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      refresh.textContent = "Refreshing…";
      await this._loadTools(true);
      this._render();
      this._openSettings();
    });
    info.appendChild(refresh);
    body.appendChild(info);

    const auto = document.createElement("div");
    auto.className = "settings-section";
    const h = document.createElement("h3");
    h.textContent = "Auto-approved tools";
    auto.appendChild(h);
    if (!this.autoApprove.size) {
      const none = document.createElement("p");
      none.className = "muted small";
      none.textContent =
        'None yet. Use "Always allow" on a tool call to add one. Stored in this browser only.';
      auto.appendChild(none);
    }
    for (const name of [...this.autoApprove].sort()) {
      const row = document.createElement("div");
      row.className = "auto-row";
      const label = document.createElement("code");
      label.textContent = name;
      const remove = document.createElement("button");
      remove.className = "icon-btn";
      remove.textContent = "✕";
      remove.title = "Require approval again";
      remove.addEventListener("click", () => {
        this.autoApprove.delete(name);
        this._saveAutoApprove();
        this._openSettings();
      });
      row.append(label, remove);
      auto.appendChild(row);
    }
    body.appendChild(auto);

    overlay.removeAttribute("hidden");
  }
}

const STYLES = `
  :host {
    display: block;
    height: 100vh;
    background: var(--primary-background-color, #fafafa);
    color: var(--primary-text-color, #212121);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
  }
  * { box-sizing: border-box; }
  button { font: inherit; cursor: pointer; border: none; border-radius: 8px; }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary {
    background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
    padding: 8px 16px;
  }
  .secondary {
    background: var(--secondary-background-color, #e5e5e5);
    color: var(--primary-text-color, #212121);
    padding: 8px 16px;
    border: 1px solid var(--divider-color, #e0e0e0);
  }
  .danger { background: var(--error-color, #db4437); color: #fff; padding: 8px 16px; }
  .icon-btn {
    background: transparent;
    color: var(--secondary-text-color, #727272);
    padding: 4px 8px;
    font-size: 16px;
  }
  .muted { color: var(--secondary-text-color, #727272); }
  .small { font-size: 12px; }
  .pad { padding: 12px; }
  code, pre {
    font-family: SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
  }

  #layout { display: flex; height: 100%; overflow: hidden; position: relative; }

  #sidebar {
    width: 270px;
    min-width: 270px;
    border-right: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    display: flex;
    flex-direction: column;
  }
  #sidebar-head { padding: 12px; }
  #sidebar-head .primary { width: 100%; }
  #chat-list { overflow-y: auto; flex: 1; }
  .chat-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    cursor: pointer;
    border-left: 3px solid transparent;
  }
  .chat-item:hover { background: var(--secondary-background-color, #f5f5f5); }
  .chat-item.active {
    border-left-color: var(--primary-color, #03a9f4);
    background: var(--secondary-background-color, #f5f5f5);
  }
  .chat-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
  }
  .chat-time { font-size: 11px; color: var(--secondary-text-color, #727272); }
  .chat-del { visibility: hidden; font-size: 13px; }
  .chat-item:hover .chat-del { visibility: visible; }

  #scrim { display: none; }

  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
  }
  #header-title { font-size: 18px; font-weight: 500; }
  #header-status { flex: 1; display: flex; gap: 6px; justify-content: flex-end; }
  #menu-btn { display: none; }
  .chip {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 12px;
    background: var(--secondary-background-color, #f0f0f0);
    color: var(--secondary-text-color, #727272);
    white-space: nowrap;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip-error { background: var(--error-color, #db4437); color: #fff; }

  #banner-area { flex: none; }
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 16px;
    font-size: 13px;
  }
  .banner-error { background: rgba(219, 68, 55, 0.12); color: var(--error-color, #b71c1c); }
  .banner-warn { background: rgba(255, 152, 0, 0.14); }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
  }
  .welcome { margin: auto; text-align: center; max-width: 420px; color: var(--secondary-text-color, #727272); }
  .msg-row { display: flex; }
  .msg-row.user { justify-content: flex-end; }
  .bubble {
    max-width: 78%;
    padding: 10px 14px;
    border-radius: 14px;
    line-height: 1.45;
    font-size: 14px;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .bubble.user {
    background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
    border-bottom-right-radius: 4px;
  }
  .bubble.assistant {
    background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color, #e0e0e0);
    border-bottom-left-radius: 4px;
    white-space: normal;
  }
  .bubble.assistant pre {
    background: var(--secondary-background-color, #f5f5f5);
    padding: 10px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 8px 0;
  }
  .bubble.assistant code {
    background: var(--secondary-background-color, #f5f5f5);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .bubble.assistant pre code { background: none; padding: 0; }
  .bubble.assistant a { color: var(--primary-color, #03a9f4); }

  .tool-card {
    border: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    border-radius: 12px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 78%;
  }
  .tool-card.pending-card.pending { border-color: var(--primary-color, #03a9f4); }
  .tool-card.pending-card.error, .tool-status.error { border-color: var(--error-color, #db4437); }
  .tool-head { display: flex; align-items: center; gap: 8px; }
  .tool-name { font-family: SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; }
  .tool-status.done { color: var(--success-color, #0f9d58); }
  .tool-status.error { color: var(--error-color, #db4437); }
  .tool-status.rejected { color: var(--secondary-text-color, #727272); }
  .tool-card pre {
    background: var(--secondary-background-color, #f5f5f5);
    border-radius: 8px;
    padding: 8px 10px;
    margin: 8px 0 0;
    overflow-x: auto;
    max-height: 240px;
    overflow-y: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tool-result { border-left: 3px solid var(--primary-color, #03a9f4); }
  .tool-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .tool-card details summary {
    cursor: pointer;
    color: var(--secondary-text-color, #727272);
    font-size: 12px;
    margin-top: 4px;
  }
  .continue-btn { align-self: flex-start; }

  .typing { display: flex; gap: 4px; padding: 8px 4px; }
  .typing span {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--secondary-text-color, #999);
    animation: blink 1.2s infinite both;
  }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

  #composer {
    display: flex;
    gap: 8px;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    max-width: 900px;
    width: 100%;
    margin: 0 auto;
  }
  #input {
    flex: 1;
    resize: none;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
    padding: 10px 12px;
    font: inherit;
    background: var(--primary-background-color, #fafafa);
    color: inherit;
    outline: none;
    max-height: 160px;
  }
  #input:focus { border-color: var(--primary-color, #03a9f4); }
  #send { min-width: 48px; }

  /* narrow / mobile */
  #layout.narrow #sidebar {
    position: absolute;
    z-index: 3;
    height: 100%;
    left: -280px;
    transition: left 0.2s ease;
    box-shadow: none;
  }
  #layout.narrow.sidebar-open #sidebar { left: 0; box-shadow: 2px 0 12px rgba(0,0,0,0.25); }
  #layout.narrow.sidebar-open #scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 2;
    background: rgba(0,0,0,0.3);
  }
  #layout.narrow #menu-btn { display: block; }
  #layout.narrow .bubble, #layout.narrow .tool-card { max-width: 92%; }

  /* settings dialog */
  #settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }
  #settings-dialog {
    background: var(--card-background-color, #fff);
    border-radius: 12px;
    width: min(480px, 92vw);
    max-height: 84vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .dialog-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 18px;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
    font-weight: 500;
    font-size: 16px;
  }
  #settings-body { padding: 8px 18px 18px; }
  .settings-section { margin-top: 12px; }
  .settings-section h3 { margin: 8px 0; font-size: 14px; }
  .kv { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; padding: 3px 0; }
  .kv span:first-child { color: var(--secondary-text-color, #727272); }
  .kv span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
  .auto-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px dashed var(--divider-color, #e0e0e0);
  }
`;

customElements.define("ha-chat-panel", HaChatPanel);
