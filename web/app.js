/* ETF Intelligence Platform 前端 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
let STATE = { positions: null, match: null };
let ETF_INDEX = [];      // 截图识别用：全市场 ETF 代码与名称
let OCR_ROWS = [];       // 校正面板里正在编辑的行

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}
function pct(x, d = 2) { return x == null ? '—' : (x * 100).toFixed(d) + '%'; }
function num(x, d = 2) { return x == null ? '—' : Number(x).toFixed(d); }
function cls(x) { return x == null ? '' : (x > 0 ? 'up' : (x < 0 ? 'down' : '')); }
/* 专业名词角标；terms.js 未加载时原样返回，不影响渲染 */
function term(label, key) {
  return window.termHTML ? window.termHTML(label, key || label) : label;
}

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

/* ---------- 持仓：文件 / 截图 ---------- */
const isImage = (f) => /^image\//i.test(f.type || '')
  || /\.(png|jpe?g|webp|bmp|heic|heif)$/i.test(f.name || '');

$('#csvFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (isImage(f)) return onScreenshot(f);
  const fd = new FormData(); fd.append('file', f); fd.append('user_id', uid());
  toast('解析持仓中…', 60000);
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.json());
    if (!r.ok) return toast('解析失败：' + (r.detail || ''));
    STATE.positions = r.positions;
    showPositions();
    toast(`已载入 ${r.count} 只持仓`);
  } catch (err) { toast('解析失败：' + err.message); }
});

function showPositions() {
  const ps = STATE.positions || [];
  $('#posPreview').innerHTML = ps.map(p =>
    `<span class="pill">${p.code} ${p.name || ''} ${pct(p.weight, 1)}</span>`).join('');
  $('#posState').textContent = ps.length
    ? `已载入 ${ps.length} 只持仓，Dashboard / Discover & Match / Profile 三页共用，无需重复上传。`
    : '尚未上传持仓';
}

/* 一次上传，三页共用：进入页面就把已保存的持仓读回来 */
async function bootPositions() {
  try {
    const r = await fetch('/api/positions/' + uid()).then(r => r.json());
    if (r.positions && r.positions.length) { STATE.positions = r.positions; }
  } catch (e) { /* 后端不可用时保持未上传状态 */ }
  showPositions();
  try {
    const e = await fetch('/api/etfs?limit=2000').then(r => r.json());
    ETF_INDEX = (e.rows || []).map(m => ({ code: m.code, name: m.name || '' }));
  } catch (err) { ETF_INDEX = []; }
}
$('#userId').addEventListener('change', bootPositions);

/* ---------- 截图识别 ---------- */
async function loadEtfIndex() {
  if (ETF_INDEX.length) return;
  try {
    const e = await fetch('/api/etfs?limit=2000').then(r => r.json());
    ETF_INDEX = (e.rows || []).map(m => ({ code: m.code, name: m.name || '' }));
  } catch (err) { ETF_INDEX = []; }
}

async function onScreenshot(f) {
  if (!window.OCR) return toast('识别模块未加载');
  $('#ocrPanel').hidden = false;
  $('#ocrMeta').textContent = '正在准备识别引擎…';
  $('#ocrTbl').innerHTML = '';
  try {
    // 名称回查要先有索引，否则只能靠 6 位代码匹配
    await loadEtfIndex();
    const snap = { etfs: ETF_INDEX.map(e => [e.code, e.name]) };
    const res = await window.OCR.parseScreenshot(f, snap, (p, st) => {
      $('#ocrMeta').textContent = (p == null ? 'OCR：' + st : '识别文字… ' + p + '%');
    });
    OCR_ROWS = res.rows;
    $('#ocrMeta').textContent = `共扫描 ${res.lines.length} 行文字，识别出 ${res.rows.length} 只持仓`
      + (res.dropped ? `，忽略 ${res.dropped} 行无关文字` : '') + '。名称靠比对全市场 ETF 得到，请核对。';
    renderOcrTbl();
  } catch (err) {
    $('#ocrMeta').textContent = '识别失败：' + err.message;
  }
}

