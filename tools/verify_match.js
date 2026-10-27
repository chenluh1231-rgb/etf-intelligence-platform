/* 一致性校验：在 Node 里跑 match.js，与 Python 侧 matching.run_matching 对比。
 * 用法：node tools/verify_match.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = path.join(__dirname, '..', 'site');
const snap = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'snapshot.json'), 'utf8'));
const ret = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'returns.json'), 'utf8'));

const ctx = { window: {}, console, Math, Date, JSON, isFinite, Number, Object, Array, Set, Map, Infinity };
ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(SITE, 'match.js'), 'utf8'), ctx);

const ENGINE = new ctx.window.ETFEngine.Engine(snap, ret);

const positions = JSON.parse(process.env.POSITIONS || JSON.stringify([
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
]));
const stated = JSON.parse(process.env.STATED || JSON.stringify({
  goals: ['长期增值', '分散风险'], risk: '平衡', horizon_years: 5,
  focus_themes: ['人工智能', '高股息防御'],
}));

const t0 = Date.now();
const res = ENGINE.run(positions, stated, { top_k: 8 });
const b = ENGINE.brief(positions, stated);

console.log('JS 耗时', Date.now() - t0, 'ms');
console.log('候选', res.n_candidates, '短名单', res.n_shortlist, '过滤', JSON.stringify(res.filtered));
console.log('组合', JSON.stringify(res.portfolio));
console.log('\n-- Best Match --');
for (const r of res.best_match.slice(0, 8)) {
  console.log(`${r.rank}. ${r.code} ${r.name} ${r.score}  ` +
    `goal=${r.components.goal} pref=${r.components.preference} comp=${r.components.complement} ` +
    `cost=${r.components.cost} risk=${r.components.risk}  ov=${r.overlap_norm} rho=${r.corr_with_portfolio} dσ=${r.marginal_vol_change_pct}`);
}
console.log('\n-- Best Addition --');
for (const r of res.best_addition.slice(0, 8)) {
  console.log(`${r.code} ${r.name} ${r.addition_score} ov=${r.overlap_norm} gain=${r.exposure_gain} rho=${r.corr_with_portfolio}`);
}
console.log('\n-- 画像 --');
console.log('完整度', res.profile.completeness, '缺口', JSON.stringify(res.profile.gaps));
console.log('波动', res.portfolio.vol_ann, '回撤', res.portfolio.maxdd, '穿透', res.portfolio.penetration_coverage);
console.log('重叠对', (res.profile.revealed.overlap_pairs || []).slice(0, 3)
  .map((p) => `${p.a_name}×${p.b_name}=${p.overlap}`).join(' | '));
console.log('行业', (res.profile.revealed.sector_exposure || []).slice(0, 5).map((s) => `${s.sector}:${s.weight}`).join(', '));
console.log('\n-- 简报 --');
console.log('头条', b.headline);
console.log('组合当日', b.portfolio_pulse.portfolio_pct);
