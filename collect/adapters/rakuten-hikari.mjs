// 楽天ひかりアダプタ — 料金一覧ページから実質月額を計算できる形にする。
//
// ★他社と違う点が2つある。どちらも数字の意味を変えるので明示する。
//
// 1. **検算の手段が弱い。**
//    NURO光・So-net光は「内訳」と「適用後の月額」の両方を載せているので突き合わせができる。
//    楽天ひかりは割引が無く適用後の月額を載せていないため、その突き合わせができない。
//    代わりに、ページ内で二重に書かれている値の整合を検算する:
//      ・税抜 × 1.1 = 税込 か
//      ・工事費の「分割 × 回数」が「一括」とほぼ一致するか
//    何で検証したかは observation の verificationMethod に残す。
//
// 2. **キャンペーンを算入しない。**
//    楽天ひかりの特典「最強おうちプログラム」は毎月1,000ポイント還元＋工事費実質0円だが、
//    **楽天モバイルの契約が前提**。他サービスの契約を条件とする割引を算入すると、
//    その契約にかかる費用を無視して安く見せることになる。
//    NURO光の「NUROでんき／ガスとのセット割」を算入していないのと同じ扱いにする。
//    → 実質月額は**単体で契約した場合**の値。セット特典は setBenefits に事実として残す。

import { parseTables } from '../lib/table.mjs';
import { cellText, stripNoise, toYen } from '../lib/dom.mjs';

export const providerId = 'rakuten-hikari';
export const providerName = '楽天ひかり';
export const channelId = 'official';

const PLANS = [
  { key: 'マンション', match: /マンションプラン/, workTable: /マンションプラン/ },
  { key: '戸建て', match: /ファミリープラン/, workTable: /ファミリープラン/ },
];

export function extract(html, url) {
  const clean = stripNoise(html);
  const { tables } = parseTables(clean);
  const warnings = [];
  const sections = sectionTitles(clean, tables);

  const monthly = findTable(tables, (t) => /プラン名/.test(t.rows[0]?.[0] ?? '') && /月額/.test(t.rows[0]?.[1] ?? ''));
  const signup = findTable(tables, (t) => /契約状況/.test(t.rows[0]?.[0] ?? '') && /初期登録費/.test(t.rows[0]?.[1] ?? ''));
  if (!monthly || !signup) {
    warnings.push('月額基本料または初期登録費の表が見つからない');
    return { offers: [], notices: readNotices(clean), warnings };
  }

  // 初月無料はキャンペーンではなくページ記載の恒常ルール（日割りせず初月無料）
  const firstMonthFree = /日割り計算を行わず初月を無料/.test(cellText(clean));

  const offers = [];
  for (const plan of PLANS) {
    const row = monthly.rows.find((r) => plan.match.test(r[0] ?? ''));
    if (!row) { warnings.push(`月額基本料が読めない: ${plan.key}`); continue; }

    const taxIncluded = yenTaxIncluded(row[1]);
    const taxExcluded = toYen(row[1]);
    if (taxIncluded == null) { warnings.push(`月額基本料の税込額が読めない: ${plan.key}`); continue; }

    for (const status of signup.rows.slice(1)) {
      const statusName = normalizeStatus(status[0]);
      const adminFee = yenTaxIncluded(status[1]) ?? toYen(status[1]);
      const isTransfer = /転用|事業者変更/.test(statusName);

      // 工事費の表は「新規」と「転用・事業者変更」で別。プラン別なのは新規のみ
      const workTable = isTransfer
        ? findTable(tables, (t, i) => /事業者変更・転用/.test(sections[i] ?? ''))
        : findTable(tables, (t, i) => plan.workTable.test(sections[i] ?? '') && /一括/.test(t.rows[2]?.[0] ?? ''));
      if (!workTable) { warnings.push(`工事費の表が見つからない: ${plan.key} / ${statusName}`); continue; }

      for (const work of readWorkOptions(workTable)) {
        const offer = {
          providerId,
          providerName,
          channelId,
          sourceUrl: url,
          planKey: [plan.key, statusName, work.name].join(' / '),
          plan: { building: plan.key, entry: statusName, work: work.name },
          contractMonths: null,
          contractNote: '契約期間・契約解除料は適用キャンペーンにより異なるとページに記載',
          monthlySchedule: firstMonthFree
            ? [
                { fromMonth: 1, toMonth: 1, amount: 0 },        // 初月無料（日割りなし）
                { fromMonth: 2, toMonth: null, amount: taxIncluded },
              ]
            : [{ fromMonth: 1, toMonth: null, amount: taxIncluded }],
          adminFee,
          constructionFee: {
            list: work.lump,
            installmentMonths: work.installmentMonths,
            borne: work.lump,   // 単体契約では工事費の割引が無いため全額負担
            residualOnEarlyExit: work.lump > 0,
          },
          cashbacks: [],
          requiredOptions: [],
          proratedFirstMonth: false,
          verificationMethod: '税抜×1.1=税込 / 工事費の分割×回数≈一括 の内部整合（公開されている適用後月額が無いため突き合わせ不可）',
          setBenefits: readSetBenefits(clean),
        };

        const mismatch = internalCheck({ taxExcluded, taxIncluded, work });
        offer.verified = mismatch.length === 0;
        if (mismatch.length) {
          offer.mismatch = mismatch;
          warnings.push(`内部整合が取れない [${offer.planKey}]: ${mismatch.join(' / ')}`);
        }
        offers.push(offer);
      }
    }
  }

  return { offers, notices: readNotices(clean), warnings };
}