function renderOcrTbl(hint) {
  const risky = (r) => r.how !== 'code' && ((r.match != null && r.match < 0.75) || r.conf < 70);
  const howText = (r) => (r.how === 'code' ? '代码'
    : r.how === 'name' ? (r.match != null && r.match < 0.75 ? '名称匹配 · 存疑' : '名称匹配')
    : r.how === 'manual' ? '手动添加' : '疑似代码');
  $('#ocrTbl').innerHTML =
    `<tr><th>代码</th><th>名称（可搜索）</th><th>权重 %</th><th>市值</th><th>识别依据</th><th></th></tr>` +
    OCR_ROWS.map((r, i) => `<tr data-i="${i}" class="${risky(r) ? 'lowconf' : ''}">
      <td><input class="oc" value="${esc(r.code || '')}" size="7"></td>
      <td><input class="on" value="${esc(r.name || '')}" size="18" placeholder="输入名称或代码">
        <div class="cand" data-i="${i}"></div></td>
      <td><input class="ow" value="${r.weight == null ? '' : (r.weight * 100).toFixed(2)}" size="7"></td>
      <td><input class="om" value="${r.market_value == null ? '' : r.market_value}" size="9"></td>
      <td class="hint">${howText(r)}${r.conf ? ' · ' + r.conf + '%' : ''}</td>
      <td><button class="btn ghost del" data-i="${i}">删除</button></td></tr>`).join('') +
    `<tr><td colspan="6"><button class="btn ghost" id="ocrAdd">+ 手动添加一行</button></td></tr>`;
  $('#ocrHint').textContent = hint || '';

  document.querySelectorAll('#ocrTbl .del').forEach(b =>
    b.addEventListener('click', () => { OCR_ROWS.splice(Number(b.dataset.i), 1); renderOcrTbl(); }));
  const add = $('#ocrAdd');
  if (add) add.addEventListener('click', () => {
    OCR_ROWS.push({ code: '', name: '', weight: null, market_value: null, conf: 0, how: 'manual' });
    renderOcrTbl();
  });
  document.querySelectorAll('#ocrTbl .on').forEach(inp =>
    inp.addEventListener('change', () => lookupCand(Number(inp.dataset.i), inp.value)));
  OCR_ROWS.forEach((r, i) => { if (r.cands && r.cands.length) renderCandBox(i, r.cands); });
}

function renderCandBox(i, hits) {
  const box = document.querySelector(`.cand[data-i="${i}"]`);
  if (!box) return;
  if (!hits || !hits.length) { box.innerHTML = '<span class="hint">库中没有匹配的 ETF</span>'; return; }
  box.innerHTML = hits.map(h => `<button class="btn ghost candb" data-c="${h.code}" data-n="${esc(h.name)}">${esc(h.name)} ${h.code}</button>`).join('');
  box.querySelectorAll('.candb').forEach(b => b.addEventListener('click', () => {
    const tr = b.closest('tr');
    tr.querySelector('.oc').value = b.dataset.c;
    tr.querySelector('.on').value = b.dataset.n;
    box.innerHTML = '';
  }));
}
function lookupCand(i, q) {
  if (!window.OCR) return;
  renderCandBox(i, window.OCR.searchEtf(ETF_INDEX, q, 6));
}

