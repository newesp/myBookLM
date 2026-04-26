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
  sourceFilter: "",
  topics: [],
  // 0 = "全部" (no filter); otherwise the active topic id used for filtering
  // sources/conversations and as the assignment target for new items.
  topicId: 0,
};

// Persist topic selection across reloads
const SAVED_TOPIC_KEY = "myBookLM.topicId";
const savedTopic = Number(localStorage.getItem(SAVED_TOPIC_KEY));
if (!Number.isNaN(savedTopic)) state.topicId = savedTopic;

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

// ---------- Topics ----------
async function loadTopics() {
  state.topics = await api("/topics");
  // If the saved topic was deleted elsewhere, fall back to "全部".
  if (state.topicId && !state.topics.find((t) => t.id === state.topicId)) {
    state.topicId = 0;
    localStorage.setItem(SAVED_TOPIC_KEY, "0");
  }
  renderTopicPicker();
}

function renderTopicPicker() {
  const sel = $("#topic-picker");
  sel.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "0";
  allOpt.textContent = "🌐 全部";
  sel.appendChild(allOpt);
  state.topics.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    opt.textContent = `${t.name} (${t.source_count})`;
    sel.appendChild(opt);
  });
  sel.value = String(state.topicId || 0);
}

$("#topic-picker").addEventListener("change", async (e) => {
  state.topicId = Number(e.target.value) || 0;
  localStorage.setItem(SAVED_TOPIC_KEY, String(state.topicId));
  // Switching topic invalidates the current selection set, since slugs
  // outside the new topic shouldn't stay checked.
  state.selected.clear();
  state.convId = null;
  await Promise.all([loadSources(), loadConvs()]);
});

$("#manage-topics-btn").addEventListener("click", openTopicManager);

function openTopicManager() {
  $("#modal-title-text").textContent = "管理主題";
  $("#modal-tabs").innerHTML = "";
  const body = $("#modal-body");
  body.innerHTML = "";
  body.appendChild(renderTopicManager());
  $("#source-modal").hidden = false;
}

