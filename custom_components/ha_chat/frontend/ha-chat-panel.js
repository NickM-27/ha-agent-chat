/* HA Chat sidebar panel.
 *
 * Plain web component, no build step. Talks to the ha_chat integration via
 * Home Assistant websocket commands. Chats and the auto-approve list persist
 * in this browser's localStorage; the LLM/MCP config lives in the integration.
 */

const STORAGE_CHATS = "ha-chat:chats:v1";
const STORAGE_AUTO_APPROVE = "ha-chat:auto-approve:v1";
const STORAGE_REASONING = "ha-chat:reasoning:v1";
const STORAGE_MODEL = "ha-chat:model:v1";
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

// Placeholder sentinels for the markdown renderer, built at runtime so the
// source file contains no control characters.
const FENCE_MARK = String.fromCharCode(0);
const CODE_MARK = String.fromCharCode(1);

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

/* ---------- markdown ---------- */

// Inline formatting for already-HTML-escaped text.
function inlineMd(text) {
  const codeSpans = [];
  text = text.replace(/`([^`\n]+)`/g, (m, code) => {
    codeSpans.push(code);
    return `${CODE_MARK}${codeSpans.length - 1}${CODE_MARK}`;
  });
  text = text.replace(
    /\[([^\]]+)\]\((https?:[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(
    /(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g,
    "$1<em>$2</em>"
  );
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  const markPattern = new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g");
  text = text.replace(markPattern, (m, i) => `<code>${codeSpans[+i] ?? ""}</code>`);
  return text;
}

function renderMarkdown(raw) {
  let text = contentToText(raw)
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/\r\n/g, "\n")
    .trim();

  // Pull out fenced code blocks first. An unterminated fence (mid-stream)
  // still renders as a code block.
  const fences = [];
  text = text.replace(/```\w*\n?([\s\S]*?)(?:```|$)/g, (m, code) => {
    fences.push(code.replace(/\n$/, ""));
    return `\n${FENCE_MARK}${fences.length - 1}${FENCE_MARK}\n`;
  });
  text = escapeHtml(text);

  const fenceLine = new RegExp(`^${FENCE_MARK}(\\d+)${FENCE_MARK}\\s*$`);
  const lines = text.split("\n");
  const out = [];
  let para = [];
  let list = null;
  let quote = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inlineMd).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(
        `<${list.type}>${list.items
          .map((item) => `<li>${inlineMd(item)}</li>`)
          .join("")}</${list.type}>`
      );
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map(inlineMd).join("<br>")}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(fenceLine))) {
      flushAll();
      out.push(`<pre><code>${fences[+m[1]] ?? ""}</code></pre>`);
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushAll();
      const level = Math.min(m[1].length + 2, 6);
      out.push(`<h${level}>${inlineMd(m[2])}</h${level}>`);
    } else if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      flushAll();
      out.push("<hr>");
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flushPara();
      flushList();
      quote.push(m[1]);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushPara();
      flushQuote();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      flushQuote();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(m[1]);
    } else if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      flushAll();
      const parseRow = (l) =>
        l
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => inlineMd(cell.trim()));
      const header = parseRow(line);
      i += 1; // skip separator row
      const rows = [];
      while (i + 1 < lines.length && lines[i + 1].includes("|")) {
        rows.push(parseRow(lines[++i]));
      }
      out.push(
        `<table><thead><tr>${header
          .map((h) => `<th>${h}</th>`)
          .join("")}</tr></thead><tbody>` +
          rows
            .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
            .join("") +
          "</tbody></table>"
      );
    } else if (line.trim() === "") {
      flushAll();
    } else {
      flushList();
      flushQuote();
      para.push(line);
    }
  }
  flushAll();
  return out.join("");
}

/* ---------- misc helpers ---------- */

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
    this._editingIndex = null;
    this._autoTurns = 0;
    this._pausedChatId = null;
    this._error = null;
    this._warning = null;
    this._serverConfig = null;
    this._tools = null;
    this._toolsError = null;
    this._streamText = "";
    this._streamThink = "";
    this._streamRaf = null;
    this._streamStart = null;
    this._streamChunks = 0;
    this._streamTimings = null;
    this._streamChatId = null;
    this._ctxDetailsOpen = true;
    this._unsubStream = null;
    this._stopCurrent = null;
    // null = follow the server's default until the user flips the toggle.
    this._reasoningPref = loadJson(STORAGE_REASONING, null);
    // null = let the server pick (legacy configured model or first available).
    this._model = loadJson(STORAGE_MODEL, null);

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
    // Drop empty chats left over from before chats were created lazily.
    this.chats = this.chats.filter((chat) => chat.messages.length);
    this.currentId = this.chats.length ? this.chats[0].id : null;

    // Pin the panel to the real visible viewport. HA gives custom panels no
    // definite height, and viewport units miss browser chrome / safe areas /
    // the on-screen keyboard; visualViewport is the ground truth.
    this._updateHeight = () => {
      const viewport = window.visualViewport;
      const height = viewport ? viewport.height : window.innerHeight;
      this.style.height = `${Math.round(height)}px`;
    };
  }

  connectedCallback() {
    this._updateHeight();
    window.addEventListener("resize", this._updateHeight);
    window.visualViewport?.addEventListener("resize", this._updateHeight);
  }

  disconnectedCallback() {
    window.removeEventListener("resize", this._updateHeight);
    window.visualViewport?.removeEventListener("resize", this._updateHeight);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._buildUI();
      this._loadServerInfo();
      this._render();
      this._updateHeight();
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

  _reasoningOn() {
    if (this._reasoningPref !== null) return this._reasoningPref;
    return this._serverConfig?.reasoning_default ?? true;
  }

  async _loadServerInfo() {
    await this._loadConfig();
    await this._loadTools(false);
    this._render();
  }

  async _loadConfig() {
    // The server resolves the model: our pick, else the legacy configured
    // one, else the first the LLM server reports. It also probes that model
    // for context window and reasoning support.
    const request = { type: "ha_chat/config" };
    if (this._model) request.model = this._model;
    try {
      this._serverConfig = await this._ws(request);
      this._model = this._serverConfig.model || this._model;
    } catch (e) {
      this._serverConfig = null;
    }
  }

  async _selectModel(model) {
    this.$("#model-menu").setAttribute("hidden", "");
    if (model === this._model) return;
    this._model = model;
    saveJson(STORAGE_MODEL, model);
    this._renderHeader();
    // Re-probe: context window and reasoning support differ per model.
    await this._loadConfig();
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
    // Just show the blank welcome view; the chat record is created when the
    // first message is sent (see _sendUserMessage).
    this.currentId = null;
    this._sidebarOpen = false;
    this._error = null;
    this._warning = null;
    this._editingIndex = null;
    this._render();
    this._focusInput();
  }

  _createChat() {
    const chat = {
      id: uid(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      pending: null,
      usage: null,
    };
    this.chats.unshift(chat);
    this.currentId = chat.id;
    return chat;
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
    this._editingIndex = null;
    this._render();
    this._focusInput();
  }

  _touch(chat) {
    chat.updatedAt = Date.now();
    this.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /* ---------- conversation loop ---------- */

  async _sendUserMessage(text) {
    const chat = this._currentChat() || this._createChat();
    if (chat.messages.length === 0) {
      chat.title = text.length > 42 ? `${text.slice(0, 42)}…` : text;
    }
    chat.messages.push({ role: "user", content: text });
    this._autoTurns = 0;
    this._pausedChatId = null;
    this._touch(chat);
    this._save();
    this._render();
    await this._runLLM(chat);
  }

  async _runLLM(chat) {
    this._busy = true;
    this._error = null;
    this._streamText = "";
    this._streamThink = "";
    this._streamStart = null;
    this._streamChunks = 0;
    this._streamTimings = null;
    this._streamChatId = chat.id;
    this._render();

    let unsub = null;
    let finished = false;

    const cleanup = () => {
      if (unsub) {
        try {
          unsub();
        } catch (e) {
          /* connection may be gone */
        }
      }
      this._unsubStream = null;
      this._stopCurrent = null;
    };

    const finalize = (message, meta) => {
      if (finished) return;
      finished = true;
      this._busy = false;
      this._streamText = "";
      this._streamThink = "";
      cleanup();
      if (!message) {
        this._render();
        return;
      }
      if (meta) message._ui = meta;
      chat.messages.push(message);
      if (meta?.usage || meta?.timings) {
        chat.usage = meta.usage || chat.usage;
        chat.timings = meta.timings || null;
        if (meta.rate) chat.rate = meta.rate;
        // Running totals across turns; "evaluated" counts only freshly
        // processed prompt tokens when the server reports cache hits.
        const totals = (chat.totals = chat.totals || {
          evaluated: 0,
          generated: 0,
        });
        const cached =
          meta.timings?.cache_n ??
          meta.usage?.prompt_tokens_details?.cached_tokens ??
          0;
        totals.evaluated +=
          meta.timings?.prompt_n ??
          Math.max(0, (meta.usage?.prompt_tokens || 0) - cached);
        totals.generated +=
          meta.usage?.completion_tokens ?? meta.timings?.predicted_n ?? 0;
      }
      this._touch(chat);

      const toolCalls = message.tool_calls || [];
      if (toolCalls.length) {
        chat.pending = {
          calls: toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function?.name || "unknown",
            args: tc.function?.arguments || "{}",
            status: this.autoApprove.has(tc.function?.name)
              ? "approved"
              : "pending",
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
    };

    const onEvent = (ev) => {
      if (ev.type === "delta") {
        if (this._streamStart === null) this._streamStart = performance.now();
        this._streamChunks += 1;
        this._streamText += ev.content;
        this._renderStream();
      } else if (ev.type === "think") {
        if (this._streamStart === null) this._streamStart = performance.now();
        this._streamChunks += 1;
        this._streamThink += ev.content;
        this._renderStream();
      } else if (ev.type === "stats") {
        // Live prompt/cache/speed timings from the server (llama.cpp).
        this._streamTimings = ev.timings || null;
        this._renderGauge(this._currentChat());
        this._renderCtxPopover();
        const meta = this.shadowRoot.querySelector("#stream-meta");
        if (meta) meta.textContent = this._liveStats();
      } else if (ev.type === "done") {
        this._warning = ev.warning || null;
        finalize(ev.message, {
          rate: ev.token_rate,
          tokens: ev.completion_tokens,
          estimated: ev.estimated,
          elapsed: ev.elapsed,
          usage: ev.usage || null,
          timings: ev.timings || null,
          think: ev.reasoning || null,
        });
      } else if (ev.type === "error") {
        this._error = ev.error || "Request failed";
        finalize(
          this._streamText
            ? { role: "assistant", content: this._streamText }
            : null,
          { partial: true }
        );
      }
    };

    this._stopCurrent = () => {
      const partial = this._streamText;
      finalize(
        partial ? { role: "assistant", content: partial } : null,
        { stopped: true }
      );
    };

    const request = {
      type: "ha_chat/chat_stream",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...chat.messages],
    };
    if (this._model) request.model = this._model;
    // Only steer reasoning for models that support it; otherwise leave the
    // request untouched.
    if (this._serverConfig?.supports_reasoning) {
      request.reasoning = this._reasoningOn();
    }
    try {
      unsub = await this._hass.connection.subscribeMessage(onEvent, request, {
        resubscribe: false,
      });
      this._unsubStream = unsub;
      // The user hit stop before the subscription resolved.
      if (finished) cleanup();
    } catch (e) {
      this._error = e?.message || "Request failed";
      finished = true;
      this._busy = false;
      this._stopCurrent = null;
      this._render();
    }
  }

  _liveStats() {
    // Prefer the server's own timings when it reports them.
    const timings = this._streamTimings;
    if (timings?.predicted_n) {
      const rate = timings.predicted_per_second;
      const bits = [];
      if (rate) bits.push(`${Number(rate).toFixed(1)} tok/s`);
      bits.push(`${timings.predicted_n} tokens`);
      return bits.join(" · ");
    }
    // Delta chunks roughly equal tokens; wait for a few before showing a rate.
    if (!this._streamStart || this._streamChunks < 5) return "";
    const seconds = (performance.now() - this._streamStart) / 1000;
    if (seconds < 0.5) return "";
    const rate = (this._streamChunks / seconds).toFixed(1);
    return `~${rate} tok/s · ~${this._streamChunks} tokens`;
  }

  _thinkBlock(text, streaming) {
    const details = document.createElement("details");
    details.className = "think-box";
    if (streaming) details.id = "stream-think";
    const summary = document.createElement("summary");
    summary.textContent = streaming ? "Thinking…" : "Thinking";
    const body = document.createElement("div");
    body.className = "think-content";
    body.textContent = text;
    details.append(summary, body);
    return details;
  }

  _renderStream() {
    if (this._streamRaf) return;
    this._streamRaf = requestAnimationFrame(() => {
      this._streamRaf = null;
      const needFull =
        (this._streamText && !this.shadowRoot.querySelector("#stream-bubble")) ||
        (this._streamThink && !this.shadowRoot.querySelector("#stream-think"));
      if (needFull) {
        this._render();
        return;
      }
      // Measure before the bubble grows: only follow the stream when the
      // reader is already at the bottom, so scrolling up to reread works.
      const container = this.$("#messages");
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        80;
      const bubble = this.shadowRoot.querySelector("#stream-bubble");
      if (bubble) bubble.innerHTML = renderMarkdown(this._streamText);
      const think = this.shadowRoot.querySelector("#stream-think .think-content");
      if (think) think.textContent = this._streamThink;
      const meta = this.shadowRoot.querySelector("#stream-meta");
      if (meta) meta.textContent = this._liveStats();
      this._renderGauge(this._currentChat());
      this._renderCtxPopover();
      if (atBottom) container.scrollTop = container.scrollHeight;
    });
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
    this._render();
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
        content =
          "The user rejected this tool call. Do not retry it unless asked.";
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
      this._pausedChatId = chat.id;
      this._render();
      return;
    }
    await this._runLLM(chat);
  }

  async _continuePaused() {
    const chat = this.chats.find((c) => c.id === this._pausedChatId);
    this._pausedChatId = null;
    this._autoTurns = 0;
    this._render();
    if (chat) await this._runLLM(chat);
  }

  /* ---------- message editing ---------- */

  _startEdit(index) {
    this._editingIndex = index;
    this._render();
  }

  _cancelEdit() {
    this._editingIndex = null;
    this._render();
  }

  _saveEdit(chat, index, text, resend) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this._editingIndex = null;
    chat.messages[index].content = trimmed;
    if (index === 0) {
      chat.title =
        trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
    }
    if (resend) {
      // Regenerate from here: everything after the edited message is stale.
      chat.messages.splice(index + 1);
      chat.pending = null;
      this._autoTurns = 0;
      this._pausedChatId = null;
      this._touch(chat);
      this._save();
      this._render();
      this._runLLM(chat);
      return;
    }
    this._touch(chat);
    this._save();
    this._render();
  }

  _deleteUserMessage(chat, index) {
    if (!confirm("Delete this message and its responses?")) return;
    // Remove the user message together with the responses it produced
    // (everything up to the next user message).
    let end = index + 1;
    while (end < chat.messages.length && chat.messages[end].role !== "user") {
      end += 1;
    }
    const removedTail = end >= chat.messages.length;
    chat.messages.splice(index, end - index);
    if (removedTail) chat.pending = null;
    this._editingIndex = null;
    if (!chat.messages.length) {
      // Nothing left; drop the chat like the lazy-create flow expects.
      this.chats = this.chats.filter((c) => c.id !== chat.id);
      this.currentId = this.chats.length ? this.chats[0].id : null;
    } else {
      this._touch(chat);
    }
    this._save();
    this._render();
  }

  async _copyMessage(text, btn) {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {
      /* fall through to the legacy path */
    }
    if (!ok) {
      // HA served over plain http has no async clipboard API.
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      this.shadowRoot.appendChild(helper);
      helper.focus();
      helper.select();
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      helper.remove();
    }
    const icon = btn?.querySelector("ha-icon");
    if (!icon) return;
    icon.setAttribute("icon", ok ? "mdi:check" : "mdi:alert-circle-outline");
    setTimeout(() => icon.setAttribute("icon", "mdi:content-copy"), 1200);
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
            <div id="model-menu" hidden></div>
          </div>
          <div id="banner-area"></div>
          <div id="messages"></div>
          <div id="composer">
            <button id="reason-btn" hidden><ha-icon icon="mdi:thought-bubble-outline"></ha-icon></button>
            <textarea id="input" rows="1" placeholder="Message…"></textarea>
            <div id="ctx-gauge" title="Context utilization"></div>
            <button id="send" class="primary" title="Send">➤</button>
            <div id="ctx-popover" hidden></div>
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
    this.$("#settings-overlay").addEventListener("click", (ev) => {
      if (ev.target === ev.currentTarget) {
        this.$("#settings-overlay").setAttribute("hidden", "");
      }
    });
    this.$("#ctx-gauge").addEventListener("click", () => this._toggleCtxPopover());
    this.$("#reason-btn").addEventListener("click", () => {
      this._reasoningPref = !this._reasoningOn();
      saveJson(STORAGE_REASONING, this._reasoningPref);
      this._renderComposerState();
    });
    this.shadowRoot.addEventListener("click", (ev) => {
      const path = ev.composedPath();
      const popover = this.$("#ctx-popover");
      if (
        !popover.hasAttribute("hidden") &&
        !path.includes(popover) &&
        !path.includes(this.$("#ctx-gauge"))
      ) {
        popover.setAttribute("hidden", "");
      }
      const menu = this.$("#model-menu");
      const chip = this.$("#model-chip");
      if (
        !menu.hasAttribute("hidden") &&
        !path.includes(menu) &&
        (!chip || !path.includes(chip))
      ) {
        menu.setAttribute("hidden", "");
      }
    });

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
    if (this._busy) {
      this._stopCurrent?.();
      return;
    }
    const input = this.$("#input");
    const text = input.value.trim();
    if (!text || this._executing) return;
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
    const chip = document.createElement("button");
    chip.className = "chip chip-btn";
    chip.id = "model-chip";
    chip.title = "Switch model";
    const label = document.createElement("span");
    label.className = "chip-label";
    label.textContent =
      this._model || (this._serverConfig ? "no model" : "…");
    const caret = document.createElement("span");
    caret.className = "chip-caret";
    caret.textContent = "▾";
    chip.append(label, caret);
    chip.addEventListener("click", () => this._toggleModelMenu());
    status.appendChild(chip);
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

  async _toggleModelMenu() {
    const menu = this.$("#model-menu");
    if (!menu.hasAttribute("hidden")) {
      menu.setAttribute("hidden", "");
      return;
    }
    this._renderModelMenu();
    menu.removeAttribute("hidden");
    // Refresh in the background; servers like llama-swap and LM Studio
    // change their model list at runtime.
    await this._loadConfig();
    this._renderHeader();
    if (!menu.hasAttribute("hidden")) this._renderModelMenu();
  }

  _renderModelMenu() {
    const menu = this.$("#model-menu");
    menu.textContent = "";
    const models = this._serverConfig?.models || [];
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "muted small pad";
      empty.textContent = this._serverConfig
        ? "No models reported by the LLM server"
        : "LLM server unreachable";
      menu.appendChild(empty);
      return;
    }
    for (const model of models) {
      const item = document.createElement("button");
      item.className = "model-item" + (model === this._model ? " active" : "");
      item.textContent = model;
      item.title = model;
      item.addEventListener("click", () => this._selectModel(model));
      menu.appendChild(item);
    }
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
      del.innerHTML = '<ha-icon icon="mdi:delete-outline"></ha-icon>';
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
    const chat = this._currentChat();
    if (chat && this._pausedChatId === chat.id && !this._busy) {
      const banner = document.createElement("div");
      banner.className = "banner banner-warn";
      const span = document.createElement("span");
      span.textContent = `Paused after ${MAX_AUTO_TURNS} consecutive tool rounds.`;
      const cont = document.createElement("button");
      cont.className = "primary banner-btn";
      cont.textContent = "Continue";
      cont.addEventListener("click", () => this._continuePaused());
      banner.append(span, cont);
      area.appendChild(banner);
    }
  }

  _msgMeta(ui) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const bits = [];
    if (ui.rate) bits.push(`${ui.estimated ? "~" : ""}${ui.rate} tok/s`);
    if (ui.tokens) bits.push(`${ui.estimated ? "~" : ""}${ui.tokens} tokens`);
    if (ui.elapsed) bits.push(`${ui.elapsed}s`);
    if (ui.stopped) bits.push("stopped by user");
    if (ui.partial) bits.push("interrupted");
    meta.textContent = bits.join(" · ");
    return meta;
  }

  _renderMessages() {
    const container = this.$("#messages");
    const prevScroll = container.scrollTop;
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    container.textContent = "";
    const chat = this._currentChat();

    if ((!chat || !chat.messages.length) && !this._busy) {
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
    for (const message of chat?.messages || []) {
      if (message.role === "tool") toolResults.set(message.tool_call_id, message);
    }

    const messages = chat?.messages || [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === "system" || message.role === "tool") continue;

      if (message.role === "user") {
        if (this._editingIndex === i) {
          container.appendChild(this._editRow(chat, i, message));
          continue;
        }
        const row = document.createElement("div");
        row.className = "msg-row user";
        const bubble = document.createElement("div");
        bubble.className = "bubble user";
        bubble.innerHTML = renderMarkdown(message.content);
        if (!this._busy && !this._executing) {
          row.appendChild(
            this._msgActions([
              ["mdi:pencil-outline", "Edit message", () => this._startEdit(i)],
              [
                "mdi:delete-outline",
                "Delete message and its responses",
                () => this._deleteUserMessage(chat, i),
              ],
            ])
          );
        }
        row.appendChild(bubble);
        container.appendChild(row);
        continue;
      }

      // assistant
      if (message._ui?.think) {
        container.appendChild(this._thinkBlock(message._ui.think, false));
      }
      const text = contentToText(message.content);
      const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (clean) {
        const row = document.createElement("div");
        row.className = "msg-row assistant";
        const bubble = document.createElement("div");
        bubble.className = "bubble assistant";
        bubble.innerHTML = renderMarkdown(text);
        row.appendChild(bubble);
        row.appendChild(
          this._msgActions([
            [
              "mdi:content-copy",
              "Copy message",
              (ev) => this._copyMessage(clean, ev.currentTarget),
            ],
          ])
        );
        container.appendChild(row);
      }
      for (const tc of message.tool_calls || []) {
        const isPending = chat.pending?.calls.some((c) => c.id === tc.id);
        if (isPending) continue; // rendered as an approval card below
        container.appendChild(this._toolHistoryCard(tc, toolResults.get(tc.id)));
      }
      if (
        message._ui &&
        (message._ui.rate ||
          message._ui.tokens ||
          message._ui.stopped ||
          message._ui.partial)
      ) {
        container.appendChild(this._msgMeta(message._ui));
      }
    }

    if (chat?.pending) {
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
      if (this._streamThink) {
        container.appendChild(this._thinkBlock(this._streamThink, true));
      }
      if (this._streamText) {
        const row = document.createElement("div");
        row.className = "msg-row assistant";
        const bubble = document.createElement("div");
        bubble.className = "bubble assistant streaming";
        bubble.id = "stream-bubble";
        bubble.innerHTML = renderMarkdown(this._streamText);
        row.appendChild(bubble);
        container.appendChild(row);
      } else if (!this._streamThink) {
        const typing = document.createElement("div");
        typing.className = "typing";
        typing.innerHTML = "<span></span><span></span><span></span>";
        container.appendChild(typing);
      }
      if (this._streamText || this._streamThink) {
        const meta = document.createElement("div");
        meta.className = "msg-meta";
        meta.id = "stream-meta";
        meta.textContent = this._liveStats();
        container.appendChild(meta);
      }
    }

    // Rebuilding the list resets the scroll position; put it back so a
    // reader scrolled up isn't yanked around by mid-generation renders.
    if (atBottom) container.scrollTop = container.scrollHeight;
    else container.scrollTop = prevScroll;
  }

  _msgActions(actions) {
    const wrap = document.createElement("div");
    wrap.className = "msg-actions";
    for (const [icon, title, onClick] of actions) {
      const btn = document.createElement("button");
      btn.className = "icon-btn msg-action";
      btn.title = title;
      btn.innerHTML = `<ha-icon icon="${icon}"></ha-icon>`;
      btn.addEventListener("click", onClick);
      wrap.appendChild(btn);
    }
    return wrap;
  }

  _editRow(chat, index, message) {
    const row = document.createElement("div");
    row.className = "msg-row user";
    const box = document.createElement("div");
    box.className = "edit-box";
    const textarea = document.createElement("textarea");
    textarea.value = contentToText(message.content);
    textarea.rows = Math.min(8, Math.max(2, textarea.value.split("\n").length));
    textarea.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this._cancelEdit();
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this._saveEdit(chat, index, textarea.value, true);
      }
    });
    const actions = document.createElement("div");
    actions.className = "edit-actions";
    const cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this._cancelEdit());
    const save = document.createElement("button");
    save.className = "secondary";
    save.textContent = "Save";
    save.title = "Keep the change without regenerating";
    save.addEventListener("click", () =>
      this._saveEdit(chat, index, textarea.value, false)
    );
    const resend = document.createElement("button");
    resend.className = "primary";
    resend.textContent = "Save & send";
    resend.title = "Regenerate from here — discards the later messages";
    resend.addEventListener("click", () =>
      this._saveEdit(chat, index, textarea.value, true)
    );
    actions.append(cancel, save, resend);
    box.append(textarea, actions);
    row.appendChild(box);
    setTimeout(() => textarea.focus(), 0);
    return row;
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
    const send = this.$("#send");
    const input = this.$("#input");
    send.textContent = this._busy ? "■" : "➤";
    send.title = this._busy ? "Stop generating" : "Send";
    send.classList.toggle("stop", this._busy);
    send.disabled = !this._busy && (this._executing || !!chat?.pending);
    const reason = this.$("#reason-btn");
    if (this._serverConfig?.supports_reasoning) {
      reason.removeAttribute("hidden");
      const on = this._reasoningOn();
      reason.classList.toggle("active", on);
      reason.title = on
        ? "Reasoning on — click to disable"
        : "Reasoning off — click to enable";
    } else {
      reason.setAttribute("hidden", "");
    }
    input.placeholder = chat?.pending
      ? "Resolve the pending tool calls first…"
      : this._busy
        ? "Generating…"
        : "Message…";
    this._renderGauge(chat);
    this._renderCtxPopover();
  }

  _contextStats(chat) {
    const limit = this._serverConfig?.context_window || 32768;
    const usage = chat?.usage;
    const prompt = usage?.prompt_tokens ?? null;
    const completion = usage?.completion_tokens ?? null;
    let used = null;
    let estimated = false;
    if (usage?.total_tokens) {
      used = usage.total_tokens;
    } else if (prompt != null) {
      used = prompt + (completion || 0);
    }
    if (used == null) {
      estimated = true;
      const text = chat ? JSON.stringify(chat.messages) : "";
      used = Math.round((text.length + SYSTEM_PROMPT.length) / 4);
    }
    // Fold in the in-flight request so the gauge and popover tick up live
    // while streaming.
    if (this._busy && chat && chat.id === this._streamChatId) {
      const timings = this._streamTimings;
      if (timings?.prompt_n != null) {
        used =
          timings.prompt_n +
          (timings.cache_n || 0) +
          (timings.predicted_n ?? this._streamChunks);
      } else {
        used += this._streamChunks;
      }
    }
    const pct = Math.min(100, Math.round((used / limit) * 100));
    return { limit, used, estimated, pct, prompt, completion };
  }

  _renderGauge(chat) {
    const gauge = this.$("#ctx-gauge");
    const { limit, used, estimated, pct } = this._contextStats(chat);
    const color =
      pct >= 90
        ? "var(--error-color, #db4437)"
        : pct >= 70
          ? "var(--warning-color, #ffa600)"
          : "var(--success-color, #0f9d58)";
    gauge.title = `Context: ${estimated ? "~" : ""}${used.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%) — click for details`;
    // Ring circumference for r=15.5 is ~97.4.
    const dash = ((pct / 100) * 97.4).toFixed(1);
    gauge.innerHTML = `
      <svg viewBox="0 0 36 36">
        <path class="ring-bg" d="M18 2.5 a 15.5 15.5 0 0 1 0 31 a 15.5 15.5 0 0 1 0 -31"/>
        <path class="ring-fg" stroke="${color}" stroke-dasharray="${dash}, 97.4"
          d="M18 2.5 a 15.5 15.5 0 0 1 0 31 a 15.5 15.5 0 0 1 0 -31"/>
        <text x="18" y="22" text-anchor="middle" class="ring-text">${pct}</text>
      </svg>`;
  }

  _toggleCtxPopover() {
    const popover = this.$("#ctx-popover");
    if (!popover.hasAttribute("hidden")) {
      popover.setAttribute("hidden", "");
      return;
    }
    this._renderCtxPopover(true);
    popover.removeAttribute("hidden");
  }

  // llama.cpp-webui-style context popover: a compact used/limit header with a
  // bar, plus collapsible per-turn token details. Re-rendered live while open.
  _renderCtxPopover(force = false) {
    const popover = this.$("#ctx-popover");
    if (!popover || (!force && popover.hasAttribute("hidden"))) return;
    const chat = this._currentChat();
    const stats = this._contextStats(chat);
    const approx = stats.estimated ? "~" : "";
    const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString());
    const tok = (n) => (n == null ? "—" : `${fmt(n)} tok`);
    const fmtK = (n) =>
      n >= 1000 ? `${(n / 1000).toFixed(2)}K` : `${Math.round(n)}`;
    const remaining = Math.max(0, stats.limit - stats.used);
    const barColor =
      stats.pct >= 90
        ? "var(--error-color, #db4437)"
        : stats.pct >= 70
          ? "var(--warning-color, #ffa600)"
          : "var(--success-color, #0f9d58)";

    // Per-request details: live server timings while streaming, else the
    // last completed request.
    const streaming = this._busy && chat && chat.id === this._streamChatId;
    const live = streaming ? this._streamTimings : null;
    const timings = live || chat?.timings || null;
    const usage = live ? null : chat?.usage || null;
    const cached =
      timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens ?? null;
    const fresh =
      timings?.prompt_n ??
      (usage?.prompt_tokens != null && cached != null
        ? usage.prompt_tokens - cached
        : null);
    const prompt =
      usage?.prompt_tokens ?? (fresh != null ? fresh + (cached || 0) : null);
    const generated = streaming
      ? live?.predicted_n ?? this._streamChunks
      : usage?.completion_tokens ?? timings?.predicted_n ?? null;
    const total =
      prompt != null && generated != null ? prompt + generated : null;
    let speed =
      timings?.predicted_per_second ?? (streaming ? null : chat?.rate);
    if (streaming && !speed && this._streamStart && this._streamChunks >= 5) {
      const seconds = (performance.now() - this._streamStart) / 1000;
      if (seconds > 0.5) speed = this._streamChunks / seconds;
    }
    const totals = chat?.totals;

    let details;
    if (totals || prompt != null || generated != null) {
      details = `
        <details class="ctx-details"${this._ctxDetailsOpen ? " open" : ""}>
          <summary>Token usage details</summary>
          <div class="ctx-section">Across all turns</div>
          <div class="kv"><span>Prompt tokens evaluated</span><span>${tok(totals?.evaluated)}</span></div>
          <div class="kv"><span>Tokens generated</span><span>${tok(totals?.generated)}</span></div>
          <div class="ctx-section">This turn${cached != null ? " · KV cache" : ""}</div>
          <div class="kv"><span>Prompt</span><span>${tok(prompt)}</span></div>
          ${
            cached != null && fresh != null
              ? `<div class="kv ctx-sub"><span></span><span>${fmt(fresh)} fresh + ${fmt(cached)} cached</span></div>`
              : ""
          }
          <div class="kv"><span>Generated</span><span>${streaming && !live ? "~" : ""}${tok(generated)}</span></div>
          <div class="kv ctx-total"><span>${cached != null ? "KV cache total" : "Total"}</span><span>${tok(total)}</span></div>
          <div class="kv ctx-speed"><span>Avg speed</span><span>${speed ? `${Number(speed).toFixed(1)} t/s` : "—"}</span></div>
        </details>`;
    } else {
      details =
        '<p class="muted small">No token counts reported yet — estimated from text length. Updates after the first response.</p>';
    }

    popover.innerHTML = `
      <div class="ctx-head" title="${
        this._serverConfig?.context_window_source === "detected"
          ? "Context window detected from the LLM server"
          : "Context window from the integration settings"
      }">Context <span class="muted">·</span> ${approx}${fmtK(stats.used)} / ${fmtK(stats.limit)}</div>
      <div class="ctx-bar"><div class="ctx-bar-fill" style="width:${stats.pct}%;background:${barColor}"></div></div>
      <div class="ctx-row"><span>${stats.pct}% used</span><span>${approx}${fmtK(remaining)} remaining</span></div>
      ${details}`;
    const box = popover.querySelector(".ctx-details");
    if (box) {
      box.addEventListener("toggle", () => {
        this._ctxDetailsOpen = box.open;
      });
    }
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
      <div class="kv"><span>Model</span><span>${escapeHtml(this._model || "?")}</span></div>
      <div class="kv"><span>LLM</span><span>${escapeHtml(conf?.llm_url || "?")}</span></div>
      <div class="kv"><span>MCP</span><span>${escapeHtml(conf?.mcp_url || "?")}</span></div>
      <div class="kv"><span>Context window</span><span>${(conf?.context_window || 32768).toLocaleString()} tokens</span></div>
      <div class="kv"><span>Tools</span><span>${
        this._tools ? this._tools.length : escapeHtml(this._toolsError || "…")
      }</span></div>
      <p class="muted small">The model is switched from the chip in the header.
      Endpoints are configured on the HA Chat integration
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
    /* Fallback only: JS pins the host to the measured viewport height,
       which is the only reliable size across desktop, mobile Safari, and
       the companion app. */
    height: 100vh;
    overflow: hidden;
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
  .chat-del { visibility: hidden; line-height: 0; }
  .chat-del ha-icon { --mdc-icon-size: 17px; }
  .chat-item:hover .chat-del { visibility: visible; }
  .chat-del:hover { color: var(--error-color, #db4437); }

  #scrim { display: none; }

  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

  #ctx-popover[hidden] { display: none; }
  #ctx-popover {
    position: absolute;
    bottom: calc(100% + 10px);
    right: 48px;
    z-index: 5;
    width: 280px;
    max-width: calc(100vw - 24px);
    background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 12px;
    padding: 12px 16px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.18);
    font-size: 13px;
  }
  #ctx-popover p { margin: 8px 0 0; }
  .ctx-head { font-size: 13px; font-weight: 600; }
  .ctx-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--secondary-text-color, #727272);
  }
  .ctx-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--secondary-background-color, #f0f0f0);
    margin: 8px 0 6px;
    overflow: hidden;
  }
  .ctx-bar-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--primary-color, #03a9f4);
  }
  .ctx-details {
    margin-top: 10px;
    border-top: 1px solid var(--divider-color, #e0e0e0);
    padding-top: 8px;
  }
  .ctx-details summary {
    cursor: pointer;
    font-size: 13px;
    user-select: none;
  }
  .ctx-section {
    margin: 10px 0 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--secondary-text-color, #727272);
  }
  .ctx-sub { padding-top: 0; margin-top: -3px; }
  .ctx-sub span:last-child {
    font-size: 11px;
    color: var(--secondary-text-color, #727272);
  }
  .ctx-total {
    margin-top: 4px;
    border-top: 1px dashed var(--divider-color, #e0e0e0);
    padding-top: 6px;
    font-weight: 600;
  }
  .ctx-total span:first-child { color: var(--primary-text-color, #212121); }
  .ctx-speed {
    margin-top: 6px;
    border-top: 1px solid var(--divider-color, #e0e0e0);
    padding-top: 6px;
  }
  #header {
    position: relative;
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
  button.chip-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  button.chip-btn:hover {
    border-color: var(--primary-color, #03a9f4);
    color: var(--primary-text-color, #212121);
  }
  .chip-label { overflow: hidden; text-overflow: ellipsis; }
  .chip-caret { flex: none; font-size: 9px; }

  #model-menu[hidden] { display: none; }
  #model-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 12px;
    z-index: 6;
    min-width: 200px;
    max-width: min(340px, calc(100vw - 24px));
    max-height: 50vh;
    overflow-y: auto;
    background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.18);
    padding: 4px;
  }
  .model-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--primary-text-color, #212121);
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .model-item:hover { background: var(--secondary-background-color, #f5f5f5); }
  .model-item.active {
    color: var(--primary-color, #03a9f4);
    font-weight: 600;
  }

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
  .banner-btn { padding: 4px 14px; font-size: 13px; }

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
  .msg-row { display: flex; gap: 2px; }
  .msg-row.user { justify-content: flex-end; }
  .msg-actions {
    display: flex;
    align-items: flex-end;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .msg-row:hover .msg-actions, .msg-actions:focus-within { opacity: 1; }
  @media (hover: none) { .msg-actions { opacity: 0.55; } }
  .msg-action { padding: 4px 5px; line-height: 0; }
  .msg-action ha-icon { --mdc-icon-size: 16px; }
  .msg-action:hover { color: var(--primary-color, #03a9f4); }
  .edit-box {
    width: 78%;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .edit-box textarea {
    width: 100%;
    resize: vertical;
    border: 1px solid var(--primary-color, #03a9f4);
    border-radius: 10px;
    padding: 10px 12px;
    font: inherit;
    background: var(--primary-background-color, #fafafa);
    color: inherit;
    outline: none;
  }
  .edit-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .edit-actions button { padding: 6px 12px; font-size: 13px; }
  .bubble {
    max-width: 78%;
    padding: 10px 14px;
    border-radius: 14px;
    line-height: 1.45;
    font-size: 14px;
    white-space: normal;
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
  }
  .bubble p { margin: 6px 0; }
  .bubble p:first-child, .bubble > :first-child { margin-top: 0; }
  .bubble p:last-child, .bubble > :last-child { margin-bottom: 0; }
  .bubble h3, .bubble h4, .bubble h5, .bubble h6 {
    margin: 12px 0 6px;
    line-height: 1.3;
  }
  .bubble h3 { font-size: 17px; }
  .bubble h4 { font-size: 15px; }
  .bubble h5, .bubble h6 { font-size: 14px; }
  .bubble ul, .bubble ol { margin: 6px 0; padding-left: 22px; }
  .bubble li { margin: 2px 0; }
  .bubble blockquote {
    margin: 6px 0;
    padding: 4px 12px;
    border-left: 3px solid var(--primary-color, #03a9f4);
    color: var(--secondary-text-color, #727272);
  }
  .bubble hr {
    border: none;
    border-top: 1px solid var(--divider-color, #e0e0e0);
    margin: 10px 0;
  }
  .bubble table {
    border-collapse: collapse;
    margin: 8px 0;
    display: block;
    max-width: 100%;
    overflow-x: auto;
    font-size: 13px;
  }
  .bubble th, .bubble td {
    border: 1px solid var(--divider-color, #e0e0e0);
    padding: 4px 10px;
    text-align: left;
  }
  .bubble th { background: var(--secondary-background-color, #f5f5f5); }
  .bubble pre {
    background: var(--secondary-background-color, #f5f5f5);
    padding: 10px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 8px 0;
    white-space: pre;
  }
  .bubble code {
    background: var(--secondary-background-color, #f5f5f5);
    padding: 1px 4px;
    border-radius: 4px;
  }
  .bubble pre code { background: none; padding: 0; }
  .bubble a { color: var(--primary-color, #03a9f4); }
  /* markdown on the colored user bubble needs its own contrast */
  .bubble.user pre, .bubble.user code {
    background: rgba(0, 0, 0, 0.18);
    color: inherit;
  }
  .bubble.user pre code { background: none; }
  .bubble.user a { color: inherit; text-decoration: underline; }
  .bubble.user blockquote {
    border-left-color: rgba(255, 255, 255, 0.7);
    color: inherit;
  }
  .bubble.user th { background: rgba(0, 0, 0, 0.18); }
  .bubble.user th, .bubble.user td { border-color: rgba(255, 255, 255, 0.4); }
  .bubble.user hr { border-top-color: rgba(255, 255, 255, 0.4); }
  .bubble.assistant.streaming::after {
    content: "▍";
    animation: cursor-blink 1s steps(1) infinite;
    color: var(--primary-color, #03a9f4);
  }
  @keyframes cursor-blink { 50% { opacity: 0; } }

  .msg-meta {
    font-size: 11px;
    color: var(--secondary-text-color, #727272);
    margin: -6px 0 0 6px;
  }

  .think-box {
    max-width: 78%;
    border: 1px dashed var(--divider-color, #e0e0e0);
    border-radius: 10px;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--secondary-text-color, #727272);
  }
  .think-box summary {
    cursor: pointer;
    font-style: italic;
    user-select: none;
  }
  .think-content {
    margin-top: 6px;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    max-height: 200px;
    overflow-y: auto;
  }

  .tool-card {
    border: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    border-radius: 12px;
    padding: 10px 14px;
    font-size: 13px;
    max-width: 78%;
  }
  .tool-card.pending-card.pending { border-color: var(--primary-color, #03a9f4); }
  .tool-card.pending-card.error { border-color: var(--error-color, #db4437); }
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
    position: relative;
    display: flex;
    gap: 8px;
    align-items: flex-end;
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
  #reason-btn[hidden] { display: none; }
  #reason-btn {
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid var(--divider-color, #e0e0e0);
    background: transparent;
    color: var(--secondary-text-color, #727272);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  #reason-btn ha-icon { --mdc-icon-size: 20px; }
  #reason-btn.active {
    background: var(--primary-color, #03a9f4);
    border-color: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
  }
  #ctx-gauge {
    width: 38px;
    height: 38px;
    flex: none;
    cursor: pointer;
  }
  #ctx-gauge svg { width: 100%; height: 100%; }
  #ctx-gauge .ring-bg {
    fill: none;
    stroke: var(--divider-color, #e0e0e0);
    stroke-width: 3.5;
  }
  #ctx-gauge .ring-fg {
    fill: none;
    stroke-width: 3.5;
    stroke-linecap: round;
  }
  #ctx-gauge .ring-text {
    font-size: 11px;
    fill: var(--secondary-text-color, #727272);
  }
  #send { min-width: 48px; height: 40px; }
  #send.stop {
    background: var(--error-color, #db4437);
    font-size: 24px;
    line-height: 1;
    padding: 0 16px;
  }

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
  #layout.narrow .edit-box { width: 92%; }

  /* settings dialog */
  #settings-overlay[hidden] { display: none; }
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
