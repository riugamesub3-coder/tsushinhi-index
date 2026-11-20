// ビッグローブ光アダプタ — 10ギガ（2年プラン）・1ギガ（3年プラン）の実質月額を計算できる形にする。
//
// ★他社と違う点が4つある。どれも数字の意味を変えるので明示する。
//
// 1. **4ページを揃えてから読む（extractAll）。**
//    料金ページ（月額・申込手数料・工事費）、特典ページ（工事費の値引き・キャッシュバック）、
//    サポートサイトの料金表2枚（1ギガ3年プラン・10ギガ）。料金表2枚は**検算専用**で、
//    料金ページの月額・申込手数料と一致しなければ verified=false にする。
//
// 2. **特典は「対象期間」を読んで、観測日に有効なものだけを数える。**
//    2026-11-20 の特典ページには 10ギガ 55,000円・1ギガ 35,000円のキャッシュバックが
//    **画面に表示されたまま**載っているが、対象期間は「〜2026年9月30日」で終わっている。
//    金額だけ拾うと、もう受けられない特典で実質月額を下げることになる。
//    逆に期間が延長・再開されれば、ここが自動で数え始める。
//    期間が読めない特典は「有効かどうか分からない」ので計算を止める（cashbacks=null）。
//
// 3. **新規工事費は「分割払い相当を毎月値引き」で実質0円。** 請求と値引きを月ごとに持ち、
//    計算期間内の差額だけを負担として数える（effective.mjs の constructionFee.monthlySchedule）。
//    「派遣工事なし 3,300円」は観測にしない。料金表では一括のみ（分割なし）で、特典の説明は
//    「分割払い相当を値引き」。一方 FAQ は「派遣工事の有無に関わらず実質0円」と書く。
//    ページ内の記述どうしで値引きのされ方が一致しないので、どちらかに寄せて0円とも3,300円とも書かない。
//
// 4. **セット割（auスマートバリュー・UQ自宅セット割）は算入しない。** 他サービスの契約が前提。
//    光テレビのキャッシュバック（テレビの同時申込が条件）、他社解約金サポート（人により額が違う）、
//    ルーター購入の値引きも算入しない。事実だけ setBenefits に残す。

import { cellText, stripNoise } from '../lib/dom.mjs';

export const providerId = 'biglobe-hikari';
export const providerName = 'ビッグローブ光';
export const channelId = 'official';

const PRICE_PAGE = /join\.biglobe\.ne\.jp\/ftth\/hikari\/price\/$/;
const CAMPAIGN_PAGE = /join\.biglobe\.ne\.jp\/ftth\/hikari\/campaign\/$/;
const SUPPORT_1G = /support\.biglobe\.ne\.jp\/jimu\/ryokin\/course\/bighikari_3years\.html$/;
const SUPPORT_10G = /support\.biglobe\.ne\.jp\/jimu\/ryokin\/course\/bighikari_10g\.html$/;

// 料金ページの書き方: 「一戸建ての月額料金 … 10 ギガ （2年） 月額 6,270 円 … 1 ギガ （3年） 月額 5,478 円」
const BUILDINGS = [
  { key: '戸建て', monthlyHead: '一戸建ての月額料金', support1g: 'ファミリータイプ', work1g: 'ファミリー1ギガタイプ' },
  { key: 'マンション', monthlyHead: '集合住宅の月額料金', support1g: 'マンションタイプ', work1g: 'マンション1ギガタイプ' },
];
const SPEEDS = [
  { key: '10ギガ', years: 2, campaignType: 'BIGLOBE光 10ギガタイプ（2年プラン）' },
  { key: '1ギガ', years: 3, campaignType: 'BIGLOBE光 1ギガタイプ（3年プラン）' },
];
const ENTRIES = ['新規', '転用', '事業者変更'];

const yenOf = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));

/**
 * @param {{html:string,url:string}[]} pages
 * @param {{now?: Date}} [opts] 特典の対象期間を判定する基準日（テスト用。既定は今）
 */
