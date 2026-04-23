// myBookLM Local — frontend
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  sources: [],
  selected: new Set(),
  convId: null,
  convs: [],
  pdfs: [],
  jobs: [],
  config: null,
  sessionTokens: { in: 0, out: 0, cost: 0 },
};

// ---------- API helper ----------
async function api(path, opts = {}) {
  const init = { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } };
  if (opts.body !== undefined && typeof opts.body !== "string") {
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch("/api" + path, init);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status}: ${t}`);
  }
  return r.json();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Tabs ----------
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    $("#tab-" + name).classList.add("active");
    if (name === "convert") { loadPDFs(); loadJobs(); }
    else if (name === "settings") loadConfig();
    else if (name === "chat") { loadSources(); loadConvs(); }
  });
});

function switchTab(name) {
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (btn) btn.click();
}

// ---------- Provider indicator ----------
async function updateProviderIndicator() {
  try {
    const cfg = await api("/config");
    const p = cfg.active_provider;
    const model = cfg.providers[p]?.model || "";
    $("#provider-indicator").textContent = `🤖 ${p} · ${model}`;
  } catch {}
}

// ---------- Sources ----------
async function loadSources() {
  state.sources = await api("/sources");
  renderSources();
}

function sourceTypeBadge(types) {
  if (!types || types.length === 0) return "";
  const labels = types.map((t) => {
    if (t === "skill") return '<span class="type-badge badge-skill">skill</span>';
    if (t === "embedding") return '<span class="type-badge badge-emb">emb</span>';
    return `<span class="type-badge">${escapeHtml(t)}</span>`;
  });
  return labels.join(" ");
}

function renderSources() {
  const list = $("#source-list");
  list.innerHTML = "";
  if (state.sources.length === 0) {
    list.innerHTML = '<li style="color:#999;padding:20px 6px;font-size:12px;">尚無來源。點「新增來源」或切到「轉換」頁面建立。</li>';
    updateSourcesCount();
    return;
  }
  state.sources.forEach((s) => {
    const li = document.createElement("li");
    const checked = state.selected.has(s.slug);
    const chunkInfo = s.chunk_count ? `${s.chunk_count} 片段` : (s.chapter_count ? `${s.chapter_count} 章` : "");
    li.innerHTML = `
      <input type="checkbox" ${checked ? "checked" : ""}>
      <div class="title-block">
        <div class="title-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
        <div class="meta">${sourceTypeBadge(s.types)} ${escapeHtml(chunkInfo)}</div>
      </div>
      <span class="delete" title="刪除">✕</span>`;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.selected.add(s.slug);
      else state.selected.delete(s.slug);
      updateSourcesCount();
      syncSelectAll();
    });
    li.querySelector(".delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`刪除 ${s.name}？`)) return;
      await api(`/sources/${s.slug}`, { method: "DELETE" });
      state.selected.delete(s.slug);
      loadSources();
    });
    list.appendChild(li);
  });
  updateSourcesCount();
  syncSelectAll();
}

function updateSourcesCount() {
  $("#sources-count").textContent = `${state.selected.size} 個來源`;
}
function syncSelectAll() {
  const cb = $("#select-all-sources");
  cb.checked = state.sources.length > 0 && state.selected.size === state.sources.length;
}
$("#select-all-sources").addEventListener("change", (e) => {
  if (e.target.checked) state.sources.forEach((s) => state.selected.add(s.slug));
  else state.selected.clear();
  renderSources();
});
$("#refresh-sources").addEventListener("click", loadSources);
$("#add-source-btn").addEventListener("click", () => switchTab("convert"));

// ---------- Conversations ----------
async function loadConvs() {
  state.convs = await api("/conversations");
  const picker = $("#conv-picker");
  picker.innerHTML = "";
  if (state.convs.length === 0) {
    state.convId = null;
    $("#messages").innerHTML = emptyChatHtml();
    $("#usage-info").textContent = "尚無對話";
    return;
  }
  state.convs.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `#${c.id} ${c.title || ""}`;
    picker.appendChild(opt);
  });
  if (!state.convId || !state.convs.find((c) => c.id === state.convId)) {
    state.convId = state.convs[0].id;
  }
  picker.value = state.convId;
  loadMessages();
}
$("#conv-picker").addEventListener("change", (e) => {
  state.convId = Number(e.target.value);
  loadMessages();
});
async function ensureConversation() {
  if (state.convId) return state.convId;
  const conv = await api("/conversations", { method: "POST" });
  state.convId = conv.id;
  await loadConvs();
  return conv.id;
}
async function loadMessages() {
  if (!state.convId) { $("#messages").innerHTML = emptyChatHtml(); return; }
  const msgs = await api(`/conversations/${state.convId}/messages`);
  renderMessages(msgs);
}
function emptyChatHtml() {
  return '<div class="empty-chat">勾選左側來源 → 在下方輸入問題開始提問。</div>';
}
function renderMessages(msgs) {
  const box = $("#messages");
  box.innerHTML = "";
  if (msgs.length === 0) { box.innerHTML = emptyChatHtml(); resetSessionTokens(); return; }
  state.sessionTokens = { in: 0, out: 0, cost: 0 };
  msgs.forEach((m) => {
    appendMessage(m, false);
    state.sessionTokens.in += m.tokens_in || 0;
    state.sessionTokens.out += m.tokens_out || 0;
    state.sessionTokens.cost += m.cost || 0;
  });
  updateSessionDisplay();
  scrollMessages();
}
function appendMessage(m, updateCounter = true) {
  const box = $("#messages");
  if (box.querySelector(".empty-chat")) box.innerHTML = "";
  const div = document.createElement("div");
  div.className = "message " + m.role;
  const roleText = m.role === "user" ? "你" : "AI";
  const parts = [];
  if (m.tokens_in || m.tokens_out) parts.push(`${m.tokens_in || 0} in / ${m.tokens_out || 0} out`);
  if (m.cost) parts.push(`$${Number(m.cost).toFixed(4)}`);
  if (m.sources_used) parts.push(`來源：${m.sources_used}`);
  const metaHtml = parts.length ? `<div class="meta">${escapeHtml(parts.join(" · "))}</div>` : "";
  const saveBtnHtml = m.role === "assistant"
    ? `<button class="save-source-btn">💾 存為來源</button>` : "";
  div.innerHTML = `
    <div class="role">${roleText}</div>
    <div class="content">${escapeHtml(m.content)}</div>
    ${metaHtml}
    ${saveBtnHtml}`;
  if (m.role === "assistant") {
    const content = m.content;
    div.querySelector(".save-source-btn").addEventListener("click", () => saveAsSource(content));
  }
  box.appendChild(div);
  if (updateCounter) {
    state.sessionTokens.in += m.tokens_in || 0;
    state.sessionTokens.out += m.tokens_out || 0;
    state.sessionTokens.cost += m.cost || 0;
    updateSessionDisplay();
  }
  scrollMessages();
}
function scrollMessages() {
  const box = $("#messages");
  box.scrollTop = box.scrollHeight;
}
function resetSessionTokens() {
  state.sessionTokens = { in: 0, out: 0, cost: 0 };
  updateSessionDisplay();
}
function updateSessionDisplay() {
  const t = state.sessionTokens;
  $("#usage-info").textContent =
    `目前對話：${t.in} in / ${t.out} out · 累計 $${t.cost.toFixed(4)}`;
}

