// failures — 収集元ごとの「何回続けて失敗しているか」を持ち越す。
//
// なぜ必要か（2026-08-24に実測して分かった欠陥）:
//   収集元を故意に1つ壊して走らせたところ、**終了コード0で通った。**
//   「半分以上落ちたら赤くする」という閾値にしていたため、
//   13ある収集元のうち6つまでが静かに死んでいても気づけない状態だった。
//   これは死活監視を作った目的そのものを裏切っている。
//
// かといって1回の失敗で毎回赤くすると、相手サーバーの一時的な不調で
// 狼少年になる。そこで「1回の失敗」と「続いている失敗」を分ける:
//
//   1回だけ失敗      → 記録するが赤くしない（一時的な不調とみなす）
//   2回続けて失敗    → **赤くする**（収集元が変わった／遮断されたとみなす）
//   半分以上が失敗   → 回数によらず即座に赤くする（大規模な破損）
//
// 併せて staleSince（いつから更新できていないか）を持つ。
// サイト側はこれを見て「更新停止中」と表示する（docs/04 の品質ゲート5）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(HERE, '..', '..', 'data', 'failures.json');

/** 続けてこの回数失敗したら赤くする */
export const ESCALATE_AFTER = 2;

/** 1回の実行でこの割合を超えて失敗したら、回数によらず即座に赤くする */
export const MASS_FAILURE_RATIO = 0.5;

export async function loadFailureState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return { updatedAt: null, sources: {} };
  }
}

export async function saveFailureState(state) {
  state.updatedAt = new Date().toISOString();
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * 1件の収集結果を記録する。
 * @returns {{ consecutive: number, staleSince: string|null }} 記録後の状態
 */
export function recordOutcome(state, key, ok, info = {}) {
  const now = new Date().toISOString();
  const prev = state.sources[key];

  if (ok) {
    // 成功したら連続失敗はリセットする。**部分的な成功でリセットしない**のは
    // 呼び出し側の責任（ページ単位でキーを分けること）。
    state.sources[key] = { consecutive: 0, lastOkAt: now, staleSince: null, lastStatus: 'ok' };
    return state.sources[key];
  }

  const consecutive = (prev?.consecutive ?? 0) + 1;
  state.sources[key] = {
    consecutive,
    lastOkAt: prev?.lastOkAt ?? null,
    // 最初に失敗した時刻を保つ。ここからサイト側で「◯日更新停止中」を出す
    staleSince: prev?.staleSince ?? now,
    lastFailedAt: now,
    lastStatus: info.status ?? 'failed',
    lastDetail: info.detail ?? null,
  };
  return state.sources[key];
}

/** 続けて ESCALATE_AFTER 回以上失敗している収集元 */
export function escalated(state, keys = null) {
  return Object.entries(state.sources)
    .filter(([k]) => !keys || keys.includes(k))
    .filter(([, v]) => (v.consecutive ?? 0) >= ESCALATE_AFTER)
    .map(([key, v]) => ({ key, ...v }));
}

/**
 * この実行を失敗（終了コード1）にすべきかを判定し、理由を返す。
 * @param {object} state       記録後の失敗状態
 * @param {string[]} keys      この実行で扱ったキー
 * @param {number} failedCount この実行で失敗した件数
 */
export function shouldFail(state, keys, failedCount) {
  const reasons = [];

  if (keys.length && failedCount / keys.length > MASS_FAILURE_RATIO) {
    reasons.push(`${failedCount}/${keys.length} が同時に失敗。大規模な破損を疑う`);
  }
  for (const e of escalated(state, keys)) {
    reasons.push(
      `${e.key} が${e.consecutive}回続けて失敗（${e.staleSince} から更新できていない）: ${e.lastStatus} ${e.lastDetail ?? ''}`.trim()
    );
  }
  return reasons;
}

/** 赤くする理由を人が読める形で出す */
export function reportFailures(reasons) {
  if (!reasons.length) return;
  console.error('\n異常:');
  for (const r of reasons) console.error(`  - ${r}`);
  console.error(
    '\n収集元の URL 変更・構造変更・遮断を疑うこと。' +
      '\n古い値を出し続けるのは単なる不具合ではなく、事実と異なる情報の掲示にあたる。'
  );
}
