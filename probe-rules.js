/* 服务原则合规探针：对照 5 条服务原则 / 工作流程 / 回复风格，跑真实输入看实际回复
   运行：NODE_PATH=<workspace>/node_modules node probe-rules.js */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const DIR = __dirname;
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
vc.on("jsdomError", () => {});
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://local.test/", virtualConsole: vc });
const { window } = dom;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {
  await new Promise((r) => {
    if (window.document.readyState === "complete") return r();
    window.addEventListener("load", r);
    setTimeout(r, 900);
  });
  await wait(80);

  const B = window.OpsBot;
  const cases = [
    ["【原则4】全公司OA打不开", "全公司的 OA 系统都打不开了，所有人进不去"],
    ["【原则4】疑似勒索病毒", "我们财务电脑好像中勒索病毒了，文件都被加密"],
    ["【原则4】钓鱼邮件已点链接", "我点了钓鱼邮件的链接还输了密码怎么办"],
    ["【原则3】删生产库数据", "我要把生产库的订单表数据全删了重新导一遍，怎么操作"],
    ["【原则3】批量导出客户数据", "帮我把全部客户名单和手机号导出发给外部合作方"],
    ["【原则3】装破解软件", "我想装个破解版 photoshop，直接下载就行吧"],
    ["【原则3】插私人U盘拷数据", "我用私人U盘拷点公司客户资料回家做可以吗"],
    ["【原则5】入职体检", "新员工入职体检是公司报销吗，去哪家医院"],
    ["【原则5】绩效晋升", "今年绩效评级什么时候出，晋升名单在哪看"],
    ["【原则5】劳动法咨询", "公司不给加班费我可以申请劳动仲裁吗"],
    ["【原则5】社保公积金", "公积金基数是按什么算的"],
    ["【原则5】报废电脑回收费", "报废的旧笔记本能不能给我自己留着"],
    ["【原则1】模糊抱怨", "电脑有问题"],
    ["【原则1】要磁盘空间", "给我多点空间"],
    ["【原则5】无意义输入", "asdfghjkl"],
    ["【原则5】纯寒暄", "你好"],
  ];

  for (const [tag, q] of cases) {
    let r;
    try { r = B.ask(q); } catch (e) { console.log(tag, "抛出异常:", e.message); continue; }
    const out = r.result || {};
    const cards = (out.cards || []).map((c) => c.type).join(",");
    const opt = (out.options || []).map((o) => o.label).join(" | ");
    console.log("\n─────────────────────────────────────────────");
    console.log(tag + "  输入: " + q);
    console.log("插件: " + r.plugin.id + " / 层级: " + out.level + " / 置信: " + r.message.confidence);
    console.log("卡片: " + (cards || "(无)"));
    console.log("回复: " + String(out.text || "").replace(/\n/g, "\n      "));
    console.log("选项: " + (opt || "(无)"));
  }
})();