async function saveAsSource(content) {
  const title = window.prompt("儲存為來源，請輸入標題：", "AI 筆記");
  if (!title) return;
  try {
    const r = await api("/sources/from-response", {
      method: "POST",
      body: { content, title },
    });
    alert(`已儲存為來源：${r.name}`);
    loadSources();
  } catch (e) {
    alert("儲存失敗：" + e.message);
  }
}

$("#send-btn").addEventListener("click", sendChat);
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
function appendLoadingBubble() {
  const box = $("#messages");
  if (box.querySelector(".empty-chat")) box.innerHTML = "";
  const div = document.createElement("div");
  div.className = "message assistant loading";
  div.id = "loading-bubble";
  div.innerHTML = `
    <div class="role">AI</div>
    <div class="content"><span class="spinner"></span> 正在處理中…</div>`;
  box.appendChild(div);
  scrollMessages();
  return div;
}

async function sendChat() {
  const input = $("#chat-input");
  const msg = input.value.trim();
  if (!msg) return;
  const cid = await ensureConversation();
  input.value = "";
  appendMessage({ role: "user", content: msg }, false);
  const loader = appendLoadingBubble();
  const btn = $("#send-btn");
  btn.disabled = true; btn.textContent = "⋯";
  try {
    const r = await api("/chat", {
      method: "POST",
      body: { conversation_id: cid, message: msg, sources: Array.from(state.selected) },
    });
    loader.remove();
    appendMessage({
      role: "assistant", content: r.content,
      tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost: r.cost,
      sources_used: (r.sources_used || []).join(","),
    });
  } catch (err) {
    loader.remove();
    appendMessage({ role: "assistant", content: `[錯誤] ${err.message}` });
  } finally {
    btn.disabled = false; btn.textContent = "→";
  }
}
$("#new-chat-btn").addEventListener("click", async () => {
  state.convId = null;
  const conv = await api("/conversations", { method: "POST" });
  state.convId = conv.id;
  await loadConvs();
  resetSessionTokens();
});
$("#clear-chat-btn").addEventListener("click", async () => {
  if (!state.convId) return;
  if (!confirm("清空目前對話的所有訊息？（對話本身保留）")) return;
  await api(`/conversations/${state.convId}/clear`, { method: "POST" });
  loadMessages();
});