function renderTopicManager() {
  const wrap = document.createElement("div");
  wrap.className = "topic-manager";
  const list = document.createElement("ul");
  list.className = "topic-list";
  // First topic (lowest id) is the default — cannot be deleted.
  const defaultId = state.topics.length ? state.topics[0].id : null;
  state.topics.forEach((t) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="t-row">
        <span class="t-name">${escapeHtml(t.name)}${t.id === defaultId ? ' <small style="color:#888">(預設)</small>' : ""}</span>
        <span class="t-count">${t.source_count} 來源</span>
        <span class="t-actions">
          <button data-a="manage">📋 管理來源</button>
          <button data-a="rename">✎ 改名</button>
          ${t.id === defaultId ? "" : '<button data-a="delete" class="danger">🗑 刪除</button>'}
        </span>
      </div>
      <div class="t-expand" hidden></div>`;
    li.querySelector("[data-a=manage]").addEventListener("click", () => toggleTopicSourcePanel(li, t));
    li.querySelector("[data-a=rename]").addEventListener("click", async () => {
      const name = prompt("新名稱：", t.name);
      if (!name || name.trim() === t.name) return;
      try {
        await api(`/topics/${t.id}`, { method: "PATCH", body: { name: name.trim() } });
        await loadTopics();
        body_refresh();
      } catch (e) { alert("改名失敗：" + e.message); }
    });
    const delBtn = li.querySelector("[data-a=delete]");
    if (delBtn) delBtn.addEventListener("click", async () => {
      if (!confirm(`刪除主題「${t.name}」？\n（裡面的對話會搬到「預設」主題；來源不會被刪除）`)) return;
      try {
        await api(`/topics/${t.id}`, { method: "DELETE" });
        if (state.topicId === t.id) {
          state.topicId = 0;
          localStorage.setItem(SAVED_TOPIC_KEY, "0");
        }
        await loadTopics();
        await loadSources();
        await loadConvs();
        body_refresh();
      } catch (e) { alert("刪除失敗：" + e.message); }
    });
    list.appendChild(li);
  });

  const addRow = document.createElement("div");
  addRow.className = "topic-add-row";
  addRow.innerHTML = `
    <input type="text" id="new-topic-name" placeholder="新增主題名稱…">
    <button id="new-topic-btn">+ 新增</button>`;
  addRow.querySelector("#new-topic-btn").addEventListener("click", async () => {
    const name = $("#new-topic-name").value.trim();
    if (!name) return;
    try {
      await api("/topics", { method: "POST", body: { name } });
      await loadTopics();
      body_refresh();
    } catch (e) { alert("新增失敗：" + e.message); }
  });

  function body_refresh() {
    const body = $("#modal-body");
    body.innerHTML = "";
    body.appendChild(renderTopicManager());
  }

  wrap.appendChild(list);
  wrap.appendChild(addRow);
  return wrap;
}

async function toggleTopicSourcePanel(li, topic) {
  const panel = li.querySelector(".t-expand");
  // Toggle close
  if (!panel.hidden) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  // Close any other open panel for clarity
  document.querySelectorAll(".topic-list .t-expand").forEach((p) => {
    if (p !== panel) { p.hidden = true; p.innerHTML = ""; }
  });

  // Need every source (irrespective of current topicId filter) and the
  // current member list of this topic. Fetch both in parallel.
  let allSources, members;
  try {
    [allSources, members] = await Promise.all([
      api("/sources"),
      api(`/sources?topic_id=${topic.id}`),
    ]);
  } catch (e) { alert("載入來源失敗：" + e.message); return; }

  const checked = new Set(members.map((s) => s.slug));
  let filter = "";

  panel.innerHTML = `
    <input type="search" class="t-source-filter" placeholder="🔍 搜尋來源…">
    <label class="t-source-stat-row">
      <input type="checkbox" class="t-select-all">
      <span class="t-select-all-label">全選</span>
      <span class="t-source-stat"></span>
    </label>
    <ul class="t-source-checklist"></ul>
    <div class="t-expand-actions">
      <button class="t-save">儲存</button>
      <button class="t-cancel">取消</button>
    </div>`;

  const sortedAll = [...allSources].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
  );

  // Tracks the most recently rendered filtered list — used by the
  // "全選" toggle so it operates on what the user is actually seeing.
  let lastFiltered = sortedAll;

  const updateStat = () => {
    const q = filter.trim();
    panel.querySelector(".t-source-stat").textContent = q
      ? `· 顯示 ${lastFiltered.length} / ${sortedAll.length} · 已選 ${checked.size}`
      : `· 共 ${sortedAll.length} 來源 · 已選 ${checked.size}`;
  };

  const updateSelectAllBox = () => {
    const box = panel.querySelector(".t-select-all");
    if (!lastFiltered.length) {
      box.checked = false; box.indeterminate = false; return;
    }
    const inSelection = lastFiltered.filter((s) => checked.has(s.slug)).length;
    if (inSelection === 0) { box.checked = false; box.indeterminate = false; }
    else if (inSelection === lastFiltered.length) { box.checked = true; box.indeterminate = false; }
    else { box.checked = false; box.indeterminate = true; }
  };

  const renderList = () => {
    const ul = panel.querySelector(".t-source-checklist");
    ul.innerHTML = "";
    const q = filter.trim().toLowerCase();
    lastFiltered = q
      ? sortedAll.filter((s) =>
          (s.name || "").toLowerCase().includes(q) ||
          (s.slug || "").toLowerCase().includes(q))
      : sortedAll;
    updateStat();
    updateSelectAllBox();
    if (!lastFiltered.length) {
      ul.innerHTML = '<li class="empty">沒有符合的來源</li>';
      return;
    }
    lastFiltered.forEach((s) => {
      const item = document.createElement("li");
      const id = `tsrc-${topic.id}-${s.slug}`;
      item.innerHTML = `
        <label for="${id}">
          <input type="checkbox" id="${id}" ${checked.has(s.slug) ? "checked" : ""}>
          <span class="src-name">${escapeHtml(s.name)}</span>
          <span class="src-badges">${sourceTypeBadge(s.types)}</span>
        </label>`;
      item.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) checked.add(s.slug);
        else checked.delete(s.slug);
        updateStat();
        updateSelectAllBox();
      });
      ul.appendChild(item);
    });
  };

  panel.querySelector(".t-source-filter").addEventListener("input", (e) => {
    filter = e.target.value;
    renderList();
  });
  // 全選 toggle: applies to whatever is currently filtered/visible
  panel.querySelector(".t-select-all").addEventListener("change", (e) => {
    if (e.target.checked) lastFiltered.forEach((s) => checked.add(s.slug));
    else lastFiltered.forEach((s) => checked.delete(s.slug));
    renderList();
  });
  panel.querySelector(".t-save").addEventListener("click", async () => {
    try {
      await api(`/topics/${topic.id}/sources`, {
        method: "PUT",
        body: { slugs: Array.from(checked) },
      });
      await loadTopics();
      await loadSources();
      // Re-render the manager so source_count updates and the panel resets
      const body = $("#modal-body");
      body.innerHTML = "";
      body.appendChild(renderTopicManager());
    } catch (e) { alert("儲存失敗：" + e.message); }
  });
  panel.querySelector(".t-cancel").addEventListener("click", () => {
    panel.hidden = true;
    panel.innerHTML = "";
  });

  renderList();
  panel.hidden = false;
}

async function openSourceTopicsDialog(source) {
  let current;
  try {
    current = await api(`/sources/${source.slug}/topics`);
  } catch (e) { alert("讀取失敗：" + e.message); return; }
  const checked = new Set(current.topic_ids);

  $("#modal-title-text").textContent = `主題分類：${source.name}`;
  $("#modal-tabs").innerHTML = "";
  const body = $("#modal-body");
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "topic-assign";
  const list = document.createElement("ul");
  list.className = "topic-assign-list";
  state.topics.forEach((t) => {
    const li = document.createElement("li");
    const id = `tassign-${t.id}`;
    li.innerHTML = `
      <label for="${id}">
        <input type="checkbox" id="${id}" ${checked.has(t.id) ? "checked" : ""}>
        ${escapeHtml(t.name)} <small style="color:#888">(${t.source_count} 來源)</small>
      </label>`;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) checked.add(t.id);
      else checked.delete(t.id);
    });
    list.appendChild(li);
  });
  const saveBtn = document.createElement("button");
  saveBtn.className = "topic-assign-save";
  saveBtn.textContent = "儲存";
  saveBtn.addEventListener("click", async () => {
    try {
      await api(`/sources/${source.slug}/topics`, {
        method: "PUT",
        body: { topic_ids: Array.from(checked) },
      });
      $("#source-modal").hidden = true;
      await loadTopics();
      await loadSources();
    } catch (e) { alert("儲存失敗：" + e.message); }
  });
  wrap.appendChild(list);
  wrap.appendChild(saveBtn);
  body.appendChild(wrap);
  $("#source-modal").hidden = false;
}

// ---------- Sources ----------
async function loadSources() {
  const q = state.topicId ? `?topic_id=${state.topicId}` : "";
  state.sources = await api("/sources" + q);
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
  // Sort by name (case-insensitive, locale-aware for CJK)
  const sorted = [...state.sources].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
  );
  // Apply filter
  const q = state.sourceFilter.trim().toLowerCase();
  const filtered = q
    ? sorted.filter((s) => (s.name || "").toLowerCase().includes(q) || (s.slug || "").toLowerCase().includes(q))
    : sorted;
  if (filtered.length === 0) {
    list.innerHTML = `<li style="color:#999;padding:20px 6px;font-size:12px;">沒有符合「${escapeHtml(q)}」的來源。</li>`;
    updateSourcesCount();
    syncSelectAll();
    return;
  }
  filtered.forEach((s) => {
    const li = document.createElement("li");
    const checked = state.selected.has(s.slug);
    const chunkInfo = s.chunk_count ? `${s.chunk_count} 片段` : (s.chapter_count ? `${s.chapter_count} 章` : "");
    li.innerHTML = `
      <input type="checkbox" ${checked ? "checked" : ""}>
      <div class="title-block">
        <div class="title-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
        <div class="meta">${sourceTypeBadge(s.types)} ${escapeHtml(chunkInfo)}</div>
      </div>
      <div class="source-menu-wrap">
        <button class="source-menu-btn" title="選單">⋮</button>
      </div>`;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.selected.add(s.slug);
      else state.selected.delete(s.slug);
      updateSourcesCount();
      syncSelectAll();
    });
    // Click title area → open reader
    li.querySelector(".title-block").addEventListener("click", (e) => {
      e.stopPropagation();
      openSourceReader(s.slug);
    });
    li.querySelector(".title-block").style.cursor = "pointer";
    // Menu button
    li.querySelector(".source-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openSourceMenu(e.currentTarget, s);
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
$("#source-filter").addEventListener("input", (e) => {
  state.sourceFilter = e.target.value;
  renderSources();
});

// ---------- Source menu (rename / delete) ----------
function closeSourceMenu() {
  document.querySelectorAll(".source-menu-dropdown").forEach((el) => el.remove());
}
document.addEventListener("click", closeSourceMenu);

function openSourceMenu(anchor, source) {
  closeSourceMenu();
  const wrap = anchor.parentElement;
  const menu = document.createElement("div");
  menu.className = "source-menu-dropdown";
  menu.innerHTML = `
    <button data-a="rename">✎ 重新命名</button>
    <button data-a="topics">🏷 主題分類…</button>
    <button data-a="delete" class="danger">🗑 刪除</button>`;
  menu.addEventListener("click", (e) => e.stopPropagation());
  menu.querySelector("[data-a=rename]").addEventListener("click", async () => {
    closeSourceMenu();
    const newName = prompt("重新命名為：", source.name);
    if (!newName || newName.trim() === source.name) return;
    try {
      await api(`/sources/${source.slug}`, {
        method: "PATCH", body: { name: newName.trim() },
      });
      loadSources();
    } catch (err) { alert("重新命名失敗：" + err.message); }
  });
  menu.querySelector("[data-a=topics]").addEventListener("click", async () => {
    closeSourceMenu();
    await openSourceTopicsDialog(source);
  });
  menu.querySelector("[data-a=delete]").addEventListener("click", async () => {
    closeSourceMenu();
    if (!confirm(`刪除「${source.name}」？此動作無法復原。`)) return;
    try {
      await api(`/sources/${source.slug}`, { method: "DELETE" });
      state.selected.delete(source.slug);
      loadSources();
    } catch (err) { alert("刪除失敗：" + err.message); }
  });
  wrap.appendChild(menu);
}

// ---------- Source reader modal ----------
const readerState = { slug: null, data: null, tab: null, chapterIdx: 0 };

async function openSourceReader(slug) {
  try {
    const data = await api(`/sources/${slug}/content`);
    readerState.slug = slug;
    readerState.data = data;
    readerState.tab = data.types[0] || "skill";
    readerState.chapterIdx = 0;
    renderReader();
    $("#source-modal").hidden = false;
  } catch (e) { alert("讀取來源失敗：" + e.message); }
}
function closeReader() {
  $("#source-modal").hidden = true;
  readerState.data = null;
}
$("#modal-close").addEventListener("click", closeReader);
$("#source-modal").addEventListener("click", (e) => {
  if (e.target.id === "source-modal") closeReader();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#source-modal").hidden) closeReader();
});

function renderReader() {
  const d = readerState.data;
  if (!d) return;
  $("#modal-title-text").textContent = d.name;
  const tabs = $("#modal-tabs");
  tabs.innerHTML = "";
  if (d.types.length > 1) {
    d.types.forEach((t) => {
      const b = document.createElement("button");
      b.textContent = t === "skill" ? "📖 skill.md" : "🔎 embedding";
      if (t === readerState.tab) b.classList.add("active");
      b.addEventListener("click", () => { readerState.tab = t; renderReader(); });
      tabs.appendChild(b);
    });
  }
  const body = $("#modal-body");
  body.innerHTML = "";
  if (readerState.tab === "skill" && d.skill) body.appendChild(renderSkillReader(d.skill));
  else if (readerState.tab === "embedding" && d.embedding) body.appendChild(renderEmbeddingReader(d.embedding));
  else body.innerHTML = '<div style="padding:40px;color:#888;">（無內容）</div>';
}

function renderSkillReader(skill) {
  const wrap = document.createElement("div");
  wrap.className = "reader-skill";
  const list = document.createElement("div");
  list.className = "reader-chapter-list";
  const content = document.createElement("div");
  content.className = "reader-content";

  const items = [{ title: "📘 主要 SKILL.md", content: skill.main_md, isMain: true }];
  skill.chapters.forEach((ch, i) => items.push({ title: ch.title, content: ch.content, i }));

  // Chapter list
  const mainGroup = document.createElement("div");
  mainGroup.className = "ch-group-title";
  mainGroup.textContent = "總覽";
  list.appendChild(mainGroup);
  const mainItem = document.createElement("div");
  mainItem.className = "ch-item";
  mainItem.textContent = "📘 SKILL.md";
  list.appendChild(mainItem);

  const chaptersGroup = document.createElement("div");
  chaptersGroup.className = "ch-group-title";
  chaptersGroup.textContent = `章節 (${skill.chapters.length})`;
  list.appendChild(chaptersGroup);

  const chapterEls = [mainItem];
  skill.chapters.forEach((ch, i) => {
    const el = document.createElement("div");
    el.className = "ch-item";
    el.textContent = ch.title;
    list.appendChild(el);
    chapterEls.push(el);
  });

  const setActive = (idx) => {
    readerState.chapterIdx = idx;
    chapterEls.forEach((el, i) => el.classList.toggle("active", i === idx));
    content.innerHTML = renderMarkdown(items[idx].content);
    content.scrollTop = 0;
  };
  chapterEls.forEach((el, i) => el.addEventListener("click", () => setActive(i)));
  setActive(Math.min(readerState.chapterIdx, items.length - 1));

  wrap.appendChild(list);
  wrap.appendChild(content);
  return wrap;
}

function renderEmbeddingReader(emb) {
  const wrap = document.createElement("div");
  wrap.className = "reader-embed";
  const toolbar = document.createElement("div");
  toolbar.className = "reader-embed-toolbar";
  toolbar.innerHTML = `
    <input type="search" placeholder="搜尋片段內容…（純文字比對）" id="chunk-search">
    <span class="stat" id="chunk-stat">共 ${emb.count} 片段</span>`;
  const chunks = document.createElement("div");
  chunks.className = "reader-embed-chunks";

  const renderChunks = (q) => {
    chunks.innerHTML = "";
    const query = (q || "").trim().toLowerCase();
    let shown = 0;
    emb.chunks.forEach((c) => {
      if (query && !c.text.toLowerCase().includes(query)) return;
      shown++;
      const card = document.createElement("div");
      card.className = "chunk-card";
      let text = escapeHtml(c.text);
      if (query) {
        const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
        text = text.replace(re, "<mark>$1</mark>");
      }
      card.innerHTML = `<div class="chunk-head">#${c.idx}</div>${text}`;
      chunks.appendChild(card);
    });
    $("#chunk-stat").textContent = query
      ? `顯示 ${shown} / ${emb.count} 片段`
      : `共 ${emb.count} 片段`;
    if (shown === 0) {
      chunks.innerHTML = '<div style="color:#888;padding:30px;text-align:center;">沒有符合的片段。</div>';
    }
  };

  wrap.appendChild(toolbar);
  wrap.appendChild(chunks);
  // Render after element is in DOM so #chunk-stat/#chunk-search queryable
  setTimeout(() => {
    renderChunks("");
    $("#chunk-search").addEventListener("input", (e) => renderChunks(e.target.value));
  }, 0);
  return wrap;
}

