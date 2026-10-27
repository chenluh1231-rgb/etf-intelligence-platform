/* =============================================================================
 * ocr.js —— 持仓截图识别（浏览器本地 OCR，图片不出本机）
 *
 * 券商 / 基金 App 的截图没有统一格式，甚至常常不显示 6 位代码，
 * 所以这里不假设任何固定列，而是：
 *   1. OCR 取带坐标的词，按 y 聚成行、按 x 排成序
 *   2. 每行里找 6 位代码；找不到就整段去比对全市场 ETF 名称
 *   3. 数值按语义猜字段（带 % 当权重、大额当市值、其余当份额）
 *   4. 全部结果交给用户核对后再应用 —— OCR 不可能全对，这一步不能省
 * ========================================================================== */
(function (global) {
  'use strict';

  const TESS_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const MIN_WORD_CONF = 45;      // 词级置信度下限，过滤明显误识
  const NAME_MIN_SCORE = 0.5;    // 名称匹配可接受的下限

  let tessLoading = null;

  function loadTesseract() {
    if (global.Tesseract) return Promise.resolve(global.Tesseract);
    if (tessLoading) return tessLoading;
    tessLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESS_SRC;
      s.onload = () => (global.Tesseract
        ? resolve(global.Tesseract)
        : reject(new Error('OCR 引擎加载失败')));
      s.onerror = () => reject(new Error('无法下载 OCR 引擎，请检查网络后重试，或改用 CSV / Excel 上传'));
      document.head.appendChild(s);
    });
    return tessLoading;
  }

  /* ------------------------------ OCR ------------------------------ */
  async function recognize(file, onProgress) {
    const T = await loadTesseract();
    const worker = await T.createWorker('chi_sim', 1, {
      logger: (m) => {
        if (!onProgress) return;
        if (m.status === 'recognizing text' && m.progress != null) {
          onProgress(Math.round(m.progress * 100), '识别文字');
        } else if (m.status) {
          onProgress(null, String(m.status));
        }
      },
    });
    try {
      const { data } = await worker.recognize(file);
      return data;
    } finally {
      try { await worker.terminate(); } catch (e) { /* 忽略 */ }
    }
  }

  /* --------------------------- 行 / 词 聚类 --------------------------- */
  function groupLines(words) {
    const ws = (words || [])
      .filter((w) => (w.confidence || 0) >= MIN_WORD_CONF && String(w.text || '').trim())
      .sort((a, b) => a.bbox.y0 - b.bbox.y0);
    const lines = [];
    for (const w of ws) {
      const cy = (w.bbox.y0 + w.bbox.y1) / 2;
      const h = Math.max(6, w.bbox.y1 - w.bbox.y0);
      let L = null;
      for (const cand of lines) {
        if (Math.abs(cand.cy - cy) <= Math.max(8, cand.h * 0.6)) { L = cand; break; }
      }
      if (!L) { L = { cy, h, ws: [] }; lines.push(L); }
      L.ws.push(w);
      L.h = Math.max(L.h, h);
      L.cy = L.ws.reduce((a, x) => a + (x.bbox.y0 + x.bbox.y1) / 2, 0) / L.ws.length;
    }
    lines.sort((a, b) => a.cy - b.cy);
    return lines.map((l) => {
      l.ws.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      return {
        text: l.ws.map((w) => w.text).join(' '),
        joined: l.ws.map((w) => w.text).join(''),
        tokens: l.ws.map((w) => String(w.text).trim()),
        conf: l.ws.reduce((a, w) => a + w.confidence, 0) / l.ws.length,
      };
    });
  }

  /* ------------------------------ 匹配 ETF ------------------------------ */
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[\s\u3000]/g, '')
      .replace(/[()（）[\]【】]/g, '')
      .replace(/[（(].*?[)）]/g, '')
      .toUpperCase();
  }
  function lev(a, b) {
    const n = a.length, m = b.length;
    if (!n || !m) return Math.max(n, m);
    let prev = Array.from({ length: m + 1 }, (_, i) => i);
    for (let i = 1; i <= n; i++) {
      const cur = [i];
      for (let j = 1; j <= m; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[m];
  }

  /* 库里的名称比识别结果长很多时（"半导体ETF鹏华" vs "半导休ETF"），
     直接算整串编辑距离会被长度差压死，改为在长串里滑动等长窗口取最小距离。 */
  function levSub(n, q) {
    const L = q.length;
    if (!L) return n.length;
    if (n.length <= L) return lev(n, q);
    let best = Infinity;
    for (let i = 0; i + L <= n.length; i++) {
      const d = lev(n.slice(i, i + L), q);
      if (d < best) best = d;
      if (best === 0) break;
    }
    return best;
  }

  function buildIndex(etfs) {
    return (etfs || []).map((e) => ({ code: e[0], name: e[1] || '' }));
  }

  function matchByName(index, query) {
    const q = norm(query);
    if (q.length < 2) return null;
    let best = null, bestScore = 0;
    for (const e of index) {
      const n = norm(e.name);
      if (!n) continue;
      let s = 0;
      if (n === q) s = 1;
      else if (n.includes(q) || q.includes(n)) {
        s = 0.74 + 0.2 * (Math.min(n.length, q.length) / Math.max(n.length, q.length));
      } else {
        s = (1 - levSub(n, q) / q.length) * 0.72;
      }
      if (s > bestScore) { bestScore = s; best = e; }
    }
    return bestScore >= NAME_MIN_SCORE ? { ...best, score: bestScore } : null;
  }

  /* ---------------------------- 行 → 持仓记录 ---------------------------- */
  const NUM_RE = /^[-+＋−]?[\d,，.]+[%￥¥]?$/;
  const IGNORE = /总资产|总市值|持仓收益|累计收益|可用|可取|盈亏|收益率|参考|合计|共\s*\d|账户|总资产|持仓|自选|刷新|排序/;

  function parseLine(line, index, byCode) {
    const raw = line.text || '';
    if (!raw.trim()) return null;
    if (IGNORE.test(raw) && !/\d{6}/.test(line.joined)) return null;

    let code = null;
    const cm = line.joined.match(/\d{6}/);
    if (cm) code = cm[0];

    const nums = [];
    for (const t of line.tokens) {
      if (!NUM_RE.test(t)) continue;
      const isPct = /%/.test(t);
      const v = parseFloat(t.replace(/[,，%￥¥＋+]/g, ''));
      if (isFinite(v)) nums.push({ raw: t, v, pct: isPct });
    }

    // 名称：剔除纯数字与纯符号后的剩余文本
    const namePart = line.tokens
      .filter((t) => !NUM_RE.test(t) && !/^[-+*·:：/|]+$/.test(t))
      .join('')
      .replace(/\d{6}/g, '')
      .trim();

    let hit = null, how = null, cands = null;
    if (code && byCode[code]) { hit = byCode[code]; how = 'code'; }
    if (!hit && namePart.length >= 2) {
      const m = matchByName(index, namePart);
      if (m) {
        hit = m; how = 'name'; code = code || m.code;
        // 简称会命中同指数的其他产品（如"半导体ETF"可能指国联安也可能指鹏华），
        // 把候选一并带出去，让用户在核对时一眼改对。
        if (m.score < 0.98) cands = searchEtf(index, namePart, 6);
      }
    }
    if (!hit && code && !byCode[code]) {
      // 认出了 6 位数字但库里没有，也先留给用户判断
      hit = { code, name: namePart || '' }; how = 'code-raw';
    }
    if (!hit) return null;

    // 字段猜测：带 % 的当权重，其余取最大者当市值
    let weight = null, market_value = null, shares = null;
    const pctNum = nums.find((n) => n.pct);
    if (pctNum) weight = Math.abs(pctNum.v) > 1.5 ? pctNum.v / 100 : pctNum.v;
    const plain = nums.filter((n) => !n.pct).map((n) => n.v);
    if (plain.length) {
      const big = Math.max.apply(null, plain);
      if (big >= 100) market_value = big;
      else if (weight == null && !pctNum) shares = big;
    }

    return {
      code: hit.code || code,
      name: hit.name || namePart || '',
      weight, market_value, shares,
      conf: Math.round(line.conf || 0),
      match: (hit && hit.score) || null,   // 名称匹配置信度，低分要在核对时标出来
      how, cands,
      raw,
    };
  }

  /* ------------------------------- 主入口 ------------------------------- */
  async function parseScreenshot(file, snap, onProgress) {
    const index = buildIndex((snap && snap.etfs) || []);
    const byCode = {};
    index.forEach((e) => { byCode[e.code] = e; });

    const data = await recognize(file, onProgress);
    const lines = groupLines(data.words || []);

    const rows = [];
    const seen = new Set();
    for (const ln of lines) {
      const r = parseLine(ln, index, byCode);
      if (!r || !r.code) continue;
      if (seen.has(r.code)) continue;   // 同一只出现多行时保留首次
      seen.add(r.code);
      rows.push(r);
    }

    // 只有市值没有权重时按市值归一化，与 CSV 口径一致
    const usable = rows.filter((r) => r.code && /^\d{6}$/.test(r.code));
    const byMv = usable.every((r) => r.weight == null) && usable.some((r) => r.market_value);
    if (byMv) {
      const tot = usable.reduce((a, r) => a + (r.market_value || 0), 0);
      usable.forEach((r) => { r.weight = tot ? (r.market_value || 0) / tot : 0; });
    } else {
      const tot = usable.reduce((a, r) => a + (r.weight || 0), 0);
      if (tot && Math.abs(tot - 1) > 0.02) {
        usable.forEach((r) => { r.weight = (r.weight || 0) / tot; });
      }
    }
    usable.forEach((r) => { r.weight = r.weight || 0; r.source = 'screenshot'; });

    return {
      rows: usable,
      lines: lines.map((l) => l.text),
      text: (data.text || '').slice(0, 4000),
      dropped: lines.length - rows.length,
    };
  }

  /* 供校正界面使用：按关键词在库里找候选 */
  function searchEtf(index, q, limit) {
    const raw = String(q == null ? '' : q).trim();
    const n = norm(raw);
    const codeHit = raw.replace(/\D/g, '').slice(0, 6);
    if (!n && codeHit.length < 3) return [];
    const out = [];
    for (const e of index) {
      let s = 0;
      if (codeHit.length >= 3 && e.code.indexOf(codeHit) === 0) s = 0.9;
      if (n) {
        const en = norm(e.name);
        if (en === n) s = Math.max(s, 1);
        else if (en.includes(n) || n.includes(en)) s = Math.max(s, 0.8);
        else s = Math.max(s, (1 - levSub(en, n) / n.length) * 0.7);
      }
      if (s >= 0.35) out.push({ code: e.code, name: e.name, score: Math.round(s * 100) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit || 8);
  }

  global.OCR = { parseScreenshot, buildIndex, matchByName, searchEtf, norm };
})(window);
