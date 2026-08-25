// NURO光アダプタ — 料金スペックページから「実質月額を計算できる形」に構造化する。
//
// なぜ各社アダプタが要るのか:
//   汎用抽出では「この6,600円は月額なのかキャッシュバックなのか」が分からない。
//   意味づけができないと実質月額は計算できない。意味は各社のページ構造にしか無い。
//
// NUROのページ構造（2026-08-23に実物で確認）:
//   「お支払いイメージ（特典適用後）」の表（期間ヘッダ＋税込月額）と、
//   その直後の「料金内訳」の表（月額基本料金 / 基本工事費 / ○○割 / 工事費相当割引 / キャンペーン）が対になる。
//   この2枚が対になっているので、**内訳から計算した月額と、公開されている月額を突き合わせられる。**
//   → 突き合わせが合わなければ解釈を間違えている。合わないものは公開しない。
//
// ★プランの識別はタブの入れ子から取る。理由:
//   戸建てページは 外[2年割/U29応援割] × 内[2ギガ/10ギガ]、
//   マンションページは 外[2ギガ/10ギガ] × 内[2年割/U29応援割] と**入れ子の順序が逆**。
//   「直前の見出し」では取り違える。data-tab / data-panel の対応で解く。
//
// ★除外するもの: 「改定前の料金について」の下にある表。
//   2026-08-23時点でNUROは料金改定の最中で、旧料金（月額5,500円）と
//   新料金（5,720円）が同じページに載っている。混ぜると偽の変化になる。

import { parseTables, stripNoise, cellText, toYen } from '../lib/table.mjs';

export const providerId = 'nuro-hikari';
export const providerName = 'NURO光';
export const channelId = 'official';

const TILDE = /[～〜~]/;

/**
 * @param {string} html 料金スペックページのHTML
 * @param {string} url  取得元URL（戸建て/マンションの判定に使う）
 * @returns {{ offers: object[], notices: string[], warnings: string[] }}
 */
export function extract(html, url) {
  const clean = stripNoise(html);
  const { tables } = parseTables(html);
  const warnings = [];

  const buildingType = /\/mansion\//.test(url) ? 'apartment'
    : /\/house\//.test(url) ? 'detached'
    : null;
  if (!buildingType) warnings.push(`建物タイプがURLから判定できない: ${url}`);

  const initial = readInitialFees(tables);
  if (initial.adminFee == null) warnings.push('契約事務手数料が読めない');

  const labels = tabLabels(clean);
  const groups = tabGroups(clean);
  const panels = panelPositions(clean);
  const typeAnchors = anchorPositions(clean, /■?タイプ([SL])の場合/g, (m) => `タイプ${m[1]}`);

  const offers = [];
  for (let i = 0; i < tables.length; i++) {
    const detail = asDetailTable(tables[i]);
    if (!detail) continue;

    // 直前の「お支払いイメージ」表（期間ヘッダ＋公開されている月額）を対にする
    const published = i > 0 ? asPublishedTable(tables[i - 1]) : null;
    if (!published) {
      warnings.push(`料金内訳の直前に「お支払いイメージ」表が無い（table#${i}）`);
      continue;
    }
    if (published.periods.length !== detail.columns) {
      warnings.push(`期間数と内訳の列数が一致しない（table#${i}）: ${published.periods.length} vs ${detail.columns}`);
      continue;
    }

    const id = identify(tables[i].start, { labels, groups, panels, typeAnchors });
    const offer = buildOffer({ url, buildingType, initial, published, detail, id });

    // ★内訳から計算した月額と、ページが公開している月額を突き合わせる。
    //   ここが合わないなら構造の読み方が間違っている。黙って通さない。
    const mismatch = crossCheck(offer, published);
    if (mismatch.length) {
      warnings.push(`公開値と内訳が不一致 [${offer.planKey}]: ${mismatch.join(' / ')}`);
      offer.verified = false;
      offer.mismatch = mismatch;
    } else {
      offer.verified = true;
    }

    offers.push(offer);
  }

  flagCashbackAmbiguity(offers, tables);

  return { offers, notices: readNotices(clean), warnings };
}

