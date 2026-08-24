// So-net光アダプタ — 料金ページから「実質月額を計算できる形」に構造化する。
//
// NURO光との違い（同じ会社のサービスだがページの作りが別物）:
//   NURO光    料金内訳が <table> の行と列
//   So-net光  料金内訳が <div class="payment-cost-wrap"> の中の <dl>（dt=項目 / dd=金額）
//   → 取り出し口は lib/dom.mjs に揃えてある。
//
// So-netのページ構造（2026-08-24に実物で確認）:
//   <h5>■月々のお支払いイメージ（割引特典適用後）※派遣工事の場合</h5>
//   <div class="payment-cost-wrap">
//     <div class="payment-cost-box-wrap">      ← 期間1つぶん
//       <div class="box-ttl">ご利用開始月（開通月）</div>   ← 期間名
//       <div class="box-body"><p class="price-wrap">3,980円</p></div>  ← 公開されている月額
//       <div class="box-body price-breakdown"><dl>            ← 内訳
//         <dt>月額基本料金</dt><dd>6,270円</dd>
//         <dt>回線工事費</dt><dd>2,420円</dd>
//         <dt>月額基本料金割引</dt><dd>－2,290円</dd>
//         <dt>回線工事費相当割引</dt><dd>－2,420円</dd>
//       </dl></div>
//     </div>  × 期間の数だけ
//   </div>
//
// NURO光と同じく、**内訳から計算した月額とページ公開の月額を突き合わせる**。
// 合わないものは verified:false にして変化検知に使わない。

import {
  findBlocks, parseDefinitionLists, headingChains, lastIdBefore,
  cellText, stripNoise, toYen,
} from '../lib/dom.mjs';
import { parseTables } from '../lib/table.mjs';

export const providerId = 'so-net-hikari';
export const providerName = 'So-net光';
export const channelId = 'official';

// 事務手数料は初期費用の表に出る。内訳の dl にも「事務手数料」行として現れる
const ADMIN_FEE_LABEL = /事務手数料/;

export function extract(html, url) {
  const clean = stripNoise(html);
  const chainAt = headingChains(clean);
  const warnings = [];
  const offers = [];
  const campaigns = readCashbackCampaigns(clean);

  for (const wrap of findBlocks(clean, 'div', 'payment-cost-wrap')) {
    const boxes = findBlocks(wrap.html, 'div', 'payment-cost-box-wrap');
    if (boxes.length < 2) {
      warnings.push(`期間の箱が${boxes.length}個しかない（位置 ${wrap.start}）`);
      continue;
    }

    const id = identify(clean, chainAt, wrap.start);
    const columns = boxes.map((b) => readBox(b.html)).filter(Boolean);
    if (columns.length !== boxes.length) {
      warnings.push(`期間名が読めない箱がある [${id.planKey}]`);
      continue;
    }

    const offer = buildOffer({ url, id, columns });
    if (!offer) {
      warnings.push(`内訳が読めない [${id.planKey}]`);
      continue;
    }

    applyCashback(offer, campaigns, warnings);

    const mismatch = crossCheck(offer, columns);
    offer.verified = mismatch.length === 0;
    if (mismatch.length) {
      offer.mismatch = mismatch;
      warnings.push(`公開値と内訳が不一致 [${offer.planKey}]: ${mismatch.join(' / ')}`);
    }
    offers.push(offer);
  }

  return { offers, notices: readNotices(clean), warnings };
}

// ── 1つの期間の箱を読む ──────────────────────────────────────────

function readBox(boxHtml) {
  const title = findBlocks(boxHtml, 'div', 'box-ttl')[0];
  if (!title) return null;
  const period = parsePeriod(cellText(title.html));
  if (!period) return null;

  // 公開されている月額。price-breakdown の中にも price-wrap は無いので取り違えない
  const priceWrap = findBlocks(boxHtml, 'p', 'price-wrap')[0]
    ?? findBlocks(boxHtml, 'div', 'price-wrap')[0];
  const publishedText = priceWrap ? cellText(priceWrap.html) : '';

  const dl = parseDefinitionLists(boxHtml)[0];
  const items = new Map((dl?.pairs ?? []).map(([k, v]) => [k.replace(/\s/g, ''), v]));

  return {
    period,
    label: cellText(title.html),
    published: toYen(publishedText),
    publishedText,
    items,
  };
}

/**
 * 「ご利用開始月（開通月）」「1カ月目」「2カ月目～23カ月目」「24カ月目～」
 *
 * 単位の書き方は事業者どころかページ内でも揺れる（カ月 / か月 / ヶ月）ので先に揃える。
 * 範囲も「2カ月目～23カ月目」と「2～23カ月目」の両方がありうる。
 */
