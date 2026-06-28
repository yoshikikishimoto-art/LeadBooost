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

/* ---------- 流入経路（リード獲得チャネル。db.sources で動的管理） ----------
   流入経路は4つ以上に増える前提で、設定画面（TimeRex設定）から
   「経路名 + CSV URL」を追加・編集できる。色はパレットから自動割当。 */
const SOURCE_PALETTE = ["#2563eb", "#12a150", "#d97706", "#7c3aed", "#0d9488", "#db2777", "#0ea5e9", "#65a30d"];

// 既知の流入経路シート（gviz CSV・link-share済み）。アプリを開けば自動で設定される
const gvizUrl = (id, gid = 0) => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`;
const KNOWN_SHEETS = [
  { key: "tezuna", label: "TEZUNA", id: "1p7K2Kt_KDirnknTtmVDFTnxfTXUTX2AjpkyVxkDu7T4" },
  { key: "hado",   label: "HADO",   id: "1iBUQLTq8A7eiKSmCgq_ZXfWDCWBgrSvEA2iBU8tWFqY" },
  { key: "rr",     label: "R&R",    id: "10J8E53wNX16vgx5_H6KWjl_VlvqH91wPAnmK5uY03PM" },
  { key: "kanoa",  label: "KANOA",  id: "1x2cX9SWr7Q91nlf_BnL91Nu22NjTwLk1nAEXsdE-KFE" },
];
function defaultSources() {
  return KNOWN_SHEETS.map((k, i) => ({ key: k.key, label: k.label, color: SOURCE_PALETTE[i % SOURCE_PALETTE.length], csvUrl: gvizUrl(k.id) }));
}
// 既存の db.sources に既知シートを補完（名前一致なら正しいURLに矯正・無ければ追加）
function ensureKnownSheets() {
  db.sources = db.sources || [];
  let changed = false;
  defaultSources().forEach((ds) => {
    const ex = db.sources.find((x) => x.label === ds.label);
    if (!ex) { db.sources.push(ds); changed = true; }
    else if (ex.csvUrl !== ds.csvUrl) { ex.csvUrl = ds.csvUrl; changed = true; } // typo等を正しいURLに矯正
  });
  if (changed) saveDB();
}
function sources() { return (db.sources && db.sources.length) ? db.sources : (db.sources = defaultSources()); }
function sourceOf(c) { return sources().find((s) => s.key === c.source) || null; }

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
if (!db.sources || !db.sources.length) db.sources = defaultSources();
if (db.syncWithinDays == null) db.syncWithinDays = 14; // 取り込みは直近この日数の予約のみ（0=全期間）
ensureKnownSheets(); // 既知4シートのURLを自動補完

/* ---------- ユーティリティ ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const uid = () => "id-" + Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const initials = (name) => (name || "?").trim().slice(0, 2);
function fmtDate(d) { if (!d) return "—"; const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}`; }
function daysSince(d) { if (!d) return 0; return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }
function advisorName(id) { const a = db.advisors.find((x) => x.id === id); return a ? a.name : "未割当"; }
function stageOf(c) { return c.stage === "closed" ? CLOSED : (STAGE_MAP[c.stage] || STAGES[0]); }
// 終了の場合は理由（事前キャンセル等）を反映したラベルを返す
function stageLabelOf(c) { return (c.stage === "closed" && c.closeReason) ? `終了（${c.closeReason}）` : stageOf(c).label; }

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
let calMonth = today().slice(0, 7); // 面談カレンダーの表示月 YYYY-MM

/* =========================================================
   ルーティング / レンダリング
   ========================================================= */
const VIEW_META = {
  dashboard:  { title: "ダッシュボード", sub: "流入から入社・返金規定クリアまでの進捗を一目で確認" },
  calendar:   { title: "面談カレンダー", sub: "予約・面談の日程をカレンダーで確認し、着座を報告" },
  pipeline:   { title: "パイプライン",  sub: "ドラッグで 予約→着座→…→入社 のステージを移動" },
  candidates: { title: "求職者一覧",    sub: "登録された求職者を検索・絞り込み" },
  advisors:   { title: "アドバイザー",  sub: "キャリアアドバイザーと担当状況・引き継ぎ" },
};

