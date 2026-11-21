// 楽天モバイルアダプタ — スマホ料金（格安SIM側）の最初の1社。
//
// 光回線と違う点（数字の意味が変わるので明示する）:
//
// 1. **料金は使ったデータ量で決まる（3段階）。** 「プラン」ではなく「データ量の段」ごとに観測を作る。
//    比較の軸は「毎月どれだけ使うか」になるので、plan.dataFromGb / dataToGb（null=上限なし）を持たせる。
//    固定容量の他社（◯GBプラン）と並べるときも、この2つの数字で突き合わせられる。
//
// 2. **工事が無い。** 実質月額の式は工事費が欠けると null になる（欠損を埋めない原則）。
//    SIM には工事という概念が無いので「0円・工事なし」を明示して渡す。推定で埋めるのとは違う。
//
// 3. **キャンペーン・家族割は算入しない。** 乗り換えポイント等はエントリーや乗り換え元などの条件付き、
//    最強家族割は家族の契約が前提。楽天ひかりで楽天モバイルとのセット特典を算入しないのと同じ扱い。
//    事実として setBenefits / campaignNote に残す。
//
// 検算（verificationMethod に残す）:
//   ・各段の「税抜×1.1=税込」
//   ・3GBまでの税込額が、手数料ページの「月額最低利用金額 最大◯円（税込◯円）」と一致するか（別ページとの突き合わせ）
//
// 収集元（targets.json の rakuten-mobile）:
//   /fee/saikyo-plan/   月額（「※通常価格：…」の1文に3段階と U-NEXT が税抜・税込の組で載る）
//   /guide/commission/  契約事務手数料・解約事務手数料

import { cellText, stripNoise } from '../lib/dom.mjs';

export const providerId = 'rakuten-mobile';
export const providerName = '楽天モバイル';
export const channelId = 'official';
export const category = 'mobile';

const PLAN_PAGE = /\/fee\/saikyo-plan\//;
const FEE_PAGE = /\/guide\/commission\//;

const num = (s) => Number(String(s).replace(/,/g, ''));
const Y = '([0-9][0-9,]*)\\s*円\\s*[（(]\\s*税込\\s*([0-9][0-9,]*)\\s*円\\s*[）)]';

export function extractAll(pages) {
  const warnings = [];
  const plan = pages.find((p) => PLAN_PAGE.test(p.url));
  const fee = pages.find((p) => FEE_PAGE.test(p.url));
  if (!plan || !fee) {
    warnings.push('料金ページ（/fee/saikyo-plan/）と手数料ページ（/guide/commission/）の両方が targets.json に必要');
    return { offers: [], notices: [], warnings };
  }

  const planText = cellText(stripNoise(plan.html));
  const feeText = cellText(stripNoise(fee.html));

  const tiers = readTiers(planText);
  if (!tiers) {
    warnings.push('料金ページの「Rakuten最強プランはデータ3GBまで…」の文が読めない（書式が変わった疑い）');
    return { offers: [], notices: [], warnings };
  }

  const adminFee = readAdminFee(feeText);
  if (adminFee == null) warnings.push('契約事務手数料が読めない → 実質月額は出さない');

  const minFee = readMinimumFee(feeText);
  const earlyExit = readEarlyExitNote(feeText);
  const setBenefits = readSetBenefits(planText);

  const offers = tiers.map((t) => {
    const mismatch = [];
    const expected = Math.round(t.taxExcluded * 1.1);
    if (Math.abs(expected - t.taxIncluded) > 1) mismatch.push(`税抜${t.taxExcluded}×1.1=${expected} ≠ 税込${t.taxIncluded}`);
    if (t.dataToGb === 3) {
      if (minFee == null) mismatch.push('手数料ページの「月額最低利用金額」が読めず、3GBまでの額を突き合わせられない');
      else if (minFee !== t.taxIncluded) mismatch.push(`手数料ページの月額最低利用金額 ${minFee}円 ≠ 料金ページの3GBまで ${t.taxIncluded}円`);
    }
    if (mismatch.length) warnings.push(`検算が合わない [${t.planKey}]: ${mismatch.join(' / ')}`);

    return {
      providerId,
      providerName,
      channelId,
      category,
      sourceUrl: plan.url,
      feeSourceUrl: fee.url,
      planKey: t.planKey,
      planLabel: t.planLabel,
      plan: { plan: t.plan, voice: true, dataFromGb: t.dataFromGb, dataToGb: t.dataToGb },
      contractMonths: null,
      contractNote: earlyExit,
      monthlySchedule: [{ fromMonth: 1, toMonth: null, amount: t.taxIncluded }],
      adminFee,
      // SIM に工事は無い。0円を「事実」として渡す（推定で埋めているのではない）
      constructionFee: { list: 0, installmentMonths: null, borne: 0, residualOnEarlyExit: false, note: '工事なし（SIM）' },
      cashbacks: [],
      requiredOptions: [],
      proratedFirstMonth: null, // ページから読んでいない
      campaignNote: '開催中のキャンペーン（乗り換え・エントリーでのポイント等）は条件付きのため実質月額に算入しない',
      setBenefits,
      verificationMethod: '各段の税抜×1.1=税込 / 3GBまでの税込額と手数料ページの月額最低利用金額の一致',
      verified: mismatch.length === 0 && adminFee != null,
      ...(mismatch.length ? { mismatch } : {}),
    };
  });

  return { offers, notices: [], warnings };
}