/**
 * ★ページ内で記載が食い違う場合に、黙って片方を採らない。
 *
 * マンションページには「プラン(速度) / 10ギガ 20,000円 / 2ギガ 10,000円」という
 * ページ全体のキャッシュバック表があるが、タイプSの料金内訳表にはキャッシュバック行が無い。
 * どちらが正しいかはページからは判断できない。
 *   → より具体的な料金内訳表の値を採用しつつ、食い違いを ambiguities に残す。
 *     公開側はこれが付いた観測を「要確認」として扱う（差分を記事にしない）。
 */
function flagCashbackAmbiguity(offers, tables) {
  const table = tables.find((t) => {
    const flat = t.rows.map((r) => r.join(' '));
    return flat.some((r) => /プラン\s*\(?速度\)?/.test(r)) && flat.some((r) => /キャッシュバック/.test(r));
  });
  if (!table) return;

  const header = table.rows.find((r) => /プラン/.test(r[0] ?? ''));
  const cbRow = table.rows.find((r) => /キャッシュバック/.test(r[0] ?? ''));
  if (!header || !cbRow) return;

  for (const o of offers) {
    if (o.cashbacks.length) continue;
    const speed = o.plan.labels.find((l) => /ギガ/.test(l));
    if (!speed) continue;
    // ヘッダは「10ギガ」「2ギガ」と分かれることも「10ギガ・2ギガ」と束ねられることもある
    // （2026-08-24にNURO側が2列から1列に変えた）。前方一致だと束ねられた側を取り逃す
    const needle = speed.replace(/プラン|\s/g, '');
    const i = header.findIndex((h) => h.replace(/\s/g, '').includes(needle));
    const amount = i > 0 ? toYen(cbRow[i]) : null;
    if (amount == null) continue;
    (o.ambiguities ??= []).push(
      // ★「キャンペーン」と書くときは「特典」も併記する。
      // （広告主固有の条件のため削除。非公開の docs/03_法務コンプラ.md を参照）
      //   記載も一緒に表記をお願いします」への対応。この文言はサイトに表示される。
      `ページ全体の特典・キャンペーン表は${speed}に${amount.toLocaleString('ja-JP')}円のキャッシュバックを掲げているが、` +
        `このプランの料金内訳表にはキャッシュバック行が無い。内訳表を採用した（実質月額はキャッシュバック無しで計算）`
    );
  }
}

// ── 初期費用（基本工事費・契約事務手数料）────────────────────────────

function readInitialFees(tables) {
  let constructionList = null;
  let adminFee = null;
  let installmentMonths = null;

  for (const t of tables) {
    for (const row of t.rows) {
      if (row.length < 2) continue;
      const head = row[0];
      const body = row.slice(1).join(' ');
      if (constructionList == null && /基本工事費/.test(head)) {
        constructionList = toYen(body);
        installmentMonths = Number(/(\d+)\s*回払い/.exec(body)?.[1] ?? '') || null;
      }
      if (adminFee == null && /契約事務手数料/.test(head)) adminFee = toYen(body);
    }
  }
  return { constructionList, adminFee, installmentMonths };
}

// ── 表の判定 ─────────────────────────────────────────────────────

/** 「お支払いイメージ」表: 1行目が期間ヘッダ、2行目が月額 */
function asPublishedTable(t) {
  if (!t || t.rows.length !== 2) return null;
  const periods = t.rows[0].map(parsePeriod);
  if (periods.some((p) => p == null) || periods.length < 2) return null;
  const amounts = t.rows[1].map(toYen);
  return { periods, amounts };
}

