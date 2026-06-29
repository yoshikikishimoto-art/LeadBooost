#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
売上管理シート(xlsx) → TalentFlow 取込用 JSON 変換（標準・一度きり）

- 標準ライブラリのみ（openpyxl不要。xlsx=zip+XML を直接解析）。
- 入力: 「内定者リスト」(sheet2) ＝ 売上台帳、「全体売上表」(sheet1) ＝ 月次目標。
- 出力: {advisors, candidates(+applications), sources, targets} の JSON。
  個人情報を含むため、出力JSONはリポジトリにコミットしないこと（既定で Downloads に出力）。

使い方:
  python3 tools/convert_xlsx.py [入力xlsx] [出力json]
  既定: ~/Downloads/【売上管理】Peter Pan_3期_総合人材.xlsx → ~/Downloads/talentflow-import.json
"""
import sys, os, json, re, zipfile
from xml.etree import ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
HOME = os.path.expanduser("~")
IN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HOME, "Downloads", "【売上管理】Peter Pan_3期_総合人材.xlsx")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HOME, "Downloads", "talentflow-import.json")

# ---- xlsx 読み込み ----
z = zipfile.ZipFile(IN)
shared = []
if 'xl/sharedStrings.xml' in z.namelist():
    for si in ET.fromstring(z.read('xl/sharedStrings.xml')):
        shared.append(''.join(n.text or '' for n in si.iter(NS + 't')))

def cellval(c):
    tp = c.get('t'); v = c.find(NS + 'v')
    if v is None:
        isn = c.find(NS + 'is')
        return ''.join(n.text or '' for n in isn.iter(NS + 't')) if isn is not None else ''
    if tp == 's':
        try: return shared[int(v.text)]
        except: return ''
    return v.text or ''

def colnum(ref):
    m = re.match(r'([A-Z]+)\d+', ref or 'A1'); col = 0
    for ch in m.group(1): col = col * 26 + (ord(ch) - 64)
    return col

def sheet_rows(fn):
    ws = ET.fromstring(z.read('xl/worksheets/%s.xml' % fn))
    rows = []
    for r in ws.iter(NS + 'row'):
        d = {}
        for c in r.iter(NS + 'c'): d[colnum(c.get('r'))] = cellval(c)
        rows.append(d)
    return rows

# ---- 日付の復号（シリアル値 or YYYYMMDD 浮動小数） ----
import datetime
EPOCH = datetime.date(1899, 12, 30)  # Excel 1900 date system

def parse_date(v):
    s = str(v).strip()
    if not s: return ""
    try: f = float(s)
    except: return ""
    n = int(round(f))
    if n >= 19000101:             # YYYYMMDD 形式
        y, md = n // 10000, n % 10000
        mo, d = md // 100, md % 100
        if 1 <= mo <= 12 and 1 <= d <= 31:
            return "%04d-%02d-%02d" % (y, mo, d)
        return ""
    if 20000 <= n <= 80000:       # Excel シリアル値
        try: return (EPOCH + datetime.timedelta(days=n)).isoformat()
        except: return ""
    return ""

def ym(iso): return iso[:7] if iso else ""
def num(v):
    s = str(v).strip().replace(",", "")
    if not s: return 0
    try: return int(round(float(s)))
    except: return 0

# ---- 内定者リスト → candidates/applications ----
COL = dict(no=1, hakkou=2, soufu=3, chakkin4=4, seikyusaki=5, name=6, seg7=7,
           pca=9, keiyu=12, status=14, company=15, ownlisting=16, ra=17,
           seika=21, zeinuki=22, refund=23, zeikomi=24, taishokubi=25,
           accept_serial=28, join_ymd=30, due_serial=32, paid_ymd=35, paid_done=38)

def seg_of(v7):
    s = str(v7).strip()
    if s == "外部(求人貸し)": return "PCA", ""
    if s == "シェア": return "PCAシェア", ""
    if s: return "CA", s            # 人名＝CA担当
    return "未分類", ""

def invoice_status(r, is_refund):
    if is_refund: return "返金"
    if num(r.get(COL['paid_done'])) == 1: return "入金済"
    if num(r.get(COL['soufu'])) == 1: return "送付済"
    if num(r.get(COL['hakkou'])) == 1: return "発行済"
    return "未請求"

VALID_STATUS = {"内定承諾", "早期退社", "内定辞退"}
rows = sheet_rows('sheet2')
data = [r for r in rows
        if str(r.get(COL['name'], '')).strip() not in ("", "名前")
        and str(r.get(COL['status'], '')).strip() in VALID_STATUS]

advisors = {}            # name -> id
def advisor_id(name):
    name = (name or "").strip()
    if not name: return ""
    if name not in advisors:
        advisors[name] = "adv-im-%d" % (len(advisors) + 1)
    return advisors[name]

candidates = []
seg_counter = {"CA": 0, "PCA": 0, "PCAシェア": 0, "未分類": 0}
status_counter = {}
sum_zeinuki_accepted = 0

for i, r in enumerate(data, 1):
    status_raw = str(r.get(COL['status'], '')).strip()
    status_counter[status_raw] = status_counter.get(status_raw, 0) + 1
    seg, ca_name = seg_of(r.get(COL['seg7']))
    seg_counter[seg] += 1
    is_refund = (status_raw == "早期退社")
    is_decline = (status_raw == "内定辞退")

    accept_date = parse_date(r.get(COL['accept_serial']))
    join_date = parse_date(r.get(COL['join_ymd']))
    due_date = parse_date(r.get(COL['due_serial']))
    paid_date = parse_date(r.get(COL['paid_ymd']))
    refund_date = parse_date(r.get(COL['taishokubi']))

    fee = num(r.get(COL['zeinuki']))          # 税抜＝計上基準
    fee_incl = num(r.get(COL['zeikomi']))      # 税込（参考）
    refund_amt = num(r.get(COL['refund'])) if is_refund else 0

    # ステータス写像
    if is_decline:
        app_status = "見送り"; cand_stage = "closed"; close_reason = "内定辞退"
    elif is_refund:
        app_status = "入社"; cand_stage = "join"; close_reason = ""
    elif status_raw == "内定承諾":
        app_status = "内定承諾"; cand_stage = "accept"; close_reason = ""
    else:
        app_status = "内定承諾"; cand_stage = "accept"; close_reason = ""

    inv = invoice_status(r, is_refund)
    if app_status == "見送り":
        inv = "未請求"

    adv = advisor_id(ca_name) if seg == "CA" else ""
    if app_status in ("内定承諾", "入社"):
        sum_zeinuki_accepted += fee

    app = {
        "id": "ia-%d" % i,
        "company": str(r.get(COL['company'], '')).strip(),
        "status": app_status,
        "fee": fee, "feeInclTax": fee_incl,
        "refundAmount": refund_amt, "refundDate": refund_date,
        "conf": "A",
        "segment": seg, "ownListing": (num(r.get(COL['ownlisting'])) == 1),
        "partner": str(r.get(COL['pca'], '')).strip(),
        "raName": str(r.get(COL['ra'], '')).strip(),
        "via": str(r.get(COL['keiyu'], '')).strip(),
        "billTo": str(r.get(COL['seikyusaki'], '')).strip(),
        "invoiceStatus": inv,
        "acceptMonth": ym(accept_date), "acceptDate": accept_date,
        "invoiceMonth": "",
        "dueMonth": ym(due_date), "paidAt": paid_date, "paidMonth": ym(paid_date),
        "paidAmount": fee,
        "createdAt": accept_date or "2025-07-01", "updatedAt": paid_date or accept_date or "2025-07-01",
    }
    cand = {
        "id": "im-%d" % i,
        "name": str(r.get(COL['name'], '')).strip(),
        "kana": "", "email": "", "phone": "",
        "advisorId": adv, "source": "", "empType": "中途",
        "company": app["company"], "stage": cand_stage,
        "createdAt": accept_date or "2025-07-01", "updatedAt": app["updatedAt"],
        "activities": [], "applications": [app],
    }
    if close_reason: cand["closeReason"] = close_reason
    candidates.append(cand)

# ---- 全体売上表 → 月次目標（税抜・合計行） ----
targets = {}
try:
    s1 = sheet_rows('sheet1')
    # r4(index3)=月ラベル, r5(index4)=目標合計。col4..9=2025/7..12, col10..15=2026/1..6
    target_row = s1[4]
    month_cols = [(c, "2025-%02d" % m) for c, m in zip(range(4, 10), range(7, 13))]
    month_cols += [(c, "2026-%02d" % m) for c, m in zip(range(10, 16), range(1, 7))]
    for c, ymk in month_cols:
        val = num(target_row.get(c))
        if val:
            targets[ymk] = {"all": val, "byAdvisor": {}}
except Exception as e:
    print("WARN: 目標の取込に失敗:", e)

advisor_list = [{"id": v, "name": k, "email": ""} for k, v in advisors.items()]
db = {"advisors": advisor_list, "candidates": candidates, "sources": [], "targets": targets}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(db, f, ensure_ascii=False, indent=2)

# ---- 検証ログ ----
print("入力:", IN)
print("出力:", OUT)
print("候補者(=台帳行):", len(candidates))
print("ステータス分布:", status_counter)
print("事業分布:", seg_counter)
print("CA担当(advisor)数:", len(advisor_list))
print("計上対象(承諾以上)税抜合計:", "{:,}".format(sum_zeinuki_accepted))
print("月次目標 月数:", len(targets))
# 簡易アサーション
assert len(candidates) > 300, "台帳行が少なすぎます"
assert status_counter.get("内定承諾", 0) > 0, "内定承諾が0件"
print("OK: 変換完了")
