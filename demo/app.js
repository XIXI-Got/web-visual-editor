/* 演示页脚本：两个 canvas —— 一个模拟 three.js 场景，一个数据图表。
   同时演示「页面如何配合编辑器改尺寸」：注册 __VE_HOOKS__.resizeCanvas 即可让渲染真正适配。 */

const scene = document.getElementById("scene");
const chart = document.getElementById("chart");

const state = { sceneW: 640, sceneH: 400, chartW: 900, chartH: 260 };

/* ---------- 模拟 three.js：一个透视投影的旋转线框立方体 ---------- */
function drawScene() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = state.sceneW;
  const h = state.sceneH;
  if (scene.width !== Math.round(w * dpr) || scene.height !== Math.round(h * dpr)) {
    scene.width = Math.round(w * dpr);
    scene.height = Math.round(h * dpr);
    scene.style.height = h + "px";
  }
  const ctx = scene.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(w, h) * 0.28;
  const t = performance.now() / 1600;

  const verts = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ].map(([x, y, z]) => {
    const ca = Math.cos(t), sa = Math.sin(t);
    const x1 = x * ca - z * sa;
    const z1 = x * sa + z * ca;
    const cb = Math.cos(t * 0.7), sb = Math.sin(t * 0.7);
    const y1 = y * cb - z1 * sb;
    const z2 = y * sb + z1 * cb;
    const p = 2.6 / (2.6 + z2);
    return [cx + x1 * scale * p, cy + y1 * scale * p];
  });

  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1.4;
  for (const [a, b] of edges) {
    ctx.beginPath();
    ctx.moveTo(verts[a][0], verts[a][1]);
    ctx.lineTo(verts[b][0], verts[b][1]);
    ctx.stroke();
  }
  ctx.fillStyle = "#2f5cff";
  for (const [x, y] of verts) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#999";
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillText(`three.js 模拟 · ${Math.round(w)}×${Math.round(h)}`, 12, h - 12);
}

/* ---------- 数据图表 ---------- */
const DATA = [42, 68, 54, 88, 72, 96, 61, 79];
function drawChart() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = state.chartW;
  const h = state.chartH;
  if (chart.width !== Math.round(w * dpr) || chart.height !== Math.round(h * dpr)) {
    chart.width = Math.round(w * dpr);
    chart.height = Math.round(h * dpr);
    chart.style.height = h + "px";
  }
  const ctx = chart.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  const pad = 26;
  const gap = 12;
  const bw = (w - pad * 2 - gap * (DATA.length - 1)) / DATA.length;
  const max = 110;
  ctx.strokeStyle = "#eee";
  for (let i = 0; i <= 4; i++) {
    const y = pad + ((h - pad * 2) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  DATA.forEach((v, i) => {
    const bh = ((h - pad * 2) * v) / max;
    const x = pad + i * (bw + gap);
    ctx.fillStyle = i === 5 ? "#2f5cff" : "#111";
    ctx.fillRect(x, h - pad - bh, bw, bh);
  });
}

/* ---------- 关键：给编辑器提供尺寸适配钩子 ---------- */
window.__hookCalls = window.__hookCalls || 0;
window.__VE_HOOKS__ = {
  resizeCanvas(canvas, width, height) {
    window.__hookCalls += 1;
    if (canvas === scene) {
      state.sceneW = Math.round(width);
      state.sceneH = Math.round(height);
      drawScene();
      return true;
    }
    if (canvas === chart) {
      state.chartW = Math.round(width);
      state.chartH = Math.round(height);
      drawChart();
      return true;
    }
    return false;
  },
};

function loop() {
  drawScene();
  requestAnimationFrame(loop);
}

state.chartW = Math.round(chart.getBoundingClientRect().width) || 900;
state.sceneW = Math.round((scene.getBoundingClientRect().width || 640));
state.sceneH = Math.round((scene.getBoundingClientRect().height || 400));
drawChart();
loop();
