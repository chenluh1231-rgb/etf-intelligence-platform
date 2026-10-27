/* =============================================================================
 * match.js —— 浏览器端四阶段 Matching Engine（与 etfi/matching.py 逻辑一一对应）
 *
 *   Stage 1  候选生成     硬约束过滤，不可被高分抵消
 *   Stage 2  兼容性打分   S(u,e) = 100 × Σₖ αₖ · sₖ(u,e)，缺失维度重归一化
 *   Stage 3  组合增量价值  重叠、新增暴露、相关性、边际风险 Δσ
 *   Stage 4  排序与解释     Best Match / Best Portfolio Addition + 解释卡片
 *
 * 全部计算在浏览器本地完成，持仓 CSV 不上传任何服务器。
 * ========================================================================== */
(function (global) {
  'use strict';

  const DEFAULT_ADD_WEIGHT = 0.10;
  const SHORTLIST_SIZE = 100;
  const RET_SCALE = 10000;   // 存储整数 → 小数收益：arr[i] / RET_SCALE

  // 新闻相关性参数，必须与 etfi/news.py 保持一致
  const NEWS_W = { stock: 0.50, sector: 0.30, theme: 0.20 };
  const NEWS_STOCK_FULL_HIT = 0.03;   // 命中成分股合计权重达 3% 即视为强直连
  const NEWS_SECTOR_FULL_HIT = 0.15;  // 命中行业暴露达 15% 即视为强暴露
  const NEWS_DECAY_HOURS = 72;        // 72 小时内线性衰减到 0.5

  // ------------------------------------------------------------ 工具函数 --
  const clip = (x) => {
    const v = Number(x);
    if (!isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
  };
  const round = (x, n = 2) => (x === null || x === undefined || !isFinite(x))
    ? null : Math.round(x * Math.pow(10, n)) / Math.pow(10, n);

  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 30) return null;
    const x = a.slice(-n), y = b.slice(-n);
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      cov += dx * dy; vx += dx * dx; vy += dy * dy;
    }
    if (vx <= 0 || vy <= 0) return null;
    return cov / Math.sqrt(vx * vy);
  }

  function annVol(rets) {
    if (!rets || rets.length < 30) return null;
    const n = rets.length;
    let m = 0;
    for (const r of rets) m += r;
    m /= n;
    let v = 0;
    for (const r of rets) v += (r - m) * (r - m);
    v /= (n - 1);
    return Math.sqrt(v * 252) * 100;
  }

  function maxddFromReturns(rets) {
    if (!rets || rets.length < 30) return null;
    let cur = 1.0, peak = 1.0, mdd = 0;
    for (const r of rets) {
      cur *= (1 + r);
      if (cur > peak) peak = cur;
      const d = cur / peak - 1;
      if (d < mdd) mdd = d;
    }
    return mdd * 100;
  }

  // ------------------------------------------------------------ 引擎主体 --
  class Engine {
    constructor(snap, ret, news) {
      this.snap = snap;
      this.D = snap.dict;
      this.cfg = snap.config || {};
      this.ALPHA = this.cfg.alpha || { goal: .30, preference: .20, complement: .20, cost: .15, risk: .15 };
      this.ADD_BETA = this.cfg.add_beta || { novelty: .35, exposure: .25, correlation: .20, goal: .20 };
      this.RISK_TARGET_VOL = this.cfg.risk_target_vol || { 保守: 6, 稳健: 11, 平衡: 17, 积极: 24, 激进: 32 };
      this.HARD = this.cfg.hard_limits || { min_scale_yi: 2, max_fee: 1.5, exclude_leverage: true };
      this.GOAL_VECTORS = this.cfg.goal_vectors || {};

      this.dates = (ret && ret.dates) || snap.dates || [];
      this.RET = (ret && ret.returns) || snap.returns || {};
      this.dateIdx = new Map();
      this.dates.forEach((d, i) => this.dateIdx.set(d, i));

      // ETF 主表展开为对象
      this.etfs = snap.etfs.map((r) => ({
        code: r[0], name: r[1], index_name: r[2],
        asset_class: this.D.asset[r[3]] ?? null,
        layer: this.D.layer[r[4]] ?? null,
        mkt: this.D.mkt[r[5]] ?? null,
        tags: (r[6] || []).map((i) => this.D.tag[i]).filter(Boolean),
        fee: r[7], scale_yi: r[8], vol_1y: r[9], maxdd_1y: r[10], ret_1y: r[11],
        leveraged: !!r[12], coverage: r[13], report_date: r[14] || '',
      }));
      this.byCode = new Map(this.etfs.map((e) => [e.code, e]));
      this.holdings = snap.holdings || {};
      this.stocks = snap.stocks || {};
      this.latest = snap.latest || {};
      // 新闻是可选数据：缺失时简报里的资讯栏会如实标注，不影响其它模块
      this.NEWS = (news && news.news) || snap.news || [];
    }

    // ---- 收益序列 ----
    retAt(code, idx) {
      const r = this.RET[code];
      if (!r) return null;
      const i = idx - r[0];
      const arr = r[1];
      if (i < 0 || i >= arr.length) return null;
      const v = arr[i];
      return (v === null || v === undefined) ? null : v / RET_SCALE;
    }
    spanOf(code) {
      const r = this.RET[code];
      return r ? [r[0], r[0] + r[1].length - 1] : null;
    }
    stockWeights(code) {
      const hs = this.holdings[code];
      if (!hs) return null;
      const out = {};
      for (const [sc, w] of hs) out[sc] = (out[sc] || 0) + w / 100;
      return out;
    }

    // ============================================================ 画像 ====
    buildProfile(positions, stated) {
      stated = stated || {};
      const asset = {}, layer = {}, mkt = {}, tags = {};
      const fees = [], vols = [], dds = [];
      const missing = [];
      let covSum = 0, covN = 0;

      const psw = {};   // 穿透到个股
      for (const p of positions) {
        const v = Number(p.weight || 0);
        const m = this.byCode.get(p.code);
        if (!m) { missing.push(p.code); continue; }
        asset[m.asset_class || '未分类'] = (asset[m.asset_class || '未分类'] || 0) + v;
        layer[m.layer || '未分类'] = (layer[m.layer || '未分类'] || 0) + v;
        mkt[m.mkt || '未分类'] = (mkt[m.mkt || '未分类'] || 0) + v;
        for (const t of m.tags) tags[t] = (tags[t] || 0) + v;
        if (m.fee != null) fees.push([v, m.fee]);
        if (m.vol_1y != null) vols.push([v, m.vol_1y]);
        if (m.maxdd_1y != null) dds.push([v, m.maxdd_1y]);
        if (m.coverage) { covSum += m.coverage; covN++; }
        const sw = this.stockWeights(p.code);
        if (sw) for (const k in sw) psw[k] = (psw[k] || 0) + v * sw[k];
      }

      const revealed = {
        n_positions: positions.length,
        asset_allocation: norm(asset), layer_allocation: norm(layer),
        market_allocation: norm(mkt), tag_exposure: norm(tags),
        sector_exposure: this.sectorExposure(psw).slice(0, 12),
        top_stocks: Object.entries(psw).sort((a, b) => b[1] - a[1]).slice(0, 15)
          .map(([code, weight]) => ({
            code, weight: round(weight, 4),
            name: (this.stocks[code] || ['', 0])[0] || '',
            industry: this.D.industry[(this.stocks[code] || ['', 0])[1]] || '',
          })),
        weighted_fee: wavg(fees), weighted_vol_1y: wavg(vols), weighted_maxdd_1y: wavg(dds),
        concentration: concentration(positions.map((p) => Number(p.weight || 0))),
        overlap_pairs: this.pairwiseOverlap(positions.map((p) => p.code)).slice(0, 8),
        penetration_coverage: covN ? round(covSum / covN, 4) : null,
        missing_etf_data: missing,
      };

      const behavioral = behaviors(positions);
      const gaps = [];
      let filled = 0;
      if (stated.goals && stated.goals.length) filled++; else gaps.push('未提供投资目标');
      if (stated.risk) filled++; else gaps.push('未提供风险容忍度');
      if (stated.horizon_years != null) filled++; else gaps.push('未提供投资期限');
      if (positions.length) filled++; else gaps.push('未上传持仓，无法计算组合增量价值');
      if (behavioral.n_observed) filled++; else gaps.push('缺少交易行为记录');
      if (revealed.penetration_coverage && revealed.penetration_coverage > 0.05) filled++;
      else gaps.push('底层持仓数据不足，穿透分析受限');

      return {
        stated, revealed, behavioral,
        divergence: divergence(stated, revealed, this.RISK_TARGET_VOL),
        gaps, completeness: round(filled / 6, 3),
      };
    }

    sectorExposure(psw) {
      const agg = {};
      let tot = 0;
      for (const code in psw) {
        const ind = this.D.industry[(this.stocks[code] || ['', 0])[1]] || '未分类';
        agg[ind] = (agg[ind] || 0) + psw[code];
        tot += psw[code];
      }
      return Object.entries(agg).sort((a, b) => b[1] - a[1])
        .map(([sector, w]) => ({ sector, weight: round(tot ? w / tot : 0, 4) }));
    }

    pairwiseOverlap(codes) {
      const ws = {};
      for (const c of codes) ws[c] = this.stockWeights(c) || {};
      const out = [];
      for (let i = 0; i < codes.length; i++) {
        for (let j = i + 1; j < codes.length; j++) {
          const a = ws[codes[i]], b = ws[codes[j]];
          const n = overlapNorm(a, b);
          if (n == null) continue;
          out.push({
            a: codes[i], b: codes[j],
            a_name: (this.byCode.get(codes[i]) || {}).name || codes[i],
            b_name: (this.byCode.get(codes[j]) || {}).name || codes[j],
            overlap: round(n, 4), raw: round(overlapRaw(a, b), 4),
          });
        }
      }
      return out.sort((x, y) => y.overlap - x.overlap);
    }

    // ======================================================= 组合上下文 ====
    portfolioContext(positions) {
      if (!positions.length) {
        return { available: false, reason: '未提供持仓，无法计算对现有组合的增量价值',
                 stock_w: {}, summary: {}, rets: [], dates: [], vol: null };
      }
      const stock_w = {};
      let lo = -1, hi = Infinity;
      const spans = [];
      for (const p of positions) {
        const v = Number(p.weight || 0);
        const sw = this.stockWeights(p.code);
        if (sw) for (const k in sw) stock_w[k] = (stock_w[k] || 0) + v * sw[k];
        const sp = this.spanOf(p.code);
        if (sp) { spans.push(sp); lo = Math.max(lo, sp[0]); hi = Math.min(hi, sp[1]); }
      }
      const rets = [], used = [];
      if (spans.length && hi > lo) {
        for (let d = lo; d <= hi; d++) {
          let r = 0, ok = true;
          for (const p of positions) {
            const rr = this.retAt(p.code, d);
            if (rr === null) { ok = false; break; }
            r += Number(p.weight || 0) * rr;
          }
          if (ok) { rets.push(r); used.push(this.dates[d]); }
        }
      }
      const vol = annVol(rets);
      const summary = {
        n: positions.length,
        weights: Object.fromEntries(positions.map((p) => [p.code, p.weight])),
        vol_ann: round(vol), maxdd: round(maxddFromReturns(rets)),
        penetration_coverage: round(Object.values(stock_w).reduce((a, b) => a + b, 0), 4),
        n_days: rets.length,
      };
      return {
        available: !!(rets.length && vol != null),
        reason: (rets.length && vol != null) ? '' : '组合收益序列不足，无法计算边际风险',
        stock_w, summary, rets, dates: used, vol,
      };
    }

    // ============================================================ 打分 ====
    scoreContext(profile, stated) {
      const rev = profile.revealed || {};
      const goals = stated.goals || [];
      const focus = stated.focus_themes || [];
      let targetVol;
      if (stated.risk) targetVol = this.RISK_TARGET_VOL[stated.risk] ?? 17;
      else if (rev.weighted_vol_1y) targetVol = rev.weighted_vol_1y;
      else targetVol = 17;
      return { rev, goals, focus, targetVol, tagExp: rev.tag_exposure || {}, risk: stated.risk };
    }

    goalScore(ctx, m) {
      if (ctx.goals.length) {
        const vals = [];
        for (const g of ctx.goals) {
          const v = this.GOAL_VECTORS[g];
          if (!v) continue;
          const a = (v.asset || {})[m.asset_class] || 0;
          const l = (v.layer || {})[m.layer] || 0;
          const t = Math.max(0, ...m.tags.map((x) => (v.tag || {})[x] || 0));
          vals.push(0.55 * a + 0.30 * l + 0.15 * t);
        }
        return vals.length ? clip(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      }
      const alloc = ctx.rev.asset_allocation || {};
      if (!Object.keys(alloc).length) return null;
      const la = ctx.rev.layer_allocation || {};
      return clip(0.6 * (alloc[m.asset_class] || 0) + 0.4 * (la[m.layer] || 0));
    }

    prefScore(ctx, m) {
      const tags = new Set(m.tags);
      if (ctx.focus.length) {
        const hit = [...tags].filter((t) => ctx.focus.includes(t));
        if (!hit.length) return 0;
        return clip(0.7 + 0.3 * Math.min(1, hit.length / Math.max(1, ctx.focus.length)));
      }
      if (!Object.keys(ctx.tagExp).length) return null;
      const vals = m.tags.map((t) => ctx.tagExp[t] || 0);
      if (!vals.length) return 0;
      return clip(0.55 * Math.max(...vals) + 0.45 * (vals.reduce((a, b) => a + b, 0) / vals.length));
    }

    riskScore(ctx, m) {
      let vol = m.vol_1y;
      if (vol == null) return null;
      const t = ctx.targetVol;
      let s = t > 0 ? Math.exp(-0.5 * Math.pow((vol - t) / (0.55 * t), 2)) : 0.5;
      const dd = m.maxdd_1y;
      if (dd != null && t > 0 && dd > 1.8 * t) {
        s *= Math.max(0.35, 1 - (dd - 1.8 * t) / (3 * t));
      }
      return clip(s);
    }

    costScore(m) {
      const parts = [], ws = [];
      if (m.fee != null) { parts.push(clip(1 - m.fee / 1.2)); ws.push(0.45); }
      if (m.scale_yi) {
        parts.push(clip(Math.log10(Math.max(m.scale_yi, 2) / 2) / Math.log10(50)));
        ws.push(0.30);
      }
      if (!parts.length) return null;
      const tot = ws.reduce((a, b) => a + b, 0);
      let c = clip(parts.reduce((a, b, i) => a + b * ws[i], 0) / tot);
      // 近 20 日日均成交额（万元）：与 Python 一致的两段式混合
      const lt = this.latest[m.code];
      if (lt && lt[2]) {
        const liq = clip(Math.log10(Math.max(lt[2], 500) / 500) / Math.log10(400));
        c = clip(0.75 * c + 0.25 * liq);
      }
      return c;
    }

    // ====================================================== 四阶段主流程 ====
    run(positions, stated, opts) {
      opts = opts || {};
      const topK = opts.top_k || 10;
      stated = stated || {};
      const held = new Set(positions.map((p) => p.code));
      const profile = this.buildProfile(positions, stated);
      const ctx = this.scoreContext(profile, stated);

      // ---- Stage 1 硬约束 ----
      const allowed = stated.asset_scope || ['境内股票', '境外股票', '债券', '商品'];
      const cands = [];
      const filtered = {};
      const bump = (k) => { filtered[k] = (filtered[k] || 0) + 1; };
      for (const m of this.etfs) {
        if (held.has(m.code)) { bump('已持有'); continue; }
        if (this.HARD.exclude_leverage && m.leveraged) { bump('杠杆/反向'); continue; }
        if (m.asset_class && !allowed.includes(m.asset_class)) { bump('资产类别不符'); continue; }
        if (m.scale_yi != null && m.scale_yi < this.HARD.min_scale_yi) { bump('规模过小'); continue; }
        if (m.fee != null && m.fee > this.HARD.max_fee) { bump('费率过高'); continue; }
        cands.push(m);
      }

      // ---- Stage 2a 快速预筛 ----
      for (const m of cands) {
        m._goal = this.goalScore(ctx, m);
        m._pref = this.prefScore(ctx, m);
        m._risk = this.riskScore(ctx, m);
        m._cost = this.costScore(m);
      }
      // 注意：必须降序（高分在前），写反会把最差的 100 只送进深算
      const pre = (m) => 0.45 * (m._goal || 0) + 0.25 * (m._pref || 0)
        + 0.15 * (m._cost || 0) + 0.15 * (m._risk || 0);
      cands.sort((a, b) => pre(b) - pre(a));
      const shortlist = cands.slice(0, SHORTLIST_SIZE);

      // ---- 组合侧 ----
      const port = this.portfolioContext(positions);

      // ---- Stage 2b + 3 ----
      const rows = [];
      const dset = new Set(port.dates);
      const portIdx = port.dates.map((d) => this.dateIdx.get(d)).filter((i) => i != null);
      for (const m of shortlist) {
        const row = this.scoreCandidate(m, ctx, port, portIdx);
        if (row) rows.push(row);
      }
      for (const r of rows) r.score = round(blend(r.components, this.ALPHA));
      rows.sort((a, b) => b.score - a.score);
      rows.forEach((r, i) => { r.rank = i + 1; });

      const best_match = rows.slice(0, topK).map((r) => this.explain(r, ctx, port, profile));
      let best_addition = [];
      if (port.available) {
        for (const r of rows) r.addition_score = round(additionScore(r, this.ADD_BETA));
        best_addition = rows.filter((r) => r.addition_score != null)
          .sort((a, b) => b.addition_score - a.addition_score)
          .slice(0, topK).map((r) => this.explain(r, ctx, port, profile));
      }
      for (const r of best_match) if (!r.explained) this.explain(r, ctx, port, profile);

      return {
        ok: true, algo_version: (this.snap.meta || {}).algo_version,
        n_candidates: cands.length, n_shortlist: shortlist.length, filtered,
        profile, portfolio: port.summary,
        best_match, best_addition,
        portfolio_unavailable_reason: port.available ? null : port.reason,
      };
    }

    scoreCandidate(m, ctx, port, portIdx) {
      const goal = this.goalScore(ctx, m);
      const pref = this.prefScore(ctx, m);
      let risk = this.riskScore(ctx, m);
      const cost = this.costScore(m);

      // 候选与组合按同一套交易日配对，缺失日两边同时剔除，避免错位
      let volE = m.vol_1y, rho = null, dv = null;
      const candR = [], portR = [];
      for (let k = 0; k < portIdx.length; k++) {
        const rr = this.retAt(m.code, portIdx[k]);
        if (rr !== null) { candR.push(rr); portR.push(port.rets[k]); }
      }
      if (candR.length >= 30) volE = annVol(candR);
      if (risk == null && volE != null) risk = this.riskScore(ctx, { ...m, vol_1y: volE });
      if (port.available && volE != null && candR.length >= 30) {
        rho = corr(candR, portR);
        dv = marginalVol(port.vol, volE, rho, DEFAULT_ADD_WEIGHT);
      }

      let comp = null, overlapN = null, overlapR = null, gain = null;
      if (port.available) {
        const cw = this.stockWeights(m.code);
        if (cw && Object.keys(port.stock_w).length) {
          overlapN = overlapNorm(cw, port.stock_w);
          overlapR = overlapRaw(cw, port.stock_w);
          gain = exposureGain(cw, port.stock_w);
          if (overlapN != null) comp = clip(0.6 * (1 - overlapN) + 0.4 * (gain || 0));
        }
      }

      const lt = this.latest[m.code];
      return {
        code: m.code, name: m.name, index_name: m.index_name,
        asset_class: m.asset_class, layer: m.layer, market: m.mkt, tags: m.tags,
        fee: m.fee, scale_yi: m.scale_yi, vol_1y: round(volE),
        maxdd_1y: m.maxdd_1y, ret_1y: m.ret_1y,
        amount_ma20_wan: lt ? lt[2] : null,
        components: { goal: round(goal, 4), preference: round(pref, 4),
                      complement: comp == null ? null : round(comp, 4),
                      cost: round(cost, 4), risk: round(risk, 4) },
        overlap_norm: round(overlapN, 4), overlap_raw: round(overlapR, 4),
        exposure_gain: round(gain, 4),
        corr_with_portfolio: round(rho, 4),
        marginal_vol_change_pct: dv,
        report_date: m.report_date || null,
      };
    }

    // ============================================================ 解释 ====
    explain(r, ctx, port, profile) {
      if (r.explained) return r;
      const c = r.components || {};
      const reasons = [], mismatches = [];
      const pctf = (x) => (x * 100).toFixed(0) + '%';

      if (r.index_name) reasons.push(`跟踪${r.index_name}，属${r.asset_class}·${r.layer}`);
      if (c.goal != null && c.goal >= 0.6) {
        const src = (ctx.goals && ctx.goals.length)
          ? '匹配你设定的投资目标'
          : '与你当前持仓结构一致（未设定目标，按实际持仓推断）';
        reasons.push(`目标适配 ${(c.goal * 100).toFixed(0)} 分：${src}`);
      }
      if (c.preference != null && c.preference >= 0.5) {
        const hit = r.tags.filter((t) => (ctx.tagExp && ctx.tagExp[t]) || (ctx.focus || []).includes(t));
        if (hit.length) reasons.push(`命中关注标签：${hit.slice(0, 4).join('、')}`);
      }
      if (r.fee != null && r.fee <= 0.2) reasons.push(`管理费率仅 ${r.fee.toFixed(2)}%，处于同类低位`);
      if (r.scale_yi && r.scale_yi >= 50) reasons.push(`规模 ${r.scale_yi.toFixed(0)} 亿元，流动性与清盘风险较好`);
      if (r.overlap_norm != null && r.overlap_norm <= 0.25) reasons.push(`与你现有组合的底层重叠仅 ${pctf(r.overlap_norm)}，分散效果好`);
      if (r.exposure_gain != null && r.exposure_gain >= 0.6) reasons.push(`带来 ${pctf(r.exposure_gain)} 的全新底层暴露`);

      if (r.overlap_norm != null && r.overlap_norm >= 0.5) {
        mismatches.push(`与现有组合底层重叠高达 ${pctf(r.overlap_norm)}，共同持仓占净值 ${((r.overlap_raw || 0) * 100).toFixed(2)}%，增量有限`);
      }
      if (r.fee != null && r.fee >= 0.6) mismatches.push(`管理费率 ${r.fee.toFixed(2)}% 偏高，长期持有成本需考虑`);
      if (r.scale_yi != null && r.scale_yi < 5) mismatches.push(`规模仅 ${r.scale_yi.toFixed(2)} 亿元，存在流动性与清盘风险`);
      if (r.maxdd_1y != null && ctx.targetVol && r.maxdd_1y > 1.8 * ctx.targetVol) {
        mismatches.push(`近一年最大回撤 ${r.maxdd_1y.toFixed(1)}%，高于「${ctx.risk || '当前'}」风险水平对应的容忍区间`);
      }
      if (r.corr_with_portfolio != null && r.corr_with_portfolio >= 0.85) {
        mismatches.push(`与组合日收益相关性 ${r.corr_with_portfolio.toFixed(2)}，分散作用有限`);
      }
      if (r.marginal_vol_change_pct != null && r.marginal_vol_change_pct > 3) {
        mismatches.push(`按 ${(DEFAULT_ADD_WEIGHT * 100).toFixed(0)}% 权重加入后，组合波动率上升 ${r.marginal_vol_change_pct.toFixed(1)}%`);
      }
      if (r.amount_ma20_wan != null && r.amount_ma20_wan < 1000) {
        mismatches.push(`近 20 日日均成交额 ${r.amount_ma20_wan.toFixed(0)} 万元，大额资金需注意冲击成本`);
      }

      const missing = Object.keys(c).filter((k) => c[k] == null);
      let age = null;
      if (r.report_date) {
        const d = new Date(r.report_date);
        if (!isNaN(d)) age = Math.floor((Date.now() - d.getTime()) / 86400000);
      }
      const fresh = age != null && age <= 180;
      let level = '高';
      if ((profile.completeness || 0) < 0.4 || !fresh || missing.length) level = '中';
      if ((profile.completeness || 0) < 0.25 || (port.available && r.overlap_norm == null)) level = '低';

      r.reasons = reasons.slice(0, 5);
      r.mismatches = mismatches.slice(0, 5);
      r.confidence = {
        level, profile_completeness: profile.completeness,
        profile_gaps: profile.gaps || [], holdings_report_date: r.report_date || null,
        holdings_age_days: age, holdings_fresh: !!fresh, dimensions_missing: missing,
        note: '匹配分数为特征适配度，不是未来收益概率',
      };
      r.explained = true;
      return r;
    }

    // ============================================================ 资讯 ====
    /* 与 etfi/news.py 的 relevance()/select_for() 一一对应。
     * 标签（个股/行业/主题）已在服务端打好，这里只做集合运算——
     * 因此持仓数据始终留在浏览器里，不上传任何服务器。
     *
     * 相关度 = 成分股直连 50% + 行业暴露 30% + 关注主题 20%，再按时间衰减。
     * 得分为 0 的条目直接丢弃，绝不凑数。 */
    newsContext(positions, stockW, profile, stated) {
      const secW = {};
      for (const s of ((profile && profile.revealed && profile.revealed.sector_exposure) || [])) {
        if (s && s.sector) secW[s.sector] = Number(s.weight || 0);
      }
      const codeNames = {};
      const names = [];
      for (const p of positions) {
        const m = this.byCode.get(p.code);
        const nm = (m && (m.name || m.index_name)) || p.name || p.code;
        codeNames[p.code] = nm;
        names.push(nm);
        if (m && m.index_name) names.push(m.index_name);
      }
      // 指数名过长会误命中（如「中证全指证券公司指数」），只留 3–8 字的有效词
      const uniq = names.filter((n) => n && n.length >= 3 && n.length <= 8);
      return {
        stockW: stockW || {},
        secW,
        themes: (stated && stated.focus_themes) || [],
        names: Array.from(new Set(uniq)),
        codeNames,
        stockNames: this.stocks || {},
      };
    }

    newsRelevance(item, ctx) {
      const [id, kind, title, summary, time, url, source, stocks, sectors, themes] = item;
      const etf = (stocks || []).filter((c) => ctx.codeNames[c]);
      const hitStocks = (stocks || []).filter((c) => ctx.stockW[c] && !ctx.codeNames[c]);
      const hitW = hitStocks.reduce((a, c) => a + (ctx.stockW[c] || 0), 0);
      const sStock = etf.length ? 1
        : (hitW ? Math.min(1, hitW / NEWS_STOCK_FULL_HIT) : 0);

      const hitSecs = (sectors || []).filter((s) => ctx.secW[s]);
      const secW = hitSecs.reduce((a, s) => a + (ctx.secW[s] || 0), 0);
      const sSector = secW ? Math.min(1, secW / NEWS_SECTOR_FULL_HIT) : 0;

      const thSet = new Set(ctx.themes || []);
      const hitThs = (themes || []).filter((t) => thSet.has(t));
      const sTheme = hitThs.length ? Math.min(1, hitThs.length / 2) : 0;

      const nameHits = (ctx.names || []).filter((n) => title && title.indexOf(n) >= 0);
      const sName = nameHits.length ? Math.min(1, nameHits.length / 2) : 0;

      let base = NEWS_W.stock * sStock + NEWS_W.sector * sSector + NEWS_W.theme * sTheme;
      if (sName) base = Math.min(1, base + 0.35 * sName);
      if (base <= 0) return null;

      const reasons = [];
      if (etf.length) {
        reasons.push('直接点名你持有的 ' + etf.slice(0, 2)
          .map((c) => ctx.codeNames[c] || c).join('、'));
      }
      if (hitStocks.length) {
        const top = hitStocks.sort((a, b) => (ctx.stockW[b] || 0) - (ctx.stockW[a] || 0)).slice(0, 3);
        reasons.push('关联你的持仓成分股 ' + top.map((c) => {
          // 快照里 stocks[code] = [名称, 行业索引]，取第 0 项才是名称
          const raw = (ctx.stockNames || {})[c];
          const n = Array.isArray(raw) ? raw[0] : raw;
          return (n && String(n).length >= 2 && String(n).indexOf('*') < 0) ? n : c;
        }).join('、'));
      }
      if (hitSecs.length) reasons.push('命中组合行业暴露 ' + hitSecs.slice(0, 2).join('、'));
      if (hitThs.length) reasons.push('命中你的关注主题 ' + hitThs.slice(0, 2).join('、'));
      if (nameHits.length) reasons.push('提及你持有的 ' + nameHits.slice(0, 2).join('、'));

      return {
        score: round(100 * base * this._newsDecay(time), 1),
        reasons, etf, hitStocks, hitSecs, hitThs, nameHits,
      };
    }

    _newsDecay(t) {
      // 快讯时间形如 "10-27 11:23"（服务端已截掉年份），只按天/时粗算新鲜度
      const m = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(t || '');
      if (!m) return 0.8;
      const now = new Date();
      const dt = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]),
                          Number(m[3]), Number(m[4]));
      let ageH = (now - dt) / 36e5;
      if (ageH < 0) ageH += 8760;   // 跨年时回滚，按一年前的旧消息处理
      if (ageH < 0 || ageH > 8760) ageH = 0;
      return Math.max(0.5, 1 - 0.5 * Math.min(1, ageH / NEWS_DECAY_HOURS));
    }

    newsFor(ctx, limitFast = 10, limitArticle = 8) {
      const kindName = ['快讯', '文章', '研报'];
      const scored = [];
      for (const it of this.NEWS) {
        const rel = this.newsRelevance(it, ctx);
        if (!rel) continue;
        scored.push({
          id: it[0], kind: kindName[it[1]] || '文章', title: it[2], summary: it[3],
          time: it[4], url: it[5], source: it[6], score: rel.score, reasons: rel.reasons,
        });
      }
      // 稳定排序：先按时间倒序，再按相关度倒序
      scored.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
      scored.sort((a, b) => b.score - a.score);
      return {
        fast: scored.filter((x) => x.kind === '快讯').slice(0, limitFast),
        articles: scored.filter((x) => x.kind !== '快讯').slice(0, limitArticle),
        n_scanned: this.NEWS.length,
        n_related: scored.length,
        note: '相关度 = 成分股直连 50% + 行业暴露 30% + 关注主题 20%，再按时间新鲜度衰减',
        empty_hint: '未找到与你当前持仓或关注主题直接相关的资讯。补充关注主题可提高命中率。',
      };
    }

    // ============================================================ 简报 ====
    brief(positions, stated) {
      const profile = this.buildProfile(positions, stated || {});
      const port = this.portfolioContext(positions);
      const meta = this.snap.meta || {};

      // Portfolio Pulse
      const holdings = [];
      let portPct = 0, wsum = 0;
      for (const p of positions) {
        const lt = this.latest[p.code];
        const m = this.byCode.get(p.code);
        const w = Number(p.weight || 0);
        const pct = lt ? lt[1] : null;
        if (pct != null) { portPct += w * pct; wsum += w; }
        holdings.push({ code: p.code, name: (m && m.name) || '', weight: w, pct,
                        price: lt ? lt[0] : null, amt20: lt ? lt[2] : null });
      }
      if (wsum > 0) portPct = portPct / wsum;
      const movers = holdings.filter((h) => h.pct != null)
        .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 6);

      const signals = [];
      for (const m of movers.slice(0, 3)) {
        if (Math.abs(m.pct) >= 1.5) signals.push(moverPhrase(m, wsum));
      }
      for (const p of (profile.revealed.overlap_pairs || []).slice(0, 1)) {
        if (p.overlap >= 0.5) signals.push(`${p.a_name} × ${p.b_name} 底层重叠 ${(p.overlap * 100).toFixed(0)}%，存在重复暴露`);
      }
      const div = profile.divergence || [];
      for (const d of div.slice(0, 1)) signals.push(d.detail);

      // ETF Radar：全市场低费率精选 + 新上市
      const lowFee = {};
      for (const e of this.etfs) {
        if (e.fee == null || !e.layer) continue;
        if (!lowFee[e.layer] || e.fee < lowFee[e.layer].fee) {
          lowFee[e.layer] = { code: e.code, name: e.name, fee: e.fee, layer: e.layer, scale_yi: e.scale_yi };
        }
      }
      const newest = this.etfs
        .map((e) => ({ ...e, list_days: (this.RET[e.code] || [0, []])[1].length }))
        .filter((e) => e.list_days > 0 && e.list_days < 120)
        .sort((a, b) => a.list_days - b.list_days).slice(0, 5)
        .map((e) => ({ code: e.code, name: e.name, list_days: e.list_days }));

      // 相关快讯与文章：只推与持仓/主题有关的，不做市场综述
      let newsBlock = { ok: false, fast: [], articles: [], n_scanned: 0, n_related: 0,
                        note: '资讯数据未加载' };
      if (this.NEWS && this.NEWS.length) {
        const ctx = this.newsContext(positions, port.stock_w, profile, stated);
        newsBlock = this.newsFor(ctx);
        newsBlock.ok = true;
        newsBlock.has_positions = positions.length > 0;
        newsBlock.coverage = port.summary.penetration_coverage;
        if (!positions.length) {
          newsBlock.note += '；未上传持仓，仅按关注主题匹配';
        }
      }

      return {
        trade_date: meta.trade_date, generated_at: meta.generated_at,
        has_signal: signals.length > 0,
        headline: signals.length ? signals.slice(0, 3).join('；') + '。'
          : '今日组合与市场未出现需要你特别处理的显著变化。',
        signals,
        portfolio_pulse: {
          portfolio_pct: positions.length ? round(portPct, 3) : null,
          holdings, movers,
          note: '组合当日变动按持仓权重加权估算，未考虑盘中申赎',
        },
        risk_radar: {
          concentration: profile.revealed.concentration,
          top_overlap_pairs: profile.revealed.overlap_pairs,
          sector_exposure: profile.revealed.sector_exposure,
          vol_ann: port.summary.vol_ann, maxdd: port.summary.maxdd,
          penetration_coverage: port.summary.penetration_coverage,
        },
        what_matters: {
          etf_moves: movers,
          theme_focus: (stated && stated.focus_themes) || [],
          news: newsBlock,
        },
        etf_radar: {
          new_products: newest,
          low_fee_picks: Object.values(lowFee).sort((a, b) => a.fee - b.fee).slice(0, 8),
        },
        profile_gaps: profile.gaps,
        profile,
      };
    }
  }

  // ------------------------------------------------------ 模块级小函数 --
  function norm(d) {
    const s = Object.values(d).reduce((a, b) => a + b, 0);
    if (s <= 0) return {};
    const out = {};
    for (const k of Object.keys(d).sort((a, b) => d[b] - d[a])) out[k] = round(d[k] / s, 4);
    return out;
  }
  function wavg(pairs) {
    const tot = pairs.reduce((a, [w]) => a + w, 0);
    if (!pairs.length || tot <= 0) return null;
    return round(pairs.reduce((a, [w, v]) => a + w * v, 0) / tot, 4);
  }
  /* 单只 ETF 的头条措辞：只报涨跌幅会让头条变成行情播报，
     必须带上它对组合的贡献，让它成为归因而非提示。
     权重缺失导致贡献趋近 0 时无法归因，如实退回涨跌幅表述。 */
  function moverPhrase(m, wsum) {
    const sign = m.pct > 0 ? '+' : '';
    const c = wsum > 0 ? (Number(m.weight) || 0) * m.pct / wsum : null;
    if (c == null || Math.abs(c) < 0.005) return `${m.name} 当日 ${sign}${m.pct.toFixed(2)}%`;
    const verb = c > 0 ? '拉动' : '拖累';
    return `${m.name} 当日 ${sign}${m.pct.toFixed(2)}%，${verb}组合 ${Math.abs(c).toFixed(2)} 个百分点`;
  }

  function concentration(weights) {
    const ws = weights.filter((w) => w > 0).sort((a, b) => b - a);
    if (!ws.length) return { hhi: null, top1: null, top3: null, top5: null, effective_n: null };
    const s = ws.reduce((a, b) => a + b, 0);
    const w = s > 0 ? ws.map((x) => x / s) : ws;
    const hhi = w.reduce((a, x) => a + x * x, 0);
    return { hhi: round(hhi, 4), top1: round(w[0], 4), top3: round(w.slice(0, 3).reduce((a, b) => a + b, 0), 4),
             top5: round(w.slice(0, 5).reduce((a, b) => a + b, 0), 4),
             effective_n: hhi > 0 ? round(1 / hhi, 2) : null };
  }
  function overlapRaw(a, b) {
    if (!a || !b || !Object.keys(a).length || !Object.keys(b).length) return 0;
    let s = 0;
    for (const k in a) if (k in b) s += Math.min(a[k], b[k]);
    return s;
  }
  function overlapNorm(a, b) {
    if (!a || !b || !Object.keys(a).length || !Object.keys(b).length) return null;
    const cov = (x) => Object.values(x).reduce((p, q) => p + q, 0);
    const denom = Math.min(cov(a), cov(b));
    if (denom <= 0) return null;
    return Math.min(1, overlapRaw(a, b) / denom);
  }
  function exposureGain(cand, port) {
    const base = Object.values(cand).reduce((a, b) => a + b, 0);
    if (base <= 0) return null;
    let g = 0;
    for (const k in cand) g += Math.max(0, cand[k] - (port[k] || 0));
    return Math.min(1, g / base);
  }
  function marginalVol(sp, se, rho, w) {
    if (sp == null || se == null) return null;
    const r = rho == null ? 0.6 : rho;
    const nw = Math.sqrt(Math.pow(1 - w, 2) * sp * sp + w * w * se * se
      + 2 * w * (1 - w) * r * sp * se);
    return round((nw - sp) / sp * 100);
  }
  function blend(comp, alpha) {
    let num = 0, den = 0;
    for (const k in alpha) {
      const v = comp[k];
      if (v == null) continue;
      num += alpha[k] * v; den += alpha[k];
    }
    return den <= 0 ? 0 : num / den * 100;
  }
  function additionScore(r, beta) {
    const novelty = r.overlap_norm == null ? null : 1 - r.overlap_norm;
    const gain = r.exposure_gain;
    const corrGain = r.corr_with_portfolio == null ? null : clip((1 - r.corr_with_portfolio) / 2);
    const goal = (r.components || {}).goal;
    const parts = [[beta.novelty, novelty], [beta.exposure, gain],
                   [beta.correlation, corrGain], [beta.goal, goal]];
    let num = 0, den = 0;
    for (const [w, v] of parts) { if (v == null) continue; num += w * v; den += w; }
    if (den <= 0) return null;
    let pen = 1;
    const dv = r.marginal_vol_change_pct;
    if (dv != null && dv > 3) pen = Math.max(0.7, 1 - (dv - 3) / 60);
    return num / den * 100 * pen;
  }
  function behaviors(positions) {
    const ds = positions.map((p) => p.buy_date).filter(Boolean);
    if (!ds.length) return { n_observed: 0, note: '无交易日期记录' };
    const now = Date.now();
    const holds = ds.map((d) => {
      const t = new Date(d);
      return isNaN(t) ? null : Math.floor((now - t.getTime()) / 86400000);
    }).filter((x) => x != null).sort((a, b) => a - b);
    if (!holds.length) return { n_observed: 0, note: '交易日期无法解析' };
    const n = holds.length, med = holds[Math.floor(n / 2)];
    return {
      n_observed: n, median_holding_days: med, max_holding_days: holds[n - 1], min_holding_days: holds[0],
      patience: med > 365 ? '长期持有' : med > 90 ? '中期持有' : '偏短期交易',
      note: '基于买入日期推断，仅作可观测行为记录，不等同于风险承受能力',
    };
  }
  function divergence(stated, revealed, RTV) {
    const out = [];
    const focus = stated.focus_themes || stated.focus || [];
    const tagExp = revealed.tag_exposure || {};
    for (const f of focus) {
      const w = tagExp[f];
      if (w == null) out.push({ item: f, type: '关注但未持有', detail: `关注的「${f}」在当前持仓中无对应暴露` });
      else if (w < 0.05) out.push({ item: f, type: '关注但占比很低', detail: `关注的「${f}」仅占组合 ${(w * 100).toFixed(1)}%` });
    }
    const vol = revealed.weighted_vol_1y;
    if (stated.risk && vol != null) {
      const t = RTV[stated.risk];
      if (t && Math.abs(vol - t) / Math.max(t, 1e-6) > 0.5) {
        out.push({ item: '风险水平', type: '风险错配',
                   detail: `自述「${stated.risk}」对应目标波动约 ${t}%，实际组合加权波动约 ${vol.toFixed(1)}%` });
      }
    }
    return out;
  }

  global.ETFEngine = { Engine, utils: { corr, annVol, round, clip } };
})(window);