export function extractAll(pages, { now = new Date() } = {}) {
  const warnings = [];
  const byRole = (re) => pages.find((p) => re.test(p.url));
  const price = byRole(PRICE_PAGE);
  const campaign = byRole(CAMPAIGN_PAGE);
  const s1 = byRole(SUPPORT_1G);
  const s10 = byRole(SUPPORT_10G);
  if (!price || !campaign || !s1 || !s10) {
    warnings.push('料金ページ・特典ページ・サポート料金表（1ギガ3年／10ギガ）のいずれかが targets.json に無い');
    return { offers: [], notices: [], warnings };
  }

  const priceText = flatText(price.html);
  const campaignText = flatText(campaign.html);
  const s1Text = flatText(s1.html);
  const s10Text = flatText(s10.html);
  const today = jstDate(now);

  const fees = readAdminFees(priceText, warnings);
  const support = {
    monthly1g: readSupport1gMonthly(s1Text),
    monthly10g: readSupport10gMonthly(s10Text),
    fee1g: readSupport1gFee(s1Text),
    fees10g: readSupport10gFees(s10Text),
  };
  const blocks = readBenefitBlocks(campaignText);
  // ★見出しに「キャッシュバック」が無い割引（例「月額割引特典」）も、黙って捨てると高く出る。
  //   分類できない有効な特典がお金に関わりそうなら、人が見るまで検算失敗にする
  const unknownCashbacks = blocks.filter((b) => isActive(b, today) && !classify(b) && looksMonetary(b));
  for (const b of unknownCashbacks) warnings.push(`対象期間内なのに分類できない割引・キャッシュバック特典がある: ${b.title}`);
  const transferWorkNoticed = /工事費不要/.test(priceText);
  const cancelFees = readCancelFees(priceText);
  const setBenefits = readSetBenefits(campaignText, priceText);

  const offers = [];
  for (const sp of SPEEDS) {
    const plan = planBenefits(blocks, sp, today, warnings);

    for (const b of BUILDINGS) {
      const monthly = readMonthly(priceText, b, sp, warnings);
      if (monthly == null) continue;
      const works = readWorks(priceText, sp.key === '10ギガ' ? 'マンション10ギガタイプ ファミリー10ギガタイプ' : b.work1g, warnings);

      // 検算: サポートサイトの料金表と月額が一致するか
      const supportMonthly = sp.key === '10ギガ' ? support.monthly10g : support.monthly1g?.[b.support1g];
      const baseMismatch = [];
      if (supportMonthly == null) baseMismatch.push('サポートサイトの料金表の月額が読めない');
      else if (supportMonthly !== monthly) baseMismatch.push(`料金ページ ${monthly}円 ≠ サポート料金表 ${supportMonthly}円`);
      if (unknownCashbacks.length) baseMismatch.push(`分類できない有効なキャッシュバック特典: ${unknownCashbacks.map((x) => x.title).join(' / ')}`);

      for (const entry of ENTRIES) {
        const adminFee = fees?.[entry]?.[sp.key] ?? null;
        const supportFee = sp.key === '10ギガ' ? support.fees10g?.[entry] : support.fee1g;
        const mismatch = [...baseMismatch];
        if (adminFee == null) mismatch.push(`${entry}の申込手数料が読めない`);
        else if (supportFee == null) mismatch.push(`サポート料金表の${entry}の手数料が読めない`);
        else if (supportFee !== adminFee) mismatch.push(`申込手数料 料金ページ ${adminFee}円 ≠ サポート料金表 ${supportFee}円`);

        const variants = entry === '新規'
          ? works.map((w) => ({ work: w.name, constructionFee: newWorkFee(w, plan) }))
          : [{ work: null, constructionFee: transferWorkFee(sp, plan, transferWorkNoticed) }];
        if (entry === '新規' && !works.length) mismatch.push('新規工事費の表が読めない');

        for (const v of variants) {
          const m = [...mismatch];
          if (v.constructionFee.check) m.push(v.constructionFee.check);
          delete v.constructionFee.check;
          const offer = {
            providerId,
            providerName,
            channelId,
            sourceUrl: price.url,
            alsoSourcedFrom: [campaign.url, sp.key === '10ギガ' ? s10.url : s1.url],
            planKey: [sp.key, b.key, entry, v.work].filter(Boolean).join(' / '),
            plan: { speed: sp.key, building: b.key, entry, ...(v.work ? { work: v.work } : {}) },
            contractMonths: sp.years * 12,
            contractNote: `${sp.years}年プラン（定期利用期間 ${sp.years * 12}か月・自動更新）。` +
              (cancelFees[`${sp.key}/${b.key}`] != null ? `更新月等以外の解約は違約金${cancelFees[`${sp.key}/${b.key}`].toLocaleString('ja-JP')}円（不課税）。` : '') +
              '開通月の扱いは満額で数える（全社共通の規則）' +
              (sp.key === '1ギガ' && /機器利用料550円\/月/.test(s1Text)
                ? '。NTT東日本のギガファミリー・スマートタイプ等に相当する回線では機器利用料550円/月が別途かかる（一部の乗り換えのみ・実質月額には未算入）'
                : ''),
            monthlySchedule: [{ fromMonth: 1, toMonth: null, amount: monthly }],
            adminFee,
            constructionFee: v.constructionFee,
            cashbacks: plan.cashbacks,
            requiredOptions: [],
            proratedFirstMonth: false,
            verificationMethod: '料金ページの月額・申込手数料 ⇔ サポートサイトの料金表（1ギガ3年プラン／10ギガ）の一致、工事費の「初回＋以降×回数」＝一括、特典は対象期間を観測日と照合',
            setBenefits,
          };
          offer.verified = m.length === 0;
          if (m.length) {
            offer.mismatch = m;
            warnings.push(`検算が通らない [${offer.planKey}]: ${m.join(' / ')}`);
          }
          offers.push(offer);
        }
      }
    }
  }

  return { offers, notices: readNotices(priceText), warnings };
}

