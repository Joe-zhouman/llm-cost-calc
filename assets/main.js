/* LLM 费用增长计算器
 * 计费公式（用户口述版）：
 *   花费(C) = C·R·输入价 + C·(1−R)·输出价 + (1+2+…+⌊C/x⌋)·x·缓存价
 *   C：上下文（K tokens）；x：每次请求新增的上下文（K）；R：新增上下文中输入占比
 *   请求 k 把当下全量 k·x 上下文按缓存读价重收一遍。
 *   价格单位 $/1M tokens，花费按 /1000 归一到 $。
 * 校准：α = √(t榜/t0)，t0 = Fable 5.1 (40498)；校准页 x = 1/α。
 */
(function () {
  'use strict';

  var D = window.APP_DATA;
  var TF = D.tFable;
  var MODELS = D.models;
  var byId = {};
  for (var i = 0; i < MODELS.length; i++) byId[MODELS[i].id] = MODELS[i];

  var COLOR_A = '#4c72b0';
  var COLOR_B = '#c44e52';
  var KEY_CTX = 277; // Codex 默认窗口

  // ---------- 状态 ----------
  // 价格已统一为人民币（海外模型美元牌价×7 已折算进数据），全部 ¥ 展示
  var state = { R: 0.5, gx: 1, tpHit: 0.9 };
  try {
    var saved = localStorage.getItem('llmcost-state');
    if (saved) {
      saved = JSON.parse(saved);
      if (saved && typeof saved === 'object') {
        if (typeof saved.R === 'number' && saved.R >= 0 && saved.R <= 1) state.R = saved.R;
        if (typeof saved.gx === 'number' && saved.gx > 0) state.gx = saved.gx;
        if (typeof saved.tpHit === 'number') state.tpHit = saved.tpHit;
      }
    }
  } catch (e) { /* localStorage 不可用时用默认值 */ }

  function persist() {
    try { localStorage.setItem('llmcost-state', JSON.stringify(state)); } catch (e) { /* 忽略 */ }
  }

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function money(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var val2;
    if (v >= 1000) val2 = Math.round(v).toLocaleString('en-US');
    else if (v >= 100) val2 = v.toFixed(0);
    else if (v >= 1) val2 = v.toFixed(2);
    else val2 = v.toFixed(3);
    return '¥' + val2;
  }
  function priceStr(v) {
    if (v === null || v === undefined) return '—';
    if (v >= 1) return '¥' + (Math.round(v * 100) / 100);
    return '¥' + (Math.round(v * 10000) / 10000);
  }
  function num(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toFixed(d === undefined ? 2 : d);
  }
  function Kfmt(k) { return num(k, k >= 100 ? 0 : 1) + 'K'; }

  // ---------- 计费 ----------
  // p = {pin, pout, pc}（$/1M）；C/x 单位 K tokens，返回 $ 累计花费
  function costAtCtx(C, p, x, R) {
    var n = Math.floor(C / x + 1e-9); // ⌊C/x⌋：爬到 C 发的请求数
    return (C * R * p.pin + C * (1 - R) * p.pout + x * p.pc * n * (n + 1) / 2) / 1000;
  }
  // 按请求数参数化（校准页用）：P 次请求爬到 P·x K，无取整问题
  function costAtReq(P, p, x, R) {
    return (P * x * (R * p.pin + (1 - R) * p.pout) + x * p.pc * P * (P + 1) / 2) / 1000;
  }
  // 校准：α = √(t榜/t0)；校准后 x = α——效率低的模型（T榜大）每请求新增更多上下文，
  // 同请求数下上下文更大、花费更高；效率高的模型爬得慢。无榜单行按 α=1。
  function alphaOf(m) {
    if (!m.bench) return 1;
    return Math.sqrt(m.bench[1] / TF);
  }
  function xCalib(m) { return alphaOf(m); }
  function reqAtCtx(C, x) { return Math.floor(C / x + 1e-9); }

  function getPrices(m, src) {
    if (src === 'go' && m.gp) return { pin: m.gp[1], pout: m.gp[2], pc: m.gp[3] };
    if (src === 'go' && m.p) return null; // 无 Go 价
    if (m.p) return { pin: m.p[0], pout: m.p[1], pc: m.p[2] };
    return null;
  }

  // ---------- 通用渲染 ----------
  function readout(el, items) {
    var html = '<div class="ro-row">';
    for (var i = 0; i < items.length; i++) {
      html += '<span class="ro-item"><span class="ro-k">' + items[i][0] + '</span> <span class="ro-v">' + items[i][1] + '</span></span>';
    }
    el.innerHTML = html + '</div>';
  }

  function barList(el, rows) {
    // rows: [{label, sub, value, valueText, color}]
    var max = 0, i;
    for (i = 0; i < rows.length; i++) if (rows[i].value > max) max = rows[i].value;
    var html = '';
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var w = max > 0 ? Math.max(1.5, r.value / max * 100) : 0;
      html += '<div class="bar-item">' +
        '<div class="bar-meta"><span class="bar-name">' + (i + 1) + '. ' + r.label +
        (r.sub ? '<span class="bar-sub">' + r.sub + '</span>' : '') + '</span>' +
        '<span class="bar-val">' + r.valueText + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill' + (r.color === 'alt' ? ' alt' : '') + '" style="width:' + w + '%"></div></div>' +
        '</div>';
    }
    el.innerHTML = html;
  }

  var CUSTOM_ID = '__custom';
  function fillModelSelect(sel, value, opts) {
    opts = opts || {};
    var html = '';
    var list = MODELS.slice(0);
    if (opts.onlyGo) list = list.filter(function (m) { return m.gp; });
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      html += '<option value="' + m.id + '"' + (m.id === value ? ' selected' : '') + '>' + m.name + '</option>';
    }
    if (opts.custom) {
      html += '<option value="' + CUSTOM_ID + '"' + (value === CUSTOM_ID ? ' selected' : '') + '>自定义模型（手填价格）</option>';
    }
    sel.innerHTML = html;
  }


  // ---------- 设置 ----------
  function bindSettings(rerender) {
    var rIn = $('set-r'), xIn = $('set-x');
    rIn.value = String(state.R);
    xIn.value = String(state.gx);
    function apply() {
      var rv = parseFloat(rIn.value);
      if (!isNaN(rv) && rv >= 0 && rv <= 1) state.R = rv;
      var xv = parseFloat(xIn.value);
      if (!isNaN(xv) && xv > 0) state.gx = xv;
      persist();
      rerender();
    }
    rIn.addEventListener('change', apply);
    xIn.addEventListener('change', apply);
  }

  // ---------- 页面 1：费用曲线 ----------
  function modelName(id, nameInputId) {
    if (id === CUSTOM_ID) {
      var v = $(nameInputId).value;
      return (v && v.trim()) ? v.trim() : '自定义模型';
    }
    return byId[id] ? byId[id].name : '—';
  }
  function initCurve() {
    fillModelSelect($('curve-model'), 'fable51', { custom: true });
    prefillCustom('curve');
    $('curve-model').addEventListener('change', function () {
      var isCustom = this.value === CUSTOM_ID;
      $('curve-name-wrap').classList.toggle('hidden', !isCustom);
      if (!isCustom) prefillCustom('curve');
      renderCurve();
    });
    $('curve-customname').addEventListener('input', renderCurve);
    ['curve-pin', 'curve-pout', 'curve-pc'].forEach(function (id) {
      $(id).addEventListener('change', renderCurve);
    });
    renderCurve();
  }
  function prefillCustom(prefix) {
    if ($(prefix + '-model').value === CUSTOM_ID) return; // 自定义模型不覆盖手填价
    var m = byId[$(prefix + '-model').value];
    if (!m) return;
    var p = m.p ? { pin: m.p[0], pout: m.p[1], pc: m.p[2] } : (m.gp ? { pin: m.gp[1], pout: m.gp[2], pc: m.gp[3] } : { pin: 7, pout: 35, pc: 0.7 });
    if (document.activeElement === $(prefix + '-pin')) return; // 正在编辑不覆盖
    $(prefix + '-pin').value = p.pin;
    $(prefix + '-pout').value = p.pout;
    $(prefix + '-pc').value = p.pc;
  }
  function customPrices(prefix) {
    return {
      pin: Math.max(0, parseFloat($(prefix + '-pin').value) || 0),
      pout: Math.max(0, parseFloat($(prefix + '-pout').value) || 0),
      pc: Math.max(0, parseFloat($(prefix + '-pc').value) || 0)
    };
  }
  // 上下文曲线采样：1K–1M，步长 1K
  function ctxSample(p, x, R) {
    var arr = [];
    for (var i = 1; i <= 1000; i++) arr.push({ x: i, y: costAtCtx(i, p, x, R) });
    return arr;
  }
  function renderCurve() {
    var id = $('curve-model').value;
    var isCustom = id === CUSTOM_ID;
    var name = modelName(id, 'curve-customname');
    var p = customPrices('curve');
    var noteEl = $('curve-note');
    var nt = (!isCustom && byId[id] && byId[id].note) ? byId[id].note : '';
    if (nt) { noteEl.textContent = nt; noteEl.classList.remove('hidden'); }
    else noteEl.classList.add('hidden');
    window.Charts.line($('curve-chart'), {
      series: [{ name: name, color: COLOR_A, points: ctxSample(p, state.gx, state.R) }],
      xLabel: 'K tokens 上下文',
      marker: { x: KEY_CTX, label: '277K' },
      xFmt: function (v) { return num(v, 0) + 'K'; },
      yFmt: money
    });
    var c277 = costAtCtx(KEY_CTX, p, state.gx, state.R);
    var n277 = reqAtCtx(KEY_CTX, state.gx);
    var cachePart = state.gx * p.pc * n277 * (n277 + 1) / 2 / 1000;
    readout($('curve-readout'), [
      ['277K 累计', money(c277)],
      ['其中缓存重收', money(cachePart) + '（' + num(cachePart / c277 * 100, 0) + '%）'],
      ['爬到 277K 需', n277 + ' 请求'],
      ['价格', priceStr(p.pin) + ' / ' + priceStr(p.pout) + ' / 缓存' + priceStr(p.pc)]
    ]);
  }

  // ---------- 页面 2：双模型对比（A/B 预填逻辑与校准对比页共用，按 prefix 区分） ----------
  function groupEditing(prefix, sides) {
    var ids = [];
    for (var s = 0; s < sides.length; s++) {
      ids.push(prefix + '-pin-' + sides[s], prefix + '-pout-' + sides[s], prefix + '-pc-' + sides[s]);
    }
    for (var i = 0; i < ids.length; i++) if (document.activeElement === $(ids[i])) return true;
    return false;
  }
  function prefillSided(prefix, side, force) {
    if (!force && groupEditing(prefix, ['a', 'b'])) return;
    if ($(prefix + '-model-' + side).value === CUSTOM_ID) return; // 自定义模型不覆盖手填价
    var m = byId[$(prefix + '-model-' + side).value];
    if (!m) return;
    var p = m.p ? [m.p[0], m.p[1], m.p[2]] : (m.gp ? [m.gp[1], m.gp[2], m.gp[3]] : [7, 35, 0.7]);
    $(prefix + '-pin-' + side).value = p[0];
    $(prefix + '-pout-' + side).value = p[1];
    $(prefix + '-pc-' + side).value = p[2];
  }
  function sidedPrices(prefix, side) {
    return {
      pin: Math.max(0, parseFloat($(prefix + '-pin-' + side).value) || 0),
      pout: Math.max(0, parseFloat($(prefix + '-pout-' + side).value) || 0),
      pc: Math.max(0, parseFloat($(prefix + '-pc-' + side).value) || 0)
    };
  }
  function initCompare() {
    fillModelSelect($('cmp-model-a'), 'fable51', { custom: true });
    fillModelSelect($('cmp-model-b'), 'gpt56sol', { custom: true });
    prefillSided('cmp', 'a', true);
    prefillSided('cmp', 'b', true);
    $('cmp-model-a').addEventListener('change', function () {
      $('cmp-name-wrap-a').classList.toggle('hidden', this.value !== CUSTOM_ID);
      if (this.value !== CUSTOM_ID) prefillSided('cmp', 'a', true);
      renderCompare();
    });
    $('cmp-model-b').addEventListener('change', function () {
      $('cmp-name-wrap-b').classList.toggle('hidden', this.value !== CUSTOM_ID);
      if (this.value !== CUSTOM_ID) prefillSided('cmp', 'b', true);
      renderCompare();
    });
    $('cmp-customname-a').addEventListener('input', renderCompare);
    $('cmp-customname-b').addEventListener('input', renderCompare);
    ['cmp-pin-a', 'cmp-pout-a', 'cmp-pc-a', 'cmp-pin-b', 'cmp-pout-b', 'cmp-pc-b'].forEach(function (id) {
      $(id).addEventListener('change', renderCompare);
    });
    renderCompare();
  }
  function renderCompare() {
    var idA = $('cmp-model-a').value, idB = $('cmp-model-b').value;
    var nameA = modelName(idA, 'cmp-customname-a');
    var nameB = modelName(idB, 'cmp-customname-b');
    var pA = sidedPrices('cmp', 'a');
    var pB = sidedPrices('cmp', 'b');
    var noteEl = $('cmp-note');
    var notes = [];
    if (idA !== CUSTOM_ID && byId[idA] && byId[idA].note) notes.push(byId[idA].note);
    if (idB !== CUSTOM_ID && byId[idB] && byId[idB].note) notes.push(byId[idB].note);
    if (notes.length) { noteEl.textContent = notes.join('；'); noteEl.classList.remove('hidden'); }
    else noteEl.classList.add('hidden');
    var series = [];
    series.push({ name: 'A ' + nameA, color: COLOR_A, points: ctxSample(pA, state.gx, state.R) });
    series.push({ name: 'B ' + nameB, color: COLOR_B, points: ctxSample(pB, state.gx, state.R) });
    window.Charts.line($('cmp-chart'), {
      series: series,
      xLabel: 'K tokens 上下文',
      marker: { x: KEY_CTX, label: '277K' },
      xFmt: function (v) { return num(v, 0) + 'K'; },
      yFmt: money
    });
    var cA = costAtCtx(KEY_CTX, pA, state.gx, state.R), cB = costAtCtx(KEY_CTX, pB, state.gx, state.R);
    readout($('cmp-readout'), [
      ['A @277K', money(cA)],
      ['B @277K', money(cB)],
      ['B/A', num(cB / cA, 3) + 'x'],
      ['A 价格', priceStr(pA.pin) + '/' + priceStr(pA.pout) + '/' + priceStr(pA.pc)],
      ['B 价格', priceStr(pB.pin) + '/' + priceStr(pB.pout) + '/' + priceStr(pB.pc)]
    ]);
  }

  // ---------- 页面 3：277K 价格榜（官方牌价） ----------
  function initRank277() {
    renderRank277();
  }
  function renderRank277() {
    var rows = [];
    for (var i = 0; i < MODELS.length; i++) {
      var m = MODELS[i];
      if (!m.p) continue;
      var p = { pin: m.p[0], pout: m.p[1], pc: m.p[2] };
      rows.push({
        label: m.name,
        sub: priceStr(p.pin) + '/' + priceStr(p.pout) + '/' + priceStr(p.pc),
        value: costAtCtx(KEY_CTX, p, state.gx, state.R),
        valueText: money(costAtCtx(KEY_CTX, p, state.gx, state.R))
      });
    }
    rows.sort(function (a, b) { return a.value - b.value; });
    barList($('rank277-list'), rows);
  }

  // ---------- 页面 4：榜单校准 ----------
  function initCalib() {
    fillModelSelect($('calib-model'), 'fable51', { custom: true });
    prefillCustom('calib');
    $('calib-model').addEventListener('change', function () {
      $('calib-name-wrap').classList.toggle('hidden', this.value !== CUSTOM_ID);
      if (this.value !== CUSTOM_ID) prefillCustom('calib');
      renderCalib();
    });
    $('calib-customname').addEventListener('input', renderCalib);
    ['calib-pin', 'calib-pout', 'calib-pc', 'calib-req'].forEach(function (id) {
      $(id).addEventListener('change', renderCalib);
    });
    renderCalib();
  }
  function renderCalib() {
    var id = $('calib-model').value;
    var isCustom = id === CUSTOM_ID;
    var m = byId[id];
    var name = modelName(id, 'calib-customname');
    var p = customPrices('calib');
    // 校准只看榜单 token（T榜），与价格无关；自定义模型无榜单行 → α=1（未校准）
    var a = (m && m.bench) ? alphaOf(m) : 1;
    var x = a;
    var P = Math.min(2000, Math.max(1, parseInt($('calib-req').value, 10) || 300));
    var P277 = reqAtCtx(KEY_CTX, x); // 爬到 277K 需 ⌊277/x⌋ 次
    $('calib-req').value = String(P);
    var noteEl = $('calib-note');
    var parts = [];
    if (!isCustom && m && m.note) parts.push(m.note);
    if (isCustom) parts.push('自定义模型无榜单行，按 α=1（未校准）处理');
    else if (m && !m.bench) parts.push('该模型无榜单行，按 α=1（未校准）处理');
    if (parts.length) { noteEl.textContent = parts.join('；'); noteEl.classList.remove('hidden'); }
    else noteEl.classList.add('hidden');

    var Pmax = Math.max(P, Math.min(P277 + 10, 2000));
    var pts = [];
    for (var i = 1; i <= Pmax; i++) pts.push({ x: i, y: costAtReq(i, p, x, state.R) });
    window.Charts.line($('calib-chart'), {
      series: [{ name: name, color: COLOR_A, points: pts }],
      xLabel: '请求数',
      marker: { x: P277, label: '到 277K 需 ' + P277 + ' 请求' },
      xFmt: function (v) { return num(v, 0); },
      yFmt: money
    });
    readout($('calib-readout'), [
      ['α', num(a, 3)],
      ['x=α', num(x, 3)],
      [P + ' 请求爬到', Kfmt(P * x)],
      ['累计费用', money(costAtReq(P, p, x, state.R))],
      ['到 277K 需', P277 + ' 请求']
    ]);
  }

  // ---------- 页面 5：校准对比 ----------
  function initCalibCmp() {
    fillModelSelect($('cc-model-a'), 'fable51', { custom: true });
    fillModelSelect($('cc-model-b'), 'gpt56sol', { custom: true });
    prefillSided('cc', 'a', true);
    prefillSided('cc', 'b', true);
    $('cc-model-a').addEventListener('change', function () {
      $('cc-name-wrap-a').classList.toggle('hidden', this.value !== CUSTOM_ID);
      if (this.value !== CUSTOM_ID) prefillSided('cc', 'a', true);
      renderCalibCmp();
    });
    $('cc-model-b').addEventListener('change', function () {
      $('cc-name-wrap-b').classList.toggle('hidden', this.value !== CUSTOM_ID);
      if (this.value !== CUSTOM_ID) prefillSided('cc', 'b', true);
      renderCalibCmp();
    });
    $('cc-customname-a').addEventListener('input', renderCalibCmp);
    $('cc-customname-b').addEventListener('input', renderCalibCmp);
    ['cc-pin-a', 'cc-pout-a', 'cc-pc-a', 'cc-pin-b', 'cc-pout-b', 'cc-pc-b', 'cc-req'].forEach(function (id) {
      $(id).addEventListener('change', renderCalibCmp);
    });
    renderCalibCmp();
  }
  function renderCalibCmp() {
    var idA = $('cc-model-a').value, idB = $('cc-model-b').value;
    var mA = byId[idA], mB = byId[idB]; // 自定义模型 → undefined
    var nameA = modelName(idA, 'cc-customname-a');
    var nameB = modelName(idB, 'cc-customname-b');
    var pA = sidedPrices('cc', 'a');
    var pB = sidedPrices('cc', 'b');
    var P = Math.min(2000, Math.max(1, parseInt($('cc-req').value, 10) || 300));
    $('cc-req').value = String(P);
    var noteEl = $('cc-note');
    var parts = [];
    if (idA === CUSTOM_ID || (mA && !mA.bench)) parts.push('A 无榜单行，按 α=1（未校准）');
    if (idB === CUSTOM_ID || (mB && !mB.bench)) parts.push('B 无榜单行，按 α=1（未校准）');
    if (parts.length) { noteEl.textContent = parts.join('；'); noteEl.classList.remove('hidden'); }
    else noteEl.classList.add('hidden');

    // 校准只看榜单 token（T榜），与价格无关；无榜单行（含自定义）→ α=1
    var xA = (mA && mA.bench) ? xCalib(mA) : 1;
    var xB = (mB && mB.bench) ? xCalib(mB) : 1;
    function mk(p, x, color, name) {
      var arr = [];
      for (var i = 1; i <= P; i++) arr.push({ x: i, y: costAtReq(i, p, x, state.R) });
      return { name: name, color: color, points: arr };
    }
    function mkCtx(x, color, name) {
      var arr = [];
      for (var i = 1; i <= P; i++) arr.push({ x: i, y: i * x });
      return { name: name, color: color, points: arr };
    }
    var ctxSeries = [], costSeries = [];
    ctxSeries.push(mkCtx(xA, COLOR_A, 'A ' + nameA));
    ctxSeries.push(mkCtx(xB, COLOR_B, 'B ' + nameB));
    costSeries.push(mk(pA, xA, COLOR_A, 'A ' + nameA));
    costSeries.push(mk(pB, xB, COLOR_B, 'B ' + nameB));
    window.Charts.line($('cc-chart-ctx'), {
      series: ctxSeries, xLabel: '请求数', marker: null,
      xFmt: function (v) { return num(v, 0); },
      yFmt: function (v) { return num(v, 0) + 'K'; }
    });
    window.Charts.line($('cc-chart-cost'), {
      series: costSeries, xLabel: '请求数', marker: null,
      xFmt: function (v) { return num(v, 0); },
      yFmt: money
    });
    var cA = costAtReq(P, pA, xA, state.R), cB = costAtReq(P, pB, xB, state.R);
    readout($('cc-readout'), [
      ['A: ' + P + ' 请求', Kfmt(P * xA) + ' / ' + money(cA)],
      ['B: ' + P + ' 请求', Kfmt(P * xB) + ' / ' + money(cB)],
      ['B/A 费用', num(cB / cA, 3) + 'x']
    ]);
  }

  // ---------- 页面 6：300 请求榜（α/β 两种折算 × 两种排名维度） ----------
  var rank300Sort = 'alpha-cost';
  var RANK_P = 300;
  // 折算系数：α=√(t榜/t0)（默认，日常口径）；β=t榜/t0 不开根号（极限对比，参考用）
  function factorOf(m, mode) {
    if (!m.bench) return 1;
    var ratio = m.bench[1] / TF;
    return mode === 'beta' ? ratio : Math.sqrt(ratio);
  }
  // 分数修正 S：med ≥ 基准 线性归一到 [1,2]（基准=1、GPT-6 Astra=2，不开根号）；
  // med < 基准 按对数惩罚归一到 (0.1,1]（最末=0.1）。baseId：300请求榜用 sonnet5，斩杀线榜用 dsv4flash
  function scoreNorm(med, baseId) {
    var s0 = byId[baseId].bench[0], s1 = byId['gpt6astra'].bench[0];
    if (med >= s0) return 1 + (med - s0) / (s1 - s0);
    var lo = Infinity;
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].bench && MODELS[i].bench[0] < lo) lo = MODELS[i].bench[0];
    }
    var t = (med - s0) / (lo - s0);
    return Math.pow(10, -t);
  }
  function initRank300() {
    var btns = document.querySelectorAll('#page-rank300 .sort-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        rank300Sort = this.getAttribute('data-sort');
        var all = document.querySelectorAll('#page-rank300 .sort-btn');
        for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
        this.classList.add('active');
        renderRank300();
      });
    }
    renderRank300();
  }
  function renderRank300() {
    var isKill = rank300Sort.indexOf('kill') >= 0;
    var isBetaKill = rank300Sort === 'beta-kill';
    var mode = rank300Sort.indexOf('beta') === 0 ? 'beta' : 'alpha';
    var effMode = isKill || rank300Sort.indexOf('-eff') > 0;
    var baseId = isKill ? 'dsv4flash' : 'sonnet5';
    var rows = [];
    for (var i = 0; i < MODELS.length; i++) {
      var m = MODELS[i];
      if (!m.bench) continue; // 折算榜只收有榜单行的模型
      var p = getPrices(m, 'or');
      if (!p) continue;
      var x = factorOf(m, mode); // α 或 β 直接作为 x（效率低→每请求新增更多上下文→同请求数花费更高）
      var c = costAtReq(RANK_P, p, x, state.R);
      var med = m.bench[0];
      rows.push({ m: m, cost: c, med: med, eff: c / scoreNorm(med, baseId) });
    }
    // 指数基准：S 基准模型自身的折算修正费用（其 S=1）→ 指数 = (费用÷S) ÷ 基准，基准模型恒为 1.00
    var bmodel = byId[baseId];
    var baseEff = costAtReq(RANK_P, getPrices(bmodel, 'or'), factorOf(bmodel, mode), state.R) / scoreNorm(bmodel.bench[0], baseId);
    var noteEl = $('rank300-note');
    if (rank300Sort === 'alpha-cost') {
      noteEl.textContent = '校准口径 α=√(t榜/t0)、x=α 下发 ' + RANK_P + ' 次请求的累计花费（官方牌价，R=' + num(state.R, 2) + '）。效率低（T榜大）的模型每请求新增更多上下文、花费更高。';
    } else if (rank300Sort === 'alpha-eff') {
      noteEl.textContent = 'α折算累计花费 ÷ 分数修正S。基准 Sonnet 5（med ' + num(byId['sonnet5'].bench[0], 2) + '）=1：其上线性归一（GPT-6 Astra=2，不开根号），其下按对数惩罚（最末 ' + (function () { var lo = Infinity; for (var i = 0; i < MODELS.length; i++) { if (MODELS[i].bench && MODELS[i].bench[0] < lo) lo = MODELS[i].bench[0]; } return num(lo, 2); })() + '）=0.1，低分模型被重罚。显示值为性价比指数：折算费用÷S 再除以基准模型自身的修正费用（Sonnet 5=1.00），无量纲、越小越好。';
    } else if (rank300Sort === 'kill') {
      noteEl.textContent = '斩杀线口径：分数修正S 的基准换成 DeepSeek V4 Flash（med ' + num(byId['dsv4flash'].bench[0], 2) + '）=1——显示值为指数，基准模型自身 =1.00 即斩杀线，>1 被斩杀、低于线的才打得起 API。其余口径同「α · 费用/分数修正」。';
    } else if (rank300Sort === 'beta-cost') {
      noteEl.textContent = 'β=t榜/t0 不开根号（x=β）：不做日常压缩的极限口径，效率差距全额体现，仅作参考。';
    } else if (rank300Sort === 'beta-eff') {
      noteEl.textContent = 'β（极限口径）累计花费 ÷ 同一分数修正S（Sonnet 5=1、GPT-6 Astra=2、最末=0.1）。显示值为指数（Sonnet 5=1.00），无量纲，双极限参考、越小越好。';
    } else {
      noteEl.textContent = 'β（极限口径）斩杀线：分数修正S 的基准换成 DeepSeek V4 Flash（med ' + num(byId['dsv4flash'].bench[0], 2) + '）=1，β 不开根号全额放大效率差。显示值为指数：DS-V4-Flash 自身 =1.00 即斩杀线，>1 被斩杀。双极限参考。';
    }
    rows.sort(function (a, b) {
      return effMode ? a.eff - b.eff : a.cost - b.cost;
    });
    var bar = [];
    for (var k = 0; k < rows.length; k++) {
      var it = rows[k];
      bar.push({
        label: it.m.name,
        sub: (mode === 'beta' ? 'β=' : 'α=') + num(factorOf(it.m, mode), 2) + ' · S=' + num(scoreNorm(it.med, baseId), 2) + ' · med=' + num(it.med, 1),
        value: effMode ? it.eff / baseEff : it.cost,
        valueText: effMode ? num(it.eff / baseEff, 3) : money(it.cost)
      });
    }
    barList($('rank300-list'), bar);
  }

  // ---------- 页面 8：Plan 折算榜（纯数据展示：折算三价 + 折算 token 单价，按单价排名） ----------
  function initGoRank() {
    var slider = $('tp-hit');
    slider.value = String(Math.round(state.tpHit * 100));
    $('tp-hit-val').textContent = Math.round(state.tpHit * 100) + '%';
    slider.addEventListener('input', function () {
      state.tpHit = parseInt(slider.value, 10) / 100;
      $('tp-hit-val').textContent = slider.value + '%';
      persist();
      renderGoRank();
    });
    renderGoRank();
  }
  // 按模型名找 benchmark 模型对象（带官方牌价）；plan 侧名字可能带/不带档位后缀，去括号后精确匹配
  function officialModelOf(name) {
    var bare = name.replace(/\s*\([^)]*\)\s*$/, '');
    var ms = D.models || [];
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].name.replace(/\s*\([^)]*\)\s*$/, '') === bare && ms[i].p) return ms[i];
    }
    return null;
  }
  function renderGoRank() {
    var h = state.tpHit;
    var plans = D.plans || [];
    var rows = [];
    var seen = {};
    for (var i = 0; i < plans.length; i++) {
      var p = plans[i];
      var eff = 0.95 * (h * p.pc + (1 - h) * p.pin) + 0.05 * p.pout; // 元/1M tokens
      rows.push({ plan: p.plan, name: p.name, pin: p.pin, pout: p.pout, pc: p.pc, eff: eff });
      // 官价作为独立条目（每个模型只列一次），与套餐条目同公式、同排序
      var om = officialModelOf(p.name);
      if (om && !seen[om.name]) {
        seen[om.name] = 1;
        rows.push({ plan: '官方 API 牌价', name: om.name, pin: om.p[0], pout: om.p[1], pc: om.p[2],
                    eff: 0.95 * (h * om.p[2] + (1 - h) * om.p[0]) + 0.05 * om.p[1], official: true });
      }
    }
    rows.sort(function (a, b) { return a.eff - b.eff; });
    var html = '';
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      html += '<div class="plan-item' + (r.official ? ' plan-official' : '') + '">' +
        '<div class="plan-name">' + r.plan + ' · ' + r.name + '</div>' +
        '<div class="plan-sub">输入 ' + priceStr(r.pin) + ' · 输出 ' + priceStr(r.pout) +
        ' · 缓存 ' + priceStr(r.pc) + ' · 折算单价 <span class="plan-eff">' + num(r.eff, 3) + ' 元/M</span></div>' +
        '</div>';
    }
    $('gorank-list').innerHTML = html;
    $('gorank-note').textContent = '各订阅计划折算后的单价，按折算 token 单价升序（单价 = 0.95×(命中×缓存读 + (1−命中)×输入) + 0.05×输出，输入占比 95%、命中率用上方滑块调）。OpenCode Go：折后 = 表列价 × 10/额度，DeepSeek 按非高峰档；智谱 Coding Plan v2：实测周额度按 Lite 的 5×（Pro）/20×（Max）放大（GLM-5.3 50M/周、Flash 125M/周，高峰约 1/3，额度不分输入输出缓存）÷ 月费；v3（Lite ¥118/Pro ¥538/Max ¥1078 每月）：按官方积分系数折算（GLM-5.3 6.9/1.7/24、Flash 2.3/0.56/8，非高峰 5 折），积分额度按 Lite 的 5×/20×。百度千帆 Token Plan 个人版（Mini ¥9.9/Lite ¥40/Pro ¥200/Max ¥600 每月，月额度 1000万/4200万/2.3亿/7亿 tokens）：Token制不区分输入/输出/缓存→三价相等，额度多模型共享、按模型单列；夜间闲时（每日21:00–次日8:00）指定模型（DS-V4-Pro preview、DS-V4-Flash-0731（核心）、GLM-5.2；DS-V4-Flash 预览版 9-29 下线不计）按 2 折扣 token 另列夜间条目；deepseek-v4-pro-0813 按 1.8× 抵扣（条目已按 1.8 计）。GLM-5.1 与 kimi-k2.6（9-29 下线）不列。积分制官方未公开系数表，不纳入。火山方舟 Agent Plan（Small ¥40/Medium ¥200/Large ¥500/Max ¥1000 每月，月额度 2万/10万/25万/50万 AFP，四档每 AFP 单价同为 0.002 元→折算价与档位无关，按模型单列）：AFP=(输入×系数+输出×系数)/10000，折算价=系数×0.2 元/M；v4-flash=0731、v4-pro=0813 均为正式版；套餐内无缓存折扣项→缓存按输入同价；GLM-5.3-Flash 限时系数 0.25（至 9-11）未计入；Auto 模式限时（至 11-08）系数 0.5 路由 Kimi-K3，另列条目；豆包 seed 系列与 kimi-k2.7-code 榜单未跟踪不列。SenseAudio Token Plan（商汤旗下，Pro ¥199/224万、Max ¥699/1120万、Ultra ¥1899/4480万 积分每月，三档档位差价→每档每模型单列）：积分池制、1 元=5,000 积分，套餐内文本积分消耗=API 牌价×5000（超额现金同锚 1:5000，音频/同传积分价均=元价×5000）→ 折算价=牌价×面值折扣率（Pro 4.4折/Max 3.1折/Ultra 2.1折）；平台文本无缓存价→缓存按输入同价；GLM-5.2 按平台阶梯 <32K/≥32K 两档单列；Lite ¥36/Plus ¥99 文本面值不打折（约 1.8×/1.4×牌价）不列；自研 S2/S1 系列与 M2.7/K2.6/豆包 榜单未跟踪或已下线不列。腾讯 TokenHub Token Plan 个人版（通用线 Lite ¥39/780积分、Standard ¥99/1980、Pro ¥299/5980、Max ¥599/11980；Hy 线 ¥28/560、¥78/1560、¥238/4760、¥468/9360——两线四档元/积分同为 0.05 元，折算价=积分价×0.05）：两种抵扣算法并存——8-31 前上架模型（旧逻辑）三类 token 同价、积分价随档位（通用组 22.285/19.8/18.687/18.43，Hy 组 16/15.6/14.875/14.4，DS-V4-Flash/Pro 与 Hy3 按档单列）；8-31 后上架模型（新逻辑）输入/输出/缓存三分价、档位无关（GLM-5.3-Flash 16/56/4.6、GLM-5.3 160/560/40、Kimi-K3 400/2000/40、MiniMax-M3 ≤512K 42/168/8.4，折算恰为各原厂牌价）；限时优惠单列：GLM-5.3 85折、Kimi-K3 95折、MiniMax-M3 5折、Hy3-hy3-202608 5折（均至 9-30），GLM-5.3-Flash 5折（9-10 止）未列；通用 Max 刊例表印 8.43 疑为 18.43 笔误（预估表 11980÷18.43=65,000 万 tokens 精确吻合），按 18.43 计；MiniMax-M3 >512K 档与 Auto(tc-code-latest)、M2.7、GLM-5/5.1/5.2、Hy4 preview 榜单未跟踪不列。官方 API 牌价作为独立条目列入同一排序（每个模型只列一次），与套餐条目同公式，便于直接对比。';
  }

  // ---------- Tab 切换 ----------
  var PAGE_RENDERER = {
    curve: function () { renderCurve(); },
    compare: function () { renderCompare(); },
    calib: function () { renderCalib(); },
    calibcmp: function () { renderCalibCmp(); }
  };
  function initTabs() {
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        var all = document.querySelectorAll('#tabs .tab');
        for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
        this.classList.add('active');
        var page = this.getAttribute('data-page');
        var pages = document.querySelectorAll('.page');
        for (var k = 0; k < pages.length; k++) pages[k].classList.remove('active');
        $('page-' + page).classList.add('active');
        // 图表页切回时重绘（隐藏期间 clientWidth=0 会跳过绘制，避免旧位图被拉伸）
        if (PAGE_RENDERER[page]) PAGE_RENDERER[page]();
        window.scrollTo(0, 0);
      });
    }
  }

  // ---------- 启动 ----------
  function init() {
    initTabs();
    // flex gap 行为检测（增强层，基线用 margin）
    try {
      var flex = document.createElement('div');
      flex.style.position = 'absolute';
      flex.style.visibility = 'hidden';
      flex.style.display = 'flex';
      flex.style.flexDirection = 'column';
      flex.style.rowGap = '1px';
      flex.appendChild(document.createElement('div'));
      flex.appendChild(document.createElement('div'));
      document.body.appendChild(flex);
      if (flex.scrollHeight === 1) document.documentElement.classList.add('supports-flex-gap');
      document.body.removeChild(flex);
    } catch (e) { /* 基线 margin 已可用 */ }

    // 先初始化各页（填充模型下拉、渲染默认视图），再绑设置——
    // 设置变更回调会触发全页重算，若在填充前触发会读到空下拉导致崩溃
    initCurve(); initCompare(); initRank277(); initCalib();
    initCalibCmp(); initRank300(); initGoRank();
    bindSettings(function () {
      renderCurve(); renderCompare(); renderRank277(); renderCalib();
      renderCalibCmp(); renderRank300(); renderGoRank();
    });
    // 旋转/改窗口尺寸时重绘图表（防抖）
    var rsTimer = null;
    window.addEventListener('resize', function () {
      if (rsTimer) clearTimeout(rsTimer);
      rsTimer = setTimeout(function () {
        renderCurve(); renderCompare(); renderCalib(); renderCalibCmp();
      }, 200);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
