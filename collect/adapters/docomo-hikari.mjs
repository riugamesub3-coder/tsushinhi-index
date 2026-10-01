// ドコモ光アダプタ — 1ギガ タイプA の実質月額を計算できる形にする。
//
// ★他社と違う点が4つある。どれも数字の意味を変えるので明示する。
//
// 1. **月額と工事費が別ページにある。** 月額は料金プラン一覧（/charge/）、
//    事務手数料と工事料は 1ギガの説明ページ（/1g_plan/）。だから extract ではなく
//    extractAll で全ページを揃えてから読む。1ページでも欠けたら呼ばれない（effective.mjs）。
//
// 2. **数字の多くが画像の alt にある。** 料金表は画像で、本文に数字が無い。
//    alt は画像の代替テキストとして公式が書いている文言なので、これを読む。
//
// 3. **タイプA と タイプC は同額として公開されている**（料金一覧の「1ギガ タイプAC」）。
//    タイプC専用ページにも同じ月額が別の書式で載っているので、それと突き合わせて検算する。
//    以前の収集はタイプCのページから価格らしい数字を拾っていたが、拾えていたのは**解約金**
//    （戸建5,500円・マンション4,180円）で、月額ではなかった（2026-10-01 発見）。
//
// 4. **公式特典はすべて dポイント（期間・用途限定）で、実質月額に算入しない。**
//    新規工事料実質0円特典も「工事料相当の dポイント」を進呈するもので、工事料そのものは請求される。
//    期間・用途が限定されたポイントは現金と同じには使えないため、キャッシュバックとして引かない。
//    事実は setBenefits に残す（算入しない特典の欄）。

import { cellText, stripNoise } from '../lib/dom.mjs';

export const providerId = 'docomo-hikari';
export const providerName = 'ドコモ光';
export const channelId = 'official';

const PRICE_PAGE = /\/internet\/hikari\/charge\/$/;
const FEE_PAGE = /\/internet\/hikari\/1g_plan\/$/;
const TYPE_C_PAGE = /\/internet\/hikari\/charge\/type_c\/$/;

const BUILDINGS = [
  { key: 'マンション', heading: /マンションにお住まいの方/, typeC: 'マンション' },
  { key: '戸建て', heading: /戸建てにお住まいの方/, typeC: '戸建' },
];

export function extractAll(pages) {
  const warnings = [];
  const byRole = (re) => pages.find((p) => re.test(p.url));
  const pricePage = byRole(PRICE_PAGE);
  const feePage = byRole(FEE_PAGE);
  const typeCPage = byRole(TYPE_C_PAGE);
  if (!pricePage || !feePage || !typeCPage) {
    warnings.push('料金一覧・1ギガ説明・タイプCのいずれかのページが targets.json に無い');
    return { offers: [], notices: [], warnings };
  }

  const priceText = flatText(pricePage.html);
  const feeText = flatText(feePage.html);
  const typeCText = flatText(typeCPage.html);

  const fees = readFees(feeText, warnings);
  const benefits = readPointBenefits(feeText);
  const cancelFees = readCancelFees(feeText);

  const offers = [];
  for (const b of BUILDINGS) {
    const monthly = readTypeAMonthly(priceText, b, warnings);
    const typeC = readTypeCMonthly(typeCText, b.typeC, warnings);
    if (monthly == null) continue;

    for (const entry of ['新規', '転用']) {
      const f = fees[entry];
      const mismatch = [];
      if (typeC == null) mismatch.push('タイプC専用ページの月額が読めない');
      else if (typeC !== monthly) mismatch.push(`料金一覧のタイプA/C ${monthly}円 ≠ タイプC専用ページ ${typeC}円`);

      const offer = {
        providerId,
        providerName,
        channelId,
        sourceUrl: pricePage.url,
        alsoSourcedFrom: [feePage.url, typeCPage.url],
        planKey: ['1ギガ タイプA', b.key, entry].join(' / '),
        plan: { speed: '1ギガ', type: 'タイプA', building: b.key, entry },
        contractMonths: 24,
        contractNote: '2年定期契約（自動更新）。' +
          (cancelFees[b.key] != null ? `更新期間以外の解約は解約金${cancelFees[b.key].toLocaleString('ja-JP')}円。` : '') +
          '開通月は日割りだが、日割り額が確定しないため満額で数える（全社共通の規則）',
        monthlySchedule: [{ fromMonth: 1, toMonth: null, amount: monthly }],
        adminFee: f?.adminFee ?? null,
        constructionFee: f
          ? {
              list: f.work,
              installmentMonths: null,
              borne: f.work, // dポイント進呈は算入しないので、工事料は全額負担
              residualOnEarlyExit: f.work > 0,
              note: '公式が「代表例」として示す額。設備状況により変動する',
            }
          : {},
        cashbacks: [],
        requiredOptions: [],
        proratedFirstMonth: false,
        verificationMethod: '料金一覧の「1ギガ タイプAC」の月額 ⇔ タイプC専用ページの月額 の一致（適用後月額の公開が無いため内訳との突き合わせは不可）',
        setBenefits: benefits,
      };
      if (!f) mismatch.push(`${entry}の事務手数料・工事料が読めない`);
      offer.verified = mismatch.length === 0;
      if (mismatch.length) {
        offer.mismatch = mismatch;
        warnings.push(`検算が通らない [${offer.planKey}]: ${mismatch.join(' / ')}`);
      }
      offers.push(offer);
    }
  }

  return { offers, notices: readNotices(feeText), warnings };
}

// ── 読み取り ───────────────────────────────────────────────────

