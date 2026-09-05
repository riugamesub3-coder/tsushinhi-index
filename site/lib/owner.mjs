// owner — 運営者情報の読み取りのうち、間違えると静かに困るもの。
//
// ★build.mjs は読み込むと main() が走るのでテストから import できない。
//   検証つきの処理はここに置く。テストできない場所に置いた検証は、次も見逃す。

/**
 * Search Console の所有権確認トークンを取り出す。
 *
 * ★形式が想定と違えばビルドを止める。所有権が確認できないまま「入れたつもり」で
 *   放置されるのが最悪で、その間インデックス状況を誰も確認できない。
 * ★タグまるごと貼られても content だけ取り出す。Googleは「タグを一切変更せずに使う」よう
 *   求めているので、出す形は公式の形そのままにする。
 */
export function searchConsoleToken(owner) {
  const raw = String(owner?.searchConsoleVerification ?? '').trim();
  if (!raw) return null;
  const inTag = /content\s*=\s*["']([^"']+)["']/.exec(raw);
  const token = (inTag ? inTag[1] : raw).trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) {
    throw new Error(`site/owner.json の searchConsoleVerification がトークンの形をしていません: ${JSON.stringify(raw.slice(0, 40))}`);
  }
  return token;
}
