/* ETF Intelligence Platform 前端 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
let STATE = { positions: null, match: null };

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}
function pct(x, d = 2) { return x == null ? '—' : (x * 100).toFixed(d) + '%'; }
function num(x, d = 2) { return x == null ? '—' : Number(x).toFixed(d); }
function cls(x) { return x == null ? '' : (x > 0 ? 'up' : (x < 0 ? 'down' : '')); }

function stated() {
  const goals = $$('#goals input:checked').map(i => i.value);
  const h = $('#horizon').value;
  const f = $('#focus').value.split(/[,，\s]+/).filter(Boolean);
  return {
    goals, risk: $('#risk').value || null,
    horizon_years: h ? Number(h) : null,
    focus_themes: f,
    constraints: { exclude_leverage: true }
  };
}
const uid = () => $('#userId').value.trim() || 'demo';

/* ---------- 持仓 ---------- */
$('#csvFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append('file', f); fd.append('user_id', uid());
  toast('解析持仓中…', 60000);
  const r = await fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.json());
  if (!r.ok) return toast('解析失败：' + (r.detail || ''));
  STATE.positions = r.positions;
  $('#posPreview').innerHTML = r.positions.map(p =>
    `<span class="pill">${p.code} ${p.name || ''} ${pct(p.weight, 1)}</span>`).join('');
  toast(`已载入 ${r.count} 只持仓`);
});

/* ---------- 建库 ---------- */
$('#btnBuild').addEventListener('click', async () => {
  $('#btnBuild').disabled = true; $('#btnBuild').textContent = '建库中…';
  toast('正在拉取全市场 ETF 并补全特征，约需 1-3 分钟', 120000);
  const r = await fetch('/api/build?limit=800', { method: 'POST' }).then(r => r.json());
  $('#btnBuild').disabled = false; $('#btnBuild').textContent = '建库 / 刷新';
  toast(`建库完成：全市场 ${r.total_universe} 只，已入库并补全 ${r.enriched} 只`);
  loadStats();
});
async function loadStats() {
  const s = await fetch('/api/stats').then(r => r.json());
  $('#stats').textContent = `数据库 ${s.etf_in_db} 只 / 全市场 ${s.universe} 只 · ${s.algo_version}`;
}

/* ---------- Tab ---------- */
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  ['dash', 'match', 'profile'].forEach(p => $('#page-' + p).classList.toggle('hidden', p !== t.dataset.tab));
}));