/**
 * 画像の alt を本文に展開してからテキスト化する。
 * 料金表が画像なので、alt を落とすと数字が1つも残らない。
 */
export function flatText(html) {
  const withAlt = stripNoise(html).replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_, alt) => ` ${alt} `);
  return cellText(withAlt);
}

const yenOf = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));

/**
 * 料金一覧から 1ギガ タイプA（＝タイプAC）の2年定期の月額を読む。
 * 同じ画像が PC用・スマホ用で2回出るので、**全部の出現が同じ値であること**を確かめる。
 */
export function readTypeAMonthly(text, building, warnings = []) {
  // 見出し（「〇〇にお住まいの方」）から次の見出しまでを、その建物の範囲とする。
  // スマホ用の画像は見出しの直後に無いので、見出し直後だけを見ると食い違いを見逃す。
  const sections = [];
  const heads = [...text.matchAll(/(\S*)にお住まいの方/g)];
  heads.forEach((h, i) => {
    if (building.heading.test(h[0])) sections.push(text.slice(h.index, heads[i + 1]?.index ?? text.length));
  });
  const re = /1ギガ\s*タイプAC(?:※\d+)?\s*2年定期契約の場合(?:※\d+)?\s*([\d,]+)円/g;
  const values = sections.flatMap((s) => [...s.matchAll(re)].map((m) => yenOf(m[1])));
  if (!values.length) { warnings.push(`1ギガ タイプAの月額が読めない: ${building.key}`); return null; }
  if (new Set(values).size > 1) {
    warnings.push(`1ギガ タイプAの月額がページ内で食い違う: ${building.key} ${values.join(' / ')}`);
    return null;
  }
  return values[0];
}

/** タイプC専用ページの「戸建にお住まいの方 料金プラン 1ギガタイプC 月額料金 5,720円」を読む（検算用） */
export function readTypeCMonthly(text, label, warnings = []) {
  const re = new RegExp(`${label}にお住まいの方\\s*料金プラン\\s*1ギガ\\s*タイプC\\s*月額料金\\s*([\\d,]+)円`, 'g');
  const values = [...text.matchAll(re)].map((m) => yenOf(m[1]));
  if (!values.length) return null;
  if (new Set(values).size > 1) {
    warnings.push(`タイプC専用ページの月額が食い違う: ${label} ${values.join(' / ')}`);
    return null;
  }
  return values[0];
}

/**
 * 初期費用の例を申込区分ごとに読む。
 *   新規: 「新規お申込みの場合 ＜初期費用（例）＞ 契約事務手数料4,950円（税込）＋工事料（※代表例）戸建・マンション：28,600円（税込）」
 *   転用: 「転用お申込みの場合（速度そのまま） ＜初期費用（例）＞ 契約事務手数料4,950円（税込）＋工事料（※代表例）：0円」
 * 光回線再利用（戸建のみ・再利用手続費あり）は申込者の設備に依存するため観測にしない。
 */
export function readFees(text, warnings = []) {
  const pattern = (lead) =>
    new RegExp(
      lead + String.raw`[^＜]{0,20}＜初期費用（例）＞\s*契約事務手数料([\d,]+)円（税込）＋工事料（※代表例）(?:戸建・マンション)?：([\d,]+)円`,
      'g'
    );
  const out = {};
  for (const [entry, lead] of [['新規', '新規お申込みの場合'], ['転用', '転用お申込みの場合']]) {
    const hits = [...text.matchAll(pattern(lead))].map((m) => `${yenOf(m[1])}/${yenOf(m[2])}`);
    if (!hits.length) { warnings.push(`初期費用の例が読めない: ${entry}`); continue; }
    if (new Set(hits).size > 1) { warnings.push(`初期費用の例が食い違う: ${entry} ${hits.join(' , ')}`); continue; }
    const [adminFee, work] = hits[0].split('/').map(Number);
    out[entry] = { adminFee, work };
  }
  return out;
}

/** 「更新期間を除いて戸建タイプ5,500円（税込）、マンションタイプ4,180円（税込）の解約金」 */
function readCancelFees(text) {
  const m = /更新期間を除いて戸建タイプ([\d,]+)円（税込）、マンションタイプ([\d,]+)円（税込）の解約金/.exec(text);
  return m ? { '戸建て': yenOf(m[1]), 'マンション': yenOf(m[2]) } : {};
}

/** dポイント特典は算入しないが、事実として残す（読者が判断できるように） */
export function readPointBenefits(text) {
  const out = [];
  if (/新規工事料実質0円特典/.test(text) && /工事料相当のdポイント（期間・用途限定）/.test(text)) {
    out.push('新規工事料実質0円特典: 工事料相当のdポイント（期間・用途限定）を進呈。工事料は請求されるため実質月額には算入しない');
  }
  if (/他社解約金のうちdポイント（期間・用途限定）最大([\d,]+)pt/.test(text)) {
    out.push('乗り換え特典: 他社解約金をdポイント（期間・用途限定）で還元。人により額が違うため算入しない');
  }
  if (/【公式Web】ドコモ光 1ギガ 新規お申込み特典/.test(text)) {
    out.push('公式Web新規申込特典: dポイント（期間・用途限定）。ポイントのため算入しない');
  }
  return out;
}

const NOTICE_KEYWORDS = /料金改定|改定を予定|改定いたしました|新規受付を終了|提供を終了/;

function readNotices(text) {
  return [...new Set(
    text
      .split(/[。]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 10 && s.length <= 140 && NOTICE_KEYWORDS.test(s))
  )].slice(0, 8);
}