/** 「料金内訳」表: 各行が 月額基本料金 / 基本工事費 / ○○割 / 工事費相当割引 / キャンペーン */
function asDetailTable(t) {
  if (!t || t.rows.length < 2) return null;
  const rows = t.rows.filter((r) => r.length > 0);
  const flat = rows.map((r) => r.join(' '));
  if (!flat.some((r) => /月額基本料金/.test(r))) return null;
  if (!flat.some((r) => /基本工事費/.test(r))) return null;

  const columns = Math.max(...rows.map((r) => r.length));
  const pick = (re) => rows.find((r) => re.test(r.join(' ')));

  return {
    columns,
    base: pick(/月額基本料金/),
    construction: pick(/基本工事費/),
    constructionDiscount: pick(/工事費相当割引/),
    monthlyDiscount: rows.find((r) => {
      const s = r.join(' ');
      return /割/.test(s) && !/工事費/.test(s) && !/月額基本料金/.test(s);
    }),
    campaign: pick(/キャンペーン|キャッシュバック/),
  };
}

/** 「1か月目」「2～24か月目」「25か月目～」を {from,to} にする */
function parsePeriod(text) {
  const s = String(text).replace(/\s/g, '');
  let m = /^(\d+)か月目$/.exec(s);
  if (m) return { from: +m[1], to: +m[1] };
  m = new RegExp(`^(\\d+)${TILDE.source}(\\d+)か月目$`).exec(s);
  if (m) return { from: +m[1], to: +m[2] };
  m = new RegExp(`^(\\d+)か月目${TILDE.source}$`).exec(s);
  if (m) return { from: +m[1], to: null };
  m = new RegExp(`^(\\d+)か月目${TILDE.source}(\\d+)か月目$`).exec(s);
  if (m) return { from: +m[1], to: +m[2] };
  if (/^開通月$/.test(s)) return { from: 1, to: 1 };
  return null;
}

// ── プランの識別（タブの入れ子）──────────────────────────────────

function tabLabels(html) {
  const map = new Map();
  const re = /data-tab=["']([^"'$]+)["'][^>]*>([\s\S]{0,300}?)<\/(?:button|a|li|div|span)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = cellText(m[2]).slice(0, 24);
    if (label && !map.has(m[1])) map.set(m[1], label);
  }
  return map;
}

/**
 * タブ群は「末尾の連番を除いたID」でまとめる。
 * plan01/plan02 → "plan"、plansub01/plansub02 → "plansub"、priceSub01..04 → "priceSub"。
 *
 * 出現順で群を切ろうとすると、同じタブがページ内で再掲されるため境界を誤る。
 * 実際に「2ギガプラン / 2ギガプラン」と同じ軸を2回拾う誤りを起こした。
 */
function tabGroups(html) {
  const groups = new Map();
  const re = /data-tab=["']([^"'$]+)["']/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const key = m[1].replace(/\d+$/, '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(m[1]);
  }
  return [...groups.values()].map((s) => [...s]);
}

function panelPositions(html) {
  const out = [];
  const re = /data-panel=["']([^"'$]+)["']/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push({ id: m[1], at: m.index });
  return out;
}

function anchorPositions(html, re, toValue) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(html)) !== null) out.push({ value: toValue(m), at: m.index });
  return out;
}

/** 表の位置から、各タブ群で「直前に開いていたパネル」のラベルを集める */
function identify(tableAt, { labels, groups, panels, typeAnchors }) {
  const parts = [];
  for (const g of groups) {
    const last = panels.filter((p) => g.includes(p.id) && p.at < tableAt).pop();
    if (last) {
      const label = labels.get(last.id);
      if (label) parts.push(label);
    }
  }
  const type = typeAnchors.filter((a) => a.at < tableAt).pop();
  if (type) parts.unshift(type.value);
  return parts;
}

// ── 観測レコードの組み立て ───────────────────────────────────────

