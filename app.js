/* =========================================================
   TalentFlow — 人材紹介 進捗管理（バニラJS / localStorage）
   求職者の情報管理と 紹介→承諾→入社 の一連フローを管理する。
   ========================================================= */

/* ---------- ステージ定義（パイプラインの単一ソース） ---------- */
const STAGES = [
  { key: "booked",   label: "受付（面談予定）", color: "var(--stage-booked)"   }, // 送客受付／リファラル面談設定済
  { key: "meeting",  label: "初回面談",        color: "var(--stage-meeting)"  },
  { key: "seated",   label: "着座（候補者化）", color: "var(--stage-seated)"   },
  { key: "pickup",   label: "企業ピックアップ", color: "var(--stage-pickup)"   },
  { key: "proposal", label: "企業提案",        color: "var(--stage-proposal)" },
  { key: "screen",   label: "選考",           color: "var(--stage-screen)"   },
  { key: "offer",    label: "内定",           color: "var(--stage-offer)"    },
  { key: "accept",   label: "内定承諾",        color: "var(--stage-accept)"   },
  { key: "join",     label: "入社",           color: "var(--stage-join)"     },
  { key: "left",     label: "退社（早期退社）", color: "var(--stage-left)"     }, // 終端：早期退社
];
const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.key, s]));
const CLOSED = { key: "closed", label: "終了（辞退・見送り）", color: "var(--stage-closed)" };
const REFERRAL = { key: "referral", label: "リファラル（面談設定前）", color: "var(--source-referral)" }; // 日程・担当未定の獲得段階

/* ---------- 報告タイミング（明示ボタンで記録） ----------
   stage を指定するとステージも進める。close は終了（理由）。 */
const REPORT_TYPES = [
  { key: "candidate",   label: "初回面談完了・候補者化", stage: "seated" },
  { key: "proposal",    label: "提案企業一覧の報告",     stage: "proposal", companies: "提案", hint: "社名をカンマ/改行で羅列" },
  { key: "accepted",    label: "応諾の報告",             companies: "応諾", hint: "応諾した社名を羅列" },
  { key: "entry",       label: "エントリー実施",         companies: "エントリー", hint: "エントリーした社名を羅列" },
  { key: "offerAccept", label: "内定承諾の報告（売上計上）", stage: "accept" },
  { key: "decline",     label: "辞退の報告",             close: "辞退" },
  { key: "left",        label: "退社の報告（早期退社）", stage: "left" },
];

/* ---------- 選考企業（候補者ごとに複数）／売上・読み票 ---------- */
const APP_STATUSES = ["提案", "応諾", "書類回収", "日程回収", "エントリー", "一次面接", "二次面接", "最終面接", "内定", "内定承諾", "入社", "見送り"];
const CONFIDENCE = [{ key: "A", label: "A（高）", p: 0.8 }, { key: "B", label: "B（中）", p: 0.5 }, { key: "C", label: "C（低）", p: 0.2 }];
function confP(k) { const c = CONFIDENCE.find((x) => x.key === k); return c ? c.p : 0.5; }
// 読み額：入社=確定(満額)、見送り=0、それ以外=想定売上×確度
function appYomi(a) { const fee = Number(a.fee) || 0; return a.status === "入社" ? fee : a.status === "見送り" ? 0 : Math.round(fee * confP(a.conf)); }
const fmtYen = (n) => `¥${(Number(n) || 0).toLocaleString("en-US")}`;
// 選考中（どこかしら選考に乗っている）＝一次面接以上の選考企業を持つ
const SELECTION_SET = ["一次面接", "二次面接", "最終面接", "内定", "内定承諾", "入社"];
const OFFER_SET = ["内定", "内定承諾", "入社"];
function hasAppIn(c, set) { return (c.applications || []).some((a) => set.includes(a.status)); }
// 読み票テーブルの絞り込み定義
const YOMI_FILTERS = [
  { key: "all",       label: "すべて",         match: (a) => a.status !== "見送り" },
  { key: "proposal",  label: "提案・応諾",     match: (a) => ["提案", "応諾"].includes(a.status) },
  { key: "doc",       label: "書類〜エントリー", match: (a) => ["書類回収", "日程回収", "エントリー"].includes(a.status) },
  { key: "interview", label: "一次面接以上",   match: (a) => ["一次面接", "二次面接", "最終面接"].includes(a.status) },
  { key: "offer",     label: "内定以上",       match: (a) => OFFER_SET.includes(a.status) },
];

/* ---------- 売上管理（計上・請求・着金） ----------
   売上計上＝内定承諾月。請求書発行：中途=入社月／新卒=承諾月。入金＝請求の翌月末。 */
const EMP_TYPES = ["中途", "新卒"];
const RECOGNIZED_SET = ["内定承諾", "入社"];               // 承諾以上＝売上計上（確定）
// 請求進捗（発行→送付→着金）。台帳の発行/送付/着金フラグを1本に集約
const INVOICE_STATUSES = ["未請求", "発行済", "送付済", "入金済", "返金"];
// 事業区分（台帳 col7 で判定。RAは基本なし）
const SEGMENTS = ["CA", "PCA", "PCAシェア", "未分類"];
function segOf(a) { return SEGMENTS.includes(a.segment) ? a.segment : "未分類"; }
const segLabel = (s) => ({ CA: "CA事業", PCA: "PCA事業", PCAシェア: "PCA(シェア)", 未分類: "未分類" }[s] || s);
function empTypeOf(c) { return c.empType === "新卒" ? "新卒" : "中途"; }

/* ---------- 企業マスタ（成果報酬・料率） ---------- */
const DEFAULT_FEE_RATE = 35;   // 既定の料率（%）
const DEFAULT_TAX_RATE = 10;   // 消費税（%）
function companyList() { return (db.companies = db.companies || []); }
function findCompanyByName(name) { const n = (name || "").trim(); return n ? companyList().find((co) => (co.name || "").trim() === n) : null; }
// 金額自動算出：固定額があればそれ、なければ 料率(%)×想定年収。税込も算出
function computeCompanyFee(co, cand) {
  if (!co) return { fee: 0, feeInclTax: 0 };
  const rate = Number(co.feeRate) || 0;
  const tax = co.taxRate == null ? DEFAULT_TAX_RATE : Number(co.taxRate);
  let fee = Number(co.fixedFee) || 0;
  if (!fee) fee = Math.round((Number(cand && cand.expectedSalary) || 0) * rate / 100);
  return { fee, feeInclTax: Math.round(fee * (1 + tax / 100)) };
}
const monthOf = (iso) => (iso || "").slice(0, 7);          // YYYY-MM
const thisMonth = () => today().slice(0, 7);
const nextMonth = (ym) => ym ? shiftMonthDate(`${ym}-01`, 1).slice(0, 7) : ""; // 翌月（=翌月末払い）
const fmtMonth = (ym) => ym ? ym.replace("-", "年") + "月" : "—";
// 計上（確定）売上：承諾以上=税抜fee（fee には税抜を格納）。早期退職は承諾月に計上のうえ、返金は別途マイナス計上
function salesRecognized(a) { return RECOGNIZED_SET.includes(a.status) ? (Number(a.fee) || 0) : 0; }
// 早期退職などの返金額（税抜）。返金の計上月は refundDate（無ければ acceptMonth）
function salesRefund(a) { return Number(a.refundAmount) || 0; }
function refundMonth(a) { return monthOf(a.refundDate) || a.acceptMonth || ""; }
// 着地見込み：承諾以上=確定fee、提案〜最終面接=fee×確度、見送り/返金=0
function salesForecast(a) {
  if (a.status === "見送り" || a.invoiceStatus === "返金") return 0;
  if (RECOGNIZED_SET.includes(a.status)) return Number(a.fee) || 0;
  return Math.round((Number(a.fee) || 0) * confP(a.conf));
}
// 売上関連フィールドの自動補完（未設定のみ補完し、手修正は尊重）
function syncAppSales(c, a) {
  if (a.invoiceStatus == null) a.invoiceStatus = "未請求";
  if (RECOGNIZED_SET.includes(a.status) && !a.acceptMonth) a.acceptMonth = thisMonth();
  if (!a.invoiceMonth) {
    if (empTypeOf(c) === "新卒") { if (a.acceptMonth) a.invoiceMonth = a.acceptMonth; }
    else { if (a.status === "入社" && c.joinedAt) a.invoiceMonth = monthOf(c.joinedAt); }
  }
  if (a.invoiceMonth && !a.dueMonth) a.dueMonth = nextMonth(a.invoiceMonth);
}

/* ---------- 流入経路（リード獲得チャネル。db.sources で動的管理） ----------
   流入経路は4つ以上に増える前提で、設定画面（TimeRex設定）から
   「経路名 + CSV URL」を追加・編集できる。色はパレットから自動割当。 */
const SOURCE_PALETTE = ["#2563eb", "#12a150", "#d97706", "#7c3aed", "#0d9488", "#db2777", "#0ea5e9", "#65a30d"];

