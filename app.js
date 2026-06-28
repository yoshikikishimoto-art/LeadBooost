/* =========================================================
   TalentFlow — 人材紹介 進捗管理（バニラJS / localStorage）
   求職者の情報管理と 紹介→承諾→入社 の一連フローを管理する。
   ========================================================= */

/* ---------- ステージ定義（パイプラインの単一ソース） ---------- */
const STAGES = [
  { key: "booked",   label: "予約",           color: "var(--stage-booked)"   },
  { key: "seated",   label: "着座",           color: "var(--stage-seated)"   },
  { key: "meeting",  label: "初回面談",        color: "var(--stage-meeting)"  },
  { key: "proposal", label: "企業提案",        color: "var(--stage-proposal)" },
  { key: "screen",   label: "選考",           color: "var(--stage-screen)"   },
  { key: "offer",    label: "内定",           color: "var(--stage-offer)"    },
  { key: "accept",   label: "内定承諾",        color: "var(--stage-accept)"   },
  { key: "join",     label: "入社",           color: "var(--stage-join)"     },
  { key: "refund",   label: "返金規定クリア",   color: "var(--stage-refund)"   },
];
const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.key, s]));
const CLOSED = { key: "closed", label: "終了（辞退・見送り）", color: "var(--stage-closed)" };

/* ---------- 流入経路（リード獲得チャネルの単一ソース） ---------- */
const SOURCES = [
  { key: "timerex",  label: "TimeRex予約",        color: "var(--source-timerex)"  },
  { key: "referral", label: "リファラル（LINE）",  color: "var(--source-referral)" },
];
const SOURCE_MAP = Object.fromEntries(SOURCES.map((s) => [s.key, s]));
function sourceOf(c) { return SOURCE_MAP[c.source] || null; }

