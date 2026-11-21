// mineo アダプタ — スマホ料金の2社目。固定容量（コースを選ぶ）型の最初の1社。
//
// 楽天モバイル（使った量で段が決まる）との違い:
//   mineo は契約時に容量（コース）を選ぶ。dataFromGb=0, dataToGb=コースの容量 とする。
//   「毎月 X GB 使う人」にとって、楽天は X を含む段、mineo は X 以上の最小コースが該当する。
//
// 観測の単位: マイピタ × 種別（デュアル=音声あり / シングル=データのみ）× コース × SIMの形
//   初期費用が SIM の形で違う（SIMカード発行料 440円、eSIM は無料）ので、形ごとに観測を分ける。
//   回線（A/D/S プラン）は月額・契約事務手数料が同じなので分けない（S プランは eSIM 未提供＝eSIM の行は A/D のみ）。
//
// 算入しないもの（楽天モバイルと同じ扱い）:
//   家族割引・複数回線割引・親思い割引・おかえり割引（いずれも条件付き）、キャンペーン。
//   マイそく（速度で選ぶ使い放題）は容量の軸に乗らないので、この版では観測にしない。
//
// 検算: /price/ の表（税込）と /price/mypita/ のコース紹介（別の書式）で、全コース・両種別の月額が一致するか。
//   税抜額の併記が無いため「税抜×1.1」の検算はできない。契約事務手数料は /price/ の表だけが出典（単一出典）。
//
// 収集元（targets.json の mineo）:
//   https://mineo.jp/price/         月額（デュアル・シングルの2表）と初期費用の表
//   https://mineo.jp/price/mypita/  マイピタのコース紹介（突き合わせ用）

import { parseTables } from '../lib/table.mjs';
import { cellText, stripNoise, toYen } from '../lib/dom.mjs';

export const providerId = 'mineo';
export const providerName = 'mineo';
export const channelId = 'official';
export const category = 'mobile';

const PRICE_PAGE = /mineo\.jp\/price\/?$/;
const MYPITA_PAGE = /mineo\.jp\/price\/mypita\/?$/;
const TYPES = [
  { key: 'デュアル', voice: true, heading: /デュアルタイプ/, label: '音声通話＋データ通信' },
  { key: 'シングル', voice: false, heading: /シングルタイプ/, label: 'データ通信のみ' },
];

export function extractAll(pages) {
  const warnings = [];
  const price = pages.find((p) => PRICE_PAGE.test(p.url));
  const mypita = pages.find((p) => MYPITA_PAGE.test(p.url));
  if (!price || !mypita) {
    warnings.push('料金ページ（/price/）とマイピタのページ（/price/mypita/）の両方が targets.json に必要');
    return { offers: [], notices: [], warnings };
  }

  const clean = stripNoise(price.html);
  const { tables } = parseTables(clean);

  const courses = readCourseTables(clean, tables);
  if (!courses) {
    warnings.push('マイピタの月額表（デュアル・シングル）を2枚とも特定できない（書式が変わった疑い）');
    return { offers: [], notices: [], warnings };
  }

  const initial = readInitialFees(tables);
  if (initial.adminFee == null) warnings.push('契約事務手数料が読めない → 実質月額は出さない');
  if (initial.simCard == null) warnings.push('SIMカード発行料が読めない → SIMカードの行は実質月額を出さない');
  if (initial.esim == null) warnings.push('eSIMプロファイル発行料が読めない → eSIMの行は実質月額を出さない');

  const cross = readMypita(cellText(stripNoise(mypita.html)));

  const offers = [];
  for (const type of TYPES) {
    for (const c of courses[type.key]) {
      const mismatch = [];
      const other = cross.get(`${type.key}/${c.gb}`);
      if (other == null) mismatch.push(`/price/mypita/ に ${c.gb}GB・${type.key}タイプの月額が見当たらない`);
      else if (other !== c.monthly) mismatch.push(`/price/ ${c.monthly}円 ≠ /price/mypita/ ${other}円`);

      for (const sim of [
        { key: 'SIMカード', fee: initial.simCard },
        { key: 'eSIM', fee: initial.esim },
      ]) {
        const adminFee = initial.adminFee == null || sim.fee == null ? null : initial.adminFee + sim.fee;
        const planKey = `マイピタ / ${type.key} / ${c.gb}GB / ${sim.key}`;
        if (mismatch.length) warnings.push(`検算が合わない [${planKey}]: ${mismatch.join(' / ')}`);
        offers.push({
          providerId,
          providerName,
          channelId,
          category,
          sourceUrl: price.url,
          crossCheckUrl: mypita.url,
          planKey,
          planLabel: `マイピタ ${c.gb}GB（${type.label}・${sim.key}）`,
          plan: { plan: 'マイピタ', voice: type.voice, simForm: sim.key, dataFromGb: 0, dataToGb: c.gb },
          contractMonths: null,
          contractNote: initial.exitFeeFree ? '解約手数料は無料と料金ページの表に記載' : '解約手数料の記載を読めていない',
          monthlySchedule: [{ fromMonth: 1, toMonth: null, amount: c.monthly }],
          // 初期費用 = 契約事務手数料 + SIMの発行料（形で違う）。内訳を残す
          adminFee,
          adminFeeBreakdown: { contract: initial.adminFee, simIssue: sim.fee },
          constructionFee: { list: 0, installmentMonths: null, borne: 0, residualOnEarlyExit: false, note: '工事なし（SIM）' },
          cashbacks: [],
          requiredOptions: [],
          proratedFirstMonth: null, // 読んでいない
          campaignNote: '家族割引・複数回線割引・親思い割引・おかえり割引・キャンペーンは条件付きのため実質月額に算入しない',
          setBenefits: [],
          verificationMethod: '/price/ の表と /price/mypita/ のコース紹介で月額が一致（契約事務手数料・発行料は /price/ の表のみ）',
          verified: mismatch.length === 0 && adminFee != null,
          ...(mismatch.length ? { mismatch } : {}),
        });
      }
    }
  }
  return { offers, notices: [], warnings };
}