// 既知の流入経路シート（gviz CSV・link-share済み）。アプリを開けば自動で設定される
const gvizUrl = (id, gid = 0) => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`;
// kind: "timerex"=予約シート / "referral"=リファラル（日程・担当未定の獲得シート）
const KNOWN_SHEETS = [
  { key: "tezuna",   label: "TEZUNA", id: "1p7K2Kt_KDirnknTtmVDFTnxfTXUTX2AjpkyVxkDu7T4" },
  { key: "hado",     label: "HADO",   id: "1iBUQLTq8A7eiKSmCgq_ZXfWDCWBgrSvEA2iBU8tWFqY" },
  { key: "rr",       label: "R&R",    id: "10J8E53wNX16vgx5_H6KWjl_VlvqH91wPAnmK5uY03PM" },
  { key: "kanoa",    label: "KANOA",  id: "1x2cX9SWr7Q91nlf_BnL91Nu22NjTwLk1nAEXsdE-KFE" },
  { key: "referral", label: "リファラル", id: "1bLZZwJGvySZn4nlWYFYhIKiKVFSuN-ld94dy-GleCu8", gid: "2108869602", kind: "referral" },
];
function defaultSources() {
  return KNOWN_SHEETS.map((k, i) => ({ key: k.key, label: k.label, color: SOURCE_PALETTE[i % SOURCE_PALETTE.length], csvUrl: gvizUrl(k.id, k.gid || 0), kind: k.kind || "timerex" }));
}
// 既存の db.sources に既知シートを補完（名前一致なら正しいURL/種別に矯正・無ければ追加）
function ensureKnownSheets() {
  db.sources = db.sources || [];
  let changed = false;
  defaultSources().forEach((ds) => {
    const ex = db.sources.find((x) => x.label === ds.label);
    if (!ex) { db.sources.push(ds); changed = true; }
    else {
      if (ex.csvUrl !== ds.csvUrl) { ex.csvUrl = ds.csvUrl; changed = true; } // typo等を正しいURLに矯正
      if (ex.kind !== ds.kind) { ex.kind = ds.kind; changed = true; }
    }
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
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // ローカル日付（toISOStringのUTCずれ回避）
const today = () => isoLocal(new Date());
const daysAgoISO = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d); };
const initials = (name) => (name || "?").trim().slice(0, 2);
function fmtDate(d) { if (!d) return "—"; const x = new Date(d); return `${x.getMonth() + 1}/${x.getDate()}`; }
function daysSince(d) { if (!d) return 0; return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }
function advisorName(id) { const a = db.advisors.find((x) => x.id === id); return a ? a.name : "未割当"; }
function stageOf(c) { return c.stage === "closed" ? CLOSED : c.stage === "referral" ? REFERRAL : (STAGE_MAP[c.stage] || STAGES[0]); }
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
let calDate = today();      // 面談カレンダーの基準日 YYYY-MM-DD
let calView = "month";      // "month" | "week"
let yomiFilter = "all";     // 読み票テーブルの絞り込み
let salesMonth = today().slice(0, 7); // 売上管理の対象月 YYYY-MM
let salesPayFilter = "all"; // 着金管理テーブルの絞り込み
let salesSeg = "all"; // 売上管理の事業フィルタ（all/CA/PCA/PCAシェア/未分類）

/* =========================================================
   ルーティング / レンダリング
   ========================================================= */
const VIEW_META = {
  dashboard:  { title: "ダッシュボード", sub: "流入から入社・返金規定クリアまでの進捗を一目で確認" },
  calendar:   { title: "面談カレンダー", sub: "予約・面談の日程をカレンダーで確認し、着座を報告" },
  referrals:  { title: "リファラル管理", sub: "日程・担当が未定のリファラル獲得を管理し、面談設定する" },
  pipeline:   { title: "パイプライン",  sub: "ドラッグで 予約→着座→…→入社 のステージを移動" },
  candidates: { title: "求職者一覧",    sub: "登録された求職者を検索・絞り込み" },
  yomi:       { title: "読み票（売上）", sub: "候補者×企業の選考から、確定売上と読み額を集計" },
  sales:      { title: "売上管理",      sub: "月次の売上計上・目標達成・入金（着金）を管理" },
  companies:  { title: "企業マスタ",    sub: "提案先企業の成果報酬・料率を管理。提案報告時に金額を自動算出" },
  advisors:   { title: "アドバイザー",  sub: "キャリアアドバイザーと担当状況・引き継ぎ" },
};

function render() {
  $("#pageTitle").textContent = VIEW_META[currentView].title;
  $("#pageSub").textContent = VIEW_META[currentView].sub;
  $$("#nav .nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === currentView));
  const view = $("#view");
  if (currentView === "dashboard") view.innerHTML = renderDashboard();
  else if (currentView === "calendar") { view.innerHTML = renderCalendar(); bindCalendar(); }
  else if (currentView === "referrals") { view.innerHTML = renderReferrals(); bindReferrals(); }
  else if (currentView === "pipeline") { view.innerHTML = renderPipeline(); bindBoard(); }
  else if (currentView === "candidates") { view.innerHTML = renderCandidates(); bindCandidates(); }
  else if (currentView === "yomi") { view.innerHTML = renderYomi(); bindYomi(); }
  else if (currentView === "sales") { view.innerHTML = renderSales(); bindSales(); }
  else if (currentView === "companies") { view.innerHTML = renderCompanies(); bindCompanies(); }
  else if (currentView === "advisors") view.innerHTML = renderAdvisors();
}

/* ---------------------- ダッシュボード ---------------------- */
function renderDashboard() {
  const cs = db.candidates.filter(inScope);
  const active = cs.filter((c) => c.stage !== "closed" && c.stage !== "left");
  const counts = Object.fromEntries(STAGES.map((s) => [s.key, cs.filter((c) => c.stage === s.key).length]));
  const max = Math.max(1, ...STAGES.map((s) => counts[s.key]));

  const order = (st) => STAGES.findIndex((s) => s.key === st);
  const reached = (key) => active.filter((c) => order(c.stage) >= order(key)).length;
  const joinedThisMonth = cs.filter((c) => (c.joinedAt || "").slice(0, 7) === today().slice(0, 7)).length;
  const joinedTotal = cs.filter((c) => !!c.joinedAt).length;
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
    const joined = list.filter((c) => !!c.joinedAt).length;
    return { ...s, total: list.length, joined };
  });
  const srcUnknown = cs.filter((c) => !c.source).length;
  const srcMax = Math.max(1, ...srcRows.map((r) => r.total), srcUnknown);
  const cancelledTotal = cs.filter((c) => c.stage === "closed" && c.closeReason).length;

  const allActs = cs.flatMap((c) => (c.activities || []).map((a) => ({ ...a, cand: c })))
    .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  const recent = allActs.slice(0, 8);
  const reports = allActs.filter((a) => a.type === "report").slice(0, 10);

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
        <div class="src-dl"><span class="muted">着座管理シート：</span>${srcRows.map((r) => `<button class="btn btn-outline btn-sm" data-seatdl="${r.key}">⬇ ${esc(r.label)}</button>`).join("")}</div>
      </div>
    </div>
    ${renderUnseatedPanel()}
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="panel-title">報告フィード</div>
      <div class="activity-list">
        ${reports.length ? reports.map((a) => `
          <div class="activity">
            <div class="activity-ico">${activityIcon("report")}</div>
            <div>
              <div class="activity-body"><strong>${esc(a.cand.name)}</strong> ${esc(a.text)}</div>
              <div class="activity-meta">${fmtDate(a.date)}・${esc(advisorName(a.cand.advisorId))}</div>
            </div>
          </div>`).join("") : `<div class="empty">まだ報告がありません。候補者詳細の「報告する」から記録できます</div>`}
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
function activityIcon(type) { return { stage: "↗", note: "✎", create: "＋", report: "📣" }[type] || "•"; }

/* ---------------------- 面談カレンダー ---------------------- */
const CAL_DOW = ["日", "月", "火", "水", "木", "金", "土"];
function addDays(iso, n) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return isoLocal(d); }
function weekStart(iso) { return addDays(iso, -new Date(iso + "T00:00:00").getDay()); } // その週の日曜
function shiftMonthDate(iso, delta) { let [y, m] = iso.split("-").map(Number); m += delta; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, "0")}-01`; }

// 担当者ごとの色（db.advisorsの並び順で固定割当）
const ADVISOR_PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0d9488", "#db2777", "#0891b2", "#65a30d", "#ea580c", "#4f46e5", "#be123c"];
function advisorColor(id) {
  if (!id) return "#94a3b8";
  const idx = db.advisors.findIndex((a) => a.id === id);
  return ADVISOR_PALETTE[(idx < 0 ? 0 : idx) % ADVISOR_PALETTE.length];
}
// 1予約のイベント（担当者カラー＋流入タグ＋担当者名）
function calEvent(c) {
  const tm = parseSchedTime(c.scheduledText);
  const sr = sourceOf(c);
  const adv = advisorColor(c.advisorId);
  const advNm = c.advisorId ? advisorName(c.advisorId) : "未割当";
  return `<div class="cal-ev" data-id="${c.id}" style="border-left-color:${adv}" title="${esc(c.name)}｜担当:${esc(advNm)}｜流入:${esc(sr ? sr.label : "—")}｜${esc(stageLabelOf(c))}${tm ? " " + tm : ""}">
    ${sr ? `<span class="cal-ev-src" style="color:${sr.color};background:${sr.color}22">${esc(sr.label)}</span>` : ""}
    <span class="cal-ev-name">${tm ? `<b>${tm}</b> ` : ""}${esc(c.name)}</span>
    <span class="cal-ev-adv" style="background:${adv}">${esc(advNm)}</span>
    ${c.stage === "booked" ? `<button class="cal-seat" data-seat="${c.id}" title="着座にする">着</button>` : ""}
  </div>`;
}
function renderCalendar() {
  const onCal = (c) => c.scheduledAt && c.stage !== "closed";
  const byDate = {};
  db.candidates.forEach((c) => { if (onCal(c) && inScope(c)) (byDate[c.scheduledAt] = byDate[c.scheduledAt] || []).push(c); });
  Object.values(byDate).forEach((l) => l.sort((a, b) => parseSchedTime(a.scheduledText).localeCompare(parseSchedTime(b.scheduledText))));

  const week = calView === "week";
  const ws = weekStart(calDate), we = addDays(ws, 6);
  const inRange = week ? (ds) => ds >= ws && ds <= we : (ds) => ds.slice(0, 7) === calDate.slice(0, 7);
  const title = week
    ? `${Number(ws.slice(5, 7))}/${Number(ws.slice(8, 10))} 〜 ${Number(we.slice(5, 7))}/${Number(we.slice(8, 10))}`
    : `${calDate.slice(0, 4)}年${Number(calDate.slice(5, 7))}月`;
  const visCount = db.candidates.filter((c) => onCal(c) && inRange(c.scheduledAt)).length;
  const advIds = [...new Set(db.candidates.filter((c) => onCal(c) && inRange(c.scheduledAt)).map((c) => c.advisorId || ""))];
  const legend = advIds.map((id) => `<span class="cal-leg"><span class="cal-leg-dot" style="background:${advisorColor(id)}"></span>${id ? esc(advisorName(id)) : "未割当"}</span>`).join("");
  const tog = (v, label) => `<button class="btn btn-sm ${calView === v ? "btn-primary" : "btn-outline"}" data-calview="${v}">${label}</button>`;

  return `
    <div class="cal-head">
      <div class="seg">${tog("month", "月")}${tog("week", "週")}</div>
      <button class="btn btn-outline btn-sm" id="calPrev">←</button>
      <div class="cal-title">${title}<span class="muted" style="font-weight:400;margin-left:8px">面談 ${visCount}件</span></div>
      <button class="btn btn-outline btn-sm" id="calNext">→</button>
      <button class="btn btn-outline btn-sm" id="calToday" style="margin-left:auto">今日へ</button>
    </div>
    ${legend ? `<div class="cal-legend"><span class="muted" style="font-size:12px">担当者：</span>${legend}</div>` : ""}
    ${week ? calWeekGrid(byDate, ws) : calMonthGrid(byDate)}`;
}
function calMonthGrid(byDate) {
  const [y, m] = calDate.split("-").map(Number);
  const startDow = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return `<div class="cal-grid">
    ${CAL_DOW.map((w, i) => `<div class="cal-dow ${i === 0 ? "sun" : ""} ${i === 6 ? "sat" : ""}">${w}</div>`).join("")}
    ${cells.map((d) => {
      if (d === null) return `<div class="cal-cell is-empty"></div>`;
      const ds = `${calDate.slice(0, 7)}-${String(d).padStart(2, "0")}`;
      return `<div class="cal-cell ${ds === today() ? "is-today" : ""}">
        <div class="cal-day">${d}</div>
        <div class="cal-events">${(byDate[ds] || []).map(calEvent).join("")}</div>
      </div>`;
    }).join("")}
  </div>`;
}
function calWeekGrid(byDate, ws) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  return `<div class="cal-grid cal-week">
    ${days.map((ds) => {
      const dt = new Date(ds + "T00:00:00"), dw = dt.getDay();
      const list = byDate[ds] || [];
      return `<div class="cal-cell cal-wcell ${ds === today() ? "is-today" : ""}">
        <div class="cal-wday ${dw === 0 ? "sun" : ""} ${dw === 6 ? "sat" : ""}">${CAL_DOW[dw]} <b>${dt.getMonth() + 1}/${dt.getDate()}</b>${list.length ? `<span class="muted" style="margin-left:auto">${list.length}件</span>` : ""}</div>
        <div class="cal-events">${list.map(calEvent).join("")}</div>
      </div>`;
    }).join("")}
  </div>`;
}
function bindCalendar() {
  $$("[data-calview]").forEach((b) => b.addEventListener("click", () => { calView = b.dataset.calview; render(); }));
  $("#calPrev")?.addEventListener("click", () => { calDate = calView === "week" ? addDays(calDate, -7) : shiftMonthDate(calDate, -1); render(); });
  $("#calNext")?.addEventListener("click", () => { calDate = calView === "week" ? addDays(calDate, 7) : shiftMonthDate(calDate, 1); render(); });
  $("#calToday")?.addEventListener("click", () => { calDate = today(); render(); });
  $$(".cal-seat").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); markSeated(b.dataset.seat); }));
  $$(".cal-ev").forEach((el) => el.addEventListener("click", () => openDetail(el.dataset.id)));
}
function markSeated(id) {
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return;
  moveStage(c, "seated");
  render();
}