/**
 * 「※通常価格：Rakuten最強プランはデータ3GBまで980円（税込1,078円）、3GB超過後20GBまで1,980円（税込2,178円）、
 *   20GB超過後は2,980円（税込3,278円）。Rakuten最強U-NEXTはデータ利用量にかかわらず、3,980円（税込4,378円）」
 * を4つの観測に開く。どれか1つでも読めなければ null（一部だけ出すと段がずれて見える）。
 *
 * ★planKey は識別子。一度出したら変えない（docs/04）。表示名を直すときは planLabel を変える。
 */
export function readTiers(text) {
  const s = text.replace(/\s+/g, '');
  const y = Y.replace(/\\s\*/g, '');
  const a = new RegExp(`Rakuten最強プランはデータ3GBまで${y}、3GB超過後20GBまで${y}、20GB超過後は${y}`).exec(s);
  const u = new RegExp(`Rakuten最強U-NEXTはデータ利用量にかかわらず、?${y}`).exec(s);
  if (!a || !u) return null;
  const P = 'Rakuten最強プラン';
  return [
    { planKey: `${P} / 3GBまで`, planLabel: `${P}（3GBまで）`, plan: P, dataFromGb: 0, dataToGb: 3, taxExcluded: num(a[1]), taxIncluded: num(a[2]) },
    { planKey: `${P} / 3GB超〜20GB`, planLabel: `${P}（3GB超〜20GB）`, plan: P, dataFromGb: 3, dataToGb: 20, taxExcluded: num(a[3]), taxIncluded: num(a[4]) },
    { planKey: `${P} / 20GB超`, planLabel: `${P}（20GB超・上限なし）`, plan: P, dataFromGb: 20, dataToGb: null, taxExcluded: num(a[5]), taxIncluded: num(a[6]) },
    { planKey: 'Rakuten最強U-NEXT', planLabel: 'Rakuten最強U-NEXT（データ量にかかわらず）', plan: 'Rakuten最強U-NEXT', dataFromGb: 0, dataToGb: null, taxExcluded: num(u[1]), taxIncluded: num(u[2]) },
  ];
}

/** 「契約事務手数料 0円（税込0円）」の税込額。最初に出てくるものを採る（5回線以上の例外は注記で後に続く） */
export function readAdminFee(text) {
  const m = new RegExp(`契約事務手数料\\s*${Y}`).exec(text);
  return m ? num(m[2]) : null;
}

/** 解約事務手数料の注記にある「月額最低利用金額の1カ月分： 最大980円（税込1,078円）」の税込額 */
export function readMinimumFee(text) {
  const m = new RegExp(`月額最低利用金額の1カ月分\\s*[：:]\\s*最大\\s*${Y}`).exec(text);
  return m ? num(m[2]) : null;
}

function readEarlyExitNote(text) {
  if (/解約事務手数料（回線利用開始から\s*1年以内/.test(text)) {
    return '契約期間の定めは記載なし。回線利用開始から1年以内の解約は解約事務手数料（月額最低利用金額の1カ月分）がかかると手数料ページに記載';
  }
  return '契約期間・解約事務手数料の記載を読めていない';
}

/** 家族割は算入しないが、事実として残す（読者が判断できるように） */
function readSetBenefits(text) {
  const out = [];
  if (/家族と一緒に使ったとき/.test(text) && /110円引き/.test(text)) {
    out.push('家族と一緒に使うと110円引き（家族の契約が前提のため実質月額には算入しない）');
  }
  return out;
}
