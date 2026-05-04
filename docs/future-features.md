# 未來實作功能

This file tracks features that are designed but not yet implemented.
Tasks here are roughly ordered by recommended execution sequence.
Mark items as done by moving them to a "Done" section at the bottom (with date).

---

## Phase 2 LLM Wiki — 自動修復後續

### 4. Duplicate diff 預覽 + 套用

**目標**：lint 找到的 duplicate 由 LLM 提合併計畫，使用者看 diff 後決定。

**流程**
1. lint 結果頁的 duplicate 列加「🛠 LLM 修」按鈕
2. Backend `POST /api/wiki/repair/plan` body `{issue, mode: "plan-only"}`
   - LLM 判斷 primary / secondary
   - 產生 actions：`[{path, after: "<合併後內容>"}, {path: secondary, after: "→ 詳見 [primary](primary.md)"}]`
   - 回傳 plan_id（cache 5 分鐘）
3. Frontend modal 分兩欄 diff 預覽（jsdiff 或自手刻 line-diff，紅綠標示）
4. 三顆按鈕：
   - ✅ 套用 → `POST /api/wiki/repair/apply` body `{plan_id}`
   - 🔄 重新生成 → 回 plan-only 但帶 hint
   - ❌ 取消
5. apply 寫入前先把舊內容快照寫進 log.md，可手動還原
6. **進階**：✏️ 編輯後套用（textarea 編輯 proposed content）

**安全度**：中低。內容合併有失真風險，**強制 plan-only diff 預覽**。  
**估時**：~半天（diff UI 是大工程）

---

## 其他想法

### LLM lint 的 smart sampling（目前是暫時解法）

**現狀**：`wiki.llm_lint()` 把全部頁面 dump 進 prompt，超過 `LINT_PAGES_DUMP_BUDGET`（50k chars）後直接截斷，回 `truncated: True`。Prompt 註解（`prompts/lint.md` 開頭）寫了「會 sample 一個 subset」，但實作只是 first-N 截斷，**沒做真正的 sampling**。

**問題**
- 大 wiki（超過 50k）時被截掉的頁可能是最該被 lint 的
- LLM 看到「treat omitted as out-of-scope」但 deterministic 規則的 orphan / missing_required_section 仍然要靠完整 page list 判斷
- 截斷恰好停在某頁中間時 LLM 容易誤判

**正解（待實作）**
1. **優先採樣**這些頁（一定要進 dump）：
   - `index.md` 全部
   - `deterministic_lint()` 已標出 issue 的頁（含 orphan / missing_*）
   - 最近 N 次 ingest 寫過的頁（讀 log.md tail）
2. **次要採樣**剩餘預算內隨機抽樣其他頁
3. Prompt 顯式告知哪些頁是「重點檢查」、哪些只是 context
4. 估算 token 數而非 char 數（不同 provider 比例不同）
5. 拆成多個 LLM 呼叫並合併結果（每批一個 type 子目錄？）

**安全度**：高。不影響功能。  
**估時**：~半天（要寫 sampling 策略 + 測幾個邊界情況）

### Wiki 顯示 slug → display name 查表

當前 Sources 區塊存純 slug（如 `jed-mckenna-notebook §06`）。可加 render 層：
- 渲染 wiki page 時，比對 slug 與 `list_sources()` 結果
- 如果 slug 在現有 sources 中，顯示 `現顯示名 (slug) §06`
- 如果不在（已刪），保持原樣或加 ⚠

優先序低，現在純 slug 已堪用。

### LLM Wiki Web Search 補完

lint.md 提到 "data gaps that could be filled with a web search" — 將來可加：
- Lint 找出明顯資訊不足的頁
- 提供「🌐 用 web search 補完」選項
- 用 Claude/Gemini 的 web search tool（Grok 也支援）查資料 → 走 ingest 管道補進該頁

需要先決定：用哪個 provider 的 web search、是否所有 provider 都支援。

### PDF OCR fallback

`pdf_utils.py` 對掃描版 PDF 抽不到文字（會做出空 chunks 的 embedding job）。可加：
- 抽取後若全文 < 50 字，警告並 fail job
- 提供 OCR 路徑（如 pytesseract / mistral OCR API）作為選用

### Recent activity tab

`log.md` 現在只能整檔讀。可加：
- Frontend 在 wiki 檢視 modal 多一個「📋 最近活動」分頁
- 後端 `GET /api/wiki/log/recent?limit=20` 回傳最後 N 行
- UI 讓使用者快速看「最近做了什麼 ingest / lint / repair」

### Source-to-Wiki ingest

當前只有「Q&A → wiki」。原 Phase 2 還有：
- 從現有 source（skill.md / embedding）直接 ingest 進 wiki
- UI：source 的 ⋮ 菜單加「📖 灌入 Wiki」
- Backend 跑一輪 chunked ingest（避免一次塞太多進 LLM）

優先序中，等使用者實際需要時再做。

---

## Done

- **2026-05-03 — Step 1: Sources 純文字化**
  - `wiki.migrate_sources_to_plaintext()` + `POST /api/wiki/migrate/sources-plaintext`
  - `ingest-apply-create.md` / `ingest-apply-update.md` prompts 改為要求純文字 Sources
  - 前端 wiki 檢視 modal 加 🧹 按鈕觸發 migration
- **2026-05-04 — Step 3: Contradiction 開新對話討論（精簡版）**
  - `wiki.build_contradiction_seed(wiki_dir, issue)` — 純文字組裝 seed message（無 LLM 呼叫）
  - `POST /api/wiki/repair/discuss` body `{issue}` → `{conversation_id, topic_id, title, seed_message, pages}`
  - 前端 lint 結果 contradiction 列加 💬 與 AI 討論按鈕（青色 `.lint-discuss-btn`）
  - 流程：建立新 conversation（預設主題） → 自動切到 chat 分頁 → 勾選 wiki → 預填 seed_message 進輸入框 → 使用者按送出（走原本 `/chat`，wiki 兩段式檢索負責真正載入兩頁全文）
  - 精簡版 = 不在後端塞 system prompt 也不額外呼叫 LLM；使用者多輪討論完就用既有 📖 存入 Wiki
  - 進階版（結論動作面板）留給未來
- **2026-05-03 — Step 2: Orphan 自動修復**
  - 新 prompt `repair-orphan-pick-partners.md`
  - `wiki.repair_orphan(orphan_path, cfg)` + `POST /api/wiki/repair/orphan`
  - 前端 lint 結果 orphan 列加 🛠 LLM 修按鈕（紫色 `.lint-repair-btn`）
  - 流程：LLM 挑 1-2 partner → 對 orphan 與每個 partner 跑 ingest-apply-update 加交叉引用 → log.md 記 `repair orphan A ↔ [B, C]`
