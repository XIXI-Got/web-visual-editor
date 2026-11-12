import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore, sanitizeOps } from "../api.mjs";

function tmpSite(contentJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ve-test-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "content.json"),
    JSON.stringify(contentJson, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(root, "index.html"), "<html><body><h1>hi</h1></body></html>", "utf8");
  return root;
}

test("store：第一次保存生成覆写文件，第二次保存生成备份", () => {
  const root = tmpSite({ person: { name: "张三" } });
  const store = createStore({ root, contentJson: "src/content.json" });
  const r1 = store.applyOps([{ type: "style", key: "sel:h1", props: { "font-size": "40px" } }]);
  assert.equal(r1.ok, true);
  assert.equal(r1.backupId, null, "第一次没有旧文件可备份");
  assert.deepEqual(store.readOverrides()["sel:h1"], { style: { "font-size": "40px" } });

  const r2 = store.applyOps([{ type: "style", key: "sel:h1", props: { "font-size": "44px" } }]);
  assert.ok(r2.backupId, "第二次应生成备份");
  const backups = store.listBackups();
  assert.equal(backups.length, 1);
  assert.ok(fs.existsSync(path.join(store.backupsDir, r2.backupId, ".ve-data", "overrides.json")));
});

test("store：改文字时唯一匹配 → 回写 content.json", () => {
  const root = tmpSite({ person: { name: "张三", bio: "十年设计经验" } });
  const store = createStore({ root, contentJson: "src/content.json" });
  const res = store.applyOps([{ type: "text", key: "sel:h1", value: "李四", orig: "张三" }]);
  assert.equal(res.wroteContent, true);
  const data = JSON.parse(fs.readFileSync(path.join(root, "src", "content.json"), "utf8"));
  assert.equal(data.person.name, "李四");
  assert.equal(store.readOverrides()["sel:h1"], undefined, "回写内容文件后不再进覆写层");
  assert.ok(res.backupId, "回写前也要备份");
});

test("store：文字不唯一 → 落到覆写层，不动 content.json", () => {
  const root = tmpSite({ a: "重复", b: "重复" });
  const store = createStore({ root, contentJson: "src/content.json" });
  const res = store.applyOps([{ type: "text", key: "sel:p", value: "新值", orig: "重复" }]);
  assert.equal(res.wroteContent, false);
  const data = JSON.parse(fs.readFileSync(path.join(root, "src", "content.json"), "utf8"));
  assert.equal(data.a, "重复");
  assert.equal(store.readOverrides()["sel:p"].text, "新值");
});

test("store：生成生产用 CSS，尺寸/隐藏都在里面", () => {
  const root = tmpSite({});
  const store = createStore({ root, contentJson: "", cssOut: "src/editor-overrides.css" });
  store.applyOps([
    { type: "style", key: "id:src/a.tsx:3:5", props: { "font-weight": "700" } },
    { type: "box", key: "id:src/a.tsx:3:5", box: { x: 8, y: 16, width: 320, height: 200 } },
    { type: "hide", key: "sel:.foot", hidden: true },
  ]);
  const css = fs.readFileSync(path.join(root, "src", "editor-overrides.css"), "utf8");
  assert.match(css, /font-weight:700!important/);
  assert.match(css, /width:320px!important/);
  assert.match(css, /height:200px!important/);
  assert.match(css, /display:none!important/);
});

test("store：overlay 插入节点可持久化", () => {
  const root = tmpSite({});
  const store = createStore({ root, contentJson: "" });
  store.applyOps([{ type: "overlay", key: "overlay:abc123", node: { id: "abc123", tag: "img", attrs: { src: "/x.png" }, x: 10, y: 20, width: 300, height: 200 } }]);
  const ov = store.readOverrides()["overlay:abc123"].__overlay;
  assert.equal(ov.tag, "img");
  assert.equal(ov.attrs.src, "/x.png");
  assert.equal(ov.width, 300);
});