// ── 読み取り ───────────────────────────────────────────────────

export function flatText(html) {
  return cellText(stripNoise(html));
}

/** 月額。PC用・スマホ用で同じ記載が複数回出るので、全出現が同じ値であることを確かめる */
export function readMonthly(text, building, speed, warnings = []) {
  const label = speed.key === '10ギガ' ? '10\\s*ギガ\\s*（2年）' : '1\\s*ギガ\\s*（3年）';
  const re = new RegExp(`${building.monthlyHead}[\\s\\S]{0,160}?${label}\\s*月額\\s*([\\d,]+)\\s*円`, 'g');
  const values = [...text.matchAll(re)].map((m) => yenOf(m[1]));
  if (!values.length) { warnings.push(`月額が読めない: ${speed.key} ${building.key}`); return null; }
  if (new Set(values).size > 1) { warnings.push(`月額がページ内で食い違う: ${speed.key} ${building.key} ${values.join(' / ')}`); return null; }
  return values[0];
}

/** 「申込手数料/事業者変更受入手数料 回線の種類 10ギガ（2年） 1ギガ（3年） 回線新規 1,100円 3,300円 転用 … 事業者変更 …」 */
export function readAdminFees(text, warnings = []) {
  const m = /申込手数料\/事業者変更受入手数料\s*回線の種類\s*10ギガ（2年）\s*1ギガ（3年）\s*回線新規\s*([\d,]+)円\s*([\d,]+)円\s*転用\s*([\d,]+)円\s*([\d,]+)円\s*事業者変更\s*([\d,]+)円\s*([\d,]+)円/.exec(text);
  if (!m) { warnings.push('申込手数料の表が読めない'); return null; }
  const v = m.slice(1).map(yenOf);
  return {
    '新規': { '10ギガ': v[0], '1ギガ': v[1] },
    '転用': { '10ギガ': v[2], '1ギガ': v[3] },
    '事業者変更': { '10ギガ': v[4], '1ギガ': v[5] },
  };
}

/**
 * 新規工事費の表。工事の区分ごとに一括額と分割（初回＋以降×回数）を読む。
 *   「ファミリー1ギガタイプ 工事費 一括 分割 屋内配線を新設する 28,600円 初回：880円 以降：792円×35回 …」
 * 「派遣工事なし」は分割が無いので読まない（冒頭の説明 3.）。
 */
