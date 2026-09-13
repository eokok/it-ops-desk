/* 混合检索评测校准脚本（Node 环境）
   用途：在无浏览器环境下跑评测集，输出 Top1/Top3 命中率与自助解决率，
        用于校准 CONF 置信度阈值。运行：node calibrate.js
   注意：索引现为可重建结构（DOCS 惰性构建 + 含 KB 文章），
        必须调用 ensureInit() 完成首次索引构建，否则评测得分为 0。 */
const path = require("path");

global.window = {};
const mem = {};
global.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };

require(path.join(__dirname, "bot-data.js"));
require(path.join(__dirname, "bot-flows.js"));
require(path.join(__dirname, "bot.js"));

const bot = global.window.OpsBot;
bot.ensureInit();                 // 关键：构建索引（FAQ + 主系统 KB）
const res = bot.evaluate();

const pct = (v) => (v * 100).toFixed(1) + "%";
console.log("样本数        :", res.total);
console.log("Top1 命中率   :", pct(res.top1Hit));
console.log("Top3 命中率   :", pct(res.top3Hit));
console.log("自助解决率    :", pct(res.selfRate));
console.log("平均融合得分  :", res.avgScore.toFixed(3));
console.log("索引规模      :", bot.documents.length, "（FAQ", bot.FAQS.length, "+ KB", bot.kbSnapshot.length, "）");
console.log("阈值 CONF     :", JSON.stringify(bot.CONF));

const miss1 = res.rows.filter((r) => !r.hit1);
console.log("\n--- Top1 未命中 (" + miss1.length + ") ---");
miss1.forEach((r) => console.log('  "' + r.q + '"  期望 ' + r.expect + "  实际 " + r.got + "  score=" + r.score + "  level=" + r.level));

const lowConf = res.rows.filter((r) => r.hit1 && r.level !== "high");
console.log("\n--- 命中但置信度未达 high (" + lowConf.length + ") ---");
lowConf.slice(0, 30).forEach((r) => console.log('  "' + r.q + '"  ' + r.got + "  score=" + r.score + "  level=" + r.level));

/* 护栏评测（服务原则 1/3/4/5） */
const g = bot.evaluateGuards();
console.log("\n=== 护栏评测（服务原则）===");
console.log("样本数        :", g.total);
console.log("总通过率      :", pct(g.pass));
console.log("  域外识别    :", pct(g.boundary));
console.log("  风险警示    :", pct(g.risk));
console.log("  值班电话    :", pct(g.hotline));
console.log("  拒答        :", pct(g.refuse));
console.log("  澄清        :", pct(g.clarify));
const gbad = g.rows.filter((r) => !r.ok);
if (gbad.length) {
  console.log("\n--- 护栏未通过 (" + gbad.length + ") ---");
  gbad.forEach((r) => console.log("  [" + r.type + '] "' + r.q + '"  plugin=' + r.plugin + " guard=" + r.guard + " cards=" + r.cards));
}
