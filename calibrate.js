/* 混合检索评测校准脚本（Node 环境）
   用途：在无浏览器环境下跑评测集，输出 Top1/Top3 命中率与自助解决率，
        用于校准 CONF 置信度阈值。运行：node calibrate.js */
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
const res = bot.evaluate();

const pct = (v) => (v * 100).toFixed(1) + "%";
console.log("样本数        :", res.total);
console.log("Top1 命中率   :", pct(res.top1Hit));
console.log("Top3 命中率   :", pct(res.top3Hit));
console.log("自助解决率    :", pct(res.selfRate));
console.log("平均融合得分  :", res.avgScore.toFixed(3));
console.log("阈值 CONF     :", JSON.stringify(bot.CONF));

const miss1 = res.rows.filter((r) => !r.hit1);
console.log("\n--- Top1 未命中 (" + miss1.length + ") ---");
miss1.forEach((r) => console.log('  "' + r.q + '"  期望 ' + r.expect + "  实际 " + r.got + "  score=" + r.score + "  level=" + r.level));

const lowConf = res.rows.filter((r) => r.hit1 && r.level !== "high");
console.log("\n--- 命中但置信度未达 high (" + lowConf.length + ") ---");
lowConf.slice(0, 30).forEach((r) => console.log('  "' + r.q + '"  ' + r.got + "  score=" + r.score + "  level=" + r.level));
