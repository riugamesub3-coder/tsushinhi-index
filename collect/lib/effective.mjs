// effective — 実質月額の統一計算式。この事業の中核資産。
//
// なぜ独自に計算するのか:
//   各社が「実質○円」を自社に有利な条件で出しており、横並び比較が成立していない。
//   キャッシュバックの受取時期・必須オプション・工事費の実負担・契約期間 ——
//   どれを含めるかがバラバラ。全社を同じ式に通して初めて比較になる。
//
// 式（docs/04_データ定義.md と完全に一致させること。サイト上にも同じ式を公開する）:
//
//   実質月額 = ( 月額の合計 + 工事費の実負担額 + 事務手数料
//              + 必須オプション費用 × 加入必要月数
//              - キャッシュバック額 - その他割引の総額 ) ÷ 契約月数
//
// ★守る原則: **欠損を埋めない。** 一項目でも不明なら実質月額は null。
//   埋めた瞬間にこのデータは信用を失う。それは不具合ではなく
//   ASP規約上の「事実と異なる情報を用いた宣伝」に近づく行為でもある。

/**
 * 月額スケジュールから、1..months か月目の月額を配列で返す。
 * schedule: [{ fromMonth, toMonth（null=以降ずっと）, amount }]
 * 隙間や重なりがあれば例外にせず missing に積んで null を返す。
 */
export function expandMonthly(schedule, months) {
  const out = [];
  for (let m = 1; m <= months; m++) {
    const hit = schedule.filter((s) => m >= s.fromMonth && (s.toMonth == null || m <= s.toMonth));
    if (hit.length !== 1) return null; // 0件=隙間 / 2件以上=重複。どちらも定義が壊れている
    if (hit[0].amount == null) return null;
    out.push(hit[0].amount);
  }
  return out;
}

/**
 * 実質月額を計算する。
 *
 * @param {object} offer 正規化済みの観測（各社アダプタの出力）
 * @param {number} months 何か月で均すか（36が全社共通の比較軸）
 * @returns {{ months, effectiveMonthly, total, breakdown, missing }}
 *   effectiveMonthly は円未満切り捨てではなく**四捨五入**。丸め方も公開する。
 */