export function readWorks(text, head, warnings = []) {
  const at = text.indexOf(`${head} 工事費 一括 分割`);
  if (at < 0) { warnings.push(`工事費の表が見つからない: ${head}`); return []; }
  const seg = text.slice(at, at + 400);
  const out = [];
  for (const name of ['屋内配線を新設する', '屋内配線を新設しない']) {
    const m = new RegExp(`${name}\\s*(?:\\*\\d\\s*)?([\\d,]+)円\\s*初回：([\\d,]+)円\\s*以降：([\\d,]+)円×(\\d+)回`).exec(seg);
    if (!m) { warnings.push(`工事費が読めない: ${head} ${name}`); continue; }
    out.push({ name, lump: yenOf(m[1]), first: yenOf(m[2]), rest: yenOf(m[3]), restCount: Number(m[4]) });
  }
  return out;
}

export function readSupport1gMonthly(text) {
  const m = /月額基本料金\s*ファミリータイプ\s*([\d,]+)円\/月\s*マンションタイプ\s*([\d,]+)円\/月/.exec(text);
  return m ? { 'ファミリータイプ': yenOf(m[1]), 'マンションタイプ': yenOf(m[2]) } : null;
}
export function readSupport10gMonthly(text) {
  const m = /月額基本料金\s*ファミリー10ギガタイプ\s*マンション10ギガタイプ\s*([\d,]+)円\/月/.exec(text);
  return m ? yenOf(m[1]) : null;
}
export function readSupport1gFee(text) {
  const m = /初期費用\s*申込手数料\/事業者変更受入手数料\s*([\d,]+)円/.exec(text);
  return m ? yenOf(m[1]) : null;
}
export function readSupport10gFees(text) {
  const m = /申込手数料（回線新規）\s*([\d,]+)円\s*申込手数料（回線転用）\s*([\d,]+)円\s*事業者変更受入手数料\s*([\d,]+)円/.exec(text);
  return m ? { '新規': yenOf(m[1]), '転用': yenOf(m[2]), '事業者変更': yenOf(m[3]) } : null;
}

/**
 * 特典ページを「特典概要」ごとのブロックに分ける。
 * 見出し（特典名）は「特典概要」の直前、対象期間は本文中の最初の「対象期間 YYYY年M月D日～[YYYY年M月D日]」。
 * PC用・スマホ用で同じ特典が2回出る。
 */