/* ---------------------- リファラル管理 ---------------------- */
function confChip(v) {
  const c = String(v || "").trim();
  const cls = /高/.test(c) ? "pos" : /低/.test(c) ? "neg" : "";
  return c ? `<span class="conf ${cls}">${esc(c)}</span>` : `<span class="muted">—</span>`;
}
function renderReferrals() {
  const list = db.candidates.filter((c) => c.stage === "referral" && inScope(c))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return `
    <div class="filter-row">
      <span class="muted">面談設定が必要なリファラル <strong>${list.length}</strong> 件</span>
      <button class="btn btn-outline btn-sm" id="refSyncBtn" style="margin-left:auto">⟳ リファラル取り込み</button>
    </div>
    <div class="card table-wrap">
      <table class="tbl">
        <thead><tr>
          <th>候補者</th><th>紹介者</th><th>希望職種</th><th>確度</th><th>ネクストアクション</th><th>担当者</th><th></th>
        </tr></thead>
        <tbody>
          ${list.length ? list.map(rowReferral).join("") : `<tr><td colspan="7"><div class="empty">面談設定待ちのリファラルはありません。「リファラル取り込み」で同期してください</div></td></tr>`}
        </tbody>
      </table>
    </div>`;
}
function rowReferral(c) {
  return `
    <tr data-id="${c.id}">
      <td><div class="cell-name">
        <span class="avatar">${esc(initials(c.name))}</span>
        <div><div class="name">${esc(c.name)}</div><div class="sub muted">${esc(c.referralNote || "")}</div></div>
      </div></td>
      <td>${esc(c.referrer || "—")}<div class="sub muted" style="font-size:12px">${esc(c.referrerAttr || "")}</div></td>
      <td>${esc(c.desiredJob || "—")}</td>
      <td>${confChip(c.confidence)}</td>
      <td>${esc(c.nextAction || "—")}</td>
      <td>${c.advisorId ? esc(advisorName(c.advisorId)) : `<span class="muted">未割当</span>`}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-primary btn-sm" data-setup="${c.id}">面談設定</button>
      </td>
    </tr>`;
}
function bindReferrals() {
  $("#refSyncBtn")?.addEventListener("click", () => runSync());
  $$(".tbl tbody tr[data-id] [data-setup]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openMeetingSetup(b.dataset.setup); }));
  $$(".tbl tbody tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openMeetingSetup(tr.dataset.id)));
}
// 面談設定：担当者と日程を決めて 予約 ステージへ
function openMeetingSetup(id) {
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return;
  const advOpts = db.advisors.map((a) => `<option value="${a.id}" ${c.advisorId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  openModal(`
    <div class="modal-head"><div class="modal-title">面談設定：${esc(c.name)}</div><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0">紹介者：${esc(c.referrer || "—")}　／　希望職種：${esc(c.desiredJob || "—")}${c.referralNote ? `<br>補足：${esc(c.referralNote)}` : ""}</p>
      <div class="form-grid">
        <div class="field"><label class="field-label">面談日 *</label><input class="input" id="ms_date" type="date" value="${today()}" /></div>
        <div class="field"><label class="field-label">時刻</label><input class="input" id="ms_time" type="time" value="" /></div>
        <div class="field"><label class="field-label">担当者 *</label>
          <div class="select-wrap"><select class="select" id="ms_adv"><option value="">未割当</option>${advOpts}</select></div>
        </div>
        <div class="field"><label class="field-label">希望職種</label><input class="input" id="ms_job" value="${esc(c.desiredJob || "")}" /></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-danger btn-sm" onclick="closeReferral('${c.id}')">見送り</button>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary" onclick="saveMeetingSetup('${c.id}')">面談を設定（予約へ）</button>
      </div>
    </div>`);
  setTimeout(() => $("#ms_date")?.focus(), 50);
}
function saveMeetingSetup(id) {
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return;
  const date = $("#ms_date").value;
  if (!date) { toast("面談日を入力してください"); return; }
  const time = $("#ms_time").value;
  const adv = $("#ms_adv").value;
  c.advisorId = adv;
  c.desiredJob = $("#ms_job").value.trim();
  c.scheduledAt = date;
  c.scheduledText = `${date}${time ? " " + time : ""}`;
  c.stage = "booked";
  logActivity(c, `面談設定（${date}${time ? " " + time : ""}・担当:${adv ? advisorName(adv) : "未割当"}）でリファラル→予約へ`, "stage");
  saveDB(); closeModal(); render();
  toast(`${c.name} の面談を設定しました（予約へ）`);
}
function closeReferral(id) {
  const c = db.candidates.find((x) => x.id === id);
  if (!c) return;
  c.stage = "closed"; c.closeReason = "見送り"; c.updatedAt = today();
  logActivity(c, "リファラルを見送り", "stage");
  saveDB(); closeModal(); render(); toast(`${c.name} を見送りにしました`);
}

/* ---------------------- パイプライン（カンバン） ---------------------- */
function renderPipeline() {
  const cs = db.candidates.filter((c) => c.stage !== "closed" && inScope(c));
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
  if (newStage === "join") { c.joinedAt = today(); (c.applications || []).forEach((a) => syncAppSales(c, a)); }
  if (newStage === "left") c.leftAt = today();
  logActivity(c, `ステージを「${from}」→「${STAGE_MAP[newStage]?.label || CLOSED.label}」に変更`, "stage");
  saveDB();
  toast(`${c.name} を「${STAGE_MAP[newStage]?.label || CLOSED.label}」へ移動`);
}

// 社名を該当ステータスの選考(application)に反映。既存社は更新、未登録社は金額を自動算出して追加
function ensureApplication(c, name, status) {
  name = (name || "").trim(); if (!name) return null;
  c.applications = c.applications || [];
  let a = c.applications.find((x) => (x.company || "").trim() === name);
  const co = findCompanyByName(name);
  const { fee, feeInclTax } = computeCompanyFee(co, c);
  if (a) {
    a.status = status; a.updatedAt = today();
    if (!a.fee && fee) { a.fee = fee; a.feeInclTax = feeInclTax; } // 金額未入力なら自動補完
  } else {
    a = {
      id: uid(), company: name, status, fee, feeInclTax, refundAmount: 0, refundDate: "", conf: "B",
      segment: "CA", ownListing: true, partner: "", raName: "", via: "", billTo: "",
      invoiceStatus: "未請求", acceptMonth: "", acceptDate: "", invoiceMonth: "", dueMonth: "",
      paidAt: "", paidMonth: "", paidAmount: 0, createdAt: today(), updatedAt: today(),
    };
    c.applications.push(a); syncAppSales(c, a);
  }
  return a;
}
function parseCompanyNames(s) { return (s || "").split(/[,、，\n\r\/／･・\t]+/).map((x) => x.trim()).filter(Boolean); }

// 報告を記録（必要ならステージ遷移・終了処理・社名→選考反映も実施）
function logReport(id, key, note) {
  const c = db.candidates.find((x) => x.id === id); if (!c) return;
  const rt = REPORT_TYPES.find((r) => r.key === key); if (!rt) return;
  let detail = (note || "").trim();
  if (rt.companies) {
    const names = parseCompanyNames(note);
    if (!names.length) { toast("社名を入力してください（カンマ/改行区切り）"); return; }
    names.forEach((n) => ensureApplication(c, n, rt.companies));
    detail = names.join("・");
  }
  if (rt.stage && c.stage !== rt.stage) {
    c.stage = rt.stage;
    if (rt.stage === "join") { c.joinedAt = today(); (c.applications || []).forEach((a) => syncAppSales(c, a)); }
    if (rt.stage === "left") c.leftAt = today();
  }
  if (rt.close) { c.stage = "closed"; c.closeReason = rt.close; }
  c.activities = c.activities || [];
  c.activities.unshift({ id: uid(), date: today(), type: "report", text: `${rt.label}${detail ? `：${detail}` : ""}` });
  c.updatedAt = today();
  saveDB(); openDetail(id);
  toast(`報告を記録：${rt.label}`);
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
    if (!inScope(c)) return false;
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
function downloadCSV(filename, rows2d) {
  const csv = rows2d.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM付きでExcelの文字化け回避
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}
function exportCSV() {
  const list = filteredCandidates();
  const cols = ["氏名", "フリガナ", "メール", "電話", "流入経路", "ステージ", "担当者", "面談日時", "終了理由", "更新日"];
  const rows = list.map((c) => [
    c.name, c.kana || "", c.email || "", c.phone || "",
    sourceOf(c)?.label || "", stageLabelOf(c), advisorName(c.advisorId),
    c.scheduledText || "", c.closeReason || "", c.updatedAt || "",
  ]);
  const tag = filters.stage ? `_${(STAGE_MAP[filters.stage] || CLOSED).label}` : "";
  downloadCSV(`求職者一覧${tag}_${today()}.csv`, [cols, ...rows]);
  toast(`${list.length}件をCSVでダウンロードしました`);
}

// 未着座（予約したが着座しなかった）の理由プリセット
const NOSHOW_REASONS = ["ドタキャン", "日程変更希望", "連絡つかず", "他社決定", "条件不一致", "その他"];
// 予約日を過ぎても着座記録がなく、未着座として未処理の候補（要確認）
function isBookedOverdue(c) { return c.stage === "booked" && !!c.scheduledAt && c.scheduledAt < today() && !c.noShowReason; }
// 着座状況：着座/未着座/予約/キャンセル/終了
function seatingStatus(c) {
  const ord = STAGES.findIndex((s) => s.key === c.stage);
  if (c.stage !== "closed" && ord >= STAGES.findIndex((s) => s.key === "seated")) return "着座";
  if (c.noShowReason) return "未着座";
  if (c.stage === "closed") return /キャンセル|取消|取り消|cancel|no[\s-]?show|不参加/i.test(c.closeReason || "") ? "キャンセル" : "終了";
  return "予約"; // 予約済み・着座前
}
// 各流入経路の着座管理シートをダウンロード
function exportSeatingCSV(sourceKey) {
  const src = sources().find((s) => s.key === sourceKey);
  const list = db.candidates.filter((c) => c.source === sourceKey)
    .sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || "") || parseSchedTime(a.scheduledText).localeCompare(parseSchedTime(b.scheduledText)));
  const cols = ["面談日", "時刻", "氏名", "流入経路", "担当者", "ステージ", "着座状況", "終了理由", "メール", "電話"];
  const rows = list.map((c) => [
    c.scheduledAt || "", parseSchedTime(c.scheduledText) || "", c.name,
    src ? src.label : "", advisorName(c.advisorId), stageLabelOf(c),
    seatingStatus(c), c.closeReason || "", c.email || "", c.phone || "",
  ]);
  downloadCSV(`着座管理_${src ? src.label : sourceKey}_${today()}.csv`, [cols, ...rows]);
  const seated = list.filter((c) => seatingStatus(c) === "着座").length;
  toast(`${src ? src.label : ""} 着座管理シート：${list.length}件（着座${seated}）をDLしました`);
}

/* 未着座（予約したが着座しなかった方）の管理 */
function renderUnseatedPanel() {
  const cs = db.candidates.filter(inScope);
  const overdue = cs.filter(isBookedOverdue).sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
  const recorded = cs.filter((c) => !!c.noShowReason).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const reasonSel = (cur) => `<select class="select ns-reason"><option value="">理由を選択…</option>${NOSHOW_REASONS.map((r) => `<option ${r === cur ? "selected" : ""}>${r}</option>`).join("")}</select>`;
  const rowHtml = (c) => {
    const rec = !!c.noShowReason;
    return `<tr data-noshowrow="${c.id}">
      <td>${esc(c.name)}</td>
      <td>${esc(sourceOf(c)?.label || "—")}</td>
      <td>${c.scheduledAt ? fmtDate(c.scheduledAt) : "—"}</td>
      <td>${esc(advisorName(c.advisorId))}</td>
      <td><span class="badge" data-stage="${rec ? "closed" : "booked"}"><span class="dot"></span>${rec ? "未着座" : "要確認"}</span></td>
      <td><div class="select-wrap">${reasonSel(c.noShowReason || "")}</div></td>
      <td><input class="input ns-note" value="${esc(c.noShowNote || "")}" placeholder="補足（任意）" /></td>
      <td style="white-space:nowrap">
        <button class="btn btn-primary btn-sm" data-noshow="${c.id}">${rec ? "更新" : "未着座で記録"}</button>
        ${rec ? `<button class="btn btn-outline btn-sm" data-noshow-clear="${c.id}">予約に戻す</button>` : ""}
      </td>
    </tr>`;
  };
  const rows = [...overdue, ...recorded];
  const body = rows.length ? rows.map(rowHtml).join("") : `<tr><td colspan="8"><div class="empty">未着座・要確認の予約はありません</div></td></tr>`;
  return `
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="panel-title">未着座の管理（予約したが着座しなかった方）</div>
      <div class="filter-row">
        <span class="muted">要確認（予約日超過）<strong class="pos">${overdue.length}</strong> 件　／　未着座 記録済み <strong>${recorded.length}</strong> 件</span>
        <button class="btn btn-outline btn-sm" data-unseated-csv="1" style="margin-left:auto">⬇ 未着座CSV</button>
      </div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr><th>氏名</th><th>流入経路</th><th>予約日</th><th>担当</th><th>状況</th><th>未着座理由</th><th>補足</th><th></th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}
function markNoShow(id) {
  const c = db.candidates.find((x) => x.id === id); if (!c) return;
  const rowSel = `[data-noshowrow="${id}"]`;
  const reason = $(`${rowSel} .ns-reason`)?.value || "";
  const note = ($(`${rowSel} .ns-note`)?.value || "").trim();
  if (!reason) { toast("未着座の理由を選択してください"); return; }
  c.noShowReason = reason; c.noShowNote = note;
  c.stage = "closed"; c.closeReason = "未着座"; c.updatedAt = today();
  logActivity(c, `未着座として記録（理由：${reason}${note ? "／" + note : ""}）`, "stage");
  saveDB(); render(); toast(`${c.name} を未着座で記録しました`);
}
function clearNoShow(id) {
  const c = db.candidates.find((x) => x.id === id); if (!c) return;
  delete c.noShowReason; delete c.noShowNote;
  c.stage = "booked"; if (c.closeReason === "未着座") delete c.closeReason;
  c.updatedAt = today();
  logActivity(c, "未着座を解除し予約に戻した", "stage");
  saveDB(); render(); toast(`${c.name} を予約に戻しました`);
}
function exportUnseatedCSV() {
  const cs = db.candidates.filter(inScope).filter((c) => !!c.noShowReason || isBookedOverdue(c))
    .sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
  const cols = ["氏名", "流入経路", "予約日", "担当者", "状況", "未着座理由", "補足", "メール", "電話"];
  const rows = cs.map((c) => [
    c.name, sourceOf(c)?.label || "", c.scheduledAt || "", advisorName(c.advisorId),
    seatingStatus(c), c.noShowReason || "", c.noShowNote || "", c.email || "", c.phone || "",
  ]);
  downloadCSV(`未着座管理_${today()}.csv`, [cols, ...rows]);
  toast(`未着座管理 ${cs.length}件をCSVでダウンロードしました`);
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
        <div class="field"><label class="field-label">想定年収（円・金額算出用）</label><input class="input" id="f_expsalary" type="number" step="100000" value="${Number(c.expectedSalary) || 0}" placeholder="例：6000000" /></div>
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
        <div class="field"><label class="field-label">区分（中途/新卒）</label>
          <div class="select-wrap"><select class="select" id="f_emptype">${EMP_TYPES.map((t) => `<option value="${t}" ${empTypeOf(c) === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
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
    expectedSalary: Number($("#f_expsalary").value) || 0,
    skills: $("#f_skills").value.split(",").map((s) => s.trim()).filter(Boolean),
    company: $("#f_company").value.trim(),
    position: $("#f_position").value.trim(),
    advisorId: $("#f_advisor").value,
    source: $("#f_source").value,
    stage: $("#f_stage").value,
    empType: $("#f_emptype").value,
  };
  if (id) {
    const c = db.candidates.find((x) => x.id === id);
    const stageChanged = c.stage !== data.stage;
    const prev = stageOf(c).label;
    Object.assign(c, data);
    c.updatedAt = today();
    if (stageChanged) {
      if (data.stage === "join") { c.joinedAt = today(); (c.applications || []).forEach((a) => syncAppSales(c, a)); }
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

      <div class="section-label">報告する</div>
      <input class="input" id="reportNote" placeholder="報告メモ（任意。提案企業名・応諾企業・エントリー先など）" style="margin-bottom:8px" />
      <div class="filter-row" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
        ${REPORT_TYPES.map((rt) => `<button class="btn btn-outline btn-sm" onclick="logReport('${c.id}','${rt.key}',document.getElementById('reportNote').value)">📣 ${esc(rt.label)}</button>`).join("")}
      </div>

      <div class="section-label">求職者情報</div>
      <div class="form-grid">
        ${row("流入経路", sourceOf(c)?.label)}
        ${c.stage === "closed" ? row("終了理由", c.closeReason || "辞退・見送り") : ""}
        ${c.noShowReason ? row("未着座理由", c.noShowReason + (c.noShowNote ? `／${c.noShowNote}` : "")) : ""}
        ${row("メール", c.email)}
        ${row("電話", c.phone)}
        ${row("現職 / 経歴", c.currentJob)}
        ${row("希望職種", c.desiredJob)}
        ${row("希望年収", c.desiredSalary)}
        ${c.expectedSalary ? row("想定年収", fmtYen(c.expectedSalary)) : ""}
        ${row("紹介先企業", c.company)}
        ${row("ポジション", c.position)}
        ${skills}
      </div>

      <div class="section-label">選考企業（売上・読み）</div>
      ${renderApplications(c)}

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
  $$(".app-row .app-f").forEach((el) => el.addEventListener("change", () => updateApplication(c.id, el.closest(".app-row").dataset.app, el.dataset.f, el.value)));
  $$("[data-appadd]").forEach((b) => b.addEventListener("click", () => addApplication(b.dataset.appadd)));
  $$("[data-appdel]").forEach((b) => b.addEventListener("click", () => deleteApplication(c.id, b.dataset.appdel)));
}

/* 候補者の選考企業（売上・読み） */
function renderApplications(c) {
  const apps = c.applications || [];
  const statusOpt = (cur) => APP_STATUSES.map((s) => `<option ${s === cur ? "selected" : ""}>${s}</option>`).join("");
  const confOpt = (cur) => CONFIDENCE.map((x) => `<option value="${x.key}" ${x.key === cur ? "selected" : ""}>${x.label}</option>`).join("");
  const rows = apps.map((a) => `
    <div class="app-row" data-app="${a.id}">
      <input class="input app-f" data-f="company" value="${esc(a.company || "")}" placeholder="企業名" />
      <div class="select-wrap"><select class="select app-f" data-f="status">${statusOpt(a.status)}</select></div>
      <input class="input app-f" data-f="fee" type="number" min="0" step="10000" value="${Number(a.fee) || 0}" placeholder="想定売上" />
      <div class="select-wrap"><select class="select app-f" data-f="conf">${confOpt(a.conf)}</select></div>
      <span class="app-yomi">${fmtYen(appYomi(a))}</span>
      <button class="btn btn-danger btn-sm" data-appdel="${a.id}" title="削除">×</button>
    </div>`).join("");
  const totalFee = apps.filter((a) => a.status !== "見送り").reduce((s, a) => s + (Number(a.fee) || 0), 0);
  const totalYomi = apps.reduce((s, a) => s + appYomi(a), 0);
  return `
    <div class="app-list">
      <div class="app-head"><span>企業</span><span>選考ステータス</span><span>想定売上</span><span>確度</span><span>読み額</span><span></span></div>
      ${rows}
      ${apps.length ? `<div class="app-foot">想定売上計 ${fmtYen(totalFee)}　／　読み額計 <strong class="pos">${fmtYen(totalYomi)}</strong></div>` : `<div class="empty" style="padding:var(--sp-4)">提案企業がありません。「＋企業を追加」から登録してください</div>`}
    </div>
    <button class="btn btn-outline btn-sm" data-appadd="${c.id}" style="margin-top:8px">＋ 企業を追加</button>`;
}
function addApplication(candId) {
  const c = db.candidates.find((x) => x.id === candId); if (!c) return;
  (c.applications = c.applications || []).push({ id: uid(), company: "", status: "提案", fee: 0, feeInclTax: 0, refundAmount: 0, refundDate: "", conf: "B", segment: "未分類", ownListing: false, partner: "", raName: "", via: "", billTo: "", invoiceStatus: "未請求", acceptMonth: "", acceptDate: "", invoiceMonth: "", dueMonth: "", paidAt: "", paidMonth: "", paidAmount: 0, createdAt: today(), updatedAt: today() });
  saveDB(); openDetail(candId);
}
function updateApplication(candId, appId, field, value) {
  const c = db.candidates.find((x) => x.id === candId); if (!c) return;
  const a = (c.applications || []).find((x) => x.id === appId); if (!a) return;
  a[field] = field === "fee" ? (Number(value) || 0) : value;
  a.updatedAt = today(); c.updatedAt = today();
  if (field === "status") { logActivity(c, `${a.company || "企業"}：選考を「${value}」に更新`, "stage"); syncAppSales(c, a); }
  saveDB(); openDetail(candId);
}
function deleteApplication(candId, appId) {
  const c = db.candidates.find((x) => x.id === candId); if (!c) return;
  c.applications = (c.applications || []).filter((x) => x.id !== appId);
  saveDB(); openDetail(candId);
}

/* ---------------------- 読み票（売上） ---------------------- */
function allApplications() {
  const out = [];
  db.candidates.forEach((c) => { if (inScope(c)) (c.applications || []).forEach((a) => out.push({ c, a })); });
  return out;
}
function renderYomi() {
  const order = (st) => STAGES.findIndex((s) => s.key === st);
  const scoped = db.candidates.filter(inScope);
  const activeCands = scoped.filter((c) => c.stage !== "closed" && c.stage !== "referral" && c.stage !== "left");
  // 選考ファネル（候補者単位）
  const seatedCnt = activeCands.filter((c) => order(c.stage) >= order("seated")).length;
  const onSelCnt = scoped.filter((c) => hasAppIn(c, SELECTION_SET)).length;
  const offerCnt = scoped.filter((c) => hasAppIn(c, OFFER_SET)).length;
  const joinedCnt = scoped.filter((c) => hasAppIn(c, ["入社"])).length;
  const funnel = [
    { label: "着座", value: seatedCnt, foot: "着座以降の稼働中" },
    { label: "選考中（一次面接以上）", value: onSelCnt, foot: "どこかしら選考に乗っている" },
    { label: "内定以上", value: offerCnt, foot: "内定・承諾・入社" },
    { label: "入社（決定）", value: joinedCnt, foot: "入社確定" },
  ];

  // 売上（見送りを除く全進行中）
  const active = allApplications().filter((r) => r.a.status !== "見送り");
  const totalFee = active.reduce((s, r) => s + (Number(r.a.fee) || 0), 0);
  const totalYomi = active.reduce((s, r) => s + appYomi(r.a), 0);
  const confirmed = active.filter((r) => r.a.status === "入社").reduce((s, r) => s + (Number(r.a.fee) || 0), 0);
  const byConf = CONFIDENCE.map((cf) => active.filter((r) => r.a.status !== "入社" && r.a.conf === cf.key).reduce((s, r) => s + appYomi(r.a), 0));
  const sales = [
    { label: "確定売上（入社）", value: fmtYen(confirmed), foot: `${active.filter((r) => r.a.status === "入社").length} 件` },
    { label: "読み額 合計", value: fmtYen(totalYomi), foot: "確定＋進行中の読み" },
    { label: "想定売上 合計", value: fmtYen(totalFee), foot: `進行中 ${active.length} 件` },
    { label: "確度別 読み", value: "", foot: CONFIDENCE.map((cf, i) => `${cf.key} ${fmtYen(byConf[i])}`).join("　") },
  ];

  // テーブル：絞り込み適用
  const flt = YOMI_FILTERS.find((f) => f.key === yomiFilter) || YOMI_FILTERS[0];
  const rows = allApplications().filter((r) => flt.match(r.a)).sort((x, y) => appYomi(y.a) - appYomi(x.a));
  const fFee = rows.reduce((s, r) => s + (Number(r.a.fee) || 0), 0);
  const fYomi = rows.reduce((s, r) => s + appYomi(r.a), 0);
  const card = (k) => `<div class="card kpi"><div class="kpi-label">${k.label}</div><div class="kpi-value" style="font-size:24px">${k.value}</div><div class="kpi-foot">${k.foot}</div></div>`;
  const chip = (f) => `<button class="btn btn-sm ${yomiFilter === f.key ? "btn-primary" : "btn-outline"}" data-yomif="${f.key}">${f.label} ${allApplications().filter((r) => f.match(r.a)).length}</button>`;

  return `
    <div class="kpi-grid">${funnel.map(card).join("")}</div>
    <div class="kpi-grid" style="margin-top:var(--sp-4)">${sales.map(card).join("")}</div>
    <div class="filter-row">
      <div class="seg">${YOMI_FILTERS.map(chip).join("")}</div>
      <button class="btn btn-outline btn-sm" id="yomiCsv" style="margin-left:auto">⬇ 読み票CSV</button>
    </div>
    <div class="card table-wrap">
      <table class="tbl">
        <thead><tr>
          <th>候補者</th><th>企業</th><th>選考ステータス</th><th>担当者</th><th style="text-align:right">想定売上</th><th>確度</th><th style="text-align:right">読み額</th>
        </tr></thead>
        <tbody>
          ${rows.length ? rows.map(({ c, a }) => `
            <tr data-id="${c.id}">
              <td>${esc(c.name)}</td>
              <td>${esc(a.company || "—")}</td>
              <td><span class="badge" data-stage="${a.status === "入社" ? "join" : OFFER_SET.includes(a.status) ? "offer" : a.status === "見送り" ? "closed" : "screen"}"><span class="dot"></span>${esc(a.status)}</span></td>
              <td>${esc(advisorName(c.advisorId))}</td>
              <td style="text-align:right">${fmtYen(a.fee)}</td>
              <td>${a.status === "入社" ? "確定" : esc((CONFIDENCE.find((x) => x.key === a.conf) || {}).label || a.conf || "")}</td>
              <td style="text-align:right"><strong>${fmtYen(appYomi(a))}</strong></td>
            </tr>`).join("") : `<tr><td colspan="7"><div class="empty">該当する選考企業がありません</div></td></tr>`}
        </tbody>
        ${rows.length ? `<tfoot><tr class="yomi-total">
          <td colspan="4">合計（${rows.length}件）</td>
          <td style="text-align:right">${fmtYen(fFee)}</td><td></td>
          <td style="text-align:right"><strong class="pos">${fmtYen(fYomi)}</strong></td>
        </tr></tfoot>` : ""}
      </table>
    </div>`;
}
function bindYomi() {
  $$("[data-yomif]").forEach((b) => b.addEventListener("click", () => { yomiFilter = b.dataset.yomif; render(); }));
  $("#yomiCsv")?.addEventListener("click", exportYomiCSV);
  $$(".tbl tbody tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
}
function exportYomiCSV() {
  const active = allApplications().filter((r) => r.a.status !== "見送り").sort((x, y) => appYomi(y.a) - appYomi(x.a));
  const cols = ["候補者", "企業", "選考ステータス", "担当者", "想定売上", "確度", "読み額", "更新日"];
  const rows = active.map(({ c, a }) => [
    c.name, a.company || "", a.status, advisorName(c.advisorId),
    Number(a.fee) || 0, a.status === "入社" ? "確定" : a.conf || "", appYomi(a), a.updatedAt || "",
  ]);
  downloadCSV(`読み票_${today()}.csv`, [cols, ...rows]);
  toast(`読み票 ${active.length}件をCSVでダウンロードしました`);
}

/* ---------------------- 売上管理（月次・目標・着金） ---------------------- */
// inScope 内の承諾以上（計上対象）案件。seg 指定で事業フィルタ
function recognizedApps(seg) {
  const list = allApplications().filter((r) => RECOGNIZED_SET.includes(r.a.status));
  return (seg && seg !== "all") ? list.filter((r) => segOf(r.a) === seg) : list;
}
// 当月（YYYY-MM）の各種集計。返金は refundMonth に税抜返金額をマイナス計上
function salesMonthAgg(m, seg) {
  const apps = recognizedApps(seg);
  const gross = apps.filter((r) => r.a.acceptMonth === m).reduce((s, r) => s + salesRecognized(r.a), 0);
  const refunded = apps.filter((r) => refundMonth(r.a) === m && r.a.invoiceStatus === "返金").reduce((s, r) => s + salesRefund(r.a), 0);
  const recognized = gross - refunded; // 計上のうえマイナス計上
  const dueOpen = apps.filter((r) => r.a.dueMonth === m && r.a.invoiceStatus !== "入金済" && r.a.invoiceStatus !== "返金");
  const due = dueOpen.reduce((s, r) => s + (Number(r.a.fee) || 0), 0);
  const received = apps.filter((r) => r.a.invoiceStatus === "入金済" && monthOf(r.a.paidAt) === m).reduce((s, r) => s + (Number(r.a.paidAmount) || 0), 0);
  return { recognized, gross, refunded, due, dueCount: dueOpen.length, received };
}
function monthTarget(m) { return (db.targets && db.targets[m]) || { all: 0, byAdvisor: {} }; }

function renderSales() {
  const m = salesMonth;
  const team = isTeamView();
  const seg = salesSeg;
  const agg = salesMonthAgg(m, seg);
  const tgt = monthTarget(m);
  const targetAll = Number(tgt.all) || 0;
  const rate = targetAll ? Math.round((agg.recognized / targetAll) * 100) : 0;

  // 事業フィルタ（CA/PCA/PCAシェア）。件数は当月計上ベース
  const segKeys = ["all", ...SEGMENTS];
  const segCount = (k) => recognizedApps(k === "all" ? "all" : k).filter((r) => r.a.acceptMonth === m).length;
  const segChips = `<div class="filter-row"><div class="seg">${segKeys.map((k) => `<button class="btn btn-sm ${seg === k ? "btn-primary" : "btn-outline"}" data-salesseg="${k}">${k === "all" ? "全事業" : segLabel(k)} ${segCount(k)}</button>`).join("")}</div></div>`;

  // 月セレクタ
  const monthBar = `
    <div class="filter-row" style="align-items:center">
      <div class="month-nav">
        <button class="btn btn-outline btn-sm" data-salesnav="-1">◀</button>
        <span class="month-label">${fmtMonth(m)}</span>
        <button class="btn btn-outline btn-sm" data-salesnav="1">▶</button>
        <button class="btn btn-outline btn-sm" data-salesnav="0">今月</button>
      </div>
      <span class="muted" style="margin-left:8px">${team ? "チーム全体" : "自分の担当のみ"}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        ${team ? `<button class="btn btn-outline btn-sm" id="salesTarget">🎯 目標を設定</button>` : ""}
        <button class="btn btn-outline btn-sm" id="salesCsv">⬇ 売上CSV</button>
      </div>
    </div>`;

  // 当月サマリ KPI
  const card = (label, value, foot) => `<div class="card kpi"><div class="kpi-label">${label}</div><div class="kpi-value" style="font-size:24px">${value}</div><div class="kpi-foot">${foot}</div></div>`;
  const kpis = `
    <div class="kpi-grid">
      ${card("当月計上（税抜・確定）", fmtYen(agg.recognized), agg.refunded ? `総計上 ${fmtYen(agg.gross)}／返金 -${fmtYen(agg.refunded)}` : "内定承諾月で計上")}
      ${card("当月目標", targetAll ? fmtYen(targetAll) : "未設定", team ? "目標を設定で編集" : "管理者が設定")}
      ${card("達成率", targetAll ? `${rate}%` : "—", targetAll ? `残り ${fmtYen(Math.max(0, targetAll - agg.recognized))}` : "目標未設定")}
      ${card("当月入金予定", fmtYen(agg.due), `${agg.dueCount}件 ／ 着金済 ${fmtYen(agg.received)}`)}
    </div>`;

  // 目標対比プログレスバー
  const pct = Math.min(100, rate);
  const barColor = rate >= 100 ? "var(--stage-join)" : rate >= 70 ? "var(--warning)" : "var(--stage-screen)";
  const progress = targetAll ? `
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="panel-title">目標対比（${fmtMonth(m)}）</div>
      <div class="funnel-row" style="grid-template-columns:120px 1fr 120px">
        <div class="funnel-name">計上 / 目標</div>
        <div class="funnel-bar" style="height:30px"><div class="funnel-fill" style="width:${pct}%;background:${barColor}"></div></div>
        <div class="funnel-count">${rate}%</div>
      </div>
      <div class="src-note">${fmtYen(agg.recognized)} / ${fmtYen(targetAll)}（着地見込み込み参考：読み票を参照）</div>
    </div>` : `
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="empty">${m} の目標が未設定です。${team ? "「🎯 目標を設定」から登録してください。" : "管理者が設定すると達成率を表示します。"}</div>
    </div>`;

  return `
    ${monthBar}
    ${segChips}
    ${kpis}
    ${progress}
    ${renderSalesBySegment(m)}
    ${renderSalesByAdvisor(m, team, seg)}
    ${renderSalesByCompany(m, seg)}
    ${renderSettlementTable(m, seg)}`;
}

// 事業別 内訳（CA/PCA/PCAシェア/未分類）
function renderSalesBySegment(m) {
  const apps = recognizedApps("all").filter((r) => r.a.acceptMonth === m);
  const rows = SEGMENTS.map((sg) => ({
    sg, val: apps.filter((r) => segOf(r.a) === sg).reduce((s, r) => s + salesRecognized(r.a), 0),
    n: apps.filter((r) => segOf(r.a) === sg).length,
  })).filter((r) => r.val > 0 || r.n > 0).sort((a, b) => b.val - a.val);
  if (!rows.length) return "";
  const max = Math.max(1, ...rows.map((r) => r.val));
  const colors = { CA: "var(--stage-join)", PCA: "var(--stage-screen)", PCAシェア: "var(--stage-offer)", 未分類: "var(--stage-closed)" };
  return `
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="panel-title">事業別 売上（${fmtMonth(m)}・税抜計上）</div>
      <div class="funnel">
        ${rows.map((r) => `
          <div class="funnel-row" style="grid-template-columns:120px 1fr 150px">
            <div class="funnel-name">${segLabel(r.sg)}</div>
            <div class="funnel-bar"><div class="funnel-fill" style="width:${(r.val / max) * 100}%;background:${colors[r.sg] || "var(--stage-screen)"}"></div></div>
            <div class="funnel-count">${fmtYen(r.val)} <span class="muted">/${r.n}件</span></div>
          </div>`).join("")}
      </div>
    </div>`;
}

// 担当(CA)別 内訳（チーム閲覧時のみ）
function renderSalesByAdvisor(m, team, seg) {
  if (!team) return "";
  const apps = recognizedApps(seg).filter((r) => r.a.acceptMonth === m);
  const tgt = monthTarget(m);
  const rows = db.advisors.map((adv) => {
    const val = apps.filter((r) => r.c.advisorId === adv.id).reduce((s, r) => s + salesRecognized(r.a), 0);
    const at = Number((tgt.byAdvisor || {})[adv.id]) || 0;
    return { adv, val, at, rate: at ? Math.round((val / at) * 100) : 0 };
  }).filter((r) => r.val > 0 || r.at > 0).sort((a, b) => b.val - a.val);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.val, r.at)));
  if (!rows.length) return `<div class="card panel" style="margin-top:var(--sp-4)"><div class="panel-title">担当(CA)別 売上</div><div class="empty">当月の計上・目標がありません</div></div>`;
  return `
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="panel-title">担当(CA)別 売上（${fmtMonth(m)}）</div>
      <div class="funnel">
        ${rows.map((r) => `
          <div class="funnel-row" style="grid-template-columns:110px 1fr 150px">
            <div class="funnel-name">${esc(r.adv.name)}</div>
            <div class="funnel-bar"><div class="funnel-fill" style="width:${(r.val / max) * 100}%;background:${advisorColor(r.adv.id)}"></div></div>
            <div class="funnel-count">${fmtYen(r.val)}${r.at ? ` <span class="muted">/${r.rate}%</span>` : ""}</div>
          </div>`).join("")}
      </div>
    </div>`;
}

// 企業別 内訳
function renderSalesByCompany(m, seg) {
  const apps = recognizedApps(seg).filter((r) => r.a.acceptMonth === m);
  const byCo = {};
  apps.forEach((r) => { const k = r.a.company || "（企業名なし）"; (byCo[k] = byCo[k] || { val: 0, n: 0 }); byCo[k].val += salesRecognized(r.a); byCo[k].n++; });
  let rows = Object.entries(byCo).map(([co, v]) => ({ co, ...v })).sort((a, b) => b.val - a.val);
  const TOP = 8;
  if (rows.length > TOP) {
    const rest = rows.slice(TOP);
    rows = rows.slice(0, TOP);
    rows.push({ co: `その他 ${rest.length}社`, val: rest.reduce((s, r) => s + r.val, 0), n: rest.reduce((s, r) => s + r.n, 0) });
  }
  const max = Math.max(1, ...rows.map((r) => r.val));
  if (!rows.length) return `<div class="card panel" style="margin-top:var(--sp-4)"><div class="panel-title">企業別 売上</div><div class="empty">当月の計上がありません</div></div>`;
  return `
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="panel-title">企業別 売上（${fmtMonth(m)}）</div>
      <div class="funnel">
        ${rows.map((r, i) => `
          <div class="funnel-row" style="grid-template-columns:160px 1fr 150px">
            <div class="funnel-name" title="${esc(r.co)}">${esc(r.co)}</div>
            <div class="funnel-bar"><div class="funnel-fill" style="width:${(r.val / max) * 100}%;background:${SOURCE_PALETTE[i % SOURCE_PALETTE.length]}"></div></div>
            <div class="funnel-count">${fmtYen(r.val)} <span class="muted">/${r.n}件</span></div>
          </div>`).join("")}
      </div>
    </div>`;
}

// 着金管理テーブル（行内編集）
const SALES_PAY_FILTERS = [
  { key: "all",      label: "すべて",        match: () => true },
  { key: "未請求",   label: "未請求",        match: (a) => a.invoiceStatus === "未請求" },
  { key: "発行済",   label: "発行済",        match: (a) => a.invoiceStatus === "発行済" },
  { key: "送付済",   label: "送付済",        match: (a) => a.invoiceStatus === "送付済" },
  { key: "入金済",   label: "入金済",        match: (a) => a.invoiceStatus === "入金済" },
  { key: "返金",     label: "返金",          match: (a) => a.invoiceStatus === "返金" },
  { key: "dueThis",  label: "当月入金予定",  match: (a) => a.dueMonth === salesMonth && a.invoiceStatus !== "入金済" && a.invoiceStatus !== "返金" },
];
function renderSettlementTable(m, seg) {
  const base = recognizedApps(seg);
  const flt = SALES_PAY_FILTERS.find((f) => f.key === salesPayFilter) || SALES_PAY_FILTERS[0];
  const rows = base.filter((r) => flt.match(r.a)).sort((x, y) => (x.a.dueMonth || "9999").localeCompare(y.a.dueMonth || "9999"));
  const statusOpt = (cur) => INVOICE_STATUSES.map((s) => `<option ${s === cur ? "selected" : ""}>${s}</option>`).join("");
  const chip = (f) => `<button class="btn btn-sm ${salesPayFilter === f.key ? "btn-primary" : "btn-outline"}" data-salespay="${f.key}">${f.label} ${base.filter((r) => f.match(r.a)).length}</button>`;
  const body = rows.length ? rows.map(({ c, a }) => `
    <tr data-id="${c.id}">
      <td>${esc(c.name)}</td>
      <td>${esc(a.company || "—")}</td>
      <td><span class="badge" data-stage="${segOf(a) === "CA" ? "join" : "screen"}">${esc(segLabel(segOf(a)))}</span></td>
      <td>${fmtMonth(a.acceptMonth)}</td>
      <td style="text-align:right">${fmtYen(a.fee)}</td>
      <td style="text-align:right">${a.refundAmount ? `<span class="neg">-${fmtYen(a.refundAmount)}</span>` : "—"}</td>
      <td><div class="select-wrap"><select class="select sale-f" data-cand="${c.id}" data-app="${a.id}" data-f="invoiceStatus">${statusOpt(a.invoiceStatus)}</select></div></td>
      <td><input class="input sale-f" type="month" data-cand="${c.id}" data-app="${a.id}" data-f="invoiceMonth" value="${a.invoiceMonth || ""}" /></td>
      <td><input class="input sale-f" type="month" data-cand="${c.id}" data-app="${a.id}" data-f="dueMonth" value="${a.dueMonth || ""}" /></td>
      <td><input class="input sale-f" type="date" data-cand="${c.id}" data-app="${a.id}" data-f="paidAt" value="${a.paidAt || ""}" /></td>
      <td style="text-align:right"><input class="input sale-f" type="number" step="10000" style="text-align:right;max-width:110px" data-cand="${c.id}" data-app="${a.id}" data-f="paidAmount" value="${Number(a.paidAmount) || 0}" /></td>
    </tr>`).join("") : `<tr><td colspan="11"><div class="empty">該当する案件がありません</div></td></tr>`;
  return `
    <div class="card panel" style="margin-top:var(--sp-4)">
      <div class="panel-title">着金管理（請求書発行 → 送付 → 着金）</div>
      <div class="filter-row"><div class="seg">${SALES_PAY_FILTERS.map(chip).join("")}</div></div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>候補者</th><th>企業</th><th>事業</th><th>計上月</th><th style="text-align:right">税抜</th><th style="text-align:right">返金</th><th>請求状態</th><th>請求月</th><th>入金予定月</th><th>着金日</th><th style="text-align:right">着金額</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function bindSales() {
  $$("[data-salesnav]").forEach((b) => b.addEventListener("click", () => {
    const d = Number(b.dataset.salesnav);
    salesMonth = d === 0 ? thisMonth() : shiftMonthDate(`${salesMonth}-01`, d).slice(0, 7);
    render();
  }));
  $$("[data-salespay]").forEach((b) => b.addEventListener("click", () => { salesPayFilter = b.dataset.salespay; render(); }));
  $$("[data-salesseg]").forEach((b) => b.addEventListener("click", () => { salesSeg = b.dataset.salesseg; render(); }));
  $("#salesTarget")?.addEventListener("click", openTargetModal);
  $("#salesCsv")?.addEventListener("click", exportSalesCSV);
  // 行内編集（select/input の change で保存）。入力欄クリックは行遷移させない
  $$(".sale-f").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("change", () => updateSaleField(el.dataset.cand, el.dataset.app, el.dataset.f, el.value));
  });
  $$(".tbl tbody tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
}

function updateSaleField(candId, appId, field, value) {
  const c = db.candidates.find((x) => x.id === candId); if (!c) return;
  const a = (c.applications || []).find((x) => x.id === appId); if (!a) return;
  a[field] = field === "paidAmount" ? (Number(value) || 0) : value;
  if (field === "invoiceMonth") a.dueMonth = nextMonth(value); // 請求月→翌月末を再計算
  if (field === "invoiceStatus" && value === "入金済") {
    if (!a.paidAt) a.paidAt = today();
    if (!a.paidAmount) a.paidAmount = Number(a.fee) || 0;
  }
  a.updatedAt = today(); c.updatedAt = today();
  saveDB(); render();
  toast(`${c.name}／${a.company || "企業"}：${field} を更新`);
}

function openTargetModal() {
  const m = salesMonth;
  const tgt = monthTarget(m);
  const advRows = db.advisors.map((adv) => `
    <div class="field"><label class="field-label">${esc(adv.name)}</label>
      <input class="input" type="number" step="100000" id="tgt_${adv.id}" value="${Number((tgt.byAdvisor || {})[adv.id]) || 0}" /></div>`).join("");
  openModal(`
    <div class="modal-head"><div class="modal-title">売上目標（${fmtMonth(m)}）</div><button class="modal-close" onclick="closeModal()">×</button></div>
    <div class="modal-body">
      <div class="section-label">全体目標</div>
      <div class="form-grid">
        <div class="field full"><label class="field-label">当月の全体目標（円）</label>
          <input class="input" type="number" step="100000" id="tgt_all" value="${Number(tgt.all) || 0}" /></div>
      </div>
      <div class="section-label">担当(CA)別 目標</div>
      <div class="form-grid">${advRows}</div>
    </div>
    <div class="modal-foot"><span></span><div style="display:flex;gap:8px">
      <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary" onclick="saveTarget('${m}')">保存する</button>
    </div></div>`);
}

function saveTarget(m) {
  const byAdvisor = {};
  db.advisors.forEach((adv) => { const v = Number($(`#tgt_${adv.id}`)?.value) || 0; if (v) byAdvisor[adv.id] = v; });
  db.targets = db.targets || {};
  db.targets[m] = { all: Number($("#tgt_all")?.value) || 0, byAdvisor };
  saveDB(); closeModal(); render(); toast(`${fmtMonth(m)} の目標を保存しました`);
}

function exportSalesCSV() {
  const m = salesMonth;
  const rows = recognizedApps(salesSeg).sort((x, y) => (x.a.dueMonth || "9999").localeCompare(y.a.dueMonth || "9999"));
  const cols = ["候補者", "企業", "事業", "自社求人", "担当者", "計上月", "税抜", "税込", "返金(税抜)", "請求状態", "請求月", "入金予定月", "着金日", "着金額"];
  const data = rows.map(({ c, a }) => [
    c.name, a.company || "", segLabel(segOf(a)), a.ownListing ? "自社求人" : "求人貸し", advisorName(c.advisorId), a.acceptMonth || "",
    Number(a.fee) || 0, Number(a.feeInclTax) || 0, Number(a.refundAmount) || 0, a.invoiceStatus || "", a.invoiceMonth || "", a.dueMonth || "", a.paidAt || "", Number(a.paidAmount) || 0,
  ]);
  downloadCSV(`売上管理_${m}.csv`, [cols, ...data]);
  toast(`売上管理 ${rows.length}件をCSVでダウンロードしました`);
}

/* ---------------------- 企業マスタ ---------------------- */
function companyUsageCount(name) {
  const n = (name || "").trim();
  return db.candidates.reduce((s, c) => s + (c.applications || []).filter((a) => (a.company || "").trim() === n).length, 0);
}
function renderCompanies() {
  const list = companyList().slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
  const f = (id, field, val, type = "text", step = "") => `<input class="input co-f" data-co="${id}" data-f="${field}" type="${type}" ${step ? `step="${step}"` : ""} value="${type === "number" ? (Number(val) || 0) : esc(val || "")}" />`;
  const body = list.length ? list.map((co) => `
    <tr data-co="${co.id}">
      <td>${f(co.id, "name", co.name)}</td>
      <td style="text-align:right">${f(co.id, "fixedFee", co.fixedFee, "number", "10000")}</td>
      <td style="text-align:right">${f(co.id, "feeRate", co.feeRate, "number", "1")}</td>
      <td style="text-align:right">${f(co.id, "taxRate", co.taxRate, "number", "1")}</td>
      <td>${f(co.id, "note", co.note)}</td>
      <td style="text-align:right">${companyUsageCount(co.name)}</td>
      <td><button class="btn btn-danger btn-sm" data-codel="${co.id}" title="削除">×</button></td>
    </tr>`).join("") : `<tr><td colspan="7"><div class="empty">企業がありません。「＋ 企業を追加」から登録してください</div></td></tr>`;
  return `
    <div class="filter-row">
      <span class="muted">提案報告時、ここの「固定額」または「料率×想定年収」で金額を自動算出します（固定額が優先）</span>
      <button class="btn btn-primary btn-sm" id="coAdd" style="margin-left:auto">＋ 企業を追加</button>
    </div>
    <div class="card table-wrap">
      <table class="tbl">
        <thead><tr>
          <th>企業名</th><th style="text-align:right">固定額(税抜)</th><th style="text-align:right">料率%</th><th style="text-align:right">税率%</th><th>メモ</th><th style="text-align:right">利用件数</th><th></th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}
function bindCompanies() {
  $("#coAdd")?.addEventListener("click", addCompany);
  $$(".co-f").forEach((el) => el.addEventListener("change", () => updateCompany(el.dataset.co, el.dataset.f, el.value)));
  $$("[data-codel]").forEach((b) => b.addEventListener("click", () => deleteCompany(b.dataset.codel)));
}
function addCompany() {
  companyList().push({ id: uid(), name: "", fixedFee: 0, feeRate: DEFAULT_FEE_RATE, taxRate: DEFAULT_TAX_RATE, note: "" });
  saveDB(); render(); toast("企業を追加しました（企業名・金額を入力してください）");
}
function updateCompany(id, field, value) {
  const co = companyList().find((x) => x.id === id); if (!co) return;
  co[field] = ["fixedFee", "feeRate", "taxRate"].includes(field) ? (Number(value) || 0) : value;
  saveDB(); render();
}
function deleteCompany(id) {
  const co = companyList().find((x) => x.id === id); if (!co) return;
  if (!confirm(`「${co.name || "(無題)"}」を企業マスタから削除しますか？`)) return;
  db.companies = companyList().filter((x) => x.id !== id);
  saveDB(); render(); toast("企業を削除しました");
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
// リファラルシート用の列（日程・担当未定の獲得シート）
const REFERRAL_COLS = {
  name:        ["候補者名", "氏名", "名前", "お名前"],
  referrer:    ["紹介者"],
  desiredJob:  ["希望職種", "希望"],
  confidence:  ["確度"],
  nextAction:  ["ネクストアクション", "次のアクション"],
  note:        ["その他補足情報", "補足", "備考", "メモ", "コメント"],
  sender:      ["送信者"],
  timestamp:   ["タイムスタンプ", "timestamp"],
  referrerAttr:["紹介者属性"],
  advisor:     ["面談担当者", "担当者", "担当"],
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
function pickCol(obj, aliases) {
  aliases = aliases || [];
  // 1) ヘッダー名の完全一致を優先（正常なシート）
  for (const a of aliases) if (a in obj && obj[a] !== "") return obj[a];
  // 2) 「列名 + スペース + データ連結」の壊れたヘッダーにも対応（前方一致）
  const keys = Object.keys(obj);
  for (const a of aliases) for (const k of keys) {
    if (k.startsWith(a + " ") && obj[k] !== "") return obj[k];
  }
  return "";
}
function colRef(obj, field) { return pickCol(obj, REFERRAL_COLS[field]); }
function colVal(obj, field) {
  return pickCol(obj, SYNC_COLS[field]);
}

// 旧バージョンの単一URLを timerex 経路へ移行（既存ユーザーの設定を引き継ぐ）
(function migrateLegacySyncUrl() {
  const legacy = localStorage.getItem(SYNC_URL_KEY);
  if (legacy && !sources().some((s) => s.csvUrl)) {
    const tx = sources().find((s) => s.key === "timerex") || sources()[0];
    if (tx) { tx.csvUrl = legacy; saveDB(); }
  }
})();

// 売上管理フィールドの後方互換補完（既存データに計上月・請求/着金情報を後付け）
(function migrateSalesFields() {
  if (db.targets == null) db.targets = {};
  if (db.companies == null) db.companies = [];
  let changed = false;
  (db.candidates || []).forEach((c) => {
    if (c.empType == null) { c.empType = "中途"; changed = true; }
    (c.applications || []).forEach((a) => {
      if (a.invoiceStatus == null) { a.invoiceStatus = "未請求"; changed = true; }
      if (a.invoiceStatus === "請求済") { a.invoiceStatus = "発行済"; changed = true; } // 4→5段階の読み替え
      if (a.paidAmount == null || a.paidAmount === 0) a.paidAmount = Number(a.fee) || 0;
      // 売上拡張フィールドの後付け
      if (a.segment == null) { a.segment = "未分類"; changed = true; }
      if (a.feeInclTax == null) { a.feeInclTax = Number(a.fee) || 0; changed = true; }
      ["acceptMonth", "acceptDate", "invoiceMonth", "dueMonth", "paidAt", "paidMonth", "refundDate", "partner", "raName", "via", "billTo"].forEach((k) => { if (a[k] == null) { a[k] = ""; changed = true; } });
      if (a.refundAmount == null) { a.refundAmount = 0; changed = true; }
      if (a.ownListing == null) { a.ownListing = false; changed = true; }
      if (RECOGNIZED_SET.includes(a.status)) {
        if (!a.acceptMonth) { a.acceptMonth = monthOf(c.joinedAt) || monthOf(a.updatedAt) || thisMonth(); changed = true; }
        // 請求月：新卒=承諾月／中途=入社月（未入社なら保留＝空）
        if (!a.invoiceMonth) {
          const inv = empTypeOf(c) === "新卒" ? a.acceptMonth : monthOf(c.joinedAt);
          if (inv) { a.invoiceMonth = inv; changed = true; }
        }
        if (a.invoiceMonth && !a.dueMonth) { a.dueMonth = nextMonth(a.invoiceMonth); changed = true; }
        if (a.status === "入社" && a.invoiceStatus === "未請求") { a.invoiceStatus = "発行済"; changed = true; }
      }
    });
  });
  if (changed) saveDB();
})();

// 業務フロー再設計に伴うステージ・選考ステータスの後方互換変換
(function migrateLegacyStages() {
  let changed = false;
  (db.candidates || []).forEach((c) => {
    if (c.stage === "refund") { c.stage = "join"; changed = true; } // 返金規定クリア廃止→入社へ寄せる
    (c.applications || []).forEach((a) => {
      if (a.status === "書類選考") { a.status = "書類回収"; changed = true; }
    });
  });
  if (changed) saveDB();
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

// リファラル行を取り込む（日程・担当未定の「リファラル」段階で登録）
function importReferralRow(o, src) {
  const name = colRef(o, "name");
  if (!name) return "empty";
  const ts = colRef(o, "timestamp"), sender = colRef(o, "sender");
  const extId = `${src.key}|${name}|${ts}|${sender}`;
  if (db.candidates.find((c) => c.extId === extId)) return "dup";
  const advNm = colRef(o, "advisor");
  const c = {
    id: uid(), name, kana: "", email: "", phone: "",
    currentJob: "", desiredJob: colRef(o, "desiredJob"), desiredSalary: "", skills: [],
    company: "", position: "", advisorId: advNm ? findOrCreateAdvisor(advNm) : "",
    source: src.key, extId, stage: "referral",
    scheduledAt: "", scheduledText: "",
    referrer: colRef(o, "referrer"), confidence: colRef(o, "confidence"),
    nextAction: colRef(o, "nextAction"), sender, referrerAttr: colRef(o, "referrerAttr"),
    referralNote: colRef(o, "note"),
    createdAt: parseSchedDate(ts) || today(), updatedAt: today(), activities: [],
  };
  logActivity(c, `リファラル獲得（紹介者:${colRef(o, "referrer") || "—"}）${c.nextAction ? `／次:${c.nextAction}` : ""}`, "create");
  db.candidates.unshift(c);
  return "added";
}

const SYNC_BUILD = "sync-v16"; // ビルド識別（ページが最新JSかの確認用）
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
      const imp = s.kind === "referral" ? importReferralRow : importRow;
      objs.forEach((o) => { const r = imp(o, s); t[r]++; per[r]++; });
      console.log(`[${SYNC_BUILD}] 「${s.label}」: ${objs.length}行 →`, per);
      results.push(`${s.label}+${per.added + per.cancelled}`);
    } catch (e) { console.error(`[${SYNC_BUILD}] 取得失敗:`, s.label, e); failed++; results.push(`${s.label}✗失敗`); }
  }
  saveDB(); render();
  const skipped = t.dup + t.old + t.reschedule + t.empty;
  let msg = `同期(v16)｜${results.join(" / ")}｜計${t.added + t.cancelled}件追加・スキップ${skipped}（期間外${t.old}・重複${t.dup}・変更${t.reschedule}・空${t.empty}）`;
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
  const sd = e.target.closest("[data-seatdl]");
  if (sd) exportSeatingCSV(sd.dataset.seatdl);
  const ns = e.target.closest("[data-noshow]");
  if (ns) markNoShow(ns.dataset.noshow);
  const nsc = e.target.closest("[data-noshow-clear]");
  if (nsc) clearNoShow(nsc.dataset.noshowClear);
  if (e.target.closest("[data-unseated-csv]")) exportUnseatedCSV();
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
// 売上管理シートから変換したJSONを取り込む（現データを置き換え）
$("#importBtn")?.addEventListener("click", () => $("#importFile")?.click());
$("#importFile")?.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.candidates)) { toast("取込失敗：candidates配列が見つかりません"); return; }
      const n = data.candidates.length;
      const apps = data.candidates.reduce((s, c) => s + ((c.applications || []).length), 0);
      if (!confirm(`「${file.name}」を取り込みます。\n候補者${n}名・選考${apps}件で現在のデータを置き換えます。よろしいですか？`)) { e.target.value = ""; return; }
      db = data;
      if (!db.advisors) db.advisors = [];
      if (!db.sources || !db.sources.length) db.sources = defaultSources();
      if (db.targets == null) db.targets = {};
      if (db.companies == null) db.companies = [];
      saveDB(); render();
      toast(`取込完了：候補者${n}名・選考${apps}件`);
    } catch (err) {
      console.error("import failed", err);
      toast("取込失敗：JSONを解析できませんでした");
    }
    e.target.value = "";
  };
  reader.readAsText(file);
});

/* =========================================================
   ログイン / 権限（開発用クライアントサイド・ロール）
   ※将来バックエンド化したら、この役割・スコープ設計を本認証へ移行
   ========================================================= */
const SESSION_KEY = "talentflow.session";
const ROLES = {
  admin:      { label: "管理者（Admin）",   desc: "全データ・全機能・設定" },
  manager:    { label: "マネージャー",       desc: "チーム全体の売上・進捗を閲覧" },
  submanager: { label: "サブマネージャー",   desc: "チーム全体の売上・進捗を閲覧" },
  ca:         { label: "CA（担当）",         desc: "自分の担当のみ表示・精査" },
};
const TEAM_ROLES = ["admin", "manager", "submanager"]; // 全体が見えるロール
let session = (function () { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; } })();
function isTeamView() { return !!session && TEAM_ROLES.includes(session.role); }
function inScope(c) { return !session || isTeamView() || c.advisorId === session.advisorId; } // CAは自分の担当のみ
function setSession(s) { session = s; localStorage.setItem(SESSION_KEY, JSON.stringify(s)); showApp(); }
function logout() { session = null; localStorage.removeItem(SESSION_KEY); showLogin(); }
function bootApp() { if (session) showApp(); else showLogin(); }
function showApp() {
  $("#loginScreen").hidden = true;
  $("#app").hidden = false;
  $(".sidebar-foot").style.display = session && session.role === "admin" ? "" : "none"; // 設定系は管理者のみ
  updateSessionBar();
  render();
}
function updateSessionBar() {
  const el = $("#sessionBar");
  if (!el) return;
  if (!session) { el.innerHTML = ""; return; }
  el.innerHTML = `<span class="sess-who"><span class="sess-role">${esc((ROLES[session.role] || {}).label || session.role)}</span>${session.name ? "：" + esc(session.name) : ""}</span><button class="btn btn-outline btn-sm" id="logoutBtn">切替/ログアウト</button>`;
  $("#logoutBtn")?.addEventListener("click", logout);
}
function showLogin() {
  $("#app").hidden = true;
  const el = $("#loginScreen");
  el.hidden = false;
  const caOpts = db.advisors.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("");
  const roleCard = (r) => `<button class="login-card" data-login="${r}"><div class="login-role">${ROLES[r].label}</div><div class="login-desc">${ROLES[r].desc}</div></button>`;
  el.innerHTML = `
    <div class="login-box">
      <div class="login-brand"><div class="brand-mark">TF</div><div><div class="brand-name">TalentFlow ログイン</div><div class="brand-sub">人材紹介 進捗管理</div></div></div>
      <div class="login-dev">🔧 開発モード：どのアカウントでもログインできます</div>
      <div class="login-grid">${roleCard("admin")}${roleCard("manager")}${roleCard("submanager")}</div>
      <div class="login-ca">
        <div class="login-role">CA（担当）としてログイン</div>
        <div class="login-desc">選んだ担当者の案件だけを表示・精査します</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <div class="select-wrap" style="flex:1"><select class="select" id="loginCa"><option value="">CAを選択…</option>${caOpts}</select></div>
          <button class="btn btn-primary" data-login="ca">ログイン</button>
        </div>
      </div>
    </div>`;
  $$("[data-login]").forEach((b) => b.addEventListener("click", () => {
    const role = b.dataset.login;
    if (role === "ca") {
      const id = $("#loginCa").value;
      if (!id) { toast("CAを選択してください"); return; }
      setSession({ role: "ca", advisorId: id, name: advisorName(id) });
    } else {
      setSession({ role, name: ROLES[role].label });
    }
  }));
}

// 関数をグローバル公開（onclick属性から呼ぶため）
Object.assign(window, { closeModal, openCandidateForm, saveCandidate, deleteCandidate, openDetail, setStage, addNote, saveAdvisor, openSyncModal, runSync, addSyncRow, saveSourcesAndSync, openHandoff, runHandoff, openMeetingSetup, saveMeetingSetup, closeReferral, logout, openTargetModal, saveTarget, logReport, db });

bootApp();

/* =========================================================
   サンプルデータ
   ========================================================= */
function seedData() {
  const A = [
    { id: "adv1", name: "赤沼 太郎", email: "t.akanuma@example.com" },
    { id: "adv2", name: "岸本 義樹", email: "y.kishimoto@example.com" },
    { id: "adv3", name: "佐藤 美咲", email: "m.sato@example.com" },
  ];
  const mk = (o) => ({ email: "", phone: "", skills: [], source: "", expectedSalary: 0, activities: [], createdAt: "2026-06-01", ...o });
  const C = [
    mk({ id: "c1", name: "田中 健一", kana: "タナカ ケンイチ", advisorId: "adv1", source: "timerex", stage: "join", company: "株式会社テックスター", position: "バックエンドエンジニア", currentJob: "SIerでJava開発5年", desiredJob: "Webサービス開発", desiredSalary: "650万円", skills: ["Java", "Spring", "AWS"], joinedAt: "2026-03-01", updatedAt: "2026-06-10",
      activities: [{ id: "a1", date: "2026-06-10", type: "stage", text: "ステージを「入社」→「返金規定クリア」に変更" }, { id: "a2", date: "2026-03-01", type: "note", text: "入社。3/1付け。受け入れ準備OK" }],
      empType: "中途", applications: [{ id: "ap1", company: "株式会社テックスター", status: "入社", fee: 900000, feeInclTax: 990000, segment: "CA", ownListing: true, conf: "A", acceptMonth: "2026-02", invoiceMonth: "2026-03", dueMonth: "2026-04", invoiceStatus: "入金済", paidAt: "2026-04-28", paidAmount: 900000, createdAt: "2026-02-10", updatedAt: "2026-04-28" }] }),
    mk({ id: "c2", name: "山本 さくら", kana: "ヤマモト サクラ", advisorId: "adv2", source: "referral", stage: "join", company: "グロースラボ株式会社", position: "フロントエンドエンジニア", currentJob: "受託開発3年", desiredJob: "自社プロダクト", desiredSalary: "550万円", skills: ["React", "TypeScript", "Next.js"], joinedAt: "2026-06-16", updatedAt: "2026-06-16",
      activities: [{ id: "a3", date: "2026-06-16", type: "stage", text: "ステージを「内定承諾」→「入社」に変更" }, { id: "a4", date: "2026-06-02", type: "note", text: "LINEグループで日程調整 → 入社日確定" }],
      empType: "新卒", applications: [{ id: "ap2", company: "グロースラボ株式会社", status: "入社", fee: 800000, feeInclTax: 880000, segment: "CA", ownListing: true, conf: "A", acceptMonth: "2026-06", invoiceMonth: "2026-06", dueMonth: "2026-07", invoiceStatus: "発行済", paidAt: "", paidAmount: 800000, createdAt: "2026-05-20", updatedAt: "2026-06-16" }] }),
    mk({ id: "c3", name: "鈴木 大輔", kana: "スズキ ダイスケ", advisorId: "adv1", source: "timerex", stage: "accept", company: "株式会社ネクストワン", position: "PM候補", currentJob: "事業会社で企画", desiredJob: "プロダクトマネージャー", desiredSalary: "700万円", skills: ["要件定義", "スクラム"], updatedAt: "2026-06-22",
      activities: [{ id: "a5", date: "2026-06-22", type: "stage", text: "ステージを「内定」→「内定承諾」に変更" }, { id: "a5b", date: "2026-06-20", type: "note", text: "オファー面談。条件に納得いただけた" }],
      empType: "中途", applications: [{ id: "ap3", company: "株式会社ネクストワン", status: "内定承諾", fee: 700000, feeInclTax: 770000, segment: "PCA", ownListing: false, partner: "送客パートナーA", conf: "A", acceptMonth: "2026-06", invoiceMonth: "", dueMonth: "", invoiceStatus: "未請求", paidAt: "", paidAmount: 700000, createdAt: "2026-06-01", updatedAt: "2026-06-22" }] }),
    mk({ id: "c4", name: "高橋 葵", kana: "タカハシ アオイ", advisorId: "adv3", source: "referral", stage: "offer", company: "クラウドベース株式会社", position: "インフラエンジニア", currentJob: "オンプレ運用", desiredJob: "クラウドインフラ", desiredSalary: "600万円", skills: ["AWS", "Terraform", "Kubernetes"], updatedAt: "2026-06-24",
      activities: [{ id: "a6", date: "2026-06-24", type: "stage", text: "ステージを「選考」→「内定」に変更" }],
      empType: "中途", applications: [{ id: "ap4", company: "クラウドベース株式会社", status: "内定", fee: 650000, conf: "A", acceptMonth: "", invoiceMonth: "", dueMonth: "", invoiceStatus: "未請求", paidAt: "", paidAmount: 0, createdAt: "2026-06-10", updatedAt: "2026-06-24" }] }),
    mk({ id: "c5", name: "伊藤 直樹", kana: "イトウ ナオキ", advisorId: "adv2", source: "timerex", stage: "screen", company: "株式会社データワークス", position: "データエンジニア", currentJob: "アナリスト", desiredJob: "データ基盤構築", desiredSalary: "580万円", skills: ["Python", "SQL", "BigQuery"], updatedAt: "2026-06-25",
      activities: [{ id: "a7", date: "2026-06-25", type: "note", text: "一次面接通過。来週二次面接" }],
      empType: "中途", applications: [{ id: "ap5", company: "株式会社データワークス", status: "一次面接", fee: 600000, conf: "B", acceptMonth: "", invoiceMonth: "", dueMonth: "", invoiceStatus: "未請求", paidAt: "", paidAmount: 0, createdAt: "2026-06-15", updatedAt: "2026-06-25" }] }),
    mk({ id: "c6", name: "渡辺 美穂", kana: "ワタナベ ミホ", advisorId: "adv3", source: "referral", stage: "proposal", company: "株式会社UXデザイン", position: "UIデザイナー", currentJob: "制作会社デザイナー", desiredJob: "プロダクトデザイン", desiredSalary: "520万円", expectedSalary: 5200000, skills: ["Figma", "UIデザイン"], updatedAt: "2026-06-26",
      activities: [{ id: "a8", date: "2026-06-26", type: "stage", text: "ステージを「初回面談」→「企業提案」に変更" }, { id: "a8b", date: "2026-06-26", type: "note", text: "2社を提案。来週、推薦書を送付予定" }],
      empType: "中途", applications: [{ id: "ap6", company: "株式会社UXデザイン", status: "提案", fee: 520000, conf: "C", acceptMonth: "", invoiceMonth: "", dueMonth: "", invoiceStatus: "未請求", paidAt: "", paidAmount: 0, createdAt: "2026-06-26", updatedAt: "2026-06-26" }] }),
    mk({ id: "c7", name: "中村 翔", kana: "ナカムラ ショウ", advisorId: "adv1", source: "timerex", stage: "meeting", currentJob: "新卒3年目 営業", desiredJob: "エンジニア転職", desiredSalary: "450万円", skills: ["独学でProgate完了"], updatedAt: "2026-06-27",
      activities: [{ id: "a9", date: "2026-06-27", type: "stage", text: "ステージを「着座」→「初回面談」に変更" }, { id: "a9b", date: "2026-06-27", type: "note", text: "初回面談実施。キャリアの方向性をヒアリング" }] }),
    mk({ id: "c8", name: "小林 由美", kana: "コバヤシ ユミ", advisorId: "adv2", source: "referral", stage: "seated", currentJob: "経理5年", desiredJob: "コーポレートIT", desiredSalary: "500万円", skills: ["Excel", "業務改善"], updatedAt: "2026-06-28",
      activities: [{ id: "a10", date: "2026-06-28", type: "stage", text: "ステージを「予約」→「着座」に変更" }, { id: "a10b", date: "2026-06-25", type: "note", text: "リファラル紹介。LINEグループで初回日程を調整" }] }),
    mk({ id: "c9", name: "加藤 隆", kana: "カトウ タカシ", advisorId: "adv3", source: "timerex", stage: "booked", scheduledAt: "2026-06-20", scheduledText: "2026-06-20 11:00", currentJob: "営業10年", desiredJob: "営業マネージャー", desiredSalary: "650万円", skills: ["法人営業"], updatedAt: "2026-06-28",
      activities: [{ id: "a11", date: "2026-06-15", type: "create", text: "TimeRexで初回面談を予約（6/20 11:00）" }] }),
    mk({ id: "c10", name: "森田 彩", kana: "モリタ アヤ", advisorId: "adv1", source: "referral", stage: "booked", currentJob: "販売職", desiredJob: "カスタマーサクセス", desiredSalary: "480万円", skills: ["接客", "顧客折衝"], updatedAt: "2026-06-28",
      activities: [{ id: "a12", date: "2026-06-28", type: "create", text: "リファラル獲得。LINEグループで日程調整中" }] }),
    mk({ id: "c11", name: "井上 拓海", kana: "イノウエ タクミ", advisorId: "adv2", source: "timerex", stage: "closed", closeReason: "未着座", noShowReason: "連絡つかず", noShowNote: "予約日にNo-show。その後も連絡つかず", scheduledAt: "2026-06-18", scheduledText: "2026-06-18 15:00", currentJob: "倉庫管理", desiredJob: "ITサポート", desiredSalary: "400万円", skills: [], updatedAt: "2026-06-19",
      activities: [{ id: "a13", date: "2026-06-19", type: "stage", text: "未着座として記録（理由：連絡つかず）" }, { id: "a14", date: "2026-06-19", type: "note", text: "予約日に来訪なし（No-show）。連絡つかず" }] }),
  ];
  const targets = {
    "2026-06": { all: 2000000, byAdvisor: { adv1: 1000000, adv2: 800000, adv3: 500000 } },
    "2026-07": { all: 2200000, byAdvisor: { adv1: 1000000, adv2: 900000, adv3: 600000 } },
  };
  const companies = [
    { id: "co1", name: "株式会社テックスター", fixedFee: 900000, feeRate: 35, taxRate: 10, note: "" },
    { id: "co2", name: "グロースラボ株式会社", fixedFee: 800000, feeRate: 35, taxRate: 10, note: "" },
    { id: "co3", name: "株式会社ネクストワン", fixedFee: 0, feeRate: 35, taxRate: 10, note: "料率×想定年収で算出" },
    { id: "co4", name: "クラウドベース株式会社", fixedFee: 650000, feeRate: 30, taxRate: 10, note: "" },
    { id: "co5", name: "株式会社データワークス", fixedFee: 0, feeRate: 30, taxRate: 10, note: "" },
  ];
  return { advisors: A, candidates: C, sources: defaultSources(), targets, companies };
}
