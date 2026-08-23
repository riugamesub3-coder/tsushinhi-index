// HTTPユーティリティ。依存ゼロ（Node 18+ の fetch を使用）。
//
// 方針:
//   - 相手サーバーに負荷をかけない（直列＋間隔）
//   - 自分が誰か名乗る
//   - 失敗を握りつぶさない。構造化して返す

export const UA =
  'tsushinhi-index/0.1 (+https://github.com/riugamesub3-coder/tsushinhi-index) Node/' +
  process.versions.node;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * リトライ付き fetch。
 * 5xx とネットワークエラーは指数バックオフで再試行する。4xx は再試行しない。
 * @returns {Promise<{ok:boolean, status:number|null, text:string|null, error:string|null, attempts:number, elapsedMs:number}>}
 */
export async function fetchWithRetry(
  url,
  { retries = 2, baseDelayMs = 1500, timeoutMs = 30000, headers = {} } = {}
) {
  const startedAt = Date.now();
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', ...headers },
      });
      clearTimeout(timer);
      lastStatus = res.status;

      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          text: await res.text(),
          error: null,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (res.status >= 400 && res.status < 500) {
        return {
          ok: false,
          status: res.status,
          text: null,
          error: `HTTP ${res.status}`,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
        };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      clearTimeout(timer);
      lastError = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e.message || e);
    }

    if (attempt <= retries) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }

  return {
    ok: false,
    status: lastStatus,
    text: null,
    error: lastError,
    attempts: retries + 1,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * robots.txt を取得し、指定パスが `*` 向けルールで許可されているか判定する。
 * Disallow/Allow の最長一致という主要ルールのみを見る。判定に迷う場合は不許可側に倒す。
 */
export async function checkRobots(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch {
    return { ok: false, allowed: null, note: null, error: 'invalid URL' };
  }

  const res = await fetchWithRetry(`${u.origin}/robots.txt`, { retries: 1, timeoutMs: 15000 });

  if (!res.ok) {
    // robots.txt が無い(404) = 制限なしとみなすのが慣行
    if (res.status === 404) {
      return { ok: true, allowed: true, note: 'robots.txt なし（制限なしとみなす）', error: null };
    }
    return { ok: false, allowed: null, note: null, error: `robots.txt 取得失敗: ${res.error}` };
  }

  // robots.txt のはずが HTML が返る = bot対策やエラーページの可能性。安全側に倒して不明扱い
  if (/^\s*<(!doctype|html)/i.test(res.text)) {
    return { ok: false, allowed: null, note: null, error: 'robots.txt の代わりにHTMLが返った（要手動確認）' };
  }

  const rules = parseRobots(res.text);
  const verdict = isAllowed(rules, u.pathname + (u.search || ''));
  return { ok: true, allowed: verdict.allowed, note: verdict.reason, error: null };
}

function parseRobots(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const groups = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === 'user-agent') {
      if (!current || current.hasRules) {
        current = { agents: [], rules: [], hasRules: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'disallow' || field === 'allow') && current) {
      current.hasRules = true;
      current.rules.push({ type: field, path: value });
    }
  }
  const star = groups.find((g) => g.agents.includes('*'));
  return star ? star.rules : [];
}

function isAllowed(rules, path) {
  let best = null;
  for (const r of rules) {
    if (r.path === '') continue; // "Disallow:" 空 = 制限なし
    if (!matches(r.path, path)) continue;
    const len = r.path.replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && r.type === 'allow')) {
      best = { type: r.type, path: r.path, len };
    }
  }
  if (!best) return { allowed: true, reason: '該当ルールなし' };
  return {
    allowed: best.type === 'allow',
    reason: `${best.type === 'allow' ? 'Allow' : 'Disallow'}: ${best.path}`,
  };
}

function matches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    '^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : '')
  );
  return re.test(path);
}
