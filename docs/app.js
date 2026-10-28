/* app.js —— 页面逻辑：加载快照、解析持仓（文件 / 截图）、渲染三个入口。
 * 所有计算在浏览器本地完成，持仓文件与截图不上传服务器。
 * 持仓一次上传，三个页面共用，并记在本机浏览器里，刷新不丢。 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const BASE = (location.pathname.replace(/[^/]*$/, '') || './');
  const LS_KEY = 'etfi.positions.v1';   // 本机留存，避免每次刷新都要重传

  let SNAP = null, RET = null, NEWS = null, ENGINE = null;
  let ETF_INDEX = null;                  // 供截图识别做名称回查
  let OCR_ROWS = [];                     // 校正面板里正在编辑的行
  const STATE = { positions: [], stated: {}, brief: null, match: null };

  const GOALS = ['长期增值', '稳定收入', '分散风险', '海外配置', '主题机会'];
  const pct = (x, n = 1) => (x == null ? '—' : (x * 100).toFixed(n) + '%');
  const num = (x, n = 2) => (x == null || !isFinite(x) ? '—' : Number(x).toFixed(n));
  const cls = (x) => (x == null ? '' : x > 0 ? 'up' : x < 0 ? 'down' : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    ETF_INDEX = window.OCR ? window.OCR.buildIndex(SNAP.etfs) : [];

    buildGoalChips();
    bind();
    restorePositions();     // 本机已有持仓则直接复用，不必再传

    // 收益序列与资讯都是异步加载，完成后重建引擎并重算。
    // 注意：两次重建必须互相补齐参数——若各自 new Engine，后完成的一个
    // 会把先完成的那个数据冲掉（快讯「时有时无」就是这里竞态导致的）。
    let RET_OK = false, NEWS_OK = false;
    const rebuildEngine = () => {
      if (!RET_OK) return;                    // 没有收益序列，引擎不完整
      ENGINE = new ETFEngine.Engine(SNAP, RET, NEWS_OK ? NEWS : null);
      $('#loading').hidden = true;
      if (STATE.positions.length) runAll();
    };
    fetchJSON(BASE + 'data/returns.json')
      .then((r) => { RET = r; RET_OK = true; rebuildEngine(); })
      .catch(() => { RET_OK = true; rebuildEngine(); });   // 失败也放行，指标显示缺失
    fetchJSON(BASE + 'data/news.json')
      .then((r) => { NEWS = r; NEWS_OK = true; rebuildEngine(); })
      .catch(() => { NEWS_OK = true; rebuildEngine(); });  // 失败也放行，快讯显示未加载
    setTimeout(() => { $('#loading').hidden = true; }, 2500);
  }

  function fetchJSON(u) {
    return fetch(u, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  // ------------------------------------------------------------ 持仓留存 --
  function savePositions() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(STATE.positions)); } catch (e) { /* 隐私模式下忽略 */ }
  }
  function restorePositions() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { rows = []; }
    const ok = (rows || []).filter((r) => r && /^\d{6}$/.test(String(r.code || '')));
    if (!ok.length) { afterPositions(); return; }
    STATE.positions = ok.map((r) => ({ ...r, source: r.source || 'saved' }));
    afterPositions();
  }

  // -------------------------------------------------------------- 绑定 --
  function bind() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.remove('active'));
      $$('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('#tab-' + t.dataset.tab).classList.add('active');
    }));

    // 所有上传入口走同一个处理函数：一次上传，全局生效
    // （Match 页已不再放上传入口，只有 Dashboard 与顶部持仓条）
    ['#fileDash', '#fileDashCsv', '#fileAny'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('change', (e) => { onFile(e.target.files[0]); e.target.value = ''; });
    });
    $('#btnReupload').addEventListener('click', () => $('#fileAny').click());
    $('#btnClearBar').addEventListener('click', () => { STATE.positions = []; savePositions(); afterPositions(); });

    const demo = () => {
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
      $('#ocrPanel').hidden = true;
      savePositions();
      afterPositions();
    };
    const d2 = $('#useDemoDash'); if (d2) d2.addEventListener('click', demo);
    // Match 页无持仓时的引导按钮：切回 Dashboard
    const gd = $('#gotoDash'); if (gd) gd.addEventListener('click', () =>
      $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'dash')));
    $('#runMatch').addEventListener('click', runAll);

    $('#ocrApply').addEventListener('click', applyOcr);
    $('#ocrCancel').addEventListener('click', () => {
      $('#ocrPanel').hidden = true; afterPositions();
    });
  }

  function buildGoalChips() {
    $('#goalChips').innerHTML = GOALS.map((g) => `<span class="chip" data-g="${g}">${g}</span>`).join('');
    $$('#goalChips .chip').forEach((c) => c.addEventListener('click', () => c.classList.toggle('on')));
    buildProfPrefs();
  }

  // ---- Profile 页的偏好编辑：与 Match 页表单共享同一份 stated ----
  // 用户在 Profile 页看不到任何输入入口却被提示「未提供」，所以在这里内联一份；
  // 改动写回 Match 页控件并自动重算画像与匹配。
  function buildProfPrefs() {
    const box = $('#profGoals');
    if (!box) return;
    box.innerHTML = GOALS.map((g) => `<span class="chip" data-g="${g}">${g}</span>`).join('');
    $$('#profGoals .chip').forEach((c) => c.addEventListener('click', () => {
      c.classList.toggle('on');
      applyProfPrefs();
    }));
    ['profRisk', 'profHorizon', 'profThemes'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.addEventListener('change', applyProfPrefs);
    });
    syncProfPrefs();
  }

  function syncProfPrefs() {
    // Match 页控件 → Profile 页控件（初次渲染 / 持仓载入后回填）
    if (!$('#profGoals')) return;
    $$('#profGoals .chip').forEach((c) => {
      const twin = document.querySelector(`#goalChips .chip[data-g="${c.dataset.g}"]`);
      c.classList.toggle('on', !!(twin && twin.classList.contains('on')));
    });
    $('#profRisk').value = $('#risk').value || '';
    $('#profHorizon').value = $('#horizon').value;
    $('#profThemes').value = $('#themes').value || '';
  }

  function applyProfPrefs() {
    // Profile 页控件 → Match 页控件 → 重算
    $$('#goalChips .chip').forEach((c) => {
      const twin = document.querySelector(`#profGoals .chip[data-g="${c.dataset.g}"]`);
      c.classList.toggle('on', !!(twin && twin.classList.contains('on')));
    });
    $('#risk').value = $('#profRisk').value || '';
    $('#horizon').value = $('#profHorizon').value;
    $('#themes').value = $('#profThemes').value || '';
    if (STATE.positions.length && ENGINE) runAll();
  }

  function readStated() {
    return {
      goals: $$('#goalChips .chip.on').map((c) => c.dataset.g),
      risk: $('#risk').value || null,
      horizon_years: $('#horizon').value === '' ? null : Number($('#horizon').value),
      focus_themes: $('#themes').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    };
  }

  // ---------------------------------------------------------- 文件/截图 --
  const isImage = (f) => /^image\//i.test(f.type || '')
    || /\.(png|jpe?g|webp|bmp|heic|heif)$/i.test(f.name || '');

  async function onFile(f) {
    if (!f) return;
    try {
      if (isImage(f)) return await onScreenshot(f);
      const rows = await parseFile(f);
      if (!rows.length) throw new Error('未识别到有效持仓');
      $('#ocrPanel').hidden = true;
      STATE.positions = rows;
      savePositions();
      afterPositions();
      toast(`已载入 ${rows.length} 只 ETF`);
    } catch (e) {
      toast('解析失败：' + e.message, 3600);
    }
  }

  async function onScreenshot(f) {
    if (!window.OCR) { toast('识别模块未加载'); return; }
    const box = $('#loading');
    box.hidden = false; box.textContent = '正在准备识别引擎…';
    try {
      const res = await window.OCR.parseScreenshot(f, SNAP, (p, st) => {
        box.textContent = (p == null ? 'OCR：' + st : '识别文字… ' + p + '%');
      });
      if (!res.rows.length) {
        box.textContent = '没能在截图里找到可识别的 ETF 持仓';
        setTimeout(() => { box.hidden = true; box.textContent = '加载数据…'; }, 3200);
        toast('未能识别，可改用 CSV / Excel，或在识别面板里手动添加', 4200);
        $('#ocrPanel').hidden = false;
        OCR_ROWS = [];
        renderOcrTbl('未在截图中识别出持仓行，可手动添加。');
        return;
      }
      OCR_ROWS = res.rows;
      $('#ocrMeta').textContent = `共扫描 ${res.lines.length} 行文字，识别出 ${res.rows.length} 只持仓`
        + (res.dropped ? `，忽略 ${res.dropped} 行无关文字` : '')
        + '。名称靠比对全市场 ETF 得到，请核对。';
      renderOcrTbl();
      $('#ocrPanel').hidden = false;
      $('#dashEmpty').hidden = true;
      $('#dashBody').hidden = true;
      box.hidden = true; box.textContent = '加载数据…';
    } catch (e) {
      box.hidden = true; box.textContent = '加载数据…';
      toast('识别失败：' + e.message, 4000);
    }
  }

  // ------------------------------------------------------ 识别结果校正 --
  function renderOcrTbl(hint) {
    const head = ['代码', '名称（可搜索）', '权重 %', '市值', '识别依据', ''];
    const risky = (r) => r.how !== 'code' && ((r.match != null && r.match < 0.75) || r.conf < 70);
    const howText = (r) => (r.how === 'code' ? '代码'
      : r.how === 'name' ? (r.match != null && r.match < 0.75 ? '名称匹配 · 存疑' : '名称匹配')
      : r.how === 'manual' ? '手动添加' : '疑似代码');
    const body = OCR_ROWS.map((r, i) => `
      <tr data-i="${i}" class="${risky(r) ? 'lowconf' : ''}">
        <td><input class="oc" data-k="code" value="${esc(r.code || '')}" size="7"></td>
        <td><input class="on" data-k="name" value="${esc(r.name || '')}" size="18"
              placeholder="输入名称或代码后回车">
            <div class="cand" data-i="${i}"></div></td>
        <td><input class="ow" data-k="weight" value="${r.weight == null ? '' : (r.weight * 100).toFixed(2)}" size="7"></td>
        <td><input class="om" data-k="market_value" value="${r.market_value == null ? '' : r.market_value}" size="9"></td>
        <td class="tiny">${howText(r)}${r.conf ? ' · ' + r.conf + '%' : ''}</td>
        <td><button class="btn tiny del" data-i="${i}">删除</button></td>
      </tr>`).join('');
    $('#ocrTbl').innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody>`
      + `<tfoot><tr><td colspan="6"><button class="btn tiny" id="ocrAdd">+ 手动添加一行</button></td></tr></tfoot>`;
    $('#ocrHint').textContent = hint || '';

    $$('#ocrTbl .del').forEach((b) => b.addEventListener('click', () => {
      OCR_ROWS.splice(Number(b.dataset.i), 1); renderOcrTbl();
    }));
    const add = $('#ocrAdd');
    if (add) add.addEventListener('click', () => {
      OCR_ROWS.push({ code: '', name: '', weight: null, market_value: null, conf: 0, how: 'manual' });
      renderOcrTbl();
    });
    $$('#ocrTbl .on').forEach((inp) => {
      inp.addEventListener('change', () => lookupCand(Number(inp.dataset.i), inp.value));
    });
    // 简称匹配到的可能不是你实际持有的那只，候选直接展开，省得再搜一次
    OCR_ROWS.forEach((r, i) => { if (r.cands && r.cands.length) renderCandBox(i, r.cands); });
  }

  function renderCandBox(i, hits) {
    const box = document.querySelector(`.cand[data-i="${i}"]`);
    if (!box) return;
    if (!hits || !hits.length) { box.innerHTML = '<span class="tiny">库中没有匹配的 ETF</span>'; return; }
    box.innerHTML = hits.map((h) =>
      `<button class="btn tiny candb" data-c="${h.code}" data-n="${esc(h.name)}">${esc(h.name)} <span class="tiny">${h.code}</span></button>`).join('');
    Array.from(box.querySelectorAll('.candb')).forEach((b) => b.addEventListener('click', () => {
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

  function applyOcr() {
    const rows = [];
    $$('#ocrTbl tbody tr').forEach((tr) => {
      const g = (k) => (tr.querySelector(k) || {}).value || '';
      const code = (g('.oc').match(/\d/g) || []).join('').slice(0, 6);
      if (!/^\d{6}$/.test(code)) return;
      let w = parseFloat(g('.ow'));
      const mv = parseFloat(g('.om'));
      rows.push({
        code, name: g('.on').trim(),
        weight: isFinite(w) ? (Math.abs(w) > 1.5 ? w / 100 : w) : null,
        market_value: isFinite(mv) ? mv : null,
        source: 'screenshot',
      });
    });
    if (!rows.length) { renderOcrTbl('至少要有 1 行代码为 6 位数字的持仓。'); return; }

    const byMv = rows.every((r) => r.weight == null) && rows.some((r) => r.market_value);
    if (byMv) {
      const tot = rows.reduce((a, r) => a + (r.market_value || 0), 0);
      rows.forEach((r) => { r.weight = tot ? (r.market_value || 0) / tot : 0; });
    } else {
      const tot = rows.reduce((a, r) => a + (r.weight || 0), 0);
      if (tot && Math.abs(tot - 1) > 0.02) rows.forEach((r) => { r.weight = (r.weight || 0) / tot; });
      else if (!tot) rows.forEach((r) => { r.weight = 1 / rows.length; });
    }
    rows.forEach((r) => { r.weight = r.weight || 0; });
    OCR_ROWS = [];
    $('#ocrPanel').hidden = true;
    STATE.positions = rows;
    savePositions();
    afterPositions();
    toast(`已应用 ${rows.length} 只持仓`);
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
    $('#dashEmpty').hidden = has || !$('#ocrPanel').hidden;
    $('#dashBody').hidden = !has;
    $('#profEmpty').hidden = has;
    $('#profBody').hidden = !has;
    $('#posBar').hidden = !has;
    $('#posBarText').textContent = `已载入 ${STATE.positions.length} 只持仓`
      + (STATE.positions[0] && STATE.positions[0].source === 'screenshot' ? '（来自截图识别）' : '');
    $('#posPreview').innerHTML = STATE.positions.map((p) =>
      `<span class="pill">${p.code} ${p.name || ''} ${pct(p.weight, 1)}</span>`).join('');
    // Match 页不再提供上传入口：有持仓直接显示，没有则引导回 Dashboard
    const emptyHint = $('#matchPosEmpty');
    if (emptyHint) emptyHint.hidden = has;
    if (has) syncProfPrefs();
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
        `<li>${p.a_name} × ${p.b_name} —— ${termHTML('归一化重叠', '归一化重叠')} <b>${pct(p.overlap)}</b>
         <span class="tiny">（${termHTML('共同持仓占净值', '共同持仓占净值')} ${pct(p.raw)}）</span></li>`).join('')
      : '<li class="tiny">暂无可比较的穿透数据</li>';
    $('#sectorBar').innerHTML = barsHTML((rr.sector_exposure || []).slice(0, 8));

    renderMatters(b.what_matters || {});

    $('#lowFee').innerHTML = tableHTML(['层级', 'ETF', '管理费率', '规模(亿)'],
      (b.etf_radar.low_fee_picks || []).slice(0, 6).map((x) =>
        [x.layer, `${x.name} <span class="tiny">${x.code}</span>`, num(x.fee) + '%', num(x.scale_yi, 0)]));
    $('#newEtf').innerHTML = (b.etf_radar.new_products || []).length
      ? b.etf_radar.new_products.map((x) =>
        `<li>${x.name} <span class="tiny">${x.code} · 上市约 ${x.list_days} 个交易日</span></li>`).join('')
      : '<li class="tiny">近期无新上市 ETF</li>';
  }

  // -------------------------------------------------- 与你相关（单列表） --
  /* 事件与资讯合并为一条流，不再分栏：卡片里若再摆「持仓异动 / 快讯 / 研报」
   * 几个小标题，等于把一个模块又拆成几块。类型改用左侧标签区分。
   * 排序：持仓异动恒排在前（你自己的持仓当日发生的事，最直接），
   * 其内按对组合的影响（|涨跌| × 权重）降序；资讯按相关度降序。 */
  function renderMatters(wm) {
    const box = $('#mattersFeed');
    if (!box) return;
    const news = wm.news || {};
    const items = [];

    (wm.etf_moves || []).forEach((m) => {
      const impact = Math.abs(m.pct || 0) * (m.weight || 0);
      items.push({
        kind: '异动',
        title: `${m.name} 当日 ${m.pct > 0 ? '+' : ''}${num(m.pct)}%`,
        tone: cls(m.pct),
        meta: `权重 ${pct(m.weight)}`,
        rank: 1e6 + impact,
        why: m.reasons || [],
      });
    });

    (news.fast || []).concat(news.articles || []).forEach((x) => {
      items.push({
        kind: x.kind || '资讯',
        title: x.title, url: x.url,
        meta: [x.time, x.source].filter(Boolean).join(' · '),
        summary: x.summary,
        score: x.score,
        why: x.reasons || [],
        rank: Number(x.score) || 0,
      });
    });

    items.sort((a, b) => b.rank - a.rank);

    const kcls = (k) => (k === '异动' ? 'm' : k === '快讯' ? 'f' : k === '研报' ? 'r' : 'a');
    const li = (x) => `
      <li class="news-item">
        <span class="feedk feedk-${kcls(x.kind)}">${esc(x.kind)}</span>
        ${x.url
          ? `<a class="news-t" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`
          : `<span class="news-t ${x.tone || ''}">${esc(x.title)}</span>`}
        <div class="news-m">
          ${x.meta ? `<span class="tiny">${esc(x.meta)}</span>` : ''}
          ${x.score != null ? `<span class="score">相关度 ${num(x.score, 1)}</span>` : ''}
        </div>
        ${x.summary ? `<p class="news-s">${esc(x.summary)}</p>` : ''}
        ${x.why && x.why.length
          ? `<div class="news-why">${x.why.map((r) => `<span class="why">${esc(r)}</span>`).join('')}</div>`
          : ''}
      </li>`;

    if (!items.length) {
      box.innerHTML = `<p class="tiny">${esc(news.empty_hint || '今日没有与你持仓或关注主题相关的内容。')}</p>`;
      return;
    }
    const nMove = (wm.etf_moves || []).length;
    const stat = news.ok
      ? `<p class="tiny">扫描 <b>${news.n_scanned}</b> 条资讯 · 与你相关 <b>${news.n_related}</b> 条`
        + `${nMove ? ` · 持仓异动 <b>${nMove}</b> 条` : ''}`
        + `${news.note ? ` · ${esc(news.note)}` : ''}</p>`
      : `<p class="tiny">${esc(news.note || '资讯正在加载…')}</p>`;
    box.innerHTML = stat + `<ul class="news-ul">${items.map(li).join('')}</ul>`;
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
            <span>${tag === 'add' ? termHTML('增量价值', '增量价值') : termHTML('综合匹配', '综合匹配')}</span></span>
        </div>
        <div class="metrics">
          <span>跟踪 ${r.index_name || '—'}</span>
          <span>费率 ${r.fee == null ? '—' : num(r.fee) + '%'}</span>
          <span>规模 ${num(r.scale_yi, 0)} 亿</span>
          <span>年化波动 ${num(r.vol_1y)}%</span>
          <span>${termHTML('重叠', '重叠')} ${pct(r.overlap_norm)}</span>
          <span>${termHTML('相关性', '相关性')} ${num(r.corr_with_portfolio)}</span>
          <span>${termHTML('Δσ', 'Δσ')} ${r.marginal_vol_change_pct == null ? '—' : (r.marginal_vol_change_pct > 0 ? '+' : '') + num(r.marginal_vol_change_pct, 1) + '%'}</span>
        </div>
        <div class="dims">${Object.keys(dimNames).map((k) => {
          const v = (r.components || {})[k];
          return `<span class="dim ${v == null ? 'none' : ''}">${termHTML(dimNames[k], dimNames[k])}
            <b>${v == null ? '无法评估' : (v * 100).toFixed(0)}</b></span>`;
        }).join('')}</div>
        ${(r.reasons || []).length ? `<ul class="reasons">${r.reasons.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
        ${(r.mismatches || []).length ? `<ul class="mismatches">${r.mismatches.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
        <div class="conf">
          <span class="badge ${r.confidence.level}">${termHTML('可信度', '可信度')} ${r.confidence.level}</span>
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
    return pairs.map(([k, v]) => {
      const key = (window.TERMS && window.TERMS[k]) ? termHTML(k) : esc(k);
      return `<div class="k">${key}</div><div class="v">${v}</div>`;
    }).join('');
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

  let toastT = null;
  function toast(msg, ms) {
    const t = $('#loading');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; t.textContent = '加载数据…'; }, ms || 2400);
  }

  boot();
})();