function render() {
  $("#pageTitle").textContent = VIEW_META[currentView].title;
  $("#pageSub").textContent = VIEW_META[currentView].sub;
  $$("#nav .nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === currentView));
  const view = $("#view");
  if (currentView === "dashboard") view.innerHTML = renderDashboard();
  else if (currentView === "calendar") { view.innerHTML = renderCalendar(); bindCalendar(); }
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
  const srcRows = sources().map((s) => {
    const list = cs.filter((c) => c.source === s.key);
    const joined = list.filter((c) => ["join", "refund"].includes(c.stage)).length;
    return { ...s, total: list.length, joined };
  });
  const srcUnknown = cs.filter((c) => !c.source).length;
  const srcMax = Math.max(1, ...srcRows.map((r) => r.total), srcUnknown);
  const cancelledTotal = cs.filter((c) => c.stage === "closed" && c.closeReason).length;

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
        <div class="src-note">入社：${srcRows.map((r) => `${esc(r.label)} ${r.joined}名`).join(" ／ ")}${cancelledTotal ? `<br>事前キャンセル：${cancelledTotal}件` : ""}</div>
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

/* ---------------------- 面談カレンダー ---------------------- */
function shiftMonth(ym, delta) {
  let [y, m] = ym.split("-").map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
// 担当者ごとの色（db.advisorsの並び順で固定割当）
const ADVISOR_PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0d9488", "#db2777", "#0891b2", "#65a30d", "#ea580c", "#4f46e5", "#be123c"];
function advisorColor(id) {
  if (!id) return "#94a3b8";
  const idx = db.advisors.findIndex((a) => a.id === id);
  return ADVISOR_PALETTE[(idx < 0 ? 0 : idx) % ADVISOR_PALETTE.length];
}
function renderCalendar() {
  const [y, m] = calMonth.split("-").map(Number);
  const startDow = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  // 面談日(スケジュール)があり、キャンセル/終了になっていない予約のみ表示
  const onCal = (c) => c.scheduledAt && c.stage !== "closed";
  const byDate = {};
  db.candidates.forEach((c) => { if (onCal(c)) (byDate[c.scheduledAt] = byDate[c.scheduledAt] || []).push(c); });
  const monthCount = db.candidates.filter((c) => onCal(c) && c.scheduledAt.slice(0, 7) === calMonth).length;

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const dow = ["日", "月", "火", "水", "木", "金", "土"];

  // 担当者の凡例（その月に面談がある担当者）
  const monthAdvIds = [...new Set(db.candidates.filter((c) => onCal(c) && c.scheduledAt.slice(0, 7) === calMonth).map((c) => c.advisorId || ""))];
  const legend = monthAdvIds.map((id) => `<span class="cal-leg"><span class="cal-leg-dot" style="background:${advisorColor(id)}"></span>${id ? esc(advisorName(id)) : "未割当"}</span>`).join("");

  return `
    <div class="cal-head">
      <button class="btn btn-outline btn-sm" id="calPrev">←</button>
      <div class="cal-title">${y}年${m}月<span class="muted" style="font-weight:400;margin-left:8px">面談 ${monthCount}件</span></div>
      <button class="btn btn-outline btn-sm" id="calNext">→</button>
      <button class="btn btn-outline btn-sm" id="calToday" style="margin-left:auto">今日へ</button>
    </div>
    ${legend ? `<div class="cal-legend"><span class="muted" style="font-size:12px">担当者：</span>${legend}</div>` : ""}
    <div class="cal-grid">
      ${dow.map((w, i) => `<div class="cal-dow ${i === 0 ? "sun" : ""} ${i === 6 ? "sat" : ""}">${w}</div>`).join("")}
      ${cells.map((d) => {
        if (d === null) return `<div class="cal-cell is-empty"></div>`;
        const ds = `${calMonth}-${String(d).padStart(2, "0")}`;
        const list = (byDate[ds] || []).slice().sort((a, b) => parseSchedTime(a.scheduledText).localeCompare(parseSchedTime(b.scheduledText)));
        return `<div class="cal-cell ${ds === today() ? "is-today" : ""}">
          <div class="cal-day">${d}</div>
          <div class="cal-events">
            ${list.map((c) => {
              const tm = parseSchedTime(c.scheduledText);
              const sr = sourceOf(c);
              return `<div class="cal-ev" data-id="${c.id}" style="border-left-color:${advisorColor(c.advisorId)}" title="${esc(c.name)}｜担当:${esc(advisorName(c.advisorId))}｜流入:${esc(sr ? sr.label : "—")}｜${esc(stageLabelOf(c))}${tm ? " " + tm : ""}">
                ${sr ? `<span class="cal-ev-src" style="color:${sr.color};background:${sr.color}22">${esc(sr.label)}</span>` : ""}
                <span class="cal-ev-name">${tm ? `<b>${tm}</b> ` : ""}${esc(c.name)}</span>
                ${c.stage === "booked" ? `<button class="cal-seat" data-seat="${c.id}" title="着座にする">着</button>` : ""}
              </div>`;
            }).join("")}
          </div>
        </div>`;
      }).join("")}
    </div>`;
}
function bindCalendar() {
  $("#calPrev")?.addEventListener("click", () => { calMonth = shiftMonth(calMonth, -1); render(); });
  $("#calNext")?.addEventListener("click", () => { calMonth = shiftMonth(calMonth, 1); render(); });
  $("#calToday")?.addEventListener("click", () => { calMonth = today().slice(0, 7); render(); });
  $$(".cal-seat").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); markSeated(b.dataset.seat); }));
  $$(".cal-ev").forEach((el) => el.addEventListener("click", () => openDetail(el.dataset.id)));
}
function markSeated(id) {
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return;
  moveStage(c, "seated");
  render();
}

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
          ${sources().map((s) => opt(s.key, s.label, filters.source === s.key)).join("")}
        </select>
      </div>
      <div class="select-wrap">
        <select class="select" id="fadvisor">
          ${opt("", "すべての担当", !filters.advisor)}
          ${db.advisors.map((a) => opt(a.id, a.name, filters.advisor === a.id)).join("")}
        </select>
      </div>
      <button class="btn btn-outline btn-sm" id="exportBtn" style="margin-left:auto">⬇ CSVダウンロード</button>
      <span class="muted">${list.length} 名</span>
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
      <td><span class="badge" data-stage="${s.key}"><span class="dot"></span>${esc(stageLabelOf(c))}</span></td>
      <td>${src ? `<span class="src-badge" style="color:${src.color};background:${src.color}22">${esc(src.label)}</span>` : `<span class="muted">—</span>`}</td>
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
  $("#exportBtn").addEventListener("click", exportCSV);
  $$(".tbl tbody tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
}