/* ---------- Dashboard ---------- */
$('#btnBrief').addEventListener('click', async () => {
  const body = { user_id: uid(), stated: stated(), positions: STATE.positions, with_matching: true };
  toast('生成每日情报中…', 90000); $('#btnBrief').disabled = true;
  const b = await fetch('/api/brief', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(r => r.json());
  $('#btnBrief').disabled = false;
  renderBrief(b); toast('每日情报已生成');
});

function renderBrief(b) {
  $('#headline').textContent = b.headline;
  $('#signals').innerHTML = (b.signals || []).map(s => '· ' + s).join('<br>');
  $('#dashDisclaimer').textContent = b.disclaimer || '';

  const pp = b.portfolio_pulse || {};
  $('#pulse').innerHTML =
    `<div style="margin-bottom:8px">组合当日估算：<b class="${cls(pp.portfolio_pct)}">${num(pp.portfolio_pct)}%</b>
     <span class="hint">（按持仓权重加权）</span></div>` +
    `<table><tr><th>ETF</th><th class="num">权重</th><th class="num">当日</th><th class="num">贡献</th></tr>` +
    (pp.holdings || []).map(h => `<tr><td>${h.name || h.code}</td><td class="num">${pct(h.weight, 1)}</td>
      <td class="num ${cls(h.pct)}">${num(h.pct)}%</td><td class="num ${cls(h.contribution)}">${num(h.contribution * 100, 3)}%</td></tr>`).join('') +
    `</table>`;

  const rr = b.risk_radar || {};
  const c = rr.concentration || {};
  $('#risk').innerHTML =
    `<div class="dim"><span class="k">HHI 集中度</span><span class="v">${num(c.hhi, 3)}</span></div>
     <div class="dim"><span class="k">Top1 / Top3</span><span class="v">${pct(c.top1, 1)} / ${pct(c.top3, 1)}</span></div>
     <div class="dim"><span class="k">有效持仓数</span><span class="v">${num(c.effective_n, 1)}</span></div>
     <div class="dim"><span class="k">穿透覆盖率</span><span class="v">${pct(rr.penetration_coverage, 1)}</span></div>
     <h4 style="font-size:13px;margin:10px 0 4px">重叠最高的持仓对</h4>` +
    (rr.top_overlap_pairs || []).map(p =>
      `<div class="dim"><span class="k">${p.a_name} × ${p.b_name}</span>
       <span class="bar"><i style="width:${(p.overlap * 100).toFixed(0)}%"></i></span>
       <span class="v">${pct(p.overlap, 0)}</span></div>`).join('') +
    (rr.vol_changed ? `<p class="hint">波动率出现明显变化：${(rr.vol_detail || []).map(v => v.name + ' ' + v.change_pct + '%').join('，')}</p>` : '') +
    `<p class="hint">${rr.note || ''}</p>`;

  const wm = b.what_matters || {};
  $('#matters').innerHTML =
    ((wm.etf_moves || []).length ? (wm.etf_moves || []).map(m =>
      `<div class="dim"><span class="k">${m.name || m.code}</span>
       <span class="v ${cls(m.pct)}">${num(m.pct)}%</span>
       <span class="hint">权重 ${pct(m.weight, 1)}${m.why ? ' · ' + m.why : ''}</span></div>`).join('')
      : '<p class="hint">今日持仓无超过阈值的显著变动。</p>') +
    `<h4 style="font-size:13px;margin:10px 0 4px">关注主题相关产品（${(wm.theme_focus || []).join('、') || '自动推断'}）</h4>` +
    `<table><tr><th>ETF</th><th class="num">规模(亿)</th><th class="num">费率%</th></tr>` +
    (wm.theme_watch || []).slice(0, 6).map(m => `<tr><td>${m.name}</td>
      <td class="num">${num(m.scale_yi, 0)}</td><td class="num">${num(m.fee)}</td></tr>`).join('') + `</table>`;

  const rd = b.etf_radar || {};
  $('#radar').innerHTML =
    `<h4 style="font-size:13px;margin:0 0 4px">与你的关注相关的新产品</h4>` +
    ((rd.new_products || []).map(m => `<div class="dim"><span class="k">${m.name}</span>
      <span class="hint">上市 ${m.age_days} 天 · 规模 ${num(m.scale_yi, 1)} 亿 · 费率 ${num(m.fee)}%</span></div>`).join('')
      || '<p class="hint">近期无与关注标签匹配的新产品。</p>') +
    `<h4 style="font-size:13px;margin:10px 0 4px">同类低费率代表</h4>` +
    `<table><tr><th>层级</th><th>ETF</th><th class="num">费率%</th></tr>` +
    (rd.low_fee_picks || []).map(m => `<tr><td>${m.layer}</td><td>${m.name}</td>
      <td class="num">${num(m.fee)}</td></tr>`).join('') + `</table>`;

  const mu = b.matching_updates || {};
  $('#mchanges').innerHTML = (mu.entered || mu.exited) ?
    `<div>基线日期 ${mu.baseline_date}</div>` +
    (mu.entered || []).map(e => `<div class="dim"><span class="k">新进入</span>
       <span>${e.name}（${e.code}）得分 ${num(e.score)}</span></div>`).join('') +
    (mu.exited || []).map(e => `<div class="dim"><span class="k">已退出</span>
       <span>${e.name}（${e.code}）</span></div>`).join('')
    : '<p class="hint">尚无历史匹配快照，本次结果将作为首个基线。</p>';
}

/* ---------- Match ---------- */
$('#btnMatch').addEventListener('click', async () => {
  toast('匹配计算中…（首次需拉取候选持仓与行情）', 120000); $('#btnMatch').disabled = true;
  const body = { user_id: uid(), stated: stated(), positions: STATE.positions, top_k: 8 };
  const r = await fetch('/api/match', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(r => r.json());
  $('#btnMatch').disabled = false;
  if (!r.ok) return toast(r.msg || '匹配失败');
  STATE.match = r;
  $('#matchMeta').innerHTML = `候选池 ${r.n_candidates} 只 → 深度计算 ${r.n_shortlist} 只；过滤：` +
    Object.entries(r.filtered || {}).map(([k, v]) => `${k} ${v}`).join('，') +
    (r.portfolio_unavailable_reason ? `　<span class="pill warn">${r.portfolio_unavailable_reason}</span>` : '');
  $('#bestMatch').innerHTML = (r.best_match || []).map(card).join('');
  $('#bestAdd').innerHTML = (r.best_addition || []).map(x => card(x, true)).join('')
    || '<p class="hint">未提供持仓，无法评估组合增量价值。</p>';
  toast('匹配完成');
});

function card(r, isAdd) {
  const c = r.components || {};
  const conf = r.confidence || {};
  const score = isAdd ? r.addition_score : r.score;
  return `<div class="rcard">
    <div class="rt"><div><b>#${r.rank || ''} ${r.name || ''}</b> <span class="code">${r.code}</span><br>
      <span class="code">${r.index_name || ''} · ${r.asset_class || ''}/${r.layer || ''}</span></div>
      <div class="score">${num(score, 1)}</div></div>
    <div style="margin-top:6px">${(r.tags || []).map(t => `<span class="tagchip">${t}</span>`).join('')}</div>
    <table style="margin-top:6px"><tr>
      <th class="num">目标</th><th class="num">偏好</th><th class="num">互补</th>
      <th class="num">成本</th><th class="num">风险</th><th class="num">重叠</th><th class="num">新增暴露</th>
      <th class="num">相关性</th><th class="num">边际波动</th></tr><tr>
      <td class="num">${n1(c.goal)}</td><td class="num">${n1(c.preference)}</td>
      <td class="num">${n1(c.complement)}</td><td class="num">${n1(c.cost)}</td>
      <td class="num">${n1(c.risk)}</td><td class="num">${pct(r.overlap_norm, 0)}</td>
      <td class="num">${pct(r.exposure_gain, 0)}</td>
      <td class="num">${num(r.corr_with_portfolio)}</td>
      <td class="num">${r.marginal_vol_change_pct == null ? '—' : r.marginal_vol_change_pct + '%'}</td>
    </tr></table>
    <div style="font-size:12px;margin-top:4px">费率 ${num(r.fee)}% · 规模 ${num(r.scale_yi, 0)} 亿 ·
      近一年波动 ${num(r.vol_1y, 1)}% · 回撤 ${num(r.maxdd_1y, 1)}%</div>
    <b style="font-size:12.5px">为什么匹配</b>
    <ul>${(r.reasons || []).map(x => `<li>${x}</li>`).join('') || '<li>—</li>'}</ul>
    <b style="font-size:12.5px">需要注意</b>
    <ul class="mis">${(r.mismatches || []).map(x => `<li>${x}</li>`).join('') || '<li>—</li>'}</ul>
    <div class="conf">数据可信度：${conf.level}（画像完整度 ${pct(conf.profile_completeness, 0)}；
      持仓报告期 ${conf.holdings_report_date || '—'}${conf.holdings_age_days != null ? '，' + conf.holdings_age_days + ' 天前' : ''}）· ${conf.note || ''}</div>
  </div>`;
}
function n1(x) { return x == null ? '—' : (x * 100).toFixed(0); }

$('#btnSearch').addEventListener('click', async () => {
  const q = $('#q').value.trim();
  const r = await fetch('/api/etfs?q=' + encodeURIComponent(q) + '&limit=30').then(r => r.json());
  $('#searchRes').innerHTML = `<table><tr><th>代码</th><th>名称</th><th>跟踪指数</th>
    <th>类别</th><th class="num">规模(亿)</th><th class="num">费率%</th></tr>` +
    r.rows.map(m => `<tr><td>${m.code}</td><td>${m.name}</td><td>${m.index_name || ''}</td>
      <td>${m.asset_class}/${m.layer}</td><td class="num">${num(m.scale_yi, 0)}</td>
      <td class="num">${num(m.fee)}</td></tr>`).join('') + `</table>`;
});

/* ---------- Profile ---------- */
$('#btnProfile').addEventListener('click', async () => {
  toast('计算画像中…', 60000);
  const p = await fetch('/api/profile/' + uid() + '?stated=' +
    encodeURIComponent(JSON.stringify(stated()))).then(r => r.json());
  renderProfile(p); toast('画像已更新');
});

function bars(obj, fmt = pct) {
  const max = Math.max(...Object.values(obj || {}).map(Math.abs), 0.0001);
  return Object.entries(obj || {}).map(([k, v]) =>
    `<div class="dim"><span class="k">${k}</span>
     <span class="bar"><i style="width:${(Math.abs(v) / max * 100).toFixed(0)}%"></i></span>
     <span class="v">${fmt(v, 1)}</span></div>`).join('') || '<p class="hint">无数据</p>';
}

function renderProfile(p) {
  const rv = p.revealed || {};
  $('#profSummary').innerHTML =
    `画像完整度 <b>${pct(p.completeness, 0)}</b> · 持仓 ${rv.n_positions || 0} 只 ·
     加权费率 ${num(rv.weighted_fee)}% · 加权波动 ${num(rv.weighted_vol_1y, 1)}% ·
     加权回撤 ${num(rv.weighted_maxdd_1y, 1)}%<p class="hint">画像来源分三类：Stated（你明确表达的）、
     Revealed（实际持仓反推）、Behavioral（可观测行为）。三者分开记录，不混同推断风险承受能力。</p>`;
  $('#alloc').innerHTML = `<div style="font-size:12px;color:var(--muted)">资产类别</div>` + bars(rv.asset_allocation) +
    `<div style="font-size:12px;color:var(--muted);margin-top:8px">产品层级</div>` + bars(rv.layer_allocation) +
    `<div style="font-size:12px;color:var(--muted);margin-top:8px">市场</div>` + bars(rv.market_allocation);
  $('#sector').innerHTML = bars(Object.fromEntries((rv.sector_exposure || []).map(s => [s.sector, s.weight])));
  $('#tags').innerHTML = bars(rv.tag_exposure);
  const c = rv.concentration || {};
  $('#conc').innerHTML = `<div class="dim"><span class="k">HHI</span><span class="v">${num(c.hhi, 3)}</span></div>
    <div class="dim"><span class="k">Top1 / Top3 / Top5</span><span class="v">${pct(c.top1, 0)}/${pct(c.top3, 0)}/${pct(c.top5, 0)}</span></div>
    <div class="dim"><span class="k">有效持仓数</span><span class="v">${num(c.effective_n, 1)}</span></div>` +
    (rv.overlap_pairs || []).map(x => `<div class="dim"><span class="k">${x.a}×${x.b}</span>
      <span class="bar"><i style="width:${(x.overlap * 100).toFixed(0)}%"></i></span>
      <span class="v">${pct(x.overlap, 0)}</span></div>`).join('');
  $('#gaps').innerHTML = (p.gaps || []).length
    ? (p.gaps || []).map(g => `<span class="pill warn">${g}</span>`).join('')
    : '<span class="pill">画像数据完整</span>';
  $('#diverge').innerHTML = (p.divergence || []).length
    ? (p.divergence || []).map(d => `<div class="dim"><span class="k">${d.type}</span>
        <span>${d.detail}</span></div>`).join('')
    : '<p class="hint">未发现显式偏好与持仓结构的明显差异。</p>';
}

loadStats();
