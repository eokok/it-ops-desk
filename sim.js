/* 端到端对话模拟：验证插件路由 / 诊断流程 / 建单 / 审计回放数据 */
const path = require("path");
global.window = {};
const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };

require(path.join(__dirname, "bot-data.js"));
require(path.join(__dirname, "bot-flows.js"));
require(path.join(__dirname, "bot.js"));

// 模拟主系统数据
const mainState = {
  incidents: [], cis: [], requests: [], changes: [],
  kb: [{ id: "KB9001", title: "Exchange 邮件流排查手册", category: "应用", tags: ["邮件", "Exchange", "退信"], content: "1. 检查邮件队列；2. 检查连接器；3. 查看网关日志", views: 3 }],
};
global.window.OpsDesk = {
  getState: () => mainState,
  save: () => {},
  refresh: () => {},
  util: { uid: (p) => p + "1234", nowISO: () => new Date().toISOString(), slaInfo: () => ({ text: "剩余 2 时" }) },
};

const bot = global.window.OpsBot;

function show(title, res) {
  console.log("\n===== " + title + " =====");
  console.log("[插件] " + (res.plugin ? res.plugin.name : "-") + "   [分级] " + (res.result ? res.result.level : "-"));
  console.log("[回复] " + String(res.result.text).slice(0, 260).replace(/\n/g, "\n       "));
  if (res.result.options && res.result.options.length) console.log("[选项] " + res.result.options.map((o) => o.label).join("  |  "));
  if (res.result.sources && res.result.sources.length) console.log("[引用] " + res.result.sources.map((s) => s.type + ":" + s.id).join(", "));
  if (res.result.cards && res.result.cards.length) console.log("[卡片] " + res.result.cards.map((c) => c.type).join(", "));
}

bot.newSession();
show("1. FAQ 自助（忘记密码）", bot.ask("我密码忘了进不去系统了"));
show("2. RAG 检索（邮件收不到）", bot.ask("有同事反映邮件收不到"));
show("3. 智能诊断（网络）", bot.ask("帮我诊断一下网络，我电脑连不上网"));
show("4. 诊断-选项1（网线）", bot.ask("1"));
show("5. 诊断-灯亮", bot.ask("亮或闪烁"));
show("6. 诊断-选「10.x 正常网段」", bot.act("__opt__:1"));
show("7. 诊断-选「网关能通」", bot.act("__opt__:0"));
show("8. 诊断-选「DNS 解析失败」", bot.act("__opt__:1"));
show("9. 一键建单（P2 网络）", bot.act("__create__:" + encodeURIComponent("内网 DNS 解析异常") + "|P2|网络"));
show("10. 查询工单", bot.ask("我的工单进度"));
show("11. 新员工入职指引", bot.ask("我是新员工刚入职，需要做什么准备"));
show("12. 无关问题（低置信兜底）", bot.ask("我办公室的椅子腿断了"));
show("13. 无关问题→转人工", bot.act("__ticket__"));
show("14. 重新进入诊断并中途切换", bot.ask("帮我诊断一下打印机"));
show("15. 中途切换到查工单", bot.ask("我的工单进度"));

console.log("\n===== 统计 =====");
console.log(JSON.stringify(bot.stats(), null, 2));

const s = bot.cur();
console.log("\n===== 审计（会话 " + s.id + "）=====");
console.log("消息数: " + s.messages.length + "   工具调用数: " + s.tools.length);
s.tools.forEach((t) => console.log("  [" + t.at.slice(11, 19) + "] " + t.plugin + "." + t.action + "  status=" + t.status + "  " + t.ms + "ms"));

console.log("\n===== 主系统已创建工单 =====");
mainState.incidents.forEach((i) => console.log("  " + i.id + " | " + i.title + " | " + i.priority + " | " + i.category + " | 来源: " + i.source));
console.log("\n回放数据检查: 首条消息 = " + JSON.stringify(s.messages[0]).slice(0, 160));