/* ---------- ストレージ ---------- */
const DB_KEY = "talentflow.db.v2";

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { console.warn("DB load failed", e); }
  return null;
}
function saveDB() { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

let db = loadDB() || seedData();

/* ---------- ユーティリティ ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const uid = () => "id-" + Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const initials = (name) => (name || "?").trim().slice(0, 2);
function fmtDate(d) { if (!d) return "—"; const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}`; }
function daysSince(d) { if (!d) return 0; return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }
function advisorName(id) { const a = db.advisors.find((x) => x.id === id); return a ? a.name : "未割当"; }
function stageOf(c) { return c.stage === "closed" ? CLOSED : (STAGE_MAP[c.stage] || STAGES[0]); }

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

function logActivity(c, text, type = "note") {
  c.activities = c.activities || [];
  c.activities.unshift({ id: uid(), date: today(), type, text });
  c.updatedAt = today();
}

/* ---------- 状態 ---------- */
let currentView = "dashboard";
let filters = { q: "", stage: "", source: "", advisor: "" };

/* =========================================================
   ルーティング / レンダリング
   ========================================================= */
const VIEW_META = {
  dashboard:  { title: "ダッシュボード", sub: "流入から入社・返金規定クリアまでの進捗を一目で確認" },
  pipeline:   { title: "パイプライン",  sub: "ドラッグで 予約→着座→…→入社 のステージを移動" },
  candidates: { title: "求職者一覧",    sub: "登録された求職者を検索・絞り込み" },
  advisors:   { title: "アドバイザー",  sub: "キャリアアドバイザーと担当状況" },
};

function render() {
  $("#pageTitle").textContent = VIEW_META[currentView].title;
  $("#pageSub").textContent = VIEW_META[currentView].sub;
  $$("#nav .nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === currentView));
  const view = $("#view");
  if (currentView === "dashboard") view.innerHTML = renderDashboard();
  else if (currentView === "pipeline") { view.innerHTML = renderPipeline(); bindBoard(); }
  else if (currentView === "candidates") { view.innerHTML = renderCandidates(); bindCandidates(); }
  else if (currentView === "advisors") view.innerHTML = renderAdvisors();
}

/* ---------------------- ダッシュボード ---------------------- */
function renderDashboard() {
  const cs = db.candidates;
  const active = cs.filter((c) => c.stage !== "closed");
  const counts = Object.fromEntries(STAGES.map((s) => [s.key, cs.filter((c) => c.stage === s.key).length]));
  const max = Math.max(1, ...STAGES.map((s) => counts[s.key]));

  const order = (st) => STAGES.findIndex((s) => s.key === st);
  const reached = (key) => active.filter((c) => order(c.stage) >= order(key)).length;
  const joinedThisMonth = cs.filter((c) => ["join", "refund"].includes(c.stage) && (c.joinedAt || "").slice(0, 7) === today().slice(0, 7)).length;
  const joinedTotal = counts.join + counts.refund;
  const seatRate = active.length ? Math.round((reached("seated") / active.length) * 100) : 0;
  const proposed = reached("proposal");
  const acceptRate = proposed ? Math.round((reached("accept") / proposed) * 100) : 0;

  const kpis = [
    { label: "稼働中の求職者", value: active.length, foot: `全 ${cs.length} 名（終了含む）` },
    { label: "着座率", value: `${seatRate}%`, foot: `着座以降 <strong class="pos">${reached("seated")}</strong> 名` },
    { label: "内定承諾", value: counts.accept, foot: `承諾率 <strong class="pos">${acceptRate}%</strong>（企業提案比）` },
    { label: "今月の入社", value: joinedThisMonth, foot: `入社累計 ${joinedTotal} 名` },
  ];

  // 流入経路の内訳
  const srcRows = SOURCES.map((s) => {
    const list = cs.filter((c) => c.source === s.key);
    const joined = list.filter((c) => ["join", "refund"].includes(c.stage)).length;
    return { ...s, total: list.length, joined };
  });
  const srcUnknown = cs.filter((c) => !c.source).length;
  const srcMax = Math.max(1, ...srcRows.map((r) => r.total), srcUnknown);

  const recent = cs
    .flatMap((c) => (c.activities || []).map((a) => ({ ...a, cand: c })))
    .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id))
    .slice(0, 8);

  return `
    <div class="kpi-grid">
      ${kpis.map((k) => `
        <div class="card kpi">
          <div class="kpi-label">${k.label}</div>
          <div class="kpi-value">${k.value}</div>
          <div class="kpi-foot">${k.foot}</div>
        </div>`).join("")}
    </div>
    <div class="dash-grid">
      <div class="card panel">
        <div class="panel-title">ステージ別ファネル</div>
        <div class="funnel">
          ${STAGES.map((s) => `
            <div class="funnel-row">
              <div class="funnel-name">${s.label}</div>
              <div class="funnel-bar"><div class="funnel-fill" style="width:${(counts[s.key] / max) * 100}%;background:${s.color}"></div></div>
              <div class="funnel-count">${counts[s.key]}</div>
            </div>`).join("")}
        </div>
      </div>
      <div class="card panel">
        <div class="panel-title">流入経路の内訳</div>
        <div class="funnel">
          ${srcRows.map((r) => `
            <div class="funnel-row">
              <div class="funnel-name">${r.label}</div>
              <div class="funnel-bar"><div class="funnel-fill" style="width:${(r.total / srcMax) * 100}%;background:${r.color}"></div></div>
              <div class="funnel-count">${r.total}</div>
            </div>`).join("")}
          ${srcUnknown ? `
            <div class="funnel-row">
              <div class="funnel-name muted">未設定</div>
              <div class="funnel-bar"><div class="funnel-fill" style="width:${(srcUnknown / srcMax) * 100}%;background:var(--stage-closed)"></div></div>
              <div class="funnel-count">${srcUnknown}</div>
            </div>` : ""}
        </div>
        <div class="src-note">入社：${srcRows.map((r) => `${r.label} ${r.joined}名`).join(" ／ ")}</div>
      </div>
    </div>
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="panel-title">最近の動き</div>
      <div class="activity-list">
        ${recent.length ? recent.map((a) => `
          <div class="activity">
            <div class="activity-ico">${activityIcon(a.type)}</div>
            <div>
              <div class="activity-body"><strong>${esc(a.cand.name)}</strong> ${esc(a.text)}</div>
              <div class="activity-meta">${fmtDate(a.date)}・${esc(advisorName(a.cand.advisorId))}</div>
            </div>
          </div>`).join("") : `<div class="empty">まだ活動がありません</div>`}
      </div>
    </div>`;
}
function activityIcon(type) { return { stage: "↗", note: "✎", create: "＋" }[type] || "•"; }

/* ---------------------- パイプライン（カンバン） ---------------------- */
function renderPipeline() {
  const cs = db.candidates.filter((c) => c.stage !== "closed");
  const cols = STAGES.map((s) => {
    const items = cs.filter((c) => c.stage === s.key);
    return `
      <div class="column" data-stage="${s.key}">
        <div class="column-head">
          <div class="stage-name"><span class="dot" style="background:${s.color}"></span>${s.label}</div>
          <span class="column-count">${items.length}</span>
        </div>
        <div class="column-body" data-stage="${s.key}">
          ${items.map(kcard).join("")}
        </div>
      </div>`;
  }).join("");
  return `<div class="board">${cols}</div>`;
}
function kcard(c) {
  return `
    <div class="kcard" draggable="true" data-id="${c.id}">
      <div class="kcard-top">
        <span class="kcard-name">${esc(c.name)}</span>
      </div>
      <div class="kcard-line">${esc(c.company || "紹介先未定")}${c.position ? "・" + esc(c.position) : ""}</div>
      <div class="kcard-foot">
        <span class="avatar" title="${esc(advisorName(c.advisorId))}">${esc(initials(advisorName(c.advisorId)))}</span>
        <span class="kcard-days">${daysSince(c.updatedAt)}日経過</span>
      </div>
    </div>`;
}

