/* app.js —— 页面逻辑：加载快照、解析持仓、渲染三个入口。
 * 所有计算在浏览器本地完成，持仓文件不上传服务器。 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const BASE = (location.pathname.replace(/[^/]*$/, '') || './');

  let SNAP = null, RET = null, ENGINE = null;
  const STATE = { positions: [], stated: {}, brief: null, match: null };

  const GOALS = ['长期增值', '稳定收入', '分散风险', '海外配置', '主题机会'];
  const pct = (x, n = 1) => (x == null ? '—' : (x * 100).toFixed(n) + '%');
  const num = (x, n = 2) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(n));
  const cls = (x) => (x == null ? '' : x > 0 ? 'up' : x < 0 ? 'down' : '');

  // ------------------------------------------------------------ 数据加载 --
  async function boot() {
    $('#loading').hidden = false;
    try {
      SNAP = await fetchJSON(BASE + 'data/snapshot.json');
    } catch (e) {
      document.body.innerHTML = '<div class="wrap"><div class="empty"><h2>数据加载失败</h2><p>'
        + '无法读取 data/snapshot.json。若以 file:// 打开，请改用本地 HTTP 服务：<br>'
        + '<code>python -m http.server 8000</code></p></div></div>';
      return;
    }
    const m = SNAP.meta || {};
    $('#meta').innerHTML = `数据日期 <b>${m.trade_date || '—'}</b> · 覆盖 <b>${m.etf_count || 0}</b> 只 ETF`
      + `（全市场 ${m.universe_size || 0} 只）<br>算法版本 ${m.algo_version || ''} · 生成于 ${m.generated_at || ''}`;
    ENGINE = new ETFEngine.Engine(SNAP, { dates: SNAP.dates, returns: {} });

    buildGoalChips();
    bind();
    // 收益序列较大，后台静默加载，匹配前就绪即可
    fetchJSON(BASE + 'data/returns.json').then((r) => {
      RET = r;
      ENGINE = new ETFEngine.Engine(SNAP, RET);
      $('#loading').hidden = true;
      if (STATE.positions.length) runAll();
    }).catch(() => { $('#loading').hidden = true; });
    setTimeout(() => { $('#loading').hidden = true; }, 2500);
  }

  function fetchJSON(u) {
    return fetch(u, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  // -------------------------------------------------------------- 绑定 --
  function bind() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.remove('active'));
      $$('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('#tab-' + t.dataset.tab).classList.add('active');
    }));
    $('#fileDash').addEventListener('change', (e) => onFile(e.target.files[0]));
    $('#fileMatch').addEventListener('change', (e) => onFile(e.target.files[0]));
    $('#useDemo').addEventListener('click', () => {
      STATE.positions = [
        { code: '510300', name: '沪深300ETF', weight: 0.18 },
        { code: '512480', name: '半导体ETF', weight: 0.15 },
        { code: '588000', name: '科创50ETF', weight: 0.12 },
        { code: '159915', name: '创业板ETF', weight: 0.10 },
        { code: '512690', name: '酒ETF', weight: 0.09 },
        { code: '518880', name: '黄金ETF', weight: 0.08 },
        { code: '512880', name: '证券ETF', weight: 0.08 },
        { code: '515790', name: '光伏ETF', weight: 0.07 },
        { code: '159941', name: '纳指ETF', weight: 0.07 },
        { code: '511990', name: '华宝添益', weight: 0.06 },
      ].map((p) => ({ ...p, source: 'demo' }));
      afterPositions();
    });
    $('#clearPos').addEventListener('click', () => {
      STATE.positions = []; afterPositions();
    });
    $('#runMatch').addEventListener('click', runAll);
  }

  function buildGoalChips() {
    $('#goalChips').innerHTML = GOALS.map((g) => `<span class="chip" data-g="${g}">${g}</span>`).join('');
    $$('#goalChips .chip').forEach((c) => c.addEventListener('click', () => c.classList.toggle('on')));
  }

  function readStated() {
    return {
      goals: $$('#goalChips .chip.on').map((c) => c.dataset.g),
      risk: $('#risk').value || null,
      horizon_years: $('#horizon').value === '' ? null : Number($('#horizon').value),
      focus_themes: $('#themes').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    };
  }

  // ---------------------------------------------------------- 文件解析 --
  async function onFile(f) {
    if (!f) return;
    $('#loading').hidden = false;
    $('#loading').textContent = '解析中…';
    try {
      const rows = await parseFile(f);
      if (!rows.length) throw new Error('未识别到有效持仓');
      STATE.positions = rows;
      afterPositions();
      $('#loading').textContent = `已载入 ${rows.length} 只 ETF`;
      setTimeout(() => { $('#loading').hidden = true; }, 1200);
    } catch (e) {
      $('#loading').textContent = '解析失败：' + e.message;
      setTimeout(() => { $('#loading').hidden = true; }, 2500);
    }
  }

  async function parseFile(f) {
    const name = (f.name || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const XLSX = await loadSheetJS();
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
      return parseGrid(grid.map((r) => r.map((c) => String(c).trim())));
    }
    let text = await f.text();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const sep = (lines[0].split(',').length >= lines[0].split('\t').length) ? ',' : '\t';
    return parseGrid(lines.map((l) => l.split(sep).map((c) => c.trim())));
  }

  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('Excel 解析库加载失败')));
      s.onerror = () => reject(new Error('无法加载 Excel 解析库，请把文件另存为 CSV 后上传'));
      document.head.appendChild(s);
    });
  }

  const HDR_MAP = {
    code: ['代码', '证券代码', '基金代码', 'code', 'ticker', 'symbol'],
    name: ['名称', '证券名称', '基金名称', 'name'],
    weight: ['权重', '占比', '仓位', 'weight', '比例'],
    market_value: ['市值', '持仓市值', 'market_value', '金额'],
    shares: ['份额', '数量', 'shares', '持有份额'],
    cost_price: ['成本价', '买入价', 'cost', '成本'],
    buy_date: ['买入日期', '建仓日期', 'buy_date', '日期'],
  };
  function mapHeader(h) {
    h = (h || '').trim().toLowerCase();
    for (const k in HDR_MAP) if (HDR_MAP[k].includes(h)) return k;
    return null;
  }

  function parseGrid(grid) {
    if (grid.length < 2) return [];
    let header = grid[0];
    let cols = header.map(mapHeader);
    let body = grid.slice(1);
    if (!cols.some(Boolean)) {   // 首行不是表头 → 下移一行
      header = grid[1] || [];
      cols = header.map(mapHeader);
      body = grid.slice(2);
    }
    const out = [];
    for (const cells of body) {
      const rec = {};
      cells.forEach((c, i) => { const k = cols[i]; if (k) rec[k] = c; });
      const code = (String(rec.code || '').match(/\d/g) || []).join('');
      if (code.length !== 6) continue;
      rec.code = code;
      const f = (k) => {
        if (rec[k] === undefined || rec[k] === '') return null;
        const v = parseFloat(String(rec[k]).replace(/[%,]/g, ''));
        return isFinite(v) ? v : null;
      };
      let w = f('weight');
      if (w != null && w > 1.5) w = w / 100;
      rec.weight = w;
      rec.market_value = f('market_value');
      rec.shares = f('shares');
      rec.cost_price = f('cost_price');
      rec.buy_date = rec.buy_date || null;
      out.push(rec);
    }
    const byMv = out.every((o) => o.weight == null) && out.some((o) => o.market_value);
    if (byMv) {
      const tot = out.reduce((a, o) => a + (o.market_value || 0), 0);
      out.forEach((o) => { o.weight = tot ? (o.market_value || 0) / tot : 0; });
    } else {
      const tot = out.reduce((a, o) => a + (o.weight || 0), 0);
      if (tot && Math.abs(tot - 1) > 0.02) out.forEach((o) => { o.weight = (o.weight || 0) / tot; });
    }
    out.forEach((o) => { o.name = o.name || ''; o.weight = o.weight || 0; o.source = 'csv'; });
    return out;
  }

  function afterPositions() {
    const has = STATE.positions.length > 0;
    $('#dashEmpty').hidden = has;
    $('#dashBody').hidden = !has;
    $('#profEmpty').hidden = has;
    $('#profBody').hidden = !has;
    $('#posPreview').innerHTML = STATE.positions.map((p) =>
      `<span class="pill">${p.code} ${p.name || ''} ${pct(p.weight, 1)}</span>`).join('');
    if (has && RET) runAll();
  }

  // -------------------------------------------------------------- 主流程 --
  function runAll() {
    if (!STATE.positions.length) return;
    STATE.stated = readStated();
    STATE.brief = ENGINE.brief(STATE.positions, STATE.stated);
    renderDash(STATE.brief);
    renderProfile(STATE.brief.profile);
    $('#matchStat').textContent = '匹配计算中…';
    setTimeout(() => {
      STATE.match = ENGINE.run(STATE.positions, STATE.stated, { top_k: 8 });
      renderMatch(STATE.match);
      $('#matchStat').textContent = `候选 ${STATE.match.n_candidates} → 深算 ${STATE.match.n_shortlist}`;
    }, 10);
  }

  // ------------------------------------------------------------ Dashboard --
  function renderDash(b) {
    $('#headline').textContent = b.headline;
    $('#signals').innerHTML = (b.signals || []).map((s) => `<li>${s}</li>`).join('');

    const pp = b.portfolio_pulse;
    const rows = [['组合当日', `<span class="${cls(pp.portfolio_pct)}">${pp.portfolio_pct == null ? '—' : (pp.portfolio_pct > 0 ? '+' : '') + pp.portfolio_pct.toFixed(2) + '%'}</span>`]];
    $('#pulse').innerHTML = kvHTML(rows);
    $('#pulseTbl').innerHTML = tableHTML(
      ['ETF', '权重', '当日', '近20日均额(万)'],
      (pp.holdings || []).map((h) => [
        `${h.name || ''} <span class="tiny">${h.code}</span>`,
        pct(h.weight),
        h.pct == null ? '—' : `<span class="${cls(h.pct)}">${h.pct > 0 ? '+' : ''}${h.pct.toFixed(2)}%</span>`,
        num(h.amt20, 0),
      ]));

    const rr = b.risk_radar, c = rr.concentration || {};
    $('#risk').innerHTML = kvHTML([
      ['年化波动', num(rr.vol_ann) + '%'],
      ['最大回撤', num(rr.maxdd) + '%'],
      ['有效持仓数', num(c.effective_n, 1)],
      ['Top1 / Top3', `${pct(c.top1, 0)} / ${pct(c.top3, 0)}`],
      ['HHI', num(c.hhi, 3)],
      ['穿透覆盖率', pct(rr.penetration_coverage)],
    ]);
    $('#overlapList').innerHTML = (rr.top_overlap_pairs || []).length
      ? rr.top_overlap_pairs.slice(0, 5).map((p) =>
        `<li>${p.a_name} × ${p.b_name} —— 归一化重叠 <b>${pct(p.overlap)}</b>
         <span class="tiny">（共同持仓占净值 ${pct(p.raw)}）</span></li>`).join('')
      : '<li class="tiny">暂无可比较的穿透数据</li>';
    $('#sectorBar').innerHTML = barsHTML((rr.sector_exposure || []).slice(0, 8));

    $('#matters').innerHTML = (b.what_matters.etf_moves || []).length
      ? b.what_matters.etf_moves.map((m) =>
        `<li>${m.name} <span class="${cls(m.pct)}">${m.pct > 0 ? '+' : ''}${num(m.pct)}%</span>
         <span class="tiny">权重 ${pct(m.weight)}</span></li>`).join('')
      : '<li class="tiny">当日无显著异动</li>';

    $('#lowFee').innerHTML = tableHTML(['层级', 'ETF', '管理费率', '规模(亿)'],
      (b.etf_radar.low_fee_picks || []).slice(0, 6).map((x) =>
        [x.layer, `${x.name} <span class="tiny">${x.code}</span>`, num(x.fee) + '%', num(x.scale_yi, 0)]));
    $('#newEtf').innerHTML = (b.etf_radar.new_products || []).length
      ? b.etf_radar.new_products.map((x) =>
        `<li>${x.name} <span class="tiny">${x.code} · 上市约 ${x.list_days} 个交易日</span></li>`).join('')
      : '<li class="tiny">近期无新上市 ETF</li>';
  }

  // --------------------------------------------------------------- Match --
  function renderMatch(res) {
    const out = [];
    const dimNames = { goal: '目标适配', preference: '主题偏好', complement: '组合互补', cost: '成本条件', risk: '风险适配' };
    const card = (r, tag) => `
      <div class="mcard">
        <div class="mhead">
          <span class="rank">${r.rank || ''}</span>
          <span class="mname">${r.name || r.code}</span>
          <span class="mcode">${r.code}</span>
          <span class="score"><b>${num(tag === 'add' ? r.addition_score : r.score)}</b>
            <span>${tag === 'add' ? '增量价值' : '综合匹配'}</span></span>
        </div>
        <div class="metrics">
          <span>跟踪 ${r.index_name || '—'}</span>
          <span>费率 ${r.fee == null ? '—' : num(r.fee) + '%'}</span>
          <span>规模 ${num(r.scale_yi, 0)} 亿</span>
          <span>年化波动 ${num(r.vol_1y)}%</span>
          <span>重叠 ${pct(r.overlap_norm)}</span>
          <span>相关性 ${num(r.corr_with_portfolio)}</span>
          <span>Δσ ${r.marginal_vol_change_pct == null ? '—' : (r.marginal_vol_change_pct > 0 ? '+' : '') + num(r.marginal_vol_change_pct, 1) + '%'}</span>
        </div>
        <div class="dims">${Object.keys(dimNames).map((k) => {
          const v = (r.components || {})[k];
          return `<span class="dim ${v == null ? 'none' : ''}">${dimNames[k]}
            <b>${v == null ? '无法评估' : (v * 100).toFixed(0)}</b></span>`;
        }).join('')}</div>
        ${(r.reasons || []).length ? `<ul class="reasons">${r.reasons.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
        ${(r.mismatches || []).length ? `<ul class="mismatches">${r.mismatches.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
        <div class="conf">
          <span class="badge ${r.confidence.level}">可信度 ${r.confidence.level}</span>
          ${r.confidence.holdings_report_date ? `持仓披露日 ${r.confidence.holdings_report_date}` : '持仓未披露'}
          ${(r.confidence.dimensions_missing || []).length ? ` · 缺失维度：${r.confidence.dimensions_missing.join('、')}` : ''}
          ${r.confidence.note ? ` · ${r.confidence.note}` : ''}
        </div>
      </div>`;

    out.push('<div class="section-title">Best Match · 最符合你的目标与偏好</div>');
    out.push((res.best_match || []).length
      ? res.best_match.map((r) => card(r, 'match')).join('')
      : '<p class="tiny">没有符合条件的候选。</p>');

    out.push('<div class="section-title">Best Portfolio Addition · 对现有组合最有补充价值</div>');
    out.push((res.best_addition || []).length
      ? res.best_addition.map((r) => card(r, 'add')).join('')
      : `<p class="tiny">${res.portfolio_unavailable_reason || '暂无结果'}</p>`);

    const f = res.filtered || {};
    if (Object.keys(f).length) {
      out.push(`<div class="section-title">硬约束过滤（不可被高分抵消）</div><p class="tiny">`
        + Object.entries(f).map(([k, v]) => `${k} ${v} 只`).join(' · ') + `</p>`);
    }
    $('#matchOut').innerHTML = out.join('');
  }

  // ------------------------------------------------------------- Profile --
  function renderProfile(p) {
    const cmpl = Math.round((p.completeness || 0) * 100);
    $('#cmplBar').style.width = cmpl + '%';
    $('#cmplText').textContent = `画像完整度 ${cmpl}%`;
    $('#gaps').innerHTML = (p.gaps || []).map((g) => `<li>${g}</li>`).join('');

    const s = p.stated || {};
    $('#stated').innerHTML = kvHTML([
      ['投资目标', (s.goals || []).join('、') || '未表达'],
      ['风险容忍度', s.risk || '未表达'],
      ['投资期限', s.horizon_years == null ? '未表达' : s.horizon_years + ' 年'],
      ['关注主题', (s.focus_themes || []).join('、') || '未表达'],
    ]);

    const r = p.revealed || {};
    $('#revealed').innerHTML = kvHTML([
      ['持仓数', r.n_positions],
      ['加权费率', num(r.weighted_fee) + '%'],
      ['加权年化波动', num(r.weighted_vol_1y) + '%'],
      ['加权最大回撤', num(r.weighted_maxdd_1y) + '%'],
      ['穿透覆盖率', pct(r.penetration_coverage)],
      ['有效持仓数', num((r.concentration || {}).effective_n, 1)],
    ]);
    $('#assetBar').innerHTML = barsHTML(Object.entries(r.asset_allocation || {})
      .map(([sector, weight]) => ({ sector, weight })));
    $('#topStocks').innerHTML = (r.top_stocks || []).slice(0, 8).map((t) =>
      `<li>${t.name || t.code} <span class="tiny">${t.industry || ''} · ${pct(t.weight, 2)}</span></li>`).join('');

    const b = p.behavioral || {};
    $('#behavioral').innerHTML = kvHTML([
      ['可观测记录', b.n_observed || 0],
      ['中位持有天数', b.median_holding_days == null ? '—' : b.median_holding_days],
      ['持有风格', b.patience || '—'],
      ['说明', b.note || ''],
    ]);
    $('#diverge').innerHTML = (p.divergence || []).length
      ? p.divergence.map((d) => `<li><b>${d.type}</b> · ${d.detail}</li>`).join('')
      : '<li class="tiny">未发现显式偏好与实际持仓的显著差异</li>';
  }

  // -------------------------------------------------------------- 小工具 --
  function kvHTML(pairs) {
    return pairs.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');
  }
  function tableHTML(headers, rows) {
    if (!rows.length) return '<p class="tiny">无数据</p>';
    return `<table class="tbl"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function barsHTML(items) {
    if (!items.length) return '<p class="tiny">无数据</p>';
    const max = Math.max(...items.map((x) => x.weight || 0), 0.0001);
    return items.map((x) => `<div class="bar-row">
      <span>${x.sector}</span>
      <span class="bar-outer"><span class="bar-fill" style="width:${((x.weight || 0) / max * 100).toFixed(1)}%"></span></span>
      <span style="text-align:right">${pct(x.weight)}</span></div>`).join('');
  }

  boot();
})();