function openMessageModal(content) {
  $("#modal-title-text").textContent = "AI 回應";
  $("#modal-tabs").innerHTML = "";
  const body = $("#modal-body");
  body.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "reader-content";
  wrap.style.flex = "1";
  wrap.innerHTML = renderMarkdown(content);
  body.appendChild(wrap);
  $("#source-modal").hidden = false;
}

function renderMarkdown(md) {
  if (window.marked) {
    try { return window.marked.parse(md); } catch {}
  }
  return `<pre>${escapeHtml(md)}</pre>`;
}

// ---------- Conversations ----------
async function loadConvs() {
  const q = state.topicId ? `?topic_id=${state.topicId}` : "";
  state.convs = await api("/conversations" + q);
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
  const conv = await api("/conversations", {
    method: "POST",
    body: { topic_id: state.topicId || null },
  });
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
  const actionsHtml = m.role === "assistant"
    ? `<div class="msg-actions">
         <button class="save-source-btn">💾 存為來源</button>
         <button class="copy-btn">📋 複製</button>
       </div>` : "";
  const expandBtnHtml = m.role === "assistant"
    ? `<button class="msg-expand-btn" title="放大檢視">⛶</button>` : "";
  div.innerHTML = `
    <div class="msg-header">
      <div class="role">${roleText}</div>
      ${expandBtnHtml}
    </div>
    <div class="content">${escapeHtml(m.content)}</div>
    ${metaHtml}
    ${actionsHtml}`;
  if (m.role === "assistant") {
    const content = m.content;
    div.querySelector(".save-source-btn").addEventListener("click", () => saveAsSource(content));
    const copyBtn = div.querySelector(".copy-btn");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(content);
        const orig = copyBtn.textContent;
        copyBtn.textContent = "✓ 已複製";
        copyBtn.disabled = true;
        setTimeout(() => { copyBtn.textContent = orig; copyBtn.disabled = false; }, 1500);
      } catch (e) { alert("複製失敗：" + e.message); }
    });
    div.querySelector(".msg-expand-btn").addEventListener("click", () => openMessageModal(content));
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
      body: { content, title, topic_id: state.topicId || null },
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
// Auto-grow the textarea up to its CSS max-height; reset back to 1 line when emptied.
(function setupChatInputAutogrow() {
  const ta = $("#chat-input");
  if (!ta) return;
  const resize = () => {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  };
  ta.addEventListener("input", resize);
  // Reset after send (sendChat clears the value)
  const obs = new MutationObserver(() => { if (!ta.value) ta.style.height = ""; });
  obs.observe(ta, { attributes: true, attributeFilter: ["value"] });
  // Also catch the post-send clearing path
  const origDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  Object.defineProperty(ta, "value", {
    get() { return origDescriptor.get.call(this); },
    set(v) { origDescriptor.set.call(this, v); if (!v) ta.style.height = ""; },
  });
})();
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
  const conv = await api("/conversations", {
    method: "POST",
    body: { topic_id: state.topicId || null },
  });
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
        await api(endpoint, {
          method: "POST",
          body: { pdf_filename: p.name, topic_id: state.topicId || null },
        });
      } catch (e) {
        alert(errLabel + "：" + e.message);
      } finally {
        // Restore buttons regardless of outcome — the job is created (or failed
        // to be created); whatever happens next belongs to the jobs panel.
        btns.forEach((b) => (b.disabled = false));
        btnClicked.textContent = origLabel;
        btnClicked.classList.remove("loading");
        loadJobs();
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
        if (a === "delete" && !confirm("刪除任務？會一併刪除已產生的來源資料。")) return;
        const allBtns = li.querySelectorAll("[data-a]");
        const orig = btn.innerHTML;
        allBtns.forEach((b) => (b.disabled = true));
        const labels = { pause: "暫停中…", resume: "啟動中…", delete: "刪除中…" };
        btn.innerHTML = `<span class="spinner"></span> ${labels[a] || "處理中…"}`;
        btn.classList.add("loading");
        try {
          if (a === "pause") await api(`/jobs/${j.id}/pause`, { method: "POST" });
          else if (a === "resume") await api(`/jobs/${j.id}/resume`, { method: "POST" });
          else if (a === "delete") await api(`/jobs/${j.id}`, { method: "DELETE" });
        } catch (e) {
          alert(e.message);
          allBtns.forEach((b) => (b.disabled = false));
          btn.innerHTML = orig;
          btn.classList.remove("loading");
        }
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
(async () => {
  await loadTopics();
  await loadSources();
  await loadConvs();
  updateProviderIndicator();
})();