function bindBoard() {
  let dragId = null;
  $$(".kcard").forEach((card) => {
    card.addEventListener("dragstart", () => { dragId = card.dataset.id; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", () => openDetail(card.dataset.id));
  });
  $$(".column").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault(); col.classList.remove("drag-over");
      const c = db.candidates.find((x) => x.id === dragId);
      const newStage = col.dataset.stage;
      if (c && newStage && c.stage !== newStage) {
        moveStage(c, newStage);
        render();
      }
    });
  });
}

function moveStage(c, newStage) {
  const from = stageOf(c).label;
  c.stage = newStage;
  if (newStage === "join") c.joinedAt = today();
  logActivity(c, `ステージを「${from}」→「${STAGE_MAP[newStage]?.label || CLOSED.label}」に変更`, "stage");
  saveDB();
  toast(`${c.name} を「${STAGE_MAP[newStage]?.label || CLOSED.label}」へ移動`);
}

/* ---------------------- 求職者一覧 ---------------------- */
function renderCandidates() {
  const list = filteredCandidates();
  const opt = (val, label, sel) => `<option value="${val}" ${sel ? "selected" : ""}>${label}</option>`;
  return `
    <div class="filter-row">
      <div class="search"><input class="input" id="fq" placeholder="名前・企業・スキルで検索" value="${esc(filters.q)}" /></div>
      <div class="select-wrap">
        <select class="select" id="fstage">
          ${opt("", "すべてのステージ", !filters.stage)}
          ${STAGES.map((s) => opt(s.key, s.label, filters.stage === s.key)).join("")}
          ${opt("closed", "終了", filters.stage === "closed")}
        </select>
      </div>
      <div class="select-wrap">
        <select class="select" id="fsource">
          ${opt("", "すべての流入経路", !filters.source)}
          ${SOURCES.map((s) => opt(s.key, s.label, filters.source === s.key)).join("")}
        </select>
      </div>
      <div class="select-wrap">
        <select class="select" id="fadvisor">
          ${opt("", "すべての担当", !filters.advisor)}
          ${db.advisors.map((a) => opt(a.id, a.name, filters.advisor === a.id)).join("")}
        </select>
      </div>
      <span class="muted" style="margin-left:auto">${list.length} 名</span>
    </div>
    <div class="card table-wrap">
      <table class="tbl">
        <thead><tr>
          <th>氏名</th><th>ステージ</th><th>流入</th><th>紹介先 / 希望職種</th><th>担当</th><th>更新</th>
        </tr></thead>
        <tbody>
          ${list.length ? list.map(rowCandidate).join("") : `<tr><td colspan="6"><div class="empty">該当する求職者がいません</div></td></tr>`}
        </tbody>
      </table>
    </div>`;
}
function rowCandidate(c) {
  const s = stageOf(c);
  const src = sourceOf(c);
  return `
    <tr data-id="${c.id}">
      <td><div class="cell-name">
        <span class="avatar">${esc(initials(c.name))}</span>
        <div><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.kana || "")}</div></div>
      </div></td>
      <td><span class="badge" data-stage="${s.key}"><span class="dot"></span>${s.label}</span></td>
      <td>${src ? `<span class="src-badge" data-source="${src.key}">${src.label}</span>` : `<span class="muted">—</span>`}</td>
      <td>${esc(c.company || "—")}<div class="sub muted" style="font-size:12px">${esc(c.desiredJob || "")}</div></td>
      <td>${esc(advisorName(c.advisorId))}</td>
      <td class="muted">${fmtDate(c.updatedAt)}</td>
    </tr>`;
}
function filteredCandidates() {
  const q = filters.q.trim().toLowerCase();
  return db.candidates.filter((c) => {
    if (filters.stage && c.stage !== filters.stage) return false;
    if (filters.source && c.source !== filters.source) return false;
    if (filters.advisor && c.advisorId !== filters.advisor) return false;
    if (q) {
      const hay = [c.name, c.kana, c.company, c.desiredJob, (c.skills || []).join(" ")].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
function bindCandidates() {
  $("#fq").addEventListener("input", (e) => { filters.q = e.target.value; refreshTableOnly(); });
  $("#fstage").addEventListener("change", (e) => { filters.stage = e.target.value; render(); });
  $("#fsource").addEventListener("change", (e) => { filters.source = e.target.value; render(); });
  $("#fadvisor").addEventListener("change", (e) => { filters.advisor = e.target.value; render(); });
  $$(".tbl tbody tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
}
function refreshTableOnly() {
  const list = filteredCandidates();
  const tbody = $(".tbl tbody");
  if (!tbody) return render();
  tbody.innerHTML = list.length ? list.map(rowCandidate).join("") : `<tr><td colspan="6"><div class="empty">該当する求職者がいません</div></td></tr>`;
  $(".filter-row .muted").textContent = `${list.length} 名`;
  $$(".tbl tbody tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
}

/* ---------------------- アドバイザー ---------------------- */
function renderAdvisors() {
  return `
    <div class="filter-row">
      <button class="btn btn-outline btn-sm" id="addAdvisorBtn">＋ アドバイザーを追加</button>
    </div>
    <div class="advisor-grid">
      ${db.advisors.map((a) => {
        const load = db.candidates.filter((c) => c.advisorId === a.id && c.stage !== "closed").length;
        const joined = db.candidates.filter((c) => c.advisorId === a.id && c.stage === "join").length;
        return `
          <div class="card advisor-card">
            <span class="avatar">${esc(initials(a.name))}</span>
            <div>
              <div class="advisor-name">${esc(a.name)}</div>
              <div class="advisor-stat">担当 ${load} 名 ・ 入社実績 ${joined} 名</div>
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

/* =========================================================
   モーダル：求職者の追加・詳細・編集
   ========================================================= */
function openModal(html) { $("#modal").innerHTML = html; $("#modalBackdrop").hidden = false; }
function closeModal() { $("#modalBackdrop").hidden = true; $("#modal").innerHTML = ""; }

function openCandidateForm(c) {
  const isNew = !c;
  c = c || {};
  const advOpts = db.advisors.map((a) => `<option value="${a.id}" ${c.advisorId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const stageOpts = [...STAGES, CLOSED].map((s) => `<option value="${s.key}" ${(c.stage || "booked") === s.key ? "selected" : ""}>${s.label}</option>`).join("");
  const sourceOpts = SOURCES.map((s) => `<option value="${s.key}" ${c.source === s.key ? "selected" : ""}>${s.label}</option>`).join("");
  openModal(`
    <div class="modal-head">
      <div><div class="modal-title">${isNew ? "求職者を追加" : "求職者を編集"}</div></div>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">
      <div class="section-label">基本情報</div>
      <div class="form-grid">
        <div class="field"><label class="field-label">氏名 *</label><input class="input" id="f_name" value="${esc(c.name || "")}" /></div>
        <div class="field"><label class="field-label">フリガナ</label><input class="input" id="f_kana" value="${esc(c.kana || "")}" /></div>
        <div class="field"><label class="field-label">メール</label><input class="input" id="f_email" value="${esc(c.email || "")}" /></div>
        <div class="field"><label class="field-label">電話</label><input class="input" id="f_phone" value="${esc(c.phone || "")}" /></div>
      </div>
      <div class="section-label">希望・スキル</div>
      <div class="form-grid">
        <div class="field"><label class="field-label">現職 / 経歴</label><input class="input" id="f_current" value="${esc(c.currentJob || "")}" /></div>
        <div class="field"><label class="field-label">希望職種</label><input class="input" id="f_desired" value="${esc(c.desiredJob || "")}" /></div>
        <div class="field"><label class="field-label">希望年収</label><input class="input" id="f_salary" value="${esc(c.desiredSalary || "")}" placeholder="例：600万円" /></div>
        <div class="field"><label class="field-label">スキル（カンマ区切り）</label><input class="input" id="f_skills" value="${esc((c.skills || []).join(", "))}" placeholder="例：React, TypeScript" /></div>
      </div>
      <div class="section-label">流入・進捗</div>
      <div class="form-grid">
        <div class="field"><label class="field-label">流入経路</label>
          <div class="select-wrap"><select class="select" id="f_source"><option value="">未設定</option>${sourceOpts}</select></div>
        </div>
        <div class="field"><label class="field-label">ステージ</label>
          <div class="select-wrap"><select class="select" id="f_stage">${stageOpts}</select></div>
        </div>
        <div class="field"><label class="field-label">紹介先企業</label><input class="input" id="f_company" value="${esc(c.company || "")}" /></div>
        <div class="field"><label class="field-label">ポジション</label><input class="input" id="f_position" value="${esc(c.position || "")}" /></div>
        <div class="field"><label class="field-label">担当アドバイザー</label>
          <div class="select-wrap"><select class="select" id="f_advisor"><option value="">未割当</option>${advOpts}</select></div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <div>${!isNew ? `<button class="btn btn-danger btn-sm" onclick="deleteCandidate('${c.id}')">削除</button>` : ""}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary" onclick="saveCandidate('${c.id || ""}')">${isNew ? "追加する" : "保存する"}</button>
      </div>
    </div>`);
  setTimeout(() => $("#f_name")?.focus(), 50);
}

function saveCandidate(id) {
  const name = $("#f_name").value.trim();
  if (!name) { toast("氏名を入力してください"); $("#f_name").focus(); return; }
  const data = {
    name,
    kana: $("#f_kana").value.trim(),
    email: $("#f_email").value.trim(),
    phone: $("#f_phone").value.trim(),
    currentJob: $("#f_current").value.trim(),
    desiredJob: $("#f_desired").value.trim(),
    desiredSalary: $("#f_salary").value.trim(),
    skills: $("#f_skills").value.split(",").map((s) => s.trim()).filter(Boolean),
    company: $("#f_company").value.trim(),
    position: $("#f_position").value.trim(),
    advisorId: $("#f_advisor").value,
    source: $("#f_source").value,
    stage: $("#f_stage").value,
  };
  if (id) {
    const c = db.candidates.find((x) => x.id === id);
    const stageChanged = c.stage !== data.stage;
    const prev = stageOf(c).label;
    Object.assign(c, data);
    c.updatedAt = today();
    if (stageChanged) {
      if (data.stage === "join") c.joinedAt = today();
      logActivity(c, `ステージを「${prev}」→「${stageOf(c).label}」に変更`, "stage");
    }
    toast("保存しました");
  } else {
    const c = { id: uid(), ...data, createdAt: today(), updatedAt: today(), activities: [] };
    logActivity(c, "求職者を登録", "create");
    db.candidates.unshift(c);
    toast(`${name} を登録しました`);
  }
  saveDB(); closeModal(); render();
}

function deleteCandidate(id) {
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`${c.name} を削除しますか？この操作は取り消せません。`)) return;
  db.candidates = db.candidates.filter((x) => x.id !== id);
  saveDB(); closeModal(); render(); toast("削除しました");
}

function openDetail(id) {
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return;
  const s = stageOf(c);
  const curIdx = STAGES.findIndex((x) => x.key === c.stage);
  const stepper = STAGES.map((st, i) => {
    const cls = c.stage === "closed" ? "" : i < curIdx ? "done" : i === curIdx ? "current" : "";
    return `<div class="step ${cls}"><div class="step-bar"></div><div class="step-label">${st.label}</div></div>`;
  }).join("");
  const row = (label, val) => val ? `<div class="field"><label class="field-label">${label}</label><div>${esc(val)}</div></div>` : "";
  const skills = (c.skills || []).length ? `<div class="field full"><label class="field-label">スキル</label><div>${c.skills.map((s) => `<span class="badge" data-stage="meeting" style="margin:2px 4px 2px 0">${esc(s)}</span>`).join("")}</div></div>` : "";

  openModal(`
    <div class="modal-head">
      <div class="detail-head">
        <span class="avatar">${esc(initials(c.name))}</span>
        <div>
          <div class="detail-name">${esc(c.name)} <span class="badge" data-stage="${s.key}" style="margin-left:6px"><span class="dot"></span>${s.label}</span></div>
          <div class="detail-meta">${esc(c.kana || "")}　担当：${esc(advisorName(c.advisorId))}</div>
        </div>
      </div>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">
      <div class="stepper">${stepper}</div>

      <div class="section-label">進捗を進める</div>
      <div class="filter-row" style="margin-bottom:8px">
        ${nextStageButtons(c)}
      </div>

      <div class="section-label">求職者情報</div>
      <div class="form-grid">
        ${row("流入経路", sourceOf(c)?.label)}
        ${row("メール", c.email)}
        ${row("電話", c.phone)}
        ${row("現職 / 経歴", c.currentJob)}
        ${row("希望職種", c.desiredJob)}
        ${row("希望年収", c.desiredSalary)}
        ${row("紹介先企業", c.company)}
        ${row("ポジション", c.position)}
        ${skills}
      </div>

      <div class="section-label">活動履歴 / アドバイザー連携メモ</div>
      <div class="add-note">
        <input class="input" id="noteInput" placeholder="連絡内容や面談メモを記録…" />
        <button class="btn btn-outline" onclick="addNote('${c.id}')">追加</button>
      </div>
      <div class="timeline" id="timeline">${renderTimeline(c)}</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-danger btn-sm" onclick="deleteCandidate('${c.id}')">削除</button>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline" onclick="openCandidateForm(db.candidates.find(x=>x.id==='${c.id}'))">編集</button>
        <button class="btn btn-primary" onclick="closeModal()">閉じる</button>
      </div>
    </div>`);
  $("#noteInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") addNote(c.id); });
}

function nextStageButtons(c) {
  if (c.stage === "closed") return `<button class="btn btn-outline btn-sm" onclick="setStage('${c.id}','booked')">再開する</button>`;
  const idx = STAGES.findIndex((x) => x.key === c.stage);
  const btns = [];
  if (idx < STAGES.length - 1) {
    const next = STAGES[idx + 1];
    btns.push(`<button class="btn btn-primary btn-sm" onclick="setStage('${c.id}','${next.key}')">「${next.label}」へ進める →</button>`);
  }
  if (idx > 0) {
    const prev = STAGES[idx - 1];
    btns.push(`<button class="btn btn-outline btn-sm" onclick="setStage('${c.id}','${prev.key}')">← ${prev.label}へ戻す</button>`);
  }
  btns.push(`<button class="btn btn-outline btn-sm" onclick="setStage('${c.id}','closed')" style="margin-left:auto">辞退・見送り</button>`);
  return btns.join("");
}
function setStage(id, stage) {
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return;
  moveStage(c, stage);
  openDetail(id); // 詳細を再描画（ステッパー/履歴更新）
}

function renderTimeline(c) {
  const acts = c.activities || [];
  if (!acts.length) return `<div class="empty">まだ記録がありません</div>`;
  return acts.map((a) => `
    <div class="tl-item">
      <div class="tl-dot">${activityIcon(a.type)}</div>
      <div class="tl-body">${esc(a.text)}<div class="tl-meta">${fmtDate(a.date)}</div></div>
    </div>`).join("");
}
function addNote(id) {
  const input = $("#noteInput");
  const text = input.value.trim();
  if (!text) return;
  const c = db.candidates.find((x) => x.id === id);
  logActivity(c, text, "note");
  saveDB();
  input.value = "";
  $("#timeline").innerHTML = renderTimeline(c);
  toast("メモを追加しました");
}

/* アドバイザー追加 */
function openAdvisorForm() {
  openModal(`
    <div class="modal-head"><div class="modal-title">アドバイザーを追加</div><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="field full"><label class="field-label">氏名 *</label><input class="input" id="a_name" /></div>
        <div class="field full"><label class="field-label">メール</label><input class="input" id="a_email" /></div>
      </div>
    </div>
    <div class="modal-foot"><span></span><div style="display:flex;gap:8px">
      <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary" onclick="saveAdvisor()">追加する</button>
    </div></div>`);
  setTimeout(() => $("#a_name")?.focus(), 50);
}
function saveAdvisor() {
  const name = $("#a_name").value.trim();
  if (!name) { toast("氏名を入力してください"); return; }
  db.advisors.push({ id: uid(), name, email: $("#a_email").value.trim() });
  saveDB(); closeModal(); render(); toast(`${name} を追加しました`);
}

/* =========================================================
   TimeRex連携：GoogleスプレッドシートのCSVから予約を取り込む
   （TimeRex →(Webhook/Zapier)→ シート保存 を前提に、本アプリは公開CSVを読むだけ）
   ========================================================= */
const SYNC_URL_KEY = "talentflow.syncUrl";

// 列名の揺れを吸収（シート側のヘッダーが多少違っても拾う）
const SYNC_COLS = {
  name:  ["氏名", "名前", "お名前", "name", "Name"],
  email: ["メール", "メールアドレス", "Email", "email", "mail", "E-mail"],
  phone: ["電話", "電話番号", "TEL", "tel", "phone"],
  date:  ["予約日時", "日時", "開始日時", "予定日時", "面談日時", "予約日", "datetime", "start"],
  extId: ["予約ID", "予約番号", "イベントID", "ID", "id", "event_id"],
  note:  ["メモ", "備考", "コメント", "note"],
};

// 最小CSVパーサ（ダブルクォート/改行/カンマ対応）
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') { inQ = true; }
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") { field += ch; }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => (c || "").trim() !== ""))
    .map((r) => { const o = {}; headers.forEach((h, i) => (o[h] = (r[i] || "").trim())); return o; });
}
function colVal(obj, field) {
  for (const a of (SYNC_COLS[field] || [])) if (a in obj && obj[a] !== "") return obj[a];
  return "";
}

async function runSync() {
  const url = localStorage.getItem(SYNC_URL_KEY);
  if (!url) return openSyncModal();
  const btn = $("#syncBtn"), label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "同期中…"; }
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const objs = rowsToObjects(parseCSV(await res.text()));
    let added = 0, skipped = 0;
    objs.forEach((o) => {
      const name = colVal(o, "name");
      const email = colVal(o, "email");
      const date = colVal(o, "date");
      if (!name && !email) return;
      const extId = colVal(o, "extId") || (email ? `${email}|${date}` : `${name}|${date}`);
      const dupe = db.candidates.find((c) =>
        (c.extId && c.extId === extId) ||
        (email && c.email === email && c.source === "timerex"));
      if (dupe) { skipped++; return; }
      const c = {
        id: uid(), name: name || email, kana: "", email, phone: colVal(o, "phone"),
        currentJob: "", desiredJob: "", desiredSalary: "", skills: [],
        company: "", position: "", advisorId: "",
        source: "timerex", stage: "booked", extId,
        createdAt: today(), updatedAt: today(), activities: [],
      };
      const note = colVal(o, "note");
      logActivity(c, `TimeRexで予約${date ? `（${date}）` : ""}${note ? `／${note}` : ""}`, "create");
      db.candidates.unshift(c);
      added++;
    });
    saveDB(); render();
    toast(`TimeRex同期：${added}件追加・${skipped}件スキップ`);
  } catch (e) {
    console.error("sync failed", e);
    toast("同期に失敗：URL/ウェブ公開設定/CORSをご確認ください");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || "⟳ TimeRex同期"; }
  }
}

function openSyncModal() {
  const cur = localStorage.getItem(SYNC_URL_KEY) || "";
  openModal(`
    <div class="modal-head">
      <div class="modal-title">TimeRex同期の設定</div>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0">TimeRexの予約をためている<strong>GoogleスプレッドシートのCSV URL</strong>を貼り付けて「保存して同期」を押すと、未登録の予約を<strong>「予約」ステージ・流入「TimeRex予約」</strong>で取り込みます（重複は自動スキップ）。</p>
      <div class="field full">
        <label class="field-label">CSV URL（ウェブに公開 → カンマ区切り(.csv)）</label>
        <input class="input" id="sync_url" value="${esc(cur)}" placeholder="https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=0" />
      </div>
      <div class="section-label">想定する列（ヘッダー名）</div>
      <p class="muted" style="font-size:12px">氏名 / メール / 予約日時（任意：電話・予約ID・メモ）。列名が多少違っても自動でマッチします。</p>
    </div>
    <div class="modal-foot">
      <span></span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary" onclick="saveSyncUrlAndRun()">保存して同期</button>
      </div>
    </div>`);
  setTimeout(() => $("#sync_url")?.focus(), 50);
}
function saveSyncUrlAndRun() {
  const url = $("#sync_url").value.trim();
  if (!url) { toast("CSV URLを入力してください"); return; }
  localStorage.setItem(SYNC_URL_KEY, url);
  closeModal();
  runSync();
}

/* =========================================================
   イベント配線
   ========================================================= */
$("#nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (!btn) return;
  currentView = btn.dataset.view;
  render();
});
$("#addCandidateBtn").addEventListener("click", () => openCandidateForm());
$("#syncBtn").addEventListener("click", () => runSync());
$("#syncCfgBtn")?.addEventListener("click", () => openSyncModal());
$("#view").addEventListener("click", (e) => {
  if (e.target.id === "addAdvisorBtn") openAdvisorForm();
});
$("#modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

$("#seedBtn").addEventListener("click", () => {
  if (confirm("サンプルデータを再投入します。現在のデータは置き換えられます。よろしいですか？")) {
    db = seedData(); saveDB(); render(); toast("サンプルデータを投入しました");
  }
});
$("#resetBtn").addEventListener("click", () => {
  if (confirm("全データを削除して空の状態にします。よろしいですか？")) {
    db = { advisors: [], candidates: [] }; saveDB(); render(); toast("データを初期化しました");
  }
});

// 関数をグローバル公開（onclick属性から呼ぶため）
Object.assign(window, { closeModal, openCandidateForm, saveCandidate, deleteCandidate, openDetail, setStage, addNote, saveAdvisor, openSyncModal, runSync, saveSyncUrlAndRun, db });

render();

/* =========================================================
   サンプルデータ
   ========================================================= */
function seedData() {
  const A = [
    { id: "adv1", name: "赤沼 太郎", email: "t.akanuma@example.com" },
    { id: "adv2", name: "岸本 義樹", email: "y.kishimoto@example.com" },
    { id: "adv3", name: "佐藤 美咲", email: "m.sato@example.com" },
  ];
  const mk = (o) => ({ email: "", phone: "", skills: [], source: "", activities: [], createdAt: "2026-06-01", ...o });
  const C = [
    mk({ id: "c1", name: "田中 健一", kana: "タナカ ケンイチ", advisorId: "adv1", source: "timerex", stage: "refund", company: "株式会社テックスター", position: "バックエンドエンジニア", currentJob: "SIerでJava開発5年", desiredJob: "Webサービス開発", desiredSalary: "650万円", skills: ["Java", "Spring", "AWS"], joinedAt: "2026-03-01", updatedAt: "2026-06-10",
      activities: [{ id: "a1", date: "2026-06-10", type: "stage", text: "ステージを「入社」→「返金規定クリア」に変更" }, { id: "a2", date: "2026-03-01", type: "note", text: "入社。3/1付け。受け入れ準備OK" }] }),
    mk({ id: "c2", name: "山本 さくら", kana: "ヤマモト サクラ", advisorId: "adv2", source: "referral", stage: "join", company: "グロースラボ株式会社", position: "フロントエンドエンジニア", currentJob: "受託開発3年", desiredJob: "自社プロダクト", desiredSalary: "550万円", skills: ["React", "TypeScript", "Next.js"], joinedAt: "2026-06-16", updatedAt: "2026-06-16",
      activities: [{ id: "a3", date: "2026-06-16", type: "stage", text: "ステージを「内定承諾」→「入社」に変更" }, { id: "a4", date: "2026-06-02", type: "note", text: "LINEグループで日程調整 → 入社日確定" }] }),
    mk({ id: "c3", name: "鈴木 大輔", kana: "スズキ ダイスケ", advisorId: "adv1", source: "timerex", stage: "accept", company: "株式会社ネクストワン", position: "PM候補", currentJob: "事業会社で企画", desiredJob: "プロダクトマネージャー", desiredSalary: "700万円", skills: ["要件定義", "スクラム"], updatedAt: "2026-06-22",
      activities: [{ id: "a5", date: "2026-06-22", type: "stage", text: "ステージを「内定」→「内定承諾」に変更" }, { id: "a5b", date: "2026-06-20", type: "note", text: "オファー面談。条件に納得いただけた" }] }),
    mk({ id: "c4", name: "高橋 葵", kana: "タカハシ アオイ", advisorId: "adv3", source: "referral", stage: "offer", company: "クラウドベース株式会社", position: "インフラエンジニア", currentJob: "オンプレ運用", desiredJob: "クラウドインフラ", desiredSalary: "600万円", skills: ["AWS", "Terraform", "Kubernetes"], updatedAt: "2026-06-24",
      activities: [{ id: "a6", date: "2026-06-24", type: "stage", text: "ステージを「選考」→「内定」に変更" }] }),
    mk({ id: "c5", name: "伊藤 直樹", kana: "イトウ ナオキ", advisorId: "adv2", source: "timerex", stage: "screen", company: "株式会社データワークス", position: "データエンジニア", currentJob: "アナリスト", desiredJob: "データ基盤構築", desiredSalary: "580万円", skills: ["Python", "SQL", "BigQuery"], updatedAt: "2026-06-25",
      activities: [{ id: "a7", date: "2026-06-25", type: "note", text: "一次面接通過。来週二次面接" }] }),
    mk({ id: "c6", name: "渡辺 美穂", kana: "ワタナベ ミホ", advisorId: "adv3", source: "referral", stage: "proposal", company: "株式会社UXデザイン", position: "UIデザイナー", currentJob: "制作会社デザイナー", desiredJob: "プロダクトデザイン", desiredSalary: "520万円", skills: ["Figma", "UIデザイン"], updatedAt: "2026-06-26",
      activities: [{ id: "a8", date: "2026-06-26", type: "stage", text: "ステージを「初回面談」→「企業提案」に変更" }, { id: "a8b", date: "2026-06-26", type: "note", text: "2社を提案。来週、推薦書を送付予定" }] }),
    mk({ id: "c7", name: "中村 翔", kana: "ナカムラ ショウ", advisorId: "adv1", source: "timerex", stage: "meeting", currentJob: "新卒3年目 営業", desiredJob: "エンジニア転職", desiredSalary: "450万円", skills: ["独学でProgate完了"], updatedAt: "2026-06-27",
      activities: [{ id: "a9", date: "2026-06-27", type: "stage", text: "ステージを「着座」→「初回面談」に変更" }, { id: "a9b", date: "2026-06-27", type: "note", text: "初回面談実施。キャリアの方向性をヒアリング" }] }),
    mk({ id: "c8", name: "小林 由美", kana: "コバヤシ ユミ", advisorId: "adv2", source: "referral", stage: "seated", currentJob: "経理5年", desiredJob: "コーポレートIT", desiredSalary: "500万円", skills: ["Excel", "業務改善"], updatedAt: "2026-06-28",
      activities: [{ id: "a10", date: "2026-06-28", type: "stage", text: "ステージを「予約」→「着座」に変更" }, { id: "a10b", date: "2026-06-25", type: "note", text: "リファラル紹介。LINEグループで初回日程を調整" }] }),
    mk({ id: "c9", name: "加藤 隆", kana: "カトウ タカシ", advisorId: "adv3", source: "timerex", stage: "booked", currentJob: "営業10年", desiredJob: "営業マネージャー", desiredSalary: "650万円", skills: ["法人営業"], updatedAt: "2026-06-28",
      activities: [{ id: "a11", date: "2026-06-28", type: "create", text: "TimeRexで初回面談を予約" }] }),
    mk({ id: "c10", name: "森田 彩", kana: "モリタ アヤ", advisorId: "adv1", source: "referral", stage: "booked", currentJob: "販売職", desiredJob: "カスタマーサクセス", desiredSalary: "480万円", skills: ["接客", "顧客折衝"], updatedAt: "2026-06-28",
      activities: [{ id: "a12", date: "2026-06-28", type: "create", text: "リファラル獲得。LINEグループで日程調整中" }] }),
    mk({ id: "c11", name: "井上 拓海", kana: "イノウエ タクミ", advisorId: "adv2", source: "timerex", stage: "closed", currentJob: "倉庫管理", desiredJob: "ITサポート", desiredSalary: "400万円", skills: [], updatedAt: "2026-06-19",
      activities: [{ id: "a13", date: "2026-06-19", type: "stage", text: "ステージを「予約」→「終了（辞退・見送り）」に変更" }, { id: "a14", date: "2026-06-19", type: "note", text: "予約日に来訪なし（No-show）。連絡つかず見送り" }] }),
  ];
  return { advisors: A, candidates: C };
}