export function computeEffectiveMonthly(offer, months) {
  const missing = [];
  const push = (k) => missing.push(k);

  const monthly = expandMonthly(offer.monthlySchedule ?? [], months);
  if (monthly == null) push('monthlySchedule');

  const monthlyTotal = monthly ? monthly.reduce((a, b) => a + b, 0) : null;

  // 事務手数料。0円の事業者もあるので「未取得」と 0 を区別する
  const adminFee = offer.adminFee;
  if (adminFee == null) push('adminFee');

  // 工事費の実負担。分割請求額の合計から割引の合計を引く。
  // 契約月数が分割回数より短い場合は、その時点までの分だけを負担として数える。
  const con = offer.constructionFee ?? {};
  let constructionBorne = null;
  if (con.monthlySchedule) {
    const charge = expandMonthly(con.monthlySchedule, months);
    const discount = expandMonthly(con.discountSchedule ?? [], months);
    if (charge == null || discount == null) push('constructionFee');
    else constructionBorne = sum(charge) - sum(discount);
  } else if (con.borne != null) {
    constructionBorne = con.borne;
  } else {
    push('constructionFee');
  }

  // 必須オプション（キャッシュバック条件などで加入が必要なもの）
  let optionTotal = 0;
  for (const o of offer.requiredOptions ?? []) {
    if (o.monthlyFee == null || o.requiredMonths == null) {
      push(`requiredOption:${o.name ?? '?'}`);
      optionTotal = null;
      break;
    }
    optionTotal += o.monthlyFee * Math.min(o.requiredMonths, months);
  }

  // キャッシュバック。**受取時期が計算期間を超える分は算入しない。**
  // 受け取れるかどうか分からないものを値引きとして数えると数字が甘くなる。
  //
  // ★`cashbacks` は配列でなければならない。「特典なし」は `[]`、「読めなかった」は `null`。
  //   以前ここは `offer.cashbacks ?? []` だった。**アダプタが「読めなかったから計算を止めろ」と
  //   null を立てても、空配列に化けて「特典0円」として計算が通っていた**（2026-08-25 発見）。
  //   実際 So-net の 1ギガ専用ページは特典欄の書式が別で、同じプランが
  //   3,879円ではなく4,296円と算出され、しかも verified=true で出ていた。
  //   欠測は必ず null に倒す。黙って0円と読み替えない。
  let cashbackCounted = 0;
  const excludedCashback = [];
  if (!Array.isArray(offer.cashbacks)) {
    push('cashbacks');
    cashbackCounted = null;
  } else for (const cb of offer.cashbacks) {
    if (cb.amount == null) { push('cashback.amount'); cashbackCounted = null; break; }
    if (cb.receiveAtMonth == null) { push('cashback.receiveAtMonth'); cashbackCounted = null; break; }
    if (cb.receiveAtMonth <= months) cashbackCounted += cb.amount;
    else excludedCashback.push(cb);
  }

  const otherDiscounts = offer.otherDiscountTotal ?? 0;

  const parts = [monthlyTotal, adminFee, constructionBorne, optionTotal, cashbackCounted];
  const ok = missing.length === 0 && parts.every((p) => p != null);

  const total = ok
    ? monthlyTotal + adminFee + constructionBorne + optionTotal - cashbackCounted - otherDiscounts
    : null;

  return {
    months,
    effectiveMonthly: ok ? Math.round(total / months) : null,
    total,
    breakdown: ok
      ? {
          monthlyTotal,
          adminFee,
          constructionBorne,
          optionTotal,
          cashbackCounted,
          otherDiscounts,
          excludedCashback: excludedCashback.map((c) => ({ ...c, reason: '受取時期が計算期間外' })),
        }
      : null,
    missing,
  };
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

/** この式をそのまま人間向けに書き出す。サイト公開用。docs/04 と同じ文言を保つこと */
export const FORMULA_TEXT =
  '実質月額 = ( 月額の合計 + 工事費の実負担額 + 事務手数料 + 必須オプション費用×加入必要月数 ' +
  '- キャッシュバック額 - その他割引の総額 ) ÷ 契約月数';

/**
 * 同じプランが複数の収集元ページに載っている場合をまとめる。
 *
 * ★So-net光で実際に起きた（2026-08-25）。1ギガMは
 *   /access/hikari/ にも /access/hikari/1g/ にも載っている。
 *   - 黙って両方残すと、比較表に同じ行が2つ出る
 *   - 黙って片方を捨てると、**ページ間の食い違い＝どちらかの読み違いに気づけない**
 *
 * → 料金に関わる項目が完全に一致するときだけ1件にまとめる。
 *   食い違ったら**両方とも検算不合格にして公開から外し、赤くする**。
 *   どちらが正しいか機械には決められないので、正しそうな方を選ぶことはしない。
 *
 * 消えたことにはしない（両方 offers に残す）。verified を落とすだけなので、
 * 変化検知は「プランが見当たらなくなった」という誤報を出さない。
 */
export function dedupeAcrossPages(offers, warnings) {
  const first = new Map();
  const merged = [];
  const conflicts = [];

  for (const o of offers) {
    const seen = first.get(o.planKey);
    if (!seen) {
      first.set(o.planKey, o);
      merged.push(o);
      continue;
    }
    if (pricingFingerprint(seen) === pricingFingerprint(o)) {
      seen.alsoSeenAt = [...(seen.alsoSeenAt ?? []), o.sourceUrl];
      continue; // 完全一致。1件にまとめる
    }
    const why = `同じプランがページ間で食い違う [${o.planKey}]: ${seen.sourceUrl} と ${o.sourceUrl}`;
    warnings.push(why);
    conflicts.push(why);
    seen.verified = false;
    o.verified = false;
    o.mismatch = [...(o.mismatch ?? []), why];
    merged.push(o); // 「消えた」ことにしないため両方残す
  }
  return { merged, conflicts };
}

/** 料金に関わる項目だけを取り出した指紋。sourceUrl や注記の違いは無視する */
function pricingFingerprint(o) {
  return JSON.stringify([
    o.monthlySchedule, o.adminFee, o.constructionFee?.monthlySchedule,
    o.constructionFee?.discountSchedule, o.constructionFee?.borne,
    (o.cashbacks ?? null) && o.cashbacks.map((c) => [c.amount, c.receiveAtMonth]),
    o.requiredOptions, o.otherDiscountTotal ?? 0,
  ]);
}