$('#ocrApply').addEventListener('click', async () => {
  const rows = [];
  document.querySelectorAll('#ocrTbl tr[data-i]').forEach(tr => {
    const g = (k) => { const el = tr.querySelector(k); return el ? el.value : ''; };
    const code = (g('.oc').match(/\d/g) || []).join('').slice(0, 6);
    if (!/^\d{6}$/.test(code)) return;
    const w = parseFloat(g('.ow')), mv = parseFloat(g('.om'));
    rows.push({ code, name: g('.on').trim(),
      weight: isFinite(w) ? (Math.abs(w) > 1.5 ? w / 100 : w) : null,
      market_value: isFinite(mv) ? mv : null });
  });
  if (!rows.length) return renderOcrTbl('至少要有 1 行代码为 6 位数字的持仓。');
  const byMv = rows.every(r => r.weight == null) && rows.some(r => r.market_value);
  if (byMv) {
    const tot = rows.reduce((a, r) => a + (r.market_value || 0), 0);
    rows.forEach(r => { r.weight = tot ? (r.market_value || 0) / tot : 0; });
  } else {
    const tot = rows.reduce((a, r) => a + (r.weight || 0), 0);
    if (tot && Math.abs(tot - 1) > 0.02) rows.forEach(r => { r.weight = (r.weight || 0) / tot; });
    else if (!tot) rows.forEach(r => { r.weight = 1 / rows.length; });
  }
  rows.forEach(r => { r.weight = r.weight || 0; });
  try {
    await fetch('/api/positions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: uid(), positions: rows })
    });
  } catch (e) { /* 后端不可用时仅前端生效 */ }
  OCR_ROWS = [];
  $('#ocrPanel').hidden = true;
  STATE.positions = rows;
  showPositions();
  toast(`已应用 ${rows.length} 只持仓`);
});
$('#ocrCancel').addEventListener('click', () => { $('#ocrPanel').hidden = true; OCR_ROWS = []; });

