/**
 * 视觉编辑器 · 浏览器端内核
 *
 * 设计要点
 * - 全部 UI 放在 Shadow DOM 里：页面 CSS 进不来，编辑器样式也不污染页面。
 * - 变更先落「待保存层」(pending)，点保存才写盘；写盘前服务端自动备份。
 * - 所有能力可撤销：每个 key 保存 before 快照。
 * - 不执行任何来自 AI 的脚本，AI 只能产出白名单操作。
 */

import {
  createHistory, snapMove, elementKey, keyToSelector, buildSelector, styleToCss,
  aspectSize, px, pxStr, round, clamp, GRID_PRESETS, fmt,
  parseGradSpec, gradSpec, gradCss, gradId, gradVector, gradStops, gradColorAt,
} from "./core.mjs";

const BOOT = (typeof window !== "undefined" && window.__VE_BOOT__) || {};
const TOKEN = BOOT.token || "";
const API = "/__ve";

/* 收集运行时错误，便于排查（也让自动化诊断能读到） */
const ERRORS = (window.__VE_ERRORS__ = window.__VE_ERRORS__ || []);
window.addEventListener("error", (e) => ERRORS.push(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => ERRORS.push(`unhandled: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

/* ────────────────────────────── 状态 ────────────────────────────── */

const S = {
  draftDirty: false,
  appliedText: "",
  lockMargin: false,
  lockPadding: false,
  lockRadius: true,
  removedKeys: new Set(),
  on: false,
  preview: false,
  embedded: false,
  marquee: false,
  marqueeItems: [],
  flashOn: false,
  pickStack: [],
  pickIndex: 0,
  pickStackPos: "",
  linkEl: null,
  blockKey: "",
  blockEl: null,
  hover: null,
  selected: null,
  editing: null,
  overrides: {},
  pending: {},
  orig: {},
  panelTab: "text",
  origText: "",
  history: createHistory(200),
  grid: { on: true, size: 8, objects: true },
  drag: null,
  toastAt: 0,
  aiOps: null,
  aiBusy: false,
  hooks: (typeof window !== "undefined" && window.__VE_HOOKS__) || null,
  autoSave: true,
  pickMode: "deepest",
  group: null,
  autoSaving: false,
  saving: false,
  lastAutoSaveAt: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/* ────────────────────────────── 样式 ────────────────────────────── */

const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.ve-ui{position:fixed;inset:0;pointer-events:none;font-size:12px;line-height:1.5;color:#111}
.ve-ui>*{pointer-events:auto}
/* 纯预览：把编辑器的所有浮层都藏掉，只留一个退出按钮；页面本身照常交互 */
.ve-ui.ve-preview>*:not(.ve-exit):not(.ve-stage){display:none!important}
.ve-exit{all:unset;position:fixed;right:16px;bottom:16px;z-index:70;display:none;cursor:pointer;pointer-events:auto;background:rgba(17,17,17,.88);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:8px 16px;font:12px/1 system-ui,sans-serif;letter-spacing:.04em;box-shadow:0 10px 30px rgba(0,0,0,.38);opacity:.75;transition:opacity .25s}
.ve-exit:hover{opacity:1}
.ve-ui.ve-preview .ve-exit{display:block}
.ve-ui.ve-preview .ve-stage{pointer-events:none!important}
.ve-ui.ve-preview .ve-stage .ve-ins{pointer-events:none!important;outline:0 dashed transparent!important}
.ve-ui.ve-preview .ve-stage .ve-ins[data-sel="1"]{outline:0 dashed transparent!important}
.ve-ui.ve-preview .ve-stage .ve-ins::before{display:none!important}
.ve-ui.ve-pure-hard .ve-exit{display:none!important}
.ve-pagenav-ui{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:4px;padding:4px;border-radius:999px;background:rgba(255,255,255,.88);backdrop-filter:blur(12px) saturate(1.25);-webkit-backdrop-filter:blur(12px) saturate(1.25);border:1px solid rgba(0,0,0,.10);box-shadow:0 10px 26px rgba(0,0,0,.16),inset 0 1px 0 rgba(255,255,255,.65);font:600 13px/1.4 Inter,system-ui,sans-serif;color:#333;max-width:calc(100vw - 40px)}
.ve-pagenav-ui button.ve-pagenav-toggle{width:30px;height:30px;flex:0 0 auto;border-radius:999px;border:0;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.14);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;color:#111;font-size:10px;line-height:1;margin:0;transition:transform .18s cubic-bezier(.22,1,.36,1),box-shadow .18s}
.ve-pagenav-ui button.ve-pagenav-toggle:hover{transform:scale(1.06);box-shadow:0 4px 14px rgba(0,0,0,.2)}
.ve-pagenav-ui button.ve-pagenav-toggle:active{transform:scale(.95)}
.ve-pagenav-ui .ve-pagenav-links{display:none;align-items:center;gap:2px;white-space:nowrap;overflow-x:auto;overflow-y:hidden;max-width:min(70vw,760px);scrollbar-width:none}
.ve-pagenav-ui .ve-pagenav-links::-webkit-scrollbar{display:none}
.ve-pagenav-ui[data-open="1"] .ve-pagenav-links{display:inline-flex}
.ve-pagenav-ui .ve-pagenav-links a{display:inline-flex;align-items:center;padding:6px 11px;border-radius:999px;text-decoration:none;color:inherit;font:600 13px/1.4 Inter,system-ui,sans-serif;opacity:.66;border:1px solid transparent;white-space:nowrap;transition:opacity .16s,background .16s}
.ve-pagenav-ui .ve-pagenav-links a:hover{opacity:.95;background:rgba(127,127,127,.16)}
.ve-pagenav-ui .ve-pagenav-links a[data-current="1"]{opacity:.95;border-color:rgba(127,127,127,.45);background:rgba(127,127,127,.10)}
.ve-pagenav-ui .ve-pagenav-empty{display:inline-flex;align-items:center;padding:6px 10px;font:500 12px/1.4 Inter,system-ui,sans-serif;opacity:.5;white-space:nowrap}
.ve-ui.ve-pure .ve-pagenav-ui{display:none!important}
.ve-ui.tb-top .ve-tb{top:14px;bottom:auto}
.ve-tb{left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:5px;background:#fff;border:1px solid #111;box-shadow:0 8px 24px rgba(0,0,0,.18);border-radius:8px;position:fixed;z-index:20}
.ve-tb button{all:unset;cursor:pointer;padding:6px 9px;border-radius:5px;font-size:12px;font-weight:600;color:#222;white-space:nowrap}
.ve-tb button:hover{background:#f0f0f0}
.ve-tb button[data-active="1"]{background:#111;color:#fff}
.ve-tb .sep{width:1px;height:18px;background:#ddd;margin:0 3px}
.ve-tb .save{background:#111;color:#fff}
.ve-tb .save:hover{background:#000}
.ve-tb .save[data-dirty="1"]{background:#2f5cff}
.ve-badge{display:inline-block;min-width:16px;padding:0 4px;margin-left:4px;border-radius:8px;background:#2f5cff;color:#fff;font-size:10px;line-height:16px;text-align:center}
.ve-panel{position:fixed;right:14px;top:14px;width:min(320px, calc(100vw - 28px));box-sizing:border-box;max-height:calc(100vh - 28px);overflow-x:hidden;overflow-y:auto;background:#fff;border:1px solid #111;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.22);z-index:60;transition:left .16s ease,right .16s ease}
.ve-panel[hidden]{display:none}
.ve-ph{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-bottom:1px solid #111;gap:8px}
.ve-ph b{font-size:12px}
.ve-ver{flex:0 0 auto;font:10px/1 ui-monospace,Menlo,Consolas,monospace;color:#9aa3b2;background:#f1f3f7;border:1px solid #e3e7ee;border-radius:99px;padding:2px 5px;white-space:nowrap;cursor:pointer;user-select:none}
.ve-ver:hover{background:#e8ecf4;color:#5b6472}
.ve-ph code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;max-width:150px}
.ve-close{all:unset;cursor:pointer;padding:2px 6px;font-size:14px;color:#888}
.ve-align{display:flex;gap:4px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid #f0f2f5;background:#fbfcff}
.ve-align button{all:unset;cursor:pointer;border:1px solid #dfe3ea;border-radius:5px;padding:2px 7px;font-size:11px;color:#333;background:#fff}
.ve-align button:hover{background:#eef2ff;border-color:#c7d2fe}
.ve-tabs{display:flex;border-bottom:1px solid #e6e6e6}
.ve-tabs button{all:unset;flex:1;text-align:center;padding:7px 0;cursor:pointer;font-size:12px;color:#666}
.ve-tabs button[data-on="1"]{color:#111;font-weight:700;box-shadow:inset 0 -2px 0 #111}
.ve-crumb{display:flex;flex-wrap:wrap;gap:3px;padding:5px 9px;border-bottom:1px solid #eef1f6;background:#fafbfd;font:10.5px/1.2 ui-monospace,Menlo,Consolas,monospace}
.ve-crumb button{all:unset;cursor:pointer;padding:2px 5px;border-radius:5px;color:#475569;border:1px solid transparent}
.ve-crumb button:hover{background:#eef2ff;border-color:#c7d2fe;color:#1e3a8a}
.ve-crumb button[data-on="1"]{background:#111;color:#fff}
.ve-body{padding:11px}
.ve-row{display:flex;align-items:center;gap:6px;margin:6px 0}
.ve-row>label{flex:0 0 62px;color:#666;font-size:11.5px}
.ve-row input[type=text],.ve-row input[type=number],.ve-row select,.ve-row textarea{flex:1;min-width:0;border:1px solid #ddd;border-radius:5px;padding:4px 6px;font-size:12px;background:#fafafa;color:#111;outline:none}
.ve-row input:focus,.ve-row select:focus,.ve-row textarea:focus{border-color:#111;background:#fff}
.ve-row textarea{min-height:64px;resize:vertical;font-family:inherit;line-height:1.5}
.ve-2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ve-chip{display:flex;gap:4px;flex-wrap:wrap}
.ve-chip button{all:unset;cursor:pointer;border:1px solid #ddd;border-radius:5px;padding:3px 7px;font-size:11px;color:#333}
.ve-chip button[data-on="1"]{background:#111;color:#fff;border-color:#111}
.ve-btn{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;text-align:center;border:1px solid #111;border-radius:6px;padding:7px;font-size:12px;font-weight:600;margin-top:7px;color:#111}
.ve-btn:hover{background:#111;color:#fff}
.ve-btn.primary{background:#111;color:#fff}
.ve-btn.primary:hover{background:#000}
.ve-btn.danger{border-color:#c0392b;color:#c0392b}
.ve-btn.danger:hover{background:#c0392b;color:#fff}
.ve-hint{margin:8px 0 0;color:#888;font-size:11px;line-height:1.5;word-break:break-word}
.ve-modal .ve-row{margin:6px 0}
.ve-modal .ve-q4{display:flex;gap:4px;align-items:center}
.ve-modal .ve-q4 input{flex:1;min-width:0;border:1px solid #ddd;border-radius:5px;padding:4px 5px;font-size:12px;background:#fafafa;outline:none}
.ve-pf{position:sticky;bottom:0;display:flex;gap:5px;padding:8px 9px;border-top:1px solid rgba(17,17,17,.10);background:#fbfcfe !important;z-index:3;border-radius:0 0 12px 12px}
.ve-pf .ve-btn{flex:1 1 0;min-width:0;margin-top:0;font-size:11px;padding:7px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box}
.ve-suffix{color:#999;font-size:11px;flex:0 0 auto}
/* —— 渐变编辑器：拉条 + 节点 + 透明度 + 角度圆盘 —— */
.ve-gradbar{position:relative;height:22px;margin:9px 4px 16px;border-radius:6px;border:1px solid #d9dde5;cursor:crosshair;
  background-image:linear-gradient(45deg,#eceff4 25%,transparent 25%),linear-gradient(-45deg,#eceff4 25%,transparent 25%),
    linear-gradient(45deg,transparent 75%,#eceff4 75%),linear-gradient(-45deg,transparent 75%,#eceff4 75%);
  background-size:10px 10px;background-position:0 0,0 5px,5px -5px,-5px 0}
.ve-gradbar .ve-gradfill{position:absolute;inset:0;border-radius:5px;pointer-events:none}
.ve-graddot{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;padding:0;border-radius:50%;border:2px solid #fff;
  box-shadow:0 0 0 1px rgba(17,17,17,.35),0 1px 3px rgba(0,0,0,.35);cursor:grab;touch-action:none;z-index:1}
.ve-graddot[data-on="1"]{box-shadow:0 0 0 2px #2f5cff,0 1px 4px rgba(0,0,0,.4);z-index:2}
.ve-graddot[data-del="1"]{box-shadow:0 0 0 2px #e11d48,0 0 14px rgba(225,29,72,.7);border-color:#fff;z-index:3}
.ve-graddot[data-del="1"]::after{content:"✕";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:9px;font-weight:700;line-height:1;color:#fff;border-radius:50%;background:rgba(225,29,72,.72);pointer-events:none}
.ve-grad-swatch{flex:0 0 34px;height:26px;padding:0;border:1px solid #ddd;border-radius:5px;background:none}
.ve-grad-hex{flex:1;min-width:0;border:1px solid #ddd;border-radius:5px;padding:4px 6px;font-size:12px;background:#fafafa;color:#111;outline:none}
.ve-grad-num{flex:0 0 50px;border:1px solid #ddd;border-radius:5px;padding:4px 4px;font-size:12px;background:#fafafa;color:#111;text-align:center;outline:none}
.ve-mini{all:unset;cursor:pointer;border:1px solid #ddd;border-radius:5px;padding:4px 7px;font-size:11px;color:#333;background:#fff;flex:0 0 auto}
.ve-mini:hover{background:#f3f4f6}
.ve-mini:disabled{opacity:.4;cursor:default}
.ve-row input[type=range]{flex:1;min-width:0;accent-color:#111}
.ve-dial{position:relative;width:40px;height:40px;border-radius:50%;border:1px solid #d9dde5;flex:0 0 auto;margin:2px 2px 2px 0;
  background:radial-gradient(circle at 50% 50%,#fff 0 42%,#eef1f6 43% 100%);touch-action:none;cursor:grab}
.ve-dial::after{content:"";position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border-radius:50%;background:#9aa3b2}
.ve-dial-needle{position:absolute;left:50%;top:50%;width:2px;height:15px;margin:-15px 0 0 -1px;border-radius:2px;background:#2f5cff;
  transform-origin:50% 100%;pointer-events:none}
.ve-quad{display:flex;gap:4px;align-items:center;flex:1;min-width:0}
.ve-quad input{flex:1;min-width:0;width:100%;border:1px solid #ddd;border-radius:5px;padding:4px 5px;font-size:12px;background:#fafafa;color:#111;outline:none}
.ve-quad input:focus{border-color:#111;background:#fff}
.ve-lock{border:1px solid #ddd;background:#fff;border-radius:5px;cursor:pointer;font-size:11px;line-height:1;padding:4px 6px;flex:0 0 auto}
.ve-lock[data-on="1"]{background:#111;color:#fff;border-color:#111}
#lockBtn[data-on="1"]{background:#111!important;color:#fff!important;border-color:#111!important}
.ve-quick button.ins{color:#0a7a4e;border-color:#bfe3d0}
.ve-force-select ::selection,.ve-force-select *::selection{background:#2f5cff!important;color:#fff!important}
.ve-force-select textarea::selection,.ve-force-select input::selection{background:#2f5cff!important;color:#fff!important}
.ve-force-select{user-select:text!important;-webkit-user-select:text!important}
.ve-force-select input,.ve-force-select textarea{user-select:text!important;-webkit-user-select:text!important}
.ve-layers{max-height:240px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px;margin:0 0 8px;background:#fff}
.ve-layer{display:flex;align-items:center;gap:4px;padding:3px 6px;font:11px/1.5 Consolas,monospace;color:#334155;cursor:pointer;white-space:nowrap;overflow:hidden}
.ve-layer:hover{background:#eef2ff}
.ve-layer[data-sel="1"]{background:#dbeafe;color:#1d4ed8;font-weight:600}
.ve-layer .lt{color:#93a3b8}
.ve-layer .lh{margin-left:auto;border:0;background:none;cursor:pointer;color:#94a3b8;padding:0 3px}
.ve-layer .lh:hover{color:#b91c1c}
.ve-left{position:fixed;left:14px;top:50%;transform:translateY(-50%);z-index:12;display:flex;flex-direction:column;gap:5px;transition:transform .26s cubic-bezier(.22,1,.36,1),opacity .26s cubic-bezier(.22,1,.36,1);
  background:rgba(255,255,255,.97);border:1px solid #e5e7eb;border-radius:12px;padding:8px;width:126px;
  box-shadow:0 12px 34px rgba(15,23,42,.18);font:12px/1.2 Inter,system-ui,sans-serif}
.ve-left h4{margin:2px 0 5px;font-size:10.5px;color:#8a93a6;font-weight:600;letter-spacing:.05em}
.ve-left[data-closed="1"]{transform:translateY(-50%) translateX(calc(-100% - 24px));opacity:0;pointer-events:none}
.ve-dockclose{position:absolute;right:6px;top:5px;width:20px;height:20px;padding:0;justify-content:center;border:1px solid #e5e7eb;border-radius:6px;background:#fff;color:#94a3b8;font-size:13px;line-height:1;cursor:pointer}
.ve-dockclose:hover{background:#fef2f2;border-color:#fecaca;color:#dc2626}
.ve-left button{display:flex;align-items:center;height:29px;border:1px solid #e5e7eb;background:#fff;border-radius:8px;font-size:12px;color:#333;cursor:pointer;padding:0 8px;text-align:left}
.ve-left button:hover{background:#f3f4f6;border-color:#c9cfdb}
.ve-left .sep{height:1px;background:#eef0f4;margin:3px 0}
.ve-outline{position:fixed;border:1px solid #2f5cff;pointer-events:none;z-index:5;display:none;will-change:transform,width,height}
.ve-outline .ve-lbl{position:absolute;left:-1px;top:-19px;background:#2f5cff;color:#fff;font-size:10px;padding:1px 5px;border-radius:3px 3px 0 0;white-space:nowrap;font-family:ui-monospace,monospace}
.ve-hover{position:fixed;border:1px dashed #2f5cff;background:rgba(47,92,255,.06);pointer-events:none;z-index:4;display:none}
.ve-handle{position:absolute;width:9px;height:9px;background:#fff;border:1.5px solid #2f5cff;border-radius:2px;pointer-events:auto;z-index:6}
.ve-handle[data-dir=nw]{left:-5px;top:-5px;cursor:nwse-resize}
.ve-handle[data-dir=n]{left:50%;top:-5px;margin-left:-5px;cursor:ns-resize}
.ve-handle[data-dir=ne]{right:-5px;top:-5px;cursor:nesw-resize}
.ve-handle[data-dir=e]{right:-5px;top:50%;margin-top:-5px;cursor:ew-resize}
.ve-handle[data-dir=se]{right:-5px;bottom:-5px;cursor:nwse-resize}
.ve-handle[data-dir=s]{left:50%;bottom:-5px;margin-left:-5px;cursor:ns-resize}
.ve-handle[data-dir=sw]{left:-5px;bottom:-5px;cursor:nesw-resize}
.ve-handle[data-dir=w]{left:-5px;top:50%;margin-top:-5px;cursor:ew-resize}
.ve-guide{position:fixed;background:#ff3b8d;pointer-events:none;z-index:7;display:none}
.ve-guide[data-kind="centerX"],.ve-guide[data-kind="centerY"]{background:#22c55e}
.ve-guide[data-axis=x]{width:1px;top:0;bottom:0}
.ve-guide[data-axis=y]{height:1px;left:0;right:0}
.ve-marquee{position:fixed;display:none;border:1.5px solid #2f5cff;background:rgba(47,92,255,.10);z-index:8;pointer-events:none;box-shadow:0 0 0 9999px rgba(15,23,42,.18)}
.ve-embed-hint{position:fixed;left:50%;top:14px;transform:translateX(-50%);background:#111;color:#fff;padding:6px 14px;border-radius:999px;font-size:12px;z-index:45;display:none;pointer-events:none}
.ve-embed .ve-tb,.ve-embed .ve-off{display:none!important}
.ve-flash{position:fixed;display:none;pointer-events:none;z-index:9;border:2px solid #ff3b8d;box-shadow:0 0 0 2px rgba(255,59,141,.35);animation:veBlink .5s ease-in-out 0s 7 alternate}
@keyframes veBlink{from{opacity:1}to{opacity:.15}}
.ve-quick{display:flex;gap:4px;flex-wrap:wrap;padding:6px 11px;border-bottom:1px solid #f0f2f5;background:#fbfcff}
.ve-quick button{all:unset;cursor:pointer;border:1px solid #dfe3ea;border-radius:5px;padding:2px 7px;font-size:11px;color:#333;background:#fff}
.ve-quick button:hover{background:#eef2ff;border-color:#b9c5f2}
.ve-quick button[data-on="1"]{background:#111;color:#fff;border-color:#111}
.ve-info{padding:5px 11px;font-size:10.5px;color:#7a8397;border-bottom:1px solid #f5f6f9;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ve-linkrow{display:flex;align-items:center;gap:6px;margin:6px 0}
.ve-linkrow label{flex:0 0 62px;color:#666;font-size:11.5px}
.ve-linkrow input{flex:1;min-width:0;border:1px solid #ddd;border-radius:5px;padding:4px 6px;font-size:12px;background:#fafafa;color:#111;outline:none}
.ve-linkrow input:focus{border-color:#111;background:#fff}
.ve-grid{position:fixed;inset:0;pointer-events:none;z-index:1;display:none;opacity:.42}
.ve-pageguides{position:fixed;inset:0;pointer-events:none;z-index:6;display:none}
.ve-pageguides[data-on="1"]{display:block}
.ve-pageguides i{position:absolute;background:#ff3b8d;opacity:.9}
.ve-pageguides i.x{top:0;bottom:0;width:1px}
.ve-pageguides i.y{left:0;right:0;height:1px}
.ve-pageguides b{position:absolute;background:#ff3b8d;color:#fff;font:10px/1.4 ui-monospace,monospace;padding:1px 4px;border-radius:3px;transform:translate(-50%,-50%)}
.ve-guidebtn{position:fixed;right:14px;bottom:70px;z-index:65;border:1px solid #111;background:#fff;color:#111;border-radius:999px;padding:6px 12px;font:600 11.5px/1.2 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.12)}
.ve-guidebtn:hover{background:#111;color:#fff}
.ve-quick-rot{display:flex;align-items:center;gap:4px;padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:11px;color:#333;background:#fff}
.ve-quick-rot label{display:flex;align-items:center;gap:3px;flex:1}
.ve-quick-rot input{width:52px;border:1px solid #dfe3ea;border-radius:5px;padding:3px 4px;font-size:11px}
.ve-quick-rot button{all:unset;cursor:pointer;border:1px solid #dfe3ea;border-radius:5px;padding:2px 6px;font-size:11px;background:#fff}
.ve-quick-rot button:hover{background:#eef2ff}
.ve-stools{position:fixed;left:14px;top:64px;z-index:66;display:flex;align-items:center;gap:4px;padding:5px;background:#fff;border:1px solid #111;border-radius:10px;box-shadow:0 10px 26px rgba(0,0,0,.14);font:12px/1.2 Inter,system-ui,sans-serif}
.ve-stools[hidden]{display:none}
.ve-stools button{all:unset;cursor:pointer;padding:5px 8px;border-radius:6px;color:#111;font-size:12px;white-space:nowrap}
.ve-stools button:hover{background:#eef2ff}
.ve-stools button[data-on="1"]{background:#111;color:#fff}
.ve-stools .sep2{width:1px;height:18px;background:#e5e7eb;margin:0 3px}
.ve-smenu{position:absolute;left:0;top:38px;min-width:150px;background:#fff;border:1px solid #111;border-radius:8px;box-shadow:0 14px 30px rgba(0,0,0,.16);padding:6px}
.ve-smenu[hidden]{display:none}
.ve-smenu label{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:5px;cursor:pointer;font-size:12px;color:#111}
.ve-smenu label:hover{background:#f3f6ff}
.ve-ui.ve-dark .ve-tb,.ve-ui.ve-dark .ve-panel,.ve-ui.ve-dark .ve-guidebox,.ve-ui.ve-dark .ve-stools{background:#151922;color:#e8ecf5;border-color:#3a4356}
.ve-ui.ve-dark .ve-tb button,.ve-ui.ve-dark .ve-panel,.ve-ui.ve-dark .ve-panel label,.ve-ui.ve-dark .ve-guidebox{color:#e8ecf5}
.ve-ui.ve-dark .ve-tb button:hover,.ve-ui.ve-dark .ve-stools button:hover{background:#263041}
.ve-ui.ve-dark .ve-stools button,.ve-ui.ve-dark .ve-smenu label{color:#e8ecf5}
.ve-ui.ve-dark .ve-smenu{background:#151922;border-color:#3a4356}
.ve-ui.ve-dark .ve-panel input,.ve-ui.ve-dark .ve-panel select,.ve-ui.ve-dark .ve-panel textarea{background:#0f131a;color:#e8ecf5;border-color:#3a4356}
.ve-guidebox{position:fixed;right:14px;top:64px;z-index:70;width:250px;background:#fff;border:1px solid #111;border-radius:10px;box-shadow:0 18px 44px rgba(0,0,0,.18);font:12px/1.5 Inter,system-ui,sans-serif;color:#111;padding:10px}
.ve-guidebox[hidden]{display:none}
.ve-gb-head{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:8px}
.ve-gb-head button{all:unset;cursor:pointer;padding:0 4px;font-size:16px;line-height:1}
.ve-gb-row{display:flex;gap:8px;align-items:center;margin:5px 0}
.ve-gb-row label{flex:1;display:flex;align-items:center;gap:4px;font-size:11px;color:#555}
.ve-gb-row input[type=number]{width:58px;border:1px solid #dfe3ea;border-radius:5px;padding:3px 4px;font-size:11px}
.ve-gb-chk{display:flex;align-items:center;gap:6px;font-size:11px;color:#333;margin:6px 0}
.ve-gb-foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:10px;color:#999}
.ve-gb-foot button{all:unset;cursor:pointer;color:#2f5cff;font-size:11px}
.ve-toast{position:fixed;left:50%;top:64px;transform:translateX(-50%);background:#111;color:#fff;padding:7px 14px;border-radius:20px;font-size:12px;z-index:40;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}
.ve-toast[data-show="1"]{opacity:1}
.ve-stage{position:fixed;inset:0;pointer-events:none;z-index:3}
.ve-stage .ve-ins{position:absolute;pointer-events:auto;touch-action:none;outline:0 dashed transparent;user-select:none;-webkit-user-select:none}
.ve-stage .ve-ins[data-sel="1"]{outline:1px solid #2f5cff}
/* 细长组件（如竖分割线）加一圈透明热区，鼠标差几个像素也能抓住，不会误点到背后整页 canvas */
.ve-stage .ve-ins[data-thin="1"]::before{content:"";position:absolute;inset:-9px;border-radius:8px}
.ve-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:460px;max-width:calc(100vw - 30px);background:#fff;border:1px solid #111;border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.3);z-index:50}
.ve-modal[hidden]{display:none}
.ve-mh{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #111}
.ve-mh b{font-size:13px}
.ve-mb{padding:12px}
.ve-ai-list{margin:9px 0 0;max-height:200px;overflow:auto;border:1px solid #eee;border-radius:6px;padding:7px 9px;font-size:11.5px;color:#333;background:#fafafa}
.ve-ai-list div{padding:2px 0;border-bottom:1px dashed #eee}
.ve-ai-list div:last-child{border:0}
.ve-ai-list .t{color:#2f5cff;font-weight:600}
.ve-off{position:fixed;right:16px;bottom:16px;z-index:60;border:1px solid #111;background:#fff;border-radius:22px;padding:8px 14px;cursor:pointer;font-size:12px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.16)}
.ve-off:hover{background:#111;color:#fff}
[hidden]{display:none!important}
`;

/* ────────────────────────────── UI 骨架 ────────────────────────────── */

const VE_VERSION = "1.1.0";
// 纯预览窗口（?ve_pure=1）：脚本一执行就要藏编辑器，避免刷新/录屏时闪一下界面
const PURE_BOOT = (() => {
  try { return new URLSearchParams(location.search).get("ve_pure") === "1"; } catch { return false; }
})();

const host = document.createElement("div");
host.id = "__ve_host";
host.setAttribute("data-ve-host", "");
host.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none;";
host.style.userSelect = "text";
host.style.webkitUserSelect = "text";
document.documentElement.appendChild(host);
const shadow = host.attachShadow({ mode: "open" });
shadow.innerHTML = `
<style>${CSS}</style>
<div class="ve-ui" id="ui">
  <div class="ve-grid" id="grid"></div>
  <div class="ve-stage" id="stage"></div>
  <div class="ve-hover" id="hover"><span class="ve-lbl"></span></div>
  <div class="ve-outline" id="outline">
    <span class="ve-lbl"></span>
    <i class="ve-handle" data-dir="nw"></i><i class="ve-handle" data-dir="n"></i><i class="ve-handle" data-dir="ne"></i>
    <i class="ve-handle" data-dir="e"></i><i class="ve-handle" data-dir="se"></i><i class="ve-handle" data-dir="s"></i>
    <i class="ve-handle" data-dir="sw"></i><i class="ve-handle" data-dir="w"></i>
  </div>
  <div class="ve-guide" id="guideX" data-axis="x"></div>
  <div class="ve-guide" id="guideY" data-axis="y"></div>
  <div class="ve-marquee" id="marquee"></div>
  <div class="ve-flash" id="flash"></div>
  <div class="ve-pageguides" id="pageGuides"></div>
  <div class="ve-stools" id="stools" hidden>
    <button data-sact="align-left" title="左对齐">⇤</button>
    <button data-sact="align-centerX" title="水平居中">↔</button>
    <button data-sact="align-right" title="右对齐">⇥</button>
    <span class="sep2"></span>
    <button data-sact="theme" id="stTheme">暗色</button>
    <button data-sact="fixate" title="应用改动到源码（相对样式，不覆盖原 CSS 文件）">应用</button>
    <button data-sact="styles" title="套用已保存风格">风格</button>
    <button data-sact="more" id="stMore">☰</button>
    <div class="ve-smenu" id="smenu" hidden>
      <label><input type="checkbox" id="stAuto"> 自动保存</label>
      <label><input type="checkbox" id="stGrid"> 网格吸附</label>
      <label><input type="checkbox" id="stObjects"> 吸附元素/中线</label>
    </div>
  </div>
  <button type="button" class="ve-guidebtn" id="guideBtn" title="页边距 / 版面参考线（可吸附）">参考线</button>
  <div class="ve-guidebox" id="guideBox" hidden>
    <div class="ve-gb-head"><b>页边距 / 参考线</b><button data-gact="close" title="关闭">×</button></div>
    <div class="ve-gb-row"><label>上 <input type="number" id="gTop" min="0" step="1"></label><label>下 <input type="number" id="gBottom" min="0" step="1"></label></div>
    <div class="ve-gb-row"><label>左 <input type="number" id="gLeft" min="0" step="1"></label><label>右 <input type="number" id="gRight" min="0" step="1"></label></div>
    <label class="ve-gb-chk"><input type="checkbox" id="gCenterX"> 垂直中心线</label>
    <label class="ve-gb-chk"><input type="checkbox" id="gCenterY"> 水平中心线</label>
    <div class="ve-gb-foot"><span>拖动元素时自动吸附</span><button data-gact="off">关闭参考线</button></div>
  </div>

  <div class="ve-pagenav-ui" id="vePagenav" hidden>
    <button type="button" class="ve-pagenav-toggle" id="vePagenavToggle" aria-label="展开/收起页面导航">▶</button>
    <span class="ve-pagenav-links" id="vePagenavLinks"></span>
  </div>
  <div class="ve-tb" id="tb" hidden>
    <button data-act="select" data-active="1" title="点选元素（V）">选择</button>
    <button data-act="text" title="编辑文字（T）">文字</button>
    <span class="sep"></span>
    <button data-act="undo" title="撤销 Ctrl+Z">↶</button>
    <button data-act="redo" title="重做 Ctrl+Shift+Z">↷</button>
    <span class="sep"></span>
    <button data-act="grid" data-active="1" title="网格吸附">网格</button>
    <select id="gridSize" title="网格密度" style="all:unset;cursor:pointer;border:1px solid #ddd;border-radius:5px;padding:4px 4px;font-size:11.5px"></select>
    <select id="vpSize" title="多视口预览" style="all:unset;cursor:pointer;border:1px solid #ddd;border-radius:5px;padding:4px 5px;font-size:11.5px"><option value="0">自适应</option><option value="360">360</option><option value="768">768</option><option value="1280">1280</option><option value="1920">1920</option></select>
    <button data-act="objects" data-active="1" title="吸附到元素边缘与中线">对齐</button>
    <button data-act="guides" title="页边距 / 版面参考线（可吸附）">参考线</button>
    <button data-act="pick-mode" data-active="0" title="当前是「元素优先」（点哪选哪，最小元素）；点一下切成容器优先。Shift+点击可选父级容器">元素优先</button>
    <span class="sep"></span>
    <button data-act="ai" title="AI 改稿">AI</button>
    <button data-act="newwin" title="网页预览：在新窗口打开整个网页（可 F11 全屏）">⛶ 网页预览</button>
    <button data-act="pure" title="纯预览窗口：新开一个干净窗口（没有任何编辑器界面，刷新后仍是纯预览，适合录屏）">纯预览窗口</button>
    <button data-act="preview" title="预览（隐藏编辑器）">预览</button>
    <button data-act="save" class="save" title="保存 Ctrl+S">保存<span class="ve-badge" id="dirty" hidden>0</span></button>
  </div>

  <div class="ve-left" id="leftDock">
    <button class="ve-dockclose" data-act="dock-close" title="收起组件栏（也可点左边缘小标签）">×</button>
    <h4>添加内容</h4>
    <button data-act="ld-text" title="插入一段文字">＋ 文字</button>
    <button data-act="ld-image" title="上传/插入图片">＋ 图片</button>
    <button data-act="ld-svg" title="插入 SVG">＋ SVG</button>
    <button data-act="ld-three" title="插入一块 Three.js 3D 画布">＋ Three.js</button>
    <div class="sep"></div>
    <h4>常用组件</h4>
    <button data-act="ld-nav" title="插入一排导航栏">导航栏</button>
    <button data-act="ld-button" title="插入一个按钮">按钮</button>
    <button data-act="ld-card" title="插入一张卡片">卡片</button>
    <button data-act="ld-divider" title="插入分割线">分割线</button>
    <button data-act="ld-pagelink" title="插入一个跳转到其它页面的链接">页面链接</button>
    <div class="sep"></div>
    <h4>图层</h4>
    <div class="ve-layers" id="layerTree"></div>
    <button data-act="layer-refresh" title="刷新图层树">刷新图层</button>
    <button data-act="export-code" title="导出当前选中元素的 HTML + CSS">导出选区代码</button>
  </div>

  <div class="ve-panel ve-force-select" id="panel" hidden>
    <div class="ve-ph">
      <b id="elTag">元素</b>
      <span class="ve-ver" id="veVer" role="button" title="编辑器内核版本；点一下刷新预览内核"></span>
      <code id="elPath"></code>
      <button class="ve-close" data-act="deselect" title="取消选择 Esc">✕</button>
    </div>
    <div class="ve-info" id="elInfo"></div>
    <div class="ve-quick" id="quick">
      <button data-act="quick-hide" title="隐藏 / 显示这个元素">👁 隐藏</button>
      <button data-act="pick-parent" title="选中父级">↑ 父级</button>
      <button data-act="quick-flash" title="闪烁开关：开着时选中元素会闪几下">✦ 闪烁</button>
      
      <button data-act="pick-up" title="Shift+点击也能切换：选中更上层的元素">⌃ 上层</button>
      <button data-act="pick-down" title="选中更深一层的元素">⌄ 下层</button>
      <button data-act="edit-block" title="把整段文字当成一段来改（会合并逐词动画）">整段文字</button>
      <button data-act="resp-center" title="响应式水平居中：写 left:50% + translateX(-50%)，换窗口仍居中">⇔ 响应式居中</button>
      <button data-act="parent-fill" title="把父容器设为占满整行并居中，再让当前元素相对页面居中">⇔ 父级占满行</button>
      <button data-act="lock-containers" id="locksBtn" title="锁定容器宽度/位置，防止拖出固定 px；高度仍可调">🔒 容器锁</button>
      <div class="ve-quick-rot">
        <label>旋转 <input type="number" id="qRotate" step="1" placeholder="0"><span>°</span></label>
        <button data-qrot="-15" title="逆时针 15°">↺</button>
        <button data-qrot="15" title="顺时针 15°">↻</button>
        <button data-qrot="0" title="取消旋转（立正）">立正</button>
      </div>
      <button data-act="delete-el" title="删除这个元素（Del 快捷键），可用「重置这个元素」恢复">🗑 删除</button>
    </div>
    <div class="ve-crumb" id="crumb"></div>
    <div class="ve-tabs" id="tabs">
      <button data-tab="text" data-on="1">文字</button>
      <button data-tab="image">图片</button>
      <button data-tab="style">外观</button>
      <button data-tab="size">布局</button>
      <button data-tab="ov" hidden>组件</button>
    </div>
    <div class="ve-body">
      <div data-pane="text">
        <div class="ve-row" id="tRunRow" hidden><label>文字段</label><select id="tRunSelect" title="容器里有多段文字时，选要改的那一段"></select></div>
        <div class="ve-row"><label>内容</label><textarea id="tContent"></textarea></div>
        <div class="ve-row"><label>字号</label><input type="number" id="tSize" step="1"><span style="color:#999;font-size:11px">px</span>
          <label style="flex:0 0 auto;margin-left:6px">字重</label><select id="tWeight" style="flex:0 0 70px"></select></div>
        <div class="ve-row"><label>行高</label><input type="number" id="tLine" step="1"><span class="ve-suffix">px</span>
          <label style="flex:0 0 auto;margin-left:6px">字距</label><input type="number" id="tSpacing" step="0.5"><span class="ve-suffix">px</span></div>
        <div class="ve-row" id="tColorModeRow"><label>颜色</label><div class="ve-chip" id="tColorMode">
          <button type="button" data-mode="solid">单色</button><button type="button" data-mode="grad">渐变</button>
        </div></div>
        <div class="ve-row" id="tSolidRow"><label></label><input type="color" id="tColor" style="flex:0 0 36px;height:26px;padding:0;border:1px solid #ddd;border-radius:5px;background:none">
          <input type="text" id="tColorHex" placeholder="#111111"></div>
        <div id="tGradBox" hidden>
          <div class="ve-gradbar" id="tGradBar" title="点拉条中间加节点；拖动圆点调位置；把圆点向上/下拖出拉条可直接删除"><div class="ve-gradfill" id="tGradFill"></div></div>
          <div class="ve-row"><label id="tStopLabel">节点 1/2</label><input type="color" class="ve-grad-swatch" id="tStopColor"><input type="text" class="ve-grad-hex" id="tStopHex"><button type="button" class="ve-mini" id="tStopDel" title="删除这个节点">删</button></div>
          <div class="ve-row"><label>透明度</label><input type="range" id="tStopAlpha" min="0" max="100" step="1"><input type="number" class="ve-grad-num" id="tStopAlphaNum" min="0" max="100" step="1"><span class="ve-suffix">%</span></div>
          <div class="ve-row"><label>角度</label><div class="ve-dial" id="tGradDial" title="拖动圆盘调渐变角度"><span class="ve-dial-needle" id="tGradNeedle"></span></div><input type="number" class="ve-grad-num" id="tGradAngle" min="0" max="360" step="1"><span class="ve-suffix">°</span></div>
        </div>
        <div class="ve-row"><label>对齐</label><div class="ve-chip" id="tAlign">
          <button data-align="left">左</button><button data-align="center">中</button><button data-align="right">右</button><button data-align="justify">两端</button>
        </div></div>
        <p class="ve-hint" id="tTextHint" hidden></p>
        <div class="ve-row"><label>字体</label><select id="tFamily">
          <option value="">继承</option>
          <option value="Inter, ui-sans-serif, system-ui, sans-serif">Inter</option>
          <option value="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif">系统无衬线</option>
          <option value="'Microsoft YaHei', 'PingFang SC', sans-serif">微软雅黑</option>
          <option value="'Songti SC', SimSun, serif">宋体</option>
          <option value="'Kaiti SC', KaiTi, serif">楷体</option>
          <option value="Georgia, 'Times New Roman', serif">Georgia</option>
          <option value="ui-monospace, Menlo, Consolas, monospace">等宽字体</option>
        </select></div>
        <div class="ve-linkrow" id="linkRow" hidden><label>跳转</label><input type="text" id="tHref" placeholder="https://… 或 #锚点 或 /路径（编辑模式下不会跳转）"></div>

                <div class="ve-row" style="margin-top:10px"><span style="font-size:11px;color:#94a3b8;letter-spacing:.04em">文字效果（选中文字时）</span></div>
        <div class="ve-row"><label><input type="checkbox" id="tStrokeOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">文字描边</label><input type="color" id="tStrokeColor" style="flex:0 0 36px;height:26px;padding:0;border:1px solid #ddd;border-radius:5px;background:none"><input type="number" id="tStrokeWidth" placeholder="px" style="flex:0 0 62px"><span class="ve-suffix">px</span></div>
        <div class="ve-row"><label><input type="checkbox" id="tShadowOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">文字投影</label><input type="number" id="tShadowY" placeholder="Y" style="flex:0 0 52px"><input type="number" id="tShadowBlur" placeholder="模糊" style="flex:0 0 62px"><input type="number" id="tShadowAlpha" step="0.05" min="0" max="1" placeholder="透明度" style="flex:0 0 70px"></div>
        <div class="ve-row"><label><input type="checkbox" id="tGlassOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">文字毛玻璃</label><input type="range" id="tGlassBlur" min="0" max="40" step="1"><input type="number" id="tGlassBlurNum" min="0" max="40" step="1" style="flex:0 0 62px"><span class="ve-suffix">px</span></div>
      </div>

      <div data-pane="image" hidden>
        <div class="ve-row" id="iColorModeRow" hidden><label>颜色</label><div class="ve-chip" id="iColorMode">
          <button type="button" data-mode="solid">单色</button><button type="button" data-mode="grad">渐变</button><button type="button" data-mode="bg">背景</button>
        </div></div>
        <div class="ve-row" id="iColorRow" hidden><label></label><input type="text" id="iColor" placeholder="#E2DBC8 / inherit"></div>
        <div id="iBgBox" hidden>
          <div class="ve-row"><label>背景色</label><input type="color" class="ve-grad-swatch" id="iBgColor"><input type="text" class="ve-grad-hex" id="iBgHex" placeholder="#232428"></div>
          <div class="ve-row"><label>不透明度</label><input type="range" id="iBgAlpha" min="0" max="100" step="1"><input type="number" class="ve-grad-num" id="iBgAlphaNum" min="0" max="100" step="1"><span class="ve-suffix">%</span></div>
          <div class="ve-row"><label>毛玻璃</label><div class="ve-chip" id="iBgBlur">
            <button type="button" data-blur="0">关</button><button type="button" data-blur="12">12</button><button type="button" data-blur="18">18</button><button type="button" data-blur="28">28</button>
          </div></div>
          <p class="ve-hint">直接改选中元素自己的背景色（容器也能改，不会跑到内部图标上）</p>
        </div>
        <div id="iGradBox" hidden>
          <div class="ve-gradbar" id="iGradBar" title="点拉条中间加节点；拖动圆点调位置；把圆点向上/下拖出拉条可直接删除"><div class="ve-gradfill" id="iGradFill"></div></div>
          <div class="ve-row"><label id="iStopLabel">节点 1/2</label><input type="color" class="ve-grad-swatch" id="iStopColor"><input type="text" class="ve-grad-hex" id="iStopHex"><button type="button" class="ve-mini" id="iStopDel" title="删除这个节点">删</button></div>
          <div class="ve-row"><label>透明度</label><input type="range" id="iStopAlpha" min="0" max="100" step="1"><input type="number" class="ve-grad-num" id="iStopAlphaNum" min="0" max="100" step="1"><span class="ve-suffix">%</span></div>
          <div class="ve-row"><label>角度</label><div class="ve-dial" id="iGradDial" title="拖动圆盘调渐变角度"><span class="ve-dial-needle" id="iGradNeedle"></span></div><input type="number" class="ve-grad-num" id="iGradAngle" min="0" max="360" step="1"><span class="ve-suffix">°</span></div>
        </div>
        <div class="ve-row"><label>地址</label><input type="text" id="iSrc" placeholder="/图片路径 或 https://"></div>
        <div class="ve-row"><label>说明</label><input type="text" id="iAlt" placeholder="alt 文本"></div>
        <div class="ve-row"><label>填充</label><div class="ve-chip" id="iFit">
          <button data-fit="fill">拉伸</button><button data-fit="cover">裁剪</button><button data-fit="contain">完整</button>
        </div></div>
        <div class="ve-row"><label>亮度</label><input type="range" id="iBright" min="0" max="2" step="0.05" value="1"><input type="number" id="iBrightNum" min="0" max="2" step="0.05" style="flex:0 0 60px"></div>
        <div class="ve-row"><label>对比度</label><input type="range" id="iContrast" min="0" max="2" step="0.05" value="1"><input type="number" id="iContrastNum" min="0" max="2" step="0.05" style="flex:0 0 60px"></div>
        <div class="ve-row"><label>饱和度</label><input type="range" id="iSat" min="0" max="2" step="0.05" value="1"><input type="number" id="iSatNum" min="0" max="2" step="0.05" style="flex:0 0 60px"></div>
        <div class="ve-row"><label>模糊</label><input type="range" id="iBlur" min="0" max="20" step="1" value="0"><input type="number" id="iBlurNum" min="0" max="20" step="1" style="flex:0 0 60px"></div>
        <div class="ve-row"><label>裁剪 %</label><input type="number" id="iCropT" placeholder="上" style="flex:1 1 0"><input type="number" id="iCropR" placeholder="右" style="flex:1 1 0"><input type="number" id="iCropB" placeholder="下" style="flex:1 1 0"><input type="number" id="iCropL" placeholder="左" style="flex:1 1 0"></div>
        <button class="ve-btn" data-act="replace-image">选一张图替换</button>
        <button class="ve-btn" data-act="paste-svg">粘贴 SVG 源码替换</button>
        <button class="ve-btn" data-act="insert-image">插入新图片</button>
        <p class="ve-hint" id="iHint"></p>
      </div>

        <div data-pane="ov" hidden></div>
      <div data-pane="size" hidden>
        <div class="ve-row"><label>宽</label><input type="number" id="sW"><label style="flex:0 0 auto">高</label><input type="number" id="sH">
          <button class="ve-chip" style="all:unset;cursor:pointer;border:1px solid #ddd;border-radius:5px;padding:3px 6px;font-size:11px" data-act="lock" id="lockBtn" title="等比锁定">🔗</button></div>
        <div class="ve-row"><label>X</label><input type="number" id="sX"><label style="flex:0 0 auto">Y</label><input type="number" id="sY"></div>
        <div class="ve-row"><label>层级</label><input type="number" id="sZ"></div>
        <p class="ve-hint" id="sizeHint"></p>
        <div class="ve-row" style="margin:10px 0 2px"><span style="font-size:11px;color:#94a3b8;letter-spacing:.04em">布局</span></div>
        <div class="ve-row"><label>外边距</label>
          <div class="ve-quad"><input type="number" id="bMarginT" placeholder="上"><input type="number" id="bMarginR" placeholder="右"><input type="number" id="bMarginB" placeholder="下"><input type="number" id="bMarginL" placeholder="左"></div>
          <span class="ve-suffix">px</span><button class="ve-lock" id="bMarginLock" title="锁链：同时修改四个边距">🔗</button></div>
        <div class="ve-row"><label>内边距</label>
          <div class="ve-quad"><input type="number" id="bPaddingT" placeholder="上"><input type="number" id="bPaddingR" placeholder="右"><input type="number" id="bPaddingB" placeholder="下"><input type="number" id="bPaddingL" placeholder="左"></div>
          <span class="ve-suffix">px</span><button class="ve-lock" id="bPaddingLock" title="锁链：同时修改四个内边距">🔗</button></div>
        <div class="ve-row"><label>圆角</label>
          <div class="ve-quad"><input type="number" id="bRadiusTL" placeholder="左上"><input type="number" id="bRadiusTR" placeholder="右上"><input type="number" id="bRadiusBR" placeholder="右下"><input type="number" id="bRadiusBL" placeholder="左下"></div>
          <span class="ve-suffix">px</span><button class="ve-lock" id="bRadiusLock" title="锁链：同时修改四个圆角（默认已锁）">🔗</button></div>
        <div class="ve-row"><label>透明度</label><input type="text" id="bOpacity" placeholder="1"></div>
        <div class="ve-row"><label>显示</label><select id="bDisplay"><option value="">继承</option><option value="block">block</option><option value="flex">flex</option><option value="inline-block">inline-block</option><option value="none">none</option></select></div>
        <div class="ve-row"><label>旋转</label><input type="number" id="bRotate" step="1" placeholder="0"><span class="ve-suffix">°</span>
          <button class="ve-mini" data-rot-step="-15" title="逆时针 15°">↺</button>
          <button class="ve-mini" data-rot-step="15" title="顺时针 15°">↻</button>
          <button class="ve-mini" data-rot-step="0" title="取消旋转">0°</button></div>
        <div class="ve-row"><label>变换</label><input type="text" id="bTransform" placeholder="rotate(2deg)"></div>
      </div>

      <div data-pane="style" hidden>
        <p class="ve-hint" style="margin:2px 0 8px">这三项默认关：勾选开关即可新增；元素原本有的话会自动检测并打开。</p>
        <div class="ve-row"><label><input type="checkbox" id="aBorderOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">描边</label><input type="color" id="aBorderColor" style="flex:0 0 36px;height:26px;padding:0;border:1px solid #ddd;border-radius:5px;background:none"><input type="number" id="aBorderWidth" placeholder="px" style="flex:0 0 62px"><span class="ve-suffix">px</span></div>
        <div class="ve-row"><label><input type="checkbox" id="aBlurOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">毛玻璃</label><input type="range" id="aBackBlur" min="0" max="40" step="1"><input type="number" id="aBackBlurNum" min="0" max="40" step="1" style="flex:0 0 62px"><span class="ve-suffix">px</span></div>
        <div class="ve-row"><label>透明度</label><input type="range" id="aOpacity" min="0" max="1" step="0.01"><input type="number" id="aOpacityNum" min="0" max="1" step="0.01" style="flex:0 0 66px"><span class="ve-suffix"></span></div>
        <div class="ve-row"><label><input type="checkbox" id="aShadowOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">投影</label><input type="number" id="aShadowY" placeholder="Y" style="flex:0 0 52px"><input type="number" id="aShadowBlur" placeholder="模糊" style="flex:0 0 62px"><input type="number" id="aShadowAlpha" step="0.05" min="0" max="1" placeholder="透明度" style="flex:0 0 70px"></div>
<p class="ve-hint">原来用 outline / inset 阴影画的白色描边，勾选后改成可调的 border；关掉恢复原样。</p>
      </div>

    </div>
    <div class="ve-pf">
      <button class="ve-btn pri" data-act="draft-save" title="应用这次文字修改（回车）">保存</button>
      
      
      <button class="ve-btn" data-act="draft-cancel" title="不保存这次文字修改">取消</button>
      
    </div>
  </div>

  <div class="ve-modal" id="exportModal" hidden>
    <div class="ve-mh"><b>导出选区代码</b><button class="ve-close" data-act="export-close">×</button></div>
    <div class="ve-mb">
      <p class="ve-hint">HTML + CSS，可直接复制到项目里。</p>
      <textarea id="exportText" readonly style="width:100%;height:320px;font:11px/1.5 Consolas,monospace;border:1px solid #ddd;border-radius:6px;padding:8px"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="ve-btn pri" data-act="export-copy">复制</button>
        <button class="ve-btn" data-act="export-download">下载 HTML</button>
      </div>
    </div>
  </div>
  <div class="ve-modal" id="ovPanel" hidden>
    <div class="ve-mh"><b>插入的元素</b><button class="ve-close" data-act="ov-close">✕</button></div>
    <div class="ve-mb">
      <div class="ve-row"><label>X / Y</label>
        <div class="ve-q4"><input type="number" id="ovX"><input type="number" id="ovY"></div></div>
      <div class="ve-row" id="ovWHRow"><label>宽 / 高</label>
        <div class="ve-q4"><input type="number" id="ovW"><input type="number" id="ovH"></div></div>
      <div class="ve-row" id="ovZRow"><label>层级</label><input type="number" id="ovZ"></div>
      <div class="ve-row" id="ovPinRow"><label>定位</label><div class="ve-chip" id="ovPin">
        <button type="button" data-pin="auto">跟随周围</button><button type="button" data-pin="page">随页面滚动</button><button type="button" data-pin="screen">固定在屏幕</button>
      </div></div>
      <div class="ve-row" id="ovItemsRow" hidden><label>导航项</label><input id="ovItems" placeholder="首页,案例,工艺,流程,联系"></div>
      <div class="ve-row" id="ovBtnRow" hidden><label>按钮文字</label><input id="ovBtnText"></div>
      <div class="ve-row" id="ovCardRow" hidden><label>卡片标题</label><input id="ovCardTitle"></div>
      <div class="ve-row" id="ovCardDescRow" hidden><label>卡片描述</label><textarea id="ovCardDesc" style="min-height:50px"></textarea></div>
      <div class="ve-row" id="ovDivRow" hidden><label>分割线</label><div class="ve-chip" id="ovDivDir">
        <button type="button" data-divdir="h">横线</button><button type="button" data-divdir="v">竖线</button>
      </div></div>
      <div class="ve-row" id="dColorModeRow" hidden><label>填色</label><div class="ve-chip" id="dColorMode">
        <button type="button" data-mode="solid">单色</button><button type="button" data-mode="grad">渐变</button>
      </div></div>
      <div id="dGradBox" hidden>
        <div class="ve-gradbar" id="dGradBar" title="点拉条中间加节点；拖动圆点调位置；把圆点向上/下拖出拉条可直接删除"><div class="ve-gradfill" id="dGradFill"></div></div>
        <div class="ve-row"><label id="dStopLabel">节点 1/2</label><input type="color" class="ve-grad-swatch" id="dStopColor"><input type="text" class="ve-grad-hex" id="dStopHex"><button type="button" class="ve-mini" id="dStopDel" title="删除这个节点">删</button></div>
        <div class="ve-row"><label>透明度</label><input type="range" id="dStopAlpha" min="0" max="100" step="1"><input type="number" class="ve-grad-num" id="dStopAlphaNum" min="0" max="100" step="1"><span class="ve-suffix">%</span></div>
        <div class="ve-row"><label>角度</label><div class="ve-dial" id="dGradDial" title="拖动圆盘调渐变角度"><span class="ve-dial-needle" id="dGradNeedle"></span></div><input type="number" class="ve-grad-num" id="dGradAngle" min="0" max="360" step="1"><span class="ve-suffix">°</span></div>
      </div>
      <div class="ve-row" id="ovDivLenRow" hidden><label>长度</label><input type="number" id="ovDivLen" placeholder="px"><label style="flex:0 0 auto">粗细</label><input type="number" id="ovDivThick" placeholder="px"><span class="ve-suffix">px</span></div>
      <div class="ve-row" id="ovDivColorRow" hidden><label>线条色</label><input type="color" id="ovDivColor" style="flex:0 0 36px;height:26px;padding:0;border:1px solid #ddd;border-radius:5px;background:none"><input type="text" id="ovDivColorHex" placeholder="#E2DBC8"></div>
      <div class="ve-row" id="ovPadRow"><label>内边距</label><input type="number" id="ovPad" placeholder="px"></div>
      <div class="ve-row" id="ovRadiusRow"><label>圆角</label><input type="number" id="ovRadius" placeholder="px"></div>
      <div class="ve-row" id="ovBgRow"><label>背景</label><input id="ovBg" placeholder="#rrggbb 或 rgba()"></div>
      <div class="ve-row" id="ovColorRow"><label>文字色</label><input id="ovColorText" placeholder="#E2DBC8"></div>
      <div class="ve-row"><label>透明度</label><input type="number" id="ovOpacity" step="0.05" min="0" max="1"></div>
      <div class="ve-row"><label>旋转</label><input type="number" id="ovRotate" step="1" placeholder="0"><span class="ve-suffix">°</span>
        <button class="ve-mini" data-ovrot="-15" title="逆时针 15°">↺</button>
        <button class="ve-mini" data-ovrot="15" title="顺时针 15°">↻</button>
        <button class="ve-mini" data-ovrot="0" title="取消旋转">0°</button></div>
      <div class="ve-row" id="ovBorderRow"><label><input type="checkbox" id="ovBorderOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">描边</label><input type="color" id="ovBorderColor" style="flex:0 0 36px;height:26px;padding:0;border:1px solid #ddd;border-radius:5px;background:none"><input type="number" id="ovBorderWidth" placeholder="px" style="flex:0 0 62px"><span class="ve-suffix">px</span></div>
      <div class="ve-row" id="ovBackBlurRow"><label><input type="checkbox" id="ovBlurOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">毛玻璃</label><input type="range" id="ovBackBlur" min="0" max="40" step="1"><input type="number" id="ovBackBlurNum" min="0" max="40" step="1" style="flex:0 0 62px"><span class="ve-suffix">px</span></div>
      <div class="ve-row" id="ovShadowRow"><label><input type="checkbox" id="ovShadowOn" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px">投影</label><input type="number" id="ovShadowY" placeholder="Y" style="flex:0 0 52px"><input type="number" id="ovShadowBlur" placeholder="模糊" style="flex:0 0 62px"><input type="number" id="ovShadowAlpha" step="0.05" min="0" max="1" placeholder="透明度" style="flex:0 0 70px"></div>
      <div class="ve-row" id="ovTextRow" hidden><label>文字</label><textarea id="ovText" placeholder="插入的文字"></textarea></div>
      <div class="ve-row" id="ovSvgRow" hidden><label>SVG</label><textarea id="ovSvg" placeholder="<svg …>"></textarea></div>
      <button class="ve-btn" id="ovReplaceBtn" data-act="ov-replace-image">换成另一张图</button>
      <button class="ve-btn danger" data-act="ov-delete">删除这个元素</button>
      <p class="ve-hint" id="ovHint">拖动可以直接移动；改完记得点上方「保存」写回源码</p>
    </div>
  </div>

  <div class="ve-modal" id="delModal" hidden>
    <div class="ve-mh"><b>删除这个元素？</b><button class="ve-close" data-act="del-cancel">✕</button></div>
    <div class="ve-mb">
      <p class="ve-hint" style="color:#b45309">删除后这个元素在页面上不再显示；「重置这个元素」或 Ctrl+Z 可以恢复，保存后写回源码。</p>
      <div style="display:grid;gap:6px;margin-top:8px">
        <button class="ve-btn pri" data-act="del-hide">隐藏（推荐，效果一样可随时恢复）</button>
        <button class="ve-btn danger" data-act="del-real">仍然删除</button>
        <button class="ve-btn" data-act="del-cancel">取消</button>
      </div>
    </div>
  </div>

  <div class="ve-modal" id="createModal" hidden>
    <div class="ve-mh"><b id="createTitle">新建</b><button class="ve-close" data-act="create-cancel">✕</button></div>
    <div class="ve-mb">
      <div id="createFields" style="display:grid;gap:8px"></div>
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="ve-btn pri" style="flex:1" data-act="create-save">保存并添加到页面</button>
        <button class="ve-btn" style="flex:1" data-act="create-cancel">取消</button>
      </div>
      <p class="ve-hint">保存后元素会出现在页面上，点它即可在右侧面板里继续改细节（同一套面板）。</p>
    </div>
  </div>

  <div class="ve-modal" id="askModal" hidden>
    <div class="ve-mh"><b id="askTitle">输入</b><button class="ve-close" data-act="ask-cancel">✕</button></div>
    <div class="ve-mb">
      <div class="ve-row"><label>内容</label><textarea id="askInput" placeholder=""></textarea></div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="ve-btn pri" style="flex:1" data-act="ask-ok">确定</button>
        <button class="ve-btn" style="flex:1" data-act="ask-cancel">取消</button>
      </div>
    </div>
  </div>

  <div class="ve-modal" id="aiModal" hidden>
    <div class="ve-mh"><b>AI 改稿</b><button class="ve-close" data-act="ai-close">✕</button></div>
    <div class="ve-mb">
      <div class="ve-row"><label>指令</label><textarea id="aiInput" placeholder="例：把这段标题改成两行、字号加大到 48px、字重 700；没选中的话就是整页。"></textarea></div>
      <div class="ve-row"><label>范围</label><select id="aiScope"><option value="page">整页</option><option value="selection">只改选中元素</option></select></div>
      <button class="ve-btn primary" data-act="ai-run">生成修改</button>
      <button class="ve-btn" data-act="ai-settings">AI 接口设置</button>
      <div class="ve-ai-list" id="aiResult" hidden></div>
      <div class="ve-2" id="aiActions" hidden style="margin-top:8px">
        <button class="ve-btn primary" data-act="ai-apply">应用到页面</button>
        <button class="ve-btn" data-act="ai-discard">取消</button>
      </div>
      <p class="ve-hint" id="aiHint"></p>
    </div>
  </div>

  <div class="ve-modal" id="setModal" hidden>
    <div class="ve-mh"><b>AI 接口设置</b><button class="ve-close" data-act="set-close">✕</button></div>
    <div class="ve-mb">
      <div class="ve-row"><label>baseURL</label><input type="text" id="setBase" placeholder="https://api.openai.com/v1"></div>
      <div class="ve-row"><label>模型</label><input type="text" id="setModel" placeholder="gpt-4o-mini"></div>
      <div class="ve-row"><label>apiKey</label><input type="text" id="setKey" placeholder="sk-..."></div>
      <p class="ve-hint">任何 OpenAI 兼容接口都行（含本地 ollama / one-api）。配置写进 .ve-data/ai.json，不会提交到仓库。</p>
      <button class="ve-btn primary" data-act="set-save">保存</button>
    </div>
  </div>

  <div class="ve-toast" id="toast"></div>
  <button class="ve-off" id="off" hidden>✎ 编辑</button>
  <button class="ve-exit" id="veExit" data-act="exit-preview" title="退出纯预览（Esc）">✕ 退出纯预览</button>
</div>`;

// 纯预览窗口：在首帧之前就把所有编辑器界面藏掉（组件层 .ve-stage 保留，它是页面设计的一部分）
if (PURE_BOOT) {
  try {
    const bootStyle = document.createElement("style");
    bootStyle.textContent = ".ve-ui.ve-pure-boot>*:not(.ve-stage){display:none!important}";
    shadow.appendChild(bootStyle);
    const uiEl = shadow.getElementById("ui");
    if (uiEl) uiEl.classList.add("ve-pure-boot");
  } catch { /* ignore */ }
}

/** 面板文字选择：用内联 !important 压过任何继承来的 user-select:none */
function forceSelectImportant() {
  try {
    const targets = [host, shadow.getElementById("ui"), shadow.getElementById("panel"), shadow.getElementById("tContent")].filter(Boolean);
    for (const el of targets) {
      el.style.setProperty("user-select", "text", "important");
      el.style.setProperty("-webkit-user-select", "text", "important");
    }
  } catch { /* ignore */ }
}

const ui = (sel) => shadow.querySelector(sel);
const refs = {
  tb: ui("#tb"), panel: ui("#panel"), hover: ui("#hover"), outline: ui("#outline"),
  grid: ui("#grid"), guideX: ui("#guideX"), guideY: ui("#guideY"), toast: ui("#toast"),
  marquee: ui("#marquee"), flash: ui("#flash"), info: ui("#elInfo"), quick: ui("#quick"), ui: ui("#ui"),
  stage: ui("#stage"), off: ui("#off"), elTag: ui("#elTag"), elPath: ui("#elPath"),
  tabs: ui("#tabs"), dirty: ui("#dirty"), aiModal: ui("#aiModal"), setModal: ui("#setModal"),
  aiResult: ui("#aiResult"), aiActions: ui("#aiActions"), aiHint: ui("#aiHint"),
  gridSize: ui("#gridSize"),
  vpSize: ui("#vpSize"),
};

/* ────────────────────────────── 小工具 ────────────────────────────── */

let toastTimer = 0;
function toast(msg, ms = 2000) {
  refs.toast.textContent = msg;
  refs.toast.dataset.show = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { refs.toast.dataset.show = "0"; }, ms);
}

/** 有效可见：自身和所有祖先都可见（祖先 opacity:0 的动画层也算不可见） */
function effectiveVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: false });
    }
  } catch { /* 走下面手动判断 */ }
  let n = el;
  for (let i = 0; i < 30 && n && n.nodeType === 1; i += 1) {
    const cs = getComputedStyle(n);
    if (Number(cs.opacity) < 0.03) return false;
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    n = n.parentElement;
  }
  return true;
}

function isConnected(el) {
  return Boolean(el && (typeof el.isConnected === "boolean" ? el.isConnected : document.contains(el)));
}

function insideEditor(e) {
  try {
    if (e.composedPath && e.composedPath().includes(host)) return true;
    const tgt = e.target;
    if (tgt && tgt.closest && tgt.closest("[data-ve-editor-ui], #__ve_docktab, #__ve_multi, #__ve_float_debug")) return true;
    if (!tgt) return false;
    if (tgt === host) return true;
    if (tgt.getRootNode && tgt.getRootNode() === shadow) return true;
    if (shadow.activeElement && shadow.activeElement.contains && shadow.activeElement.contains(tgt)) return true;
  } catch { /* ignore */ }
  return false;
}

function isTextEl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (["IMG", "SVG", "CANVAS", "VIDEO", "IFRAME", "INPUT", "TEXTAREA", "BR", "HR"].includes(tag)) return false;
  const kids = [...el.children];
  // 只允许「纯文本」或「文本 + <br>」的元素，避免把容器改坏
  return kids.every((c) => c.tagName === "BR") && (el.textContent.trim() !== "" || kids.length > 0);
}

/** 从选中元素往上找「能当成一段文字」的块（通用：上溯到真正包含整句的块级容器） */
function findTextBlock(el) {
  if (!el) return el;
  let node = el;
  const isInline = (n) => {
    try { return getComputedStyle(n).display.startsWith("inline"); } catch { return false; }
  };
  for (let i = 0; i < 14 && node.parentElement && node.parentElement !== document.body; i += 1) {
    const parent = node.parentElement;
    if (isInline(parent)) { node = parent; continue; } // 父级还是行内（逐字/逐词 span）→ 继续上溯
    // 父级是块级：如果它是文字容器（子元素全是行内 / 只有这一串 / 本来就是 p·h1-6·li），就是整段
    const kids = [...parent.children];
    const allInline = kids.length > 0 && kids.every((c) => isInline(c));
    const looksTextBlock = allInline || kids.length <= 1 || parent.tagName === "P" || /^H[1-6]$/.test(parent.tagName) || parent.tagName === "LI";
    if (looksTextBlock) return parent;
    return node;
  }
  return node;
}

/** 可见文本节点：父元素可见、有宽度 */
function visibleTextNodes(block) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.classList && p.classList.contains("sr-only")) return NodeFilter.FILTER_REJECT;
      if (!n.nodeValue || !n.nodeValue.length) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const p = n.parentElement;
    try {
      if (!effectiveVisible(p)) continue;
      const r = p.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
    } catch { /* 保留 */ }
    nodes.push(n);
  }
  return nodes;
}

/** 整段文字写入：按可见叶子元素逐字/逐词分配（保留动画 span 结构，不再出现「开头消失」） */
function writeBlockText(block, text) {
  if (!block) return;
  const value = String(text ?? "");
  // 可见叶子元素（自身只含文本节点的元素，且父级可见）
  const leaves = [];
  const walk = (node) => {
    for (const child of [...node.children]) {
      const cs = getComputedStyle(child);
      if (Number(cs.opacity) < 0.03 || cs.visibility === "hidden" || cs.display === "none") continue;
      if (child.classList && child.classList.contains("sr-only")) continue;
      const hasText = [...child.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      const r = child.getBoundingClientRect();
      if (hasText && child.childElementCount === 0 && r.width >= 1 && r.height >= 1) {
        leaves.push(child);
      } else {
        walk(child);
      }
    }
  };
  walk(block);

  // sr-only 真值层也同步更新（读屏/SEO）
  const sr = block.querySelector("[class*='sr-only'], .sr-only");
  if (sr) sr.textContent = value;

  if (!leaves.length) {
    // 没有可见叶子：保留原结构，把内容集中到第一个文本节点
    const vis = visibleTextNodes(block);
    if (!vis.length) { block.textContent = value; return; }
    vis[0].nodeValue = value;
    for (let i = 1; i < vis.length; i += 1) vis[i].nodeValue = "";
    return;
  }

  // 判断按字还是按词
  const lens = leaves.map((el) => (el.textContent || "").trim().length).filter((n) => n > 0);
  const avg = lens.reduce((s, n) => s + n, 0) / Math.max(1, lens.length);
  const charMode = avg <= 2;
  const tokens = charMode ? [...value] : value.split(/(\s+)/).filter((s) => s.length);

  let ti = 0;
  for (const leaf of leaves) {
    let tk = "";
    if (ti < tokens.length) {
      tk = tokens[ti];
      ti += 1;
      // 词模式下把紧跟的空格并进来，避免单词粘连
      if (!charMode && ti < tokens.length && /^\s+$/.test(tokens[ti])) { tk += tokens[ti]; ti += 1; }
    }
    leaf.textContent = tk;
  }
  // 多余文字：追加到最后一个叶子
  if (ti < tokens.length) leaves[leaves.length - 1].textContent += tokens.slice(ti).join("");
}

/** 读整段文字：优先 sr-only 真值；否则用可见文本节点拼起来（去重重复层） */
function canonicalBlockText(block) {
  if (!block) return "";
  const sr = block.querySelector("[class*='sr-only'], .sr-only");
  if (sr && sr.textContent.trim()) return sr.textContent.replace(/\s+/g, " ").trim();
  const vis = visibleTextNodes(block);
  const rawJoin = vis.map((n) => n.nodeValue).join("");
  let text = dedupeLayers(rawJoin).replace(/\s+/g, " ").trim();
  return dedupeLayers(text);
}

/** 去重重复层：一是整句重复（ABAB），二是每个字符重复 k 遍（AABBCC / AAABBBCCC） */
function dedupeLayers(raw) {
  const text = String(raw || "");
  if (text.length < 2) return text;
  // 整句重复
  if (text.length % 2 === 0) {
    const half = text.slice(0, text.length / 2);
    if (half && text.slice(text.length / 2) === half) return half.trim();
  }
  // 字符重复：找 k=2..4，使得「每 k 个字符中只有第 0 个不一样」可还原
  for (let k = 2; k <= 4; k += 1) {
    if (text.length % k !== 0) continue;
    let ok = true;
    let out = "";
    for (let i = 0; i < text.length; i += k) {
      const ch = text[i];
      out += ch;
      for (let j = 1; j < k; j += 1) if (text[i + j] !== ch) { ok = false; break; }
      if (!ok) break;
    }
    if (ok && out.trim()) return out.trim();
  }
  return text.trim();
}

function applyBlockText(key, text) {
  const el = resolve(key);
  if (!el) return;
  writeBlockText(el, text);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

/** 读文字：<br> 归一成换行 */
function textOf(el) {
  return [...el.childNodes]
    .map((n) => (n.nodeType === 3 ? n.textContent : n.nodeName === "BR" ? "\n" : ""))
    .join("");
}

/** 写文字：保留换行（转回 <br>），不执行任何 HTML */
function writeText(el, text) {
  const kids = [...el.children];
  if (kids.length && !kids.every((c) => c.tagName === "BR")) {
    el.textContent = String(text);
    return;
  }
  el.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
}

/** 把旧 key（可能从 body 截断/带 html 前缀等）统一成当前 elementKey 的规范形式 */
function canonicalKey(key) {
  try {
    if (!key || key.indexOf("sel:") !== 0) return key;
    const el = resolve(key);
    if (!el) return key;
    return elementKey(el) || key;
  } catch { return key; }
}

/** 归一化整张覆写表：同一元素的不同 key 合并（后者覆盖前者） */
/** 判断 key 是否指向编辑器自己的浮层（这些不该被保存成页面覆写） */
function isEditorUiKey(key) {
  try {
    const el = resolve(key);
    if (!el) return false;
    if (el.closest && el.closest("[data-ve-editor-ui], #__ve_docktab, #__ve_multi, #__ve_float_debug")) return true;
    const id = el.id || "";
    return id === "__ve_docktab" || id === "__ve_multi" || id === "__ve_float_debug";
  } catch { return false; }
}

/** 过滤掉指向编辑器浮层的覆写（历史误存的需要清掉） */
function stripEditorUiKeys(map) {
  const out = {};
  let removed = 0;
  try {
    for (const [k, v] of Object.entries(map || {})) {
      if (isEditorUiKey(k)) { removed += 1; continue; }
      out[k] = v;
    }
  } catch { /* ignore */ }
  if (removed) console.info("[ve] 已清理 " + removed + " 条指向编辑器浮层的覆写");
  return out;
}

function normalizeKeyMap(map) {
  const out = {};
  try {
    for (const [k, v] of Object.entries(map || {})) {
      const ck = canonicalKey(k);
      if (!ck) continue;
      if (out[ck]) out[ck] = { ...out[ck], ...v, style: { ...(out[ck].style || {}), ...(v.style || {}) } };
      else out[ck] = v;
    }
  } catch { /* ignore */ }
  return out;
}

function entryOf(key) {
  return S.pending[key] || S.overrides[key] || null;
}

function ensureEntry(key) {
  if (!S.pending[key]) S.pending[key] = clone(S.overrides[key]) || {};
  if (!S.pending[key].style) S.pending[key].style = {};
  return S.pending[key];
}

function isDirty() {
  return Object.keys(S.pending).length > 0;
}

function updateDirty() {
  const n = Object.keys(S.pending).length;
  refs.dirty.hidden = n === 0;
  refs.dirty.textContent = String(n);
  const save = refs.tb.querySelector('[data-act="save"]');
  save.dataset.dirty = n ? "1" : "0";
  // 每次改动：写一份草稿缓存（防刷新/崩溃丢改动）+ 预约自动保存
  try { scheduleDraft(); scheduleAutoSave(); } catch { /* 早期调用忽略 */ }
}

/* ────────────────────────────── DOM 应用 / 回退 ──────────────────────────────
 * 关键设计：样式改动走「注入 !important 样式表」，不写内联 style。
 * 因为 React/Vue 重渲染时会重写 style 属性，内联改动会被冲掉；样式表 !important 能扛住。
 * 只有文字、属性（src/alt/fill…）和 canvas 尺寸同步需要真的碰 DOM。
 */

const STYLE_ID = "__ve_style";
let styleTag = null;

function ensureStyleTag() {
  if (styleTag && styleTag.isConnected) return styleTag;
  styleTag = document.getElementById(STYLE_ID);
  if (!styleTag) {
    styleTag = document.createElement("style");
    styleTag.id = STYLE_ID;
    document.body.appendChild(styleTag);
  }
  return styleTag;
}

/** 覆写层 + 未保存改动合并后的生效条目 */
function effectiveEntries() {
  const map = {};
  for (const [k, v] of Object.entries(S.overrides)) if (v && !v.__overlay) map[k] = v;
  for (const [k, v] of Object.entries(S.pending)) {
    if (v && v.__overlay) continue;
    // pending 里的空对象 = 显式取消（撤销到无覆写时用来盖掉自动保存下来的 overrides）
    if (!v || !Object.keys(v).length) { delete map[k]; continue; }
    map[k] = { ...(map[k] || {}), ...v, style: { ...(map[k]?.style || {}), ...(v.style || {}) } };
  }
  for (const k of Object.keys(map)) if (!Object.keys(map[k]).length) delete map[k];
  return map;
}

function refreshStylesheet() {
  const entries = effectiveEntries();
  { const tag = ensureStyleTag(); tag.textContent = styleToCss(entries); try { document.body.appendChild(tag); } catch { /* ignore */ } }
  // SVG 渐变用到的 <linearGradient> 跟着覆写层一起同步（保存后重开预览也会重新生成）
  syncSvgGrads(entries);
}

let lastStyleAt = 0;
/**
 * 同步刷新样式表。
 * 不用 rAF：后台标签页/无头环境下 rAF 会被节流甚至不触发，样式会「卡住不生效」；
 * 而这里只是给一个 <style> 赋 textContent，开销可以忽略。
 */
function scheduleStyles() {
  const now = performance.now ? performance.now() : Date.now();
  // 拖动时每帧都会调用，这里不做节流（一次赋值 ≈ 微秒级），但保留时间戳便于将来扩展
  lastStyleAt = now;
  refreshStylesheet();
}
void lastStyleAt;

const ORIG_ATTRS = ["src", "alt", "href", "fill", "stroke", "title", "type", "aria-label"];

function pickAttrs(el) {
  const out = {};
  for (const a of ORIG_ATTRS) if (el.hasAttribute(a)) out[a] = el.getAttribute(a);
  return out;
}

function resolve(key) {
  const sel = keyToSelector(key);
  if (!sel) return null;
  try { return document.querySelector(sel); } catch { return null; }
}

/** 只处理「必须碰 DOM」的那部分 */
function applyDom(key, entry) {
  const el = resolve(key);
  if (!el) return;
  if (!entry || !Object.keys(entry).length) return;
  if (entry.attrs) {
    for (const [a, v] of Object.entries(entry.attrs)) {
      try {
        if (v == null) el.removeAttribute(a);
        else el.setAttribute(a, v);
      } catch { /* 非法属性名忽略 */ }
    }
  }
  if (typeof entry.text === "string" && isTextEl(el)) writeText(el, entry.text);
  if (typeof entry.blockText === "string") writeBlockText(el, entry.blockText);
  if (entry.image && el.tagName !== "IMG" && !el.querySelector("[data-ve-replaced]")) {
    const r = entry.imageBox || el.getBoundingClientRect();
    replaceWithImage(el, entry.image, { width: r.width, height: r.height });
  }
  if (el.tagName === "CANVAS") syncCanvas(el, entry);
}

function applyEntry(key, entry) {
  applyDom(key, entry);
}

function syncCanvas(el, entry) {
  if (el.tagName !== "CANVAS") return;
  const box = entry?.box || {};
  const rect = el.getBoundingClientRect();
  const w = Math.round(box.width ?? rect.width);
  const h = Math.round(box.height ?? rect.height);
  if (!w || !h) return;
  const hooks = S.hooks || window.__VE_HOOKS__;
  if (hooks && typeof hooks.resizeCanvas === "function") {
    try { hooks.resizeCanvas(el, w, h); return; } catch (e) { console.warn("[ve] resizeCanvas 钩子报错", e); }
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
  }
  window.dispatchEvent(new Event("resize"));
}

/** 把某个元素恢复成页面原始状态（重置按钮用） */
function restoreOriginal(key) {
  const el = resolve(key);
  const orig = S.orig[key];
  delete S.pending[key];
  refreshStylesheet();
  if (!el || !orig) return;
  if (orig.text != null && isTextEl(el)) writeText(el, orig.text);
  for (const [a, v] of Object.entries(orig.attrs || {})) {
    try { el.setAttribute(a, v); } catch { /* ignore */ }
  }
}

/* ────────────────────────────── 选择与悬浮 ────────────────────────────── */

const SKIP_TAGS = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"]);

/** 取该点下所有可编辑候选（由表层到深层），用于处理「点到背景/覆盖层」 */
function pickStackAt(x, y) {
  const raw = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
  const out = [];
  for (const el of raw) {
    if (!el || el.nodeType !== 1) continue;
    if (el === host || el.closest?.("#__ve_host")) continue;
    if (el.closest?.("[data-ve-editor-ui], #__ve_docktab, #__ve_multi, #__ve_float_debug")) continue;
    if (SKIP_TAGS.has(el.tagName)) continue;
    if (out.includes(el)) continue;
    if (!effectiveVisible(el)) continue; // 祖先透明/隐藏的重复层不参与选择
    out.push(el);
  }
  return out;
}

/** 在一叠候选里挑「最像可编辑内容」的那个：媒体/小组件优先，避免被大包装层吃掉 */
function rankCandidate(el, x, y) {
  let score = 0;
  if (!el) return -999;
  const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  const media = ["IMG", "SVG", "CANVAS", "VIDEO", "PATH", "CIRCLE", "RECT", "USE"].includes(el.tagName);
  const subText = !hasText && el.textContent ? el.textContent.replace(/\s+/g, "").length : 0;
  if (hasText) score += 100;
  if (isTextEl(el)) score += 20;
  // 有些标题的字是 CSS ::before/::after content 或拆分 span 画的：检测伪元素文字
  let pseudoText = false;
  try {
    for (const pseudo of ["::before", "::after"]) {
      const c = getComputedStyle(el, pseudo).content;
      if (c && c !== "none" && c !== "normal" && /[\w\u4e00-\u9fa5]/.test(c)) { pseudoText = true; break; }
    }
  } catch { /* ignore */ }
  if (pseudoText) score += 60;
  if (media) score += 70; // 图标/图片/视频本身最值得点
  else if (subText > 1 || pseudoText) score += 30; // 文字容器次之
  // 小组件（图标、按钮、角标）默认更容易选中
  try {
    const r = el.getBoundingClientRect();
    const vp = window.innerWidth * window.innerHeight;
    const ratio = vp > 0 ? (r.width * r.height) / vp : 0;
    if (!hasText && r.width <= 160 && r.height <= 160 && r.width * r.height >= 16) score += 22;
    const cs = getComputedStyle(el);
    if (Number(cs.opacity) < 0.05) score -= 80;
    if (!effectiveVisible(el)) score -= 300;
    if (cs.pointerEvents === "none") score -= 30;
    if (cs.visibility === "hidden") score -= 120;
    // 盖住大半屏又没有自身文字的，基本都是包装层 / 遮罩 / 固定背景
    if (!hasText) {
      if (ratio > 0.6) score -= 45;
      if (ratio > 0.25) score -= 15;
      if (el.children.length > 4 && el !== S.pickHit) score -= 15;
      if (cs.position === "fixed") score -= 20;
      // 铺满屏幕的纯媒体基本是背景视频/装饰图，默认让位给文字层
      if (media && ratio > 0.55) score -= 130;
      else if (media && ratio > 0.2) score -= 80;
    }
  } catch { /* ignore */ }
  return score;
}

/** 点到的是包装层（a/div/button）时，自动下钻到它里面盖住点击点的小媒体元素 */
function descendMedia(el, x, y) {
  if (!el || !el.querySelectorAll) return el;
  if (["IMG", "SVG", "CANVAS", "VIDEO"].includes(el.tagName)) return el;
  if (!["A", "BUTTON", "DIV", "SPAN", "SECTION", "LI"].includes(el.tagName)) return el;
  let best = null;
  for (const child of el.querySelectorAll("svg, img, canvas, video")) {
    const r = child.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const area = r.width * r.height;
    if (!best || area < best.area) best = { el: child, area };
  }
  return best ? best.el : el;
}

/** 几何扫描：不管 pointer-events / z-index，只要矩形盖住点且可见就算候选（专治滚动出现的动画文字层） */
function geometricCandidates(x, y) {
  const out = [];
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    if (el === host || el.closest?.("#__ve_host")) continue;
    if (el.closest?.("[data-ve-editor-ui], #__ve_docktab, #__ve_multi, #__ve_float_debug")) continue;
    if (SKIP_TAGS.has(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    if (!effectiveVisible(el)) continue;
    out.push(el);
    if (out.length >= 800) break;
  }
  return out;
}

function pickStack(x, y) {
  const stack = pickStackAt(x, y);
  // 真实命中的最上层元素（elementsFromPoint 第一位）：它才是用户"看到并点到"的东西
  S.pickHit = stack[0] || null;
  // elementsFromPoint 拿不到 pointer-events:none 的层；命中层没有文字时用几何扫描补齐
  const hitHasText = stack.some((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1));
  if (!hitHasText) {
    for (const el of geometricCandidates(x, y)) if (!stack.includes(el)) stack.push(el);
  }
  const best = stack
    .map((el, i) => ({ el, i, score: rankCandidate(el, x, y) + (S.pickHit === el ? 30 : (S.pickHit && el.contains(S.pickHit) ? -60 : 0)) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x2) => x2.el);
  // 文字优先：点击位置若落在一段文字上（哪怕上面盖着装饰/覆盖层），把这段文字排到第一候选
  try {
    const caretEl = textElementAtPoint(x, y);
    if (caretEl && caretEl !== best[0]) {
      const rest = best.filter((el) => el !== caretEl);
      rest.unshift(caretEl);
      S.pickStack = rest;
      return rest;
    }
  } catch { /* ignore */ }
  S.pickStack = best;
  return best;
}

/** 该点实际落到的文字元素（用 caret 命中；能穿透覆盖层找到下面真正承载文字的节点）
 *  判定：纵向落在文字行盒内（±10px），横向留一定容差（覆盖"点字与字之间空隙"的情况）。
 */
function textElementAtPoint(x, y) {
  try {
    let node = null;
    let caretRect = null;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      node = p && p.offsetNode;
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      node = r && r.startContainer;
    }
    if (!node) return null;
    const textNode = (() => {
      let n = node;
      for (let i = 0; i < 4 && n; i++) {
        if (n.nodeType === 3 && String(n.textContent || "").trim()) return n;
        n = n.parentElement;
      }
      return node && node.nodeType === 3 ? node : null;
    })();
    if (!textNode) return null;
    try {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      caretRect = range.getBoundingClientRect();
    } catch { caretRect = null; }
    if (!caretRect || !(caretRect.width > 0) || !(caretRect.height > 0)) return null;
    // 纵向必须在文字行内；横向允许较宽容差（字符被拆成多个 span 时空隙也能命中）
    const padY = 10;
    const padX = 64;
    if (y < caretRect.top - padY || y > caretRect.bottom + padY) return null;
    if (x < caretRect.left - padX || x > caretRect.right + padX) return null;
    let el = textNode.parentElement;
    const ownText = (n) => {
      try { return [...n.childNodes].some((c) => c.nodeType === 3 && String(c.textContent || "").trim().length > 0); } catch { return false; }
    };
    let guard = 0;
    while (el && el !== document.body && guard++ < 8 && !ownText(el)) el = el.parentElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (SKIP_TAGS.has(el.tagName)) return null;
    if (el.closest && (el.closest("#__ve_host") || el.closest("[data-ve-editor-ui]"))) return null;
    if (!effectiveVisible(el)) return null;
    return el;
  } catch { return null; }
}

/** 取该点下最深的可见文字叶子（T 模式的文字抓取） */
function textLeafAt(x, y) {
  const isTextNode = (el) => el && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  const pick = (list) => {
    let best = null;
    for (const el of list) {
      if (!el || el.nodeType !== 1) continue;
      if (el.closest && el.closest("#__ve_host")) continue;
      if (!effectiveVisible(el)) continue;
      if (!isTextNode(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (!best || area < best.area) best = { el, area };
    }
    return best ? best.el : null;
  };
  // 优先：该点上所有可见文字层（含被覆盖层压住但实际可见的）
  const hit = pick(pickStackAt(x, y));
  if (hit) return hit;
  const geo = geometricCandidates(x, y);
  const fromGeo = pick(geo);
  if (fromGeo) return fromGeo;
  // 兜底：从命中元素往上/往下找最近的文字元素
  const base = pickEl(x, y);
  if (base) {
    let n = base;
    for (let i = 0; i < 6 && n; i += 1) {
      if (isTextNode(n)) return n;
      n = n.parentElement;
    }
    const walk = (node) => {
      for (const child of [...node.children]) {
        if (!effectiveVisible(child)) continue;
        if (isTextNode(child)) return child;
        const deeper = walk(child);
        if (deeper) return deeper;
      }
      return null;
    };
    const downward = walk(base);
    if (downward) return downward;
  }
  return null;
}

function pickEl(x, y, keepStack) {
  if (!keepStack && (!S.pickStack.length || S.pickStackPos !== `${Math.round(x)},${Math.round(y)}`)) {
    S.pickStackPos = `${Math.round(x)},${Math.round(y)}`;
    pickStack(x, y);
    S.pickIndex = 0;
  }
  const stack = S.pickStack;
  if (!stack.length) return null;
  if (S.textMode) { const leaf = textLeafAt(x, y); if (leaf) return leaf; }
  const chosen = stack[S.pickIndex % stack.length];
  // 点到 <a>/<div> 包装层时，优先选它里面盖住点击点的小图标/图片
  const descended = descendMedia(chosen, x, y);
  if (descended !== chosen && !S.pickStack.includes(descended)) S.pickStack.unshift(descended);
  return descended;
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
}

/* ── 面板自适应位置 ──
 * 默认停右上；当编辑的元素跑到屏幕右侧 1/3（会被面板挡住）时，面板自动挪到左上。
 */
function leftDockShown() {
  try {
    const dock = refs.ui ? refs.ui.querySelector("#leftDock") : null;
    if (!dock) return false;
    if (dock.getAttribute("data-closed") === "1") return false;
    const r = dock.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  } catch { return false; }
}

function placePanelFor(el) {
  const panel = refs.panel;
  if (!panel) return;
  let side = "right";
  try {
    if (el && el.nodeType === 1 && panel.hidden === false) {
      const r = rectOf(el);
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const cx = r.left + r.width / 2;
      const spansMost = r.width > vw * 0.86; // 整屏画布：挪哪边都挡，保持右侧
      const pr = panel.getBoundingClientRect();
      const overlapsRight = !(r.bottom < pr.top + 10 || r.top > pr.bottom - 10) && r.right > pr.left - 16;
      if (!spansMost) {
        if (overlapsRight && r.left > 120) side = "left";
        else if (vw > 0 && cx > vw * 2 / 3) side = "left";
      }
    }
  } catch { side = "right"; }
  if (panel.dataset.side !== side) panel.dataset.side = side;
  if (side === "left") {
    const left = leftDockShown() ? "152px" : "14px";
    if (panel.style.left !== left) panel.style.left = left;
    if (panel.style.right !== "auto") panel.style.right = "auto";
  } else {
    if (panel.style.left !== "") panel.style.left = "";
    if (panel.style.right !== "") panel.style.right = "";
  }
}


function paintOutline(el) {
  if (S.preview) { refs.outline.style.display = "none"; return; }
  if (!el) { refs.outline.style.display = "none"; return; }
  const r = rectOf(el);
  refs.outline.style.display = "block";
  refs.outline.style.left = `${r.left}px`;
  refs.outline.style.top = `${r.top}px`;
  refs.outline.style.width = `${r.width}px`;
  refs.outline.style.height = `${r.height}px`;
  refs.outline.querySelector(".ve-lbl").textContent =
    `${el.tagName.toLowerCase()}  ${Math.round(r.width)}×${Math.round(r.height)}`;
}

function paintHover(el) {
  if (S.preview) { refs.hover.style.display = "none"; return; }
  if (!el) { refs.hover.style.display = "none"; return; }
  const r = rectOf(el);
  refs.hover.style.display = "block";
  refs.hover.style.left = `${r.left}px`;
  refs.hover.style.top = `${r.top}px`;
  refs.hover.style.width = `${r.width}px`;
  refs.hover.style.height = `${r.height}px`;
}

function layerLabelOf(el) {
  const tag = String(el.tagName || "").toLowerCase();
  const cls = String(el.className || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
  return tag + (cls ? "." + cls : "");
}

function renderLayerTree() {
  const host = ui("#layerTree");
  if (!host) return;
  host.textContent = "";
  if (!S.layerCollapsed || typeof S.layerCollapsed !== "object") S.layerCollapsed = {};
  const collapsed = S.layerCollapsed;
  const ancestors = new Set();
  try {
    let n = S.selected && S.selected.parentElement;
    while (n && n !== document.body) { ancestors.add(n); n = n.parentElement; }
  } catch { /* ignore */ }
  let count = 0;
  const walk = (parent, depth) => {
    if (!parent || depth > 6 || count > 180) return;
    for (const el of parent.children) {
      if (count > 180) return;
      if (!el || el.id === "__ve_host" || el.id === "__ve_docktab") continue;
      if (el.hasAttribute("data-ve-editor-ui") || el.hasAttribute("data-ve-applied-overlay")) continue;
      if (["SCRIPT", "STYLE", "LINK", "META"].includes(el.tagName)) continue;
      const key = elementKey(el);
      if (!key) continue;
      count += 1;
      const hasKids = el.children && el.children.length > 0;
      const forceOpen = ancestors.has(el) || el === S.selected;
      const isCollapsed = Boolean(collapsed[key]) && !forceOpen;
      const row = document.createElement("div");
      row.className = "ve-layer";
      row.dataset.layerKey = key;
      row.style.paddingLeft = (4 + depth * 10) + "px";
      if (el === S.selected) row.dataset.sel = "1";
      if (hasKids) {
        const tg = document.createElement("button");
        tg.className = "lt";
        tg.dataset.layerToggle = key;
        tg.textContent = isCollapsed ? "▶" : "▼";
        tg.style.cssText = "border:0;background:none;cursor:pointer;padding:0 2px;color:#8494a8;font-size:9px;min-width:10px";
        row.appendChild(tg);
      } else {
        const sp = document.createElement("span");
        sp.style.cssText = "display:inline-block;width:10px";
        row.appendChild(sp);
      }
      const tag = document.createElement("span");
      tag.className = "lt-name";
      tag.textContent = layerLabelOf(el);
      row.appendChild(tag);
      const hidden = Boolean(entryOf(key)?.hidden) || getComputedStyle(el).display === "none";
      if (hidden) row.style.opacity = "0.45";
      const btn = document.createElement("button");
      btn.className = "lh";
      btn.dataset.layerHide = key;
      btn.title = hidden ? "显示" : "隐藏";
      btn.textContent = hidden ? "◌" : "◉";
      row.appendChild(btn);
      host.appendChild(row);
      if (!isCollapsed) walk(el, depth + 1);
    }
  };
  try {
    walk(document.body, 0);
    // 默认折叠太深的内容，只展开到 section/主要容器，当前选中路径例外
    if (Object.keys(collapsed).length === 0) {
      const walkDefault = (parent, depth) => {
        if (!parent || depth > 2) return;
        for (const el of parent.children) {
          const key = elementKey(el);
          if (!key) continue;
          if (el.children && el.children.length > 0 && depth >= 2 && !ancestors.has(el)) collapsed[key] = true;
          walkDefault(el, depth + 1);
        }
      };
      try { walkDefault(document.body, 0); } catch { /* ignore */ }
      if (Object.keys(collapsed).length) { renderLayerTree(); return; }
    }
    if (!host.querySelector('.ve-layer-cur')) {
      const cur = document.createElement('div');
      cur.className = 've-layer ve-layer-cur';
      cur.dataset.sel = '1';
      cur.textContent = '当前选择：' + (S.selected ? layerLabelOf(S.selected) : '无');
      host.insertBefore(cur, host.firstChild);
    } else {
      host.querySelector('.ve-layer-cur').textContent = '当前选择：' + (S.selected ? layerLabelOf(S.selected) : '无');
    }
    const selRow = host.querySelector('.ve-layer:not(.ve-layer-cur)[data-sel="1"]');
    if (selRow) { try { selRow.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ } }
  } catch { /* ignore */ }
}
function exportSelectedCode() {
  const el = S.selected;
  if (!el) { toast("先选中一个元素再导出", 1600); return; }
  try {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("[data-ve-editor-ui]").forEach((n) => n.remove());
    clone.removeAttribute("contenteditable");
    clone.removeAttribute("data-ve-sel");
    const cls = String(el.className || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    const selector = el.id ? "#" + el.id : String(el.tagName || "div").toLowerCase() + (cls ? "." + cls : "");
    const cs = getComputedStyle(el);
    const props = ["display", "position", "width", "height", "max-width", "margin", "padding", "border", "border-radius", "background", "color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "box-shadow", "text-shadow", "filter", "backdrop-filter", "transform", "opacity"];
    const decls = props.map((p) => {
      let v = cs.getPropertyValue(p);
      if (!v || v === "none" || v === "normal" || v === "auto" || v === "0px" || v === "rgba(0, 0, 0, 0)") return "";
      return "  " + p + ": " + v + ";";
    }).filter(Boolean).join("\n");
    const css = selector + " {\n" + decls + "\n}";
    const html = clone.outerHTML;
    const text = "<!-- " + selector + " -->\n<style>\n" + css + "\n</style>\n\n" + html;
    const ta = ui("#exportText");
    if (ta) ta.value = text;
    const m = ui("#exportModal");
    if (m) m.hidden = false;
  } catch (e) { toast("导出失败：" + (e && e.message || e), 2600); }
}

function copyExportText() {
  const ta = ui("#exportText");
  if (!ta) return;
  try { ta.select(); document.execCommand("copy"); toast("已复制", 1200); return; } catch { /* ignore */ }
  try { navigator.clipboard.writeText(ta.value).then(() => toast("已复制", 1200)).catch(() => toast("复制失败，请手动选择", 1600)); } catch { toast("复制失败", 1600); }
}

function downloadExportText() {
  const ta = ui("#exportText");
  if (!ta) return;
  try {
    const blob = new Blob([ta.value], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "selection-" + Date.now() + ".html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch { toast("下载失败", 1600); }
}

function select(el, showPanel) {
  try { } catch { /* ignore */ }
  const panelVisible = showPanel === undefined ? true : Boolean(showPanel);
  if (S.draftDirty && el !== S.selected) {
    const ta = ui("#tContent");
    if (ta) { ta.value = S.appliedText || ""; ta.style.borderColor = ""; }
    S.draftDirty = false;
  }
  if (S.editing) stopEditing(false);
  try {
    if (el && el.closest && el.closest("[data-ve-editor-ui], #__ve_docktab, #__ve_multi, #__ve_float_debug")) el = null;
    if (el && (el.id === "__ve_docktab" || el.id === "__ve_multi" || el.id === "__ve_float_debug")) el = null;
  } catch { /* ignore */ }
  S.selected = el || null;
  if (!el) {
    refs.panel.hidden = true;
    placePanelFor(null);
    refs.outline.style.display = "none";
    refs.stage.querySelectorAll(".ve-ins").forEach((n) => n.dataset.sel = "0");
    return;
  }
  if (el.__veOverlayId) {
    refs.panel.hidden = !panelVisible;
    S.ovEl = el;
    refs.stage.querySelectorAll(".ve-ins").forEach((n) => { n.dataset.sel = n === el ? "1" : "0"; });
    paintOutline(el);
    const info = overlayEntry(el);
    const names = { nav: "导航栏", button: "按钮", card: "卡片", divider: "分割线", text: "文字", img: "图片", three: "Three.js" };
    const node = info && info.node;
    const presetName = overlayPresetOf(node);
    const label = (presetName ? names[presetName] : null) || (node && names[node.tag]) || "插入元素";
    refs.elTag.textContent = label;
    // 标题右侧 + 页签都显示具体类型（分割线/导航栏…），别再显示笼统的「组件」
    refs.elPath.textContent = presetName ? (names[presetName] || "组件") : "元素";
    {
      const tabOv = refs.tabs.querySelector('[data-tab="ov"]');
      if (tabOv) tabOv.textContent = presetName ? (names[presetName] || "组件") : "组件";
    }
    try {
      const rr = rectOf(el);
      if (refs.elInfo) refs.elInfo.textContent = label + " · " + Math.round(rr.width) + "×" + Math.round(rr.height) + " · (" + Math.round(rr.left) + "," + Math.round(rr.top) + ")";
      const lbl = refs.outline && refs.outline.querySelector(".ve-lbl");
      if (lbl) lbl.textContent = label + "  " + Math.round(rr.width) + "×" + Math.round(rr.height);
    } catch { /* ignore */ }
    fillOverlayPanel(el);
    S.panelTab = "ov";
    refs.tabs.querySelectorAll("button").forEach((b) => { b.hidden = b.dataset.tab !== "ov"; b.dataset.on = b.dataset.tab === "ov" ? "1" : "0"; });
    shadow.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== "ov"; });
    updateQuickState();
    placePanelFor(el);
    return;
  }
  { const ovPanelEl = ui("#ovPanel"); if (ovPanelEl) ovPanelEl.hidden = true; }
  S.ovEl = null;
  { const tabOv = refs.tabs.querySelector('[data-tab="ov"]'); if (tabOv) tabOv.textContent = "组件"; }
  // 切回普通元素时，把之前插入组件身上的蓝框清掉，避免「新增部件的蓝框不消失」
  refs.stage.querySelectorAll(".ve-ins").forEach((n) => { n.dataset.sel = "0"; });
  refs.panel.hidden = !panelVisible;
  try { refs.panel.dataset.dark = pageIsDark() ? "1" : "0"; } catch { /* ignore */ }
  if (S.blockEl && S.blockEl !== el) { S.blockKey = ""; S.blockEl = null; }
  S.textLeaf = null;
  paintOutline(el);
  paintInfo(el);
  try { paintCrumb(el); } catch { /* ignore */ }
  if (S.flashOn) startFlash(el);
  updateQuickState();
  const key = elementKey(el);
  ensureSnapshot(el);
  S.origText = S.overrides[key]?.text ?? (isTextEl(el) ? textOf(el) : "");
  refs.elTag.textContent = el.tagName.toLowerCase();
  refs.elPath.textContent = key ? key.replace(/^(id|sel):/, "") : "";
  fillPanel(el, key);
  updatePanes(el);
  refs.tabs.querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.tab === S.panelTab ? "1" : "0"; });
  shadow.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== S.panelTab; });
  placePanelFor(el);
  try { paintMulti(); } catch { /* ignore */ }
}

/** 元素层级面包屑：显示从 body 到当前元素的路径，点任意一层即可选中（背景板也能选） */
function paintCrumb(el) {
  try {
    const box = ui("#crumb");
    if (!box) return;
    const chain = [];
    let n = el;
    while (n && n !== document.documentElement && chain.length < 8) {
      chain.unshift(n);
      n = n.parentElement;
    }
    S.crumbEls = chain;
    box.innerHTML = "";
    chain.forEach((node, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.crumbIdx = String(idx);
      const cls = node.getAttribute && node.getAttribute("class");
      const short = (cls ? "." + String(cls).trim().split(/\s+/)[0] : "") || "";
      b.textContent = node.tagName.toLowerCase() + short;
      b.dataset.on = node === el ? "1" : "0";
      b.title = "选中这一层：" + node.tagName.toLowerCase() + short;
      box.appendChild(b);
    });
  } catch { /* ignore */ }
}

/** 面板顶部信息行：标签/类名/尺寸/位置/源位置 */
function paintInfo(el) {
  if (!el || !refs.info) return;
  const r = rectOf(el);
  const id = el.id ? "#" + el.id : "";
  const cls = el.classList && el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "";
  const src = el.getAttribute("data-ve-id");
  refs.info.textContent = `${el.tagName.toLowerCase()}${id}${cls} · ${Math.round(r.width)}×${Math.round(r.height)} · (${Math.round(r.left)},${Math.round(r.top)})` + (src ? ` · 源 ${src}` : "");
  try {
    const c = getComputedStyle(el);
    if (c.position === "fixed") refs.info.textContent += " · 📌固定定位（滚动时不会移动）";
    else if (c.position === "sticky") refs.info.textContent += " · 📌吸顶";
    if (Number(c.opacity) < 0.05) refs.info.textContent += " · 透明≈0";
    if (c.pointerEvents === "none") refs.info.textContent += " · 不接收点击";
  } catch { /* ignore */ }
  refs.info.title = el.outerHTML.slice(0, 300);
}

/** 让选中元素的位置闪几下（不碰页面本身，只画我们的框） */
function startFlash(el) {
  if (!el || !refs.flash) return;
  const r = rectOf(el);
  const f = refs.flash;
  f.style.display = "block";
  f.style.left = `${r.left}px`;
  f.style.top = `${r.top}px`;
  f.style.width = `${r.width}px`;
  f.style.height = `${r.height}px`;
  f.style.animation = "none";
  void f.offsetWidth;
  f.style.animation = "veBlink .5s ease-in-out 0s 7 alternate";
  clearTimeout(startFlash._t);
  startFlash._t = setTimeout(() => { f.style.display = "none"; }, 3700);
}
function stopFlash() {
  if (!refs.flash) return;
  clearTimeout(startFlash._t);
  refs.flash.style.display = "none";
  refs.flash.style.animation = "none";
}

/* ────────────────────────────── 面板填充 ────────────────────────────── */

const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];
let lockAspect = false;
let aspectRatio = 1;

function cs(el, prop) { return getComputedStyle(el).getPropertyValue(prop); }

/** 解析计算样式里第一个数字（如 "24px" -> 24） */
function numOrEmpty(v) {
  const s = String(v || "").trim();
  if (!s || s === "normal" || s === "auto" || s === "none") return "";
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? String(Math.round(Number(m[0]) * 10) / 10) : "";
}

function fillQuad(ids, props, el) {
  ids.forEach((id, i) => { const inp = ui("#" + id); if (inp) inp.value = numOrEmpty(cs(el, props[i])); });
}

/** 拖拽/动画层的 tab 只显示相关项：纯文字只显示「文字」，纯图片/SVG 只显示「图片」 */
function updatePanes(el) {
  if (el && el.__veOverlayId) {
    refs.tabs.querySelectorAll("button").forEach((b) => { b.hidden = b.dataset.tab !== "ov"; b.dataset.on = b.dataset.tab === "ov" ? "1" : "0"; });
    shadow.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== "ov"; });
    return;
  }
  const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  const isText = isTextEl(el) || hasOwnText || (el.closest && el.closest("[class*='text']") && el.textContent.trim().length > 0 && el.childElementCount === 0);
  const isMedia = ["IMG", "SVG", "CANVAS", "VIDEO"].includes(el.tagName) || Boolean(el.querySelector && el.querySelector("img, svg, canvas, video"));
  const inBlock = Boolean(S.blockKey && S.blockEl === el);
  const show = { text: Boolean(isText) || inBlock, image: inBlock ? false : (!isText || Boolean(isMedia)), size: true, style: true };
  refs.tabs.querySelectorAll("button").forEach((b) => { b.hidden = !show[b.dataset.tab]; });
  if (S.blockKey && S.blockEl === el) S.panelTab = "text";
  else if (!show[S.panelTab]) S.panelTab = show.text ? "text" : (show.image ? "image" : "size");
}

function overlayEntry(el) {
  const key = el && el.dataset ? el.dataset.veOverlay : null;
  const entry = key ? S.pending[key] || S.overrides[key] : null;
  return entry && entry.__overlay ? { key, node: entry.__overlay } : null;
}

/* ── 插入组件的「定位」：随页面滚动 / 固定在屏幕 ──
 * 默认 page：组件挂在插入的那一段页面上，滚动到别的页面时它跟着页面一起走（不会每屏都出现）；
 * screen：固定挂在视口上（老行为，滚动时始终可见）。
 * 节点里 node.y 始终存「文档坐标」；渲染到 fixed 的 stage 时 page 模式要减掉 scrollY。
 */
function overlayPin(node) {
  if (node && node.pin === "screen") return "screen";
  if (node && node.pin === "page") return "page";
  // 默认「跟随周围」：位置固定，但跟着它所在的那一层（如首页封面）一起淡出
  return "auto";
}

/** 历史组件没有 preset 时按 HTML 特征补一个（目前支持分割线），保证选中后能进专用面板 */
function migrateOverlayPreset(node) {
  if (!node) return node;
  const html = node.attrs && typeof node.attrs.html === "string" ? node.attrs.html : "";
  // 1) 优先读 HTML 里编码的 data-ve-meta（保存时服务端只保留白名单字段，靠它把设置带回来）
  const metaMatch = /data-ve-meta="([^"]+)"/.exec(html);
  if (metaMatch) {
    try {
      const meta = JSON.parse(decodeURIComponent(metaMatch[1]));
      if (meta && meta.preset) {
        node.preset = meta.preset;
        node.params = { ...(meta.params || {}), ...(node.params || {}) };
        node.style = { ...(meta.style || {}), ...(node.style || {}) };
        if (!node.pin && meta.pin) node.pin = meta.pin;
        if (!node.rotate && meta.rotate) node.rotate = meta.rotate;
        if (node.baseScroll == null && meta.baseScroll) node.baseScroll = meta.baseScroll;
        normalizeDividerParams(node);
        // 用当前版本的默认样式重新生成 HTML（例如分割线默认改成实线，旧数据也会跟着更新）
        try { node.attrs = { ...(node.attrs || {}), html: presetHtml(node) }; } catch { /* ignore */ }
        return node;
      }
    } catch { /* ignore */ }
  }
  if (node.preset) return node;
  // 2) 早期版本插入的分割线：没有 preset 也没有 meta，按 HTML 特征识别
  if (/(linear-gradient|gradient)\((90deg|180deg),\s*transparent/.test(html)) {
    node.preset = "divider";
    node.params = { dir: /180deg/.test(html) ? "v" : "h", thick: 2, ...(node.params || {}) };
    normalizeDividerParams(node);
    node.attrs = { ...(node.attrs || {}), html: presetHtml(node) };
  }
  return node;
}

/** 分割线参数归一化：老的「两端渐隐」标记转成渐变填色（fill/grad） */
function normalizeDividerParams(node) {
  if (!node || node.preset !== "divider") return node;
  node.params = { ...(node.params || {}) };
  const c = (node.style && node.style.color) || "#E2DBC8";
  const dir = node.params.dir === "v" ? "v" : "h";
  if (!node.params.fill) node.params.fill = node.params.fade === true ? "grad" : "solid";
  if (node.params.fill === "grad" && !node.params.grad) {
    node.params.grad = gradSpec({
      angle: dir === "v" ? 180 : 90,
      target: "fill",
      stops: [
        { offset: 0, color: c, alpha: 0 },
        { offset: 0.5, color: c, alpha: 1 },
        { offset: 1, color: c, alpha: 0 },
      ],
    });
  }
  delete node.params.fade;
  return node;
}

/** 组件的预设类型（兼容没写 preset 的历史节点） */
function overlayPresetOf(node) {
  if (!node) return "";
  if (node.preset) return node.preset;
  const html = node.attrs && typeof node.attrs.html === "string" ? node.attrs.html : "";
  const metaMatch = /data-ve-meta="([^"]+)"/.exec(html);
  if (metaMatch) {
    try {
      const meta = JSON.parse(decodeURIComponent(metaMatch[1]));
      if (meta && meta.preset) return meta.preset;
    } catch { /* ignore */ }
  }
  if (/(linear-gradient|gradient)\((90deg|180deg),\s*transparent/.test(html)) return "divider";
  return "";
}

/** 视口 y → 文档 y（page 模式用） */
function docY(v) {
  return (window.scrollY || 0) + (Number(v) || 0);
}

function overlayTop(node) {
  const y = Number(node && node.y) || 0;
  // page 模式跟着文档走；screen / auto 都固定在视口上（auto 由邻近图层的淡出/移动带出效果）
  return overlayPin(node) === "page" ? y - (window.scrollY || 0) : y;
}

/** 插入组件默认定位：跟随周围组件（位置固定在视口，但跟着邻近图层一起淡出/移动） */
function refKeyAt(x, y) {
  try {
    // 首页封面层（.hero）是「开屏这一页」的容器：点在它范围内就跟随它，
    // 这样组件会跟标题/文案一起随滚动淡出，而不是像原来那样每屏都出现。
    const hero = document.getElementById("hero");
    if (hero && hero.getRootNode() === document) {
      const cs = getComputedStyle(hero);
      const rect = hero.getBoundingClientRect();
      const inView = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      const heroAlive = cs.visibility !== "hidden" && Number(cs.opacity) > 0.02;
      if (inView && heroAlive) return elementKey(hero);
    }
    for (const e of document.elementsFromPoint(x, y)) {
      if (!e || e.getRootNode() !== document) continue; // 跳过编辑器自己的层
      if (["CANVAS", "HTML", "BODY", "VIDEO"].includes(e.tagName)) continue;
      if (e.id === "loader" || e.id === "splash") continue;
      const c = getComputedStyle(e);
      if (c.visibility === "hidden" || Number(c.opacity) < 0.02) continue;
      const k = elementKey(e);
      if (k) return k;
    }
  } catch { /* ignore */ }
  return "";
}

function initOverlayPin(node) {
  node.pin = "auto";
  node.baseScroll = window.scrollY || 0;
  try {
    node.refKey = refKeyAt((Number(node.x) || 0) + (Number(node.width) || 0) / 2, (Number(node.y) || 0) + (Number(node.height) || 0) / 2);
  } catch { node.refKey = ""; }
  return node;
}

/** 取某个页面元素及其祖先叠加后的实际透明度（首页封面淡出就是靠祖先 opacity） */
function effectiveOpacity(el) {
  if (!el || el.nodeType !== 1) return 1;
  let o = 1;
  let n = el;
  for (let i = 0; i < 30 && n && n.nodeType === 1; i += 1) {
    try {
      const c = getComputedStyle(n);
      if (c.display === "none" || c.visibility === "hidden") return 0;
      o *= parseFloat(c.opacity || "1");
    } catch { return o; }
    n = n.parentElement;
  }
  return Math.max(0, Math.min(1, o));
}

function overlayRefEl(node) {
  try {
    const sel = node && node.refKey ? keyToSelector(node.refKey) : "";
    if (sel) {
      const found = document.querySelector(sel);
      if (found) return found;
    }
  } catch { /* ignore */ }
  return null;
}

/** 开场/加载遮罩：这两层盖住整屏时组件直接退场（不用剪裁） */
function introCoverOpacity() {
  let cover = 0;
  for (const sel of ["#splash", "#loader"]) {
    const el = document.querySelector(sel);
    if (!el) continue;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      cover = Math.max(cover, Number(cs.opacity) || 0);
    } catch { /* ignore */ }
  }
  return Math.min(1, Math.max(0, cover));
}

/** 下方升起的黑幕（.rise）当前的上边缘在视口里的 y；没出现时返回 Infinity */
function curtainTopY() {
  try {
    const rise = document.querySelector(".rise") || document.getElementById("rise");
    if (!rise) return Infinity;
    const cs = getComputedStyle(rise);
    if (cs.display === "none" || cs.visibility === "hidden") return Infinity;
    const r = rise.getBoundingClientRect();
    if (!r.height) return Infinity;
    return r.top;
  } catch { return Infinity; }
}

/** 组件被下方黑幕盖住的高度（px）：照着黑幕上边缘把下半部分剪掉，视觉上和周围文字一起被覆盖 */
function curtainClipPx(el) {
  try {
    const ctop = curtainTopY();
    if (!Number.isFinite(ctop)) return 0;
    const r = el.getBoundingClientRect();
    if (r.bottom <= ctop) return 0;
    return Math.max(0, Math.min(r.height, r.bottom - ctop));
  } catch { return 0; }
}

function syncAutoOverlays() {
  let intro = 0;
  try { intro = introCoverOpacity(); } catch { intro = 0; }
  try {
    for (const el of refs.stage.querySelectorAll(".ve-ins")) {
      const info = overlayEntry(el);
      if (!info) continue;
      const n = info.node;
      const pin = overlayPin(n);
      let eff = 1;
      if (pin === "auto") {
        let ref = overlayRefEl(n);
        if (!ref) {
          // 没记到参照元素时：按组件当前中心点找下面的页面元素，并把参照记到节点上（只在内存里，重开会重新推断）
          try {
            const r = el.getBoundingClientRect();
            const k = refKeyAt(r.left + Math.min(r.width / 2, 20), r.top + Math.min(r.height / 2, 10));
            if (k) {
              n.refKey = k;
              const sel = keyToSelector(k);
              ref = sel ? document.querySelector(sel) : null;
            }
          } catch { /* ignore */ }
        }
        eff = ref ? effectiveOpacity(ref) : 1;
      }
      const manual = n.style && n.style.opacity != null ? Math.max(0, Math.min(1, Number(n.style.opacity))) : 1;
      // 开场/加载遮罩盖满整屏时直接退场
      el.style.opacity = String(Math.max(0, Math.min(1, eff * manual * (1 - intro))));
      // 下方黑幕：不淡出，跟着它的上边缘把被盖住的部分剪掉（和周围文字一起被盖住的观感）
      if (pin === "auto") {
        const clip = curtainClipPx(el);
        el.style.clipPath = clip > 0.5 ? `inset(0 0 ${clip.toFixed(1)}px 0)` : "";
      } else {
        el.style.clipPath = "";
      }
    }
  } catch { /* ignore */ }
}

/** 把节点的位置/尺寸/层级写回 DOM（处理 page/screen/auto 三种纵向坐标） */
function placeOverlayEl(el, node) {
  if (!el || !node) return;
  el.style.left = `${Number(node.x) || 0}px`;
  el.style.top = `${overlayTop(node)}px`;
  el.style.width = `${Math.max(1, Number(node.width) || 1)}px`;
  el.style.height = `${Math.max(1, Number(node.height) || 1)}px`;
  el.style.zIndex = String(node.z || 900);
  el.dataset.pinMode = overlayPin(node);
  el.dataset.thin = Number(node.width) < 24 || Number(node.height) < 24 ? "1" : "0";
  // 描边 / 毛玻璃 / 投影（插入元素的外观属性）
  try {
    const s = node.style || {};
    if (s.borderWidth) el.style.border = Math.max(0, Number(s.borderWidth)) + "px solid " + (s.borderColor || "rgba(255,255,255,.35)");
    else el.style.border = "";
    const blur = Number(s.backBlur) || 0;
    el.style.backdropFilter = blur > 0 ? "blur(" + blur + "px)" : "";
    el.style.webkitBackdropFilter = el.style.backdropFilter;
    const sy = s.shadowY;
    const sb = s.shadowBlur;
    const sa = s.shadowAlpha;
    if (sy != null || sb != null || sa != null) {
      el.style.boxShadow = "0 " + (Number(sy) || 6) + "px " + (Number(sb) || 18) + "px rgba(0,0,0," + (sa != null ? Math.max(0, Math.min(1, Number(sa))) : 0.25) + ")";
    } else {
      el.style.boxShadow = "";
    }
  } catch { /* ignore */ }
}

/** 页面滚动时：page 模式跟着页面走，auto 模式跟着邻近图层淡出 */
function syncPinnedOverlays() {
  try {
    for (const el of refs.stage.querySelectorAll(".ve-ins")) {
      const info = overlayEntry(el);
      if (!info) continue;
      if (overlayPin(info.node) === "page") el.style.top = `${overlayTop(info.node)}px`;
    }
  } catch { /* ignore */ }
  syncAutoOverlays();
}

/** 当前正在编辑的插入组件（S.ovEl 可能已失效/被替换，退回当前选中的组件） */
function currentOverlayEl() {
  for (const el of [S.ovEl, S.selected]) {
    if (el && el.nodeType === 1 && el.isConnected && el.dataset && el.dataset.veOverlay) return el;
  }
  return null;
}

/** 编辑已保存的组件时，先把它复制进「待保存层」，否则改动进不了 buildOps（不会保存） */
function editOverlayNode(el) {
  const key = el && el.dataset ? el.dataset.veOverlay : null;
  if (!key) return null;
  if (!S.pending[key] || !S.pending[key].__overlay) {
    const base = S.overrides[key];
    if (!base || !base.__overlay) return null;
    S.pending[key] = clone(base);
    updateDirty();
  }
  // 保存后服务端只回白名单字段，预设/颜色/方向等信息要从 HTML 的 data-ve-meta 里补回来
  return migrateOverlayPreset(S.pending[key].__overlay);
}

function fillOverlayPanel(el) {
  const info = overlayEntry(el);
  if (!info) return;
  const n = info.node;
  ui("#ovX").value = String(Math.round(n.x || 0));
  ui("#ovY").value = String(Math.round(n.y || 0));
  ui("#ovW").value = String(Math.round(n.width || 200));
  ui("#ovH").value = String(Math.round(n.height || 160));
  ui("#ovZ").value = String(Math.round(n.z || 900));
  // 定位：随页面滚动（只出现在插入的那一段）/ 固定在屏幕（每屏都显示）
  {
    const pin = overlayPin(n);
    if (ui("#ovPin")) ui("#ovPin").querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.pin === pin ? "1" : "0"; });
    if (ui("#ovPinRow")) ui("#ovPinRow").hidden = false;
  }
  // 结构化组件参数
  const preset = overlayPresetOf(n);
  const has = (sel) => Boolean(ui(sel));
  if (has("#ovItemsRow")) {
    ui("#ovItemsRow").hidden = preset !== "nav";
    ui("#ovBtnRow").hidden = preset !== "button";
    ui("#ovCardRow").hidden = preset !== "card";
    ui("#ovCardDescRow").hidden = preset !== "card";
    const pr = n.params || {};
    if (preset === "nav") ui("#ovItems").value = (pr.items || []).join(",");
    if (preset === "button") ui("#ovBtnText").value = pr.text || "";
    if (preset === "card") { ui("#ovCardTitle").value = pr.title || ""; ui("#ovCardDesc").value = pr.desc || ""; }
    const st = n.style || {};
    if (has("#ovPad")) ui("#ovPad").value = st.pad != null ? st.pad : "";
    if (has("#ovRadius")) ui("#ovRadius").value = st.radius != null ? st.radius : "";
    if (has("#ovBg")) ui("#ovBg").value = st.bg || "";
    if (has("#ovColorText")) ui("#ovColorText").value = st.color || "";
    if (has("#ovOpacity")) ui("#ovOpacity").value = st.opacity != null ? st.opacity : "";
    if (has("#ovBorderOn")) ui("#ovBorderOn").checked = Boolean(st.borderWidth);
    if (has("#ovBlurOn")) ui("#ovBlurOn").checked = Boolean(st.backBlur);
    if (has("#ovShadowOn")) ui("#ovShadowOn").checked = st.shadowY != null || st.shadowBlur != null || st.shadowAlpha != null;
    if (has("#ovBorderColor")) ui("#ovBorderColor").value = (st.borderColor && String(st.borderColor).startsWith("#")) ? st.borderColor : "#ffffff";
    if (has("#ovBorderWidth")) ui("#ovBorderWidth").value = st.borderWidth != null ? st.borderWidth : "";
    if (has("#ovBackBlur")) ui("#ovBackBlur").value = st.backBlur != null ? st.backBlur : 0;
    if (has("#ovBackBlurNum")) ui("#ovBackBlurNum").value = st.backBlur != null ? st.backBlur : 0;
    if (has("#ovShadowY")) ui("#ovShadowY").value = st.shadowY != null ? st.shadowY : "";
    if (has("#ovShadowBlur")) ui("#ovShadowBlur").value = st.shadowBlur != null ? st.shadowBlur : "";
    if (has("#ovShadowAlpha")) ui("#ovShadowAlpha").value = st.shadowAlpha != null ? st.shadowAlpha : "";
    if (has("#ovRotate")) ui("#ovRotate").value = n.rotate ? String(Math.round(n.rotate)) : "";
    if (has("#ovDivRow")) {
      const isDiv = preset === "divider";
      ui("#ovDivRow").hidden = !isDiv;
      // 分割线用独立的精简面板：只留方向/长度/粗细/线条色/透明度/旋转/位置，
      // 把宽高、内边距、圆角、背景、文字色、层级这些「组件通用」字段藏起来，避免干扰
      const genericRows = ["#ovWHRow", "#ovZRow", "#ovPadRow", "#ovRadiusRow", "#ovBgRow", "#ovColorRow", "#ovBorderRow", "#ovBackBlurRow", "#ovShadowRow"];
      genericRows.forEach((id) => { const row = has(id) ? ui(id) : null; if (row) row.hidden = isDiv; });
      if (has("#ovDivLenRow")) ui("#ovDivLenRow").hidden = !isDiv;
      if (has("#ovDivColorRow")) ui("#ovDivColorRow").hidden = !isDiv;
      if (isDiv) {
        // 方向以数据为准；数据丢了就按元素形状推断（高>宽=竖线），保证面板和画布上的那条线一致
        const dir = (n.params && n.params.dir === "v") || (n.params && n.params.dir === "h")
          ? n.params.dir
          : (Number(n.height) > Number(n.width) ? "v" : "h");
        ui("#ovDivDir").querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.divdir === dir ? "1" : "0"; });
        const len = dir === "v" ? n.height : n.width;
        const thick = n.params && n.params.thick != null ? n.params.thick : 2;
        const col = (n.style && n.style.color) || "#E2DBC8";
        if (has("#ovDivLen")) ui("#ovDivLen").value = String(Math.round(len));
        if (has("#ovDivThick")) ui("#ovDivThick").value = String(thick);
        if (has("#ovDivColor")) ui("#ovDivColor").value = col;
        if (has("#ovDivColorHex")) ui("#ovDivColorHex").value = col;
        // 填色：单色 / 渐变（和文字一样的渐变编辑器，走 --ve-grad 同一套描述）
        fillGradUI("d", el, true);
      } else {
        if (has("#dColorModeRow")) ui("#dColorModeRow").hidden = true;
        if (has("#ovDivColorRow")) ui("#ovDivColorRow").hidden = true;
        if (has("#dGradBox")) ui("#dGradBox").hidden = true;
      }
    }
  }

  const isText = n.tag === "text";
  const isSvg = n.tag === "svg";
  const isImg = n.tag === "img";
  ui("#ovTextRow").hidden = !isText;
  ui("#ovSvgRow").hidden = !isSvg;
  ui("#ovReplaceBtn").hidden = !isImg;
  if (isText) ui("#ovText").value = (n.attrs && n.attrs.text) || "";
  if (isSvg) ui("#ovSvg").value = (n.attrs && n.attrs.html) || "";
  ui("#ovHint").textContent = preset === "divider"
    ? "这是分割线：可切换横线/竖线、调长度/粗细/线条色，保存后写进覆写层"
    : preset
      ? "这是插入的组件：右侧参数实时生效，保存后写进覆写层"
      : isText
        ? "这是插入的一段文字：可改内容/位置/尺寸，保存后写进覆写层"
        : isSvg
          ? "这是插入的 SVG：可改源码/位置/尺寸，保存后写进覆写层"
          : "这是插入的图片：可换图 / 位置 / 尺寸，保存后写进覆写层";
}

function applyOverlayField(field, value) {
  const el = currentOverlayEl();
  if (!el) return;
  const n = editOverlayNode(el); // 已保存的组件先复制进待保存层，否则改动不会保存
  if (!n) return;
  const v = Math.round(Number(value) || 0);
  if (field === "x") n.x = v;
  if (field === "y") n.y = v;
  if (field === "width") n.width = Math.max(1, v);
  if (field === "height") n.height = Math.max(1, v);
  if (field === "z") n.z = v;
  if (field === "rotate") {
    n.rotate = ((v % 360) + 360) % 360;
    el.style.rotate = n.rotate ? n.rotate + "deg" : "";
    const inp = ui("#ovRotate");
    if (inp) inp.value = n.rotate ? String(n.rotate) : "";
    if (overlayPresetOf(n)) refreshPresetEl(el.dataset.veOverlay, n);
    updateDirty();
    return;
  }
  placeOverlayEl(el, n);
  updateDirty();
}

/* 组件参数/样式：改完立即重渲染（不需要保存） */
{
  const applyPreset = () => {
    const el = currentOverlayEl();
    if (!el) return;
    const n = editOverlayNode(el);
    if (!n || !n.preset) return;
    n.params = n.params || {};
    n.style = n.style || {};
    const val = (sel) => (ui(sel) ? ui(sel).value : "");
    if (n.preset === "nav" && ui("#ovItems")) {
      n.params.items = String(val("#ovItems")).split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    }
    if (n.preset === "button") n.params.text = val("#ovBtnText");
    if (n.preset === "card") { n.params.title = val("#ovCardTitle"); n.params.desc = val("#ovCardDesc"); }
    const num = (v) => (v === "" ? null : Number(v));
    const pad = num(val("#ovPad")); if (pad != null) n.style.pad = pad;
    const radius = num(val("#ovRadius")); if (radius != null) n.style.radius = radius;
    if (val("#ovBg")) n.style.bg = val("#ovBg");
    if (val("#ovColorText")) n.style.color = val("#ovColorText");
    const opacity = num(val("#ovOpacity")); if (opacity != null) n.style.opacity = Math.max(0, Math.min(1, opacity));
    if (ui("#ovBorderOn") && !ui("#ovBorderOn").checked) { delete n.style.borderWidth; delete n.style.borderColor; }
    else {
      if (val("#ovBorderColor")) n.style.borderColor = val("#ovBorderColor");
      const bw = num(val("#ovBorderWidth")); if (bw != null) n.style.borderWidth = Math.max(0, bw);
    }
    if (ui("#ovBlurOn") && !ui("#ovBlurOn").checked) delete n.style.backBlur;
    if (ui("#ovShadowOn") && !ui("#ovShadowOn").checked) { delete n.style.shadowY; delete n.style.shadowBlur; delete n.style.shadowAlpha; }
    const bb = num(val("#ovBackBlur")); if (bb != null) n.style.backBlur = Math.max(0, Math.min(40, bb));
    const sy2 = num(val("#ovShadowY")); if (sy2 != null) n.style.shadowY = sy2;
    const sb2 = num(val("#ovShadowBlur")); if (sb2 != null) n.style.shadowBlur = Math.max(0, sb2);
    const sa2 = num(val("#ovShadowAlpha")); if (sa2 != null) n.style.shadowAlpha = Math.max(0, Math.min(1, sa2));
    placeOverlayEl(el, n);
    refreshPresetEl(el.dataset.veOverlay, n);
    syncAutoOverlays();
  };
  for (const id of ["ovItems", "ovBtnText", "ovCardTitle", "ovCardDesc", "ovPad", "ovRadius", "ovBg", "ovColorText", "ovOpacity", "ovBorderOn", "ovBorderColor", "ovBorderWidth", "ovBlurOn", "ovBackBlur", "ovBackBlurNum", "ovShadowOn", "ovShadowY", "ovShadowBlur", "ovShadowAlpha"]) {
    const inp = ui("#" + id);
    if (inp) inp.addEventListener("input", applyPreset);
  }
  // 外观开关：打开时给默认值，关闭时删除属性
  try {
    const wire = (onId, ids, defaults) => {
      const on = ui("#" + onId);
      if (!on || on.dataset.bound === "1") return;
      on.dataset.bound = "1";
      on.addEventListener("change", () => {
        const el = currentOverlayEl();
        if (!el) return;
        if (on.checked) {
          for (const [id, v] of Object.entries(defaults || {})) {
            const inp = ui("#" + id);
            if (inp && !inp.value) inp.value = v;
          }
        }
        applyPreset();
      });
    };
    wire("ovBorderOn", [], { ovBorderWidth: 1, ovBorderColor: "#ffffff" });
    wire("ovBlurOn", [], { ovBackBlur: 12, ovBackBlurNum: 12 });
    wire("ovShadowOn", [], { ovShadowY: 6, ovShadowBlur: 18, ovShadowAlpha: 0.25 });
  } catch { /* ignore */ }
  // 毛玻璃滑条与数字框同步
  try {
    const r = ui("#ovBackBlur");
    const n2 = ui("#ovBackBlurNum");
    if (r && n2 && r.dataset.bound !== "1") {
      r.dataset.bound = "1";
      r.addEventListener("input", () => { n2.value = r.value; });
      n2.addEventListener("input", () => { r.value = n2.value; });
    }
  } catch { /* ignore */ }
  // 分割线方向切换：横线 / 竖线（宽高自动对调，方便直接用）
  shadow.querySelectorAll("[data-divdir]").forEach((b) => b.addEventListener("click", () => {
    const el = currentOverlayEl();
    if (!el || !el.dataset) return;
    const n = editOverlayNode(el);
    if (!n || n.preset !== "divider") return;
    const dir = b.dataset.divdir === "v" ? "v" : "h";
    if (((n.params && n.params.dir) || "h") === dir) return;
    n.params = { ...(n.params || {}), dir };
    const w = n.width;
    const h = n.height;
    n.width = h;
    n.height = w;
    placeOverlayEl(el, n);
    refreshPresetEl(el.dataset.veOverlay, n);
    fillOverlayPanel(el);
    updateDirty();
    toast(dir === "v" ? "已切换为竖线" : "已切换为横线", 1600);
  }));
  // 分割线专用面板：长度 / 粗细 / 线条色（面板只显示这几个 + 透明度/旋转/位置）
  const divLen = ui("#ovDivLen");
  if (divLen) divLen.addEventListener("input", () => {
    const n = editOverlayNode(S.ovEl);
    if (!n || n.preset !== "divider") return;
    const dir = (n.params && n.params.dir) === "v" ? "v" : "h";
    applyOverlayField(dir === "v" ? "height" : "width", divLen.value);
  });
  const divThick = ui("#ovDivThick");
  if (divThick) divThick.addEventListener("input", () => {
    const el = currentOverlayEl();
    if (!el || !el.dataset) return;
    const n = editOverlayNode(el);
    if (!n || n.preset !== "divider") return;
    n.params = { ...(n.params || {}), thick: Math.max(1, Math.round(Number(divThick.value) || 2)) };
    refreshPresetEl(el.dataset.veOverlay, n);
  });
  const applyDivColor = (hex) => {
    const el = currentOverlayEl();
    if (!el || !el.dataset) return;
    const n = editOverlayNode(el);
    if (!n || n.preset !== "divider") return;
    n.style = { ...(n.style || {}), color: hex };
    refreshPresetEl(el.dataset.veOverlay, n);
    syncAutoOverlays();
    try { if (S.selected === el) paintOutline(el); } catch { /* ignore */ }
  };
  const divColor = ui("#ovDivColor");
  if (divColor) {
    const onColor = () => {
      const hexEl = ui("#ovDivColorHex");
      if (hexEl) hexEl.value = divColor.value;
      applyDivColor(divColor.value);
    };
    // Windows / 部分浏览器原生取色器只触发 change、不触发 input，两个都绑上
    divColor.addEventListener("input", onColor);
    divColor.addEventListener("change", onColor);
  }
  const divHex = ui("#ovDivColorHex");
  if (divHex) {
    const apply = () => {
      const raw = String(divHex.value).trim();
      const m6 = /^#?([0-9a-f]{6})$/i.exec(raw);
      const m3 = /^#?([0-9a-f]{3})$/i.exec(raw);
      if (!m6 && !m3) return;
      let c = "#" + (m6 ? m6[1] : m3[1]);
      if (c.length === 4) c = "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
      if (ui("#ovDivColor")) ui("#ovDivColor").value = c;
      applyDivColor(c);
    };
    // 输入到合法 hex 就实时生效，不用等失焦
    divHex.addEventListener("input", () => {
      const raw = String(divHex.value).trim();
      if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) apply();
    });
    divHex.addEventListener("change", apply);
    divHex.addEventListener("blur", apply);
  }
}

["ovX:x", "ovY:y", "ovW:width", "ovH:height", "ovZ:z", "ovRotate:rotate"].forEach((pair) => {
  const [id, field] = pair.split(":");
  const inp = ui("#" + id);
  if (inp) inp.addEventListener("input", () => applyOverlayField(field, inp.value));
});
shadow.querySelectorAll("[data-ovrot]").forEach((b) => b.addEventListener("click", () => {
  const n = editOverlayNode(S.ovEl);
  if (!n) return;
  const cur = Number(n.rotate) || 0;
  const step = Number(b.dataset.ovrot);
  applyOverlayField("rotate", step === 0 ? 0 : cur + step);
}));
// 定位切换：跟随周围（默认，位置固定 + 跟邻近图层一起淡出）/ 随页面滚动 / 固定在屏幕
shadow.querySelectorAll("[data-pin]").forEach((b) => b.addEventListener("click", () => {
  const el = currentOverlayEl();
  if (!el || !el.dataset || !el.dataset.veOverlay) return;
  const n = editOverlayNode(el);
  if (!n) return;
  const mode = ["auto", "page", "screen"].includes(b.dataset.pin) ? b.dataset.pin : "auto";
  if (overlayPin(n) === mode) return;
  const sy = window.scrollY || 0;
  // 先换算成「当前屏幕上的位置」，再按目标模式存
  const viewportTop = overlayPin(n) === "page" ? (Number(n.y) || 0) - sy : (Number(n.y) || 0);
  n.y = mode === "page" ? viewportTop + sy : viewportTop;
  n.pin = mode;
  if (mode === "auto") {
    try {
      const r = el.getBoundingClientRect();
      n.refKey = refKeyAt(r.left + Math.min(r.width / 2, 20), r.top + Math.min(r.height / 2, 10));
    } catch { /* ignore */ }
  }
  placeOverlayEl(el, n);
  if (mode !== "auto") el.style.opacity = "";
  if (overlayPresetOf(n)) refreshPresetEl(el.dataset.veOverlay, n);
  syncAutoOverlays();
  fillOverlayPanel(el);
  updateDirty();
  toast(mode === "auto"
    ? "已设为「跟随周围」：位置固定，跟着邻近图层一起淡出/移动"
    : mode === "page"
      ? "已设为「随页面滚动」：只出现在插入的那一段"
      : "已设为「固定在屏幕」：每屏都会显示", 2400);
}));

{
  const ovText = ui("#ovText");
  if (ovText) {
    ovText.addEventListener("input", () => {
      const n = editOverlayNode(S.ovEl);
      if (!n) return;
      n.attrs = { ...(n.attrs || {}), text: ovText.value };
      if (S.ovEl) S.ovEl.textContent = ovText.value;
      updateDirty();
    });
  }
  const ovSvg = ui("#ovSvg");
  if (ovSvg) {
    ovSvg.addEventListener("input", () => {
      const n = editOverlayNode(S.ovEl);
      if (!n) return;
      n.attrs = { ...(n.attrs || {}), html: ovSvg.value };
      if (S.ovEl) S.ovEl.innerHTML = ovSvg.value;
      updateDirty();
    });
  }
}

async function overlayReplaceImage() {
  const el = currentOverlayEl();
  const info = overlayEntry(el);
  if (!el || !info) return;
  const file = await filePicker("image/*");
  if (!file) return;
  try {
    const url = await upload(file);
    const n = info.node;
    n.tag = "img";
    n.attrs = { src: url };
    // 重新渲染该节点
    const fresh = renderOverlay(info.key, n);
    fresh.dataset.sel = "1";
    try { el.remove(); } catch { /* ignore */ }
    S.ovEl = fresh;
    updateDirty();
    toast("已换成新图片");
  } catch (err) { toast("换图失败：" + err.message, 4000); }
}

function overlayDelete() {
  const el = currentOverlayEl();
  if (!el) return;
  select(el);
  deleteElement();
}

/** 取元素里第一段「可见文字叶子」（面板编辑文字时只改这一段，不碰容器里其它文字） */
function primaryTextLeaf(el) {
  if (!el) return null;
  if (isTextEl(el)) return el;
  const vis = visibleTextNodes(el);
  for (const node of vis) {
    const leaf = node.parentElement;
    if (!leaf) continue;
    if (!isTextEl(leaf)) continue;
    // 逐字/逐词动画：把「单字/单词」升级成整句，避免只能编辑一个字
    if ((leaf.textContent || "").trim().length <= 2) {
      const block = findTextBlock(leaf);
      if (block && block !== leaf) return block;
    }
    return leaf;
  }
  // 兜底：第一个有直接文字的可见元素
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (!effectiveVisible(child)) continue;
      const hasText = [...child.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (hasText && child.childElementCount === 0) return child;
      const deeper = walk(child);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(el);
}

/** 收集容器里的「文字段」：每段=一个整句块（按块元素去重） */
const __veTextNodeKeys = new WeakMap();
let __veTextNodeSeq = 0;

/**
 * 收集容器里的「文字段」：
 *  - 普通叶子元素 → 按整句块分组
 *  - 混合内容（外层 span 里既有直接文本，又有子元素如绿色角标）→ 直接文本单独成段
 * 返回 [{ el, text, leaves, textNodes }]
 */
function textRunsIn(el) {
  if (!el) return [];
  if (isTextEl(el)) return [{ el, text: textOf(el), leaves: [el], textNodes: [] }];
  const map = new Map();
  const push = (key, base) => {
    if (!map.has(key)) map.set(key, { el: base.el, text: "", leaves: [], textNodes: [] });
    return map.get(key);
  };
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const raw = node.nodeValue || "";
    if (raw.trim()) {
      const parent = node.parentElement;
      if (parent) {
        const directMixed = [...parent.childNodes].some((n) => n.nodeType === 1) &&
          [...parent.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue || "").trim());
        if (directMixed) {
          // 混合内容里的直接文本：单独一段，写入时精确改这个文本节点
          let k = __veTextNodeKeys.get(node);
          if (!k) { k = "tn" + (++__veTextNodeSeq); __veTextNodeKeys.set(node, k); }
          const run = push("t:" + k, { el: parent });
          run.textNodes.push(node);
          run.text += raw;
        } else if (isTextEl(parent)) {
          const block = findTextBlock(parent) || parent;
          let k = __veTextNodeKeys.get(block);
          if (!k) { k = "blk" + (++__veTextNodeSeq); __veTextNodeKeys.set(block, k); }
          const run = push("b:" + k, { el: block });
          if (!run.leaves.includes(parent)) run.leaves.push(parent);
          run.text += raw;
        }
      }
    }
    node = walker.nextNode();
  }
  const runs = [];
  for (const run of map.values()) {
    const text = String(run.text || "").replace(/\s+/g, " ").trim();
    if (text) runs.push({ el: run.el, text, leaves: run.leaves, textNodes: run.textNodes });
  }
  if (!runs.length) {
    const text = (canonicalBlockText(el) || el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) runs.push({ el, text, leaves: [], textNodes: [] });
  }
  return runs;
}

/** 只把文字写进这一段的 leaves（逐字/逐词结构保留，不碰同容器其它文字如按钮角标） */
function writeRunText(run, value) {
  const text = String(value ?? "");
  if (!run) return false;
  // ① 混合内容里的直接文本节点：精确写回
  const tns = (run.textNodes || []).filter((n) => n && n.isConnected !== false);
  if (tns.length) {
    tns[0].nodeValue = text;
    for (let i = 1; i < tns.length; i += 1) tns[i].nodeValue = "";
    return true;
  }
  // ② 普通文字叶子：按逐字/逐词分配
  const alive = (run.leaves || []).filter((el) => el && el.isConnected);
  if (!alive.length) return false;
  if (alive.length === 1) { writeText(alive[0], text); return true; }
  const lens = alive.map((el) => (el.textContent || "").trim().length).filter((n) => n > 0);
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const charMode = avg <= 2;
  const tokens = charMode ? [...text] : text.split(/(\s+)/).filter((s) => s.length);
  let ti = 0;
  for (const leaf of alive) {
    let tk = "";
    if (ti < tokens.length) {
      tk = tokens[ti];
      ti += 1;
      if (!charMode && ti < tokens.length && /^\s+$/.test(tokens[ti])) { tk += tokens[ti]; ti += 1; }
    }
    leaf.textContent = tk;
  }
  if (ti < tokens.length) alive[alive.length - 1].textContent += tokens.slice(ti).join("");
  return true;
}

/** 提交文字草稿（保存按钮 / 回车） */
function commitTextDraft() {
  if (!S.draftDirty) { toast("没有待保存的文字修改"); return; }
  const el = S.selected;
  if (!el) return;
  const v = ui("#tContent").value;
  const key = elementKey(el);
  ensureSnapshot(el);
  ensureOrig(el);
  const orig = S.appliedText || "";
  if (S.blockKey && key === S.blockKey && S.blockEl) {
    writeBlockText(S.blockEl, v);
    mutate(key, (e) => { e.blockText = v; });
  } else if (isTextEl(el)) {
    writeText(el, v);
    mutate(key, (e) => { e.text = v; if (e.__orig === undefined) e.__orig = orig; });
  } else if (S.textRun && (S.textRun.leaves || []).some((lf) => lf && lf.isConnected && el.contains(lf)) || (S.textRun.textNodes || []).some((nd) => nd && nd.parentElement && el.contains(nd.parentElement))) {
    // 精确写「这一段的 leaves」，不会误改同容器里的按钮/角标文字
    const okWrite = writeRunText(S.textRun, v);
    if (okWrite) {
      const leafKey = elementKey(S.textRun.leaves[0]) || key;
      mutate(leafKey, (e) => { e.text = v; if (e.__orig === undefined) e.__orig = orig; });
    }
  } else if (S.textLeaf && el.contains(S.textLeaf)) {
    // 容器里选中的「主文字段」：只改这一段
    const leaf = S.textLeaf;
    const leafKey = elementKey(leaf);
    ensureSnapshot(leaf);
    ensureOrig(leaf);
    if (isTextEl(leaf)) {
      writeText(leaf, v);
      mutate(leafKey, (e) => { e.text = v; if (e.__orig === undefined) e.__orig = orig; });
    } else {
      writeBlockText(leaf, v);
      mutate(leafKey, (e) => { e.blockText = v; });
    }
  } else if (el.textContent && el.textContent.trim().length > 0) {
    // 兜底：整段回填
    writeBlockText(el, v);
    mutate(key, (e) => { e.blockText = v; });
  } else {
    toast("这个元素没有可编辑文字");
    return;
  }
  S.appliedText = v;
  S.draftDirty = false;
  toast("文字已应用到页面（点上方「保存」才写回源码）");
}

function cancelTextDraft() {
  if (!S.draftDirty) { toast("没有待取消的修改"); return; }
  ui("#tContent").value = S.appliedText || "";
  S.draftDirty = false;
  toast("已取消这次文字修改");
}

/** 重置这个元素：清掉覆写 + 用初次改动前的 DOM 快照还原，立即生效 */
function resetElement() {
  const el = S.selected;
  if (!el) return;
  const key = elementKey(el);
  let fresh = el;
  const snapshot = S.snapshots && S.snapshots[key];
  if (snapshot) {
    try {
      const tpl = document.createElement("template");
      tpl.innerHTML = snapshot.trim();
      const node = tpl.content.firstElementChild;
      if (node && el.parentElement) {
        el.replaceWith(node);
        fresh = node;
      }
    } catch { /* 快照还原失败就只清覆写 */ }
  }
  // 注意：不要再用 restoreOriginal（它记录的 orig.text 可能是改动后的值）；
  // DOM 已按快照还原，这里只需要清掉覆写层，让样式表也不再生效
  delete S.pending[key];
  if (S.overrides) delete S.overrides[key];
  if (S.snapshots) delete S.snapshots[key];
  if (S.orig) delete S.orig[key];
  refreshStylesheet();
  updateDirty();
  S.draftDirty = false;
  select(null);
  select(fresh);
  toast("已重置这个元素（立即生效；点上方保存会写回源码）");
}

/** 删除入口：插入的元素直接删；页面元素弹确认（隐藏推荐 / 仍然删除） */
function deleteElement() {
  const el = S.selected;
  if (!el) return;
  if (el.__veOverlayId) {
    const key = el.dataset.veOverlay;
    try { el.remove(); } catch { /* ignore */ }
    if (key) {
      delete S.pending[key];
      if (S.overrides[key]) S.removedKeys.add(key);
    }
    S.ovEl = null;
    { const ov = ui("#ovPanel"); if (ov) ov.hidden = true; }
    updateDirty();
    toast("已删除插入的元素");
    select(null);
    return;
  }
  S.delEl = el;
  ui("#delModal").hidden = false;
}

/** 隐藏元素（推荐） */
function hideSelectedElement(el) {
  const target = el || S.selected;
  if (!target) return;
  const key = elementKey(target);
  mutate(key, (e) => { e.hidden = true; delete e.removed; });
  refreshStylesheet();
  updateQuickState();
  toast("已隐藏：点「👁 显示」或「重置这个元素」可恢复，Ctrl+Z 也能撤销", 4000);
}

/** 真正删除：隐藏 + 打上 removed 标记（保存后仍是删除状态，可重置/Ctrl+Z 恢复） */
function reallyDeleteElement(el) {
  const target = el || S.selected;
  if (!target) return;
  const key = elementKey(target);
  mutate(key, (e) => { e.hidden = true; e.removed = true; });
  refreshStylesheet();
  updateQuickState();
  toast("已删除（想找回：选中状态下点「重置这个元素」，或按 Ctrl+Z 撤销）", 4800);
}

/** 面板内输入弹层（Electron 的 prompt() 不可用，必须用自绘的） */
function askText({ title = "输入", placeholder = "", value = "" } = {}) {
  return new Promise((resolve) => {
    const modal = ui("#askModal");
    ui("#askTitle").textContent = title;
    const input = ui("#askInput");
    input.value = value;
    input.placeholder = placeholder;
    modal.hidden = false;
    input.focus();
    S.askResolve = resolve;
  });
}

function closeAsk(value) {
  const modal = ui("#askModal");
  if (modal) modal.hidden = true;
  const resolve = S.askResolve;
  S.askResolve = null;
  if (resolve) resolve(value);
}

async function insertText() {
  const text = await askText({ title: "插入文字", placeholder: "输入要插入的文字", value: "新文字" });
  if (!text) return;
  addOverlayNode("text", { text: text.trim() });
}

async function insertSvg() {
  const code = await askText({ title: "插入 SVG", placeholder: "粘贴 <svg> 源码" });
  if (!code) return;
  if (!/^\s*<svg[\s>]/i.test(code.trim())) { toast("这不像 SVG 源码"); return; }
  addOverlayNode("svg", { html: code.trim() });
}

/** 在新窗口打开当前页面：侧边栏是宿主嵌入视图放不大，新窗口里可以 F11 全屏，编辑也实时生效 */
/** 纯预览窗口：单独开一个干净窗口，URL 带 ve_pure=1；刷新/录屏都保持纯预览（无编辑器界面） */
function openPureWindow() {
  try {
    const url = new URL(location.href);
    ["ve", "ve_embed", "ve_win", "ve_preview", "ve_pure"].forEach((k) => url.searchParams.delete(k));
    url.searchParams.set("ve_pure", "1");
    url.hash = "";
    const win = window.open(url.toString(), "_blank", "popup=1,width=1700,height=1000,menubar=no,toolbar=no,location=no,status=no");
    if (!win) {
      enterPurePreview();
      toast("浏览器拦截了新窗口，已在当前窗口进入纯预览；允许弹出窗口后重试即可用独立窗口", 6500);
    }
  } catch (err) {
    enterPurePreview();
  }
}

function openInNewWindow() {
  try {
    const url = new URL(location.href);
    // 新窗口不要再继承“嵌入模式”参数，否则工具栏还是隐藏的
    url.searchParams.delete("ve");
    url.searchParams.delete("ve_embed");
    url.searchParams.set("ve_win", "1");
    const win = window.open(url.toString(), "_blank");
    if (!win) toast("浏览器拦截了新窗口：允许弹出窗口后重试，或手动打开 " + url.toString(), 6500);
  } catch (err) {
    toast("打开新窗口失败：" + (err && err.message ? err.message : err), 4000);
  }
}

function fillPanel(el, key) {
  const entry = entryOf(key) || {};
  const textish = Boolean(el.textContent && el.textContent.trim().length > 0 && !["SCRIPT", "STYLE", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  const canText = isTextEl(el) || textish;
  // 注意：不要在这里自动进入「整段」模式，否则会按整块合并文本；
  // 面板优先编辑「主文字段」（primaryTextLeaf），需要整块时用户点「整段文字」
  const blockEntry = entryOf(elementKey(el)) || {};
  const inBlock = S.blockKey && elementKey(el) === S.blockKey;
  let txt = "";
  let textHint = "";
  if (isTextEl(el)) {
    txt = textOf(el).slice(0, 4000);
  } else if (typeof blockEntry.blockText === "string") {
    txt = blockEntry.blockText;
  } else if (inBlock) {
    txt = canonicalBlockText(el).slice(0, 4000);
  } else if (textish) {
    const runs = textRunsIn(el);
    S.textRuns = runs;
    if (runs.length) {
      // 默认选「最长的一段」，避免挑到按钮/角标上的小字（例如绿色的 24 times）
      let best = 0;
      const weight = (run) => {
        let w = run.text.length;
        try { if (run.el.closest && run.el.closest("button,[role='button']")) w -= 200; } catch { /* ignore */ }
        return w;
      };
      for (let i = 1; i < runs.length; i += 1) if (weight(runs[i]) > weight(runs[best])) best = i;
      S.textRunIndex = best;
      const run = runs[best];
      S.textLeaf = run.el;
      S.textRun = run;
      txt = String(run.text || "").slice(0, 4000);
      textHint = runs.length > 1
        ? "这个容器里有 " + runs.length + " 段文字，正在编辑第 " + (best + 1) + " 段（用上方「文字段」切换）"
        : "正在编辑这一小段文字（" + run.el.tagName.toLowerCase() + "）：想改整块请点顶部「整段文字」";
    } else {
      S.textLeaf = null;
      S.textRuns = [];
      txt = canonicalBlockText(el).slice(0, 4000);
      textHint = "整个容器的文字（合并显示）";
    }
  }
  const isCanvas = el.tagName === "CANVAS";
  const isImg = el.tagName === "IMG" || el.tagName === "VIDEO";
  const isSvg = el.tagName.toLowerCase() === "svg";

  // 文字
  ui("#tContent").value = txt;
  S.appliedText = txt;
  S.draftDirty = false;
  if (ui("#tTextHint")) { ui("#tTextHint").textContent = textHint; ui("#tTextHint").hidden = !textHint; }
  {
    const runRow = ui("#tRunRow");
    const runSel = ui("#tRunSelect");
    const runs = S.textRuns || [];
    if (runRow && runSel) {
      runRow.hidden = runs.length <= 1;
      runSel.innerHTML = runs.map((r, i) => '<option value="' + i + '">第' + (i + 1) + '段：' + String(r.text).slice(0, 22).replace(/</g, "&lt;") + (String(r.text).length > 22 ? "…" : "") + '</option>').join("");
      runSel.value = String(S.textRunIndex || 0);
    }
  }
  const inBlockMode = S.blockKey && elementKey(el) === S.blockKey;
  // 永不 disable：disabled 的 textarea 会导致双击/Ctrl+A/拖选/Shift 全都不响应（就是"选不中文字"的元凶）
  ui("#tContent").disabled = false;
  ui("#tContent").readOnly = false;
  ui("#tContent").placeholder = canText ? "" : "这个元素没有可编辑文字（图片 / SVG / 画布等）";
  ui("#tSize").value = Math.round(px(cs(el, "font-size"), 16));
  ui("#tWeight").innerHTML = WEIGHTS.map((w) => `<option value="${w}">${w}</option>`).join("");
  ui("#tWeight").value = String(clamp(Math.round(Number(cs(el, "font-weight")) / 100) * 100 || 400, 300, 900));
  ui("#tLine").value = numOrEmpty(cs(el, "line-height"));
  ui("#tSpacing").value = numOrEmpty(cs(el, "letter-spacing"));
  const color = rgbToHex(cs(el, "color"));
  // 渐变生效时，单色控件显示渐变的第一个节点颜色，免得面板上总是一片「透明」的 #000000
  const startGrad = gradOf(key);
  const solidColor = startGrad && startGrad.stops.length ? startGrad.stops[0].color : color;
  ui("#tColor").value = solidColor;
  ui("#tColorHex").value = solidColor;
  fillGradUI("t", el, Boolean(canText) && !svgIn(el));
  {
    const fam = cs(el, "font-family") || "";
    const sel = ui("#tFamily");
    const opt = [...sel.options].find((o) => o.value && fam.replace(/["']/g, "").includes(o.value.split(",")[0].replace(/["']/g, "").trim()));
    sel.value = opt ? opt.value : (entry.style?.["font-family"] || "");
  }
  const align = cs(el, "text-align");
  shadow.querySelectorAll("#tAlign button").forEach((b) => { b.dataset.on = b.dataset.align === align ? "1" : "0"; });

  // 跳转链接（a / area）
  const linkEl = el.closest ? el.closest("a[href]") : null;
  S.linkEl = linkEl || null;
  const linkRow = ui("#linkRow");
  if (linkRow) linkRow.hidden = !linkEl;
  if (linkEl) ui("#tHref").value = linkEl.getAttribute("href") || "";

  // 图片 / SVG 图标
  const entryForKey = entryOf(key) || {};
  ui("#iSrc").value = isImg ? el.getAttribute("src") || "" : (isSvg ? "（内联 SVG，可用下方按钮换图或粘贴 SVG）" : (entryForKey.image || ""));
  const svgEl = isSvg ? el : (el.querySelector ? el.querySelector("svg") : null);
  if (svgEl && ui("#iColor")) ui("#iColor").value = getComputedStyle(svgEl).color || "";
  // 图片页：按元素类型只显示该用的控件
  try {
    const tagName = el.tagName.toLowerCase();
    const ownSvg = tagName === "svg";
    const mediaTag = ["img", "svg", "canvas", "video"].includes(tagName);
    const isContainer = !mediaTag && (el.childElementCount > 0);
    const rowOf = (sel) => { const n = ui(sel); return n ? n.closest(".ve-row") : null; };
    const setHidden = (sel, hidden) => { const n = ui(sel); if (n) n.hidden = hidden; };
    const rowHidden = (sel, hidden) => { const r = rowOf(sel); if (r) r.hidden = hidden; };
    const colorRow = ui("#iColorModeRow");
    const bgBox = ui("#iBgBox");
    const gradBox = ui("#iGradBox");
    const solidRow = ui("#iColorRow");
    if (isContainer) {
      // 容器：只给「背景」（改自己背景色），其余隐藏
      fillGradUI("i", el, false);
      if (colorRow) colorRow.hidden = true;
      if (gradBox) gradBox.hidden = true;
      if (solidRow) solidRow.hidden = true;
      rowHidden("#iSrc", true); rowHidden("#iAlt", true); setHidden("#iFit", true);
      const btnR = shadow.querySelector('[data-act="replace-image"]'); if (btnR) btnR.hidden = true;
      const btnP = shadow.querySelector('[data-act="paste-svg"]'); if (btnP) btnP.hidden = true;
      const btnI = shadow.querySelector('[data-act="insert-image"]'); if (btnI) btnI.hidden = false;
      if (bgBox) { bgBox.hidden = false; fillBgUI(el); }
      if (ui("#iHint")) ui("#iHint").textContent = "这是容器（" + tagName + "）：用上面的「背景」改它自己的背景色/透明度/毛玻璃。要改内部图标，双击进入组后再选中 svg。";
    } else if (ownSvg) {
      fillGradUI("i", el, true);
      if (colorRow) colorRow.hidden = false;
      if (bgBox) bgBox.hidden = true;
      rowHidden("#iSrc", true); rowHidden("#iAlt", true); setHidden("#iFit", true);
      const btnR = shadow.querySelector('[data-act="replace-image"]'); if (btnR) btnR.hidden = true;
      const btnP = shadow.querySelector('[data-act="paste-svg"]'); if (btnP) btnP.hidden = false;
      if (ui("#iHint")) ui("#iHint").textContent = "内联 SVG：单色/渐变作用在它的 fill/stroke 上；尺寸可改宽高。";
    } else if (tagName === "img") {
      fillGradUI("i", el, false);
      if (colorRow) colorRow.hidden = true;
      if (gradBox) gradBox.hidden = true;
      if (solidRow) solidRow.hidden = true;
      if (bgBox) bgBox.hidden = true;
      rowHidden("#iSrc", false); rowHidden("#iAlt", false); setHidden("#iFit", false);
      const btnR = shadow.querySelector('[data-act="replace-image"]'); if (btnR) btnR.hidden = false;
      const btnP = shadow.querySelector('[data-act="paste-svg"]'); if (btnP) btnP.hidden = true;
      if (ui("#iHint")) ui("#iHint").textContent = "";
    } else {
      fillGradUI("i", el, false);
      if (colorRow) colorRow.hidden = true;
      if (gradBox) gradBox.hidden = true;
      if (bgBox) bgBox.hidden = true;
      rowHidden("#iSrc", true); rowHidden("#iAlt", true); setHidden("#iFit", true);
      const btnR = shadow.querySelector('[data-act="replace-image"]'); if (btnR) btnR.hidden = true;
      const btnP = shadow.querySelector('[data-act="paste-svg"]'); if (btnP) btnP.hidden = true;
      if (ui("#iHint")) ui("#iHint").textContent = "选中的不是图片/画布/容器。";
    }
  } catch { /* ignore */ }
  ui("#iAlt").value = el.getAttribute("alt") || "";
  shadow.querySelectorAll("#iFit button").forEach((b) => { b.dataset.on = b.dataset.fit === (el.style.objectFit || cs(el, "object-fit")) ? "1" : "0"; });
  ui("#iHint").textContent = isCanvas
    ? "这是 canvas：改尺寸会同步 width/height 并触发 resize；页面若注册了 __VE_HOOKS__.resizeCanvas，three.js 会真正适配。"
    : (isSvg || svgEl)
      ? "内联 SVG：可以直接改宽高和填充色；「渐变」会把渐变注入页面 defs，保存后重开预览仍然生效（描边图标自动作用在 stroke 上）。"
      : isImg ? "" : "选中的不是图片/画布。可以先选中 <img>，或用「插入新图片」。";
  ui("#iHint").textContent = ui("#iHint").textContent || "";

  // 尺寸
  const r = rectOf(el);
  const w = Math.round(px(el.style.width) ?? r.width);
  const h = Math.round(px(el.style.height) ?? r.height);
  aspectRatio = h ? w / h : 1;
  ui("#sW").value = w;
  ui("#sH").value = h;
  ui("#sX").value = Math.round(entry.box?.x || 0);
  ui("#sY").value = Math.round(entry.box?.y || 0);
  ui("#sZ").value = cs(el, "z-index") === "auto" ? 0 : Number(cs(el, "z-index")) || 0;
  { const lb = ui("#lockBtn"); if (lb) { lb.dataset.on = lockAspect ? "1" : "0"; lb.textContent = lockAspect ? "🔒" : "🔗"; } }
  ui("#sizeHint").textContent = isCanvas
    ? (S.hooks || window.__VE_HOOKS__)
      ? "已检测到 resizeCanvas 钩子：拖动尺寸会正确适配渲染。"
      : "没检测到钩子：目前只改 CSS 尺寸并触发 resize，必要时页面里注册 __VE_HOOKS__.resizeCanvas。"
    : isTextEl(el) ? "文字元素建议用等比 + 自动高度。" : "";

  // 外观：描边 / 毛玻璃 / 投影（检测已有属性；没有则开关默认关）
  try {
    const cs2 = getComputedStyle(el);
    let bw = parseFloat(cs2.borderTopWidth) || 0;
    let bc = cs2.borderTopColor || "";
    // 文字：描边用 -webkit-text-stroke
    if (isTextTarget(el)) {
      const tw = parseFloat(cs2.webkitTextStrokeWidth) || 0;
      if (tw > 0) { bw = tw; bc = cs2.webkitTextStrokeColor || bc; }
    }
    // SVG：描边来自 stroke（可能在子 path 上）
    try {
      const isSvgEl = el.tagName && el.tagName.toLowerCase() === "svg";
      const svgRoot = isSvgEl ? el : (el.ownerSVGElement || null);
      if (svgRoot) {
        const pathEl = svgRoot.querySelector ? svgRoot.querySelector("path, line, circle, rect, polyline") : null;
        const st = pathEl ? getComputedStyle(pathEl) : getComputedStyle(svgRoot);
        const sw = parseFloat(st.strokeWidth) || 0;
        const sc = st.stroke && st.stroke !== "none" ? st.stroke : "";
        if (sw > 0 && sc) { bw = sw; bc = sc; }
      }
    } catch { /* ignore */ }
    const shRaw = isTextTarget(el) ? (cs2.textShadow || "") : (cs2.boxShadow || "");
    if (!bw && /inset/.test(shRaw) && /rgba?\(/.test(shRaw)) {
      const cm = shRaw.match(/rgba?\([^)]+\)/);
      if (cm) { bw = 1; bc = cm[0]; }
    }
    const hexOf = (v) => {
      const m = String(v || "").match(/rgba?\(([^)]+)\)/);
      if (!m) return "#ffffff";
      const p = m[1].split(",").map((x) => parseFloat(x.trim()));
      return "#" + [p[0], p[1], p[2]].map((n) => Math.round(n || 0).toString(16).padStart(2, "0")).join("");
    };
    if (ui("#aBorderColor")) ui("#aBorderColor").value = hexOf(bc);
    if (ui("#aBorderWidth")) ui("#aBorderWidth").value = bw ? Math.round(bw) : "";
    if (ui("#aBorderOn")) ui("#aBorderOn").checked = bw > 0;
    const bf = cs2.backdropFilter || cs2.webkitBackdropFilter || "";
    const bm = bf.match(/blur\(([\d.]+)px\)/);
    const blurN = bm ? Math.round(parseFloat(bm[1])) : 0;
    if (ui("#aBackBlur")) ui("#aBackBlur").value = blurN;
    if (ui("#aBackBlurNum")) ui("#aBackBlurNum").value = blurN;
    if (ui("#aBlurOn")) ui("#aBlurOn").checked = blurN > 0;
    const sh = isTextTarget(el) ? (cs2.textShadow || "") : (cs2.boxShadow || "");
    const shNums = sh && sh !== "none" ? (sh.match(/-?\d+(?:\.\d+)?px/g) || []).map((x) => parseFloat(x)) : [];
    if (ui("#aShadowY")) ui("#aShadowY").value = shNums.length ? shNums[0] : "";
    if (ui("#aShadowBlur")) ui("#aShadowBlur").value = shNums.length > 1 ? shNums[1] : "";
    const am = sh && sh !== "none" ? sh.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/) : null;
    if (ui("#aShadowAlpha")) ui("#aShadowAlpha").value = am ? am[1] : "";
    if (ui("#aShadowOn")) ui("#aShadowOn").checked = Boolean(sh && sh !== "none");
    // 文字效果（独立于容器描边/投影）
    try {
      const textLike = (() => {
        if (!el || el.nodeType !== 1) return false;
        const tag = String(el.tagName || "").toUpperCase();
        if (["IMG", "SVG", "CANVAS", "VIDEO", "IFRAME"].includes(tag)) return false;
        return el.childElementCount === 0 && String(el.textContent || "").trim().length > 0;
      })();
      if (textLike) {
        const tw = parseFloat(cs2.webkitTextStrokeWidth) || 0;
        if (ui("#tStrokeOn")) ui("#tStrokeOn").checked = tw > 0;
        if (ui("#tStrokeWidth")) ui("#tStrokeWidth").value = tw ? Math.round(tw) : "";
        if (ui("#tStrokeColor")) ui("#tStrokeColor").value = hexOf(cs2.webkitTextStrokeColor || bc);
        const ts = cs2.textShadow || "";
        const tn = ts && ts !== "none" ? (ts.match(/-?\d+(?:\.\d+)?px/g) || []).map((x) => parseFloat(x)) : [];
        if (ui("#tShadowOn")) ui("#tShadowOn").checked = Boolean(tn.length);
        if (ui("#tShadowY")) ui("#tShadowY").value = tn.length ? tn[0] : "";
        if (ui("#tShadowBlur")) ui("#tShadowBlur").value = tn.length > 1 ? tn[1] : "";
        const tam = ts && ts !== "none" ? ts.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/) : null;
        if (ui("#tShadowAlpha")) ui("#tShadowAlpha").value = tam ? tam[1] : "";
        const tbf = (cs2.backdropFilter || "").match(/blur\(([\d.]+)px\)/);
        if (ui("#tGlassOn")) ui("#tGlassOn").checked = Boolean(tbf);
        if (ui("#tGlassBlur")) ui("#tGlassBlur").value = tbf ? Math.round(parseFloat(tbf[1])) : "";
        if (ui("#tGlassBlurNum")) ui("#tGlassBlurNum").value = tbf ? Math.round(parseFloat(tbf[1])) : "";
      }
    } catch { /* ignore */ }
    const op = Number(cs2.opacity);
    const opVal = Number.isFinite(op) ? op : 1;
    if (ui("#aOpacity")) ui("#aOpacity").value = String(opVal);
    if (ui("#aOpacityNum")) ui("#aOpacityNum").value = String(opVal);
  } catch { /* ignore */ }
  // 外观开关的可用状态
  try {
    const setEn = (on, sels) => { for (const s of sels) { const n = ui(s); if (n) n.disabled = !on; } };
    setEn(Boolean(ui("#aBorderOn") && ui("#aBorderOn").checked), ["#aBorderColor", "#aBorderWidth"]);
    setEn(Boolean(ui("#aBlurOn") && ui("#aBlurOn").checked), ["#aBackBlur", "#aBackBlurNum"]);
    setEn(Boolean(ui("#aShadowOn") && ui("#aShadowOn").checked), ["#aShadowY", "#aShadowBlur", "#aShadowAlpha"]);
  } catch { /* ignore */ }
  // 布局
  fillQuad(["bMarginT", "bMarginR", "bMarginB", "bMarginL"], ["margin-top", "margin-right", "margin-bottom", "margin-left"], el);
  fillQuad(["bPaddingT", "bPaddingR", "bPaddingB", "bPaddingL"], ["padding-top", "padding-right", "padding-bottom", "padding-left"], el);
  fillQuad(["bRadiusTL", "bRadiusTR", "bRadiusBR", "bRadiusBL"], ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"], el);
  ui("#bMarginLock").dataset.on = S.lockMargin ? "1" : "0";
  ui("#bPaddingLock").dataset.on = S.lockPadding ? "1" : "0";
  ui("#bRadiusLock").dataset.on = S.lockRadius ? "1" : "0";
  ui("#bOpacity").value = entry.style?.["opacity"] || cs(el, "opacity");
  ui("#bDisplay").value = entry.style?.["display"] || "";
  {
    const rot = parseFloat(entry.style?.["rotate"]);
    ui("#bRotate").value = Number.isFinite(rot) && rot !== 0 ? String(rot) : "";
  }
  ui("#bTransform").value = entry.style?.["transform"] || (cs(el, "transform") === "none" ? "" : cs(el, "transform"));
  { const hb = ui("#hideBtn"); if (hb) hb.textContent = entry.hidden ? "取消隐藏" : "隐藏这个元素"; }
}

function cssShorthand(el, prop) {
  const parts = ["top", "right", "bottom", "left"].map((s) => cs(el, `${prop}-${s}`));
  return parts.join(" ");
}

function rgbToHex(rgb) {
  const m = String(rgb).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return "#111111";
  return "#" + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, "0")).join("");
}

/* ────────────────────────────── 渐变（文字 / SVG） ──────────────────────────────
 * 覆写层里只记一个 `--ve-grad` 描述（多节点，格式见 core.mjs 的 parseGradSpec）。
 * 面板交互：单色 / 渐变切换 → 渐变拉条（两端圆点、点中间加节点、拖动调位置）
 *           → 选中节点：颜色 + 透明度 → 角度圆盘 + 数字。
 * · 文字：styleToCss 展开成 background-image + background-clip:text
 * · SVG ：styleToCss 展开成 fill/stroke:url(#veGrad-xxx)，对应 <linearGradient>
 *         由这里的 syncSvgGrads() 注入文档；保存/重开预览时按覆写层重新生成。
 */

const GRAD_DEFS_SVG_ID = "__ve_svg_grad_defs";

/** 文档里放 <linearGradient> 的隐藏 <svg>，返回它的 <defs> */
function gradDefs() {
  let svg = document.getElementById(GRAD_DEFS_SVG_ID);
  if (svg && svg.isConnected && svg.firstElementChild) return svg.firstElementChild;
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", GRAD_DEFS_SVG_ID);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none";
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.documentElement.appendChild(svg);
  return defs;
}

/** 把覆写层里所有「SVG 目标」的渐变同步成文档里的 <linearGradient> */
function syncSvgGrads(entries) {
  try {
    const wanted = new Map();
    for (const [key, entry] of Object.entries(entries || {})) {
      const g = parseGradSpec(entry && entry.style && entry.style["--ve-grad"]);
      if (!g || g.target === "text") continue;
      wanted.set(gradId(key), g);
    }
    if (!wanted.size && !document.getElementById(GRAD_DEFS_SVG_ID)) return;
    const defs = gradDefs();
    for (const node of [...defs.children]) if (!wanted.has(node.id)) node.remove();
    for (const [id, g] of wanted) {
      let node = defs.querySelector(`#${id}`);
      if (!node) {
        node = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
        node.setAttribute("id", id);
        node.setAttribute("gradientUnits", "objectBoundingBox");
        defs.appendChild(node);
      }
      const v = gradVector(g.angle);
      node.setAttribute("x1", String(v.x1));
      node.setAttribute("y1", String(v.y1));
      node.setAttribute("x2", String(v.x2));
      node.setAttribute("y2", String(v.y2));
      node.textContent = "";
      for (const s of gradStops(g)) {
        const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
        stop.setAttribute("offset", `${round(s.offset * 100, 2)}%`);
        stop.setAttribute("stop-color", s.color);
        stop.setAttribute("stop-opacity", String(s.alpha));
        node.appendChild(stop);
      }
    }
  } catch (e) { console.warn("[ve] 渐变同步失败", e); }
}

/** 渐变编辑用的 key：插入组件用 overlay:xxx，普通元素用选择器 key */
function gradKeyOf(el) {
  if (el && el.dataset && el.dataset.veOverlay) return el.dataset.veOverlay;
  return elementKey(el);
}

function gradOf(key) {
  const entry = entryOf(key) || {};
  if (entry.__overlay) {
    const p = entry.__overlay.params || {};
    return p.fill === "grad" && p.grad ? parseGradSpec(p.grad) : null;
  }
  return parseGradSpec(entry.style && entry.style["--ve-grad"]);
}

/** 选中元素是不是（或包含）SVG —— 决定渐变作用到文字还是 fill/stroke */
function svgIn(el) {
  if (!el) return null;
  if (el.tagName && el.tagName.toLowerCase() === "svg") return el;
  return el.querySelector ? el.querySelector("svg") : null;
}

/** SVG 该染 fill 还是 stroke（描边图标用 stroke，填充图标用 fill，两个都用就 both） */
function svgGradTarget(el) {
  const svg = svgIn(el);
  if (!svg) return "fill";
  let fill = false;
  let stroke = false;
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    try {
      const c = getComputedStyle(node);
      if (c.fill && c.fill !== "none" && c.fill !== "rgba(0, 0, 0, 0)") fill = true;
      if (c.stroke && c.stroke !== "none" && c.stroke !== "rgba(0, 0, 0, 0)" && parseFloat(c.strokeWidth) > 0) stroke = true;
      if (fill && stroke) break;
    } catch { /* ignore */ }
  }
  if (fill && stroke) return "both";
  return stroke ? "stroke" : "fill";
}

function hexRgbOf(hex) {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clearTextGradProps(e) {
  if (!e || !e.style) return;
  for (const p of ["background-image", "background-clip", "-webkit-background-clip", "-webkit-text-fill-color"]) delete e.style[p];
  if (e.style.color === "transparent") delete e.style.color;
}

/** 摘掉渐变（文字顺带把透明字色还原） */
function removeGrad(key, el) {
  const entry = entryOf(key) || {};
  if (entry.__overlay) {
    const n = el ? editOverlayNode(el) : null;
    if (n) { n.params = { ...(n.params || {}), fill: "solid" }; refreshPresetEl(key, n); }
    return;
  }
  const isSvg = Boolean(svgIn(el));
  mutate(key, (e) => {
    if (!e.style) return;
    delete e.style["--ve-grad"];
    if (!isSvg) clearTextGradProps(e);
  });
}

function applyGradState(key, state) {
  const entry = entryOf(key) || {};
  if (entry.__overlay) {
    // 插入组件（分割线）的渐变：写进节点参数，重新生成组件 HTML
    const el = [...refs.stage.querySelectorAll(".ve-ins")].find((n) => n.dataset.veOverlay === key);
    const n = el ? editOverlayNode(el) : null;
    if (!n) return;
    n.params = { ...(n.params || {}), fill: "grad", grad: gradSpec(state) };
    refreshPresetEl(key, n);
    return;
  }
  mutate(key, (e) => {
    e.style = { ...(e.style || {}) };
    e.style["--ve-grad"] = gradSpec(state);
  });
}

/** 默认渐变：文字用「当前色 → 透明」；分割线用「两端渐隐」的三节点 */
function gradDefaultState(el) {
  if (el && el.dataset && el.dataset.veOverlay) {
    const info = overlayEntry(el);
    const n = info && info.node;
    const c = (n && n.style && n.style.color) || "#E2DBC8";
    const dir = n && n.params && n.params.dir === "v" ? "v" : "h";
    return {
      angle: dir === "v" ? 180 : 90,
      target: "fill",
      stops: [
        { offset: 0, color: c, alpha: 0 },
        { offset: 0.5, color: c, alpha: 1 },
        { offset: 1, color: c, alpha: 0 },
      ],
    };
  }
  const color = rgbToHex(cs(el, "color"));
  const target = svgIn(el) ? svgGradTarget(el) : "text";
  return {
    angle: 90,
    target,
    stops: [
      { offset: 0, color, alpha: 1 },
      { offset: 1, color, alpha: 0 },
    ],
  };
}

/* —— 渐变编辑器（面板） —— */

function gradEditOf() {
  const G = S.gradEdit;
  if (!G || !G.el || !G.el.isConnected) return null;
  return G;
}

/** 打开/复用渐变编辑器：确保这一元素有 --ve-grad，选中第一个节点 */
function openGradEdit(prefix, el) {
  const key = gradKeyOf(el);
  let state = gradOf(key);
  if (!state) {
    state = gradDefaultState(el);
    applyGradState(key, state);
    state = gradOf(key) || state;
  }
  S.gradEdit = { el, key, prefix, state, sel: state.stops[0] || null };
  renderGradEdit(prefix);
}

/** 提交：写回覆写层 → 重新渲染面板 */
function commitGradEdit(prefix, apply) {
  const G = gradEditOf();
  if (!G) return;
  G.state.stops.sort((a, b) => a.offset - b.offset);
  if (!G.state.stops.some((s) => s === G.sel)) G.sel = G.state.stops[0] || null;
  if (apply) applyGradState(G.key, G.state);
  renderGradEdit(prefix);
}

function renderGradEdit(prefix) {
  const G = gradEditOf();
  if (!G) return;
  const box = ui("#" + prefix + "GradBox");
  if (box) box.hidden = false;
  const fill = ui("#" + prefix + "GradFill");
  if (fill) fill.style.background = gradCss(G.state);
  const bar = ui("#" + prefix + "GradBar");
  if (bar) {
    bar.querySelectorAll(".ve-graddot").forEach((n) => n.remove());
    G.state.stops.sort((a, b) => a.offset - b.offset);
    for (const s of G.state.stops) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "ve-graddot";
      dot.dataset.on = s === G.sel ? "1" : "0";
      dot.dataset.del = G.deleteArmed && s === G.sel ? "1" : "0";
      dot.style.left = `${round(s.offset * 100, 2)}%`;
      dot.style.background = `rgba(${hexRgbOf(s.color).join(",")},${s.alpha})`;
      dot._stop = s;
      dot.title = `${Math.round(s.offset * 100)}% · 透明度 ${Math.round(s.alpha * 100)}%`;
      bar.appendChild(dot);
    }
  }
  const idx = G.sel ? G.state.stops.indexOf(G.sel) : -1;
  const label = ui("#" + prefix + "StopLabel");
  if (label) label.textContent = `节点 ${idx >= 0 ? idx + 1 : "-"}/${G.state.stops.length}`;
  if (G.sel) {
    const colorInput = ui("#" + prefix + "StopColor");
    const hexInput = ui("#" + prefix + "StopHex");
    const alphaRange = ui("#" + prefix + "StopAlpha");
    const alphaNum = ui("#" + prefix + "StopAlphaNum");
    if (colorInput) colorInput.value = G.sel.color;
    if (hexInput && document.activeElement !== hexInput) hexInput.value = G.sel.color;
    const a = Math.round(G.sel.alpha * 100);
    if (alphaRange) alphaRange.value = String(a);
    if (alphaNum && document.activeElement !== alphaNum) alphaNum.value = String(a);
  }
  const del = ui("#" + prefix + "StopDel");
  if (del) del.disabled = G.state.stops.length <= 2;
  const needle = ui("#" + prefix + "GradNeedle");
  if (needle) needle.style.transform = `rotate(${Math.round(G.state.angle)}deg)`;
  const angInput = ui("#" + prefix + "GradAngle");
  if (angInput && document.activeElement !== angInput) angInput.value = String(Math.round(G.state.angle));
}

/** 拉条：点圆点选中/拖动；点空白处加节点 */
function bindGradBar(prefix) {
  const bar = ui("#" + prefix + "GradBar");
  if (!bar || bar.dataset.bound === "1") return;
  bar.dataset.bound = "1";
  bar.addEventListener("pointerdown", (e) => {
    const G = gradEditOf();
    if (!G) return;
    e.preventDefault();
    const rect = bar.getBoundingClientRect();
    const at = (clientX) => Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    const hitDot = e.target && e.target.closest ? e.target.closest(".ve-graddot") : null;
    let stop = hitDot && hitDot._stop;
    if (!stop) {
      // 点拉条中间：在当前位置插一个节点，颜色/透明度取插值
      const spot = gradColorAt(G.state, at(e.clientX));
      stop = { offset: at(e.clientX), color: spot.color, alpha: spot.alpha };
      G.state.stops.push(stop);
    }
    G.sel = stop;
    // 点已有圆点只是选中，不移动它；点空白处时新节点直接落在点击位置
    if (!hitDot) stop.offset = at(e.clientX);
    G.deleteArmed = false;
    commitGradEdit(prefix, true);
    const origin = stop.offset;
    const midY = rect.top + rect.height / 2;
    const OUT = 26; // 把圆点拖离拉条超过这么多像素 = 进入「松开删除」状态
    const move = (ev) => {
      const cur = G.sel;
      if (!cur) return;
      cur.offset = at(ev.clientX);
      const armed = Math.abs(ev.clientY - midY) > OUT;
      if (G.deleteArmed !== armed) {
        G.deleteArmed = armed;
        if (armed) toast(G.state.stops.length > 2 ? "松开即可删除这个节点" : "至少保留两个节点", 1400);
      }
      if (cur.offset !== origin || G.deleteArmed) commitGradEdit(prefix, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      const G2 = gradEditOf();
      if (G2 && G2.deleteArmed && G2.sel) {
        G2.deleteArmed = false;
        if (G2.state.stops.length > 2) {
          G2.state.stops = G2.state.stops.filter((s) => s !== G2.sel);
          G2.sel = G2.state.stops[0] || null;
          commitGradEdit(prefix, true);
          toast("已删除节点", 1200);
          return;
        }
        toast("至少保留两个节点", 1600);
      }
      if (G2) G2.deleteArmed = false;
      commitGradEdit(prefix, true);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  });
}

/** 角度圆盘：拖动设置角度（0=向上，90=向右，顺时针） */
function bindGradDial(prefix) {
  const dial = ui("#" + prefix + "GradDial");
  if (!dial || dial.dataset.bound === "1") return;
  dial.dataset.bound = "1";
  const setFrom = (clientX, clientY) => {
    const G = gradEditOf();
    if (!G) return;
    const r = dial.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    let deg = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
    if (deg < 0) deg += 360;
    G.state.angle = deg;
    commitGradEdit(prefix, true);
  };
  dial.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    setFrom(e.clientX, e.clientY);
    const move = (ev) => setFrom(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  });
  const ang = ui("#" + prefix + "GradAngle");
  if (ang && ang.dataset.bound !== "1") {
    ang.dataset.bound = "1";
    ang.addEventListener("change", () => {
      const G = gradEditOf();
      if (!G) return;
      const v = ((Math.round(Number(ang.value) || 0) % 360) + 360) % 360;
      G.state.angle = v;
      commitGradEdit(prefix, true);
    });
  }
}

/** 选中节点的：颜色 / 透明度 / 删除 */
function bindStopControls(prefix) {
  const colorInput = ui("#" + prefix + "StopColor");
  const hexInput = ui("#" + prefix + "StopHex");
  const alphaRange = ui("#" + prefix + "StopAlpha");
  const alphaNum = ui("#" + prefix + "StopAlphaNum");
  const del = ui("#" + prefix + "StopDel");
  const withSel = (fn) => {
    const G = gradEditOf();
    if (!G || !G.sel) return;
    fn(G);
    commitGradEdit(prefix, true);
  };
  if (colorInput && colorInput.dataset.bound !== "1") {
    colorInput.dataset.bound = "1";
    colorInput.addEventListener("input", () => withSel((G) => { G.sel.color = colorInput.value; }));
  }
  if (hexInput && hexInput.dataset.bound !== "1") {
    hexInput.dataset.bound = "1";
    const apply = () => withSel((G) => {
      const raw = String(hexInput.value).trim();
      const m6 = /^#?([0-9a-f]{6})$/i.exec(raw);
      const m3 = /^#?([0-9a-f]{3})$/i.exec(raw);
      if (!m6 && !m3) return;
      let c = "#" + (m6 ? m6[1] : m3[1]);
      if (c.length === 4) c = "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
      G.sel.color = c;
    });
    hexInput.addEventListener("change", apply);
    hexInput.addEventListener("blur", apply);
  }
  if (alphaRange && alphaRange.dataset.bound !== "1") {
    alphaRange.dataset.bound = "1";
    alphaRange.addEventListener("input", () => withSel((G) => { G.sel.alpha = Math.min(1, Math.max(0, Number(alphaRange.value) / 100)); }));
  }
  if (alphaNum && alphaNum.dataset.bound !== "1") {
    alphaNum.dataset.bound = "1";
    alphaNum.addEventListener("change", () => withSel((G) => { G.sel.alpha = Math.min(1, Math.max(0, Number(alphaNum.value) / 100)); }));
  }
  if (del && del.dataset.bound !== "1") {
    del.dataset.bound = "1";
    del.addEventListener("click", () => {
      const G = gradEditOf();
      if (!G || !G.sel) return;
      if (G.state.stops.length <= 2) { toast("至少保留两个节点", 1600); return; }
      G.state.stops = G.state.stops.filter((s) => s !== G.sel);
      G.sel = G.state.stops[0];
      commitGradEdit(prefix, true);
    });
  }
}

/** 解析元素的背景色/毛玻璃当前值 */
function bgParse(el) {
  const out = { r: 35, g: 36, b: 40, a: 1, blur: 0 };
  try {
    const bg = cs(el, "background-color") || "";
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(",").map((x) => parseFloat(x.trim()));
      out.r = p[0] || 0; out.g = p[1] || 0; out.b = p[2] || 0;
      out.a = p.length > 3 ? p[3] : 1;
    }
    const bf = cs(el, "backdrop-filter") || cs(el, "-webkit-backdrop-filter") || "";
    const bm = bf.match(/blur\(([\d.]+)px\)/);
    if (bm) out.blur = Math.round(parseFloat(bm[1]));
  } catch { /* ignore */ }
  return out;
}

function rgbToRgba(r, g, b, a) {
  return "rgba(" + Math.round(r) + "," + Math.round(g) + "," + Math.round(b) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
}

/** 应用背景色/毛玻璃到选中元素 */
function applyBg(el, st) {
  if (!el) return;
  const key = elementKey(el);
  if (!key) return;
  mutate(key, (e) => {
    e.style = { ...(e.style || {}) };
    e.style["background-color"] = rgbToRgba(st.r, st.g, st.b, st.a);
    if (st.blur > 0) {
      e.style["backdrop-filter"] = "blur(" + st.blur + "px)";
      e.style["-webkit-backdrop-filter"] = "blur(" + st.blur + "px)";
    } else {
      delete e.style["backdrop-filter"];
      delete e.style["-webkit-backdrop-filter"];
    }
  });
}

function fillBgUI(el) {
  const box = ui("#iBgBox");
  if (!box) return;
  box.hidden = false;
  const st = bgParse(el);
  const hex = "#" + [st.r, st.g, st.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  if (ui("#iBgColor")) ui("#iBgColor").value = hex;
  if (ui("#iBgHex")) ui("#iBgHex").value = hex;
  if (ui("#iBgAlpha")) ui("#iBgAlpha").value = String(Math.round(st.a * 100));
  if (ui("#iBgAlphaNum")) ui("#iBgAlphaNum").value = String(Math.round(st.a * 100));
  const wrap = ui("#iBgBlur");
  if (wrap) wrap.querySelectorAll("button").forEach((b) => { b.dataset.on = Number(b.dataset.blur) === st.blur ? "1" : "0"; });
  box.dataset.bound = box.dataset.bound || "";
  if (box.dataset.bound !== "1") {
    box.dataset.bound = "1";
    const current = () => bgParse(S.selected || document.body);
    const readInputs = () => {
      const base = current();
      let hex = (ui("#iBgHex") && ui("#iBgHex").value) || "";
      if (!/^#?[0-9a-f]{6}$/i.test(hex)) hex = (ui("#iBgColor") && ui("#iBgColor").value) || "#232428";
      if (hex[0] !== "#") hex = "#" + hex;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const a = Number(ui("#iBgAlphaNum") ? ui("#iBgAlphaNum").value : 100) / 100;
      return { r, g, b, a, blur: base.blur };
    };
    const push = () => { if (S.selected) applyBg(S.selected, readInputs()); };
    ["#iBgColor", "#iBgHex"].forEach((selStr) => {
      const inp = ui(selStr);
      if (!inp) return;
      inp.addEventListener("input", () => {
        const v = inp.value;
        if (ui("#iBgColor")) ui("#iBgColor").value = v.startsWith("#") ? v : "#" + v;
        if (ui("#iBgHex")) ui("#iBgHex").value = v.startsWith("#") ? v : "#" + v;
        push();
      });
    });
    ["#iBgAlpha", "#iBgAlphaNum"].forEach((selStr) => {
      const inp = ui(selStr);
      if (!inp) return;
      inp.addEventListener("input", () => {
        const v = Number(inp.value) || 0;
        if (ui("#iBgAlpha")) ui("#iBgAlpha").value = String(v);
        if (ui("#iBgAlphaNum")) ui("#iBgAlphaNum").value = String(v);
        push();
      });
    });
    const wrap2 = ui("#iBgBlur");
    if (wrap2) wrap2.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-blur]");
      if (!b || !S.selected) return;
      wrap2.querySelectorAll("button").forEach((x) => { x.dataset.on = x === b ? "1" : "0"; });
      const st = readInputs();
      st.blur = Number(b.dataset.blur) || 0;
      applyBg(S.selected, st);
    });
  }
}

/** 单色 / 渐变 切换 */
function bindColorMode(prefix) {
  const wrap = ui("#" + prefix + "ColorMode");
  if (!wrap || wrap.dataset.bound === "1") return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-mode]") : null;
    if (!btn || !S.selected) return;
    const mode = btn.dataset.mode;
    if (prefix === "i" && mode === "bg") {
      setColorMode(prefix, S.selected, "bg");
      wrap.querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.mode === "bg" ? "1" : "0"; });
      const gradBox = ui("#iGradBox"); if (gradBox) gradBox.hidden = true;
      const solidRow = ui("#iColorRow"); if (solidRow) solidRow.hidden = true;
      fillBgUI(S.selected);
      return;
    }
    setColorMode(prefix, S.selected, mode);
  });
}

function solidRowId(prefix) {
  if (prefix === "d") return "#ovDivColorRow"; // 分割线：单色就是「线条色」那一行
  return "#" + prefix + (prefix === "t" ? "SolidRow" : "ColorRow");
}

function setColorMode(prefix, el, mode) {
  const key = gradKeyOf(el);
  if (prefix === "i" && mode !== "bg") { const bgBox = ui("#iBgBox"); if (bgBox) bgBox.hidden = true; }
  if (el && el.dataset && el.dataset.veOverlay) {
    const n = editOverlayNode(el);
    if (!n) return;
    if (mode === "grad") {
      n.params = { ...(n.params || {}), fill: "grad" };
      if (!gradOf(key)) n.params.grad = gradSpec(gradDefaultState(el));
      refreshPresetEl(key, n);
      openGradEdit(prefix, el);
    } else {
      n.params = { ...(n.params || {}), fill: "solid" };
      refreshPresetEl(key, n);
      S.gradEdit = null;
    }
    const gradBox2 = ui("#" + prefix + "GradBox");
    if (gradBox2) gradBox2.hidden = mode !== "grad";
    const solidRow2 = ui(solidRowId(prefix));
    if (solidRow2) solidRow2.hidden = mode === "grad";
    const wrap2 = ui("#" + prefix + "ColorMode");
    if (wrap2) wrap2.querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.mode === mode ? "1" : "0"; });
    fillOverlayPanel(el);
    return;
  }
  const gradBox = ui("#" + prefix + "GradBox");
  const solidRow = ui(solidRowId(prefix));
  const wrap = ui("#" + prefix + "ColorMode");
  if (mode === "grad") {
    openGradEdit(prefix, el);
    if (gradBox) gradBox.hidden = false;
    if (solidRow) solidRow.hidden = true;
  } else {
    removeGrad(key, el);
    S.gradEdit = null;
    if (gradBox) gradBox.hidden = true;
    if (solidRow) solidRow.hidden = false;
  }
  if (wrap) wrap.querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.mode === mode ? "1" : "0"; });
}

/** 面板回填：allow=false 时整块隐藏 */
function fillGradUI(prefix, el, allow) {
  const key = gradKeyOf(el);
  const state = allow ? gradOf(key) : null;
  const modeRow = ui("#" + prefix + "ColorModeRow");
  const wrap = ui("#" + prefix + "ColorMode");
  const gradBox = ui("#" + prefix + "GradBox");
  const solidRow = ui(solidRowId(prefix));
  if (modeRow) modeRow.hidden = !allow;
  if (!allow) {
    if (gradBox) gradBox.hidden = true;
    if (solidRow) solidRow.hidden = true;
    if (wrap) wrap.querySelectorAll("button").forEach((b) => { b.dataset.on = "0"; });
    return;
  }
  bindColorMode(prefix);
  bindGradBar(prefix);
  bindGradDial(prefix);
  bindStopControls(prefix);
  const mode = state ? "grad" : "solid";
  if (wrap) wrap.querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.mode === mode ? "1" : "0"; });
  if (mode === "grad") {
    S.gradEdit = { el, key, prefix, state, sel: state.stops[0] || null };
    if (gradBox) gradBox.hidden = false;
    if (solidRow) solidRow.hidden = true;
    renderGradEdit(prefix);
  } else {
    if (S.gradEdit && S.gradEdit.el === el) S.gradEdit = null;
    if (gradBox) gradBox.hidden = true;
    if (solidRow) solidRow.hidden = false;
  }
}

/* ────────────────────────────── 写入待保存层 ────────────────────────────── */

/** 记录元素「改动前」的 DOM 快照（重置时用它原样还原） */
function ensureSnapshot(el) {
  if (!el || !el.dataset) return;
  const key = el.__veOverlayId ? el.dataset.veOverlay : elementKey(el);
  if (!key) return;
  if (!S.snapshots) S.snapshots = {};
  if (!S.snapshots[key]) {
    try { S.snapshots[key] = el.outerHTML; } catch { /* ignore */ }
  }
}

let historyTimer = 0;

/* ───────── 持久化整体步骤历史（跨保存/跨重启可撤销） ───────── */
const HIST = { steps: [], ptr: -1 };

/** 当前"有效覆写层"：pending 优先，其次 overrides */
function effEntryOf(key) {
  if (Object.prototype.hasOwnProperty.call(S.pending || {}, key)) return S.pending[key];
  if (Object.prototype.hasOwnProperty.call(S.overrides || {}, key)) return S.overrides[key];
  return undefined;
}
function allOverrideKeys() {
  return new Set([...Object.keys(S.pending || {}), ...Object.keys(S.overrides || {})]);
}
/** 采集整份有效状态：entries（null = 该 key 回到原始）+ orig（原始文字/属性，用于跨会话恢复） */
function effState() {
  const entries = {};
  for (const k of allOverrideKeys()) {
    const v = effEntryOf(k);
    if (v === undefined) continue;
    entries[k] = (v && Object.keys(v).length) ? clone(v) : null;
  }
  return { entries, orig: clone(S.orig || {}) };
}
function stateEquals(a, b) {
  try {
    const ea = (a && a.entries) || {};
    const eb = (b && b.entries) || {};
    return JSON.stringify(ea) === JSON.stringify(eb);
  } catch { return false; }
}
let stepPersistTimer = 0;
/** 把本页的撤销历史持久化到服务端（按页面隔离由 store 保证），250ms 防抖 */
function persistSteps() {
  try {
    clearTimeout(stepPersistTimer);
    stepPersistTimer = setTimeout(() => {
      try {
        const all = HIST.steps || [];
        const keep = all.slice(-80);
        const offset = Math.max(0, all.length - keep.length);
        const ptr = Math.max(0, Math.min(keep.length - 1, (HIST.ptr || 0) - offset));
        fetch(`${API}/steps-replace`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-ve-token": TOKEN },
          body: JSON.stringify({ steps: keep, ptr }),
        }).catch(() => {});
      } catch { /* ignore */ }
    }, 250);
  } catch { /* ignore */ }
}
/** 记录一步（整体状态）；若状态未变化则跳过 */
/* ───────── 操作录制（把"操作"和"页面实际变化"一起记录下来，供排查） ───────── */
const REC = { on: false, items: [], startedAt: 0 };

function recDomSnap(key) {
  try {
    const el = resolve(key);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: String(el.tagName || "").toLowerCase(),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      text: String(el.textContent || "").trim().slice(0, 40),
      style: {
        w: el.style.width || "", h: el.style.height || "",
        fs: el.style.fontSize || "", color: el.style.color || "",
      },
    };
  } catch { return null; }
}

function recAdd(type, payload) {
  if (!REC.on) return;
  try {
    REC.items.push({ t: Date.now() - REC.startedAt, type, ...payload });
    if (REC.items.length > 800) REC.items = REC.items.slice(-800);
  } catch { /* ignore */ }
}

function recStart() {
  REC.on = true;
  REC.items = [];
  REC.startedAt = Date.now();
  toast("已开始记录操作（再次点击结束并上报）", 2000);
}

function recStop() {
  REC.on = false;
  try {
    const report = {
      startedAt: REC.startedAt,
      endedAt: Date.now(),
      steps: { ptr: HIST.ptr, total: HIST.steps.length, labels: HIST.steps.map((s) => s.label || "") },
      pendingKeys: Object.keys(S.pending || {}),
      overridesKeys: Object.keys(S.overrides || {}),
      items: REC.items,
    };
    const text = JSON.stringify(report);
    try { PARENT.postMessage({ __ve: "evt", type: "record", text: text.slice(0, 60000) }, "*"); } catch { /* ignore */ }
    toast("录制已结束并上报（共 " + REC.items.length + " 条）", 2400);
  } catch (e) { console.warn("[ve] 录制上报失败", e); }
}

/** 计算两份 entries 的差异 key */
function diffKeys(a, b) {
  const A = a || {};
  const B = b || {};
  const out = [];
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  for (const k of keys) {
    let same = false;
    try { same = JSON.stringify(A[k] || null) === JSON.stringify(B[k] || null); } catch { same = false; }
    if (!same) out.push(k);
  }
  return out;
}

/** 把当前步骤指针/总数告诉上层（工具栏状态显示） */
function postHistoryState() {
  try { postToParent("history-state", { ptr: HIST.ptr, len: HIST.steps.length, autoSave: Boolean(S.autoSave) }); } catch { /* ignore */ }
}

function pushStep(label) {
  try {
    const st = effState();
    const cur = HIST.steps[HIST.ptr];
    if (cur && stateEquals(cur.state, st)) return;
    // 已经撤销过（指针不在末尾）时，新改动必须先把"未来"截断再记录；
    // 否则会让旧分支留在历史里，之后撤销会退回到已经撤销过的旧状态。
    const atTip = HIST.ptr === HIST.steps.length - 1;
    // 连续输入（拖动透明度/字号拉条）在 900ms 内合并为同一步，避免一拖几十步。
    // 注意：只有指针在末尾（没有 redo 分支）时才允许合并，撤销后的第一次改动必须新建一步。
    try {
      const now = Date.now();
      const keysNow = Object.keys(st.entries || {}).sort().join(",");
      if (atTip && S.mergeStep && cur && S.mergeStep.keys === keysNow && now - S.mergeStep.at < 900) {
        cur.state = st;
        cur.at = now;
        S.mergeStep.at = now;
        persistSteps(true);
        return;
      }
      S.mergeStep = { keys: keysNow, at: now };
    } catch { /* ignore */ }
    try {
      if (REC.on) {
        const changed = diffKeys(cur && cur.state && cur.state.entries, st.entries);
        recAdd("step", {
          label: String(label || ""),
          changed: changed.slice(0, 20).map((k) => ({
            key: k,
            before: (cur && cur.state && cur.state.entries && cur.state.entries[k]) || null,
            after: st.entries[k] || null,
            dom: recDomSnap(k),
          })),
        });
      }
    } catch { /* ignore */ }
    const truncated = !atTip;
    HIST.steps = HIST.steps.slice(0, HIST.ptr + 1);
    HIST.steps.push({ id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: Date.now(), label: String(label || ""), state: st });
    try { postHistoryState(); } catch { /* ignore */ }
    if (HIST.steps.length > 200) HIST.steps = HIST.steps.slice(-200);
    HIST.ptr = HIST.steps.length - 1;
    S.mergeStep = null;
    persistSteps(truncated);
  } catch { /* ignore */ }
}
/** 兼容旧调用点：mutate / 拖动结束都用它记录一步 */
function pushHistory(key) {
  pushStep(String(key || ""));
}
/** 打开页面：优先恢复本页已保存的撤销历史（切页/刷新后仍能继续回退）；没有则建基线 */
async function loadSteps() {
  try {
    let restored = null;
    try {
      const res = await fetch(`${API}/steps`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        const steps = Array.isArray(data && data.steps) ? data.steps.filter((s) => s && s.state && typeof s.state === "object") : [];
        if (steps.length) restored = { steps, ptr: data && data.ptr };
      }
    } catch { /* ignore */ }
    if (restored) {
      const keep = restored.steps.slice(-80).map((s) => ({ id: String(s.id || ""), at: Number(s.at) || 0, label: String(s.label || ""), state: s.state }));
      // 去掉连续重复状态（旧版本可能写入重复步骤，导致撤销一步看不出变化）
      const uniq = [];
      for (const s of keep) {
        const prev = uniq[uniq.length - 1];
        if (prev && stateEquals(prev.state, s.state)) continue;
        uniq.push(s);
      }
      HIST.steps = uniq.length ? uniq : keep;
      let p = Number(restored.ptr);
      if (!Number.isFinite(p)) p = HIST.steps.length - 1;
      HIST.ptr = Math.max(0, Math.min(HIST.steps.length - 1, Math.round(p)));
      // 指针所指状态要能和"当前页面状态"对上：否则找一个相同状态；再没有就补一条当前状态
      try {
        const curState = effState();
        if (!stateEquals(HIST.steps[HIST.ptr] && HIST.steps[HIST.ptr].state, curState)) {
          // 从持久化指针向两边找最近的匹配状态（先往回找），
          // 避免"当前状态恰好等于某个更靠后的旧步骤"时把指针跳到分支之后。
          let hit = -1;
          const p0 = HIST.ptr;
          for (let d = 0; d < HIST.steps.length && hit < 0; d++) {
            const back = p0 - d;
            if (back >= 0 && stateEquals(HIST.steps[back] && HIST.steps[back].state, curState)) { hit = back; break; }
            const fwd = p0 + d;
            if (fwd < HIST.steps.length && stateEquals(HIST.steps[fwd] && HIST.steps[fwd].state, curState)) { hit = fwd; break; }
          }
          if (hit >= 0) HIST.ptr = hit;
          else {
            HIST.steps.push({ id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: Date.now(), label: "current", state: curState });
            if (HIST.steps.length > 200) HIST.steps = HIST.steps.slice(-200);
            HIST.ptr = HIST.steps.length - 1;
          }
        }
      } catch { /* ignore */ }
      try { postHistoryState(); } catch { /* ignore */ }
      try { persistSteps(); } catch { /* ignore */ }
      console.info("[ve] 已恢复本页撤销历史：" + HIST.steps.length + " 步（当前第 " + (HIST.ptr + 1) + " 步）");
      return;
    }
    HIST.steps = [];
    HIST.ptr = -1;
    try { pushStep("baseline"); } catch { /* ignore */ }
    try { postHistoryState(); } catch { /* ignore */ }
    try { persistSteps(); } catch { /* ignore */ }
    console.info("[ve] 历史已初始化为当前页面状态（本页首次编辑）");
  } catch { /* ignore */ }
}

/** 应用一份持久化状态：{entries, orig} → 还原整页有效覆写层（含文字/属性） */
function applyStateOf(st) {
  try {
    const target = (st && st.entries) || {};
    if (st && st.orig) {
      for (const [k, v] of Object.entries(st.orig)) if (!S.orig[k]) S.orig[k] = clone(v);
    }
    // 改动前的有效层（用于判断"哪些字段被移除了、需要还原原始值"）
    const oldMap = {};
    for (const k of allOverrideKeys()) {
      const v = effEntryOf(k);
      if (v !== undefined) oldMap[k] = v;
    }
    const keys = new Set([...Object.keys(oldMap), ...Object.keys(target), ...Object.keys(S.overrides || {})]);
    const nextPending = {};
    for (const k of keys) {
      const have = Object.prototype.hasOwnProperty.call(target, k);
      const val = have ? target[k] : null;
      if (val === null || (val && typeof val === "object" && !Object.keys(val).length)) {
        // 目标状态没有该覆写：若 overrides 里存着（多半是自动保存下来的），用 {} 显式取消
        if (Object.prototype.hasOwnProperty.call(S.overrides || {}, k)) nextPending[k] = {};
      } else {
        nextPending[k] = clone(val);
      }
    }
    S.pending = nextPending;
    refreshStylesheet();
    // DOM 对齐
    for (const k of keys) {
      const el = resolve(k);
      if (!el) continue;
      const oldE = oldMap[k] || null;
      const newE = entryOf(k);
      if (newE && Object.keys(newE).length) applyDom(k, newE);
      // 字段级还原：目标里没有的字段，恢复原始值
      const orig = S.orig[k] || null;
      const hadText = oldE && oldE.text != null;
      const hasText = newE && newE.text != null;
      if (orig && hadText && !hasText && isTextEl(el) && orig.text != null) writeText(el, orig.text);
      const hadBlock = oldE && oldE.blockText != null;
      const hasBlock = newE && newE.blockText != null;
      if (orig && hadBlock && !hasBlock && orig.blockText && String(orig.blockText).trim()) {
        try { writeBlockText(el, orig.blockText); } catch { /* ignore */ }
      }
      if (orig && orig.attrs) {
        for (const [a, v] of Object.entries(orig.attrs)) {
          const newVal = newE && newE.attrs ? newE.attrs[a] : undefined;
          const oldVal = oldE && oldE.attrs ? oldE.attrs[a] : undefined;
          if (oldVal !== undefined && newVal === undefined) {
            try { if (v == null) el.removeAttribute(a); else el.setAttribute(a, v); } catch { /* ignore */ }
          }
        }
      }
    }
    // 选中框/多选框
    try {
      if (S.selected && !S.selected.isConnected) select(null);
      else if (S.selected) paintOutline(S.selected);
      paintHover(null);
      try { paintMulti(); } catch { /* ignore */ }
    } catch { /* ignore */ }
    // 插入组件同步
    try {
      const wanted = new Set();
      const pend = S.pending || {};
      const ovr = S.overrides || {};
      for (const [k, v] of Object.entries(pend)) if (v && v.__overlay) wanted.add(k);
      for (const [k, v] of Object.entries(ovr)) {
        if (Object.prototype.hasOwnProperty.call(pend, k)) continue;
        if (v && v.__overlay) wanted.add(k);
      }
      for (const node of [...refs.stage.querySelectorAll(".ve-ins")]) {
        const k = node.dataset.veOverlay;
        if (!k || !wanted.has(k)) { try { node.remove(); } catch { /* ignore */ } }
      }
      for (const k of wanted) {
        const entry = entryOf(k);
        if (entry && entry.__overlay) { try { renderOverlay(k, entry.__overlay); } catch { /* ignore */ } }
      }
      try { syncAutoOverlays(); } catch { /* ignore */ }
    } catch { /* ignore */ }
    if (S.selected) {
      try {
        fillPanel(S.selected, elementKey(S.selected));
        S.appliedText = (ui("#tContent") && ui("#tContent").value) || "";
        S.draftDirty = false;
      } catch { /* ignore */ }
    }
    updateDirty();
  } catch (e) {
    console.warn("[ve] 应用步骤状态失败", e);
    try { toast("状态回放失败：" + String((e && e.message) || e), 3200); } catch { /* ignore */ }
  }
}

/** 旧的整层应用（保留给兼容调用） */
function applyWholeState(next) {
  const prev = S.pending || {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next || {})]);
  S.pending = clone(next || {});
  refreshStylesheet();
  for (const key of keys) {
    const el = resolve(key);
    if (!el) continue;
    const entry = entryOf(key);
    if (entry) {
      applyDom(key, entry);
    } else {
      const orig = S.orig[key];
      if (!orig) continue;
      if (orig.text != null && isTextEl(el)) writeText(el, orig.text);
      else if (orig.blockText && String(orig.blockText).trim()) { try { writeBlockText(el, orig.blockText); } catch { /* ignore */ } }
      for (const [aa, vv] of Object.entries(orig.attrs || {})) {
        try { el.setAttribute(aa, vv); } catch { /* ignore */ }
      }
    }
  }
  if (S.selected) {
    try {
      fillPanel(S.selected, elementKey(S.selected));
      S.appliedText = (ui("#tContent") && ui("#tContent").value) || "";
      S.draftDirty = false;
    } catch { /* ignore */ }
  }
  updateDirty();
}

/** 记录元素被改动前的原始文字/属性（必须在写 DOM 之前调用，否则记录成改后的值 → 撤销会丢文字） */
function ensureOrig(el) {
  if (!el) return;
  const key = el.__veOverlayId ? el.dataset.veOverlay : elementKey(el);
  if (!key) return;
  if (!S.orig[key]) {
    let block = "";
    try { block = String(el.innerText || "").trim(); } catch { block = ""; }
    S.orig[key] = {
      text: isTextEl(el) ? textOf(el) : null,
      attrs: pickAttrs(el),
      blockText: block,
    };
  }
}

function mutate(key, fn, { record = true, batch = true } = {}) {
  // 多选：同一个改动批量应用到所有选中元素（一次撤销）
  if (batch && S.multi && S.multi.length > 1) {
    const multiKeys = S.multi.map((m) => elementKey(m)).filter(Boolean);
    if (multiKeys.length > 1 && multiKeys.map(String).indexOf(String(key)) >= 0) {
      let last = null;
      for (const mk of multiKeys) last = mutate(mk, fn, { record: false, batch: false });
      try { pushStep("多选 · " + multiKeys.length + " 个元素"); } catch { /* ignore */ }
      try { toast("已同时修改 " + multiKeys.length + " 个元素", 1000); } catch { /* ignore */ }
      return last;
    }
  }
  const el = resolve(key);
  const before = clone(S.pending[key] || S.overrides[key] || {});
  // 第一次动这个元素时，记下原始 DOM 快照（文字/换图等直接改 DOM 的改动靠它恢复）
  if (!S.snapshots) S.snapshots = {};
  if (!S.snapshots[key] && el) { try { S.snapshots[key] = el.outerHTML; } catch { /* ignore */ } }
  // 第一次动这个元素时，记下它的原始文字/属性，供「重置」用
  if (!S.orig[key] && el) {
    S.orig[key] = { text: isTextEl(el) ? textOf(el) : null, attrs: pickAttrs(el) };
  }
  const entry = ensureEntry(key);
  fn(entry);
  const after = clone(entry);
  if (record && JSON.stringify(before) !== JSON.stringify(after)) {
    pushHistory(key, before, after);
  }
  updateDirty();
  scheduleStyles();
  if (el) applyDom(key, entry);
  return entry;
}

function setStyleProp(key, prop, value, opts) {
  mutate(key, (e) => {
    if (value == null || value === "") delete e.style[prop];
    else e.style[prop] = value;
  }, opts);
}

function cleanClonedNode(root) {
  const kill = root.querySelectorAll ? root.querySelectorAll("script, [data-ve-editor-ui], [data-ve-overlay], .ve-ins") : [];
  kill.forEach((n) => n.remove());
  const visit = (n) => {
    try {
      if (n.nodeType === 1) {
        n.removeAttribute("data-ve-id");
        n.removeAttribute("data-ve-editor-ui");
        n.removeAttribute("contenteditable");
        if (n.id) n.removeAttribute("id");
        for (const c of [...n.children]) visit(c);
      }
    } catch { /* ignore */ }
  };
  visit(root);
  return root;
}

const COPY_INLINE_PROPS = ["display","position","top","right","bottom","left","float","clear","box-sizing","width","height","min-width","min-height","max-width","max-height","margin-top","margin-right","margin-bottom","margin-left","padding-top","padding-right","padding-bottom","padding-left","border-top-width","border-top-style","border-top-color","border-right-width","border-right-style","border-right-color","border-bottom-width","border-bottom-style","border-bottom-color","border-left-width","border-left-style","border-left-color","border-top-left-radius","border-top-right-radius","border-bottom-right-radius","border-bottom-left-radius","background-color","background-image","background-size","background-position","background-repeat","background-clip","color","font-family","font-size","font-weight","font-style","font-variant","font-stretch","line-height","letter-spacing","word-spacing","text-align","text-transform","text-decoration-line","text-decoration-color","text-decoration-style","text-indent","text-shadow","white-space","word-break","vertical-align","overflow","overflow-x","overflow-y","opacity","box-shadow","filter","backdrop-filter","transform","transform-origin","z-index","visibility","flex-direction","flex-wrap","justify-content","align-items","align-content","flex-grow","flex-shrink","flex-basis","gap","row-gap","column-gap","grid-template-columns","grid-template-rows","grid-auto-flow","grid-column","grid-row","object-fit","object-position","list-style-type","cursor","mix-blend-mode","isolation"];

/** 把原元素及其子元素的「最终计算样式」内联到副本上：文本、字体、颜色、布局全部一致 */
function inlineComputedStyles(original, clone) {
  const walk = (a, b) => {
    if (!a || !b || a.nodeType !== 1 || b.nodeType !== 1) return;
    let cs = null;
    try { cs = getComputedStyle(a); } catch { cs = null; }
    if (cs) {
      for (const p of COPY_INLINE_PROPS) {
        let v = cs.getPropertyValue(p);
        if (v == null) continue;
        v = String(v).trim();
        if (!v) continue;
        try { b.style.setProperty(p, v); } catch { /* ignore */ }
      }
    }
    const akids = [...a.children];
    const bkids = [...b.children];
    const n = Math.min(akids.length, bkids.length);
    for (let i = 0; i < n; i++) walk(akids[i], bkids[i]);
  };
  walk(original, clone);
  return clone;
}

/** 复制当前选中元素为内存剪贴板（Ctrl+C） */
function copyElement() {
  const el = S.selected;
  if (!el) { toast("先选中一个元素再复制", 1200); return; }
  try {
    const clone = cleanClonedNode(el.cloneNode(true));
    try { inlineComputedStyles(el, clone); } catch { /* ignore */ }
    const r = el.getBoundingClientRect();
    clipElement = {
      html: clone.outerHTML,
      width: Math.max(16, Math.round(r.width)),
      height: Math.max(16, Math.round(r.height)),
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
    };
    pasteOffset = 0;
    toast("已复制元素：Ctrl+V 粘贴副本", 1800);
  } catch (e) { toast("复制失败：" + String((e && e.message) || e), 2600); }
}

/** 粘贴元素副本（Ctrl+V） */
function pasteElement() {
  if (!clipElement) { toast("剪贴板里没有元素：先选中元素按 Ctrl+C", 1600); return; }
  try {
    pasteOffset += 1;
    const off = pasteOffset * 24;
    addOverlayNode("div", { html: clipElement.html }, {
      x: clipElement.x + off,
      y: clipElement.y + off,
      width: clipElement.width,
      height: clipElement.height,
    });
    toast("已粘贴副本（Ctrl+Z 可撤销）", 1600);
  } catch (e) { toast("粘贴失败：" + String((e && e.message) || e), 2600); }
}

/** 复制选中元素的外观（Ctrl+Shift+C） */
function copyStyle() {
  const el = S.selected;
  if (!el) { toast("先选中一个元素再复制样式", 1200); return; }
  try {
    const cs = getComputedStyle(el);
    const props = {};
    for (const p of STYLE_CLIP_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && v !== "none" && v !== "normal") props[p] = v;
    }
    clipStyle = props;
    toast("已复制样式（Ctrl+Shift+V 粘贴到目标元素）", 2000);
  } catch (e) { toast("复制样式失败：" + String((e && e.message) || e), 2600); }
}

/** 清理早期"插入页面导航"留下的覆盖层（长条 nav 覆盖层），避免和新的源码顶部胶囊重复 */
function dropLegacyNavOverlays() {
  const keys = new Set();
  try {
    const isLegacyNav = (entry) => {
      try {
        const h = String((entry && entry.__overlay && entry.__overlay.attrs && entry.__overlay.attrs.html) || "");
        return /<nav[\s>]/i.test(h) && /<a\s+href=/i.test(h);
      } catch { return false; }
    };
    for (const [k, v] of Object.entries(S.pending || {})) if (isLegacyNav(v)) { delete S.pending[k]; keys.add(k); }
    for (const [k, v] of Object.entries(S.overrides || {})) if (isLegacyNav(v)) { S.pending[k] = {}; keys.add(k); }
    for (const k of keys) {
      try {
        [...refs.stage.querySelectorAll(".ve-ins")].filter((n) => n.dataset.veOverlay === k).forEach((n) => n.remove());
      } catch { /* ignore */ }
    }
    if (keys.size) { try { refreshStylesheet(); updateDirty(); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  return keys.size;
}

function cleanupLegacyPageNav() {
  try {
    const n = dropLegacyNavOverlays();
    const dom = dropLegacyNavDom();
    try { select(null); } catch { /* ignore */ }
    if (!n && !dom) toast("没有找到旧版浮动导航（新的胶囊是编辑器 UI，不占页面、不可编辑）", 2400);
    else toast("已清理 " + (n + dom) + " 处旧版导航（源码里的旧胶囊可保存后移除）", 2600);
  } catch (e) { toast("清理失败：" + String((e && e.message) || e), 2600); }
}

/** 页面导航胶囊（编辑器 UI，不是页面元素：不可编辑、不会重复、不需要保存）
 *  它和左侧栏 / 弹出面板属于同一层 UI，固定在页面顶部居中（像侧边栏一样不随内容滚动）。
 *  默认常驻：只要站点是多页（或还没读到页面列表）就显示，不再依赖「页面面板」里的按钮。 */
const PAGE_NAV_OFF = (() => {
  try { return new URLSearchParams(location.search).get("ve_nav") === "0"; } catch { return false; }
})();

function pageNavHiddenPref() {
  try { return localStorage.getItem("ve:pagenavOff") === "1"; } catch { return false; }
}
function setPageNavPref(on) {
  try {
    if (on) localStorage.removeItem("ve:pagenavOff");
    else localStorage.setItem("ve:pagenavOff", "1");
  } catch { /* ignore */ }
}

/** 旧版「生成导航条」把胶囊直接写进页面源码/覆盖层，会和 UI 胶囊重影；
 *  预览里直接把那份 DOM 摘掉（只动当前预览的内存，不改项目源码）。 */
function dropLegacyNavDom() {
  let n = 0;
  try {
    document.querySelectorAll("[data-ve-pagenav]").forEach((el) => {
      try { el.remove(); n += 1; } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  return n;
}

function updatePageNavUI() {
  try {
    const box = ui("#vePagenavLinks");
    const root = ui("#vePagenav");
    if (!box || !root) return;
    const known = Array.isArray(S.pages);
    const pages = known ? S.pages.filter((p) => p && p.path) : [];
    const current = String(S.currentPage || "");
    if (known && !pages.length) {
      box.innerHTML = '<span class="ve-pagenav-empty">这个站点只有一页</span>';
    } else {
      box.innerHTML = pages.map((p) => {
        let name = String(p.title || p.path).replace(/^\/+/, "").replace(/\.html?$/i, "");
        if (p.path === "/" || p.path === "/index.html") name = p.title || "首页";
        const cur = current && (p.path === current || ("/" + p.path.replace(/^\/+/, "")) === ("/" + current.replace(/^\/+/, "")));
        const safe = String(p.path).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        const nm = String(name).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return '<a href="' + safe + '" data-current="' + (cur ? "1" : "0") + '" title="' + safe + '">' + nm + "</a>";
      }).join("");
    }
    const btn = ui("#vePagenavToggle");
    if (btn) {
      btn.disabled = false;
      btn.title = known && pages.length ? "展开 / 收起页面导航（共 " + pages.length + " 页）" : "展开 / 收起页面导航";
      btn.setAttribute("aria-expanded", root.getAttribute("data-open") === "1" ? "true" : "false");
    }
  } catch { /* ignore */ }
}

function setPageNavOpen(open) {
  try {
    const root = ui("#vePagenav");
    if (!root) return;
    root.setAttribute("data-open", open ? "1" : "0");
    const btn = ui("#vePagenavToggle");
    if (btn) {
      btn.textContent = open ? "◀" : "▶";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    updatePageNavUI();
  } catch { /* ignore */ }
}

function showPageNavUI(opts) {
  const silent = Boolean(opts && opts.silent);
  try {
    if (PAGE_NAV_OFF) return;
    try { dropLegacyNavOverlays(); } catch { /* ignore */ }
    try { dropLegacyNavDom(); } catch { /* ignore */ }
    const root = ui("#vePagenav");
    if (!root) {
      if (!silent) toast("导航胶囊不可用：请刷新预览", 2200);
      return;
    }
    updatePageNavUI();
    root.hidden = false;
    setPageNavOpen(false);
    setPageNavPref(true);
    if (!silent) toast("已显示悬浮导航胶囊：默认折叠（▶），点一下展开全部页面", 2600);
  } catch (e) {
    if (!silent) toast("显示导航失败：" + String((e && e.message) || e), 2400);
  }
}

function hidePageNavUI(opts) {
  const silent = Boolean(opts && opts.silent);
  try {
    const root = ui("#vePagenav");
    if (root) { root.hidden = true; setPageNavOpen(false); }
    setPageNavPref(false);
    if (!silent) toast("已隐藏悬浮导航胶囊：可在「页面」面板里再打开", 2000);
  } catch { /* ignore */ }
}

function togglePageNavUI(force) {
  try {
    const root = ui("#vePagenav");
    if (!root) return;
    const open = typeof force === "boolean" ? force : root.getAttribute("data-open") !== "1";
    setPageNavOpen(open);
  } catch { /* ignore */ }
}

/** 每次进编辑器时的默认行为：常驻显示（静默，不弹 toast）。
 *  1.1.7 起页面菜单里不再有「显示/隐藏胶囊」按钮，所以也不再看旧的隐藏偏好——
 *  否则之前点过「隐藏」的用户会永远看不到胶囊。
 *  注意：独立启动器 / 新窗口模式没有宿主送页面列表，此时不显示，避免出现空胶囊。 */
function applyPageNavDefault() {
  try {
    if (PAGE_NAV_OFF) return;
    const root = ui("#vePagenav");
    if (!root) return;
    if (!Array.isArray(S.pages) || !S.pages.length) { root.hidden = true; return; }
    showPageNavUI({ silent: true });
  } catch { /* ignore */ }
}

function bindPageNavUI() {
  try {
    const btn = ui("#vePagenavToggle");
    if (btn && !btn.__veBound) {
      btn.__veBound = true;
      btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePageNavUI(); });
    }
    const links = ui("#vePagenavLinks");
    if (links && !links.__veBound) {
      links.__veBound = true;
      links.addEventListener("click", (e) => {
        const a = e.target && e.target.closest ? e.target.closest("a") : null;
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        const path = a.getAttribute("href") || "";
        try { postToParent("page-nav", { path }); } catch { /* ignore */ }
        togglePageNavUI(false);
      });
    }
  } catch { /* ignore */ }
}

/** 把复制的外观粘贴到选中元素（多选则全部应用） *//** 把复制的外观粘贴到选中元素（多选则全部应用） *//** 把复制的外观粘贴到选中元素（多选则全部应用） */
function pasteStyle() {
  if (!clipStyle) { toast("剪贴板里没有样式：先选中元素按 Ctrl+Shift+C", 1600); return; }
  const els = multiEls().filter((el) => el && el.isConnected);
  if (!els.length) { toast("先选中要粘贴样式的元素", 1400); return; }
  let count = 0;
  for (const el of els) {
    const key = elementKey(el);
    if (!key) continue;
    ensureSnapshot(el);
    for (const [p, v] of Object.entries(clipStyle)) setStyleProp(key, p, v, { record: false });
    count += 1;
  }
  scheduleStyles();
  if (S.selected) { try { paintOutline(S.selected); } catch { /* ignore */ } }
  updateDirty();
  try { pushStep("粘贴样式"); } catch { /* ignore */ }
  toast("已粘贴样式到 " + count + " 个元素", 1600);
}

function setTextOp(key, value, el) {
  const orig = el && el.childElementCount === 0 ? el.textContent : "";
  mutate(key, (e) => { e.text = value; });
  return orig;
}

/* ────────────────────────────── 拖动 / 缩放 ────────────────────────────── */

function siblingRects(el) {
  const parent = el.parentElement;
  if (!parent) return [];
  const out = [];
  for (const child of parent.children) {
    if (child === el) continue;
    const r = child.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
    if (out.length >= 40) break;
  }
  return out;
}

function beginDrag(el, e, kind, dir) {
  if (layoutLockedFor(el)) {
    const horizontalResize = kind === "resize" && /[ew]/.test(String(dir || ""));
    // Shift+拖拽是显式操作：允许移动锁定容器，避免“Shift 选父级后拖不动”
    if (kind === "move" && e.shiftKey) { /* allow */ }
    else if (kind === "move" || horizontalResize) {
      toast("容器宽度/位置已锁定；高度仍可调（点「容器锁」解锁）", 2200);
      return;
    }
  }
  const key = elementKey(el);
  if (!key) return;
  const r = rectOf(el);
  const base = clone(S.pending[key] || S.overrides[key] || {});
  const origin = { x: base.box?.x || 0, y: base.box?.y || 0 };
  // 元素可能已经有位移：吸附要按「没有位移时的原始位置 + 累计位移」算，否则会重复加上 origin
  const baseRect = {
    left: r.left - origin.x,
    top: r.top - origin.y,
    width: r.width,
    height: r.height,
  };
  // 记录元素原有的 inline transform：拖动期间用 inline(!important) 兜底，
  // 避免被页面样式/固化脚本/其他规则压住导致"选择框跟手但元素不动"
  const origTf = el.style.getPropertyValue("transform");
  const origTfPrio = el.style.getPropertyPriority("transform");
  const origW = el.style.getPropertyValue("width");
  const origWPrio = el.style.getPropertyPriority("width");
  const origH = el.style.getPropertyValue("height");
  const origHPrio = el.style.getPropertyPriority("height");
  // inline（非替换）元素上 transform 不生效 → 拖动会"蓝框跟手但元素不动"。
  // 拖动时自动提升为 inline-block（只影响该元素的位移能力，不改字符布局）。
  try {
    const cs = getComputedStyle(el);
    if (kind === "move" && cs.display === "inline") {
      el.style.setProperty("display", "inline-block", "important");
      S._inlinePromoted = S._inlinePromoted || new Set();
      S._inlinePromoted.add(el);
    }
  } catch { /* ignore */ }
  S.drag = {
    el, key, kind, dir, origTf, origTfPrio, origW, origWPrio, origH, origHPrio,
    startX: e.clientX, startY: e.clientY,
    rect: baseRect,
    moved: false, base,
    origin,
    w: px(el.style.width) ?? r.width,
    h: px(el.style.height) ?? r.height,
    alt: e.altKey,
  };
  // 多选整体拖动：把同一组里其它元素的起点一起记下来
  try {
    if (S.multi && S.multi.length > 1 && S.multi.indexOf(el) >= 0) {
      S.drag.multi = S.multi
        .filter((m) => m && m.isConnected)
        .map((m) => {
          const mk = elementKey(m);
          if (!mk) return null;
          const mbase = clone(S.pending[mk] || S.overrides[mk] || {});
          return { el: m, key: mk, base: mbase, ox: (mbase.box && mbase.box.x) || 0, oy: (mbase.box && mbase.box.y) || 0 };
        })
        .filter(Boolean);
    }
  } catch (err) { /* ignore */ }
}

function onDragMove(e) {  const d = S.drag;
  if (!d) return;
  const dxRaw = e.clientX - d.startX;
  const dyRaw = e.clientY - d.startY;
  if (!d.moved && Math.hypot(dxRaw, dyRaw) < 3) return;
  d.moved = true;

  S.grid.objects = !e.altKey;

  if (d.kind === "move") {
    const snapped = snapMove({
      rect: d.rect,
      dx: d.origin.x + dxRaw,
      dy: d.origin.y + dyRaw,
      grid: S.grid.size,
      useGrid: S.grid.on && !e.altKey,
      useObjects: S.grid.objects,
      threshold: 6,
      parent: d.el.parentElement ? rectOf(d.el.parentElement) : null,
      siblings: siblingRects(d.el),
      viewport: { width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight },
      guideX: pageGuideTargets().x,
      guideY: pageGuideTargets().y,
    });
    S.pending[d.key] = S.pending[d.key] || clone(d.base);
    S.pending[d.key].box = { ...(S.pending[d.key].box || {}), x: snapped.dx, y: snapped.dy };
    // 多选：其它成员跟着移动同样的偏移
    if (d.multi && d.multi.length > 1) {
      const ddx = snapped.dx - d.origin.x;
      const ddy = snapped.dy - d.origin.y;
      for (const m of d.multi) {
        if (!m || m.key === d.key) continue;
        S.pending[m.key] = clone(S.pending[m.key] || m.base || {});
        S.pending[m.key].box = { ...(S.pending[m.key].box || {}), x: m.ox + ddx, y: m.oy + ddy };
      }
    }
    scheduleStyles();
    // 兜底：inline !important 保证拖动一定跟手（结束时再还原/交给样式表）
    try { d.el.style.setProperty("transform", "translate(" + snapped.dx + "px," + snapped.dy + "px)", "important"); } catch (err) { /* ignore */ }
    paintGuides(snapped.guides);
    paintOutline(d.el);
    try { paintMulti(); } catch (err) { /* ignore */ }
    return;
  }

  // 缩放
  const dir = d.dir || "";
  let w = d.w;
  let h = d.h;
  if (dir.includes("e")) w = Math.max(8, d.w + dxRaw);
  if (dir.includes("w")) w = Math.max(8, d.w - dxRaw);
  if (dir.includes("s")) h = Math.max(8, d.h + dyRaw);
  if (dir.includes("n")) h = Math.max(8, d.h - dyRaw);
  if (e.shiftKey || lockAspect) {
    if (dir.includes("e") || dir.includes("w")) {
      const s = aspectSize(w, h, w, h, "w");
      h = s.height;
    } else {
      const s = aspectSize(w, h, w, h, "h");
      w = s.width;
    }
  }
  if (S.grid.on && !e.altKey) {
    w = Math.max(1, Math.round(w / S.grid.size) * S.grid.size);
    h = Math.max(1, Math.round(h / S.grid.size) * S.grid.size);
  }
  S.pending[d.key] = S.pending[d.key] || clone(d.base);
  S.pending[d.key].box = { ...(S.pending[d.key].box || {}), width: round(w, 1), height: round(h, 1) };
  S.pending[d.key].style = { ...(S.pending[d.key].style || {}), width: pxStr(w), height: pxStr(h) };
  scheduleStyles();
  try {
    d.el.style.setProperty("width", pxStr(w), "important");
    d.el.style.setProperty("height", pxStr(h), "important");
  } catch (err) { /* ignore */ }
  paintOutline(d.el);
  if (d.el.tagName === "CANVAS") syncCanvas(d.el, S.pending[d.key] || {});
  paintGuides([]);
}

function endDrag() {
  const d = S.drag;
  S.drag = null;
  paintGuides([]);
  if (!d) return;
  const after = S.pending[d.key];
  if (!d.moved) return;
  // 还原拖动开始时元素的 inline transform（拖动期间的兜底值不能留）
  try {
    if (d.origTf) d.el.style.setProperty("transform", d.origTf, d.origTfPrio || "");
    else d.el.style.removeProperty("transform");
    if (d.origW) d.el.style.setProperty("width", d.origW, d.origWPrio || "");
    else d.el.style.removeProperty("width");
    if (d.origH) d.el.style.setProperty("height", d.origH, d.origHPrio || "");
    else d.el.style.removeProperty("height");
  } catch { /* ignore */ }
  if (JSON.stringify(d.base) !== JSON.stringify(after)) {
    pushHistory(d.key, d.base, S.pending[d.key] || {});
    updateDirty();
    if (d.el.tagName === "CANVAS") syncCanvas(d.el, after || {});
  }
}

function paintGuides(guides) {
  const gx = guides.find((g) => g.axis === "x");
  const gy = guides.find((g) => g.axis === "y");
  refs.guideX.style.display = gx ? "block" : "none";
  refs.guideY.style.display = gy ? "block" : "none";
  if (gx) { refs.guideX.style.left = `${gx.pos}px`; refs.guideX.dataset.kind = gx.kind || ""; }
  if (gy) { refs.guideY.style.top = `${gy.pos}px`; refs.guideY.dataset.kind = gy.kind || ""; }
}

/* ───────────── 页边距 / 版面参考线 ───────────── */
const PAGE_GUIDE_KEY = "ve:pageGuides:" + (location.pathname || "/");
function loadPageGuides() {
  try {
    const raw = JSON.parse(localStorage.getItem(PAGE_GUIDE_KEY) || "null") || {};
    return {
      top: Math.max(0, Number(raw.top) || 0),
      right: Math.max(0, Number(raw.right) || 0),
      bottom: Math.max(0, Number(raw.bottom) || 0),
      left: Math.max(0, Number(raw.left) || 0),
      centerX: Boolean(raw.centerX),
      centerY: Boolean(raw.centerY),
      on: Boolean(raw.on),
    };
  } catch { return { top: 0, right: 0, bottom: 0, left: 0, centerX: false, centerY: false, on: false }; }
}
function pageGuides() {
  if (!S.pageGuides) S.pageGuides = loadPageGuides();
  return S.pageGuides;
}
function pageGuideTargets() {
  const g = pageGuides();
  const x = [], y = [];
  if (!g.on) return { x, y };
  // 用布局视口（不含滚动条）而不是 innerWidth：否则中心线会偏右约一个滚动条宽
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = document.documentElement.clientHeight || innerHeight;
  if (g.left > 0) x.push(g.left);
  if (g.right > 0) x.push(vw - g.right);
  if (g.centerX) x.push(vw / 2);
  if (g.top > 0) y.push(g.top);
  if (g.bottom > 0) y.push(vh - g.bottom);
  if (g.centerY) y.push(vh / 2);
  return { x, y };
}
function paintPageGuides() {
  const layer = ui("#pageGuides");
  if (!layer) return;
  const g = pageGuides();
  layer.dataset.on = g.on ? "1" : "0";
  if (!g.on) { layer.innerHTML = ""; return; }
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = document.documentElement.clientHeight || innerHeight;
  const parts = [];
  const add = (axis, pos, label) => {
    if (!Number.isFinite(pos) || pos < 0) return;
    const style = axis === "x" ? `left:${Math.round(pos)}px` : `top:${Math.round(pos)}px`;
    parts.push(`<i class="${axis}" style="${style}"></i>`);
  };
  if (g.left > 0) add("x", g.left, "L");
  if (g.right > 0) add("x", vw - g.right, "R");
  if (g.centerX) add("x", vw / 2, "C");
  if (g.top > 0) add("y", g.top, "T");
  if (g.bottom > 0) add("y", vh - g.bottom, "B");
  if (g.centerY) add("y", vh / 2, "C");
  layer.innerHTML = parts.join("");
}
function syncPageGuideInputs() {
  const g = pageGuides();
  const map = { gTop: g.top, gRight: g.right, gBottom: g.bottom, gLeft: g.left };
  for (const [id, v] of Object.entries(map)) { const el = ui("#" + id); if (el) el.value = String(v); }
  const cx = ui("#gCenterX"), cy = ui("#gCenterY");
  if (cx) cx.checked = g.centerX;
  if (cy) cy.checked = g.centerY;
}
function setPageGuides(patch) {
  S.pageGuides = { ...pageGuides(), ...patch };
  try { localStorage.setItem(PAGE_GUIDE_KEY, JSON.stringify(S.pageGuides)); } catch { /* ignore */ }
  paintPageGuides();
  syncPageGuideInputs();
}
function bindPageGuideUI() {
  const box = ui("#guideBox");
  if (box && !box.__veBound) {
    box.__veBound = true;
    box.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-gact]") : null;
      if (!b) return;
      if (b.dataset.gact === "close") { box.hidden = true; return; }
      setPageGuides({ on: false });
    });
  }
  const bindNum = (id, key) => {
    const el = ui("#" + id);
    if (!el || el.__veBound) return;
    el.__veBound = true;
    el.addEventListener("input", () => setPageGuides({ [key]: Math.max(0, Number(el.value) || 0), on: true }));
  };
  bindNum("gTop", "top"); bindNum("gRight", "right"); bindNum("gBottom", "bottom"); bindNum("gLeft", "left");
  const cx = ui("#gCenterX"); if (cx && !cx.__veBound) { cx.__veBound = true; cx.addEventListener("change", () => setPageGuides({ centerX: cx.checked, on: true })); }
  const cy = ui("#gCenterY"); if (cy && !cy.__veBound) { cy.__veBound = true; cy.addEventListener("change", () => setPageGuides({ centerY: cy.checked, on: true })); }
  syncPageGuideInputs();
  paintPageGuides();
}
bindPageGuideUI();
function bindStandaloneTools() {
  const bar = ui("#stools");
  if (!bar) return;
  const q = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); } })();
  const isStandalone = q.get("ve_win") === "1" || Boolean(window.opener);
  if (!isStandalone) return;
  bar.hidden = false;
  refs.ui.classList.add("is-standalone");
  if (q.get("ve_tb") === "top") refs.ui.classList.add("tb-top");
  try { if (localStorage.getItem("ve:dark") === "1") refs.ui.classList.add("ve-dark"); } catch { /* ignore */ }
  const sendHost = (action) => {
    try {
      if (!window.opener) { toast("这个工具需要从侧边栏的「独立页面」打开", 2200); return; }
      window.opener.postMessage({ source: "ve-standalone", action }, "*");
    } catch { /* ignore */ }
  };
  if (!bar.__veBound) {
    bar.__veBound = true;
    bar.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("button[data-sact]") : null;
      if (!b) return;
      const act = b.dataset.sact;
      if (act === "align-left" || act === "align-centerX" || act === "align-right") { alignSelected(act); return; }
      if (act === "theme") {
        const dark = !refs.ui.classList.contains("ve-dark");
        refs.ui.classList.toggle("ve-dark", dark);
        try { localStorage.setItem("ve:dark", dark ? "1" : "0"); } catch { /* ignore */ }
        b.textContent = dark ? "亮色" : "暗色";
        return;
      }
      if (act === "fixate") { sendHost("fixate"); return; }
      if (act === "styles") { sendHost("styles"); return; }
      if (act === "more") { const m = ui("#smenu"); if (m) m.hidden = !m.hidden; return; }
    });
  }
  const autosave = ui("#stAuto"), grid = ui("#stGrid"), objects = ui("#stObjects");
  if (autosave && !autosave.__veBound) {
    autosave.__veBound = true;
    autosave.checked = Boolean(S.autoSave);
    autosave.addEventListener("change", () => { try { setAutoSave(autosave.checked); } catch { S.autoSave = autosave.checked; } });
  }
  if (grid && !grid.__veBound) {
    grid.__veBound = true;
    grid.checked = Boolean(S.grid.on);
    grid.addEventListener("change", () => { S.grid.on = grid.checked; paintGrid(); });
  }
  if (objects && !objects.__veBound) {
    objects.__veBound = true;
    objects.checked = Boolean(S.grid.objects);
    objects.addEventListener("change", () => { S.grid.objects = objects.checked; });
  }
}
bindStandaloneTools();
try {
  const gbtn = ui("#guideBtn");
  if (gbtn && !gbtn.__veBound) {
    gbtn.__veBound = true;
    gbtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const box = ui("#guideBox");
      if (!box) return;
      box.hidden = !box.hidden;
      if (!box.hidden) setPageGuides({ on: true });
    });
  }
} catch { /* ignore */ }
window.addEventListener("resize", () => { try { paintPageGuides(); } catch { /* ignore */ } });

/* ────────────────────────────── 文字就地编辑 ────────────────────────────── */

function startEditing(el) {
  if (!isTextEl(el)) {
    if (el.childElementCount > 0) toast("这个元素里有子元素，请双击里面的文字");
    else toast("这个元素不是文字");
    return;
  }
  const key = elementKey(el);
  if (!key) return;
  ensureSnapshot(el);
  ensureOrig(el);
  S.editing = { el, key, orig: textOf(el) };
  el.setAttribute("contenteditable", "plaintext-only");
  el.style.setProperty("outline", "1px dashed #2f5cff", "important");
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.addEventListener("keydown", onEditKey, true);
}

function stopEditing(save = true) {
  const ed = S.editing;
  if (!ed) return;
  S.editing = null;
  document.removeEventListener("keydown", onEditKey, true);
  const el = ed.el;
  el.removeAttribute("contenteditable");
  el.style.removeProperty("outline");
  const value = textOf(el);
  if (save && value !== ed.orig) {
    ensureSnapshot(el);
    writeText(el, value);
    mutate(ed.key, (e) => { e.text = value; e.__orig = ed.orig; });
    toast("文字已改，记得保存");
  } else if (!save) {
    writeText(el, ed.orig);
  } else {
    writeText(el, value);
  }
  refs.panel.hidden = false;
  select(el);
}

function onEditKey(e) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopEditing(false); }
  if (e.key === "Enter" && !e.shiftKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    stopEditing(true);
  }
}

/* ────────────────────────────── 保存 ────────────────────────────── */

function buildOps() {
  const ops = [];
  for (const [key, entry] of Object.entries(S.pending)) {
    const base = S.overrides[key] || {};
    if (!Object.keys(entry).length) { ops.push({ type: "reset", key }); continue; }
    if (entry.__overlay) { ops.push({ type: "overlay", key, node: entry.__overlay }); continue; }
    const style = {};
    const keys = new Set([...Object.keys(base.style || {}), ...Object.keys(entry.style || {})]);
    for (const p of keys) {
      const a = base.style?.[p] ?? null;
      const b = entry.style?.[p] ?? null;
      if (a !== b) style[p] = b;
    }
    if (Object.keys(style).length) ops.push({ type: "style", key, props: style });
    if ((entry.image ?? null) !== (base.image ?? null)) {
      ops.push({ type: "image", key, value: entry.image ?? "", box: entry.imageBox || null });
    }
    if ((entry.blockText ?? null) !== (base.blockText ?? null)) {
      ops.push({ type: "blockText", key, value: entry.blockText ?? "", orig: base.blockText ?? "" });
    }
    if ((entry.text ?? null) !== (base.text ?? null)) {
      ops.push({ type: "text", key, value: entry.text ?? "", orig: entry.__orig ?? base.text ?? "" });
    }
    const attrs = {};
    const akeys = new Set([...Object.keys(base.attrs || {}), ...Object.keys(entry.attrs || {})]);
    for (const a of akeys) {
      if ((base.attrs?.[a] ?? null) !== (entry.attrs?.[a] ?? null)) attrs[a] = entry.attrs?.[a] ?? null;
    }
    if (Object.keys(attrs).length) ops.push({ type: "attrs", key, props: attrs });
    if (JSON.stringify(entry.box || null) !== JSON.stringify(base.box || null)) ops.push({ type: "box", key, box: entry.box || { x: 0, y: 0 } });
    if (Boolean(entry.hidden) !== Boolean(base.hidden)) ops.push({ type: "hide", key, hidden: Boolean(entry.hidden) });
  }
  for (const key of S.removedKeys) ops.push({ type: "reset", key });
  return ops;
}

/** 恢复到页面原始状态：清空服务器覆写层 + 本地草稿 + 内存历史，然后刷新 */
async function resetAll() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("ve:draft:") || k.startsWith("ve:pending:"))) {
        try { localStorage.removeItem(k); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  try {
    await fetch(`${API}/replace-overrides`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ve-token": TOKEN },
      body: JSON.stringify({ overrides: {}, label: "reset-all" }),
    });
  } catch { /* 忽略，刷新后仍可能残留 */ }
  try {
    S.pending = {};
    S.overrides = {};
    HIST.steps = [];
    HIST.ptr = -1;
    try { await fetch(`${API}/steps-replace`, { method: "POST", headers: { "Content-Type": "application/json", "x-ve-token": TOKEN }, body: JSON.stringify({ steps: [] }) }); } catch { /* ignore */ }
  } catch { /* ignore */ }
  toast("已清空全部修改，正在恢复原始页面…", 1500);
  setTimeout(() => { try { location.reload(); } catch { /* ignore */ } }, 400);
}

function cssUnitOf(el, prop) {
  try {
    const classify = (v) => {
      const s = String(v || "");
      if (!s) return "auto";
      if (/var\(|clamp\(|min\(|max\(|calc\(|%|vw|vh|vmin|vmax|rem|em|fr|ch|ex/.test(s)) return "ratio";
      if (/px/.test(s)) return "px";
      return "auto";
    };
    const inline = el.style && el.style.getPropertyValue(prop);
    if (inline) return classify(inline);
    let value = "";
    const walk = (rules) => {
      for (const rule of rules) {
        try {
          if (rule.type === 1 && rule.selectorText && rule.style) {
            if (el.matches(rule.selectorText)) {
              const v = rule.style.getPropertyValue(prop);
              if (v) value = v;
            }
          } else if (rule.cssRules) walk(rule.cssRules);
        } catch { /* ignore */ }
      }
    };
    for (const sheet of document.styleSheets) {
      try { if (sheet.cssRules) walk(sheet.cssRules); } catch { /* ignore */ }
    }
    return classify(value);
  } catch { return "auto"; }
}

async function save(opts = {}) {
  const silent = Boolean(opts === true || (opts && opts.silent));
  if (S.saving) return { ok: false, busy: true };
  const ops = buildOps();
  try {
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const op of ops) {
      if (!op || !op.key) continue;
      const el = resolve(op.key);
      const p = el && el.parentElement;
      op.ref = { vw, vh, pw: p ? p.clientWidth : 0, ph: p ? p.clientHeight : 0 };
      op.ref.units = {
        width: el ? cssUnitOf(el, "width") : "auto",
        height: el ? cssUnitOf(el, "height") : "auto",
        "font-size": el ? cssUnitOf(el, "font-size") : "auto",
      };
    }
  } catch { /* ignore */ }
  if (!ops.length) { if (!silent) toast("没有需要保存的改动"); return { ok: true, empty: true }; }
  S.saving = true;
  if (!silent) toast("保存中…", 6000);
  try {
    const res = await fetch(`${API}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ve-token": TOKEN },
      body: JSON.stringify({ ops, auto: silent ? 1 : 0 }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "保存失败");
    S.lastSave = data;
    S.overrides = data.overrides || { ...S.overrides, ...S.pending };
    if (!silent) {
      // 手动保存 = 阶段落盘：清空待保存层与撤销历史（保存前状态不再可撤）
      S.pending = {};
      S.removedKeys.clear();
      // 注意：不清撤销历史 —— 保存后仍可用 Ctrl+Z 退回保存前的状态（再点保存即可落盘）
      clearDraft();
    }
    updateDirty();
    const n = data.applied?.length || ops.length;
    if (silent) {
      try { S.lastAutoSig = autoSaveSignature(); } catch { /* ignore */ }
      S.lastAutoSaveAt = Date.now();
      const hm = new Date().toTimeString().slice(0, 5);
      toast(`已自动保存 ${n} 处改动 · ${hm}`, 1600);
    } else {
      toast(`已保存 ${n} 处改动${data.backupId ? ` · 备份 ${data.backupId}` : ""}${data.wroteContent ? " · 已写回内容文件" : ""}`, 3200);
      if (data.wroteContent) console.info("[ve] 文字已回写进 " + (BOOT.contentJson || "content.json"));
    }
    return { ok: true, data };
  } catch (err) {
    if (silent) {
      console.warn("[ve] 自动保存失败（已忽略，下次改动会重试）：", err && err.message);
    } else {
      toast(`保存失败：${err.message}`, 4000);
    }
    return { ok: false, error: String(err.message || err) };
  } finally {
    S.saving = false;
  }
}

/* ────────────────────── 自动保存 / 草稿缓存 ──────────────────────
 * 目标：改了东西忘了点「保存」也不丢。
 * 1) 自动保存：改动后静置约 2 秒，自动走一遍 save()（写 overrides.json，服务端照常备份轮转）
 * 2) 草稿缓存：改动实时写 localStorage（按页面路径分开），刷新/崩溃后自动恢复回待保存层
 * 3) 关页面/切后台时：先把草稿写死，再用 keepalive 请求尽力补一次保存
 */
const AUTO_KEY = "ve:autoSave";
const DRAFT_KEY = "ve:draft:" + location.pathname;
// 页面自带的构建号（<meta name="ve-build">）：页面一更新，旧草稿就作废，
// 避免"改了源码但刷新后又被上次没保存的草稿盖回去"
const PAGE_BUILD = (() => {
  try {
    const m = document.querySelector('meta[name="ve-build"]');
    return m ? (m.getAttribute("content") || "") : "";
  } catch { return ""; }
})();
const DRAFT_TTL = 7 * 24 * 3600 * 1000;
const AUTO_DELAY = 2200;
let autoTimer = 0;
let draftTimer = 0;

function autoSaveEnabled() {
  try {
    const v = localStorage.getItem(AUTO_KEY);
    return v == null ? true : v === "1";
  } catch { return true; }
}

function setAutoSave(on) {
  S.autoSave = Boolean(on);
  try { localStorage.setItem(AUTO_KEY, S.autoSave ? "1" : "0"); } catch { /* ignore */ }
  updateQuickState();
  if (S.autoSave && isDirty()) scheduleAutoSave();
  toast(S.autoSave ? "自动保存已开：改动静置约 2 秒就存" : "自动保存已关：改完记得点「保存」", 2400);
}

/** 当前待保存层指纹（用于判断是否真的还有未保存改动） */
function autoSaveSignature() {
  try { return JSON.stringify(S.pending || {}); } catch { return ""; }
}

function scheduleAutoSave() {
  if (!S.autoSave) return;
  try {
    if (S.lastAutoSig && autoSaveSignature() === S.lastAutoSig) return;
  } catch { /* ignore */ }
  clearTimeout(autoTimer);
  if (!isDirty()) return;
  autoTimer = setTimeout(() => { autoSaveNow(); }, AUTO_DELAY);
}

async function autoSaveNow() {
  if (!S.autoSave || S.saving || !isDirty()) return;
  if (S.preview || S.marquee) return;
  S.autoSaving = true;
  try {
    const r = await save({ silent: true });
    if (r && r.busy) scheduleAutoSave();
  } finally {
    S.autoSaving = false;
  }
}

function writeDraft() {
  try {
    if (!isDirty()) { localStorage.removeItem(DRAFT_KEY); return; }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      at: Date.now(),
      path: location.pathname,
      pending: S.pending,
      removed: [...S.removedKeys],
      build: PAGE_BUILD,
    }));
  } catch { /* 隐私模式 / 容量超限：忽略 */ }
}

function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, 200);
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !d.pending || !Object.keys(d.pending).length) return null;
    // 页面构建号变了：这条草稿是基于旧页面改的，直接丢掉（否则会把旧样式盖在更新后的页面上）
    if (PAGE_BUILD && String(d.build || "") !== PAGE_BUILD) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    if (Date.now() - (d.at || 0) > DRAFT_TTL) { localStorage.removeItem(DRAFT_KEY); return null; }
    return d;
  } catch { return null; }
}

/** 刷新 / 崩溃后，把上次没保存的改动恢复回待保存层（面板上会显示改动数） */
function restoreDraft() {
  const d = readDraft();
  if (!d) return false;
  const merged = { ...S.overrides, ...d.pending };
  for (const [key, entry] of Object.entries(d.pending)) {
    if (!entry || entry.__overlay) continue;
    if (keyToSelector(key)) applyDom(key, entry);
  }
  applyOverlays(merged);
  S.pending = d.pending;
  S.removedKeys = new Set(Array.isArray(d.removed) ? d.removed : []);
  refreshStylesheet();
  updateDirty();
  toast(`已恢复上次未保存的 ${Object.keys(S.pending).length} 处改动（稍后自动保存）`, 3600);
  return true;
}

/** 关页面/切后台时尽力补一次保存（keepalive，不保证成功；草稿兜底） */
function flushAutoSave() {
  try {
    const ops = buildOps();
    if (!ops.length) return;
    fetch(`${API}/save`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", "x-ve-token": TOKEN },
      body: JSON.stringify({ ops, auto: 1 }),
    }).then((r) => { if (r && r.ok) clearDraft(); }).catch(() => { /* 草稿兜底 */ });
  } catch { /* ignore */ }
}

function bindAutoSaveLifecycle() {
  try {
    window.addEventListener("pagehide", () => {
      try { writeDraft(); } catch { /* ignore */ }
      if (S.autoSave && isDirty()) flushAutoSave();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") return;
      try { writeDraft(); } catch { /* ignore */ }
      if (S.autoSave && isDirty()) autoSaveNow();
    });
  } catch { /* ignore */ }
}

/* ────────────────────────────── 撤销 / 重做 ────────────────────────────── */

function undo() {
  const e = S.history.undo();
  if (!e) { toast("没有可撤销的操作"); return; }
  restoreKey(e.key, e.before);
  S.history.pushRedo?.(e);
}

function restoreKey(key, snapshot) {
  if (snapshot && Object.keys(snapshot).length) S.pending[key] = clone(snapshot);
  else delete S.pending[key];
  refreshStylesheet();
  const el = resolve(key);
  const entry = entryOf(key);
  if (el) {
    if (entry) applyDom(key, entry);
    else {
      // 回到「没有覆写」状态：把原始文字/块文字/属性放回去
      const orig = S.orig[key];
      if (orig) {
        if (orig.text != null && isTextEl(el)) writeText(el, orig.text);
        else if (orig.blockText && orig.blockText.trim()) {
          try { writeBlockText(el, orig.blockText); } catch { /* ignore */ }
        }
        for (const [a, v] of Object.entries(orig.attrs || {})) {
          try { el.setAttribute(a, v); } catch { /* ignore */ }
        }
      }
    }
  }
  if (S.selected && elementKey(S.selected) === key) {
    fillPanel(S.selected, key);
    try { S.appliedText = (ui("#tContent") && ui("#tContent").value) || ""; S.draftDirty = false; } catch { /* ignore */ }
  }
  updateDirty();
}

/** 强制把页面有效层设成目标状态（兜底：applyStateOf 内部异常时也保证结果正确） */
function forceApplyState(state) {
  try {
    const want = (state && state.entries) || {};
    const cur = effState().entries;
    let same = false;
    try { same = JSON.stringify(cur) === JSON.stringify(want); } catch { same = false; }
    if (same) return;
    applyStateOf(state);
  } catch (e) { console.warn("[ve] 强制回放失败", e); }
}

function doUndo() {
  try {
    if (!HIST.steps.length) { toast("还没有可撤销的步骤（先改动一次）", 1600); return; }
    if (HIST.ptr <= 0) { toast("已经是最早一步了", 1200); return; }
    const from = HIST.ptr;
    HIST.ptr -= 1;
    // 历史里若有连续相同状态，继续往前跳到"真正不同"的那一步
    while (HIST.ptr > 0 && stateEquals(HIST.steps[HIST.ptr].state, HIST.steps[HIST.ptr + 1].state)) HIST.ptr -= 1;
    // 撤销后必须断开"合并窗口"，否则撤销后的第一次改动会被并进旧步骤里（且不会截断旧分支）
    S.mergeStep = null;
    try { postHistoryState(); } catch { /* ignore */ }
    recAdd("undo", { from: from + 1, to: HIST.ptr + 1, keys: Object.keys(S.pending || {}) });
    const targetState = HIST.steps[HIST.ptr] && HIST.steps[HIST.ptr].state;
    applyStateOf(targetState);
    forceApplyState(targetState);
    try { persistSteps(); } catch { /* ignore */ }
    recAdd("undo-applied", { ptr: HIST.ptr + 1, pendingKeys: Object.keys(S.pending || {}), dom: Object.keys(S.pending || {}).slice(0, 10).map((k) => ({ key: k, dom: recDomSnap(k) })) });
    toast("已撤销（第 " + (HIST.ptr + 1) + "/" + HIST.steps.length + " 步）", 1200);
  } catch (err) {
    console.error("[ve] 撤销失败", err);
    toast("撤销失败：" + String((err && err.message) || err), 2600);
  }
}
function doRedo() {
  try {
    if (HIST.ptr >= HIST.steps.length - 1) { toast("没有可重做的步骤了", 1200); return; }
    HIST.ptr += 1;
    while (HIST.ptr < HIST.steps.length - 1 && stateEquals(HIST.steps[HIST.ptr].state, HIST.steps[HIST.ptr - 1].state)) HIST.ptr += 1;
    S.mergeStep = null;
    try { postHistoryState(); } catch { /* ignore */ }
    recAdd("redo", { to: HIST.ptr + 1, keys: Object.keys(S.pending || {}) });
    const targetState2 = HIST.steps[HIST.ptr] && HIST.steps[HIST.ptr].state;
    applyStateOf(targetState2);
    forceApplyState(targetState2);
    try { persistSteps(); } catch { /* ignore */ }
    recAdd("redo-applied", { ptr: HIST.ptr + 1, pendingKeys: Object.keys(S.pending || {}), dom: Object.keys(S.pending || {}).slice(0, 10).map((k) => ({ key: k, dom: recDomSnap(k) })) });
    toast("已重做（第 " + (HIST.ptr + 1) + "/" + HIST.steps.length + " 步）", 1200);
  } catch (err) {
    console.error("[ve] 重做失败", err);
    toast("重做失败：" + String((err && err.message) || err), 2600);
  }
}
void undo;

/* ────────────────────────────── 图片 / SVG ────────────────────────────── */

function filePicker(accept) {
  return new Promise((resolveP) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const f = input.files?.[0] || null;
      input.remove();
      resolveP(f);
    });
    input.addEventListener("cancel", () => { input.remove(); resolveP(null); });
    input.click();
  });
}

async function upload(file) {
  const res = await fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "x-ve-token": TOKEN },
    body: file,
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || "上传失败");
  return data.url;
}

async function replaceImage() {
  const el = S.selected;
  if (!el) return;
  ensureSnapshot(el);
  const key = elementKey(el);
  const file = await filePicker("image/*");
  if (!file) return;
  try {
    const url = await upload(file);
    if (el.tagName === "IMG") {
      mutate(key, (e) => { e.attrs = { ...(e.attrs || {}), src: url }; });
    } else {
      // 图标 / SVG / 任意元素：换成一张图片，保持原占位大小
      const r = el.getBoundingClientRect();
      mutate(key, (e) => { e.image = url; e.imageBox = { width: Math.round(r.width), height: Math.round(r.height) }; });
      replaceWithImage(el, url, r);
    }
    toast("已替换成图片，记得保存");
  } catch (err) { toast(`换图失败：${err.message}`, 4000); }
}

/** 把任意元素换成 <img>（保留尺寸/位置） */
function replaceWithImage(el, src, rect) {
  if (!el || !el.parentElement) return;
  const img = document.createElement("img");
  img.setAttribute("src", src);
  img.style.width = Math.round(rect.width) + "px";
  img.style.height = Math.round(rect.height) + "px";
  img.style.objectFit = "contain";
  img.style.display = "inline-block";
  img.dataset.veReplaced = "1";
  el.replaceWith(img);
}

async function insertImage() {
  const file = await filePicker("image/*");
  if (!file) return;
  try {
    const url = await upload(file);
    addOverlayNode("img", { src: url });
  } catch (err) { toast(`插入失败：${err.message}`, 4000); }
}

/** 新建面板：点左侧坞按钮先出面板，填 1~2 个关键信息，保存后才插入 */
function openCreate(kind) {
  const titles = { text: "新建文字", image: "新建图片", svg: "新建 SVG", three: "新建 Three.js 画布", nav: "新建导航栏", button: "新建按钮", card: "新建卡片", divider: "新建分割线", pagelink: "新建页面链接", hero: "新建 Hero 区块" };
  S.createKind = kind;
  ui("#createTitle").textContent = titles[kind] || "新建";
  const fields = [];
  const row = (label, id, ph, type) => '<div class="ve-row"><label>' + label + '</label><' + (type === "textarea" ? "textarea" : 'input type="text"') + ' id="' + id + '" placeholder="' + ph + '"></' + (type === "textarea" ? "textarea" : "input") + "></div>";
  if (kind === "text") fields.push(row("内容", "crText", "要插入的文字", "textarea"));
  if (kind === "image") fields.push(row("图片地址", "crSrc", "URL 或留空后面选择文件"));
  if (kind === "svg") fields.push(row("SVG 源码", "crSvg", "<svg …>", "textarea"));
  if (kind === "three") fields.push('<p class="ve-hint">保存后插入一块 3D 画布（能接入站点 three 时自动渲染）。</p>');
  if (kind === "nav") fields.push(row("导航项（逗号分隔）", "crNav", "首页,案例,工艺,流程,联系"));
  if (kind === "button") fields.push(row("按钮文字", "crBtn", "按钮文字"));
  if (kind === "card") { fields.push(row("标题", "crCardTitle", "卡片标题")); fields.push(row("描述", "crCardDesc", "卡片描述", "textarea")); }
  if (kind === "divider") fields.push('<div class="ve-row"><label>方向</label><select id="crDivDir"><option value="h">横线</option><option value="v">竖线</option></select></div>');
  if (kind === "hero") { fields.push(row("标题", "crHeroTitle", "让 AI 出稿，让人收尾")); fields.push(row("副标题", "crHeroSub", "一句话说明")); fields.push(row("按钮文字", "crHeroCta", "开始使用")); }
  if (kind === "pagelink") {
    const plPages = Array.isArray(S.pages) ? S.pages.filter((p) => p && p.path) : [];
    const plOpts = plPages.map((p) => '<option value="' + String(p.path).replace(/"/g, "&quot;") + '">' + String(p.title || p.path).replace(/</g, "&lt;") + '（' + String(p.path) + '）</option>').join("");
    fields.push('<div class="ve-row"><label>目标页面</label><select id="crLinkTarget">' + plOpts + '<option value="__custom__">自定义 URL…</option></select></div>');
    fields.push(row("自定义 URL（上面选「自定义」时用）", "crLinkUrl", "/about.html 或 https://…"));
    fields.push(row("链接文字", "crLinkText", "例如：关于我们"));
    fields.push('<p class="ve-hint">保存后插入一个链接按钮，可拖动位置；多页面之间用它互相跳转。</p>');
  }
  fields.push('<p class="ve-hint">保存后会立刻插入页面，并打开右侧面板继续调整。</p>');
  ui("#createFields").innerHTML = fields.join("");
  ui("#createModal").hidden = false;
  try { const first = ui("#createFields").querySelector("input,textarea"); if (first) first.focus(); } catch { /* ignore */ }
}

function createSave() {
  const kind = S.createKind;
  const val = (id) => { const el = ui("#" + id); return el ? String(el.value || "").trim() : ""; };
  const done = () => { const m = ui("#createModal"); if (m) m.hidden = true; };
  const afterInsert = (el) => { done(); if (el) select(el); };
  try {
    if (kind === "text") {
      const text = val("crText") || "新文字";
      const key = "overlay:ov" + Math.random().toString(36).slice(2, 8);
      const node = { id: key.slice(8), tag: "text", attrs: { text, color: "#E2DBC8", size: 24 }, x: 60, y: 160, width: 320, height: 60, z: 950 };
      initOverlayPin(node);
      S.pending[key] = { __overlay: node };
      afterInsert(renderOverlay(key, node));
      updateDirty();
    } else if (kind === "image") {
      const src = val("crSrc");
      const insert = (url) => {
        const key = "overlay:ov" + Math.random().toString(36).slice(2, 8);
        const node = { id: key.slice(8), tag: "img", attrs: { src: url }, x: 60, y: 140, width: 320, height: 200, z: 950 };
        initOverlayPin(node);
        S.pending[key] = { __overlay: node };
        afterInsert(renderOverlay(key, node));
        updateDirty();
      };
      if (src) insert(src);
      else filePicker("image/*").then((f) => (f ? upload(f).then(insert).catch((e) => toast("插入失败：" + e.message, 3000)) : done()));
    } else if (kind === "svg") {
      const html = val("crSvg") || '<svg width="160" height="160" viewBox="0 0 24 24" fill="none" stroke="#E2DBC8" stroke-width="1.5"><circle cx="12" cy="12" r="9"/></svg>';
      const key = "overlay:ov" + Math.random().toString(36).slice(2, 8);
      const node = { id: key.slice(8), tag: "div", attrs: { html }, x: 60, y: 150, width: 200, height: 200, z: 950 };
      initOverlayPin(node);
      S.pending[key] = { __overlay: node };
      afterInsert(renderOverlay(key, node));
      updateDirty();
    } else if (kind === "three") {
      done();
      insertThreeScene();
    } else if (kind === "hero") {
      done();
      insertPreset("hero", { title: val("crHeroTitle") || "让 AI 出稿，让人收尾", sub: val("crHeroSub") || "改完直接落盘，刷新就是成品。", cta: val("crHeroCta") || "开始使用" });
    } else if (kind === "pagelink") {
      const selEl = ui("#crLinkTarget");
      let href = selEl ? String(selEl.value || "") : "";
      if (!href || href === "__custom__") href = val("crLinkUrl");
      href = String(href || "").trim();
      if (!href) { toast("请选择目标页面或填一个 URL", 1800); return; }
      if (!/^(https?:|\/|#|[\w.-]+\/|\.\/)/i.test(href)) href = "/" + href.replace(/^\/+/, "");
      const text = val("crLinkText") || href;
      const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const inner = '<a href="' + escHtml(href) + '" style="display:inline-block;padding:12px 20px;border:1px solid currentColor;border-radius:999px;text-decoration:none;color:inherit;font:inherit">' + escHtml(text) + "</a>";
      const linkKey = "overlay:ov" + Math.random().toString(36).slice(2, 8);
      const linkNode = { id: linkKey.slice(8), tag: "div", attrs: { html: inner }, x: 60, y: 200, width: 200, height: 52, z: 950 };
      initOverlayPin(linkNode);
      S.pending[linkKey] = { __overlay: linkNode };
      afterInsert(renderOverlay(linkKey, linkNode));
      updateDirty();
      toast("已插入页面链接：拖动到需要的位置", 2200);
    } else {
      const params = {};
      if (kind === "nav") params.items = (val("crNav") || "首页,案例,工艺,流程,联系").split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      if (kind === "button") params.text = val("crBtn") || "按钮文字";
      if (kind === "card") { params.title = val("crCardTitle") || "卡片标题"; params.desc = val("crCardDesc") || "卡片描述"; }
      if (kind === "divider") params.dir = val("crDivDir") === "v" ? "v" : "h";
      done();
      insertPreset(kind, params);
    }
  } catch (e) {
    toast("新建失败：" + (e.message || e), 3600);
  }
}

/** 预设组件的 HTML 生成（参数化：改参数即重渲染）
 * 注意：保存时服务端只保留 overlay 的白名单字段（id/tag/attrs/x/y/width/height/z），
 * 所以把 preset/params/style/pin/rotate 编码进 HTML 的 data-ve-meta 里，
 * 这样保存 → 刷新后设置不会丢（读取见 migrateOverlayPreset）。
 */
function presetMeta(node, preset) {
  try {
    const meta = {
      preset,
      params: (node && node.params) || {},
      style: (node && node.style) || {},
      pin: (node && node.pin) || "auto",
      rotate: (node && node.rotate) || 0,
      baseScroll: (node && node.baseScroll) || 0,
    };
    return ' data-ve-meta="' + encodeURIComponent(JSON.stringify(meta)) + '"';
  } catch { return ""; }
}

function presetHtml(node) {
  const p = (node && node.params) || {};
  const s = (node && node.style) || {};
  const pad = s.pad != null ? s.pad : 14;
  const radius = s.radius != null ? s.radius : 12;
  const bg = s.bg || "rgba(20,30,24,.72)";
  const color = s.color || "#E2DBC8";
  const gap = p.gap != null ? p.gap : 28;
  const preset = node && node.preset;
  const meta = presetMeta(node, preset);
  if (preset === "nav") {
    const items = Array.isArray(p.items) && p.items.length ? p.items : ["首页", "案例", "工艺", "流程", "联系"];
    const links = items.map((x) => '<a style="color:inherit;text-decoration:none;cursor:pointer">' + String(x || "").replace(/</g, "&lt;") + "</a>").join("");
    return "<div" + meta + ' style="display:flex;align-items:center;justify-content:center;gap:' + gap + 'px;height:100%;padding:0 ' + pad + 'px;font:500 13px/1 Inter,system-ui,sans-serif;color:' + color + ";background:" + bg + ";backdrop-filter:blur(10px);border-radius:" + radius + 'px;letter-spacing:.06em;border:1px solid rgba(226,219,200,.22);box-shadow:0 8px 24px rgba(0,0,0,.25)">' + links + "</div>";
  }
  if (preset === "button") {
    const label = p.text || "按钮文字";
    return "<div" + meta + ' style="display:flex;align-items:center;justify-content:center;height:100%;padding:0 ' + pad + "px;background:" + bg + ";border-radius:" + radius + "px;color:" + color + ';font:600 13px/1 Inter,system-ui,sans-serif;cursor:pointer">' + String(label).replace(/</g, "&lt;") + "</div>";
  }
  if (preset === "card") {
    const title = p.title || "卡片标题";
    const desc = p.desc || "这里是一段卡片描述文字，可以直接改。";
    return "<div" + meta + ' style="height:100%;box-sizing:border-box;padding:' + pad + "px;border-radius:" + radius + "px;background:" + bg + ";border:1px solid rgba(226,219,200,.18);color:" + color + ';font:13px/1.6 Inter,system-ui,sans-serif;backdrop-filter:blur(8px)"><div style="font-size:16px;font-weight:600;margin-bottom:8px">' + String(title).replace(/</g, "&lt;") + '</div><div style="opacity:.78">' + String(desc).replace(/</g, "&lt;") + "</div></div>";
  }
  if (preset === "hero") {
    const title = String(p.title || "让 AI 出稿，让人收尾").replace(/</g, "&lt;");
    const sub = String(p.sub || "").replace(/</g, "&lt;");
    const cta = String(p.cta || "开始使用").replace(/</g, "&lt;");
    return "<div" + meta + ' style="height:100%;box-sizing:border-box;padding:' + (pad + 18) + "px;border-radius:" + radius + "px;background:linear-gradient(135deg,rgba(12,20,16,.96),rgba(24,40,32,.92));color:" + color + ';display:flex;flex-direction:column;justify-content:center;gap:12px;font-family:Inter,system-ui,sans-serif"><div style="font:800 clamp(22px,3vw,40px)/1.1 Inter,system-ui,sans-serif;letter-spacing:-.03em">' + title + '</div><div style="opacity:.7;font-size:13px;line-height:1.7;max-width:80%">' + sub + '</div><div style="margin-top:6px"><span style="display:inline-block;padding:10px 18px;border-radius:999px;background:' + color + ';color:#0b1220;font-weight:700;font-size:12px">' + cta + "</span></div></div>";
  }
  if (preset === "divider") {
    const thick = Math.max(1, Math.round(Number(p.thick) || 2));
    // 填色：单色（线条色）/ 渐变（和文字同一套 --ve-grad 描述，见 core.mjs）
    let bg = color;
    if (p.fill === "grad" && p.grad) {
      const g = parseGradSpec(p.grad);
      if (g) bg = gradCss(g);
    }
    if (p.dir === "v") {
      return "<div" + meta + ' style="width:100%;height:100%;display:flex;justify-content:center"><div style="width:' + thick + 'px;height:100%;background:' + bg + '"></div></div>';
    }
    return "<div" + meta + ' style="width:100%;height:100%;display:flex;align-items:center"><div style="width:100%;height:' + thick + 'px;background:' + bg + '"></div></div>';
  }
  return "";
}

function refreshPresetEl(key, node) {
  try {
    const el = [...refs.stage.querySelectorAll(".ve-ins")].find((n) => n.dataset.veOverlay === key);
    if (!el) return;
    const html = presetHtml(node);
    node.attrs = { ...(node.attrs || {}), html };
    el.innerHTML = html;
    if (node.style && node.style.opacity != null) el.style.opacity = String(node.style.opacity);
    updateDirty();
  } catch { /* ignore */ }
}

/** 常用组件预设：结构化参数，面板里可实时改细节 */
function insertPreset(kind, extraParams) {
  const base = {
    nav: { w: 720, h: 46, x: 24, y: 24, params: { items: ["首页", "案例", "工艺", "流程", "联系"], gap: 28 } },
    button: { w: 180, h: 44, x: 40, y: 160, params: { text: "按钮文字" } },
    card: { w: 300, h: 160, x: 40, y: 200, params: { title: "卡片标题", desc: "这里是一段卡片描述文字，可以直接改。" } },
    divider: { w: 360, h: 16, x: 40, y: 240, params: { dir: "h", thick: 2, fill: "solid" } },
    hero: { w: 760, h: 360, x: 40, y: 120, params: { title: "让 AI 出稿，让人收尾", sub: "改完直接落盘，刷新就是成品。", cta: "开始使用" } },
  }[kind];
  if (!base) return;
  const vertical = kind === "divider" && extraParams && extraParams.dir === "v";
  // 默认落到当前选中容器内（视觉上在同一个容器里），并记住容器作为锚点
  let targetEl = S.selected;
  try {
    if (targetEl && targetEl.__veOverlayId) targetEl = null;
    if (targetEl && (isTextEl(targetEl) || targetEl.childElementCount === 0)) targetEl = targetEl.parentElement;
    if (targetEl && targetEl.closest && targetEl.closest("#__ve_host")) targetEl = null;
  } catch { targetEl = null; }
  let px = base.x, py = base.y;
  let pw = base.w, ph = base.h;
  let refKey = "";
  try {
    if (targetEl) {
      const tr = rectOf(targetEl);
      px = Math.round(tr.left + 20);
      py = Math.round(tr.top + 20);
      pw = Math.max(120, Math.min(base.w, Math.round(tr.width - 40)));
      ph = base.h;
      refKey = elementKey(targetEl) || "";
    }
  } catch { /* ignore */ }
  const id = "ov" + Math.random().toString(36).slice(2, 8);
  const key = `overlay:${id}`;
  const node = {
    id, preset: kind, params: { ...base.params, ...(extraParams || {}) },
    style: { pad: kind === "nav" ? 20 : 18, radius: kind === "divider" ? 0 : 12, bg: kind === "card" ? "rgba(12,20,16,.86)" : "rgba(12,20,16,.92)", color: "#E2DBC8", opacity: 1 },
    attrs: { html: "" },
    tag: "div",
    x: px, y: py,
    width: vertical ? 16 : pw,
    height: vertical ? 240 : ph,
    z: 1200,
    pin: "auto",
    refKey,
  };
  if (targetEl) toast("已创建在当前容器：" + layerLabelOf(targetEl), 1600);
  initOverlayPin(node);
  node.attrs.html = presetHtml(node);
  S.pending[key] = { __overlay: node };
  const freshEl = renderOverlay(key, node);
  S.dockOverlayKey = key;
  updateDirty();
  select(freshEl);
  clearNativeSelection();
  const names = { nav: "导航栏", button: "按钮", card: "卡片", divider: vertical ? "竖分割线" : "分割线" };
  toast("已插入" + (names[kind] || "组件") + "：右侧面板可直接调参数，改完即时生效", 2800);
}

/** 插入 Three.js 3D 画布（站点里有 three 时直接接入，否则退回 2D 占位） */
async function insertThreeScene() {
  const key = "overlay:three" + Math.random().toString(36).slice(2, 7);
  const id = "three" + Math.random().toString(36).slice(2, 7);
  const node = { id, tag: "div", attrs: { html: '<canvas style="display:block;width:100%;height:100%"></canvas>' }, x: 60, y: 160, width: 420, height: 260, z: 960 };
  initOverlayPin(node);
  S.dockOverlayKey = key;
  S.pending[key] = { __overlay: node };
  const el = renderOverlay(key, node);
  updateDirty();
  select(el);
  const canvas = el.querySelector("canvas");
  if (!canvas) return;
  try {
    const THREE = await import(/* @vite-ignore */ new URL("/node_modules/three/build/three.module.js", location.origin).href);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
    camera.position.z = 2.6;
    const geo = new THREE.IcosahedronGeometry(0.9, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xE2DBC8, wireframe: true, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    const fit = () => {
      const w = el.clientWidth || 420;
      const h = el.clientHeight || 260;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    fit();
    try { new ResizeObserver(fit).observe(el); } catch { /* ignore */ }
    const tick = () => {
      if (!el.isConnected) return;
      mesh.rotation.x += 0.006;
      mesh.rotation.y += 0.01;
      renderer.render(scene, camera);
      requestAnimationFrame(tick);
    };
    tick();
    toast("已插入 Three.js 画布（可拖动/缩放）", 2600);
  } catch (e) {
    // 站点没有可直接加载的 three：画一个 2D 占位，方便后续接代码
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = el.clientWidth * dpr;
      canvas.height = el.clientHeight * dpr;
      ctx.scale(dpr, dpr);
      const g = ctx.createLinearGradient(0, 0, el.clientWidth, el.clientHeight);
      g.addColorStop(0, "#19261d");
      g.addColorStop(1, "#2f4436");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, el.clientWidth, el.clientHeight);
      ctx.strokeStyle = "rgba(226,219,200,.55)";
      ctx.beginPath();
      for (let i = 0; i < 12; i += 1) {
        const a = (i / 12) * Math.PI * 2;
        ctx.lineTo(el.clientWidth / 2 + Math.cos(a) * 60, el.clientHeight / 2 + Math.sin(a) * 60);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = "#E2DBC8";
      ctx.font = "600 12px Inter, system-ui, sans-serif";
      ctx.fillText("Three.js 容器（可接入站点已有的 three）", 14, 22);
    }
    toast("已插入 3D 占位画布（站点未暴露 three 模块，可后续接代码）", 3200);
  }
}

/** 左侧坞插入：移除上一次由坞添加的图层，保证只存在一个 */
function clearDockOverlay() {
  try {
    const key = S.dockOverlayKey;
    if (!key) return;
    const el = [...refs.stage.querySelectorAll(".ve-ins")].find((n) => n.dataset.veOverlay === key);
    if (el) el.remove();
    if (S.pending[key]) delete S.pending[key];
    if (S.overlays && S.overlays[key]) delete S.overlays[key];
    S.dockOverlayKey = "";
    if (S.ovEl && S.ovEl.dataset && S.ovEl.dataset.veOverlay === key) S.ovEl = null;
  } catch { /* ignore */ }
}

function addOverlayNode(tag, attrs, opts = {}) {
  const id = "ov" + Math.random().toString(36).slice(2, 8);
  const key = `overlay:${id}`;
  const node = {
    id, tag, attrs,
    x: opts.x != null ? opts.x : 40,
    y: opts.y != null ? opts.y : 120,
    width: opts.width != null ? opts.width : 320,
    height: opts.height != null ? opts.height : 200,
    z: opts.z != null ? opts.z : 900,
    refKey: opts.refKey || "",
    pin: "auto",
  };
  if (!opts.refKey) initOverlayPin(node);
  S.pending[key] = { __overlay: node };
  const freshEl = renderOverlay(key, node);
  if ((opts && opts.dock) || S.dockInserting) { S.dockOverlayKey = key; S.dockInserting = false; }
  updateDirty();
  select(freshEl);
  clearNativeSelection();
  if (node.tag === "text") {
    const ovText = ui("#ovText");
    if (ovText) { ovText.focus(); ovText.select(); }
    toast("文字已插入：现在可以直接改内容", 2600);
  } else if (node.tag === "svg") {
    const ovSvg = ui("#ovSvg");
    if (ovSvg) ovSvg.focus();
    toast("SVG 已插入：可直接改源码 / 拖动 / 改尺寸", 2600);
  } else {
    toast("图片已插入：拖动调整位置；双击图片可换图", 3000);
  }
}

/** 清掉浏览器原生选区（拖组件时会被「拖选」污染，视觉上就是整页蓝框） */
function clearNativeSelection() {
  try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch { /* ignore */ }
}

function renderOverlay(key, node) {
  // 同一个组件只保留一个 DOM（重复渲染会留下「残影」）
  [...refs.stage.querySelectorAll(".ve-ins")].filter((n) => n.dataset.veOverlay === key).forEach((n) => n.remove());
  // 兼容历史组件：早期插入的分割线节点没有 preset，按 HTML 特征补上，才能用专用面板
  migrateOverlayPreset(node);
  const hasHtml = Boolean(node.attrs && typeof node.attrs.html === "string" && node.attrs.html.trim());
  const tag = node.tag === "text" ? "text" : node.tag === "img" && !hasHtml ? "img" : "div";
  const el = document.createElement(tag);
  el.className = "ve-ins";
  el.dataset.veOverlay = key;
  el.__veOverlayId = node.id;
  if (tag === "img") {
    el.setAttribute("src", node.attrs?.src || "");
    el.style.objectFit = "cover";
  } else if (tag === "text") {
    el.textContent = node.attrs?.text || "新文字";
    el.style.color = node.attrs?.color || "#111";
    el.style.fontSize = (node.attrs?.size || 24) + "px";
    el.style.fontWeight = "600";
    el.style.whiteSpace = "pre-wrap";
    el.style.lineHeight = "1.3";
  } else {
    el.innerHTML = node.attrs?.html || "";
  }
  el.style.position = "absolute";
  placeOverlayEl(el, node);
  try { syncAutoOverlays(); } catch { /* ignore */ }
  el.style.rotate = node.rotate ? `${Math.round(Number(node.rotate))}deg` : "";
  el.draggable = false;
  // 拖动组件：阻止默认行为，否则会触发浏览器的「拖选页面文字」→ 整页全选 + 蓝色残影
  el.addEventListener("dragstart", (e) => e.preventDefault());
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch { /* ignore */ }
    select(el);
    const start = { x: e.clientX, y: e.clientY, l: parseFloat(el.style.left), t: parseFloat(el.style.top) };
    const dragging = editOverlayNode(el); // 已保存的组件先复制进待保存层，拖动才会保存
    const move = (ev) => {
      let nx = start.l + ev.clientX - start.x;
      let ny = start.t + ev.clientY - start.y;
      if (S.grid.on && !ev.altKey) {
        nx = Math.round(nx / S.grid.size) * S.grid.size;
        ny = Math.round(ny / S.grid.size) * S.grid.size;
      }
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
      if (dragging) {
        dragging.x = nx;
        // page 模式存文档坐标（随页面滚动）；screen 模式就是视口坐标
        dragging.y = ny + (overlayPin(dragging) === "page" ? (window.scrollY || 0) : 0);
      }
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch { /* ignore */ }
      updateDirty();
      try { if (S.ovEl === el) fillOverlayPanel(el); } catch { /* ignore */ }
      // 拖完把选中框/悬停框贴回新位置，避免旧位置留下虚线残影
      try { if (S.selected === el) paintOutline(el); } catch { /* ignore */ }
      try { paintHover(null); } catch { /* ignore */ }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    select(el);
    const info = overlayEntry(el);
    if (!info) return;
    if (info.node.tag === "text") {
      const ovText = ui("#ovText");
      if (ovText) { ovText.focus(); ovText.select(); }
    } else if (info.node.tag === "img") {
      overlayReplaceImage();
    } else {
      const ovSvg = ui("#ovSvg");
      if (ovSvg) ovSvg.focus();
    }
  });
  refs.stage.appendChild(el);
  return el;
}

function applyOverlays(overrides) {
  for (const [key, entry] of Object.entries(overrides)) {
    if (entry?.__overlay) renderOverlay(key, entry.__overlay);
  }
}

async function pasteSvg() {
  const el = S.selected;
  if (el) ensureSnapshot(el);
  const key = el && elementKey(el);
  const code = await askText({ title: "替换成 SVG", placeholder: "粘贴 <svg> 源码" });
  if (!code || !key) return;
  if (!/^\s*<svg[\s>]/i.test(code)) { toast("这不像 SVG 源码"); return; }
  mutate(key, (e) => { e.attrs = { ...(e.attrs || {}), html: code }; });
  if (el.tagName.toLowerCase() === "svg") {
    el.outerHTML = code;
    toast("SVG 已替换（注意：outerHTML 替换后需要重选元素）");
  } else {
    addOverlayNode("svg", { html: code });
  }
  updateDirty();
}

/* ────────────────────────────── AI ────────────────────────────── */

function pageContext() {
  const anchors = [];
  const walk = (el, depth) => {
    if (depth > 7 || anchors.length > 80) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(el.tagName) || el === host) return;
    const text = el.childElementCount === 0 ? (el.textContent || "").trim() : "";
    const key = elementKey(el);
    if (key && (text || ["img", "canvas", "svg", "video"].includes(tag))) {
      anchors.push(`${key} | ${tag} | ${text.slice(0, 40) || el.getAttribute("src") || ""}`);
    }
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  return anchors.join("\n");
}

function selectionInfo() {
  const el = S.selected;
  if (!el) return null;
  const key = elementKey(el);
  if (!key) return null;
  const entry = entryOf(key) || {};
  return {
    key,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || "").trim().slice(0, 200),
    rect: rectOf(el),
    styles: {
      fontSize: cs(el, "font-size"), fontWeight: cs(el, "font-weight"),
      color: cs(el, "color"), lineHeight: cs(el, "line-height"),
    },
    override: entry,
  };
}

const AI_COMP_REFS = {
  glass: `<div class="glass-card"><h3>Title</h3><p>Description</p><button>Action</button></div><style>.glass-card{padding:24px;border-radius:20px;background:rgba(255,255,255,.16);backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.28);box-shadow:0 18px 50px rgba(20,40,90,.16)}</style>`,
  hover: `<button class="fx-btn">Get started</button><style>.fx-btn{border:0;border-radius:999px;padding:12px 22px;background:#2563eb;color:#fff;font-weight:700;transition:transform .18s ease,box-shadow .18s ease}.fx-btn:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(37,99,235,.35)}</style>`,
  reveal: `<div class="reveal">Content</div><style>.reveal{opacity:0;transform:translateY(16px);transition:opacity .7s ease,transform .7s cubic-bezier(.16,.84,.3,1)}.reveal.in{opacity:1;transform:none}</style>`,
  grad: `<h2 class="grad-text">Gradient title</h2><style>.grad-text{font-size:clamp(28px,4vw,56px);font-weight:800;background:linear-gradient(90deg,#2563eb,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent}</style>`,
  card: `<div class="card-grid"><article class="card"><h3>One</h3><p>Description</p></article><article class="card"><h3>Two</h3><p>Description</p></article></div><style>.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px}.card{padding:20px;border:1px solid #e6ebf4;border-radius:16px;background:#fff}</style>`,
};
function openAiComp() {
  const m = ui("#aiCompModal"); if (!m) return;
  m.hidden = false;
  const hint = ui("#aiCompHint"); if (hint) hint.textContent = "";
  const res = ui("#aiCompResult"); if (res) { res.hidden = true; res.textContent = ""; }
  const act = ui("#aiCompActions"); if (act) act.hidden = true;
}
async function aiCompRun() {
  const prompt = ui("#aiCompPrompt") ? String(ui("#aiCompPrompt").value || "").trim() : "";
  if (!prompt) { ui("#aiCompHint").textContent = "先写一句要创建什么组件。"; return; }
  const refKey = ui("#aiCompRef") ? ui("#aiCompRef").value : "";
  const reference = AI_COMP_REFS[refKey] || "";
  let context = "";
  try {
    const target = S.selected && !S.selected.__veOverlayId ? (isTextEl(S.selected) ? S.selected.parentElement : S.selected) : null;
    if (target) context = "当前容器：" + layerLabelOf(target) + "\n" + target.outerHTML.slice(0, 2500);
  } catch { /* ignore */ }
  ui("#aiCompHint").textContent = "生成中…";
  try {
    const res = await fetch(`${API}/ai-html`, { method: "POST", headers: { "Content-Type": "application/json", "x-ve-token": TOKEN }, body: JSON.stringify({ instruction: prompt, reference, context }) });
    const data = await res.json();
    if (!res.ok || !data.ok) { ui("#aiCompHint").textContent = data.error || "生成失败"; return; }
    const out = ui("#aiCompResult"); out.hidden = false; out.textContent = data.html;
    ui("#aiCompActions").hidden = false;
    ui("#aiCompHint").textContent = "生成好了，确认后插入当前容器。";
  } catch (e) { ui("#aiCompHint").textContent = "出错了：" + (e.message || e); }
}
function aiCompInsert() {
  const code = ui("#aiCompResult") ? String(ui("#aiCompResult").textContent || "").trim() : "";
  if (!code) { toast("还没有可插入的代码", 1400); return; }
  let target = S.selected && !S.selected.__veOverlayId ? (isTextEl(S.selected) ? S.selected.parentElement : S.selected) : null;
  let x = 40, y = 120, w = 520, h = 320, refKey = "";
  try {
    if (target) {
      const r = rectOf(target);
      x = Math.round(r.left + 16); y = Math.round(r.top + 16);
      w = Math.max(240, Math.round(r.width - 32)); h = 320;
      refKey = elementKey(target) || "";
    }
  } catch { /* ignore */ }
  addOverlayNode("div", { html: code }, { x, y, width: w, height: h, refKey, dock: true });
  const m = ui("#aiCompModal"); if (m) m.hidden = true;
  toast("组件已插入，拖到合适位置后保存", 2600);
}

async function aiRun() {
  const instruction = ui("#aiInput").value.trim();
  if (!instruction) { refs.aiHint.textContent = "先写一句要改什么。"; return; }
  refs.aiHint.textContent = "生成中…";
  refs.aiActions.hidden = true;
  try {
    const scope = ui("#aiScope").value;
    const res = await fetch(`${API}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ve-token": TOKEN },
      body: JSON.stringify({
        instruction,
        selection: scope === "selection" ? selectionInfo() : null,
        context: scope === "page" ? pageContext() : "",
        history: Object.keys(S.pending),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      refs.aiHint.textContent = data.error || "生成失败";
      if (data.needsConfig) refs.aiHint.innerHTML = data.error + ' <a href="#" data-act="ai-settings">去设置</a>';
      return;
    }
    S.aiOps = data.ops || [];
    if (!S.aiOps.length) { refs.aiHint.textContent = data.note || "AI 认为不需要改动。"; return; }
    refs.aiResult.hidden = false;
    refs.aiResult.innerHTML = S.aiOps.map((op) => {
      const k = op.key.replace(/^(id|sel):/, "").slice(0, 42);
      if (op.type === "style") return `<div><span class="t">样式</span> ${k} · ${Object.entries(op.props).map(([a, b]) => a + ":" + b).join(" ")}</div>`;
      if (op.type === "text") return `<div><span class="t">文字</span> ${k} → ${String(op.value).slice(0, 40)}</div>`;
      if (op.type === "attrs") return `<div><span class="t">属性</span> ${k} · ${Object.keys(op.props).join(",")}</div>`;
      if (op.type === "box") return `<div><span class="t">尺寸</span> ${k} · ${op.box.width}×${op.box.height}</div>`;
      return `<div><span class="t">${op.type}</span> ${k}</div>`;
    }).join("");
    refs.aiActions.hidden = false;
    refs.aiHint.textContent = data.note || `生成了 ${S.aiOps.length} 个操作，确认后应用。`;
  } catch (err) {
    refs.aiHint.textContent = `出错：${err.message}`;
  }
}

function applyOpsLocal(ops) {
  for (const op of ops || []) {
    try { const el = op && op.key ? resolve(op.key) : null; if (el) ensureSnapshot(el); } catch { /* ignore */ }
  }
  let n = 0;
  for (const op of ops || []) {
    const key = op && op.key;
    if (!key) continue;
    if (op.type === "style") mutate(key, (e) => { e.style = { ...(e.style || {}), ...op.props }; });
    else if (op.type === "text") mutate(key, (e) => { e.text = op.value; if (e.__orig === undefined) { const el = resolve(key); e.__orig = el && isTextEl(el) ? textOf(el) : ""; } });
    else if (op.type === "attrs") mutate(key, (e) => { e.attrs = { ...(e.attrs || {}), ...op.props }; });
    else if (op.type === "box") mutate(key, (e) => { e.box = { ...(e.box || {}), ...op.box }; });
    else if (op.type === "hide") mutate(key, (e) => { e.hidden = Boolean(op.hidden); });
    else if (op.type === "overlay" && op.node && typeof op.node === "object") {
      // 新增图层：写入 pending 层并立刻渲染（AI/agent 下发的"加元素"走这里）
      S.pending[key] = { ...(S.pending[key] || {}), __overlay: op.node };
      try {
        const stale = [...refs.stage.querySelectorAll(".ve-ins")].filter((el) => el.dataset.veOverlay === key);
        for (const el of stale) el.remove();
      } catch { /* ignore */ }
      renderOverlay(key, op.node);
      updateDirty();
    }
    else continue;
    n += 1;
  }
  return n;
}

function aiApply() {
  if (!S.aiOps?.length) return;
  const n = applyOpsLocal(S.aiOps);
  S.aiOps = null;
  refs.aiModal.hidden = true;
  refs.aiResult.hidden = true;
  refs.aiActions.hidden = true;
  refs.aiHint.textContent = "";
  toast(`AI 改了 ${n} 处，确认后点保存`);
}

/** 同步快捷按钮外观 */
function updateQuickState() {
  try { renderLayerTree(); } catch { /* ignore */ }
  try { const lb = ui("#locksBtn"); if (lb) lb.textContent = lockContainers ? "🔒 容器锁" : "🔓 容器锁"; } catch { /* ignore */ }
  try {
    const tbtn = refs.quick && refs.quick.querySelector('[data-act="text-mode"]');
    if (tbtn) tbtn.dataset.on = S.textMode ? "1" : "0";
  } catch { /* ignore */ }
  if (!refs.quick) return;
  const el = S.selected;
  const btnHide = refs.quick.querySelector('[data-act="quick-hide"]');
  const btnFlash = refs.quick.querySelector('[data-act="quick-flash"]');
  if (btnHide) {
    const entry = el ? entryOf(elementKey(el)) : null;
    btnHide.textContent = entry && entry.hidden ? "👁 显示" : "👁 隐藏";
  }
  if (btnFlash) btnFlash.dataset.on = S.flashOn ? "1" : "0";
  const btnAuto = refs.quick.querySelector('[data-act="toggle-autosave"]');
  if (btnAuto) {
    btnAuto.dataset.on = S.autoSave ? "1" : "0";
    btnAuto.title = S.autoSave
      ? "自动保存已开：改动静置约 2 秒自动保存到项目（点一下关闭）"
      : "自动保存已关：改完记得点「保存」（点一下打开）";
  }
}

/** 在候选栈里上下切一层 */
function cyclePick(dir) {
  if (!S.pickStack.length) {
    const el = S.selected;
    if (!el) return;
    const r = rectOf(el);
    pickStack(r.left + r.width / 2, r.top + Math.min(12, r.height / 2));
  }
  if (!S.pickStack.length) return;
  S.pickIndex = (S.pickIndex + dir + S.pickStack.length) % S.pickStack.length;
  const next = S.pickStack[S.pickIndex];
  if (next) {
    select(next);
    toast("已切到第 " + (S.pickIndex + 1) + "/" + S.pickStack.length + " 层：" + next.tagName.toLowerCase(), 1400);
  }
}

/* ─────────────────── 被宿主插件嵌入：框选 + postMessage 协议 ─────────────────── */

const PARENT = window.parent !== window ? window.parent : null;

function postToParent(type, payload = {}) {
  if (!PARENT) return;
  try { PARENT.postMessage({ __ve: "evt", type, ...payload }, "*"); } catch { /* 跨域时忽略 */ }
}

function normRect(x0, y0, x1, y1) {
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function paintMarquee(r) {
  if (!r || r.width < 1) { refs.marquee.style.display = "none"; return; }
  refs.marquee.style.display = "block";
  refs.marquee.style.left = `${r.left}px`;
  refs.marquee.style.top = `${r.top}px`;
  refs.marquee.style.width = `${r.width}px`;
  refs.marquee.style.height = `${r.height}px`;
}

function intersectsBox(a, b) {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

/** 框选：收集区域内最深层元素（叶子优先），带 key 与关键样式 */
function collectInRect(marqueeRect) {
  const pool = document.querySelectorAll("[data-ve-id]");
  const nodes = pool.length ? [...pool] : [...document.body.querySelectorAll("*")];
  const hits = [];
  for (const el of nodes) {
    if (!el || el === host || el.closest?.("#__ve_host")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    if (!intersectsBox(marqueeRect, r)) continue;
    hits.push({ el, rect: r, cs });
  }
  const leaves = hits.filter((h) => !hits.some((o) => o !== h && h.el.contains(o.el)));
  const list = (leaves.length ? leaves : hits).slice(0, 30);
  return list
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .map(({ el, rect, cs }) => {
      const key = elementKey(el);
      if (!key) return null;
      return {
        key,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        style: { fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color, lineHeight: cs.lineHeight },
      };
    })
    .filter(Boolean);
}

/** 框选区域截图：先把可读 canvas 画进去，再尽力用 foreignObject 光栅化 DOM */
async function captureRegion(r) {
  try {
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const out = document.createElement("canvas");
    out.width = Math.round(w * dpr);
    out.height = Math.round(h * dpr);
    const ctx = out.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    // ① 可读的 canvas（2D/WebGL）：直接按可视区域裁剪绘制
    for (const cv of document.querySelectorAll("canvas")) {
      const cr = cv.getBoundingClientRect();
      if (cr.width < 1 || cr.height < 1) continue;
      const x = Math.max(cr.left, r.left);
      const y = Math.max(cr.top, r.top);
      const x2 = Math.min(cr.right, r.left + w);
      const y2 = Math.min(cr.bottom, r.top + h);
      if (x2 <= x || y2 <= y) continue;
      try {
        const sx = (x - cr.left) * (cv.width / cr.width);
        const sy = (y - cr.top) * (cv.height / cr.height);
        const sw = (x2 - x) * (cv.width / cr.width);
        const sh = (y2 - y) * (cv.height / cr.height);
        ctx.drawImage(cv, sx, sy, sw, sh, x - r.left, y - r.top, x2 - x, y2 - y);
      } catch { /* 读不出来就跳过 */ }
    }

    // ② DOM 光栅化（尽力而为：同源样式内联进 foreignObject）
    try {
      const docW = document.documentElement.clientWidth;
      const docH = Math.max(document.documentElement.clientHeight, document.body.scrollHeight);
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script,link,iframe,canvas").forEach((n) => n.remove());
      let css = "";
      for (const sheet of document.styleSheets) {
        try { css += [...sheet.cssRules].map((rule) => rule.cssText).join("\n"); } catch { /* 跨域跳过 */ }
      }
      const holder = document.createElement("div");
      holder.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
      holder.style.cssText = "margin:0;padding:0;width:" + docW + "px;min-height:" + docH + "px;background:#fff";
      const st = document.createElement("style");
      st.textContent = css;
      holder.appendChild(st);
      holder.appendChild(clone);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + docW + '" height="' + docH + '">' +
        '<foreignObject x="0" y="0" width="' + docW + '" height="' + docH + '">' +
        new XMLSerializer().serializeToString(holder) +
        "</foreignObject></svg>";
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      });
      ctx.drawImage(img, Math.round(r.left), Math.round(r.top), w, h, 0, 0, w, h);
    } catch { /* 保留 canvas 版结果 */ }

    return out.toDataURL("image/png");
  } catch { return ""; }
}

function startMarquee() {
  if (S.marquee) return;
  S.marquee = true;
  if (!S.on) setMode();
  document.documentElement.style.cursor = "crosshair";
  toast("拖一个框截取这一块（Esc 取消）", 2600);
  const down = (e) => {
    if (insideEditor(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev) => paintMarquee(normRect(x0, y0, ev.clientX, ev.clientY));
    const up = (ev) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointerdown", down, true);
      refs.marquee.style.display = "none";
      S.marquee = false;
      const r = normRect(x0, y0, ev.clientX, ev.clientY);
      if (r.width < 6 || r.height < 6) { postToParent("marquee", { items: [] }); return; }
      const items = collectInRect(r);
      S.marqueeItems = items;
      document.documentElement.style.cursor = "";
      postToParent("marquee", { items, rect: r });
      captureRegion(r).then((dataUrl) => {
        if (dataUrl) postToParent("shot", { dataUrl, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } });
      });
      toast(`已截取区域（${items.length} 个元素）`, 1800);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  };
  document.addEventListener("pointerdown", down, true);
  const onEsc = (e) => {
    if (e.key !== "Escape") return;
    if (S.group) { exitGroup(); toast("已退出组", 1200); }
    S.marquee = false;
    document.documentElement.style.cursor = "";
    refs.marquee.style.display = "none";
    window.removeEventListener("keydown", onEsc, true);
    postToParent("marquee", { items: [], cancelled: true });
  };
  window.addEventListener("keydown", onEsc, true);
}

function onParentMessage(e) {
  const d = e.data;
  if (!d || d.__ve !== "cmd") return;
  const type = d.type;
  if (type === "ping") postToParent("pong", { href: location.href });
  else if (type === "theme-query") reportTheme();
  else if (type === "enter-marquee") startMarquee();
  else if (type === "exit-marquee") { S.marquee = false; refs.marquee.style.display = "none"; }
  else if (type === "apply-ops") {
    const n = applyOpsLocal(d.ops || []);
    postToParent("applied", { count: n, ops: d.ops || [] });
    toast(`AI 改了 ${n} 处，确认后保存`, 2200);
  } else if (type === "save") {
    save().then((r) => postToParent("saved", { result: r }));
  } else if (type === "select") {
    const el = d.key ? resolve(d.key) : null;
    if (el) select(el);
    postToParent("selected", { key: d.key || null, ok: Boolean(el) });
  } else if (type === "dock-set") {
    try {
      const dock = shadow.querySelector(".ve-left");
      if (dock) {
        const closed = Boolean(d && d.closed);
        dock.setAttribute("data-closed", closed ? "1" : "0");
          try { if (window.__veDockTabSync) window.__veDockTabSync(); } catch { /* ignore */ }
        try { localStorage.setItem("ve:dockClosed", closed ? "1" : "0"); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  } else if (type === "rec-start") { recStart(); }
  else if (type === "rec-stop") { recStop(); }
  else if (type === "layers-list") {
    try {
      S.layerEls = listLayerCandidates();
      postToParent("layers", { items: S.layerEls.map((x, i) => ({ i, label: x.label, w: x.w, h: x.h, x: x.x, y: x.y })) });
    } catch { /* ignore */ }
  } else if (type === "layer-select") {
    try {
      const it = (S.layerEls || [])[Number(d.index)];
      if (it && it.el && it.el.isConnected) { select(it.el, true); toast("已选中：" + (it.label || ""), 1400); }
    } catch { /* ignore */ }
  } else if (type === "history-list") {
    try {
      postToParent("history", {
        ptr: HIST.ptr,
        steps: HIST.steps.map((s, i) => ({
          i,
          id: s.id,
          label: s.label || "",
          at: s.at || 0,
          keys: Object.keys((s.state && s.state.entries) || {}).length,
        })),
      });
    } catch { /* ignore */ }
  } else if (type === "history-jump") {
    try {
      const idx = Math.max(0, Math.min(HIST.steps.length - 1, Number(d.index)));
      HIST.ptr = idx;
      S.mergeStep = null;
      applyStateOf(HIST.steps[idx] && HIST.steps[idx].state);
      try { persistSteps(); } catch { /* ignore */ }
      toast("已跳转到第 " + (idx + 1) + "/" + HIST.steps.length + " 步", 1200);
    } catch (e) { toast("跳转失败：" + String((e && e.message) || e), 2200); }
  } else if (type === "reset-all") { resetAll(); }
  else if (type === "pages") {
    S.pages = Array.isArray(d.pages) ? d.pages : [];
    if (typeof d.current === "string") S.currentPage = d.current;
    updatePageNavUI();
    // 页面列表到齐后，按默认策略显示（用户手动关掉的除外；工作台嵌入时 ve_nav=0 不显示）
    applyPageNavDefault();
    // 切页/刷新会重新注入内核：缓存一份页面列表，刷新后胶囊仍然常驻
    try {
      sessionStorage.setItem("ve:pages", JSON.stringify({
        pages: S.pages,
        current: S.currentPage || "",
        at: Date.now(),
      }));
    } catch { /* ignore */ }
  }
  else if (type === "insert-page-nav") { showPageNavUI(); }
  else if (type === "hide-page-nav") { hidePageNavUI(); }
  else if (type === "cleanup-legacy-nav") { cleanupLegacyPageNav(); }
  else if (type === "copy-element") { copyElement(); }
  else if (type === "paste-element") { pasteElement(); }
  else if (type === "copy-style") { copyStyle(); }
  else if (type === "paste-style") { pasteStyle(); }
  else if (type === "undo") { doUndo(); }
  else if (type === "redo") { doRedo(); }
  else if (type === "autosave") { setAutoSave(Boolean(d.on)); postToParent("autosave", { on: S.autoSave }); }
  else if (type === "align") {
    alignSelected(d.kind);
    postToParent("aligned", { kind: d.kind, count: (S.multi || []).length || (S.selected ? 1 : 0) });
  } else if (type === "grid") {
    if (typeof d.on === "boolean") S.grid.on = d.on;
    if (d.size != null) S.grid.size = Math.max(1, Math.min(200, Number(d.size) || 8));
    if (typeof d.objects === "boolean") S.grid.objects = d.objects;
    paintGrid();
    postToParent("grid", { on: S.grid.on, size: S.grid.size, objects: S.grid.objects });
  }
}
window.addEventListener("message", onParentMessage);

/* ────────────────────────────── 事件绑定 ────────────────────────────── */

function setMode() {
  S.on = !S.on;
  refs.tb.hidden = !S.on;
  refs.off.hidden = S.on;
  if (!S.on) {
    select(null);
    refs.grid.style.display = "none";
    refs.panel.hidden = true;
    try { const r = ui("#vePagenav"); if (r) r.hidden = true; } catch { /* ignore */ }
  } else {
    paintGrid();
    // 进入编辑态时把导航胶囊带上（编辑 UI 的一部分；纯浏览页面不出现）
    try { applyPageNavDefault(); } catch { /* ignore */ }
  }
}

function paintGrid() {
  if (!S.on || !S.grid.on || S.preview) { refs.grid.style.display = "none"; return; }
  const g = S.grid.size;
  refs.grid.style.display = "block";
  refs.grid.style.backgroundImage =
    `linear-gradient(to right, rgba(47,92,255,.11) 1px, transparent 1px),` +
    `linear-gradient(to bottom, rgba(47,92,255,.11) 1px, transparent 1px)`;
  refs.grid.style.backgroundSize = `${g}px ${g}px`;
}

let raf = 0;
function refresh() {
  if (!S.on) return;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    // 滚动/缩放后旧坐标对应的元素可能已经变了：让拾取缓存失效
    S.pickStackPos = "";
    if (S.selected && !S.editing) {
      const alive = isConnected(S.selected);
      let visible = alive;
      if (alive) {
        try {
          const key0 = elementKey(S.selected);
          const entry0 = key0 ? entryOf(key0) : null;
          if (entry0 && entry0.hidden) {
            visible = true; // 我们主动隐藏的元素保持选中，方便点「显示」或重置
          } else {
            visible = effectiveVisible(S.selected) && S.selected.getBoundingClientRect().width > 0;
          }
        } catch { visible = false; }
      }
      // 滚动动画层里元素会变透明/移出：自动取消选择，避免选择框「滞留」在后续页面
      if (!alive || !visible) select(null);
      else { paintOutline(S.selected); placePanelFor(S.selected); }
    }
    if (S.hover && S.hover !== S.selected) paintHover(S.hover);
    else paintHover(null);
    if (S.flashOn) stopFlash();
  });
}

/** 编辑模式：拦截链接跳转与表单提交；按住 Alt 才放行 */
function onGuardClick(e) {
  if (!S.on || S.preview || S.marquee) return;
  const path = e.composedPath ? e.composedPath() : [];
  const ins = path.find((n) => n && n.classList && n.classList.contains("ve-ins"));
  if (insideEditor(e) && !ins) return;
  if (e.altKey) return;
  const link = path.find((n) => n && n.tagName && /^(A|AREA)$/i.test(n.tagName) && n.getAttribute && n.getAttribute("href"))
    || (e.target && e.target.closest ? e.target.closest("a[href], area[href]") : null);
  if (link) {
    e.preventDefault();
    e.stopPropagation();
    toast("编辑模式已拦截跳转 → " + (link.getAttribute("href") || "").slice(0, 60) + "（按住 Alt 点击可跳转）", 2600);
    return;
  }
  const form = path.find((n) => n && n.tagName === "FORM")
    || (e.target && e.target.closest ? e.target.closest("form") : null);
  if (form) {
    e.preventDefault();
    e.stopPropagation();
    toast("编辑模式已拦截表单提交", 2000);
  }
}

/** 组件/容器特征（类名、角色、标签） */
const VE_CONTAINER_RE = /(fab|btn|button|card|nav|menu|logo|icon|group|wrap|container|panel|tabs?|list|item|chip|badge|toolbar|header|footer|hero|avatar|switch|toggle|slider|shelf|bg|background|surface|backdrop|glass|sheet|tile|block|inner|outer|frame|body)/i;

function isContainerLike(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (["button", "a", "li", "figure", "nav", "header", "footer", "section", "article", "aside", "form", "label"].includes(tag)) return true;
    const cls = (el.getAttribute && (el.getAttribute("class") || "")) || "";
    const role = (el.getAttribute && (el.getAttribute("role") || "")) || "";
    if (role) return true;
    if (VE_CONTAINER_RE.test(cls)) return true;
    return false;
  } catch { return false; }
}

/** 容器优先：从最深元素往上，找到第一个"像组件容器"的祖先 */
function componentOf(el) {
  try {
    let n = el;
    let fallback = el;
    for (let i = 0; i < 8 && n && n !== document.body && n !== document.documentElement; i += 1) {
      if (isContainerLike(n)) {
        const r = n.getBoundingClientRect();
        if (r.width >= 16 && r.height >= 16) return n;
      }
      n = n.parentElement;
    }
    return fallback;
  } catch { return el; }
}

/** 找到"真正画这块背景"的元素：有背景色/图片 + 圆角，且面积不会大到是整个页面 */
/** 列出页面里"卡片级"元素（有背景 + 圆角，或类名像卡片/面板），供图层清单点选 */
function listLayerCandidates() {
  const out = [];
  try {
    const vp = window.innerWidth * window.innerHeight;
    const all = document.querySelectorAll("section,article,aside,nav,header,footer,main,div,figure,li,a,button,svg,img,canvas,video,picture,use");
    for (const el of all) {
      if (out.length >= 150) break;
      try {
        if (el.closest && el.closest("#__ve_host")) continue;
        const r = el.getBoundingClientRect();
        { /* 尺寸下限由下面的 minSize 判定 */ }
        if (r.width * r.height > vp * 0.92) continue;
        const st = getComputedStyle(el);
        const bg = st.backgroundColor || "";
        const emptyBg = /^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg) || bg === "transparent";
        const hasBg = Boolean(bg && !emptyBg);
        const hasImg = Boolean(st.backgroundImage && st.backgroundImage !== "none");
        const rad = parseFloat(st.borderRadius) || 0;
        const cls = String(el.getAttribute("class") || "");
        const tag2 = el.tagName.toLowerCase();
        const isGraphic = ["svg", "img", "canvas", "video", "picture", "use"].includes(tag2);
        const looksCard = /(card|panel|tile|sheet|glass|surface|block|wrap|box|modal|drawer|sidebar|icon|logo|graphic|illustration|art|badge|brand)/i.test(cls);
        const minSize = isGraphic ? 8 : 40;
        if (r.width >= minSize && r.height >= minSize && (isGraphic || ((hasBg || hasImg) && (rad >= 4 || looksCard)))) {
          out.push({ el, label: el.tagName.toLowerCase() + (cls ? "." + cls.trim().split(/\s+/).slice(0, 3).join(".") : ""), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}

function paintOwnerOf(el) {
  try {
    const vp = window.innerWidth * window.innerHeight;
    const baseR = el.getBoundingClientRect();
    const baseArea = Math.max(1, baseR.width * baseR.height);
    let firstBg = null;
    let n = el;
    for (let i = 0; i < 10 && n && n !== document.body && n !== document.documentElement; i += 1) {
      const r = n.getBoundingClientRect();
      const area = Math.max(1, r.width * r.height);
      if (area > vp * 0.45) break; // 太大：整列/整页容器，停止
      let st = null;
      try { st = getComputedStyle(n); } catch { st = null; }
      if (st) {
        const bg = st.backgroundColor || "";
        const emptyBg = /^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg) || bg === "transparent" || bg === "rgba(0, 0, 0, 0)";
        const hasBg = Boolean(bg && !emptyBg);
        const hasImg = Boolean(st.backgroundImage && st.backgroundImage !== "none");
        const rad = parseFloat(st.borderRadius) || 0;
        if (hasBg || hasImg) {
          if (!firstBg) firstBg = n;
          // 卡片级：有背景 + 明显圆角 + 至少是点击元素的 3 倍大
          if (rad >= 6 && area >= baseArea * 3) return n;
        }
      }
      n = n.parentElement;
    }
    return firstBg;
  } catch { return null; }
}

/** 按当前模式选取 */
function pickByMode(x, y) {
  const deep = pickEl(x, y);
  if (!deep) return null;
  // 组模式：只能在组内部选（更精细）
  if (S.group && S.group.isConnected) {
    if (S.group.contains(deep)) {
      // 组内仍可用 Ctrl+点击选择更深层；默认给"组内最贴近点击的元素"
      return deep;
    }
    // 点到组外：自动退出组
    exitGroup();
    return deep;
  }
  if (S.pickMode === "container") {
    const owner = paintOwnerOf(deep);
    if (owner && owner !== deep) return owner;
    return componentOf(deep);
  }
  return deep;
}

/** 进入组：高亮容器边界，之后的单击优先选组内元素 */
function enterGroup(el) {
  try {
    exitGroup();
    if (!el) return;
    S.group = el;
    S.groupOrigOutline = el.style.outline;
    S.groupOrigOffset = el.style.outlineOffset;
    el.style.setProperty("outline", "2px dashed #8b5cf6", "important");
    el.style.setProperty("outline-offset", "2px", "important");
    toast("已进入组：" + (el.className ? "." + String(el.className).split(" ")[0] : el.tagName.toLowerCase()) + "（单击选组内元素，Esc 退出）", 2600);
  } catch { /* ignore */ }
}

function exitGroup() {
  try {
    if (S.group) {
      S.group.style.setProperty("outline", S.groupOrigOutline || "");
      S.group.style.setProperty("outline-offset", S.groupOrigOffset || "");
      if (!S.groupOrigOutline) S.group.style.removeProperty("outline");
      if (!S.groupOrigOffset) S.group.style.removeProperty("outline-offset");
    }
  } catch { /* ignore */ }
  S.group = null;
}

let lastFocusGrabAt = 0;
/** 点击预览时把键盘焦点抢回 iframe（否则焦点留在 DSH 聊天框里，撤销快捷键收不到） */
function grabPreviewFocus() {
  try {
    const now = Date.now();
    if (now - lastFocusGrabAt < 400) return;
    lastFocusGrabAt = now;
    try { window.focus(); } catch { /* ignore */ }
    const ae = document.activeElement;
    if (ae && ae !== document.body && typeof ae.blur === "function") { try { ae.blur(); } catch { /* ignore */ } }
    try { postToParent("preview-focus"); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

let lockContainers = true;
try { lockContainers = localStorage.getItem("ve:lockContainers") !== "0"; } catch { /* ignore */ }

function isLayoutContainer(el) {
  try {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || "").toUpperCase();
    // 只锁「宽度接近整屏」的页面级大容器；内部 grid/flex/.wrap 不再锁
    if (!["SECTION", "HEADER", "FOOTER", "NAV", "MAIN"].includes(tag)) return false;
    const vw = document.documentElement.clientWidth || window.innerWidth || 0;
    const r = el.getBoundingClientRect();
    return vw > 0 && r.width >= vw * 0.92;
  } catch { return false; }
}

function layoutLockedFor(el) {
  return Boolean(lockContainers && isLayoutContainer(el));
}

function onPointerDown(e) {
  grabPreviewFocus();
  if (!S.on || S.preview || S.marquee) return;
  if (insideEditor(e)) return;
  // 悬浮导航胶囊：点击只负责展开/收起，不参与选中/拖动（避免点一下就弹面板+大选框）
  try {
    if (e.target && e.target.closest && (e.target.closest("[data-ve-pagenav]") || e.target.closest("[data-ve-pagenav-toggle]"))) return;
  } catch { /* ignore */ }
  if (S.editing) {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/⌘+点击：结束就地编辑，按普通选择处理（会弹面板）
      stopEditing(true);
      S.editing = null;
    } else {
      // 在正在编辑的元素内部点击/拖选文字时不要退出编辑，否则没法框选整段
      if (e.target && S.editing.el && S.editing.el.contains && S.editing.el.contains(e.target)) return;
      stopEditing(true);
      return;
    }
  }
  if (S.textMode) {
    const leaf = textLeafAt(e.clientX, e.clientY);
    if (leaf) {
      e.preventDefault();
      e.stopPropagation();
      select(leaf);
      const ta = ui("#tContent");
      if (ta && !ta.disabled) {
        ta.focus();
        try { ta.setSelectionRange(0, (ta.value || "").length); } catch { /* ignore */ }
        ta.scrollIntoView({ block: "nearest" });
      }
      toast("已抓取文字：" + (leaf.textContent || "").trim().slice(0, 18) + "（可直接改，回车保存）", 2200);
      return;
    }
  }
  // 每次点击都重建候选（下滑后同一坐标对应的元素会变，不能吃缓存）
  // Ctrl+Shift+点击：诊断该位置真实的层叠元素（排查"选不中"）
  if (e.ctrlKey && e.altKey) {
    try {
      const raw = (document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : []).slice(0, 6).map(function (n) {
        var cls = String((n.getAttribute && n.getAttribute("class")) || "");
        return n.tagName.toLowerCase() + (cls ? "." + cls.trim().split(/\s+/)[0] : "");
      });
      var ranked = [];
      try {
        pickStack(e.clientX, e.clientY);
        ranked = (S.pickStack || []).slice(0, 5).map(function (n) {
          var cls = String((n.getAttribute && n.getAttribute("class")) || "");
          var base = rankCandidate(n, e.clientX, e.clientY);
          var eff = base + (S.pickHit === n ? 30 : (S.pickHit && n.contains(S.pickHit) ? -60 : 0));
          return n.tagName.toLowerCase() + (cls ? "." + cls.trim().split(/\s+/)[0] : "") + "(" + eff + (eff !== base ? "=" + base + (eff > base ? "+" : "") + (eff - base) : "") + ")";
        });
      } catch (err) { /* ignore */ }
      const chosen = (S.pickStack || [])[0];
      var chosenInfo = chosen ? (chosen.tagName.toLowerCase() + "." + String((chosen.getAttribute && chosen.getAttribute("class")) || "").trim().split(/\s+/)[0]) : "(无)";
      e.preventDefault();
      e.stopPropagation();
      toast("命中：" + (raw[0] || "-") + "\n选中：" + chosenInfo + "\n排序：" + ranked.join(" > "), 8000);
      console.info("[ve] pick diag", { raw, ranked, chosen: chosenInfo });
      return;
    } catch (err) { /* ignore */ }
  }
  S.pickStackPos = "";
  let el = pickByMode(e.clientX, e.clientY);
  if (el && e.shiftKey && e.ctrlKey) {
    // Ctrl+Shift+点击：多选（加入/移出多选集合），方便做对齐
    e.preventDefault();
    e.stopPropagation();
    toggleMulti(el);
    select(el, true);
    return;
  }
  if (el && e.shiftKey) {
    // Shift+点击：只选立即父级，不继续上溯到更上层/页面根元素
    const parent = el.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement && parent.tagName !== "HTML") el = parent;
  }
  if (!el) { select(null); toast("这里没有可编辑元素（可能是 canvas / 视频 / 空白区）", 1800); return; }
  e.preventDefault();
  e.stopPropagation();
  const inMulti = Boolean(S.multi && S.multi.length > 1 && S.multi.indexOf(el) >= 0);
  if (e.ctrlKey || e.metaKey) {
    // 第一次 Ctrl+点击：把当前选中元素一起带进多选，符合常见操作习惯
    if (!S.multi || !S.multi.length) {
      if (S.selected && S.selected !== el) { S.multi = [S.selected]; toggleMulti(el); }
      else toggleMulti(el);
    } else toggleMulti(el);
  } else if (!inMulti) { S.multi = []; paintMulti(); }
  select(el, Boolean(e.ctrlKey || e.metaKey));
  try { paintMulti(); } catch { /* ignore */ }
  if (e.button !== 0) return;
  if (layoutLockedFor(el) && !e.shiftKey) {
    toast("容器宽度/位置已锁定；高度仍可调。要移动请点「🔓 容器锁」解锁，或按住 Shift 拖动。", 2600);
    return;
  }
  beginDrag(el, e, "move");
  window.addEventListener("pointermove", onDragMove, true);
  const up = (ev) => {
    window.removeEventListener("pointermove", onDragMove, true);
    window.removeEventListener("pointerup", up, true);
    if (S.drag && !S.drag.moved && S.hover !== ev.target) { /* 单击只选中 */ }
    endDrag();
  };
  window.addEventListener("pointerup", up, true);
}

function onPointerMove(e) {
  if (!S.on || S.preview || S.drag || S.editing) return;
  if (insideEditor(e)) { paintHover(null); return; }
  const el = pickEl(e.clientX, e.clientY);
  S.hover = el && el !== S.selected ? el : null;
  paintHover(S.hover);
}

function onDblClick(e) {
  if (!S.on || S.preview || insideEditor(e)) return;
  // 组模式：双击可进入组（之后单击只选组内元素）；已在组内则走正常双击（编辑文字等）
  try {
    if (!S.group) {
      const raw = e.target && e.target.nodeType === 1 ? e.target : null;
      const target = raw && !(raw.closest && raw.closest("#__ve_host")) ? raw : pickEl(e.clientX, e.clientY);
      // 文本叶子（比如 h1 里的 span.accent）双击应该直接改字，不要进入组件组
      if (target && isTextEl(target)) { /* skip group entry */ }
      else {
      const container = target ? componentOf(target) : null;
      if (container && container !== target) {
        e.preventDefault();
        e.stopPropagation();
        enterGroup(container);
        select(container, true);
        return;
      }
      }
    }
  } catch { /* ignore */ }
  // 真实双击时用事件目标更准（避免被覆盖层抢走）；合成事件再退回坐标命中
  const rawTarget = e.target && e.target.nodeType === 1 ? e.target : null;
  const fromTarget = rawTarget && !(rawTarget.closest && rawTarget.closest("#__ve_host")) ? rawTarget : null;
  let el = fromTarget || pickEl(e.clientX, e.clientY);
  // 兜底：目标落在画布/图片/空白包装层上（例如整层 pointer-events:none 的封面、加载遮罩），
  // 按坐标再抓一次「这一点的文字」，否则会误以为没点到文字（双击改不了字就是这个原因）
  const weak = !el
    || ["CANVAS", "IMG", "VIDEO", "BODY", "HTML", "SECTION", "DIV"].includes(el.tagName)
    || !String(el.textContent || "").trim();
  if (weak && !isTextEl(el)) {
    const leaf = textLeafAt(e.clientX, e.clientY);
    if (leaf) el = leaf;
  }
  // 双击在图标/图片等非文字元素上时，允许它的父级文字节点
  if (el && !isTextEl(el) && el.parentElement && isTextEl(el.parentElement) && el.childElementCount === 0) el = el.parentElement;
  if (!el) return;
  // 双击在无文字的背景上：给个提示，别让人以为双击坏了
  if (!isTextEl(el) && !String(el.textContent || "").trim()) {
    toast("这里不是文字，双击文字本身就能直接改", 2000);
    return;
  }
  // 只有「被拆成单字/单词的碎片」才自动升级成整段；正常段落仍然双击就地编辑（可框选整段）
  if (el.childElementCount === 0) {
    let fragment = false;
    try {
      const cs = getComputedStyle(el);
      const p = el.parentElement;
      const siblings = p ? [...p.children].filter((x) => x !== el && x.tagName !== "BR") : [];
      const animParent = Boolean(p) && (
        siblings.length >= 4 ||
        /(split|word|char|letter|reveal|fragment)/i.test(String(p.className || "") + " " + String(el.className || ""))
      );
      fragment = animParent || (cs.display.startsWith("inline") && (el.textContent || "").trim().length <= 2 && siblings.length >= 3);
    } catch { fragment = false; }
    if (fragment) {
      const block = findTextBlock(el);
      if (block && block !== el) {
        e.preventDefault();
        e.stopPropagation();
        S.blockEl = block;
        S.blockKey = elementKey(block);
        S.panelTab = "text";
        select(block);
        ui("#tContent").disabled = false;
        ui("#tContent").focus();
        toast("这是逐字/逐词动画文本，已切成整段编辑；改完点底部「保存」或回车", 3000);
        return;
      }
    }
  }
  e.preventDefault();
  e.stopPropagation();
  // 双击：进入就地编辑，同时把面板带到「文字」页（嵌入模式下面板是主要编辑入口，
  // 万一 iframe 没拿到键盘焦点，也能直接在面板的「内容」框里改）
  select(el, true);
  startEditing(el);
}

/** Ctrl +/- ：文字元素改字号，其他元素改宽高 */
/* ───────────────── 多选 & 对齐 ───────────────── */
S.multi = S.multi || [];

/* 复制/粘贴：元素副本 + 样式（格式刷） */
let clipElement = null;
let clipStyle = null;
let pasteOffset = 0;

const STYLE_CLIP_PROPS = [
  "color", "background-color", "background-image", "background-size", "background-position", "background-repeat",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-transform", "text-decoration-line", "text-decoration-color",
  "border-top-width", "border-top-style", "border-top-color",
  "border-right-width", "border-right-style", "border-right-color",
  "border-bottom-width", "border-bottom-style", "border-bottom-color",
  "border-left-width", "border-left-style", "border-left-color",
  "border-radius", "box-shadow", "text-shadow", "opacity", "filter", "backdrop-filter",
];

function multiEls() {
  const list = (S.multi || []).filter((el) => el && el.isConnected);
  if (list.length) return list;
  return S.selected ? [S.selected] : [];
}

function paintMulti() {
  try {
    let layer = document.getElementById("__ve_multi");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "__ve_multi";
      layer.setAttribute("data-ve-editor-ui", "1");
      layer.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2147483000";
      document.documentElement.appendChild(layer);
    }
    layer.innerHTML = "";
    const list = multiEls();
    // 只有真正多选（≥2）时才画框；单选交给主轮廓，避免叠一个"1"号框
    if (list.length < 2) return;
    for (const el of list) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const isCur = el === S.selected;
      const d = document.createElement("div");
      d.style.cssText =
        "position:fixed;left:" + Math.round(r.left) + "px;top:" + Math.round(r.top) + "px;" +
        "width:" + Math.round(r.width) + "px;height:" + Math.round(r.height) + "px;" +
        "border:" + (isCur ? "1.5px solid #2f5cff" : "1.5px dashed #2f5cff") + ";" +
        "background:" + (isCur ? "rgba(47,92,255,.04)" : "rgba(47,92,255,.10)") + ";" +
        "border-radius:2px;box-sizing:border-box";
      const idx = document.createElement("i");
      idx.textContent = String(list.indexOf(el) + 1);
      idx.style.cssText = "position:absolute;left:-1px;top:-17px;background:#2f5cff;color:#fff;font:10px/1.5 ui-monospace,monospace;font-style:normal;padding:0 4px;border-radius:3px 3px 0 0";
      d.appendChild(idx);
      layer.appendChild(d);
    }
  } catch { /* ignore */ }
}

function toggleMulti(el) {
  if (!S.multi) S.multi = [];
  const i = S.multi.indexOf(el);
  if (i >= 0) S.multi.splice(i, 1);
  else S.multi.push(el);
  paintMulti();
  toast(S.multi.length > 1 ? "已多选 " + S.multi.length + " 个元素" : "已取消多选", 900);
}

function fillParentRow() {
  const el = S.selected;
  const parent = el && el.parentElement;
  if (!parent) { toast("先选中一个元素", 1400); return; }
  const pk = elementKey(parent);
  if (!pk) { toast("父容器无法定位", 1400); return; }
  let cs = null;
  let gcs = null;
  try { cs = getComputedStyle(parent); } catch { cs = null; }
  try { gcs = parent.parentElement ? getComputedStyle(parent.parentElement) : null; } catch { gcs = null; }
  ensureSnapshot(parent);
  mutate(pk, (e) => {
    e.style = { ...(e.style || {}) };
    e.style.width = "100%";
    e.style["max-width"] = "none";
    e.style["min-width"] = "0";
    e.style["margin-left"] = "0";
    e.style["margin-right"] = "0";
    e.style["box-sizing"] = "border-box";
    if (cs && /flex/.test(cs.display)) {
      e.style["flex"] = "1 1 100%";
      e.style["justify-content"] = "center";
      e.style["align-items"] = "center";
    }
    if (cs && /grid/.test(cs.display)) {
      e.style["grid-column"] = "1 / -1";
      e.style["justify-items"] = "center";
    }
    // 父元素自己如果是 grid/flex 的子项，也要跨满整行
    if (gcs && /grid/.test(gcs.display)) e.style["grid-column"] = "1 / -1";
    if (gcs && /flex/.test(gcs.display)) e.style["flex"] = "1 1 100%";
    e.style["text-align"] = "center";
  }, { record: false, batch: false });
  try { pushStep("父级占满行"); } catch { /* ignore */ }
  responsiveCenter();
  toast("父容器已占满整行并居中", 1600);
}

function responsiveCenter() {
  const els = multiEls().filter((el) => el && el.isConnected);
  if (!els.length) { toast("先选中要居中的元素", 1400); return; }
  let n = 0;
  for (const el of els) {
    const key = elementKey(el);
    if (!key) continue;
    ensureSnapshot(el);
    mutate(key, (e) => {
      e.box = { ...(e.box || {}), x: 0 };
      e.style = { ...(e.style || {}) };
      if (!e.style.position || e.style.position === "static") e.style.position = "relative";
      e.style.left = "50%";
      e.style.transform = "translateX(-50%)";
      e.style["max-width"] = "100%";
      // 文本块只做盒子居中还不够，文字仍会左对齐；标题/段落/按钮同时居中文字
      if (/^(H[1-6]|P|SPAN|A|BUTTON|LABEL|LI|STRONG|EM)$/i.test(el.tagName)) e.style["text-align"] = "center";
    }, { record: false, batch: false });
    n += 1;
  }
  try { pushStep("响应式居中"); } catch { /* ignore */ }
  try { paintOutline(S.selected); } catch { /* ignore */ }
  toast("已响应式居中 " + n + " 个元素（换窗口仍居中）", 1800);
}

function alignSelected(kind) {
  const els = multiEls().filter((el) => el && el.isConnected);
  if (!els.length) { toast("先选中元素（Ctrl+点击可多选）", 1200); return; }
  const boxes = els.map((el) => ({ el, r: el.getBoundingClientRect() }));
  let target = null;
  if (boxes.length >= 2) {
    if (kind === "align-left") target = Math.min(...boxes.map((b) => b.r.left));
    else if (kind === "align-right") target = Math.max(...boxes.map((b) => b.r.right));
    else if (kind === "align-centerX") target = boxes.reduce((s, b) => s + b.r.left + b.r.width / 2, 0) / boxes.length;
    else if (kind === "align-top") target = Math.min(...boxes.map((b) => b.r.top));
    else if (kind === "align-bottom") target = Math.max(...boxes.map((b) => b.r.bottom));
    else if (kind === "align-centerY") target = boxes.reduce((s, b) => s + b.r.top + b.r.height / 2, 0) / boxes.length;
  } else {
    const el = boxes[0].el;
    const parentEl = el.parentElement;
    const pr = parentEl ? parentEl.getBoundingClientRect() : { left: 0, top: 0, right: document.documentElement.clientWidth || innerWidth, bottom: document.documentElement.clientHeight || innerHeight, width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight };
    if (kind === "align-left") target = pr.left;
    else if (kind === "align-right") target = pr.right;
    else if (kind === "align-centerX") target = pr.left + pr.width / 2;
    else if (kind === "align-top") target = pr.top;
    else if (kind === "align-bottom") target = pr.bottom;
    else if (kind === "align-centerY") target = pr.top + pr.height / 2;
  }
  for (const item of boxes) {
    const { el, r } = item;
    const key = elementKey(el);
    if (!key) continue;
    let dx = 0;
    let dy = 0;
    if (kind === "align-left") dx = target - r.left;
    else if (kind === "align-right") dx = target - r.right;
    else if (kind === "align-centerX") dx = target - (r.left + r.width / 2);
    else if (kind === "align-top") dy = target - r.top;
    else if (kind === "align-bottom") dy = target - r.bottom;
    else if (kind === "align-centerY") dy = target - (r.top + r.height / 2);
    if (!dx && !dy) continue;
    ensureSnapshot(el);
    S.pending[key] = clone(S.pending[key] || S.overrides[key] || {});
    const box = S.pending[key].box || { x: 0, y: 0 };
    S.pending[key].box = { x: (box.x || 0) + dx, y: (box.y || 0) + dy };
  }
  scheduleStyles();
  if (S.selected) paintOutline(S.selected);
  paintMulti();
  updateDirty();
  try { pushStep("对齐 " + kind); } catch { /* ignore */ }
  toast("已对齐 " + els.length + " 个元素（可 Ctrl+Z 撤销）", 1200);
}

function quickResize(dir) {
  const el = S.selected;
  if (!el) return;
  const key = elementKey(el);
  if (!key) return;
  ensureSnapshot(el);
  const leaf = (S.textLeaf && el.contains && el.contains(S.textLeaf)) ? S.textLeaf : (isTextEl(el) ? el : null);
  if (leaf) {
    const cs = getComputedStyle(leaf);
    const cur = parseFloat(cs.fontSize) || 16;
    const next = Math.max(6, Math.round((cur + dir * 2) * 10) / 10);
    setStyleProp(elementKey(leaf) || key, "font-size", next + "px");
    toast("字号 " + next + "px", 900);
    return;
  }
  const r = rectOf(el);
  const w = Math.max(4, Math.round(r.width + dir * 8));
  const h = Math.max(4, Math.round(r.height + dir * 8));
  setStyleProp(key, "width", w + "px");
  setStyleProp(key, "height", h + "px");
  toast("尺寸 " + w + "×" + h, 900);
}

/** Ctrl + ←/→ 字距；Ctrl + ↑/↓ 行距（仅文字元素） */
function quickSpacing(k) {
  const el = S.selected;
  if (!el) return;
  const leaf = (S.textLeaf && el.contains && el.contains(S.textLeaf)) ? S.textLeaf : (isTextEl(el) ? el : null);
  if (!leaf) { toast("选中文字元素后可用 Ctrl+方向键调字距/行距", 1400); return; }
  const key = elementKey(leaf);
  if (!key) return;
  ensureSnapshot(leaf);
  const cs = getComputedStyle(leaf);
  if (k === "ArrowLeft" || k === "ArrowRight") {
    const cur = parseFloat(cs.letterSpacing) || 0;
    const next = Math.round((cur + (k === "ArrowLeft" ? -0.5 : 0.5)) * 100) / 100;
    setStyleProp(key, "letter-spacing", next + "px");
    toast("字距 " + next + "px", 900);
  } else {
    const cur = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 16) * 1.5;
    const next = Math.max(8, Math.round((cur + (k === "ArrowUp" ? -2 : 2)) * 10) / 10);
    setStyleProp(key, "line-height", next + "px");
    toast("行距 " + next + "px", 900);
  }
}

function onKey(e) {
  if (!S.on) return;
  // 深度取焦点元素（含 shadow DOM），保证在输入框里时快捷键完全交给文本、不碰页面撤回
  const deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  const active = deepActive();
  const t = (e.composedPath && e.composedPath()[0]) || active;
  // Ctrl+Z / Ctrl+Shift+Z 最高优先级：不管焦点在页面哪里（输入框、可编辑文字、面板里），都先撤销页面改动
  {
    const metaZA = e.ctrlKey || e.metaKey;
    const isZ = e.code === "KeyZ" || String(e.key).toLowerCase() === "z";
    const isY = e.code === "KeyY" || String(e.key).toLowerCase() === "y";
    if (metaZA && isZ) {
      e.preventDefault();
      try { if (S.editing) { stopEditing(true); S.editing = null; } } catch { /* ignore */ }
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (metaZA && isY) {
      e.preventDefault();
      try { if (S.editing) { stopEditing(true); S.editing = null; } } catch { /* ignore */ }
      doRedo();
      return;
    }
  }
  const isTextInput = (n) => n && n.nodeType === 1 && (n.isContentEditable || /^(input|textarea|select)$/i.test(n.tagName));
  // 只有"页面里的"输入框才拦截撤销；编辑器面板自己的输入框不拦截（否则改完描边/宽度后 Ctrl+Z 就卡住）
  const inEditorUi = (n) => {
    try {
      if (!n || n.nodeType !== 1) return false;
      if (n.getRootNode && n.getRootNode() === shadow) return true;
      return Boolean(n.closest && n.closest("#__ve_host"));
    } catch { return false; }
  };
  const editorTyping = inEditorUi(t) || inEditorUi(active);
  const typing = !editorTyping && (isTextInput(t) || isTextInput(active));
  if (typing) return;
  const meta = e.ctrlKey || e.metaKey;
  {
    const key = String(e.key || "").toLowerCase();
    const code = e.code || "";
    // 复制/粘贴样式：Ctrl+Shift+C / Ctrl+Shift+V
    if (meta && e.shiftKey && (code === "KeyC" || key === "c")) { e.preventDefault(); copyStyle(); return; }
    if (meta && e.shiftKey && (code === "KeyV" || key === "v")) { e.preventDefault(); pasteStyle(); return; }
    // 复制/粘贴元素：Ctrl+C / Ctrl+V
    if (meta && (code === "KeyC" || key === "c")) { e.preventDefault(); copyElement(); return; }
    if (meta && (code === "KeyV" || key === "v")) { e.preventDefault(); pasteElement(); return; }
  }
  if (meta && (e.code === "KeyZ" || String(e.key).toLowerCase() === "z")) {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if (meta && (e.code === "KeyY" || String(e.key).toLowerCase() === "y")) { e.preventDefault(); doRedo(); return; }
  if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
  if (meta && e.key === "Enter") { e.preventDefault(); try { postToParent("toggle-ai"); } catch { /* ignore */ } return; }
  if (e.code === "NumpadAdd" || e.code === "NumpadSubtract") {
    e.preventDefault();
    quickResize(e.code === "NumpadSubtract" ? -1 : 1);
    return;
  }
  if (meta && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    quickSpacing(e.key);
    return;
  }
  if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    try {
      const active2 = document.activeElement;
      const typing2 = active2 && active2.nodeType === 1 && (active2.isContentEditable || /^(input|textarea|select)$/i.test(active2.tagName));
      if (!typing2) {
        const dock = shadow.querySelector(".ve-left");
        if (dock) {
          const closing = dock.getAttribute("data-closed") !== "1";
          dock.setAttribute("data-closed", closing ? "1" : "0");
          try { localStorage.setItem("ve:dockClosed", closing ? "1" : "0"); } catch { /* ignore */ }
          try { if (window.__veDockTabSync) window.__veDockTabSync(); } catch { /* ignore */ }
        }
        e.preventDefault();
        return;
      }
    } catch { /* ignore */ }
  }
  if (e.key === "Escape") {
    // 纯预览窗口：Esc 不退出，保证录屏画面干净（关掉窗口即可离开）
    if (refs.ui.classList.contains("ve-pure-hard")) return;
    S.preview = false; applyPreview(); select(null); refs.aiModal.hidden = true; refs.setModal.hidden = true; return;
  }
  if (e.key.toLowerCase() === "t" && !meta && !e.altKey && !e.shiftKey && e.type === "keydown") {
    if (!S.textMode) {
      S.textMode = true;
      updateQuickState();
      toast("文字选择模式：点哪抓哪段文字（松开 T 结束）", 1800);
    }
    return;
  }
  if (e.key.toLowerCase() === "f" && !meta && !e.altKey) {
    e.preventDefault();
    S.flashOn = !S.flashOn;
    if (!S.flashOn) stopFlash();
    else if (S.selected) startFlash(S.selected);
    updateQuickState();
    toast(S.flashOn ? "闪烁开关：开（选中元素会闪 3 秒）" : "闪烁开关：关", 1600);
    return;
  }
  if (e.key === "Delete" && S.selected && !typing) {
    e.preventDefault();
    deleteElement();
    return;
  }
  if (e.key === "Backspace" && S.selected && !typing) {
    e.preventDefault();
    mutate(elementKey(S.selected), (en) => { en.hidden = true; });
    toast("已隐藏，保存后生效");
    return;
  }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") && S.selected) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const key = elementKey(S.selected);
    mutate(key, (en) => {
      en.box = en.box || { x: 0, y: 0 };
      if (e.key === "ArrowUp") en.box.y -= step;
      if (e.key === "ArrowDown") en.box.y += step;
      if (e.key === "ArrowLeft") en.box.x -= step;
      if (e.key === "ArrowRight") en.box.x += step;
    });
    paintOutline(S.selected);
  }
}

function applyPreview() {
  const pure = Boolean(S.preview);
  refs.ui.classList.toggle("ve-preview", pure);
  // 左侧组件坞的收起小把手是注入在页面 DOM 里的（不在影子里），纯预览时也要一起收掉
  try {
    const dockTab = document.getElementById("__ve_docktab");
    if (dockTab) dockTab.style.display = pure ? "none" : "";
  } catch { /* ignore */ }
  refs.tb.hidden = !S.on;
  if (pure) {
    refs.panel.hidden = true;
    refs.outline.style.display = "none";
    refs.hover.style.display = "none";
    refs.grid.style.display = "none";
    // 组件层（插入的分割线等）是页面设计的一部分，纯预览里要保留，只让它不响应鼠标
    refs.stage.style.display = "";
  } else {
    refs.stage.style.display = "";
    paintGrid();
    if (S.selected) select(S.selected);
  }
}

/** 纯预览：隐藏编辑器所有界面 + 尽量进入全屏（浏览器不允许时静默忽略，按 F11 亦可） */
function enterPurePreview() {
  S.preview = true;
  applyPreview();
  try { toast("纯预览：按 Esc 退出；F11 可全屏", 2800); } catch { /* ignore */ }
  try {
    const d = document.documentElement;
    if (!document.fullscreenElement && d.requestFullscreen) {
      const promise = d.requestFullscreen();
      if (promise && promise.catch) promise.catch(() => {});
    }
  } catch { /* ignore */ }
}

function exitPurePreview() {
  S.preview = false;
  applyPreview();
  try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch { /* ignore */ }
}

/* 手柄 */
refs.outline.querySelectorAll(".ve-handle").forEach((h) => {
  h.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!S.selected) return;
    beginDrag(S.selected, e, "resize", h.dataset.dir);
    window.addEventListener("pointermove", onDragMove, true);
    const up = () => {
      window.removeEventListener("pointermove", onDragMove, true);
      window.removeEventListener("pointerup", up, true);
      endDrag();
    };
    window.addEventListener("pointerup", up, true);
  });
});

/* 工具栏 */
refs.tb.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "undo") doUndo();
  else if (act === "redo") doRedo();
  else if (act === "grid") {
    S.grid.on = !S.grid.on;
    btn.dataset.active = S.grid.on ? "1" : "0";
    paintGrid();
  } else if (act === "objects") {
    S.grid.objects = !S.grid.objects;
    btn.dataset.active = S.grid.objects ? "1" : "0";
  } else if (act === "save") save();
  else if (act === "preview") { S.preview = !S.preview; applyPreview(); }
  else if (act === "newwin") openInNewWindow();
  else if (act === "pure") openPureWindow();
  else if (act === "exit-preview") exitPurePreview();
  else if (act === "guides") {
    const g = pageGuides();
    const box = ui("#guideBox");
    if (box) { box.hidden = g.on; }
    if (!g.on) setPageGuides({ on: true });
    else if (box) box.hidden = false;
  }
  else if (act === "ai") { refs.aiModal.hidden = false; }
  else if (act === "select") { /* 默认模式 */ }
  else if (act === "text" && S.selected) startEditing(S.selected);
});

refs.gridSize.innerHTML = GRID_PRESETS.map((g) => `<option value="${g}">${g}px</option>`).join("");
refs.gridSize.value = "8";
refs.gridSize.addEventListener("change", () => {
  S.grid.size = Number(refs.gridSize.value) || 8;
  paintGrid();
});

/* 面板交互 */
refs.tabs.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  S.panelTab = b.dataset.tab;
  if (S.selected && S.selected.__veOverlayId && S.panelTab !== "ov") S.panelTab = "ov";
  refs.tabs.querySelectorAll("button").forEach((x) => { x.dataset.on = x === b ? "1" : "0"; });
  shadow.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== S.panelTab; });
});

function bindInput(sel, handler, event = "input") {
  const el = ui(sel);
  if (!el) return;
  let timer = 0;
  el.addEventListener(event, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (S.selected) handler(el.value, S.selected); }, 120);
  });
}

// 文字改成「草稿模式」：打字不实时改页面，点保存/回车才应用，可框选多个字一起改
{
  const askInput = ui("#askInput");
  if (askInput) {
    askInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        closeAsk(askInput.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeAsk(null);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const s0 = askInput.selectionStart;
        askInput.value = askInput.value.slice(0, s0) + "\n" + askInput.value.slice(askInput.selectionEnd);
        askInput.selectionStart = askInput.selectionEnd = s0 + 1;
      }
    });
  }
}
/* 文本域兜底：把我们自己的全局监听挡在外面，让浏览器原生拖选/光标正常 */
try {
  const taGuard = ui("#tContent");
  taGuard.__veTaGuard = true;
  for (const evt of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"]) {
    taGuard.addEventListener(evt, (e) => { e.stopPropagation(); }, false);
  }
  taGuard.addEventListener("keydown", (e) => { e.stopPropagation(); }, false);
  taGuard.addEventListener("keyup", (e) => { e.stopPropagation(); }, false);
  taGuard.style.setProperty("user-select", "text", "important");
  taGuard.style.setProperty("-webkit-user-select", "text", "important");
  taGuard.draggable = false;
} catch { /* ignore */ }

{
  const runSel2 = ui("#tRunSelect");
  if (runSel2) {
    runSel2.addEventListener("change", () => {
      const idx = Number(runSel2.value) || 0;
      const runs = S.textRuns || [];
      const run = runs[idx];
      if (!run) return;
      S.textRunIndex = idx;
      S.textLeaf = run.el;
      S.textRun = run;
      S.draftDirty = false;
      const ta2 = ui("#tContent");
      ta2.value = String(run.text || "");
      S.appliedText = ta2.value;
      if (ui("#tTextHint")) {
        ui("#tTextHint").textContent = "正在编辑第 " + (idx + 1) + " 段：" + String(run.text).slice(0, 20);
        ui("#tTextHint").hidden = false;
      }
      ta2.focus();
    });
  }
}

ui("#tContent").addEventListener("input", () => {
  S.draftDirty = true;
  const ta = ui("#tContent");
  ta.style.borderColor = "#f59e0b";
});
ui("#tContent").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    commitTextDraft();
    ui("#tContent").style.borderColor = "";
    return;
  }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    // Ctrl+回车 = 内容里换行
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + "\n" + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 1;
    S.draftDirty = true;
  }
});
bindInput("#tSize", (v, el) => setStyleProp(elementKey(el), "font-size", `${Math.max(1, Number(v) || 16)}px`));

/** 四值输入（外边距/内边距/圆角）：锁链按下时四个一起改 */
function bindQuad(kind, prop, ids, defaultLocked) {
  const inputs = ids.map((id) => ui("#" + id)).filter(Boolean);
  const lockBtn = ui("#b" + kind + "Lock");
  const locked = () => Boolean(S["lock" + kind]);
  const apply = () => {
    if (!S.selected) return;
    const vals = inputs.map((inp) => (inp.value === "" ? "" : Math.round(Number(inp.value))));
    const css = vals.every((v) => v === "") ? "" : vals.map((v) => (v === "" ? "0" : v + "px")).join(" ");
    setStyleProp(elementKey(S.selected), prop, css);
  };
  inputs.forEach((inp) => inp.addEventListener("input", () => {
    if (locked()) inputs.forEach((x) => { x.value = inp.value; });
    apply();
  }));
  if (lockBtn) {
    lockBtn.addEventListener("click", () => {
      S["lock" + kind] = !locked();
      lockBtn.dataset.on = locked() ? "1" : "0";
      if (locked() && inputs[0]) { const v = inputs[0].value; inputs.forEach((x) => { x.value = v; }); apply(); }
    });
    lockBtn.dataset.on = locked() ? "1" : "0";
  }
}
/** 选纯色：把渐变清掉（否则渐变里的「透明字色」会让新颜色看不见） */
function setSolidTextColor(hex) {
  if (!S.selected) return;
  const el = S.selected;
  const key = elementKey(el);
  removeGrad(key, el);
  setStyleProp(key, "color", hex || "");
  S.gradEdit = null;
  const wrap = ui("#tColorMode");
  if (wrap) wrap.querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.mode === "solid" ? "1" : "0"; });
  const box = ui("#tGradBox");
  if (box) box.hidden = true;
  const row = ui("#tSolidRow");
  if (row) row.hidden = false;
}

bindInput("#tWeight", (v, el) => setStyleProp(elementKey(el), "font-weight", v), "change");
bindInput("#tLine", (v, el) => setStyleProp(elementKey(el), "line-height", v === "" ? "" : Math.round(Number(v)) + "px"));
bindInput("#tSpacing", (v, el) => setStyleProp(elementKey(el), "letter-spacing", v === "" ? "" : Math.round(Number(v) * 10) / 10 + "px"));
bindInput("#tColorHex", (v) => {
  if (v && /^#[0-9a-f]{3,8}$/i.test(String(v).trim())) ui("#tColor").value = String(v).trim();
  setSolidTextColor(v);
});
bindInput("#tFamily", (v, el) => setStyleProp(elementKey(el), "font-family", v || ""), "change");
bindInput("#tHref", (v) => {
  const link = S.linkEl;
  if (!link) return;
  mutate(elementKey(link), (e) => { e.attrs = { ...(e.attrs || {}), href: v }; });
});
ui("#tColor").addEventListener("input", (e) => {
  if (!S.selected) return;
  ui("#tColorHex").value = e.target.value;
  setSolidTextColor(e.target.value);
});
shadow.querySelectorAll("#tAlign button").forEach((b) => b.addEventListener("click", () => {
  if (!S.selected) return;
  setStyleProp(elementKey(S.selected), "text-align", b.dataset.align);
  shadow.querySelectorAll("#tAlign button").forEach((x) => { x.dataset.on = x === b ? "1" : "0"; });
}));
bindInput("#iSrc", (v, el) => mutate(elementKey(el), (e) => { e.attrs = { ...(e.attrs || {}), src: v }; }));
bindInput("#iColor", (v) => {
  if (!S.selected) return;
  const el = S.selected;
  removeGrad(elementKey(el), el);
  mutate(elementKey(el), (e) => { e.style = { ...(e.style || {}), color: v }; });
  S.gradEdit = null;
  const wrap = ui("#iColorMode");
  if (wrap) wrap.querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.mode === "solid" ? "1" : "0"; });
  const box = ui("#iGradBox");
  if (box) box.hidden = true;
  const row = ui("#iColorRow");
  if (row) row.hidden = false;
});
bindInput("#iAlt", (v, el) => mutate(elementKey(el), (e) => { e.attrs = { ...(e.attrs || {}), alt: v }; }));
shadow.querySelectorAll("#iFit button").forEach((b) => b.addEventListener("click", () => {
  if (!S.selected) return;
  setStyleProp(elementKey(S.selected), "object-fit", b.dataset.fit);
  shadow.querySelectorAll("#iFit button").forEach((x) => { x.dataset.on = x === b ? "1" : "0"; });
}));
/** 显式设宽高时，解除父级 flex 的收缩 / 拉伸限制，否则宽度会被 flex 布局"压缩"回来 */
function unlockFlexSize(el) {
  try {
    const key = elementKey(el);
    if (!key) return;
    // 不再只在 flex/grid 父级里解锁：文字 <p> 常见的 max-width 也会把宽度卡住
    mutate(key, (e) => {
      e.style = { ...(e.style || {}) };
      e.style["flex"] = "0 0 auto";
      e.style["max-width"] = "none";
      e.style["min-width"] = "0";
      e.style["max-height"] = "none";
      e.style["min-height"] = "0";
      e.style["box-sizing"] = "border-box";
      const cs = getComputedStyle(el);
      if (cs.display === "inline") e.style["display"] = "inline-block";
    }, { record: false });
  } catch { /* ignore */ }
}

bindInput("#sW", (v, el) => {
  if (layoutLockedFor(el)) { toast("容器已锁定：不要用固定宽度，改宽请先解锁", 2200); return; }
  const key = elementKey(el);
  const n = Math.max(1, Number(v) || 1);
  const h = lockAspect ? Math.round(n / aspectRatio) : px(el.style.height) ?? rectOf(el).height;
  unlockFlexSize(el);
  mutate(key, (e) => {
    e.box = { ...(e.box || {}), width: n, height: lockAspect ? h : (e.box?.height ?? h) };
    e.style = { ...(e.style || {}), width: pxStr(n) };
    if (lockAspect) e.style.height = pxStr(h);
  });
});
bindInput("#sH", (v, el) => {
  const key = elementKey(el);
  const n = Math.max(1, Number(v) || 1);
  const w = lockAspect ? Math.round(n * aspectRatio) : px(el.style.width) ?? rectOf(el).width;
  unlockFlexSize(el);
  mutate(key, (e) => {
    e.box = { ...(e.box || {}), height: n, width: lockAspect ? w : (e.box?.width ?? w) };
    e.style = { ...(e.style || {}), height: pxStr(n) };
    if (lockAspect) e.style.width = pxStr(w);
  });
});
bindInput("#sX", (v, el) => mutate(elementKey(el), (e) => { e.box = { ...(e.box || {}), x: Number(v) || 0 }; }));
bindInput("#sY", (v, el) => mutate(elementKey(el), (e) => { e.box = { ...(e.box || {}), y: Number(v) || 0 }; }));
bindInput("#sZ", (v, el) => setStyleProp(elementKey(el), "z-index", String(Number(v) || 0)));
bindQuad("Margin", "margin", ["bMarginT", "bMarginR", "bMarginB", "bMarginL"], false);
bindQuad("Padding", "padding", ["bPaddingT", "bPaddingR", "bPaddingB", "bPaddingL"], false);
bindQuad("Radius", "border-radius", ["bRadiusTL", "bRadiusTR", "bRadiusBR", "bRadiusBL"], true);
bindInput("#bOpacity", (v, el) => setStyleProp(elementKey(el), "opacity", v));
/** 旋转：用 CSS 独立的 rotate 属性，跟拖拽用的 transform:translate 互不打架 */
function rotateTargetOf(el) {
  // 点卡片内部时，把旋转落到真正带旋转的卡片/容器上，而不是内部画布
  try {
    let node = el;
    for (let i = 0; i < 5 && node; i += 1) {
      const cs = getComputedStyle(node);
      const rot = String(cs.rotate || "none");
      let deg = 0;
      if (rot !== "none") deg = parseFloat(rot) || 0;
      else if (cs.transform && cs.transform !== "none") {
        const nums = cs.transform.match(/matrix\(([^)]+)\)/);
        if (nums) {
          const p = nums[1].split(",").map(Number);
          if (p.length >= 2) deg = Math.atan2(p[1], p[0]) * 180 / Math.PI;
        }
      }
      if (Math.abs(deg) > 0.5) return node;
      node = node.parentElement;
    }
  } catch { /* ignore */ }
  return el;
}

function applyRotate(el, deg) {
  const d = Number(deg);
  const norm = Number.isFinite(d) ? Math.round(d) : 0;
  const target = rotateTargetOf(el);
  setStyleProp(elementKey(target), "rotate", norm === 0 ? "" : `${norm}deg`);
  const inp = ui("#bRotate");
  if (inp) inp.value = norm === 0 ? "" : String(norm);
  const q = ui("#qRotate");
  if (q) q.value = norm === 0 ? "" : String(norm);
}
bindInput("#bRotate", (v, el) => applyRotate(el, v === "" ? 0 : Number(v)));
bindInput("#qRotate", (v, el) => applyRotate(el, v === "" ? 0 : Number(v)));
shadow.querySelectorAll("[data-qrot]").forEach((b) => b.addEventListener("click", () => {
  if (!S.selected) return;
  const step = Number(b.dataset.qrot);
  const cur = Number(ui("#qRotate") && ui("#qRotate").value) || 0;
  applyRotate(S.selected, step === 0 ? 0 : cur + step);
}));
shadow.querySelectorAll("[data-rot-step]").forEach((b) => b.addEventListener("click", () => {
  if (!S.selected) return;
  const step = Number(b.dataset.rotStep);
  const cur = Number(ui("#bRotate").value) || 0;
  applyRotate(S.selected, step === 0 ? 0 : cur + step);
}));
bindInput("#bTransform", (v, el) => setStyleProp(elementKey(el), "transform", v));
/* 普通元素外观：描边 / 毛玻璃 / 投影 */
try {
  const isSvgThing = (el) => {
    try {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName && el.tagName.toLowerCase() === "svg") return true;
      if (el.ownerSVGElement) return true;
      return false;
    } catch { return false; }
  };
  const isTextTarget = (el) => {
    try {
      if (!el || el.nodeType !== 1) return false;
      if (isSvgThing(el)) return false;
      const tag = String(el.tagName || "").toUpperCase();
      if (["IMG", "SVG", "CANVAS", "VIDEO", "IFRAME"].includes(tag)) return false;
      if (isTextEl(el)) return true;
      return el.childElementCount === 0 && String(el.textContent || "").trim().length > 0;
    } catch { return false; }
  };
  const applyBorder = (el) => {
    const on = ui("#aBorderOn") ? ui("#aBorderOn").checked : true;
    const w = Number((ui("#aBorderWidth") || {}).value) || 0;
    const c = (ui("#aBorderColor") || {}).value || "#ffffff";
    const key = elementKey(el);
    if (!key) return;
    // SVG / path：描边 = stroke（作用于图标本身及其内部路径），不是外框
    if (isSvgThing(el)) {
      setStyleProp(key, "--ve-svg-stroke", on && w > 0 ? c : "");
      setStyleProp(key, "--ve-svg-stroke-w", on && w > 0 ? String(w) : "");
      return;
    }
    if (!on || w <= 0) {
      // 关闭：显式去掉描边（包括元素原本的 border / outline），而不是删覆写（删了会恢复原本的浅色边）
      setStyleProp(key, "border", "0 solid transparent");
      setStyleProp(key, "outline", "0 solid transparent");
      return;
    }
    setStyleProp(key, "border", w + "px solid " + c);
    // 原描边若来自 outline / inset 阴影，改成 border 后压掉 outline，避免双线
    setStyleProp(key, "outline", "0 solid transparent");
  };
  const applyBlur = (el) => {
    const v = ui("#aBlurOn") && !ui("#aBlurOn").checked ? 0 : (Number((ui("#aBackBlur") || {}).value) || 0);
    const key = elementKey(el);
    if (!key) return;
    setStyleProp(key, "backdrop-filter", v > 0 ? "blur(" + v + "px)" : "");
    setStyleProp(key, "-webkit-backdrop-filter", v > 0 ? "blur(" + v + "px)" : "");
  };
  const applyShadow = (el) => {
    if (ui("#aShadowOn") && !ui("#aShadowOn").checked) { const key0 = elementKey(el); if (key0) setStyleProp(key0, "box-shadow", ""); return; }
    const y = Number((ui("#aShadowY") || {}).value) || 0;
    const b = Number((ui("#aShadowBlur") || {}).value) || 0;
    const a = Number((ui("#aShadowAlpha") || {}).value);
    const alpha = Number.isFinite(a) && a > 0 ? a : 0.25;
    const key = elementKey(el);
    if (!key) return;
    setStyleProp(key, "box-shadow", (y || b) ? "0 " + y + "px " + b + "px rgba(0,0,0," + alpha + ")" : "");
  };
  const applyTextStroke = (el) => {
    const on = ui("#tStrokeOn") ? ui("#tStrokeOn").checked : false;
    const w = Number((ui("#tStrokeWidth") || {}).value) || 0;
    const c = (ui("#tStrokeColor") || {}).value || "#ffffff";
    const key = elementKey(el);
    if (!key) return;
    if (!isTextTarget(el)) { toast("先选中文字元素，再用文字描边", 1600); return; }
    setStyleProp(key, "-webkit-text-stroke", on && w > 0 ? w + "px " + c : "");
    if (on && w > 0) setStyleProp(key, "paint-order", "stroke fill");
  };
  const applyTextShadow = (el) => {
    const on = ui("#tShadowOn") ? ui("#tShadowOn").checked : false;
    const y = Number((ui("#tShadowY") || {}).value) || 0;
    const b = Number((ui("#tShadowBlur") || {}).value) || 0;
    const a = Number((ui("#tShadowAlpha") || {}).value);
    const key = elementKey(el);
    if (!key) return;
    if (!isTextTarget(el)) { toast("先选中文字元素，再用文字投影", 1600); return; }
    setStyleProp(key, "text-shadow", on && (y || b) ? "0 " + y + "px " + b + "px rgba(0,0,0," + (Number.isFinite(a) && a > 0 ? a : 0.35) + ")" : "");
  };
  const applyTextGlass = (el) => {
    const on = ui("#tGlassOn") ? ui("#tGlassOn").checked : false;
    const v = Number((ui("#tGlassBlur") || {}).value) || 0;
    const key = elementKey(el);
    if (!key) return;
    if (!isTextTarget(el)) { toast("先选中文字元素，再用文字毛玻璃", 1600); return; }
    setStyleProp(key, "backdrop-filter", on && v > 0 ? "blur(" + v + "px)" : "");
    setStyleProp(key, "-webkit-backdrop-filter", on && v > 0 ? "blur(" + v + "px)" : "");
    setStyleProp(key, "background-color", on && v > 0 ? "rgba(255,255,255,0.16)" : "");
  };
  const sel = () => S.selected;
  const setEnabled = (on, sels) => {
    for (const s of sels) { const n = ui(s); if (n) n.disabled = !on; }
  };
  const syncDisabled = () => {
    try {
      setEnabled(Boolean(ui("#aBorderOn") && ui("#aBorderOn").checked), ["#aBorderColor", "#aBorderWidth"]);
      setEnabled(Boolean(ui("#aBlurOn") && ui("#aBlurOn").checked), ["#aBackBlur", "#aBackBlurNum"]);
      setEnabled(Boolean(ui("#aShadowOn") && ui("#aShadowOn").checked), ["#aShadowY", "#aShadowBlur", "#aShadowAlpha"]);
    } catch { /* ignore */ }
  };
  ["#aBorderOn", "#aBlurOn", "#aShadowOn"].forEach((s) => {
    const n = ui(s);
    if (n) n.addEventListener("change", () => {
      syncDisabled();
      const el = sel();
      if (!el) return;
      if (s === "#aBorderOn") {
        if (n.checked && ui("#aBorderWidth") && !ui("#aBorderWidth").value) ui("#aBorderWidth").value = 1;
        applyBorder(el);
      } else if (s === "#aBlurOn") {
        if (!n.checked) applyBlur(el); else { if (ui("#aBackBlurNum") && !Number(ui("#aBackBlurNum").value)) { ui("#aBackBlurNum").value = 12; if (ui("#aBackBlur")) ui("#aBackBlur").value = 12; } applyBlur(el); }
      } else {
        if (!n.checked) applyShadow(el); else { if (ui("#aShadowBlur") && !Number(ui("#aShadowBlur").value)) { ui("#aShadowBlur").value = 18; if (ui("#aShadowY") && !Number(ui("#aShadowY").value)) ui("#aShadowY").value = 6; if (ui("#aShadowAlpha") && !ui("#aShadowAlpha").value) ui("#aShadowAlpha").value = 0.25; } applyShadow(el); }
      }
    });
  });
  setTimeout(syncDisabled, 0);
  ["#aBorderColor", "#aBorderWidth"].forEach((s) => {
    const n = ui(s);
    if (n) n.addEventListener("input", () => { const el = sel(); if (el) applyBorder(el); });
  });
  ["#aBackBlur", "#aBackBlurNum"].forEach((s) => {
    const n = ui(s);
    if (n) n.addEventListener("input", () => {
      const el = sel(); if (!el) return;
      const v = Number((ui("#aBackBlur") || {}).value) || 0;
      if (ui("#aBackBlur")) ui("#aBackBlur").value = v;
      if (ui("#aBackBlurNum")) ui("#aBackBlurNum").value = v;
      applyBlur(el);
    });
  });
  ["#aShadowY", "#aShadowBlur", "#aShadowAlpha"].forEach((s) => {
    const n = ui(s);
    if (n) n.addEventListener("input", () => { const el = sel(); if (el) applyShadow(el); });
  });
  ["#tStrokeOn", "#tStrokeColor", "#tStrokeWidth"].forEach((id) => {
    const n = ui(id); if (!n) return;
    n.addEventListener("input", () => { const el = sel(); if (el) applyTextStroke(el); });
    n.addEventListener("change", () => { const el = sel(); if (el) applyTextStroke(el); });
  });
  ["#tShadowOn", "#tShadowY", "#tShadowBlur", "#tShadowAlpha"].forEach((id) => {
    const n = ui(id); if (!n) return;
    n.addEventListener("input", () => { const el = sel(); if (el) applyTextShadow(el); });
    n.addEventListener("change", () => { const el = sel(); if (el) applyTextShadow(el); });
  });
  ["#tGlassOn", "#tGlassBlur", "#tGlassBlurNum"].forEach((id) => {
    const n = ui(id); if (!n) return;
    n.addEventListener("input", () => {
      if (ui("#tGlassBlur") && id !== "#tGlassBlur") ui("#tGlassBlur").value = ui("#tGlassBlurNum").value;
      if (ui("#tGlassBlurNum") && id !== "#tGlassBlurNum") ui("#tGlassBlurNum").value = ui("#tGlassBlur").value;
      const el = sel(); if (el) applyTextGlass(el);
    });
  });
  const applyImageFx = (el) => {
    const key = elementKey(el);
    if (!key) return;
    const num = (id, d) => { const n = ui(id); const v = n ? Number(n.value) : d; return Number.isFinite(v) ? v : d; };
    const b = num("#iBright", 1), c = num("#iContrast", 1), s2 = num("#iSat", 1), bl = num("#iBlur", 0);
    const parts = [];
    if (Math.abs(b - 1) > 0.01) parts.push("brightness(" + b + ")");
    if (Math.abs(c - 1) > 0.01) parts.push("contrast(" + c + ")");
    if (Math.abs(s2 - 1) > 0.01) parts.push("saturate(" + s2 + ")");
    if (bl > 0) parts.push("blur(" + bl + "px)");
    setStyleProp(key, "filter", parts.length ? parts.join(" ") : "");
    const t = num("#iCropT", 0), r = num("#iCropR", 0), bo = num("#iCropB", 0), l = num("#iCropL", 0);
    setStyleProp(key, "clip-path", (t || r || bo || l) ? "inset(" + t + "% " + r + "% " + bo + "% " + l + "%)" : "");
  };
  ["#iBright", "#iBrightNum", "#iContrast", "#iContrastNum", "#iSat", "#iSatNum", "#iBlur", "#iBlurNum", "#iCropT", "#iCropR", "#iCropB", "#iCropL"].forEach((id) => {
    const n = ui(id); if (!n) return;
    n.addEventListener("input", () => {
      // 同步滑块和数字
      const pairs = [["#iBright", "#iBrightNum"], ["#iContrast", "#iContrastNum"], ["#iSat", "#iSatNum"], ["#iBlur", "#iBlurNum"]];
      for (const [a, b] of pairs) {
        if (id === a && ui(b)) ui(b).value = n.value;
        if (id === b && ui(a)) ui(a).value = n.value;
      }
      const el = sel(); if (el) applyImageFx(el);
    });
  });
  const applyOpacity = (el) => {
    const v = Number((ui("#aOpacityNum") || {}).value);
    const key = elementKey(el);
    if (!key) return;
    const op = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    setStyleProp(key, "opacity", op >= 0.999 ? "" : String(op));
  };
  ["#aOpacity", "#aOpacityNum"].forEach((s) => {
    const n = ui(s);
    if (n) n.addEventListener("input", () => {
      const el = sel();
      if (!el) return;
      if (s === "#aOpacity" && ui("#aOpacityNum")) ui("#aOpacityNum").value = ui("#aOpacity").value;
      if (s === "#aOpacityNum" && ui("#aOpacity")) ui("#aOpacity").value = ui("#aOpacityNum").value;
      applyOpacity(el);
    });
  });
} catch { /* ignore */ }
ui("#bDisplay").addEventListener("change", (e) => { if (S.selected) setStyleProp(elementKey(S.selected), "display", e.target.value); });

shadow.addEventListener("click", (e) => {
  const lr = e.target && e.target.closest ? e.target.closest("[data-layer-key]") : null;
  if (lr) {
    const toggle = e.target.closest("[data-layer-toggle]");
    if (toggle) {
      e.preventDefault(); e.stopPropagation();
      const k = toggle.dataset.layerToggle;
      if (!S.layerCollapsed || typeof S.layerCollapsed !== "object") S.layerCollapsed = {};
      S.layerCollapsed[k] = !S.layerCollapsed[k];
      renderLayerTree();
      return;
    }
    const hide = e.target.closest("[data-layer-hide]");
    if (hide) {
      e.preventDefault(); e.stopPropagation();
      const k = hide.dataset.layerHide;
      const en = S.overrides[k] || S.pending[k] || {};
      mutate(k, (x) => { x.hidden = !en.hidden; });
      renderLayerTree();
      return;
    }
    const el = resolve(lr.dataset.layerKey);
    if (el) { select(el); }
    return;
  }

  const crumbBtn = e.target && e.target.closest ? e.target.closest("[data-crumb-idx]") : null;
  if (crumbBtn) {
    try {
      const node = (S.crumbEls || [])[Number(crumbBtn.dataset.crumbIdx)];
      if (node && node.isConnected) select(node, true);
    } catch { /* ignore */ }
    return;
  }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "save") save();
  else if (act === "newwin") openInNewWindow();
  else if (act === "pure") openPureWindow();
  else if (act === "exit-preview") exitPurePreview();
  else if (act === "parent-fill") {
    fillParentRow();
    updateQuickState();
  }
  else if (act === "lock-containers") {
    lockContainers = !lockContainers;
    try { localStorage.setItem("ve:lockContainers", lockContainers ? "1" : "0"); } catch { /* ignore */ }
    const lb = ui("#locksBtn");
    if (lb) lb.textContent = lockContainers ? "🔒 容器锁" : "🔓 容器锁";
    toast(lockContainers ? "已锁定容器宽度/位置：高度仍可调" : "已解锁容器：拖动会把尺寸写死，慎用", 2200);
  }
  else if (act === "layer-refresh") { renderLayerTree(); }
  else if (act === "export-code") { exportSelectedCode(); }
  else if (act === "export-close") { const m = ui("#exportModal"); if (m) m.hidden = true; }
  else if (act === "export-copy") { copyExportText(); }
  else if (act === "export-download") { downloadExportText(); }
  else if (act === "resp-center") {
    responsiveCenter();
    updateQuickState();
  }
  else if (act === "quick-hide") {
    if (!S.selected) return;
    const key = elementKey(S.selected);
    const entry = entryOf(key) || {};
    mutate(key, (en) => { en.hidden = !entry.hidden; });
    updateQuickState();
  } else if (act === "quick-flash") {
    S.flashOn = !S.flashOn;
    if (!S.flashOn) stopFlash();
    else if (S.selected) startFlash(S.selected);
    updateQuickState();
    toast(S.flashOn ? "闪烁开关：开（选中元素会闪 3 秒）" : "闪烁开关：关", 1600);
  } else if (act === "toggle-autosave") setAutoSave(!S.autoSave);
  else if (act === "pick-up") cyclePick(-1);
  else if (act === "pick-down") cyclePick(1);
  else if (act === "edit-block") {
    if (!S.selected) return;
    const block = findTextBlock(S.selected);
    if (!block || block === S.selected) { toast("当前元素本身就是一个整段文字，可直接改内容"); return; }
    S.blockEl = block;
    S.blockKey = elementKey(block);
    S.panelTab = "text";
    select(block);
    ui("#tContent").disabled = false;
    ui("#tContent").focus();
    refs.tabs.querySelectorAll("button").forEach((b) => { b.dataset.on = b.dataset.tab === "text" ? "1" : "0"; });
    shadow.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== "text"; });
    toast("已切到整段模式：改完点底部「保存」或回车应用", 3200);
  }
  else if (act === "deselect") select(null);
  else if (act === "replace-image") replaceImage();
  else if (act === "insert-image") insertImage();
  else if (act === "paste-svg") pasteSvg();
  else if (act === "page-undo") { doUndo(); toast("已撤销一次页面改动（输入框内 Ctrl+Z 仍是文本撤销）", 2200); }
  else if (act === "page-redo") { doRedo(); toast("已重做一次页面改动", 1800); }
  else if (act === "draft-save") commitTextDraft();
  else if (act === "draft-cancel") cancelTextDraft();
  else if (act === "delete-el") deleteElement();
  else if (act === "dock-close") {
    try {
      const dock = shadow.querySelector(".ve-left");
      if (dock) { dock.setAttribute("data-closed", "1"); try { localStorage.setItem("ve:dockClosed", "1"); } catch { /* ignore */ } }
    } catch { /* ignore */ }
  }
  else if (act === "pick-mode") {
    S.pickMode = S.pickMode === "container" ? "deepest" : "container";
    const isC = S.pickMode === "container";
    btn.dataset.active = isC ? "1" : "0";
    btn.textContent = isC ? "容器优先" : "元素优先";
    toast(isC ? "已切换：容器优先（点选先选整块容器）" : "已切换：元素优先（点哪选哪；Shift+点击选父级容器）", 2200);
  }
  else if (act === "align-left" || act === "align-right" || act === "align-centerX" || act === "align-top" || act === "align-bottom" || act === "align-centerY") alignSelected(act);
  else if (act === "insert-text") insertText();
  else if (act === "insert-svg") insertSvg();
  else if (act === "ld-text") openCreate("text");
  else if (act === "ld-image") openCreate("image");
  else if (act === "ld-svg") openCreate("svg");
  else if (act === "ld-three") openCreate("three");
  else if (act === "ld-nav") openCreate("nav");
  else if (act === "ld-button") openCreate("button");
  else if (act === "ld-card") openCreate("card");
  else if (act === "ld-divider") openCreate("divider");
  else if (act === "ld-pagelink") openCreate("pagelink");
  else if (act === "create-save") createSave();
  else if (act === "create-cancel") { const m = ui("#createModal"); if (m) m.hidden = true; }
  else if (act === "text-mode") { S.textMode = !S.textMode; updateQuickState(); toast(S.textMode ? "文字选择模式：点哪抓哪段文字（再点一次关闭）" : "已关闭文字选择模式", 2000); }
  else if (act === "ov-close") { select(null); }
  else if (act === "del-hide") { ui("#delModal").hidden = true; hideSelectedElement(S.delEl); S.delEl = null; }
  else if (act === "del-real") { ui("#delModal").hidden = true; reallyDeleteElement(S.delEl); S.delEl = null; }
  else if (act === "del-cancel") { ui("#delModal").hidden = true; S.delEl = null; }
  else if (act === "ov-delete") overlayDelete();
  else if (act === "ov-replace-image") overlayReplaceImage();
  else if (act === "ask-ok") closeAsk(ui("#askInput").value);
  else if (act === "ask-cancel") closeAsk(null);
  else if (act === "lock") {
    lockAspect = !lockAspect;
    const lb = ui("#lockBtn");
    if (lb) { lb.dataset.on = lockAspect ? "1" : "0"; lb.textContent = lockAspect ? "🔒" : "🔗"; lb.title = lockAspect ? "已锁定等比（改宽高会联动）" : "等比锁定：点击开启"; }
    toast(lockAspect ? "已锁定等比：改宽/高会联动" : "已取消等比锁定", 1200);
  }
  else if (act === "hide-el") {
    const key = elementKey(S.selected);
    const entry = entryOf(key) || {};
    mutate(key, (en) => { en.hidden = !entry.hidden; });
    { const hb = ui("#hideBtn"); if (hb) hb.textContent = !entry.hidden ? "取消隐藏" : "隐藏这个元素"; }
  } else if (act === "pick-parent") { if (S.selected?.parentElement) select(S.selected.parentElement); }
  else if (act === "reset-el") resetElement(); else if (act === "ai-run") aiRun();
  else if (act === "ai-apply") aiApply();
  else if (act === "ai-discard") { S.aiOps = null; refs.aiResult.hidden = true; refs.aiActions.hidden = true; refs.aiHint.textContent = ""; }
  else if (act === "ai-comp") { openAiComp(); }
  else if (act === "ai-comp-close") { const m = ui("#aiCompModal"); if (m) m.hidden = true; }
  else if (act === "ai-comp-run") { aiCompRun(); }
  else if (act === "ai-comp-insert") { aiCompInsert(); }
  else if (act === "ai-comp-copy") { const r = ui("#aiCompResult"); if (r) { try { navigator.clipboard.writeText(r.textContent || ""); toast("已复制", 1200); } catch { toast("复制失败", 1200); } } }
  else if (act === "ai-close") refs.aiModal.hidden = true;
  else if (act === "ai-settings") { refs.setModal.hidden = false; }
  else if (act === "set-close") refs.setModal.hidden = true;
  else if (act === "set-save") {
    fetch(`${API}/ai-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ve-token": TOKEN },
      body: JSON.stringify({
        baseURL: ui("#setBase").value.trim(),
        model: ui("#setModel").value.trim(),
        apiKey: ui("#setKey").value.trim(),
      }),
    }).then((r) => r.json()).then((d) => {
      toast(d.ok ? "AI 配置已保存" : "保存失败");
      refs.setModal.hidden = true;
    }).catch(() => toast("保存失败"));
  }
});

refs.off.addEventListener("click", () => setMode());

document.addEventListener("click", onGuardClick, true);
document.addEventListener("pointerdown", onPointerDown, true);
document.addEventListener("pointermove", onPointerMove, true);
document.addEventListener("dblclick", onDblClick, true);
document.addEventListener("keydown", onKey, true);
// 编辑态里在「插入组件层」上按下/拖拽时，别让浏览器开始原生拖选文字：
// 否则会整页文字被选中成蓝色（看起来像全选），拖动结束还会留下蓝色残影
document.addEventListener("selectstart", (e) => {
  if (!S.on || S.preview) return;
  try {
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(refs.stage)) { e.preventDefault(); return; }
    if (path.includes(host)) {
      // 编辑器界面本身（工具栏/抽屉/面板）也不参与原生拖选；只有输入框、文本域、可编辑区允许
      const t = path[0];
      const tag = t && t.tagName ? t.tagName : "";
      const editable = tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable);
      if (!editable) e.preventDefault();
    }
  } catch { /* ignore */ }
}, true);
document.addEventListener("keyup", (e) => {
  if (e.key.toLowerCase() === "t" && S.textMode) { S.textMode = false; updateQuickState(); }
}, true);
window.addEventListener("scroll", () => { syncPinnedOverlays(); refresh(); }, true);
window.addEventListener("resize", refresh);
refs.stage.addEventListener("pointerdown", (e) => {
  const ins = e.target.closest?.(".ve-ins");
  if (ins && ins.__veOverlayId) { /* 由节点自身处理 */ }
});

/* 启动：读覆写层 → 注入样式表 + 应用文字/属性 */
/** 估算页面整体明暗（用于浮窗淡字自动反色） */
function pageIsDark() {
  try {
    const pick = (el) => {
      let n = el;
      for (let i = 0; i < 8 && n; i += 1) {
        const bg = getComputedStyle(n).backgroundColor || "";
        const m = bg.match(/rgba?\(([^)]+)\)/);
        if (m) {
          const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
          const alpha = parts.length > 3 ? parts[3] : 1;
          if (alpha > 0.35) return parts.slice(0, 3);
        }
        n = n.parentElement;
      }
      return null;
    };
    const c = pick(document.body) || pick(document.documentElement) || [255, 255, 255];
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return lum < 128;
  } catch { return false; }
}

function reportTheme() {
  const dark = pageIsDark();
  try { PARENT.postMessage({ __ve: "evt", type: "theme", dark }, "*"); } catch { /* ignore */ }
  try { if (refs && refs.panel) refs.panel.dataset.dark = dark ? "1" : "0"; } catch { /* ignore */ }
}

async function boot() {
  forceSelectImportant();
  try { setTimeout(() => { loadSteps().catch(() => {}); }, 500); } catch { /* ignore */ }
  // 面板标题上显示内核版本，点一下可刷新预览内核（DSH 开着的旧标签不会自动换内核）
  try {
    const vEl = ui("#veVer");
    if (vEl) {
      vEl.textContent = "v" + VE_VERSION;
      vEl.addEventListener("click", () => { try { location.reload(); } catch { /* ignore */ } });
      vEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    }
  } catch { /* ignore */ }
  // auto 模式组件要跟着邻近图层的透明度变化（定时同步，滚动时也会同步）
  try { setInterval(syncAutoOverlays, 250); } catch { /* ignore */ }
  try {
    if (!PURE_BOOT && !document.getElementById("__ve_docktab")) {
      try {
        const DOCK_KEY = "ve:dockClosed";
        // 样式：把手与抽屉同一缓动 / 同一时长（.26s cubic-bezier(.22,1,.36,1)）
        if (!document.getElementById("__ve_docktab_style")) {
          const st = document.createElement("style");
          st.id = "__ve_docktab_style";
          st.textContent = [
            "#__ve_docktab{position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:2147483000;width:24px;height:62px;",
            "border:1px solid #dbe1ea;border-left:none;border-radius:0 11px 11px 0;background:linear-gradient(180deg,#ffffff,#f6f8fb);color:#475569;",
            "font:600 17px/1 system-ui,sans-serif;cursor:pointer;box-shadow:6px 8px 20px rgba(15,23,42,.12);display:flex;align-items:center;justify-content:center;",
            "padding:0;user-select:none;-webkit-user-select:none;pointer-events:auto;",
            "transition:left .26s cubic-bezier(.22,1,.36,1),transform .26s cubic-bezier(.22,1,.36,1),box-shadow .2s ease,background .2s ease}",
            "#__ve_docktab:hover{background:linear-gradient(180deg,#ffffff,#eef2ff);box-shadow:6px 10px 26px rgba(15,23,42,.18)}",
            "#__ve_docktab .__ve_glyph{display:block;line-height:1;transition:transform .26s cubic-bezier(.22,1,.36,1)}",
            "#__ve_docktab[data-open=\"1\"] .__ve_glyph{transform:rotate(45deg)}",
            "#__ve_docktab:hover .__ve_glyph{transform:rotate(45deg) scale(1.06)}",
          ].join("");
          document.head.appendChild(st);
        }
        const tab = document.createElement("div");
        tab.id = "__ve_docktab";
        tab.innerHTML = '<span class="__ve_glyph">+</span>';
        tab.title = "展开组件栏（B / 点击）";
        tab.setAttribute("contenteditable", "false");
        tab.setAttribute("role", "button");
        tab.setAttribute("data-ve-editor-ui", "1");
        tab.setAttribute("data-open", "0");
        tab.setAttribute("tabindex", "-1");
        document.documentElement.appendChild(tab);

        const getDock = () => shadow && shadow.querySelector(".ve-left");
        const placeTab = () => {
          try {
            const dock = getDock();
            if (!dock) return;
            const closed = dock.getAttribute("data-closed") === "1";
            // 无缝贴合：打开时把手贴在抽屉右缘（-1px 覆盖描边），收起时回到屏幕左缘
            tab.style.left = closed ? "0px" : Math.round(14 + (dock.offsetWidth || 144) - 1) + "px";
            tab.setAttribute("data-open", closed ? "0" : "1");
            tab.title = closed ? "展开组件栏（B / 点击）" : "收起组件栏（B / 点击）";
          } catch { /* ignore */ }
        };
        const syncDock = () => {
          const dock = getDock();
          if (!dock) return;
          const closing = dock.getAttribute("data-closed") !== "1";
          dock.setAttribute("data-closed", closing ? "1" : "0");
          try { localStorage.setItem(DOCK_KEY, closing ? "1" : "0"); } catch { /* ignore */ }
          placeTab();
        };
        window.__veDockTabSync = placeTab;
        try {
          const dock0 = getDock();
          const saved = localStorage.getItem(DOCK_KEY);
          if (dock0) dock0.setAttribute("data-closed", saved === null ? "1" : (saved === "1" ? "1" : "0"));
        } catch { /* ignore */ }
        placeTab();
        setTimeout(placeTab, 60);
        setTimeout(placeTab, 320);
        tab.addEventListener("click", () => { syncDock(); });
        window.addEventListener("resize", placeTab);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  try { setTimeout(reportTheme, 300); setInterval(reportTheme, 4000); } catch { /* ignore */ }
  try { setTimeout(() => postToParent("autosave", { on: S.autoSave }), 400); } catch { /* ignore */ }
  // 新建/插入元素的参数统一放进右侧面板「组件」页：把旧弹层里的字段搬进面板
  try {
    const ovBody = shadow.querySelector("#ovPanel .ve-mb");
    const paneOv = shadow.querySelector('[data-pane="ov"]');
    if (ovBody && paneOv) {
      while (ovBody.firstChild) paneOv.appendChild(ovBody.firstChild);
      const old = shadow.getElementById("ovPanel");
      if (old) old.remove();
    }
  } catch { /* ignore */ }
  // 站点常把 ::selection 设成浅色（如 rgba(255,255,255,.2)），在白底面板上等于不可见；
  // 这里在页面 head 覆盖一条明确的选区配色，保证"选中了但看不到高亮"不再发生。
  try {
    if (!document.getElementById("__ve_selection")) {
      const st = document.createElement("style");
      st.id = "__ve_selection";
      st.textContent = "::selection{background:#2f5cff!important;color:#fff!important}";
      document.head.appendChild(st);
    }
  } catch { /* ignore */ }
  // 入口跳转（meta refresh / location.replace）会丢参数：记住并在新页面恢复
  try {
    if (/[?&]ve=1/.test(location.search)) sessionStorage.setItem("__ve_params", location.search);
    else if (window.parent !== window) {
      const saved = sessionStorage.getItem("__ve_params");
      if (saved && /[?&]ve=1/.test(saved) && !/[?&]ve=/.test(location.search)) {
        location.replace(location.pathname + saved + location.hash);
        return;
      }
    }
  } catch { /* ignore */ }
  try {
    const probeEl = shadow.querySelector(".ve-row label") || shadow.getElementById("panel");
    console.info(
      "[ve][diag2] version=" + VE_VERSION +
      " | userSelect(panel)=" + (probeEl ? getComputedStyle(probeEl).userSelect : "?") +
      " | userSelect(body)=" + getComputedStyle(document.body).userSelect +
      " | host=" + host.style.getPropertyValue("user-select") +
      " | embedded=" + (S.embedded ? "1" : "0") +
      " | on=" + (S.on ? "1" : "0") +
      " | preview=" + (S.preview ? "1" : "0") +
      " | search=" + (location.search || "-") +
      " | ta.disabled=" + (shadow.getElementById("tContent") ? shadow.getElementById("tContent").disabled : "?") +
      " | ta.readOnly=" + (shadow.getElementById("tContent") ? shadow.getElementById("tContent").readOnly : "?") +
      " | ta.userSelect=" + (shadow.getElementById("tContent") ? getComputedStyle(shadow.getElementById("tContent")).userSelect : "?") +
      " | ta.pointerEvents=" + (shadow.getElementById("tContent") ? getComputedStyle(shadow.getElementById("tContent")).pointerEvents : "?") +
      " | iframe=" + (window.parent !== window ? "1" : "0") +
      " | href=" + location.href +
      " | selStyle=" + (document.getElementById("__ve_selection") ? "1" : "0")
    );
  } catch { /* ignore */ }
  try {
    const res = await fetch(`${API}/overrides`, { cache: "no-store" });
    if (res.ok) {
      try {
        if (res.headers.get("x-ve-source-stale") === "1") {
          toast("源文件已被外部修改：旧编辑记录已备份并停用，正在读取最新源码", 5000);
        }
      } catch { /* ignore */ }
      const raw = await res.json();
      S.overrides = stripEditorUiKeys(normalizeKeyMap(raw));
      // 若发生过合并，把归一化结果写回服务端，避免下次再出现两种 key
      try {
        if (raw && JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(Object.keys(S.overrides).sort())) {
          // 有 key 被归一化/清理：写回，避免下次再出现
          fetch(`${API}/replace-overrides`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-ve-token": TOKEN },
            body: JSON.stringify({ overrides: S.overrides, label: "normalize-keys" }),
          }).catch(() => {});
        }
      } catch { /* ignore */ }
    }
  } catch { S.overrides = {}; }
  refreshStylesheet();
  // 注意：插入组件（__overlay）只能由下面的 applyOverlays 渲染一次；
  // 这里再渲染一遍会出现两个重叠的组件 DOM，拖动其中一个时另一个留在原地 → 看起来像「残影」。
  for (const [key, entry] of Object.entries(S.overrides)) {
    if (!entry?.__overlay && keyToSelector(key)) applyDom(key, entry);
  }
  applyOverlays(S.overrides);
  syncPinnedOverlays();
  // 自动保存 / 草稿缓存：读开关偏好，并把上次没保存的改动恢复回待保存层
  S.autoSave = autoSaveEnabled();
  bindAutoSaveLifecycle();
  try { restoreDraft(); } catch { /* 草稿坏了就当没有 */ }
  try { S.pending = stripEditorUiKeys(normalizeKeyMap(S.pending)); } catch { /* ignore */ }
  updateQuickState();
  const ai = await fetch(`${API}/config`).then((r) => r.json()).catch(() => null);
  if (ai?.ai) {
    ui("#setModel").value = ai.ai.model || "";
    if (!ai.ai.configured) ui("#aiHint").textContent = "还没配置 AI 接口。";
  }
  // 独立启动器（顶层窗口、没有宿主送页面列表）：直接问本地 /ve/plugin/pages，
  // 让编辑器里的悬浮导航胶囊在纯本地模式下也能列出页面。
  try {
    if (ai && ai.root && window.parent === window && !PAGE_NAV_OFF) {
      const pr = await fetch("/ve/plugin/pages?dir=" + encodeURIComponent(String(ai.root)), { cache: "no-store" });
      const pd = pr.ok ? await pr.json().catch(() => null) : null;
      if (pd && Array.isArray(pd.pages) && pd.pages.length) {
        S.pages = pd.pages.map((p) => ({ path: p.path, title: p.title || p.name || p.path }));
        try { S.currentPage = decodeURIComponent(location.pathname) || "/"; } catch { S.currentPage = "/"; }
        updatePageNavUI();
      }
    }
  } catch { /* ignore */ }
  // 刷新/切页后内核是重新注入的：从 sessionStorage 恢复页面列表（同一个预览源），
  // 保证顶部导航胶囊不会因为宿主还没重发消息就消失。
  try {
    if (!Array.isArray(S.pages) && !PAGE_NAV_OFF) {
      const raw = sessionStorage.getItem("ve:pages");
      const cached = raw ? JSON.parse(raw) : null;
      if (cached && Array.isArray(cached.pages) && cached.pages.length) {
        S.pages = cached.pages;
        try { S.currentPage = decodeURIComponent(location.pathname) || "/"; } catch { S.currentPage = "/"; }
        updatePageNavUI();
        // ?ve=1 会让 setMode() 早于 boot() 执行（那时还没有页面列表），所以恢复后补一次显示
        if (S.on) applyPageNavDefault();
      }
    }
  } catch { /* ignore */ }
  try { bindPageNavUI(); } catch { /* ignore */ }
  console.info("[ve] 视觉编辑器已注入：点右下角「✎ 编辑」开始");
}

boot().then(() => {
  // 被宿主（DSH 插件）用 iframe 嵌入时：自动进编辑态、隐藏自带工具栏，并报 ready
  const q = new URLSearchParams(location.search);
  // 入口跳转可能丢 query；只要有父窗口（被宿主 iframe 嵌入）就按嵌入模式处理
  S.embedded = q.get("ve_embed") === "1" || q.get("ve") === "1" || Boolean(PARENT);
  try { if (q.get("ve_tb") === "top") refs.ui.classList.add("tb-top"); } catch { /* ignore */ }
  // 从「⛶ 新窗口」打开：独立窗口，直接进编辑态（工具栏/组件坞都在）
  if (!S.embedded && q.get("ve_win") === "1" && !S.on) setMode();
  if (S.embedded) {
    refs.ui.classList.add("ve-embed");
    if (!S.on) setMode();
    setTimeout(() => postToParent("ready", { href: location.href, embedded: true }), 60);
  } else if (PARENT) {
    postToParent("ready", { href: location.href, embedded: false });
  }
  // 纯预览窗口（URL 带 ve_pure=1）：刷新后仍然是纯预览，没有任何编辑器界面，适合录制开屏动画
  if (q.get("ve_pure") === "1") {
    try {
      S.preview = true;
      refs.ui.classList.add("ve-pure-hard");
      applyPreview();
    } catch { /* ignore */ }
  }
});

// 从「新窗口」打开时提示一下怎么全屏
try {
  if (new URLSearchParams(location.search).get("ve_win") === "1") {
    setTimeout(() => {
      try {
        toast("独立窗口：改动实时生效；按 F11 全屏，想只看画面先点「预览」", 6000);
      } catch { /* ignore */ }
    }, 1200);
  }
} catch { /* ignore */ }

// 便于自动化测试 / 截图 / 二次开发
const query = new URLSearchParams(location.search);
if (query.get("ve") === "1") {
  if (!S.on) setMode();
  const target = query.get("sel");
  if (target) {
    setTimeout(() => {
      const el = document.querySelector(target);
      if (el) select(el);
    }, 260);
  }
}
window.__VE__ = { S, save, buildOps, select, mutate, setMode, elementKey, keyToSelector, applyOpsLocal, collectInRect, setAutoSave, isDirty, writeDraft, restoreDraft };
window.__VE_DEBUG__ = { styleToCss, effectiveEntries, refreshStylesheet, scheduleStyles };