function buildOffer({ url, buildingType, initial, published, detail, id }) {
  const periods = published.periods;
  const col = (row, i) => (row ? row[i] ?? '' : '');
  const at = (row, i) => toYen(col(row, i));

  const schedule = (row, sign = 1) =>
    periods.map((p, i) => ({
      fromMonth: p.from,
      toMonth: p.to,
      amount: sign * (at(row, i) ?? 0),
    }));

  // 月額 = 月額基本料金 + 月額割引（割引は負値で入っている）
  const monthlySchedule = periods.map((p, i) => {
    const base = at(detail.base, i);
    const disc = at(detail.monthlyDiscount, i) ?? 0;
    return { fromMonth: p.from, toMonth: p.to, amount: base == null ? null : base + disc };
  });

  const cashbacks = [];
  if (detail.campaign) {
    for (let i = 0; i < periods.length; i++) {
      const text = col(detail.campaign, i);
      if (!/キャッシュバック/.test(text)) continue;
      const amount = toYen(text);
      const month = Number(/(\d+)\s*か月目/.exec(text)?.[1] ?? '') || null;
      if (amount != null) cashbacks.push({ amount, receiveAtMonth: month, note: text.slice(0, 60) });
    }
  }

  const axes = classifyAxes(id);
  // ★キーは軸の種類で順序を固定する。ページのタブの並び順に従うと、
  //   NURO側がタブを入れ替えただけでキーが変わり、**偽の「プラン追加/削除」**を出してしまう。
  const planKey = [
    buildingType === 'apartment' ? 'マンション' : '戸建て',
    axes.mansionType,
    axes.speed,
    axes.discount,
  ].filter(Boolean).join(' / ');

  return {
    providerId,
    providerName,
    channelId,
    sourceUrl: url,
    planKey,
    plan: { buildingType, ...axes, labels: id },
    contractMonths: null, // NUROは契約期間の縛りなし。36か月正規化で比較する
    contractNote: '契約期間の縛りなし（解約金0円）',
    monthlySchedule,
    adminFee: initial.adminFee,
    constructionFee: {
      list: initial.constructionList,
      installmentMonths: initial.installmentMonths,
      monthlySchedule: schedule(detail.construction, 1),
      discountSchedule: schedule(detail.constructionDiscount, -1), // 表では負値なので正に戻す
      residualOnEarlyExit: true, // 24回払いの途中解約は残債が出る
    },
    cashbacks,
    requiredOptions: [],
    proratedFirstMonth: /最大/.test(col(detail.base, 0)),
    publishedMonthly: periods.map((p, i) => ({ fromMonth: p.from, toMonth: p.to, amount: published.amounts[i] })),
  };
}

/** タブのラベル群を、意味の軸（回線速度・割引・マンションのタイプ）に振り分ける */
function classifyAxes(labels) {
  const axes = { mansionType: null, speed: null, discount: null, unknown: [] };
  for (const l of labels) {
    if (/^タイプ[SL]$/.test(l)) axes.mansionType = l;
    else if (/ギガ/.test(l)) axes.speed = l.replace(/プラン$/, '');
    else if (/割/.test(l)) axes.discount = l;
    else axes.unknown.push(l);
  }
  return axes;
}

/** 内訳から計算した月額が、ページに公開されている月額と一致するか */
function crossCheck(offer, published) {
  const out = [];
  for (let i = 0; i < published.periods.length; i++) {
    const expected = published.amounts[i];
    if (expected == null) continue;
    const monthly = offer.monthlySchedule[i].amount;
    const charge = offer.constructionFee.monthlySchedule[i].amount;
    const discount = offer.constructionFee.discountSchedule[i].amount;
    if (monthly == null) { out.push(`${i}列目: 月額が読めない`); continue; }
    const computed = monthly + charge - discount;
    if (computed !== expected) out.push(`${i}列目: 計算${computed} ≠ 公開${expected}`);
  }
  return out;
}

// ── ページ上の告知（改定・受付終了）を拾う ──────────────────────

// 文単位で拾う。パターンで前方一致を取ると後続の別の文まで飲み込む
const NOTICE_KEYWORDS = /料金改定|新規受付を終了|新プラン(?:を|の提供)/;

function readNotices(html) {
  const sentences = cellText(html)
    .split(/[。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10 && s.length <= 120 && NOTICE_KEYWORDS.test(s));
  return [...new Set(sentences)].slice(0, 8);
}