// ---------- PDFs ----------
async function loadPDFs() {
  state.pdfs = await api("/pdfs");
  const ul = $("#pdf-list");
  ul.innerHTML = "";
  if (state.pdfs.length === 0) {
    ul.innerHTML = '<li style="color:#999;">books/ 目錄中沒有 PDF 檔案。</li>';
    return;
  }
  state.pdfs.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><strong>${escapeHtml(p.name)}</strong><br><small>${p.size_mb} MB</small></div>
      <div class="pdf-btns">
        <button data-action="skill" title="用 LLM 重寫為結構化 skill.md（慢，品質高）">skill.md</button>
        <button data-action="embed" title="直接向量化（快，保留原文）">Embedding</button>
      </div>`;
    const runConvert = async (btnClicked, endpoint, errLabel) => {
      const btns = li.querySelectorAll("button");
      btns.forEach((b) => (b.disabled = true));
      const origLabel = btnClicked.textContent;
      btnClicked.innerHTML = '<span class="spinner"></span> 處理中…';
      btnClicked.classList.add("loading");
      try {
        await api(endpoint, { method: "POST", body: { pdf_filename: p.name } });
        loadJobs();
      } catch (e) {
        alert(errLabel + "：" + e.message);
        btns.forEach((b) => (b.disabled = false));
        btnClicked.textContent = origLabel;
        btnClicked.classList.remove("loading");
      }
    };
    const skillBtn = li.querySelector("[data-action=skill]");
    const embedBtn = li.querySelector("[data-action=embed]");
    skillBtn.addEventListener("click", () => runConvert(skillBtn, "/jobs", "建立任務失敗"));
    embedBtn.addEventListener("click", () => runConvert(embedBtn, "/pdfs/embed", "建立 Embedding 任務失敗"));
    ul.appendChild(li);
  });
}
$("#refresh-pdfs").addEventListener("click", loadPDFs);
$("#pdf-upload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/pdfs/upload", { method: "POST", body: fd });
  if (!r.ok) { alert("上傳失敗：" + await r.text()); return; }
  loadPDFs();
  e.target.value = "";
});

// ---------- Jobs ----------
async function loadJobs() {
  state.jobs = await api("/jobs");
  const ul = $("#jobs-list");
  ul.innerHTML = "";
  if (state.jobs.length === 0) {
    ul.innerHTML = '<li style="color:#999;">目前沒有任務。</li>';
    return;
  }
  state.jobs.forEach((j) => {
    const pct = j.total_chapters ? Math.round((100 * j.completed_chapters) / j.total_chapters) : 0;
    const li = document.createElement("li");
    li.className = "job-card";
    const cost = j.cost ? `$${Number(j.cost).toFixed(4)}` : "$0";
    const pdfName = j.pdf_path.split(/[\\\/]/).pop();
    const jobTypeBadge = j.job_type === "embedding"
      ? '<span class="type-badge badge-emb">embedding</span>'
      : '<span class="type-badge badge-skill">skill.md</span>';
    const actions = [];
    if (j.status === "running") actions.push('<button data-a="pause">⏸ 暫停</button>');
    if (j.status === "paused" || j.status === "failed" || j.status === "pending")
      actions.push('<button data-a="resume">▶ 恢復</button>');
    actions.push('<button data-a="delete">🗑 刪除</button>');
    li.innerHTML = `
      <div class="title">${escapeHtml(j.book_title || pdfName)} ${jobTypeBadge}</div>
      <div class="status-line">
        <span class="status-${j.status}">${j.status}</span>
        ${j.current_step ? " · " + escapeHtml(j.current_step) : ""}
      </div>
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="usage">
        ${j.completed_chapters}/${j.total_chapters} ${j.job_type === "embedding" ? "片段" : "章"} ·
        ${j.tokens_in} in / ${j.tokens_out} out · ${cost} ·
        ${escapeHtml(j.provider || "")}/${escapeHtml(j.model || "")}
      </div>
      ${j.error ? `<div class="err">${escapeHtml(j.error)}</div>` : ""}
      <div class="actions">${actions.join("")}</div>`;
    li.querySelectorAll("[data-a]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const a = btn.dataset.a;
        try {
          if (a === "pause") await api(`/jobs/${j.id}/pause`, { method: "POST" });
          else if (a === "resume") await api(`/jobs/${j.id}/resume`, { method: "POST" });
          else if (a === "delete") {
            if (!confirm("刪除任務？會一併刪除已產生的來源資料。")) return;
            await api(`/jobs/${j.id}`, { method: "DELETE" });
          }
        } catch (e) { alert(e.message); }
        loadJobs();
        loadSources();
      });
    });
    ul.appendChild(li);
  });
}

// Poll jobs while convert tab is visible
setInterval(() => {
  if ($("#tab-convert").classList.contains("active")) loadJobs();
}, 3000);

// ---------- Settings ----------
async function loadConfig() {
  state.config = await api("/config");
  $("#active-provider").value = state.config.active_provider;
  Object.entries(state.config.providers).forEach(([name, pcfg]) => {
    $$(`[data-p="${name}"]`).forEach((input) => {
      const f = input.dataset.f;
      let val;
      if (f.includes(".")) {
        const [a, b] = f.split(".");
        val = pcfg[a]?.[b];
      } else {
        val = pcfg[f];
      }
      input.value = val ?? "";
    });
  });
}
$("#save-settings").addEventListener("click", async () => {
  const payload = { active_provider: $("#active-provider").value, providers: {} };
  ["claude", "gemini", "grok", "ollama"].forEach((name) => {
    const obj = {};
    $$(`[data-p="${name}"]`).forEach((input) => {
      const f = input.dataset.f;
      let val = input.value;
      if (input.type === "number") val = Number(val) || 0;
      if (f.includes(".")) {
        const [a, b] = f.split(".");
        obj[a] = obj[a] || {};
        obj[a][b] = val;
      } else {
        obj[f] = val;
      }
    });
    payload.providers[name] = obj;
  });
  try {
    await api("/config", { method: "POST", body: payload });
    $("#settings-msg").textContent = "✓ 已儲存";
    updateProviderIndicator();
    setTimeout(() => ($("#settings-msg").textContent = ""), 2000);
  } catch (e) { alert("儲存失敗：" + e.message); }
});

// ---------- Sidebar resizer ----------
(function setupResizer() {
  const resizer = $("#sidebar-resizer");
  const sidebar = document.querySelector(".sidebar");
  if (!resizer || !sidebar) return;
  const saved = localStorage.getItem("sidebarWidth");
  if (saved) sidebar.style.width = saved + "px";

  let dragging = false;
  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = sidebar.getBoundingClientRect();
    const w = Math.max(180, Math.min(600, e.clientX - rect.left));
    sidebar.style.width = w + "px";
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem("sidebarWidth", parseInt(sidebar.style.width, 10));
  });
})();

// ---------- Init ----------
loadSources();
loadConvs();
updateProviderIndicator();