export function readBenefitBlocks(text) {
  const marks = [...text.matchAll(/ 特典概要 /g)].map((m) => m.index);
  return marks.map((at, i) => {
    // ★前の特典の本文を見出しに混ぜない。混ざると、新しいキャッシュバック特典が直前の
    //   「光テレビ キャッシュバック特典」の語を含んでしまい、条件付き特典として素通りする（テストで発見）
    const prevEnd = i > 0 ? marks[i - 1] + 6 : 0;
    const before = text.slice(Math.max(prevEnd, at - 120), at);
    const title = before.split(/特典概要|閉じる|。|当社は\S*|ください|みる|～\s*\S*|\s{2,}/).pop().trim();
    const body = text.slice(at + 6, marks[i + 1] ?? text.length).slice(0, 2500);
    const p = /対象期間\s*(\d{4})年(\d{1,2})月(\d{1,2})日～\s*(?:(\d{4})年(\d{1,2})月(\d{1,2})日)?/.exec(body);
    const ymd = (y, m, d) => (y ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
    // ★終了日が別の書き方（「～9月30日」「～2026/9/30」）だと、上の正規表現は「終了日なし」と読む。
    //   そのまま通すと、終わった特典を有効として数える（critic が 4,597円 vs 正 5,570円 で再現）。
    //   「～」の直後が完全な日付でも、定型の「当社は…」でもなければ、期間は読めなかったことにする
    let periodRead = Boolean(p);
    if (p && !p[4]) {
      const after = body.slice(p.index + p[0].length, p.index + p[0].length + 12).trim();
      if (after && !/^当社/.test(after)) periodRead = false;
    }
    return {
      title,
      body,
      start: p ? ymd(p[1], p[2], p[3]) : null,
      end: p ? ymd(p[4], p[5], p[6]) : null,
      periodRead,
    };
  });
}

function isActive(block, today) {
  if (!block.periodRead) return true; // 期間が読めないものは「有効かもしれない」側に倒して扱いを決めさせる
  return block.start <= today && (block.end == null || today <= block.end);
}

/** 実質月額に関係する特典の種類。関係しないもの（セキュリティ・ルーター・テレビ等）は null */
function classify(block) {
  const t = block.title;
  if (/光テレビ/.test(t)) return 'tv';
  // 見出しの前に「BIGLOBE光 特典詳細」などが付くことがあるので、末尾で判定する
  const m = /(BIGLOBE光 (?:10ギガ|1ギガ)タイプ（[23]年プラン）)(新規工事費実質無料特典|キャッシュバック特典)$/.exec(t);
  if (m) return { type: m[1], kind: m[2] === 'キャッシュバック特典' ? 'cashback' : 'work' };
  if (/(?:^|\s)タイプ変更工事費無料特典$/.test(t)) return { kind: 'typeChange' };
  // 実質月額に入れないと決めている特典（他の購入・契約が前提、または人により額が違う）
  if (/ルーター|トータル・ネットセキュリティ|解約金サポート/.test(t)) return 'ignored';
  return null;
}

/** 分類できないのに、お金に関わりそうな特典か（見出しか特典概要の冒頭に割引・値引き・還元・キャッシュバック） */
function looksMonetary(block) {
  return /割引|値引|還元|キャッシュバック/.test(`${block.title} ${block.body.slice(0, 120)}`);
}

/** そのプラン（速度）に、観測日に有効な特典をまとめる */
export function planBenefits(blocks, speed, today, warnings = []) {
  const mine = blocks.map((b) => ({ b, c: classify(b) })).filter(({ c }) => c && c !== 'tv' && (!c.type || c.type === speed.campaignType));
  const pick = (kind) => mine.filter(({ c }) => c.kind === kind).map(({ b }) => b);

  // 工事費の値引き: 有効なブロックがあるか（期間が読めなければ不明）
  const work = pick('work');
  const workActive = work.some((b) => b.periodRead && isActive(b, today))
    ? true
    : work.some((b) => !b.periodRead) ? null : false;

  const typeChange = pick('typeChange');
  const typeChangeActive = typeChange.some((b) => b.periodRead && isActive(b, today))
    ? true
    : typeChange.some((b) => !b.periodRead) ? null : false;

  // キャッシュバック: 有効なものだけ。期間・金額・受取月のどれかが読めなければ計算を止める
  let cashbacks = [];
  const seen = new Set();
  for (const b of pick('cashback')) {
    if (!b.periodRead) { warnings.push(`キャッシュバックの対象期間が読めない: ${b.title}`); cashbacks = null; break; }
    if (!isActive(b, today)) continue;
    const m = /■([\d,]+)円キャッシュバック（口座送金）\s*課金開始月を1カ月目として(\d+)カ月目/.exec(b.body);
    if (!m) { warnings.push(`有効なキャッシュバックの金額・受取月が読めない: ${b.title}`); cashbacks = null; break; }
    // ★申込区分で額や対象が分かれる書き方なら、どの区分に何円かを読み分けていないので止める
    //   （1区分の額を全区分に配ると、対象外の区分まで安く出る。critic が再現）
    const amounts = b.body.match(/■[\d,]+円/g) ?? [];
    const target = /対象者([\s\S]{0,300}?)(?:■|特典の受け取り|\(1\)|$)/.exec(b.body)?.[1] ?? '';
    if (amounts.length > 1 || /新規|転用|事業者変更|乗り換え|乗換/.test(target)) {
      warnings.push(`有効なキャッシュバックが申込区分で分かれている可能性があり、読み分けていない: ${b.title}`);
      cashbacks = null;
      break;
    }
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key)) continue; // PC用・スマホ用の重複
    seen.add(key);
    cashbacks.push({ amount: yenOf(m[1]), receiveAtMonth: Number(m[2]), method: '口座送金', period: `${b.start}〜${b.end ?? ''}` });
  }
  return { workActive, typeChangeActive, cashbacks };
}

