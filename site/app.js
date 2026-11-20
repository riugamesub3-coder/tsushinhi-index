// 条件の切り替え（トップページ）。site/build.mjs が dist/app.js にそのまま出す。
//
// ★ここでは**値を作らない**。表の各行に埋め込まれた実質月額（data/ の値そのもの）を
//   条件で選び、安い順に並べ替え、順位の数字を振り直すだけ。
// ★外部へ何も送らない。Cookie も localStorage も使わない（/privacy/ の記述と一致させる）。
//   選んだ条件は URL の # 以降にだけ残す（そのまま人に送れるように）。
// ★JSが動かなくても、既定の条件の答えと一覧はHTMLだけで読める。
(() => {
  'use strict';
  const form = document.getElementById('picker');
  const table = document.getElementById('ranking');
  if (!form || !table) return;

  const tbody = table.tBodies[0];
  const rows = Array.from(tbody.rows).filter((r) => r.dataset.id);
  const podium = document.getElementById('podium');
  const tpl = document.getElementById('tpl-cards');
  const count = document.getElementById('count');
  const label = document.getElementById('cond-label');
  const empty = document.getElementById('empty');
  const hint = document.getElementById('young-hint');
  const yen = (n) => `${Number(n).toLocaleString('ja-JP')}円`;

  const read = () => {
    const c = {};
    for (const el of form.querySelectorAll('input[type=radio]:checked')) c[el.name] = el.value;
    return c;
  };
  const labelOf = (c) => Array.from(form.querySelectorAll('fieldset')).map((fs) => {
    const on = fs.querySelector('input:checked');
    return on ? (on.dataset.short || on.nextElementSibling.textContent) : '';
  }).join('・');

  const fits = (r, c) =>
    (r.dataset.b === 'both' || r.dataset.b === c.b) &&
    r.dataset.e === c.e &&
    (c.s === 'any' || r.dataset.s === c.s) &&
    (c.y === '1' || r.dataset.y === '0');

  const byValue = (a, b) => Number(a.dataset.v) - Number(b.dataset.v) ||
    a.dataset.provider.localeCompare(b.dataset.provider);

  function card(row, rank, others) {
    const src = tpl && tpl.content.querySelector(`[data-id="${CSS.escape(row.dataset.id)}"]`);
    if (!src) return null;
    const li = src.cloneNode(true);
    const r = li.querySelector('.pick-rank');
    r.textContent = String(rank);
    r.setAttribute('aria-label', `${rank}位`);
    li.querySelector('.pick-range').textContent = others.length
      ? `同じ会社のほかの条件 ${others.length}件（〜${yen(others[others.length - 1].dataset.v)}）は下の一覧に`
      : '';
    return li;
  }

  function apply(save) {
    const c = read();
    const hit = rows.filter((r) => fits(r, c)).sort(byValue);
    for (const r of rows) r.hidden = true;
    hit.forEach((r, i) => {
      r.hidden = false;
      r.cells[0].textContent = String(i + 1);
      r.classList.toggle('top', i < 3);
      tbody.appendChild(r);
    });

    // 答えの欄: 会社ごとに安いものを1つずつ、3社まで
    const groups = new Map();
    for (const r of hit) {
      if (!groups.has(r.dataset.pid)) groups.set(r.dataset.pid, []);
      groups.get(r.dataset.pid).push(r);
    }
    const top = Array.from(groups.values()).slice(0, 3);
    if (podium) podium.replaceChildren(...top.map((g, i) => card(g[0], i + 1, g.slice(1))).filter(Boolean));

    // 30歳以上を選んでいるとき、29歳以下ならもっと安い値があるかだけ知らせる
    if (hint) {
      const young = rows.filter((r) => fits(r, { ...c, y: '1' }) && r.dataset.y === '1').sort(byValue)[0];
      const show = c.y === '0' && young && (!hit[0] || Number(young.dataset.v) < Number(hit[0].dataset.v));
      hint.hidden = !show;
      if (show) {
        hint.innerHTML = '';
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = '29歳以下なら';
        // 出典と取得時刻は表の行にあるものをそのまま複製する（値の隣に必ず出典を置く）
        const srcCell = young.querySelector('td.src');
        const link = srcCell && srcCell.querySelector('a');
        const time = srcCell && srcCell.querySelector('time');
        hint.append(chip, ` ${young.dataset.provider}の${young.dataset.plan}が${yen(young.dataset.v)}／月（出典 `);
        if (link) hint.append(link.cloneNode(true));
        if (time) hint.append(' ', time.cloneNode(true));
        hint.append('）。年齢で「29歳以下」を選ぶと順位に入ります。');
      }
    }

    if (count) count.textContent = String(hit.length);
    const countA = document.getElementById('count-a');
    if (countA) countA.textContent = String(hit.length);
    if (label) label.textContent = labelOf(c);
    if (empty) empty.hidden = hit.length > 0;
    if (save) {
      try { history.replaceState(null, '', `#${new URLSearchParams(c)}`); } catch (_) { /* 何もしない */ }
    }
  }

  // URL の # から条件を戻す（共有されたリンクで同じ結果を出す）
  function restore() {
    try {
      const p = new URLSearchParams(location.hash.slice(1));
      for (const [k, v] of p) {
        const el = form.querySelector(`input[name="${CSS.escape(k)}"][value="${CSS.escape(v)}"]`);
        if (el) el.checked = true;
      }
    } catch (_) { /* 壊れた # は無視して既定の条件で出す */ }
  }

  form.addEventListener('change', () => apply(true));
  // 同じページのまま # だけ変わったとき（戻る・リンク）にも合わせる
  window.addEventListener('hashchange', () => { restore(); apply(false); });
  form.classList.add('is-live');
  restore();
  apply(false);
})();
