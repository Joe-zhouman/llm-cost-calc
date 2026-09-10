/* 极简 Canvas 2D 折线图（Chrome 61 基线，无外部依赖）
 * Charts.line(canvas, cfg)
 * cfg = {
 *   series: [{ name, color, points: [{x, y}] }],   // points 按 x 升序
 *   xLabel, marker: {x, label} | null,
 *   xFmt(v), yFmt(v)
 * }
 * 同一 canvas 重复调用即重绘；十字线 tooltip 自动挂在 canvas 父节点的 .chart-tip 上。
 */
(function () {
  'use strict';

  var PAD = { l: 52, r: 12, t: 14, b: 28 };

  function niceMax(v) {
    if (v <= 0) return 1;
    var exp = Math.floor(Math.log(v) / Math.LN10);
    var base = Math.pow(10, exp);
    var f = v / base;
    var nf;
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 2.5) nf = 2.5;
    else if (f <= 5) nf = 5;
    else nf = 10;
    return nf * base;
  }

  function fmtAxis(v) {
    if (v === 0) return '0';
    if (v >= 1000) {
      var s = (v / 1000).toFixed(1);
      if (s.slice(-2) === '.0') s = s.slice(0, -2);
      return s + 'k';
    }
    if (v >= 100) return String(Math.round(v));
    if (v >= 10) return String(Math.round(v * 10) / 10);
    if (v >= 1) return String(Math.round(v * 10) / 10);
    return String(Math.round(v * 100) / 100);
  }

  function drawFrame(canvas, cfg, crossX) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var cssW = canvas.clientWidth || 0;
    var cssH = canvas.clientHeight || 0;
    if (!cssW || !cssH) return; // 页面隐藏时 clientWidth 为 0，留着旧位图，切回时由 tab 切换重绘
    // 窄屏收紧左边距，给数据区留空间
    var padL = cssW < 420 ? 38 : PAD.l;
    var PADL = padL;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var series = cfg.series;
    var xmax = 0, ymax = 0, i, s, p;
    for (i = 0; i < series.length; i++) {
      s = series[i];
      for (var j = 0; j < s.points.length; j++) {
        p = s.points[j];
        if (p.x > xmax) xmax = p.x;
        if (p.y > ymax) ymax = p.y;
      }
    }
    if (cfg.marker && cfg.marker.x > xmax) xmax = cfg.marker.x;
    xmax = xmax || 1;
    ymax = niceMax(ymax * 1.05) || 1;

    var plotW = cssW - PADL - PAD.r;
    var plotH = cssH - PAD.t - PAD.b;
    if (plotW <= 10 || plotH <= 10) { cfg.__xmax = xmax; cfg.__ymax = ymax; return; }
    function px(x) { return PADL + (x / xmax) * plotW; }
    function py(y) { return PAD.t + plotH - (y / ymax) * plotH; }

    // 网格与 y 轴刻度
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#9aa3ad';
    ctx.strokeStyle = '#eef0f3';
    ctx.lineWidth = 1;
    var yTicks = 4;
    for (i = 0; i <= yTicks; i++) {
      var yv = ymax * i / yTicks;
      var yy = py(yv);
      ctx.beginPath();
      ctx.moveTo(PADL, yy);
      ctx.lineTo(cssW - PAD.r, yy);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtAxis(yv), PADL - 4, yy);
    }
    // x 轴刻度
    var xTicks = 4;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (i = 0; i <= xTicks; i++) {
      var xv = xmax * i / xTicks;
      ctx.fillText(cfg.xFmt ? cfg.xFmt(xv) : fmtAxis(xv), px(xv), PAD.t + plotH + 6);
    }

    // 272K（Codex 默认窗口）/ 关键点标记
    if (cfg.marker) {
      var mx = px(cfg.marker.x);
      ctx.save();
      ctx.strokeStyle = '#c44e52';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(mx, PAD.t);
      ctx.lineTo(mx, PAD.t + plotH);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#c44e52';
      ctx.textAlign = mx > cssW - 70 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(cfg.marker.label || '', mx + (mx > cssW - 70 ? -4 : 4), PAD.t + 2);
    }

    // 数据线
    for (i = 0; i < series.length; i++) {
      s = series[i];
      if (!s.points.length) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (var k = 0; k < s.points.length; k++) {
        var pt = s.points[k];
        if (k === 0) ctx.moveTo(px(pt.x), py(pt.y));
        else ctx.lineTo(px(pt.x), py(pt.y));
      }
      ctx.stroke();
    }

    // 十字线
    if (crossX !== null && crossX !== undefined && crossX >= 0 && crossX <= xmax) {
      var cx2 = px(crossX);
      ctx.save();
      ctx.strokeStyle = '#9aa3ad';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx2, PAD.t);
      ctx.lineTo(cx2, PAD.t + plotH);
      ctx.stroke();
      ctx.restore();
    }

    // 图例（窄屏截断长名）
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    var lx = cssW - PAD.r;
    for (i = series.length - 1; i >= 0; i--) {
      s = series[i];
      if (!s.points.length) continue;
      var nm = s.name.length > (cssW < 420 ? 10 : 16) ? s.name.slice(0, cssW < 420 ? 9 : 15) + '…' : s.name;
      ctx.fillStyle = s.color;
      ctx.fillRect(lx - 58, PAD.t + 2 + i * 14, 8, 3);
      ctx.fillStyle = '#40495a';
      ctx.fillText(nm, lx - 2, PAD.t - 2 + i * 14);
    }
    canvas.__padL = PADL;
    cfg.__xmax = xmax;
    cfg.__ymax = ymax;
  }

  function line(canvas, cfg) {
    canvas.__cfg = cfg;
    drawFrame(canvas, cfg, null);

    var tip = canvas.parentNode.querySelector('.chart-tip');
    if (!tip) return;

    function onMove(ev) {
      var cfgNow = canvas.__cfg;
      if (!cfgNow) return;
      var rect = canvas.getBoundingClientRect();
      var cx = (ev.clientX - rect.left);
      var cssW = canvas.clientWidth;
      var padL = canvas.__padL || PAD.l;
      var xMax = cfgNow.__xmax || 1;
      var dataX = Math.max(0, Math.min(1, (cx - padL) / (cssW - padL - PAD.r))) * xMax;
      var rows = '';
      for (var i = 0; i < cfgNow.series.length; i++) {
        var s = cfgNow.series[i];
        if (!s.points.length) continue;
        var best = s.points[0];
        for (var j = 1; j < s.points.length; j++) {
          if (Math.abs(s.points[j].x - dataX) < Math.abs(best.x - dataX)) best = s.points[j];
        }
        rows += '<span class="tip-row"><span style="color:' + s.color + '">■</span> ' +
          s.name + ': ' + (cfgNow.yFmt ? cfgNow.yFmt(best.y) : fmtAxis(best.y)) + '</span>';
      }
      tip.innerHTML = '<div class="tip-x">' + (cfgNow.xFmt ? cfgNow.xFmt(dataX) : fmtAxis(dataX)) + ' ' + (cfgNow.xLabel || '') + '</div>' + rows;
      tip.classList.remove('hidden');
      var tipX = cx + 12;
      if (tipX + 140 > cssW) tipX = cx - 150;
      if (tipX < 0) tipX = 0;
      tip.style.left = tipX + 'px';
      tip.style.top = '8px';
      drawFrame(canvas, cfgNow, dataX);
    }
    function onLeave() {
      tip.classList.add('hidden');
      if (canvas.__cfg) drawFrame(canvas, canvas.__cfg, null);
    }
    // 先移除旧监听（存引用），再挂新的
    if (canvas.__handlers) {
      canvas.removeEventListener('pointermove', canvas.__handlers.m);
      canvas.removeEventListener('pointerdown', canvas.__handlers.m);
      canvas.removeEventListener('pointerleave', canvas.__handlers.l);
      canvas.removeEventListener('pointerup', canvas.__handlers.l);
    }
    canvas.__handlers = { m: onMove, l: onLeave };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerup', onLeave);
  }

  window.Charts = { line: line, fmtAxis: fmtAxis };
})();