function parsePeriod(text) {
  const s = text
    .replace(/\s/g, '')
    .replace(/[〜~]/g, '～')
    .replace(/[カヵケヶか]月/g, 'か月');
  // ★契約1か月目＝開通月に揃える。
  //   So-netは「開通月」と「1カ月目」を別に数えるが、NURO光は開通月そのものを「1か月目」と呼ぶ。
  //   数え方を揃えないと、**片方だけ開通月を含んだ36か月**を比べることになる。
  //   → So-net の表記を +1 して、開通月を1か月目とする内部表現に直す。
  if (/ご利用開始月|開通月/.test(s)) return { from: 1, to: 1 };
  let m = /^(\d+)か月目$/.exec(s);
  if (m) return { from: +m[1] + 1, to: +m[1] + 1 };
  m = /^(\d+)(?:か月目)?～(\d+)か月目$/.exec(s);
  if (m) return { from: +m[1] + 1, to: +m[2] + 1 };
  m = /^(\d+)か月目～$/.exec(s);
  if (m) return { from: +m[1] + 1, to: null };
  return null;
}

// ── プランの識別 ─────────────────────────────────────────────────

/**
 * 見出しの連なりと、直前の節IDからプランを決める。
 * 見出しだけでは 10ギガ と 1ギガ が区別できない（どちらも同じ見出し文言を使っている）ため、
 * 節ID（charge-plan-10g / monthly-charge-1g / plan-m-price …）を併用する。
 */
function identify(html, chainAt, at) {
  const chain = chainAt(at);
  const sectionId = lastIdBefore(html, at, /10g|1g|plan-[a-z]/i) ?? '';

  const speed = /10g/i.test(sectionId) ? '10ギガ' : /1g|plan-[sml]/i.test(sectionId) ? '1ギガ' : null;
  const building = chain.find((h) => /^(戸建|マンション)$/.test(h)) ?? '戸建・マンション共通';
  const entry = chain.find((h) => /新設|転用|事業者変更/.test(h)) ?? null;

  // 「※派遣工事の場合」「※10ギガ⇒10ギガの場合」など工事区分は見出しの末尾に付く
  const imageHeading = chain.find((h) => /お支払いイメージ/.test(h)) ?? '';
  const work = /派遣工事/.test(imageHeading) ? '派遣工事'
    : /無派遣/.test(imageHeading) ? '無派遣工事'
    : /⇒/.test(imageHeading) ? cellText(imageHeading.replace(/.*※/, '')).replace(/の場合.*/, '')
    : null;

  const planKey = [speed, building, entry, work].filter(Boolean).join(' / ');
  return { planKey, speed, building, entry, work, sectionId, chain };
}

// ── 観測レコードの組み立て ───────────────────────────────────────

const AT = (items, re) => {
  for (const [k, v] of items) if (re.test(k)) return toYen(v);
  return null;
};

function buildOffer({ url, id, columns }) {
  const base = (c) => AT(c.items, /^月額基本料金$/);
  if (columns.every((c) => base(c) == null)) return null;

  // 開通月は日割りだが、ページが「最大◯円」として上限を出しているのでそれを使う。
  // 実際の請求はこれ以下になるため、**高く見積もる側**に倒れる（安く見せる誤りを作らない）。
  const months = columns;
  if (!months.length) return null;

  const sched = (pick) =>
    months.map((c) => ({ fromMonth: c.period.from, toMonth: c.period.to, amount: pick(c) ?? 0 }));

  const monthlySchedule = months.map((c) => {
    const b = base(c);
    const d = AT(c.items, /月額基本料金割引/) ?? 0;
    return { fromMonth: c.period.from, toMonth: c.period.to, amount: b == null ? null : b + d };
  });

  const adminFee = columns.map((c) => AT(c.items, ADMIN_FEE_LABEL)).find((v) => v != null) ?? null;

  return {
    providerId,
    providerName,
    channelId,
    sourceUrl: url,
    planKey: id.planKey,
    plan: { speed: id.speed, building: id.building, entry: id.entry, work: id.work },
    contractMonths: null,
    contractNote: '契約期間の定めなし（工事費の分割は23回）',
    monthlySchedule,
    adminFee,
    constructionFee: {
      monthlySchedule: sched((c) => AT(c.items, /^回線工事費$/)),
      discountSchedule: sched((c) => {
        const v = AT(c.items, /回線工事費相当割引/);
        return v == null ? 0 : -v; // 表では負値なので正に戻す
      }),
      residualOnEarlyExit: true,
    },
    cashbacks: [],   // So-netのキャッシュバックは特典欄にあり、この内訳表には現れない
    requiredOptions: [],
    proratedFirstMonth: true,
    publishedMonthly: months.map((c) => ({ fromMonth: c.period.from, toMonth: c.period.to, amount: c.published })),
  };
}

/** 内訳から計算した月額が、ページに公開されている月額と一致するか */
function crossCheck(offer, columns) {
  const out = [];
  const months = columns;
  for (let i = 0; i < months.length; i++) {
    const expected = months[i].published;
    if (expected == null) continue;
    const monthly = offer.monthlySchedule[i].amount;
    if (monthly == null) { out.push(`${months[i].label}: 月額が読めない`); continue; }
    const computed = monthly
      + offer.constructionFee.monthlySchedule[i].amount
      - offer.constructionFee.discountSchedule[i].amount;
    if (computed !== expected) out.push(`${months[i].label}: 計算${computed} ≠ 公開${expected}`);
  }
  return out;
}