// ── 表の読み取り ─────────────────────────────────────────────────

function findTable(tables, pred) {
  for (let i = 0; i < tables.length; i++) if (pred(tables[i], i)) return tables[i];
  return null;
}

/** 各表の直前の見出し（工事費の表がどのプラン向けかを決めるのに使う） */
function sectionTitles(html, tables) {
  const heads = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => ({ at: m.index, text: cellText(m[2]) }));
  return tables.map((t) => heads.filter((h) => h.at < t.start).pop()?.text ?? '');
}

/**
 * 工事費の表を「工事の区分 → 一括額・分割額」に開く。
 *   行0: ['', 派遣工事あり, 派遣工事あり, 派遣工事なし]
 *   行1: ['', 配線調整あり, 配線調整なし, 派遣工事なし]
 *   行2: ['一括', 22,000円, 11,660円, 3,300円]
 *   行3: ['分割（24回）', 916円/月, 485円/月, 137円/月]
 */
function readWorkOptions(t) {
  const head1 = t.rows[0] ?? [];
  const head2 = t.rows[1] ?? [];
  const lump = t.rows.find((r) => /^一括/.test(r[0] ?? ''));
  const split = t.rows.find((r) => /分割/.test(r[0] ?? ''));
  if (!lump) return [];

  const installmentMonths = Number(/(\d+)\s*回/.exec(split?.[0] ?? '')?.[1] ?? '') || null;
  const out = [];
  for (let i = 1; i < lump.length; i++) {
    const amount = yenTaxIncluded(lump[i]) ?? toYen(lump[i]);
    if (amount == null) continue;
    const name = [head1[i], head2[i]].filter(Boolean).filter((v, j, a) => a.indexOf(v) === j).join('・');
    out.push({
      name: name || `工事区分${i}`,
      lump: amount,
      monthly: split ? toYen(split[i]) : null,
      installmentMonths,
    });
  }
  return out;
}

/** 「3,800円（税込4,180円）」から税込の 4,180 を取る。先頭の金額は税抜なので使わない */
function yenTaxIncluded(text) {
  if (text == null) return null;
  const s = String(text).replace(/\s/g, '');
  const m = /税込\s*([0-9][0-9,]*)\s*円?/.exec(s);
  if (m) return Number(m[1].replace(/,/g, ''));
  if (/（税込）|\(税込\)/.test(s)) return toYen(s); // 「22,000円（税込）」は表示額がそのまま税込
  return null;
}

function normalizeStatus(text) {
  const s = cellText(String(text));
  if (/転用/.test(s)) return '転用';
  if (/事業者変更/.test(s)) return '事業者変更';
  return '新規';
}

/** ページ内で二重に書かれている値どうしの整合を検算する */
function internalCheck({ taxExcluded, taxIncluded, work }) {
  const out = [];
  if (taxExcluded != null) {
    const expected = Math.round(taxExcluded * 1.1);
    if (Math.abs(expected - taxIncluded) > 1) out.push(`税抜${taxExcluded}×1.1=${expected} ≠ 税込${taxIncluded}`);
  }
  if (work.monthly != null && work.installmentMonths) {
    const total = work.monthly * work.installmentMonths;
    // 分割は端数調整が入るので、回数ぶんの誤差は許す
    if (Math.abs(total - work.lump) > work.installmentMonths) {
      out.push(`分割${work.monthly}×${work.installmentMonths}=${total} ≠ 一括${work.lump}`);
    }
  }
  return out;
}

/** セット特典は算入しないが、事実として残す（読者が判断できるように） */
function readSetBenefits(html) {
  const text = cellText(html);
  const out = [];
  if (/最強おうちプログラム/.test(text)) {
    out.push('最強おうちプログラム: 楽天モバイルとのセットで毎月1,000ポイント還元・工事費実質0円（楽天モバイル契約が前提のため実質月額には算入しない）');
  }
  return out;
}

const NOTICE_KEYWORDS = /料金改定|改定を予定|新規受付を終了|提供を終了/;

function readNotices(html) {
  return [...new Set(
    cellText(html)
      .split(/[。\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 10 && s.length <= 140 && NOTICE_KEYWORDS.test(s))
  )].slice(0, 8);
}
