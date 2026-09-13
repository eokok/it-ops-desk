/* 护栏 + 知识库学习闭环 回归脚本
   运行：NODE_PATH=<workspace>/node_modules node calibrate-guards.js
   覆盖：服务原则 1/3/4/5 的护栏判定 + KB 与 bot 的双向联动 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const DIR = __dirname;
let pass = 0, fail = 0;
const P = (s) => console.log(s);

const STUB = "window.Chart=function(){return{destroy:function(){}}};" +
  "window.XLSX={utils:{json_to_sheet:function(){return{}},book_new:function(){return{}},book_append_sheet:function(){}},writeFile:function(){}};";

let html = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const need = ["app.js", "bot-data.js", "bot-flows.js", "bot.js", "bot-ui.js"];
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  if (need.indexOf(src) < 0) return "<script>" + STUB + "</script>";
  const code = fs.readFileSync(path.join(DIR, src), "utf8").replace(/<\/script>/gi, "<\\/script>");
  return "<script>\n" + code + "\n</script>";
});
const vc = new VirtualConsole();
const errs = [];
vc.on("jsdomError", (e) => errs.push(String(e && e.message || e)));
vc.on("error", (...a) => errs.push("console.error: " + a.join(" ")));

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://local.test/", virtualConsole: vc });
const { window } = dom;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = window.document;

function ok(cond, name, extra) {
  if (cond) { pass++; P("  ✓ " + name); }
  else { fail++; P("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

(async function run() {
  await new Promise((r) => {
    if (doc.readyState === "complete") return r();
    window.addEventListener("load", r);
    setTimeout(r, 900);
  });
  await wait(80);
  const B = window.OpsBot;
  const $ = (s) => doc.querySelector(s);

  P("\n=== 1. 值班电话口径（原则 4）===");
  ok(B.DUTY_PHONE === "400-1111-2222", "值班电话常量为 400-1111-2222", B.DUTY_PHONE);
  ok(/400-1111-2222/.test(JSON.stringify(B.FAQS)), "FAQ 语料中已写入值班电话");
  const faq45 = B.FAQS.find((f) => f.id === "FAQ45");
  const faq46 = B.FAQS.find((f) => f.id === "FAQ46");
  const faq51 = B.FAQS.find((f) => f.id === "FAQ51");
  ok(/400-1111-2222/.test(faq45.steps.join(" ")), "FAQ45 钓鱼邮件告知值班电话");
  ok(/400-1111-2222/.test(faq46.steps.join(" ")), "FAQ46 勒索病毒告知值班电话");
  ok(/400-1111-2222/.test(faq51.steps.join(" ")), "FAQ51 紧急上报告知值班电话");
  ok(B.FAQS.length === 53, "FAQ 语料 53 条（新增报废设备）", B.FAQS.length);

  P("\n=== 2. 护栏评测集（原则 1/3/4/5）===");
  ok(B.GUARD_SET.length >= 20, "护栏评测样本 ≥20 条", B.GUARD_SET.length);
  const g = B.evaluateGuards();
  P("     通过率 " + Math.round(g.pass * 100) + "%  " +
    "（边界 " + Math.round(g.boundary * 100) + "% / 风险 " + Math.round(g.risk * 100) + "% / " +
    "电话 " + Math.round(g.hotline * 100) + "% / 拒答 " + Math.round(g.refuse * 100) + "% / " +
    "澄清 " + Math.round(g.clarify * 100) + "%）");
  const bad = g.rows.filter((r) => !r.ok);
  if (bad.length) bad.forEach((r) => P("     ✗ [" + r.type + "] " + r.q + "  → plugin=" + r.plugin + " guard=" + r.guard + " cards=" + r.cards));
  ok(g.boundary === 1, "域外问题 100% 识别并转交", Math.round(g.boundary * 100) + "%");
  ok(g.risk === 1, "高危操作 100% 前置风险警示", Math.round(g.risk * 100) + "%");
  ok(g.hotline === 1, "紧急场景 100% 出现值班电话", Math.round(g.hotline * 100) + "%");
  ok(g.refuse === 1, "无依据问题 100% 拒答", Math.round(g.refuse * 100) + "%");
  ok(g.clarify === 1, "过泛描述 100% 先澄清", Math.round(g.clarify * 100) + "%");
  ok(g.pass === 1, "护栏总通过率 100%", Math.round(g.pass * 100) + "%");

  P("\n=== 3. 检索评测未被护栏回归破坏 ===");
  const ev = B.evaluate();
  const evMiss = ev.rows.filter((r) => !r.hit1);
  if (evMiss.length) evMiss.forEach((r) => P("     ✗ 未命中: " + r.q + "  期望 " + r.expect + "  实际 " + r.got + "  score=" + r.score + "  level=" + r.level));
  ok(ev.top1Hit === 1, "Top-1 100%", Math.round(ev.top1Hit * 100) + "%");
  ok(ev.selfRate >= 0.95, "自助解决率 ≥95%", Math.round(ev.selfRate * 100) + "%");

  P("\n=== 4. KB 接入索引（学习闭环 · 读侧）===");
  const kbDocs = B.documents.filter((d) => d.src === "kb");
  const st = B.mainState();
  ok(kbDocs.length === st.kb.length, "KB 文章全部进入索引", kbDocs.length + " / " + st.kb.length);
  ok(B.documents.length === B.FAQS.length + st.kb.length, "索引规模 = FAQ + KB", B.documents.length);

  P("\n=== 5. 用 KB 文章提问 → bot 命中并作答 ===");
  const kbTitle = st.kb[0].title;
  const r1 = B.ask(kbTitle);
  ok(!!r1.result, "KB 标题提问有回复");
  const c1 = (r1.result.cards || [])[0] || {};
  ok(c1.type === "kbAnswer", "命中 KB 卡片", c1.type);
  ok(r1.result.level === "self", "KB 命中晋级为自助解决", r1.result.level);
  ok(/IT 知识库/.test(r1.result.text), "回复标明知识库来源");
  ok((r1.result.sources || []).some((s) => s.type === "KB"), "引用来源含 KB");

  P("\n=== 6. 新增 KB 文章 → 学习后即可命中（学习闭环 · 写侧）===");
  const NEW_TITLE = "会议室无线投屏连不上的处理办法";
  const NEW_CONTENT = "1. 确认投屏器电源与 HDMI 输入源；\n2. 检查笔记本是否切换到扩展显示模式；\n3. 投屏器指示灯红色时更换 HDMI 线；\n4. 仍失败则重启投屏器并重新配对。";
  // 先验证「学习前答不出」——用只存在于新文章里的词提问
  const NEW_Q = "投屏器指示灯红色要怎么处理";
  const rBefore = B.ask(NEW_Q);
  ok(((rBefore.result.cards || [])[0] || {}).type !== "kbAnswer", "学习前无法命中该知识", ((rBefore.result.cards || [])[0] || {}).type);
  const t1 = B.teachToKB({ title: NEW_TITLE, content: NEW_CONTENT, tags: ["投屏", "会议室", "HDMI"], category: "打印与会议", from: "test" });
  ok(t1.ok && t1.action === "created", "新增 KB 文章成功", JSON.stringify(t1));
  const kbAfter = B.mainState().kb.length;
  ok(kbAfter === kbDocs.length + 1, "主系统 KB 条数 +1", kbAfter);
  ok(B.documents.length === B.FAQS.length + kbAfter, "索引已自动重建包含新文章", B.documents.length);
  const r2 = B.ask(NEW_Q);
  const c2 = (r2.result.cards || [])[0] || {};
  ok(c2.type === "kbAnswer" && c2.kbId === t1.id, "学习后即可检索命中新知识", c2.type + "/" + c2.kbId);
  ok(r2.result.level === "self", "新知识命中晋升自助层级", r2.result.level);
  ok(/IT 知识库/.test(r2.result.text), "回复标明这是知识库内容");

  P("\n=== 7. 同标题重复沉淀转为更新（幂等）===");
  const t2 = B.teachToKB({ title: NEW_TITLE, content: NEW_CONTENT + "\n5. 记录故障时间并报修。", tags: ["投屏"], from: "test" });
  ok(t2.ok && t2.action === "updated", "重复标题走更新而非新建", t2.action);
  ok(B.mainState().kb.length === kbAfter, "KB 条数未增加", B.mainState().kb.length);

  P("\n=== 8. 会话沉淀：已解决 → 自动写回 KB ===");
  const before = B.mainState().kb.length;
  window.OpsDesk.switchPage("assistant");
  const send = (t) => { const i = $("#botInput"); i.value = t; i.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); };
  B.ask("忘记域账号密码怎么重置");
  const sess = B.cur();
  const learned = B.autoLearnOnSolved();
  ok(learned.ok, "会话沉淀成功", JSON.stringify(learned));
  ok(B.mainState().kb.length === before + 1, "知识库新增一条沉淀文章", B.mainState().kb.length);
  ok(!!sess.resolution.knowledgeId, "会话记录了沉淀文章 ID", sess.resolution.knowledgeId);

  P("\n=== 9. 知识规模状态 ===");
  const ls = B.learnStatus();
  ok(ls.kbTotal === B.mainState().kb.length, "状态卡 KB 数与主系统一致", ls.kbTotal);
  ok(ls.faqTotal === 53, "状态卡 FAQ 数正确", ls.faqTotal);
  ok(ls.indexedDocs === B.FAQS.length + ls.kbTotal, "可检索总量正确", ls.indexedDocs);
  ok(ls.pendingCount === 0, "学习后无待同步文章", ls.pendingCount);

  P("\n=== 10. 主系统侧联动（notifyBotLearn 桥）===");
  const kb0 = B.mainState().kb.length;
  B.mainState().kb.push({ id: "KB9999", title: "测试用的新知识条目", category: "应用", tags: ["测试"], ciId: null, content: "1. 第一步；\n2. 第二步。", views: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const sync = B.syncKnowledge();
  ok(sync.added >= 1, "手动同步可发现未索引文章", sync.added);
  const r3 = B.ask("测试用的新知识条目");
  ok(((r3.result.cards || [])[0] || {}).type === "kbAnswer", "同步后立即可检索到", ((r3.result.cards || [])[0] || {}).type);
  // 清理测试数据
  B.mainState().kb = B.mainState().kb.filter((k) => k.id !== "KB9999");
  B.mainState().kb = B.mainState().kb.filter((k) => !/测试用的新知识条目/.test(k.title));
  B.mainState().kb = B.mainState().kb.filter((k) => k.title !== NEW_TITLE);
  B.mainState().kb = B.mainState().kb.filter((k) => !/忘记域账号密码/.test(k.title));
  window.OpsDesk.save();
  ok(B.mainState().kb.length <= kb0, "测试数据已清理", B.mainState().kb.length);

  P("\n=== 11. 意图与插件 ===");
  ok(B.PLUGINS.length === 6, "插件 6 个（新增知识库学习）", B.PLUGINS.length);
  ok(B.detectIntent("同步知识库") === "knowledge", "知识库意图可识别");
  ok(B.detectIntent("把这次的解决方案沉淀一下") === "knowledge", "沉淀意图可识别");
  ok(B.detectIntent("忘记密码了") === "search", "普通问题不受影响");
  const rk = B.ask("同步知识");
  ok(rk.plugin.id === "kb", "知识库插件承接该意图", rk.plugin.id);

  P("\n=== 12. 异常捕获 ===");
  ok(errs.length === 0, "无 JS 运行时错误", errs.slice(0, 3).join(" | "));

  P("\n────────────────────────────────");
  P("断言 " + (pass + fail) + " 项：" + pass + " 通过 / " + fail + " 失败");
  if (fail) process.exitCode = 1;
})();