/* 現在の絞り込み結果をCSV（Excel可）でダウンロード。着座でフィルタすれば着座者一覧に */
function csvCell(v) { v = String(v ?? ""); return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }
function exportCSV() {
  const list = filteredCandidates();
  const cols = ["氏名", "フリガナ", "メール", "電話", "流入経路", "ステージ", "担当者", "面談日時", "終了理由", "更新日"];
  const rows = list.map((c) => [
    c.name, c.kana || "", c.email || "", c.phone || "",
    sourceOf(c)?.label || "", stageLabelOf(c), advisorName(c.advisorId),
    c.scheduledText || "", c.closeReason || "", c.updatedAt || "",
  ]);
  const csv = [cols, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM付きでExcelの文字化け回避
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const tag = filters.stage ? `_${(STAGE_MAP[filters.stage] || CLOSED).label}` : "";
  a.download = `求職者一覧${tag}_${today()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
  toast(`${list.length}件をCSVでダウンロードしました`);
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
            <div style="flex:1;min-width:0">
              <div class="advisor-name">${esc(a.name)}</div>
              <div class="advisor-stat">担当 ${load} 名 ・ 入社実績 ${joined} 名</div>
            </div>
            ${load ? `<button class="btn btn-outline btn-sm" data-handoff="${a.id}">引き継ぎ</button>` : ""}
          </div>`;
      }).join("")}
    </div>`;
}
function openHandoff(fromId) {
  const from = db.advisors.find((a) => a.id === fromId);
  if (!from) return;
  const total = db.candidates.filter((c) => c.advisorId === fromId).length;
  const opts = db.advisors.filter((a) => a.id !== fromId).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  openModal(`
    <div class="modal-head"><div class="modal-title">担当者の引き継ぎ</div><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0"><strong>${esc(from.name)}</strong> さんの担当（${total}名）を、別の担当者へまとめて引き継ぎます。</p>
      <div class="field full"><label class="field-label">引き継ぎ先</label>
        <div class="select-wrap"><select class="select" id="handoffTo">${opts || `<option value="">他に担当者がいません</option>`}</select></div>
      </div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px;margin-top:12px">
        <input type="checkbox" id="handoffActiveOnly" checked /> <span>進行中のみ引き継ぐ（終了した求職者は除く）</span>
      </label>
    </div>
    <div class="modal-foot"><span></span><div style="display:flex;gap:8px">
      <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary" onclick="runHandoff('${fromId}')">引き継ぐ</button>
    </div></div>`);
}
function runHandoff(fromId) {
  const toId = $("#handoffTo").value;
  if (!toId) { toast("引き継ぎ先を選んでください"); return; }
  const activeOnly = $("#handoffActiveOnly")?.checked;
  const from = advisorName(fromId), to = advisorName(toId);
  let n = 0;
  db.candidates.forEach((c) => {
    if (c.advisorId === fromId && (!activeOnly || c.stage !== "closed")) {
      c.advisorId = toId;
      logActivity(c, `担当者を「${from}」→「${to}」に引き継ぎ`, "note");
      n++;
    }
  });
  saveDB(); closeModal(); render(); toast(`${n}件を ${to} さんへ引き継ぎました`);
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
  const sourceOpts = sources().map((s) => `<option value="${s.key}" ${c.source === s.key ? "selected" : ""}>${esc(s.label)}</option>`).join("");
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
          <div class="detail-name">${esc(c.name)} <span class="badge" data-stage="${s.key}" style="margin-left:6px"><span class="dot"></span>${esc(stageLabelOf(c))}</span></div>
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
        ${c.stage === "closed" ? row("終了理由", c.closeReason || "辞退・見送り") : ""}
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
   流入経路の同期：各流入経路のGoogleスプレッドシート(CSV)から予約を取り込む
   （TimeRex等 →(Webhook/Zapier)→ シート保存 を前提に、本アプリは公開CSVを読むだけ）
   - 流入経路ごとにCSV URLを設定（db.sources[].csvUrl）
   - ステータス列が「キャンセル/取消」の予約は 終了（キャンセル）へ自動移動
   ========================================================= */
const SYNC_URL_KEY = "talentflow.syncUrl"; // 旧バージョンの単一URL（移行用）

// 列名の揺れを吸収（シート側のヘッダーが多少違っても拾う）
const SYNC_COLS = {
  name:   ["氏名", "名前", "お名前", "name", "Name"],
  email:  ["メール", "メールアドレス", "Email", "email", "mail", "E-mail"],
  phone:  ["電話", "電話番号", "TEL", "tel", "phone"],
  date:   ["スケジュール", "予約日時", "日時", "開始日時", "予定日時", "面談日時", "予約日", "datetime", "start"],
  extId:  ["イベントID", "予約ID", "予約番号", "event_id", "ID", "id"],
  note:   ["コメント", "メモ", "備考", "note"],
  status: ["ステータス", "状態", "予約状態", "予約ステータス", "status", "Status"],
  advisor:["参加メンバー", "担当者", "担当", "アサイン", "メンバー"],
};
const CANCEL_RE = /キャンセル|取消|取り消|cancel|declin|no[\s-]?show|不参加|辞退/i;
const RESCHEDULED_RE = /日程変更|リスケ|reschedul/i; // 新しい確定行に置き換わった古い行 → 取り込まない

// TimeRexの「名前」列は "氏名\tフリガナ" の形が多いので分離する
function parseName(raw) {
  const parts = String(raw || "").split(/\t/);
  return { name: (parts[0] || "").trim(), kana: (parts[1] || "").trim() };
}

// スケジュール文字列から予約日(YYYY-MM-DD)を取り出す
// 例: "2026年6月29日 (月) 12:00 - 13:00（Asia/Tokyo）" / "2026/6/29" / "2026-06-29"
function parseSchedDate(s) {
  const m = String(s || "").match(/(\d{4})\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}
function parseSchedTime(s) {
  const m = String(s || "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

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
  const aliases = SYNC_COLS[field] || [];
  // 1) ヘッダー名の完全一致を優先（正常なシート）
  for (const a of aliases) if (a in obj && obj[a] !== "") return obj[a];
  // 2) 「列名 + スペース + データ連結」の壊れたヘッダーにも対応（前方一致）
  const keys = Object.keys(obj);
  for (const a of aliases) for (const k of keys) {
    if (k.startsWith(a + " ") && obj[k] !== "") return obj[k];
  }
  return "";
}

// 旧バージョンの単一URLを timerex 経路へ移行（既存ユーザーの設定を引き継ぐ）
(function migrateLegacySyncUrl() {
  const legacy = localStorage.getItem(SYNC_URL_KEY);
  if (legacy && !sources().some((s) => s.csvUrl)) {
    const tx = sources().find((s) => s.key === "timerex") || sources()[0];
    if (tx) { tx.csvUrl = legacy; saveDB(); }
  }
})();

// 担当者名からアドバイザーを取得（無ければ自動登録）。複数名は先頭をメイン担当に
function findOrCreateAdvisor(name) {
  name = (name || "").split(/[,、，/／]/)[0].trim();
  if (!name) return "";
  let a = db.advisors.find((x) => x.name === name);
  if (!a) { a = { id: uid(), name, email: "" }; db.advisors.push(a); }
  return a.id;
}

function newCandidateFromRow(o, src, stage, extId) {
  const nm = parseName(colVal(o, "name"));
  const date = colVal(o, "date");
  return {
    id: uid(), name: nm.name || colVal(o, "email"), kana: nm.kana,
    email: colVal(o, "email"), phone: colVal(o, "phone"),
    currentJob: "", desiredJob: "", desiredSalary: "", skills: [],
    company: "", position: "", advisorId: findOrCreateAdvisor(colVal(o, "advisor")),
    source: src.key, extId, stage,
    scheduledAt: parseSchedDate(date), scheduledText: date,
    createdAt: today(), updatedAt: today(), activities: [],
  };
}

// 1行を取り込む。戻り値: "added" | "cancelled" | "dup" | "old" | "reschedule" | "empty"
function importRow(o, src) {
  const name = colVal(o, "name"), email = colVal(o, "email"), date = colVal(o, "date");
  if (!name && !email) return "empty";
  const status = colVal(o, "status");
  // 日程変更済みの古い行は新しい確定行に置き換わっているので取り込まない
  if (RESCHEDULED_RE.test(status)) return "reschedule";
  // 取り込み範囲：直近N日より前の予約はスキップ（日付が読めない行は対象外＝取り込む）
  const within = Number(db.syncWithinDays) || 0;
  if (within > 0) { const sd = parseSchedDate(date); if (sd && sd < daysAgoISO(within)) return "old"; }
  const rawId = colVal(o, "extId");
  const extId = `${src.key}|` + (rawId || (email ? `${email}|${date}` : `${name}|${date}`));
  // 重複判定は一意キー（イベントID等）のみで行う。メールは使い回されるため使わない
  const existing = db.candidates.find((c) => c.extId && c.extId === extId);

  if (CANCEL_RE.test(status)) {
    const reason = status || "事前キャンセル";
    if (existing) {
      // 既に終了済み、または着座以降に進んでいる予約は触らない（過去の取消が上書きしないように）
      if (existing.stage === "closed" || existing.stage !== "booked") return "dup";
      const from = stageOf(existing).label;
      existing.stage = "closed"; existing.closeReason = reason; existing.updatedAt = today();
      logActivity(existing, `事前キャンセル（${reason}）でステージを「${from}」→「終了」に変更`, "stage");
      return "cancelled";
    }
    // 新規のキャンセル行 → 終了（キャンセル）として記録（キャンセル率の集計用）
    const c = newCandidateFromRow(o, src, "closed", extId);
    c.closeReason = reason;
    logActivity(c, `事前キャンセル（${reason}）を取り込み`, "create");
    db.candidates.unshift(c);
    return "cancelled";
  }

  if (existing) {
    // 既存でも未設定の項目はシートで補完（担当者・面談日時）
    let upd = false;
    if (!existing.advisorId) { const adv = findOrCreateAdvisor(colVal(o, "advisor")); if (adv) { existing.advisorId = adv; upd = true; } }
    if (!existing.scheduledAt) { const sd = parseSchedDate(date); if (sd) { existing.scheduledAt = sd; existing.scheduledText = date; upd = true; } }
    if (upd) existing.updatedAt = today();
    return "dup";
  }
  const c = newCandidateFromRow(o, src, "booked", extId);
  const note = colVal(o, "note");
  logActivity(c, `${src.label}で予約${date ? `（${date}）` : ""}${note ? `／${note}` : ""}`, "create");
  db.candidates.unshift(c);
  return "added";
}

const SYNC_BUILD = "sync-v9"; // ビルド識別（ページが最新JSかの確認用）
async function runSync() {
  const srcs = sources().filter((s) => s.csvUrl);
  console.log(`[${SYNC_BUILD}] runSync 開始 / today=${today()} / 直近${db.syncWithinDays}日（下限=${db.syncWithinDays ? daysAgoISO(Number(db.syncWithinDays)) : "なし"}） / 対象経路=${srcs.length}`, srcs.map((s) => ({ label: s.label, url: s.csvUrl })));
  if (!srcs.length) return openSyncModal();
  const btn = $("#syncBtn"), label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "同期中…"; }
  const t = { added: 0, cancelled: 0, dup: 0, old: 0, reschedule: 0, empty: 0 };
  const results = [];
  let failed = 0;
  for (const s of srcs) {
    try {
      const res = await fetch(s.csvUrl, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const objs = rowsToObjects(parseCSV(await res.text()));
      const per = { added: 0, cancelled: 0, dup: 0, old: 0, reschedule: 0, empty: 0 };
      objs.forEach((o) => { const r = importRow(o, s); t[r]++; per[r]++; });
      console.log(`[${SYNC_BUILD}] 「${s.label}」: ${objs.length}行 →`, per);
      results.push(`${s.label}+${per.added + per.cancelled}`);
    } catch (e) { console.error(`[${SYNC_BUILD}] 取得失敗:`, s.label, e); failed++; results.push(`${s.label}✗失敗`); }
  }
  saveDB(); render();
  const skipped = t.dup + t.old + t.reschedule + t.empty;
  let msg = `同期(v9)｜${results.join(" / ")}｜計${t.added + t.cancelled}件追加・スキップ${skipped}（期間外${t.old}・重複${t.dup}・変更${t.reschedule}・空${t.empty}）`;
  console.log(`[${SYNC_BUILD}] 完了:`, { ...t, failed, 求職者総数: db.candidates.length });
  toast(msg);
  if (btn) { btn.disabled = false; btn.textContent = label || "⟳ TimeRex同期"; }
}

function openSyncModal() {
  const rowHtml = (s) => `
    <div class="sync-row" data-key="${esc(s.key || "")}">
      <input class="input" data-f="label" value="${esc(s.label || "")}" placeholder="流入経路名（例: TimeRex予約）" />
      <input class="input" data-f="csvUrl" value="${esc(s.csvUrl || "")}" placeholder="GoogleスプレッドシートのCSV URL" />
    </div>`;
  openModal(`
    <div class="modal-head">
      <div class="modal-title">流入経路と同期の設定</div>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0">流入経路ごとに、保存先の<strong>GoogleスプレッドシートのCSV URL</strong>（ファイル→共有→ウェブに公開→カンマ区切り）を設定します。「保存して同期」で全シートから未登録の予約を取り込みます。</p>
      <div class="section-label">流入経路 × シート</div>
      <div id="syncRows">${[...sources(), { key: "", label: "", csvUrl: "" }].map(rowHtml).join("")}</div>
      <button class="btn btn-outline btn-sm" type="button" onclick="addSyncRow()" style="margin-top:8px">＋ 行を追加</button>
      <div class="section-label">取り込み範囲</div>
      <div class="field">
        <label class="field-label">直近この日数の予約のみ取り込む（0 = 全期間）</label>
        <input class="input" id="sync_within" type="number" min="0" value="${esc(db.syncWithinDays ?? 14)}" style="max-width:160px" />
      </div>
      <div class="section-label">取り込みルール</div>
      <p class="muted" style="font-size:12px">列は自動マッチ：氏名 / メール / 予約日時（任意：電話・予約ID・メモ・ステータス）。<br><strong>ステータス列が「キャンセル/取消」</strong>の予約は「終了（キャンセル）」へ自動で移動します。重複は自動スキップ。</p>
    </div>
    <div class="modal-foot">
      <span></span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary" onclick="saveSourcesAndSync()">保存して同期</button>
      </div>
    </div>`);
}
function addSyncRow() {
  const wrap = $("#syncRows");
  if (!wrap) return;
  const div = document.createElement("div");
  div.className = "sync-row"; div.dataset.key = "";
  div.innerHTML = `<input class="input" data-f="label" placeholder="流入経路名（例: 〇〇広告）" /><input class="input" data-f="csvUrl" placeholder="GoogleスプレッドシートのCSV URL" />`;
  wrap.appendChild(div);
}
function saveSourcesAndSync() {
  const rows = $$("#syncRows .sync-row").map((r) => ({
    key: r.dataset.key || "",
    label: $('[data-f="label"]', r).value.trim(),
    csvUrl: $('[data-f="csvUrl"]', r).value.trim(),
  })).filter((s) => s.label || s.csvUrl); // 名前かURLどちらか入っていれば有効
  if (!rows.length) { toast("流入経路を1つ以上入力してください"); return; }
  db.syncWithinDays = Math.max(0, parseInt($("#sync_within")?.value, 10) || 0);
  const prev = sources();
  const used = new Set();
  db.sources = rows.map((s, i) => {
    let key = s.key;
    if (!key || used.has(key)) key = "s_" + uid();
    used.add(key);
    const old = prev.find((x) => x.key === s.key);
    return { key, label: s.label || `流入経路${i + 1}`, color: (old && old.color) || SOURCE_PALETTE[i % SOURCE_PALETTE.length], csvUrl: s.csvUrl };
  });
  saveDB();
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
  const h = e.target.closest("[data-handoff]");
  if (h) openHandoff(h.dataset.handoff);
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
Object.assign(window, { closeModal, openCandidateForm, saveCandidate, deleteCandidate, openDetail, setStage, addNote, saveAdvisor, openSyncModal, runSync, addSyncRow, saveSourcesAndSync, openHandoff, runHandoff, db });

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
  return { advisors: A, candidates: C, sources: defaultSources() };
}
