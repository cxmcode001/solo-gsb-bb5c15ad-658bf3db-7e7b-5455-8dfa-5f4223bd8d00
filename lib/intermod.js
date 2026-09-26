'use strict';

/**
 * 互调冲突分析与自动频率协调核心逻辑（纯函数，无外部依赖）。
 *
 * 单位约定：所有频率在内部一律使用整数 Hz（由 MHz × 1e6 四舍五入得到），
 * 避免浮点误差；仅在 API 边界与界面显示时转换为 MHz。
 *
 * 互调积：对任意两个不同频道 (f1, f2) 枚举
 *   |f1 - f2|、f1 + f2、|2f1 - f2|（含两种有序组合，即 |2f1-f2| 与 |2f2-f1|）
 * 保护区：频道载频 fc、保护间隔 g 时，区间 [fc - g, fc + g] 为保护区；
 * 互调积 p 满足 |p - fc| <= g（含边界）即判定为落入保护区，构成冲突。
 *
 * 现场占用频段：协调时可额外传入若干占用区间（Hz），自动合并重叠/端点相接的区间；
 * 某频道候选载频的保护区与任一占用区间相交（端点相接也算）时，该候选直接排除。
 */

const HZ_PER_MHZ = 1e6;

function mhzToHz(mhz) {
  const n = Number(mhz);
  if (!Number.isFinite(n)) {
    throw new Error(`无效频率值: ${mhz}`);
  }
  return Math.round(n * HZ_PER_MHZ);
}

function hzToMhz(hz) {
  // 保留 6 位小数（1 Hz 精度），并去掉多余的尾随零
  return parseFloat((hz / HZ_PER_MHZ).toFixed(6));
}

/**
 * 计算一组频道的全部互调冲突。
 * @param {Array<{id:*, name:string, freqHz:number, guardHz:number}>} channels 按录入顺序排列
 * @returns {Array<object>} 冲突列表，每项含互调积类型/频率、来源频道、受影响频道
 */
