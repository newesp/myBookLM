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
  // LLM Wiki info — { exists, page_count, by_type, last_updated, ... } or null
  wikiInfo: null,
};

// Sentinel slug used to mean "include the LLM Wiki" in selected sources.
// Mirrors backend/wiki.py::WIKI_SLUG_SENTINEL.
const WIKI_SLUG = "__wiki__";

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
  const [srcs, wikiInfo] = await Promise.all([
    api("/sources" + q),
    api("/wiki/info").catch(() => null),
  ]);
  state.sources = srcs;
  state.wikiInfo = wikiInfo;
  renderSources();
}

function fmtWikiTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "剛剛";
  if (diffMin < 60) return `${diffMin} 分鐘前`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} 小時前`;
  return d.toLocaleDateString();
}

function renderWikiItem() {
  const li = document.createElement("li");
  li.className = "source-wiki";
  const w = state.wikiInfo;
  const checked = state.selected.has(WIKI_SLUG);
  const exists = w && w.exists;
  const metaText = exists
    ? `${w.page_count} 頁${w.last_updated ? " · " + fmtWikiTimestamp(w.last_updated) : ""}`
    : "尚未建立 — 點 AI 訊息上的「📖 存入 Wiki」即可開始";
  const brokenSuffix = exists && w.broken_link_count
    ? ` · <span class="wiki-broken-count" title="點檢視可看 broken link 清單">⚠ ${w.broken_link_count} broken</span>`
    : "";
  li.innerHTML = `
    <input type="checkbox" ${checked ? "checked" : ""} ${exists ? "" : "disabled"}>
    <div class="title-block">
      <div class="title-name">📖 LLM Wiki</div>
      <div class="meta"><span class="type-badge badge-wiki">wiki</span> ${escapeHtml(metaText)}${brokenSuffix}</div>
    </div>
    <div class="source-menu-wrap">
      ${exists ? '<button class="source-menu-btn" title="檢視">⋮</button>' : ""}
    </div>`;
  const cb = li.querySelector("input");
  cb.addEventListener("change", (e) => {
    if (e.target.checked) state.selected.add(WIKI_SLUG);
    else state.selected.delete(WIKI_SLUG);
    updateSourcesCount();
  });
  if (exists) {
    li.querySelector(".title-block").addEventListener("click", openWikiViewer);
    li.querySelector(".title-block").style.cursor = "pointer";
    const menu = li.querySelector(".source-menu-btn");
    if (menu) menu.addEventListener("click", (e) => {
      e.stopPropagation();
      openWikiViewer();
    });
  }
  return li;
}

// Module-level cache for the wiki viewer session — set when the modal opens,
// used to mark broken links and to detect stale ones without an extra fetch.
let _wikiKnownPaths = new Set();

async function openWikiViewer() {
  let info, idx, pages;
  try {
    [info, idx, pages] = await Promise.all([
      api("/wiki/info"),
      api("/wiki/index"),
      api("/wiki/pages"),
    ]);
  } catch (e) { alert("讀取 wiki 失敗：" + e.message); return; }
  _wikiKnownPaths = new Set((pages.pages || []).map((p) => p.path));
  $("#modal-title-text").textContent = "📖 LLM Wiki";
  $("#modal-tabs").innerHTML = "";
  const body = $("#modal-body");
  const counts = info.by_type || {};
  const countLine = ["concept", "entity", "summary", "compare", "synthesis"]
    .map((t) => `${t}: ${counts[t] || 0}`).join(" · ");
  const brokenList = Array.isArray(info.broken_links) ? info.broken_links : [];
  const brokenHtml = info.broken_link_count > 0
    ? `<details class="wiki-broken-panel" ${brokenList.length <= 5 ? "open" : ""}>
         <summary>⚠ ${info.broken_link_count} broken link${info.broken_link_count > 1 ? "s" : ""}${brokenList.length < info.broken_link_count ? `（顯示前 ${brokenList.length} 筆）` : ""}</summary>
         <ul class="wiki-broken-list">
           ${brokenList.map((b) => `
             <li>
               <a href="#" class="wiki-broken-from" data-path="${escapeHtml(b.from)}"><code>${escapeHtml(b.from)}</code></a>
               → <code class="wiki-broken-to">${escapeHtml(b.to)}</code>
               <small>（${escapeHtml(b.text)}）</small>
             </li>`).join("")}
         </ul>
       </details>`
    : "";
  body.innerHTML = `
    <div class="wiki-viewer">
      <div class="wiki-viewer-meta">
        共 ${info.page_count} 頁 · ${escapeHtml(countLine)}
        ${info.last_updated ? "<br>最後更新：" + escapeHtml(info.last_updated) : ""}
        <div class="wiki-toolbar">
          <button class="wiki-lint-btn" data-mode="cheap">🩺 結構檢查</button>
          <button class="wiki-lint-btn" data-mode="llm">🧠 用 LLM 深度檢查</button>
          <button class="wiki-migrate-btn" data-action="sources-plaintext"
            title="把所有頁面 ## Sources 區塊裡的 markdown link 轉成純文字（保留可見字）">
            🧹 Sources 純文字化
          </button>
        </div>
      </div>
      ${brokenHtml}
      <div class="wiki-lint-results" hidden></div>
      <div class="wiki-viewer-content"></div>
    </div>`;
  const contentEl = body.querySelector(".wiki-viewer-content");
  const lintResults = body.querySelector(".wiki-lint-results");
  // Clicking "from" link in broken-link list jumps to that page
  body.querySelectorAll(".wiki-broken-from").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      renderWikiPageInto(contentEl, a.dataset.path);
    });
  });
  body.querySelectorAll(".wiki-lint-btn").forEach((btn) => {
    btn.addEventListener("click", () => runWikiLint(btn.dataset.mode, lintResults, body, contentEl));
  });
  body.querySelectorAll(".wiki-migrate-btn").forEach((btn) => {
    btn.addEventListener("click", () => runWikiMigration(btn, body, contentEl, lintResults));
  });
  renderWikiIndexInto(contentEl, idx.content || "");
  $("#source-modal").hidden = false;
}

async function runWikiMigration(btn, body, contentEl, lintResults) {
  const action = btn.dataset.action;
  if (action !== "sources-plaintext") return;
  if (!confirm(
    "🧹 Sources 純文字化\n\n" +
    "把所有頁面的「## Sources」區塊裡的 markdown link 轉成純文字（保留可見文字、移除 [](path) 包裝）。\n\n" +
    "這是無損操作（內容不會掉），執行後 broken link 數通常會大幅減少。\n" +
    "Idempotent — 跑過再跑也不會壞。要繼續嗎？"
  )) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 處理中…';
  try {
    const r = await api("/wiki/migrate/sources-plaintext", { method: "POST" });
    btn.textContent = orig;
    btn.disabled = false;
    const summary =
      `✓ 已掃描 ${r.pages_scanned} 頁，${r.pages_changed} 頁被修改，` +
      `共移除 ${r.links_removed} 個 markdown link。`;
    alert(summary + (r.changes && r.changes.length
      ? "\n\n受影響頁面：\n" + r.changes.map((c) => `  ${c.path} (×${c.links_removed})`).join("\n")
      : ""));
    // Refresh wiki info, broken-link panel, and re-run cheap lint.
    await refreshWikiAfterFix(body, contentEl);
  } catch (e) {
    alert("Sources 純文字化失敗：" + e.message);
    btn.textContent = orig;
    btn.disabled = false;
  }
}

const LINT_CATEGORY_LABEL = {
  broken_link: "🔗 broken link",
  orphan: "🏝 orphan（無人連入）",
  empty_page: "📭 空頁",
  missing_h1: "🔠 缺 H1",
  missing_header_blockquote: "📝 缺 header blockquote",
  missing_sources_section: "📚 缺 ## Sources",
  duplicate: "👯 重複",
  contradiction: "⚡ 矛盾",
  stale_claim: "🕰 過時陳述",
  misclassified: "🗂 分類不符",
};

async function runWikiLint(mode, container, body, contentEl) {
  const llm = mode === "llm";
  if (llm && !confirm(
    "🧠 用 LLM 做深度 lint？\n\n" +
    "這會把 wiki 全部頁面送進 LLM 跑 1 次呼叫，依模型可能花費數千 tokens。\n" +
    "結構性問題（broken link / orphan / 缺欄位）建議先用「結構檢查」，那個免錢。"
  )) return;

  // Disable both buttons during run
  const btns = body.querySelectorAll(".wiki-lint-btn");
  btns.forEach((b) => (b.disabled = true));
  const trigger = body.querySelector(`.wiki-lint-btn[data-mode="${mode}"]`);
  const orig = trigger.textContent;
  trigger.innerHTML = '<span class="spinner"></span> 檢查中…';

  try {
    const r = await api(llm ? "/wiki/lint/llm" : "/wiki/lint", { method: "POST" });
    container.hidden = false;
    container.innerHTML = renderLintResults(r, llm);
    hookLintActions(container, body, contentEl);
    // Remember which mode the user last ran so refreshWikiAfterFix() can
    // decide whether to re-run cheap lint (cheap=fine to re-run) vs leave the
    // LLM-mode panel intact (re-running LLM costs thousands of tokens).
    body.dataset.lastLintMode = mode;
  } catch (e) {
    container.hidden = false;
    container.innerHTML = `<div class="wiki-broken-link">Lint 失敗：${escapeHtml(e.message)}</div>`;
  } finally {
    btns.forEach((b) => (b.disabled = false));
    trigger.textContent = orig;
  }
}

function renderLintResults(r, isLlm) {
  const issues = r.issues || [];
  const headerExtras = isLlm
    ? `<small>${r.pages_scanned}/${r.pages_total} pages · ${r.tokens_in || 0} in / ${r.tokens_out || 0} out${r.truncated ? " · ⚠ truncated" : ""}</small>`
    : `<small>page count: ${r.page_count}</small>`;
  if (!issues.length) {
    return `<div class="wiki-lint-empty">
      ✅ ${isLlm ? "LLM" : "結構"}檢查未發現問題。 ${headerExtras}
      ${isLlm && r.summary ? `<div class="wiki-lint-summary">${escapeHtml(r.summary)}</div>` : ""}
    </div>`;
  }
  // Group by category
  const byCat = {};
  issues.forEach((iss) => {
    (byCat[iss.category] = byCat[iss.category] || []).push(iss);
  });
  const sections = Object.entries(byCat).map(([cat, list]) => {
    const label = LINT_CATEGORY_LABEL[cat] || cat;
    const isBroken = cat === "broken_link";
    const bulkBtn = isBroken
      ? ` <button class="lint-bulk-fix" data-cat="broken_link">🔧 全部移除連結（保留文字）</button>`
      : "";
    const isOrphan = cat === "orphan";
    const items = list.map((iss, idx) => {
      const pageRef = iss.page
        ? `<a href="#" data-lint-page="${escapeHtml(iss.page)}"><code>${escapeHtml(iss.page)}</code></a>`
        : "";
      const fix = iss.suggested_fix
        ? `<div class="lint-fix">建議：${escapeHtml(iss.suggested_fix)}</div>`
        : "";
      let fixBtn = "";
      if (isBroken && iss.to) {
        fixBtn = `<button class="lint-fix-btn" data-from="${escapeHtml(iss.page)}" data-to="${escapeHtml(iss.to)}" title="把 [text](broken) 換成純文字 text">🔧 移除連結</button>`;
      } else if (isOrphan && iss.page) {
        fixBtn = `<button class="lint-repair-btn" data-action="orphan" data-page="${escapeHtml(iss.page)}" title="LLM 挑 1-2 頁建立雙向交叉引用（會花 token）">🛠 LLM 修</button>`;
      } else if (cat === "contradiction" && iss.page) {
        const issBlob = encodeURIComponent(JSON.stringify(iss));
        fixBtn = `<button class="lint-discuss-btn" data-issue="${issBlob}" title="開新對話與 AI 討論這個矛盾，最後手動 📖 存入 Wiki">💬 與 AI 討論</button>`;
      } else if (cat === "duplicate" && iss.page) {
        const issBlob = encodeURIComponent(JSON.stringify(iss));
        fixBtn = `<button class="lint-plan-btn" data-issue="${issBlob}" title="LLM 提合併計畫，預覽 diff 後再決定是否套用（會花 token）">🛠 LLM 修</button>`;
      }
      return `
        <li data-cat="${cat}" data-idx="${idx}">
          ${pageRef} ${fixBtn}
          <div class="lint-detail">${escapeHtml(iss.detail || "")}</div>
          ${fix}
        </li>`;
    }).join("");
    return `
      <details class="lint-cat" open>
        <summary>${label} <span class="lint-count">${list.length}</span>${bulkBtn}</summary>
        <ul>${items}</ul>
      </details>`;
  }).join("");
  return `
    <div class="wiki-lint-header">
      <strong>${isLlm ? "🧠 LLM" : "🩺 結構"} lint：${issues.length} 個問題</strong>
      ${headerExtras}
      ${isLlm && r.summary ? `<div class="wiki-lint-summary">${escapeHtml(r.summary)}</div>` : ""}
    </div>
    ${sections}`;
}

// ---------- Wiki repair: diff modal ----------
// LCS-based aligned line diff. Returns rows of {left, right, op}; "eq" rows
// have both sides populated, "del" rows have right="", "add" rows have left="".
// O(m*n) memory — fine for typical wiki page sizes (< 1000 lines each).
function alignedLineDiff(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  const m = la.length;
  const n = lb.length;
  // dp[i][j] = LCS length of la[i..] and lb[j..]
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = la[i] === lb[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (la[i] === lb[j]) {
      rows.push({ left: la[i], right: lb[j], op: "eq" }); i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ left: la[i], right: "", op: "del" }); i++;
    } else {
      rows.push({ left: "", right: lb[j], op: "add" }); j++;
    }
  }
  while (i < m) rows.push({ left: la[i++], right: "", op: "del" });
  while (j < n) rows.push({ left: "", right: lb[j++], op: "add" });
  return rows;
}

function renderDiffTable(before, after) {
  const rows = alignedLineDiff(before, after);
  const cells = rows.map((r) => {
    const leftCls = r.op === "eq" ? "eq" : (r.op === "del" ? "del" : "empty");
    const rightCls = r.op === "eq" ? "eq" : (r.op === "add" ? "add" : "empty");
    return `<div class="diff-cell ${leftCls}">${escapeHtml(r.left || " ")}</div>` +
           `<div class="diff-cell ${rightCls}">${escapeHtml(r.right || " ")}</div>`;
  }).join("");
  return `
    <div class="diff-table">
      <div class="diff-col-header before">舊內容（before）</div>
      <div class="diff-col-header after">新內容（after）</div>
      ${cells}
    </div>`;
}

// `wikiBody` and `contentEl` are the wiki viewer elements that should be
// refreshed after a successful apply (so the lint panel + page count update).
function openRepairModal(plan, issue, wikiBody, contentEl) {
  const modal = $("#repair-modal");
  const titleEl = $("#repair-modal-title");
  const metaEl = $("#repair-modal-meta");
  const bodyEl = $("#repair-modal-body");
  const cancelBtn = $("#repair-cancel-btn");
  const regenBtn = $("#repair-regen-btn");
  const applyBtn = $("#repair-apply-btn");

  titleEl.textContent = `合併重複頁 · 預覽 (${plan.kind || "duplicate-merge"})`;
  const expiresIn = Math.max(
    0, Math.round((plan.expires_at * 1000 - Date.now()) / 1000)
  );
  metaEl.textContent =
    `tokens: ${plan.tokens_in || 0} in / ${plan.tokens_out || 0} out · ` +
    `plan_id: ${plan.plan_id} · 5 分鐘內未套用會過期（剩 ${expiresIn}s）`;

  const sections = (plan.actions || []).map((act) => {
    const role = act.role === "primary" ? "primary" : "secondary";
    const roleLabel = role === "primary" ? "保留為主頁（合併內容）" : "改為跳轉 stub";
    return `
      <div class="repair-section">
        <div class="repair-section-header">
          <span class="role-badge role-${role}">${role}</span>
          <code>${escapeHtml(act.path)}</code>
          <span style="color:#6b7280;">— ${roleLabel}</span>
        </div>
        ${renderDiffTable(act.before || "", act.after || "")}
      </div>`;
  }).join("");

  bodyEl.innerHTML = `
    ${plan.reasoning ? `<div class="repair-reasoning">💡 ${escapeHtml(plan.reasoning)}</div>` : ""}
    <div class="repair-meta-line">
      套用前會把舊內容快照寫入 <code>log.md</code>，可手動還原。
    </div>
    ${sections}`;

  modal.hidden = false;

  const close = () => {
    modal.hidden = true;
    cancelBtn.onclick = null;
    regenBtn.onclick = null;
    applyBtn.onclick = null;
  };

  cancelBtn.onclick = close;
  regenBtn.onclick = async () => {
    regenBtn.disabled = true;
    applyBtn.disabled = true;
    const origR = regenBtn.textContent;
    regenBtn.innerHTML = '<span class="spinner"></span> 重新生成中…';
    try {
      const newPlan = await api("/wiki/repair/plan", {
        method: "POST",
        body: { issue },
      });
      // Re-render in place (handlers stay bound).
      close();
      openRepairModal(newPlan, issue, wikiBody, contentEl);
    } catch (err) {
      alert("重新生成失敗：" + err.message);
      regenBtn.disabled = false;
      applyBtn.disabled = false;
      regenBtn.textContent = origR;
    }
  };
  applyBtn.onclick = async () => {
    if (!confirm(
      `✅ 套用合併計畫？\n\n` +
      `  primary:   ${plan.primary}\n` +
      `  secondary: ${plan.secondary}\n\n` +
      "舊內容會快照進 log.md。"
    )) return;
    applyBtn.disabled = true;
    regenBtn.disabled = true;
    cancelBtn.disabled = true;
    const origA = applyBtn.textContent;
    applyBtn.innerHTML = '<span class="spinner"></span> 套用中…';
    try {
      const r = await api("/wiki/repair/apply", {
        method: "POST",
        body: { plan_id: plan.plan_id },
      });
      close();
      alert(
        `✓ 已套用合併計畫\n` +
        `  共改了 ${r.applied.length} 頁\n` +
        `  (snapshot 已寫入 log.md)`
      );
      // Both pages are now structurally different — easiest is to refresh
      // wiki info + drop the duplicate row from the LLM lint panel.
      await refreshWikiAfterFix(wikiBody, contentEl, {
        category: "duplicate", page: issue.page,
      });
    } catch (err) {
      alert("套用失敗：" + err.message);
      applyBtn.disabled = false;
      regenBtn.disabled = false;
      cancelBtn.disabled = false;
      applyBtn.textContent = origA;
    }
  };
}

// Wire the close button + backdrop click once at load.
(function bindRepairModalClose() {
  const modal = $("#repair-modal");
  if (!modal) return;
  $("#repair-modal-close").addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
})();

async function unlinkBroken(fromPath, toPath) {
  return api("/wiki/fix-broken-link", {
    method: "POST",
    body: { from_path: fromPath, to_path: toPath },
  });
}

async function refreshWikiAfterFix(body, contentEl, fixed = null) {
  // `fixed` (optional): {category, page} describing the issue we just
  // resolved. Used to surgically remove the matching <li> from an LLM-mode
  // lint panel without re-running the expensive LLM lint.
  await loadSources();
  try {
    const info = await api("/wiki/info");
    rebuildBrokenPanel(body, info, contentEl);

    const container = body.querySelector(".wiki-lint-results");
    const lastMode = body.dataset.lastLintMode;
    if (lastMode === "llm" && container && !container.hidden) {
      // Don't re-run LLM lint — it costs thousands of tokens. Instead,
      // surgically prune the fixed issue from the displayed list. The user
      // can re-run 🧠 manually if they want fresh semantic findings.
      pruneLintIssueFromDom(container, fixed);
      ensureStaleLintNotice(container);
      return;
    }
    // Cheap lint mode (or no lint run yet): re-run cheap lint so the list
    // reflects the new state.
    const lintRes = await api("/wiki/lint", { method: "POST" });
    if (container) {
      container.hidden = false;
      container.innerHTML = renderLintResults(lintRes, false);
      hookLintActions(container, body, contentEl);
    }
  } catch (e) {
    console.warn("Lint refresh failed:", e);
  }
}

function pruneLintIssueFromDom(container, fixed) {
  // fixed shapes:
  //   { category, page }              — single non-broken_link issue (e.g. orphan)
  //   { category, page, to }          — single broken_link unlink
  //   { category, pairs: [{page,to}]} — batch broken_link unlink
  if (!fixed) return;
  const pairs = fixed.pairs
    || (fixed.page !== undefined ? [{ page: fixed.page, to: fixed.to }] : []);
  if (!pairs.length) return;
  const sel = fixed.category
    ? `li[data-cat="${fixed.category}"]`
    : "li[data-cat]";

  let removed = 0;
  pairs.forEach((t) => {
    container.querySelectorAll(sel).forEach((li) => {
      const pageRef = li.querySelector("[data-lint-page]");
      if (!pageRef || pageRef.dataset.lintPage !== t.page) return;
      // If `to` was supplied (broken_link), only remove the <li> whose fix
      // button points at the same target — a single page can have multiple
      // distinct broken_link entries.
      if (t.to !== undefined && t.to !== null) {
        const fixBtn = li.querySelector(".lint-fix-btn");
        if (!fixBtn || fixBtn.dataset.to !== t.to) return;
      }
      const section = li.closest("details.lint-cat");
      li.remove();
      removed++;
      if (section) {
        const countEl = section.querySelector(".lint-count");
        const remaining = section.querySelectorAll("li[data-cat]").length;
        if (countEl) countEl.textContent = remaining;
        if (remaining === 0) section.remove();
      }
    });
  });

  if (removed > 0) {
    const header = container.querySelector(".wiki-lint-header strong");
    if (header) {
      const m = header.textContent.match(/(\d+)\s*個問題/);
      if (m) {
        const newCount = Math.max(0, parseInt(m[1], 10) - removed);
        header.textContent = header.textContent.replace(
          /\d+\s*個問題/, `${newCount} 個問題`
        );
      }
    }
  }
}

function ensureStaleLintNotice(container) {
  if (container.querySelector(".lint-stale-notice")) return;
  const notice = document.createElement("div");
  notice.className = "lint-stale-notice";
  notice.innerHTML =
    "ℹ 顯示為上次 🧠 LLM lint 的結果（已剔除剛修好的項目）。" +
    "若要看新的語意分析，請重新點 🧠 用 LLM 深度檢查。";
  container.insertBefore(notice, container.firstChild);
}

function rebuildBrokenPanel(body, info, contentEl) {
  const panel = body.querySelector(".wiki-broken-panel");
  const count = info.broken_link_count || 0;
  if (count === 0) {
    if (panel) panel.remove();
    return;
  }
  const list = Array.isArray(info.broken_links) ? info.broken_links : [];
  const html = `
    <details class="wiki-broken-panel" ${list.length <= 5 ? "open" : ""}>
      <summary>⚠ ${count} broken link${count > 1 ? "s" : ""}${list.length < count ? `（顯示前 ${list.length} 筆）` : ""}</summary>
      <ul class="wiki-broken-list">
        ${list.map((b) => `
          <li>
            <a href="#" class="wiki-broken-from" data-path="${escapeHtml(b.from)}"><code>${escapeHtml(b.from)}</code></a>
            → <code class="wiki-broken-to">${escapeHtml(b.to)}</code>
            <small>（${escapeHtml(b.text)}）</small>
          </li>`).join("")}
      </ul>
    </details>`;
  if (panel) {
    panel.outerHTML = html;
  } else {
    // Insert before .wiki-lint-results / .wiki-viewer-content
    const anchor = body.querySelector(".wiki-lint-results") || body.querySelector(".wiki-viewer-content");
    anchor.insertAdjacentHTML("beforebegin", html);
  }
  body.querySelectorAll(".wiki-broken-from").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      renderWikiPageInto(contentEl, a.dataset.path);
    });
  });
}

function hookLintActions(container, body, contentEl) {
  container.querySelectorAll("[data-lint-page]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      renderWikiPageInto(contentEl, a.dataset.lintPage);
    });
  });
  container.querySelectorAll(".lint-fix-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { from, to } = btn.dataset;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        const r = await unlinkBroken(from, to);
        if (r.removed === 0) {
          alert("沒找到對應的連結（可能已被修掉了）。重新跑一次 lint 看看。");
        }
        await refreshWikiAfterFix(body, contentEl, {
          category: "broken_link", page: from, to,
        });
      } catch (err) {
        alert("修復失敗：" + err.message);
        btn.disabled = false;
        btn.textContent = "🔧 移除連結";
      }
    });
  });
  container.querySelectorAll(".lint-repair-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action !== "orphan") return;
      const page = btn.dataset.page;
      if (!confirm(
        `🛠 LLM 自動修復 orphan：${page}\n\n` +
        "流程：\n" +
        "  1. LLM 從現有頁挑 1-2 個最相關的「partner」頁\n" +
        "  2. 在 orphan 頁與每個 partner 頁加一句雙向交叉引用\n\n" +
        "會花 1 + N 次 LLM 呼叫（partner 1-2 個）。要繼續嗎？"
      )) return;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        const r = await api("/wiki/repair/orphan", {
          method: "POST",
          body: { page },
        });
        if (r.skipped) {
          alert(`LLM 判斷找不到適合的 partner：${r.skip_reason}\n（沒做任何修改）`);
          // No edits — don't prune; just refresh wiki info.
          await refreshWikiAfterFix(body, contentEl);
        } else {
          const partners = (r.partners || []).map((p) => p.path).join(", ");
          alert(
            `✓ 已建立交叉引用\n` +
            `  orphan: ${r.orphan}\n` +
            `  partners: ${partners}\n` +
            `  共改了 ${r.applied.length} 頁\n` +
            `  tokens: ${r.tokens_in} in / ${r.tokens_out} out`
          );
          // The orphan is no longer orphan; remove that entry from the panel.
          await refreshWikiAfterFix(body, contentEl, {
            category: "orphan", page: r.orphan,
          });
        }
      } catch (err) {
        alert("orphan 修復失敗：" + err.message);
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  });
  container.querySelectorAll(".lint-discuss-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      let iss;
      try {
        iss = JSON.parse(decodeURIComponent(btn.dataset.issue));
      } catch {
        alert("issue payload 解析失敗");
        return;
      }
      btn.disabled = true;
      const orig = btn.textContent;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        const r = await api("/wiki/repair/discuss", {
          method: "POST",
          body: { issue: iss },
        });
        // The new conversation is created under the default topic. If the
        // user is currently viewing a different topic, switch to "全部" so
        // the new conv is visible in the picker.
        if (state.topicId && state.topicId !== r.topic_id) {
          state.topicId = 0;
          localStorage.setItem(SAVED_TOPIC_KEY, "0");
          await loadTopics();
        }
        // Ensure wiki is selected so two-pass retrieval delivers context.
        if (state.wikiInfo && state.wikiInfo.exists) {
          state.selected.add(WIKI_SLUG);
        }
        // Close wiki viewer modal if open.
        const modal = $("#source-modal");
        if (modal) modal.hidden = true;
        switchTab("chat");
        await loadConvs();
        state.convId = r.conversation_id;
        const picker = $("#conv-picker");
        if (picker) picker.value = String(r.conversation_id);
        await loadMessages();
        // Pre-fill input with the seed; user reviews + clicks send so the
        // regular /chat path runs (no extra LLM endpoint required).
        const input = $("#chat-input");
        if (input) {
          input.value = r.seed_message;
          input.dispatchEvent(new Event("input"));
          input.focus();
        }
      } catch (err) {
        alert("建立討論對話失敗：" + err.message);
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  });
  container.querySelectorAll(".lint-plan-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      let iss;
      try {
        iss = JSON.parse(decodeURIComponent(btn.dataset.issue));
      } catch {
        alert("issue payload 解析失敗");
        return;
      }
      if (!confirm(
        `🛠 LLM 自動合併重複頁：\n` +
        `  ${iss.page}\n\n` +
        "流程：\n" +
        "  1. LLM 讀兩頁全文，挑 primary / secondary，提合併計畫\n" +
        "  2. 你看 diff 後決定是否套用\n\n" +
        "計畫階段會花 1 次 LLM 呼叫；先預覽不會寫入 wiki。要繼續嗎？"
      )) return;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        const plan = await api("/wiki/repair/plan", {
          method: "POST",
          body: { issue: iss },
        });
        openRepairModal(plan, iss, body, contentEl);
      } catch (err) {
        alert("產生合併計畫失敗：" + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  });
  container.querySelectorAll(".lint-bulk-fix").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cat = btn.dataset.cat;
      const items = Array.from(container.querySelectorAll(`li[data-cat="${cat}"]`));
      const targets = items
        .map((li) => li.querySelector(".lint-fix-btn"))
        .filter(Boolean)
        .map((b) => ({ from: b.dataset.from, to: b.dataset.to }));
      if (!targets.length) return;
      if (!confirm(`移除 ${targets.length} 個 broken link（保留可見文字）？\n操作會逐一寫進 log.md，可在那裡追蹤。`)) return;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.innerHTML = '<span class="spinner"></span> 處理中…';
      try {
        let totalRemoved = 0;
        for (const t of targets) {
          const r = await unlinkBroken(t.from, t.to);
          totalRemoved += r.removed || 0;
        }
        await refreshWikiAfterFix(body, contentEl, {
          category: "broken_link",
          pairs: targets.map((t) => ({ page: t.from, to: t.to })),
        });
        console.log(`[wiki bulk unlink] removed ${totalRemoved} link(s) across ${targets.length} target(s)`);
      } catch (err) {
        alert("批次修復中斷：" + err.message);
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  });
}

function renderWikiIndexInto(container, indexMd) {
  container.classList.add("wiki-index-md");
  container.classList.remove("wiki-page-md");
  container.innerHTML = marked.parse(indexMd);
  hookWikiLinks(container);
}

async function renderWikiPageInto(container, path) {
  const renderBack = () => {
    container.querySelector(".wiki-back-btn")?.addEventListener("click", async () => {
      const idx = await api("/wiki/index").catch(() => ({ content: "" }));
      renderWikiIndexInto(container, idx.content || "");
    });
  };
  let r;
  try {
    r = await api(`/wiki/page?path=${encodeURIComponent(path)}`);
  } catch (e) {
    // Render a friendly broken-link notice in-place instead of alert().
    container.classList.remove("wiki-index-md");
    container.classList.add("wiki-page-md");
    const isMissing = /^404/.test(e.message || "");
    container.innerHTML = `
      <button class="wiki-back-btn">← 回 Index</button>
      <div class="wiki-page-path">${escapeHtml(path)}</div>
      <div class="wiki-broken-link">
        ${isMissing
          ? `⚠ 此頁面不存在 — 多半是 LLM 寫了一個沒對應到實體頁的連結（broken link）。<br>
             之後 Phase 2 的 lint 操作會自動偵測這類問題。`
          : `讀取頁面失敗：${escapeHtml(e.message || "unknown")}`}
      </div>`;
    renderBack();
    return;
  }
  container.classList.remove("wiki-index-md");
  container.classList.add("wiki-page-md");
  container.innerHTML = `
    <button class="wiki-back-btn">← 回 Index</button>
    <div class="wiki-page-path">${escapeHtml(path)}</div>
    <div class="wiki-page-body">${marked.parse(r.content || "")}</div>`;
  renderBack();
  hookWikiLinks(container, path);
}

// Intercept relative .md links inside the wiki viewer and route them through
// the API instead of letting the browser navigate to a non-existent path.
// `currentPath` lets us resolve links that are relative to a sub-page.
function hookWikiLinks(container, currentPath = "") {
  const baseDir = currentPath.includes("/")
    ? currentPath.slice(0, currentPath.lastIndexOf("/") + 1)
    : "";
  container.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("#")) return;
    if (!href.endsWith(".md")) return;
    const parts = (baseDir + href).split("/");
    const stack = [];
    for (const p of parts) {
      if (!p || p === ".") continue;
      if (p === "..") stack.pop();
      else stack.push(p);
    }
    const resolved = stack.join("/");
    // If we know the page doesn't exist, mark the link visually so the user
    // can spot stale links before clicking. Click still works (renders the
    // friendly broken-link notice).
    if (_wikiKnownPaths.size && !_wikiKnownPaths.has(resolved)) {
      a.classList.add("wiki-link-broken");
      a.title = "broken link: " + resolved;
    }
    a.addEventListener("click", (e) => {
      e.preventDefault();
      renderWikiPageInto(container, resolved);
    });
  });
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
  // Wiki entry — always at top, regardless of filter / topic / source count.
  if (state.wikiInfo) {
    list.appendChild(renderWikiItem());
  }
  if (state.sources.length === 0) {
    const empty = document.createElement("li");
    empty.style = "color:#999;padding:20px 6px;font-size:12px;";
    empty.textContent = state.wikiInfo
      ? "尚無一般來源。點「新增來源」或切到「轉換」頁面建立。"
      : "尚無來源。點「新增來源」或切到「轉換」頁面建立。";
    list.appendChild(empty);
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
    const empty = document.createElement("li");
    empty.style = "color:#999;padding:20px 6px;font-size:12px;";
    empty.textContent = `沒有符合「${q}」的來源。`;
    list.appendChild(empty);
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
  const wikiAvailable = !!(state.wikiInfo && state.wikiInfo.exists);
  const total = state.sources.length + (wikiAvailable ? 1 : 0);
  cb.checked = total > 0 && state.selected.size === total;
}
$("#select-all-sources").addEventListener("change", (e) => {
  if (e.target.checked) {
    state.sources.forEach((s) => state.selected.add(s.slug));
    if (state.wikiInfo && state.wikiInfo.exists) state.selected.add(WIKI_SLUG);
  } else {
    state.selected.clear();
  }
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
  const types = source.types || [];
  const hasBoth = types.includes("skill") && types.includes("embedding");
  const deleteButtons = hasBoth
    ? `
      <button data-a="delete-embedding" class="danger">🗑 只刪 embedding</button>
      <button data-a="delete-skill" class="danger">🗑 只刪 skill.md</button>
      <button data-a="delete" class="danger">🗑 完全刪除</button>`
    : `<button data-a="delete" class="danger">🗑 刪除</button>`;
  menu.innerHTML = `
    <button data-a="rename">✎ 重新命名</button>
    <button data-a="topics">🏷 主題分類…</button>
    <button data-a="ingest-wiki">📖 灌入 Wiki</button>
    ${deleteButtons}`;
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
  menu.querySelector("[data-a=ingest-wiki]").addEventListener("click", async () => {
    closeSourceMenu();
    let preview;
    try {
      preview = await api(
        `/wiki/ingest/source/preview?slug=${encodeURIComponent(source.slug)}`
      );
    } catch (err) {
      alert("查詢來源資訊失敗：" + err.message);
      return;
    }
    const n = preview.chunk_count;
    if (!n) {
      alert("此來源沒有可灌入的內容。");
      return;
    }
    if (!confirm(
      `📖 把「${preview.name}」灌入 Wiki？\n\n` +
      `來源類型：${preview.types.join(", ")}\n` +
      `chunk 數：${n}\n\n` +
      `每個 chunk 會跑 1 次 Plan + N 次 Apply LLM 呼叫，` +
      `總共預估 ${n}-${n * 4} 次 LLM 呼叫，視主題複雜度而定。\n` +
      `成本可能不低，建議先在 Settings 切到便宜的 model（如 Gemini Flash）。\n\n` +
      `要繼續嗎？（過程中無法中斷）`
    )) return;
    try {
      const res = await api("/wiki/ingest/source", {
        method: "POST", body: { slug: source.slug },
      });
      alert(
        `✓ 灌入完成\n` +
        `  來源：${res.name}\n` +
        `  chunks 處理：${res.chunks_total}\n` +
        `  新增頁：${res.creates}\n` +
        `  更新頁：${res.updates}\n` +
        `  tokens：${res.tokens_in} in / ${res.tokens_out} out`
      );
      await loadSources();
    } catch (err) {
      alert("灌入 Wiki 失敗：" + err.message);
    }
  });
  const partialDelete = async (kind, label) => {
    closeSourceMenu();
    if (!confirm(`刪除「${source.name}」的 ${label}？\n（另一個來源類型會保留）`)) return;
    try {
      await api(`/sources/${source.slug}?type=${kind}`, { method: "DELETE" });
      loadSources();
    } catch (err) { alert("刪除失敗：" + err.message); }
  };
  const embBtn = menu.querySelector("[data-a=delete-embedding]");
  if (embBtn) embBtn.addEventListener("click", () => partialDelete("embedding", "embedding 片段"));
  const skillBtn = menu.querySelector("[data-a=delete-skill]");
  if (skillBtn) skillBtn.addEventListener("click", () => partialDelete("skill", "skill.md 檔案"));
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
         <button class="save-wiki-btn" title="將此問答整合進 LLM Wiki">📖 存入 Wiki</button>
         <button class="save-source-btn">💾 存為來源</button>
         <button class="copy-btn">📋 複製</button>
       </div>` : "";
  const expandBtnHtml = m.role === "assistant"
    ? `<button class="msg-expand-btn" title="放大檢視">⛶</button>` : "";
  const contentHtml = m.role === "assistant"
    ? `<div class="content markdown-body">${renderMarkdown(m.content)}</div>`
    : `<div class="content">${escapeHtml(m.content)}</div>`;
  div.innerHTML = `
    <div class="msg-header">
      <div class="role">${roleText}</div>
      ${expandBtnHtml}
    </div>
    ${contentHtml}
    ${metaHtml}
    ${actionsHtml}`;
  if (m.role === "assistant") {
    const content = m.content;
    div.querySelector(".save-source-btn").addEventListener("click", () => saveAsSource(content));
    div.querySelector(".save-wiki-btn").addEventListener("click", (e) => saveToWiki(div, content, e.currentTarget));
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

async function saveToWiki(msgDiv, answer, btn) {
  // Walk back through siblings to find the most recent user message.
  let prev = msgDiv.previousElementSibling;
  while (prev && !prev.classList.contains("user")) {
    prev = prev.previousElementSibling;
  }
  if (!prev) { alert("找不到對應的問題"); return; }
  const question = prev.querySelector(".content")?.textContent || "";
  if (!question.trim()) { alert("找不到對應的問題"); return; }
  if (!confirm("將這段問答整合進 LLM Wiki？\n（會花費數次 LLM 呼叫，視 wiki 規模而定）")) return;
  const orig = btn.textContent;
  btn.textContent = "整合中…";
  btn.disabled = true;
  try {
    const r = await api("/wiki/ingest/qa", {
      method: "POST",
      body: { question, answer },
    });
    const ops = r.operations || [];
    const summary = ops.length
      ? ops.map((o) => `${o.action} ${o.path}`).join(", ")
      : "(無操作)";
    btn.textContent = `✓ ${ops.length} 個操作`;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
    loadSources(); // refresh wiki info banner
    console.log("[wiki ingest]", summary);
  } catch (e) {
    btn.textContent = orig;
    btn.disabled = false;
    alert("Wiki 整合失敗：" + e.message);
  }
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
    ul.innerHTML = '<li style="color:#999;">raw_data/ 目錄中沒有 PDF 檔案。</li>';
    return;
  }
  state.pdfs.forEach((p) => {
    const li = document.createElement("li");
    li.className = "pdf-item";
    const derived = Array.isArray(p.derived_sources) ? p.derived_sources : [];
    // Dim a button when this PDF already produced that type of source —
    // re-running the same conversion is rarely what the user wants.
    const hasSkill = derived.some((d) => !d.missing && (d.types || []).includes("skill"));
    const hasEmb = derived.some((d) => !d.missing && (d.types || []).includes("embedding"));
    const skillCls = hasSkill ? "dim" : "";
    const embCls = hasEmb ? "dim" : "";
    const derivedRows = derived.map((d) => {
      const types = d.types || [];
      const badges = d.missing
        ? `<span class="d-badge missing">missing</span>`
        : types.map((t) =>
            t === "skill"
              ? `<span class="d-badge skill">skill</span>`
              : `<span class="d-badge emb">emb</span>`
          ).join("");
      const meta = d.missing
        ? ""
        : types.includes("skill")
        ? `<span class="d-meta">${d.chapter_count || 0} 章</span>`
        : `<span class="d-meta">${d.chunk_count || 0} 片段</span>`;
      return `
        <div class="derived-row">
          ${badges}
          <span class="d-name">${escapeHtml(d.name || d.slug)}</span>
          ${meta}
          <button class="d-delete" data-slug="${escapeHtml(d.slug)}" title="刪除此來源">🗑 刪除</button>
        </div>`;
    }).join("");

    li.innerHTML = `
      <div class="pdf-row">
        <div class="pdf-meta">
          <strong>${escapeHtml(p.name)}</strong><br>
          <small>${p.size_mb} MB</small>
        </div>
        <div class="pdf-btns">
          <button data-action="skill" class="${skillCls}" title="用 LLM 重寫為結構化 skill.md（慢，品質高）">skill.md${hasSkill ? " ↻" : ""}</button>
          <button data-action="embed" class="${embCls}" title="直接向量化（快，保留原文）">Embedding${hasEmb ? " ↻" : ""}</button>
        </div>
      </div>
      ${derived.length ? `<div class="derived-list">${derivedRows}</div>` : ""}
    `;

    const runConvert = async (btnClicked, endpoint, errLabel) => {
      const btns = li.querySelectorAll(".pdf-btns button");
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
        // Await both refreshes so the spinner stays visible until the UI
        // is fully updated; loadPDFs re-creates fresh DOM buttons (no
        // need to manually re-enable the old references).
        await Promise.all([loadJobs(), loadPDFs()]);
      }
    };
    const skillBtn = li.querySelector("[data-action=skill]");
    const embedBtn = li.querySelector("[data-action=embed]");
    skillBtn.addEventListener("click", () => runConvert(skillBtn, "/jobs", "建立任務失敗"));
    embedBtn.addEventListener("click", () => runConvert(embedBtn, "/pdfs/embed", "建立 Embedding 任務失敗"));

    // Per-derived-source delete.
    li.querySelectorAll(".d-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const slug = btn.dataset.slug;
        // Block deletion if a job for this slug is still active —
        // otherwise we'd race the worker writing chapter files.
        const blocking = (state.jobs || []).find(
          (j) => j.skill_slug === slug && (j.status === "running" || j.status === "pending")
        );
        if (blocking) {
          alert(`此來源仍有「${blocking.status}」的轉換任務,請先暫停或等任務完成。`);
          return;
        }
        if (!confirm(`刪除來源「${slug}」?\n會一併移除已產生的檔案、向量、主題歸屬。`)) return;
        const orig = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<span class="spinner"></span> 刪除中…`;
        try {
          await api(`/sources/${encodeURIComponent(slug)}`, { method: "DELETE" });
          await loadPDFs();
          await loadSources();
        } catch (e) {
          alert("刪除失敗：" + e.message);
          btn.disabled = false;
          btn.innerHTML = orig;
        }
      });
    });

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
// Signature of last seen jobs state, used to decide whether the PDF list
// (which shows derived sources per PDF) needs to be refreshed too.
let _lastJobsSig = "";
function _jobsSignature(jobs) {
  // id + status + completed_chapters captures "something visible to the user changed"
  return jobs.map((j) => `${j.id}:${j.status}:${j.completed_chapters}`).join("|");
}

async function loadJobs() {
  state.jobs = await api("/jobs");
  const sig = _jobsSignature(state.jobs);
  if (sig !== _lastJobsSig) {
    const wasInitialised = _lastJobsSig !== "";
    _lastJobsSig = sig;
    // Skip the very first call (loadPDFs is already called alongside it on tab open).
    // After that, any change in job state may have produced/removed a derived source,
    // so refresh the left panel too.
    if (wasInitialised) loadPDFs();
  }
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

// Clear all completed job log rows (does not touch produced sources).
$("#clear-done-jobs").addEventListener("click", async () => {
  const doneCount = state.jobs.filter((j) => j.status === "done").length;
  if (doneCount === 0) {
    alert("目前沒有已完成的任務紀錄。");
    return;
  }
  if (!confirm(`清除 ${doneCount} 筆已完成的任務紀錄？\n\n此操作只移除紀錄，不會刪除已產生的來源。`)) return;
  const btn = $("#clear-done-jobs");
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 清除中…`;
  try {
    const r = await api("/jobs/done", { method: "DELETE" });
    await loadJobs();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
});

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
  // Wiki block
  const wcfg = state.config.wiki || {};
  $$("[data-w]").forEach((input) => {
    input.value = wcfg[input.dataset.w] ?? "";
  });
}
$("#save-settings").addEventListener("click", async () => {
  const payload = { active_provider: $("#active-provider").value, providers: {}, wiki: {} };
  ["claude", "gemini", "grok", "ollama", "openai"].forEach((name) => {
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
  $$("[data-w]").forEach((input) => {
    payload.wiki[input.dataset.w] = input.value;
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