/* ---------- 建库 ---------- */
$('#btnBuild').addEventListener('click', async () => {
  $('#btnBuild').disabled = true; $('#btnBuild').textContent = '建库中…';
  toast('正在拉取全市场 ETF 并补全特征，约需 1-3 分钟', 120000);
  const r = await fetch('/api/build?limit=800', { method: 'POST' }).then(r => r.json());
  $('#btnBuild').disabled = false; $('#btnBuild').textContent = '建库 / 刷新';
  toast(`建库完成：全市场 ${r.total_universe} 只，已入库并补全 ${r.enriched} 只`);
  loadStats();
});async function loadStats() {
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
    `<div class="dim"><span class="k">${term('HHI 集中度', 'HHI')}</span><span class="v">${num(c.hhi, 3)}</span></div>
     <div class="dim"><span class="k">${term('Top1 / Top3')}</span><span class="v">${pct(c.top1, 1)} / ${pct(c.top3, 1)}</span></div>
     <div class="dim"><span class="k">${term('有效持仓数')}</span><span class="v">${num(c.effective_n, 1)}</span></div>
     <div class="dim"><span class="k">${term('穿透覆盖率')}</span><span class="v">${pct(rr.penetration_coverage, 1)}</span></div>
     <h4 style="font-size:13px;margin:10px 0 4px">${term('重叠最高的持仓对', '归一化重叠')}</h4>` +
    (rr.top_overlap_pairs || []).map(p =>
      `<div class="dim"><span class="k">${p.a_name} × ${p.b_name}</span>
       <span class="bar"><i style="width:${(p.overlap * 100).toFixed(0)}%"></i></span>
       <span class="v">${pct(p.overlap, 0)}</span></div>`).join('') +
    (rr.vol_changed ? `<p class="hint">波动率出现明显变化：${(rr.vol_detail || []).map(v => v.name + ' ' + v.change_pct + '%').join('，')}</p>` : '') +
    `<p class="hint">${rr.note || ''}</p>`;

  const wm = b.what_matters || {};
  renderMatters(wm);

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
  $('#conc').innerHTML = `<div class="dim"><span class="k">${term('HHI', 'HHI')}</span><span class="v">${num(c.hhi, 3)}</span></div>
    <div class="dim"><span class="k">${term('Top1 / Top3 / Top5', 'Top1 / Top3')}</span><span class="v">${pct(c.top1, 0)}/${pct(c.top3, 0)}/${pct(c.top5, 0)}</span></div>
    <div class="dim"><span class="k">${term('有效持仓数')}</span><span class="v">${num(c.effective_n, 1)}</span></div>` +
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

/* 事件与资讯合并为一条流，不再分「持仓异动 / 快讯 / 研报」几栏：
 * 卡片里再摆小标题等于把一个模块又拆成几块，类型改用左侧标签区分。
 * 排序：异动恒排在前（你自己的持仓当日发生的事），按 |涨跌| × 权重 降序；
 * 资讯按相关度降序；关注主题的相关产品附在最后。 */
function renderMatters(wm) {
  const box = $('#mattersFeed');
  if (!box) return;
  const news = wm.news || {};
  const items = [];

  (wm.etf_moves || []).forEach(m => {
    items.push({
      kind: '异动',
      title: `${m.name || m.code} 当日 ${m.pct > 0 ? '+' : ''}${num(m.pct)}%`,
      tone: cls(m.pct),
      meta: `权重 ${pct(m.weight, 1)}${m.why ? ' · ' + m.why : ''}`,
      rank: 1e6 + Math.abs(m.pct || 0) * (m.weight || 0),
      why: [],
    });
  });

  (news.fast || []).concat(news.articles || []).forEach(x => {
    items.push({
      kind: x.kind || '资讯',
      title: x.title, url: x.url,
      meta: [x.time, x.source].filter(Boolean).join(' · '),
      summary: x.summary, score: x.score,
      why: x.reasons || [],
      rank: Number(x.score) || 0,
    });
  });

  (wm.theme_watch || []).slice(0, 6).forEach(x => {
    items.push({
      kind: '主题',
      title: x.name,
      meta: `规模 ${num(x.scale_yi, 0)} 亿 · 费率 ${num(x.fee)}%`,
      rank: -1,
      why: [],
    });
  });

  items.sort((a, b) => b.rank - a.rank);

  const kcls = k => (k === '异动' ? 'm' : k === '快讯' ? 'f' : k === '研报' ? 'r' : k === '主题' ? 't' : 'a');
  const li = (x) => `
    <li class="news-item">
      <span class="feedk feedk-${kcls(x.kind)}">${esc(x.kind)}</span>
      ${x.url
        ? `<a class="news-t" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`
        : `<span class="news-t ${x.tone || ''}">${esc(x.title)}</span>`}
      <div class="news-m">
        ${x.meta ? `<span class="hint">${esc(x.meta)}</span>` : ''}
        ${x.score != null ? `<span class="nscore">相关度 ${num(x.score, 1)}</span>` : ''}
      </div>
      ${x.summary ? `<p class="news-s">${esc(x.summary)}</p>` : ''}
      ${x.why && x.why.length
        ? `<div class="news-why">${x.why.map(r => `<span class="why">${esc(r)}</span>`).join('')}</div>` : ''}
    </li>`;

  if (!items.length) {
    box.innerHTML = `<p class="hint">${esc(news.empty_hint || '今日没有与你持仓或关注主题相关的内容。')}</p>`;
    return;
  }
  const nMove = (wm.etf_moves || []).length;
  const stat = news.ok
    ? `<p class="hint">扫描 ${news.n_scanned} 条 · 与你相关 <b>${news.n_related}</b> 条`
      + `${nMove ? ` · 持仓异动 <b>${nMove}</b> 条` : ''}`
      + `${news.note ? ` · ${esc(news.note)}` : ''}</p>`
    : `<p class="hint">${esc(news.note || '资讯暂不可用')}</p>`;
  const focus = (wm.theme_focus || []).length ? `关注主题：${esc(wm.theme_focus.join('、'))}` : '';
  box.innerHTML = stat + (focus ? `<p class="hint">${focus}</p>` : '')
    + `<ul class="news-ul">${items.map(li).join('')}</ul>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadStats();
bootPositions();