function computeConflicts(channels) {
  const conflicts = [];
  const n = channels.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = channels[i];
      const b = channels[j];
      // 每个无序频道对产生 4 个互调积（三阶项含两种有序组合）
      const products = [
        { type: '|f1-f2|', f1: a, f2: b, value: Math.abs(a.freqHz - b.freqHz) },
        { type: 'f1+f2', f1: a, f2: b, value: a.freqHz + b.freqHz },
        { type: '|2f1-f2|', f1: a, f2: b, value: Math.abs(2 * a.freqHz - b.freqHz) },
        { type: '|2f1-f2|', f1: b, f2: a, value: Math.abs(2 * b.freqHz - a.freqHz) },
      ];
      for (const p of products) {
        for (let k = 0; k < n; k++) {
          const victim = channels[k];
          const deviation = Math.abs(p.value - victim.freqHz);
          if (deviation <= victim.guardHz) {
            conflicts.push({
              productType: p.type,
              productHz: p.value,
              source: [
                { id: p.f1.id, name: p.f1.name, freqHz: p.f1.freqHz },
                { id: p.f2.id, name: p.f2.name, freqHz: p.f2.freqHz },
              ],
              victim: {
                id: victim.id,
                name: victim.name,
                freqHz: victim.freqHz,
                guardHz: victim.guardHz,
              },
              deviationHz: deviation,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

/**
 * 合并区间：按下限排序后合并所有重叠或端点相接（lo <= 已合并上限）的区间。
 * 输入项形如 {lo, hi}，调用方须保证 lo、hi 为有限数且 lo <= hi。
 * @returns {Array<{lo:number, hi:number}>} 合并后的区间（按频率升序）
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .map((iv) => ({ lo: iv.lo, hi: iv.hi }))
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.lo <= last.hi) {
      if (iv.hi > last.hi) last.hi = iv.hi;
    } else {
      merged.push({ lo: iv.lo, hi: iv.hi });
    }
  }
  return merged;
}

/**
 * 频道保护区 [freqHz - guardHz, freqHz + guardHz] 是否与任一占用区间相交。
 * 区间均为闭区间，端点相接也算相交。
 */
function hitsOccupied(freqHz, guardHz, occupiedHz) {
  const lo = freqHz - guardHz;
  const hi = freqHz + guardHz;
  for (const iv of occupiedHz) {
    if (lo <= iv.hi && iv.lo <= hi) return true;
  }
  return false;
}

/** 回溯搜索的节点上限，防止极端参数下搜索空间爆炸 */
const SEARCH_NODE_CAP = 2_000_000;

/**
 * 自动频率协调。
 *
 * 在 [bandMinHz, bandMaxHz] 频段内，以 stepHz 为步进、maxOffsetHz 为最大偏移，
 * 为每个未锁定频道生成候选频率（原频 + k × 步进）。锁定频道保持不动。
 * occupiedHz 为现场扫描到的占用频段（Hz 闭区间），进入搜索前先合并重叠/相接区间；
 * 候选载频的保护区与任一占用区间相交（端点相接也算）时，该候选不可用。
 * 通过带回溯的分支限界搜索，找出总偏移（各频道 |新频-原频| 之和）最小的无冲突方案；
 * 总偏移相同时，按录入顺序逐频道比较，优先选择更低频率。
 *
 * @param {Array<{id:*, name:string, freqHz:number, guardHz:number, locked:boolean}>} channels 按录入顺序
 * @param {{bandMinHz:number, bandMaxHz:number, stepHz:number, maxOffsetHz:number,
 *          occupiedHz?:Array<{lo:number, hi:number}>}} params
 * @returns {{solved:boolean, reason:string|null, capped:boolean, nodes:number,
 *            assignments:Array, totalOffsetHz:number, occupiedHz:Array<{lo:number, hi:number}>}}
 */
function coordinate(channels, params) {
  const { bandMinHz, bandMaxHz, stepHz, maxOffsetHz } = params;
  const occupiedHz = mergeIntervals(Array.isArray(params.occupiedHz) ? params.occupiedHz : []);
  const occupiedDesc = occupiedHz.length > 0 ? '、现场占用频段' : '';
  const n = channels.length;

  // ---- 生成候选频率（按偏移升序、同偏移按频率升序排列） ----
  const candLists = channels.map((ch) => {
    if (ch.locked) {
      // 锁定频道载频不动，但若其保护区落在现场占用频段内，同样不可用
      return hitsOccupied(ch.freqHz, ch.guardHz, occupiedHz) ? [] : [{ freqHz: ch.freqHz, offsetHz: 0 }];
    }
    const list = [];
    const kMax = Math.floor(maxOffsetHz / stepHz);
    for (let k = -kMax; k <= kMax; k++) {
      const f = ch.freqHz + k * stepHz;
      if (f >= bandMinHz && f <= bandMaxHz
        && !hitsOccupied(f, ch.guardHz, occupiedHz)) {
        list.push({ freqHz: f, offsetHz: Math.abs(k) * stepHz });
      }
    }
    list.sort((x, y) => x.offsetHz - y.offsetHz || x.freqHz - y.freqHz);
    return list;
  });

  // 某频道在约束下没有任何候选频率 → 直接无解
  for (let i = 0; i < n; i++) {
    if (candLists[i].length === 0) {
      return {
        solved: false,
        reason: `频道「${channels[i].name}」在指定频段、步进、最大偏移${occupiedDesc}约束下没有可用频率，已保持原有频率。`,
        capped: false,
        nodes: 0,
        assignments: channels.map((ch) => ({
          id: ch.id, name: ch.name, locked: !!ch.locked,
          originalHz: ch.freqHz, freqHz: ch.freqHz, offsetHz: 0,
        })),
        totalOffsetHz: 0,
        occupiedHz,
      };
    }
  }

  // ---- 回溯 + 分支限界 ----
  const assigned = new Array(n); // 已确定的频率（Hz）
  const products = [];           // 已确定频道之间产生的互调积（Hz）
  let best = null;               // { totalHz, freqs: number[] }
  let nodes = 0;
  let capped = false;

  const hitsGuard = (productHz, idx) =>
    Math.abs(productHz - assigned[idx]) <= channels[idx].guardHz;

  /** 解 A 是否优于解 B：总偏移更小；或相同则按录入顺序逐频道取更低频率 */
  const isBetter = (a, b) => {
    if (b === null) return true;
    if (a.totalHz !== b.totalHz) return a.totalHz < b.totalHz;
    for (let i = 0; i < n; i++) {
      if (a.freqs[i] !== b.freqs[i]) return a.freqs[i] < b.freqs[i];
    }
    return false;
  };

  function dfs(k, offsetSoFar) {
    if (capped) return;
    if (++nodes > SEARCH_NODE_CAP) { capped = true; return; }
    if (best && offsetSoFar > best.totalHz) return; // 限界：部分偏移已超过最优解
    if (k === n) {
      const sol = { totalHz: offsetSoFar, freqs: assigned.slice() };
      if (isBetter(sol, best)) best = sol;
      return;
    }
    const baseCount = products.length;
    for (const cand of candLists[k]) {
      if (best && offsetSoFar + cand.offsetHz > best.totalHz) break; // 候选按偏移升序，可提前终止
      assigned[k] = cand.freqHz;

      // 新增互调积：频道 k 与已确定的 0..k-1 配对
      let ok = true;
      for (let j = 0; j < k && ok; j++) {
        const fj = assigned[j];
        const fk = cand.freqHz;
        const newProducts = [
          Math.abs(fj - fk),
          fj + fk,
          Math.abs(2 * fj - fk),
          Math.abs(2 * fk - fj),
        ];
        for (const p of newProducts) {
          // 新互调积不得落入任何已确定频道（含频道 k 自身）的保护区
          for (let m = 0; m <= k; m++) {
            if (hitsGuard(p, m)) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (!ok) break;
        products.push(...newProducts);
      }
      // 既有互调积不得落入频道 k 的保护区
      if (ok) {
        for (let t = 0; t < baseCount; t++) {
          if (hitsGuard(products[t], k)) { ok = false; break; }
        }
      }

      if (ok) dfs(k + 1, offsetSoFar + cand.offsetHz);
      products.length = baseCount; // 回溯
      if (capped) return;
    }
  }

  dfs(0, 0);

  if (best) {
    const assignments = channels.map((ch, i) => ({
      id: ch.id,
      name: ch.name,
      locked: !!ch.locked,
      originalHz: ch.freqHz,
      freqHz: best.freqs[i],
      offsetHz: Math.abs(best.freqs[i] - ch.freqHz),
    }));
    return {
      solved: true,
      reason: capped ? '搜索达到节点上限，返回当前已找到的最优方案（可能非全局最优）。' : null,
      capped,
      nodes,
      assignments,
      totalOffsetHz: best.totalHz,
      occupiedHz,
    };
  }

  // 无解：保持原值并说明原因
  let reason;
  if (channels.every((ch) => ch.locked)) {
    reason = occupiedHz.length > 0
      ? '所有频道均已锁定且当前配置存在互调冲突或落入现场占用频段，没有可调整的频道，已保持原有频率。'
      : '所有频道均已锁定且当前配置存在互调冲突，没有可调整的频道，已保持原有频率。';
  } else {
    reason = `在指定频段、步进、最大偏移${occupiedDesc}约束内未找到无冲突组合，已保持原有频率。可尝试放宽最大偏移、减小步进、扩大频段或调整占用区间。`;
  }
  if (capped) reason += '（搜索达到节点上限，结论基于已截断的搜索空间。）';
  return {
    solved: false,
    reason,
    capped,
    nodes,
    assignments: channels.map((ch) => ({
      id: ch.id, name: ch.name, locked: !!ch.locked,
      originalHz: ch.freqHz, freqHz: ch.freqHz, offsetHz: 0,
    })),
    totalOffsetHz: 0,
    occupiedHz,
  };
}

module.exports = {
  HZ_PER_MHZ,
  mhzToHz,
  hzToMhz,
  mergeIntervals,
  computeConflicts,
  coordinate,
  SEARCH_NODE_CAP,
};