// ── キャッシュバック特典 ─────────────────────────────────────────
//
// ★これを落とすと比較が嘘になる。
//   NURO光は内訳表にキャッシュバックが載るが、So-netは載らず、
//   ページ上部の「特典」表にしかない。取らずに並べると
//   「NUROは15,000円引き後・So-netは引く前」を比べることになり、So-netが不当に高く見える。
//
// 特典表の形（2026-08-24に実物で確認）:
//   キャンペーン期間 | 2026年8月24日～2026年8月31日
//   対象サービス     | So-net 光 10ギガ
//   対象となるお客さま | ・本ページにて、So-netへ新規入会、または…
//   特典内容         | …■戸建・マンション共通 ・新設の場合：15,000円 ・転用/事業者変更の場合：対象外
//   受け取り期間     | 対象サービスのご利用開始（開通）から17カ月後の15日より45日間

function readCashbackCampaigns(html) {
  const { tables } = parseTables(html);
  const out = [];

  for (const t of tables) {
    const row = (re) => t.rows.find((r) => re.test((r[0] ?? '').replace(/\s/g, '')))?.[1] ?? null;
    const benefit = row(/特典内容/);
    if (!benefit || !/キャッシュバック/.test(benefit)) continue;

    const audience = row(/対象となる.*お客さま|対象となるお客さま/) ?? '';
    // ★プラン変更者限定の特典を新規申込に適用しない。
    //   同じページに「So-net会員限定 キャッシュバック特典（プラン変更者向け）」があり、
    //   条件を見ずに拾うと、対象でない人の金額を差し引いてしまう。
    if (!/新規入会/.test(audience)) continue;

    const receive = row(/受け取り期間/) ?? '';
    const receiveAtMonth = Number(/(\d+)\s*[カヵケヶか]月後/.exec(receive)?.[1] ?? '') || null;

    out.push({
      service: row(/対象サービス/) ?? '',
      period: row(/キャンペーン期間/),
      receiveAtMonth,
      receiveText: receive,
      byEntry: parseBenefitByEntry(benefit),
      benefitText: benefit,
    });
  }
  return out;
}

/** 「・新設の場合：15,000円 ・転用/事業者変更の場合：対象外」を申込区分ごとに割る */
function parseBenefitByEntry(text) {
  const out = {};
  for (const m of text.matchAll(/[・･]\s*([^：:・]{2,20})の場合\s*[：:]\s*([^・･\s]{1,12})/g)) {
    const key = m[1].replace(/\s/g, '');
    // 「対象外」は不明ではなく「0円」という事実。推定ではないので算入してよい
    out[key] = /対象外/.test(m[2]) ? 0 : toYen(m[2]);
  }
  if (!Object.keys(out).length) {
    // 申込区分で割られていない場合は一律
    const flat = /共通\s*[：:]\s*([0-9,]+\s*円)/.exec(text);
    if (flat) out['*'] = toYen(flat[1]);
  }
  return out;
}

/** 観測に、対象サービスと申込区分が一致するキャッシュバックを載せる */
function applyCashback(offer, campaigns, warnings) {
  const hit = campaigns.filter((c) => offer.plan.speed && c.service.includes(offer.plan.speed));
  if (!hit.length) {
    warnings.push(`キャッシュバック特典が見つからない [${offer.planKey}] — 実質月額は算出しない`);
    offer.cashbacks = null; // ★不明。0円と扱うと安く見せてしまうので null にして計算を止める
    return;
  }

  for (const c of hit) {
    const entryKey = Object.keys(c.byEntry).find(
      (k) => k === '*' || (offer.plan.entry ?? '').replace(/\s/g, '').includes(k.replace(/[/／].*/, ''))
    );
    if (entryKey === undefined) {
      warnings.push(`申込区分に対応する特典額が読めない [${offer.planKey}]`);
      offer.cashbacks = null;
      return;
    }
    const amount = c.byEntry[entryKey];
    if (amount == null) { offer.cashbacks = null; return; }
    if (amount === 0) continue; // 対象外＝キャッシュバックなし（事実として確定）
    offer.cashbacks.push({
      amount,
      receiveAtMonth: c.receiveAtMonth,
      note: `${c.service} / ${entryKey} / ${c.receiveText}`.slice(0, 120),
      campaignPeriod: c.period,
    });
  }
}

const NOTICE_KEYWORDS = /料金改定|改定を予定|新規受付を終了|キャンペーン期間/;

function readNotices(html) {
  const sentences = cellText(html)
    .split(/[。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10 && s.length <= 140 && NOTICE_KEYWORDS.test(s));
  return [...new Set(sentences)].slice(0, 8);
}