test("store：上传落盘并可通过 URL 取回", () => {
  const root = tmpSite({});
  const store = createStore({ root, contentJson: "", publicDir: "public" });
  const buf = Buffer.from("PNGDATA");
  const up = store.saveUpload("我的图.png", buf);
  assert.ok(up.ok);
  assert.match(up.url, /^public\/.+\.png$/);
  assert.ok(fs.existsSync(path.join(root, up.url)));
  // 非 publicDir 模式走 /__ve/files/ 前缀
  const store2 = createStore({ root, dataDir: ".ve-data2" });
  const up2 = store2.saveUpload("a.jpg", buf);
  assert.match(up2.url, /^\/__ve\/files\//);
  const file = store2.readUpload(path.basename(up2.url));
  assert.ok(file && fs.existsSync(file));
});

test("store：恢复备份", () => {
  const root = tmpSite({});
  const store = createStore({ root, contentJson: "" });
  store.applyOps([{ type: "style", key: "sel:h1", props: { color: "red" } }]);
  const second = store.applyOps([{ type: "style", key: "sel:h1", props: { color: "blue" } }]);
  assert.equal(store.readOverrides()["sel:h1"].style.color, "blue");
  store.restoreBackup(second.backupId);
  assert.equal(store.readOverrides()["sel:h1"].style.color, "red");
});

test("store：token 存在且每次启动不同", () => {
  const root = tmpSite({});
  const a = createStore({ root });
  const b = createStore({ root });
  assert.equal(a.config().token.length, 24);
  assert.notEqual(a.config().token, b.config().token);
  assert.doesNotMatch(fs.readFileSync(path.join(root, ".ve-data", "config.json"), "utf8"), new RegExp(a.config().token));
});

test("store：AI 配置读写，未配置时给出明确提示", async () => {
  const root = tmpSite({});
  const store = createStore({ root });
  assert.equal(store.readAiConfig().apiKey, "");
  const res = await store.askAI({ instruction: "把标题改大" });
  assert.equal(res.ok, false);
  assert.equal(res.needsConfig, true);
  store.writeAiConfig({ apiKey: "sk-test", model: "m1", baseURL: "http://127.0.0.1:9/v1" });
  const ai = store.readAiConfig();
  assert.equal(ai.apiKey, "sk-test");
  assert.equal(ai.model, "m1");
});

test("sanitizeOps：拦截脚本与非法属性", () => {
  const ops = sanitizeOps([
    { type: "style", key: "sel:h1", props: { "font-size": "40px", "background-image": "url(javascript:alert(1))", behavior: "x", color: "red;}" } },
    { type: "style", key: "javascript:alert(1)", props: { color: "red" } },
    { type: "text", key: "sel:h1", value: "ok" },
    { type: "attrs", key: "sel:img", props: { src: "/a.png", onerror: "alert(1)" } },
    { type: "attrs", key: "sel:img", props: { src: "javascript:alert(1)" } },
    { type: "hide", key: "sel:footer", hidden: true },
    { type: "overlay", key: "overlay:x" },
    null,
    "junk",
  ]);
  assert.equal(ops.length, 4, JSON.stringify(ops));
  assert.deepEqual(ops[0].props, { "font-size": "40px" }, "只有合法样式留下");
  assert.equal(ops[1].type, "text");
  assert.deepEqual(ops[2].props, { src: "/a.png" }, "事件属性与 javascript: 被拦");
  assert.equal(ops[3].type, "hide");
});

test("sanitizeOps：数量与数值收敛", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ type: "text", key: "sel:p", value: "v" + i }));
  assert.equal(sanitizeOps(many).length, 24);
  const box = sanitizeOps([{ type: "box", key: "sel:p", box: { x: 1.23456, y: "abc", width: 300, height: 200 } }]);
  assert.deepEqual(box[0].box, { x: 1.23, y: 0, width: 300, height: 200 });
});
