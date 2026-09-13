/* 检索调试脚本：输出指定查询的 Top-N 命中与三层分数明细
   用法：node debug.js "查询1" "查询2" ... */
const path = require("path");
global.window = {};
const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };

require(path.join(__dirname, "bot-data.js"));
require(path.join(__dirname, "bot-flows.js"));
require(path.join(__dirname, "bot.js"));

const bot = global.window.OpsBot;
const qs = process.argv.slice(2);
if (!qs.length) { console.log("请传入查询语句"); process.exit(0); }

qs.forEach((q) => {
  const r = bot.hybridSearch(q, 5);
  console.log("\n===== 查询: " + q + " =====");
  console.log("tokens  : " + r.tokens.join(" "));
  console.log("扩展词  : " + (r.expansions.extra || []).join(" "));
  console.log("level=" + r.level + "  margin=" + r.margin + "  polarity=" + r.polarity + "  topCov=" + r.coverage);
  console.log("keys    : " + (r.keys || []).join(" "));
  r.hits.forEach((h) => {
    console.log("  " + h.id + "  score=" + h.score.toFixed(3) + "  cov=" + (h.cov == null ? "-" : h.cov.toFixed(2)) +
      "  [bm25=" + h.detail.bm25 + " cos=" + h.detail.cosine + " con=" + h.detail.concept + " ph=" + h.detail.phrase + "]" +
      "  pol=" + h.polarity + " pen=" + h.penalty + "  " + h.faq.q);
  });
});