/**
 * 「コース / 月額基本料金」の表を2枚探し、直前の見出しでデュアル／シングルを決める。
 * どちらかが欠けたり3枚以上あったりしたら null（どれが何か機械に決めさせない）。
 */
export function readCourseTables(clean, tables) {
  const found = tables.filter((t) => /コース/.test(t.rows[0]?.[0] ?? '') && /月額基本料金/.test(t.rows[0]?.[1] ?? ''));
  if (found.length !== 2) return null;
  const out = {};
  let prevEnd = 0;
  for (const t of tables) {
    if (found.includes(t)) {
      const before = cellText(clean.slice(Math.max(prevEnd, t.start - 3000), t.start));
      const pos = TYPES.map((ty) => ({ ty, at: lastMatch(before, ty.heading) })).filter((x) => x.at >= 0).sort((a, b) => b.at - a.at);
      if (!pos.length) return null;
      const key = pos[0].ty.key;
      if (out[key]) return null; // 同じ種別が2枚 → 判定がおかしい
      const rows = t.rows.slice(1).map((r) => ({ gb: Number(/^(\d+)\s*GB$/.exec(String(r[0]).trim())?.[1]), monthly: toYen(r[1]) }));
      if (!rows.length || rows.some((r) => !Number.isFinite(r.gb) || r.monthly == null)) return null;
      out[key] = rows;
    }
    prevEnd = t.end;
  }
  return out['デュアル'] && out['シングル'] ? out : null;
}

function lastMatch(text, re) {
  let at = -1;
  for (const m of text.matchAll(new RegExp(re.source, 'g'))) at = m.index;
  return at;
}

/** 初期費用の表（契約事務手数料・SIMカード発行料・eSIMプロファイル発行料）。A プランの列を読む */
export function readInitialFees(tables) {
  const t = tables.find((x) => x.rows.some((r) => /^契約事務手数料$/.test(String(r[0]).trim())));
  const cell = (re) => t?.rows.find((r) => re.test(String(r[0])))?.[1];
  const yenOrFree = (v) => (v == null ? null : /^\s*無料\s*$/.test(v) ? 0 : toYen(v));
  const exit = tables.find((x) => x.rows.some((r) => /^解約手数料$/.test(String(r[0]).trim())));
  return {
    adminFee: yenOrFree(cell(/^契約事務手数料$/)),
    simCard: yenOrFree(cell(/SIMカード\s*発行料/)),
    esim: yenOrFree(cell(/eSIMプロファイル発行料/)),
    exitFeeFree: /^\s*無料\s*$/.test(exit?.rows.find((r) => /^解約手数料$/.test(String(r[0]).trim()))?.[1] ?? ''),
  };
}

/** 「3GB 音声通話＋データ通信 （デュアルタイプ） 1,298 円/月 データ通信のみ （シングルタイプ） 880 円/月」を読む */
export function readMypita(text) {
  const out = new Map();
  const re = /(\d+)\s*GB\s*音声通話＋データ通信\s*[（(]\s*デュアルタイプ\s*[）)]\s*([0-9][0-9,]*)\s*円\/月\s*データ通信のみ\s*[（(]\s*シングルタイプ\s*[）)]\s*([0-9][0-9,]*)\s*円\/月/g;
  for (const m of text.matchAll(re)) {
    const gb = Number(m[1]);
    const set = (k, v) => {
      const n = Number(v.replace(/,/g, ''));
      // 同じコースが2回出て値が違えば、どちらとも決めない
      if (out.has(k) && out.get(k) !== n) out.set(k, NaN);
      else out.set(k, n);
    };
    set(`デュアル/${gb}`, m[2]);
    set(`シングル/${gb}`, m[3]);
  }
  return out;
}