/** 新規工事費: 請求（初回＋以降×回数）と、特典が有効なら同額の値引きを月ごとに持つ */
function newWorkFee(w, plan) {
  const months = 1 + w.restCount;
  const charge = [
    { fromMonth: 1, toMonth: 1, amount: w.first },
    { fromMonth: 2, toMonth: months, amount: w.rest },
    { fromMonth: months + 1, toMonth: null, amount: 0 },
  ];
  const fee = {
    list: w.lump,
    installmentMonths: months,
    monthlySchedule: charge,
    residualOnEarlyExit: true,
    note: '屋内配線の有無など設置先の状況で工事の区分が決まる',
  };
  const total = w.first + w.rest * w.restCount;
  if (total !== w.lump) fee.check = `工事費 初回${w.first}+${w.rest}×${w.restCount}=${total} ≠ 一括${w.lump}`;
  if (plan.workActive === true) fee.discountSchedule = charge.map((s) => ({ ...s }));
  else if (plan.workActive === false) fee.discountSchedule = [{ fromMonth: 1, toMonth: null, amount: 0 }];
  else fee.check = (fee.check ? fee.check + ' / ' : '') + '新規工事費実質無料特典の対象期間が読めない';
  return fee;
}

/**
 * 転用・事業者変更: 料金ページの「工事費不要」が根拠。
 * 10ギガへの乗り換えはタイプ変更工事が要るが、「タイプ変更工事費無料特典」が有効なら0円。
 * 無効・不明なら工事費が決まらないので null（計算を止める）。
 */
function transferWorkFee(speed, plan, noticed) {
  if (!noticed) return { borne: null, check: '乗り換えの工事費不要の記載が見つからない' };
  if (speed.key === '10ギガ') {
    if (plan.typeChangeActive !== true) {
      return { borne: null, check: 'タイプ変更工事費無料特典が有効か読めない（10ギガへの乗り換えはタイプ変更工事が要る）' };
    }
    return { list: 0, borne: 0, residualOnEarlyExit: false, note: '1ギガからの乗り換えで要るタイプ変更工事費は特典で無料' };
  }
  return { list: 0, borne: 0, residualOnEarlyExit: false };
}

/** 「10ギガタイプ（2年プラン）… 違約金 4,620円」「ファミリー1ギガタイプ：4,100円 マンション1ギガタイプ：3,000円」 */
function readCancelFees(text) {
  const out = {};
  const g10 = /10ギガタイプ（2年プラン）[\s\S]{0,200}?違約金\s*([\d,]+)円（不課税）/.exec(text);
  if (g10) { out['10ギガ/戸建て'] = yenOf(g10[1]); out['10ギガ/マンション'] = yenOf(g10[1]); }
  const f1 = /ファミリー1ギガタイプ：([\d,]+)円（不課税）/.exec(text);
  const m1 = /マンション1ギガタイプ：([\d,]+)円（不課税）/.exec(text);
  if (f1) out['1ギガ/戸建て'] = yenOf(f1[1]);
  if (m1) out['1ギガ/マンション'] = yenOf(m1[1]);
  return out;
}

/** 算入しない特典を事実として残す（読者が判断できるように） */
function readSetBenefits(campaignText, priceText) {
  const t = `${campaignText} ${priceText}`;
  const out = [];
  if (/auスマートバリュー/.test(t) || /UQ自宅セット割/.test(t)) {
    out.push('auスマートバリュー・UQ自宅セット割: スマホとのセット割。スマホ側の契約が前提のため実質月額には算入しない');
  }
  if (/解約金サポート特典/.test(t)) out.push('解約金サポート特典: 他社の解約金を補う特典。人により額が違うため算入しない');
  if (/光テレビ\s*キャッシュバック特典/.test(t)) out.push('光テレビのキャッシュバック: 光テレビの同時申込が条件のため算入しない');
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

/** 観測日（日本時間の YYYY-MM-DD）。特典の対象期間は日本の日付で書かれている */
export function jstDate(d) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
