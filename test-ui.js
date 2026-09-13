/* 助手界面层集成测试（jsdom 无头驱动真实 DOM）
   运行：NODE_PATH=<workspace>/node_modules node test-ui.js
   覆盖：导航切换 / 欢迎页 / 快捷提问 / 回复卡片 / 选项点击 / 诊断流程推进
        / 对话建单（写入主系统）/ 审计表 / 工具调用明细 / 回放播放 / 看板挂件 / 异常捕获 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const DIR = __dirname;
const errors = [];
const logs = [];
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 组装测试页面：内联脚本 + Chart/XLSX 打桩 ---------- */
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
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e && e.message ? e.message : e)));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));
vc.on("warn", (...a) => logs.push("warn: " + a.join(" ")));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://local.test/",
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;
window.addEventListener("error", (e) => errors.push("window.onerror: " + e.message));
window.addEventListener("unhandledrejection", (e) => errors.push("unhandledrejection: " + e.reason));

const $ = (s) => doc.querySelector(s);
const $$ = (s) => Array.prototype.slice.call(doc.querySelectorAll(s));
const txt = (s) => { const e = $(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; };
const click = (el) => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

function botMessages() {
  return $$("#botStream .bmsg-b");
}
function lastOptions() {
  const ms = botMessages();
  return ms.length ? Array.prototype.slice.call(ms[ms.length - 1].querySelectorAll(".bopt")) : [];
}

(async function run() {
  await new Promise((r) => {
    if (doc.readyState === "complete") return r();
    window.addEventListener("load", r);
    setTimeout(r, 800);
  });
  await wait(60);

  console.log("\n=== 1. 引擎与界面层加载 ===");
  ok(!!window.OpsBot, "window.OpsBot 已挂载");
  ok(typeof window.OpsBot.render === "function", "OpsBot.render 已挂载");
  ok(typeof window.OpsBot.renderAudit === "function", "OpsBot.renderAudit 已挂载");
  ok(typeof window.OpsBot.renderDashboardWidgets === "function", "OpsBot.renderDashboardWidgets 已挂载");
  ok(window.OpsBot.FAQS.length === 52, "FAQ 语料 52 条", "实际 " + window.OpsBot.FAQS.length);
  ok(window.OpsBot.FLOWS.length === 7, "诊断流程 7 条", "实际 " + window.OpsBot.FLOWS.length);
  ok(window.OpsBot.PLUGINS.length === 5, "核心插件 5 个", "实际 " + window.OpsBot.PLUGINS.length);
  ok(window.OpsBot.EVAL_SET.length === 101, "评测样本 101 条", "实际 " + window.OpsBot.EVAL_SET.length);

  console.log("\n=== 2. 导航与页面区块 ===");
  ok($$('.nav-item[data-page="assistant"]').length === 1, "侧栏含「IT 智能助手」入口");
  ok($$('.nav-item[data-page="audit"]').length === 1, "侧栏含「审计与回放」入口");
  ok(!!$("#page-assistant") && !!$("#page-audit"), "两个页面区块已渲染");
  window.OpsDesk.switchPage("assistant");
  ok($("#page-assistant").classList.contains("active"), "切换到助手页");
  ok(txt("#pageTitle") === "IT 智能助手", "顶栏标题正确", txt("#pageTitle"));

  console.log("\n=== 3. 助手侧栏与欢迎页 ===");
  ok($$("#botPlugins .bplug").length === 5, "插件卡 5 张", $$("#botPlugins .bplug").length);
  ok($$("#botTiers .btier").length === 3, "分级服务流程 3 级", $$("#botTiers .btier").length);
  ok($$("#botSla tbody tr").length === 4, "SLA 分级表 P1–P4", $$("#botSla tbody tr").length);
  ok($$("#botQuick .bquick").length >= 6, "快捷提问 chips", $$("#botQuick .bquick").length);
  ok(/IT 智能助手/.test(txt("#botStream")), "欢迎页文案已渲染");
  const demoN = window.OpsBot.store.sessions.length;
  ok(demoN >= 10, "演示审计会话已种子", "实际 " + demoN);

  console.log("\n=== 4. 自由输入 → FAQ 自助命中 ===");
  $("#botInput").value = "我密码忘了进不去系统了";
  click($("#botSend"));
  await wait(30);
  ok(botMessages().length === 1, "产生 1 条助手回复", botMessages().length);
  ok(/已为你找到答案/.test(txt("#botStream")), "命中 FAQ 自助应答");
  ok($$("#botStream .bcard-faq").length === 1, "渲染 FAQ 卡片");
  ok($$("#botStream .bcard-steps li").length >= 3, "渲染处置步骤清单");
  ok($$("#botStream .bsrc").length === 1, "渲染引用来源折叠区");
  ok($$("#botStream .baudit").length === 1, "渲染检索审计明细");
  ok(lastOptions().length === 3, "给出 3 个后续选项", lastOptions().length);
  ok($$("#botStream .bpill.lv-self").length >= 1, "标注自助解决层级");

  console.log("\n=== 5. 快捷提问与选项点击 ===");
  click($$("#botQuick .bquick")[1]);
  await wait(30);
  ok(botMessages().length === 2, "快捷提问新增回复");
  const beforeMsgs = window.OpsBot.cur().messages.length;
  const solved = lastOptions().find((b) => /已解决/.test(b.textContent));
  click(solved);
  await wait(30);
  ok(window.OpsBot.cur().messages.length > beforeMsgs, "选项点击写入用户与助手消息");
  ok($$("#botStream .bcard-closed").length === 1, "渲染会话闭环卡片");
  ok(/会话已闭环/.test(txt("#botStream")), "闭环文案已展示");

  console.log("\n=== 6. 故障诊断工作流（一问一答） ===");
  $("#botInput").value = "帮我诊断打印机故障";
  click($("#botSend"));
  await wait(30);
  const optCount = lastOptions().length;
  ok(optCount >= 2, "诊断流程给出选项", optCount);
  ok($$("#botStream .bcard-flow").length >= 1, "渲染流程节点卡片");
  const firstOpt = lastOptions()[0];
  const optLabel = firstOpt.textContent.trim();
  click(firstOpt);
  await wait(30);
  ok(/当前节点|已到达结论节点|✅|🔍|⚠️/.test(txt("#botStream")), "流程成功推进到下一节点");
  ok(window.OpsBot.cur().messages.slice(-2)[0].text === optLabel, "点击选项以可读文案留痕（非裸序号）", window.OpsBot.cur().messages.slice(-2)[0].text);
  ok($$("#botStream .bcard-result").length >= 1 || $$("#botStream .bcard-flow").length >= 2, "出现结论卡或下一节点卡");

  console.log("\n=== 7. 大面积故障直达人工（P1） ===");
  const incBefore = window.OpsDesk.getState().incidents.length;
  const botBefore = window.OpsBot.cur().messages.filter((m) => m.role === "bot").length;
  const wasInFlow = !!(window.OpsBot.cur().flow && window.OpsBot.cur().flow.active);
  $("#botInput").value = "财务系统全公司都打不开了";
  click($("#botSend"));
  await wait(30);
  const incAfter = window.OpsDesk.getState().incidents.length;
  ok(incAfter === incBefore + 1, "主系统工单数 +1", incBefore + " → " + incAfter);
  ok($$("#botStream .bcard-blast").length === 1, "渲染大面积故障直达告警卡");
  ok($$("#botStream .bcard-ticket").length === 1, "渲染工单卡片");
  const newInc = window.OpsDesk.getState().incidents[0];
  ok(newInc.priority === "P1", "P1 由影响面自动判定", newInc.priority);
  ok(newInc.source === "AI 助手", "工单来源标记为 AI 助手", newInc.source);
  ok(newInc.id === window.OpsBot.cur().resolution.ticketId, "新工单即本次会话所建工单", newInc.id);
  ok(/响应时限/.test(txt("#botStream .bcard-ticket")) && /解决时限/.test(txt("#botStream .bcard-ticket")), "工单卡片含 SLA 响应/解决时限");
  ok(/15 分钟/.test(txt("#botStream .bcard-ticket")), "P1 响应时限 15 分钟");
  ok(window.OpsBot.cur().resolution.level === "ticket", "会话结论层级=转人工");
  ok(window.OpsBot.cur().resolution.ticketId === newInc.id, "会话与工单双向关联", window.OpsBot.cur().resolution.ticketId);
  ok($$("#botStream .bpill.lv-ticket").length >= 1, "标注人工工单层级");
  ok(window.OpsBot.cur().tools.some((t) => t.action === "blast_escalate"), "直达人工动作已入审计日志");
  const blastMsgs = window.OpsBot.cur().messages.filter((m) => m.role === "bot").length;
  ok(blastMsgs === botBefore + 1, "大面积故障一跳直达（未先走 FAQ 自助）", botBefore + " → " + blastMsgs);
  ok(!wasInFlow || !(window.OpsBot.cur().flow && window.OpsBot.cur().flow.active), "诊断流程已让位（不被卡在流程中）");
  ok(!wasInFlow || window.OpsBot.cur().tools.some((t) => t.action === "flow_abort"), "流程中断留有审计痕迹");

  console.log("\n=== 7b. 普通故障仍走自助/诊断（不受直达规则影响） ===");
  $("#botInput").value = "公司 Wi-Fi 老是掉线";
  click($("#botSend"));
  await wait(30);
  const incAfter2 = window.OpsDesk.getState().incidents.length;
  ok(incAfter2 === incAfter, "普通故障不误开单", incAfter + " → " + incAfter2);
  ok($$("#botStream .bcard-faq").length >= 1, "仍由 FAQ 自助应答");

  console.log("\n=== 8. 入职指引插件 ===");
  $("#botInput").value = "新员工入职电脑要准备什么";
  click($("#botSend"));
  await wait(30);
  ok($$("#botStream .bob-card").length === 4, "四阶段清单卡", $$("#botStream .bob-card").length);
  const st0 = $$("#botStream .bob-card")[0];
  click(st0);
  await wait(30);
  ok($$("#botStream .bob-row").length > 0, "阶段明细可展开", $$("#botStream .bob-row").length);
  const row0 = $$("#botStream .bob-row")[0];
  click(row0);
  await wait(30);
  const onb = window.OpsBot.onboardStats();
  ok(onb.done >= 1, "勾选进度已写入并统计", JSON.stringify(onb));
  ok($$("#botStream .bob-row.done").length >= 1, "勾选态样式生效");

  console.log("\n=== 9. 会话头部与多会话管理 ===");
  ok(/会话/.test(txt("#botSub")), "头部显示会话元信息");
  ok(/次工具调用/.test(txt("#botSub")), "头部统计工具调用次数");
  ok($$("#botLevelChip .bpill").length === 1, "头部展示当前服务层级");
  const sidOld = window.OpsBot.cur().id;
  click($("#botNew"));
  await wait(20);
  ok(window.OpsBot.cur().id !== sidOld, "新建会话切换成功");
  ok(window.OpsBot.store.sessions.length === demoN + 1, "会话被归档进审计库", window.OpsBot.store.sessions.length + " / 种子 " + demoN);

  console.log("\n=== 10. 审计与回放页 ===");
  window.OpsDesk.switchPage("audit");
  ok($("#page-audit").classList.contains("active"), "切换到审计页");
  ok($$("#auditStats .stat").length === 8, "审计指标卡 8 张", $$("#auditStats .stat").length);
  ok($$("#audBody tr").length >= 10, "会话审计表有数据", $$("#audBody tr").length);
  ok($$("#audBody .bpill").length >= 10, "每条会话标注服务层级");
  ok($$("#audToolBody tr").length > 0, "工具调用明细有数据", $$("#audToolBody tr").length);
  ok(/IN/.test(txt("#audTimeline")) && /OUT/.test(txt("#audTimeline")), "回放时间轴含工具入参/出参");
  ok(/回放进度/.test(txt("#audTimeline")), "回放进度条已渲染");
  ok($$("#audTimeline .aur-ev.pending").length > 0, "未播放事件处于待播状态");

  // 回放播放
  click($("#audStepBtn"));
  await wait(20);
  ok($$("#audTimeline .aur-ev.done").length >= 1, "单步推进：出现已播放事件");
  ok($$("#audTimeline .aur-ev.current").length === 1, "单步推进：当前事件高亮");
  const p1 = /回放进度 (\d+)/.exec(txt("#audTimeline"));
  click($("#audStepBtn"));
  await wait(20);
  const p2 = /回放进度 (\d+)/.exec(txt("#audTimeline"));
  ok(p1 && p2 && Number(p2[1]) === Number(p1[1]) + 1, "单步计数递增", (p1 && p1[0]) + " → " + (p2 && p2[0]));
  click($("#audPlay"));
  await wait(1100);
  const p3 = /回放进度 (\d+)/.exec(txt("#audTimeline"));
  ok(p3 && Number(p3[1]) > Number(p2[1]), "自动播放持续推进", p3 && p3[0]);
  click($("#audPlay"));   // 暂停
  await wait(30);
  ok($("#audPlay").textContent.indexOf("播放") >= 0, "可暂停播放");
  click($("#audReset"));
  await wait(20);
  ok(/回放进度 0/.test(txt("#audTimeline")), "可重置回放");
  ok($$("#audSpeed option").length === 3, "支持 1×/2×/5× 倍速");

  // 切换会话回放
  const sessRows = $$("#audBody tr[data-sess]");
  const targetId = sessRows[1].dataset.sess;
  click(sessRows[1]);
  await wait(20);
  ok($("#audReplayId").textContent.indexOf(targetId) >= 0, "点击会话行载入对应回放", $("#audReplayId").textContent);
  ok($$("#audBody tr.row-active").length === 1, "选中行高亮");

  // 筛选
  $("#audResult").value = "ticket";
  $("#audResult").dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(20);
  const tkRows = $$("#audBody tr[data-sess]").length;
  ok(tkRows >= 1 && tkRows < sessRows.length, "按结果筛选生效", tkRows + "/" + sessRows.length);
  const firstVisible = $$("#audBody tr[data-sess]")[0].dataset.sess;
  ok($("#audReplayId").textContent.indexOf(firstVisible) >= 0,
    "筛选后回放面板与列表选中项保持一致", $("#audReplayId").textContent + " vs " + firstVisible);
  $("#audResult").value = "";
  $("#audResult").dispatchEvent(new window.Event("change", { bubbles: true }));
  await wait(20);

  $("#audSearch").value = "打印机";
  $("#audSearch").dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(20);
  ok($$("#audBody tr[data-sess]").length < sessRows.length, "关键词检索会话生效", $$("#audBody tr[data-sess]").length);
  $("#audSearch").value = "";
  $("#audSearch").dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(20);

  // 回放需完整还原当时下发的卡片与选项（否则 FAQ 答案等关键信息在追溯时丢失）
  const liveSess = window.OpsBot.store.sessions.find((s) =>
    (s.messages || []).some((m) => m.role === "bot" && (m.cards || []).length));
  ok(!!liveSess, "存在带卡片的真实会话");
  const liveRow = $$("#audBody tr[data-sess]").find((r) => r.dataset.sess === liveSess.id);
  click(liveRow);
  await wait(20);
  ok($$("#audTimeline .aur-cards .bcard").length > 0, "回放还原当时的卡片内容", $$("#audTimeline .aur-cards .bcard").length);
  ok($$("#audTimeline .aur-cards .bcard-steps li").length > 0, "回放保留处置步骤", $$("#audTimeline .aur-cards .bcard-steps li").length);
  ok($$("#audTimeline .aur-opts .tag").length > 0, "回放还原当时给出的选项");

  console.log("\n=== 11. 数据看板挂件 ===");
  window.OpsDesk.switchPage("dashboard");
  ok($("#page-dashboard").classList.contains("active"), "切换回看板");
  ok($$("#botDashStats .stat").length === 4, "助手效能卡 4 张", $$("#botDashStats .stat").length);
  ok(/自助解决率/.test(txt("#botDashStats")), "展示自助解决率指标");
  ok($$("#botRecent .brecent-row").length === 5, "最近会话 5 条", $$("#botRecent .brecent-row").length);
  ok(/混合检索评测/.test(txt("#botEvalBox")), "评测面板已渲染");
  click($("#botRunEval"));
  await wait(1200);
  const ev = window.OpsBot.store.lastEval;
  ok(!!ev, "评测已产出结果");
  ok(ev && ev.top1Hit >= 0.95, "Top-1 命中率 ≥95%", ev && (ev.top1Hit * 100).toFixed(1) + "%");
  ok(ev && ev.selfRate >= 0.95, "自助解决率达标 ≥95%", ev && (ev.selfRate * 100).toFixed(1) + "%");
  ok(/超过 FAQ 自助解决率 95%|低于 95% 目标/.test(txt("#botEvalBox")), "评测结论文案已展示");

  console.log("\n=== 12. 全局统计与异常检查 ===");
  const st = window.OpsBot.stats();
  ok(st.sessions === window.OpsBot.store.sessions.length, "统计会话数一致");
  ok(st.toolCalls > 20, "工具调用被完整审计", st.toolCalls);
  ok(st.messages > 20, "消息被完整审计", st.messages);
  ok(typeof st.deflectRate === "number" && st.deflectRate >= 0 && st.deflectRate <= 1, "自助解决率计算正常", (st.deflectRate * 100).toFixed(1) + "%");

  const realErr = errors.filter((e) => !/Not implemented|canvas/i.test(e));
  ok(realErr.length === 0, "运行期无 JS 异常", realErr.slice(0, 4).join(" | "));

  console.log("\n================ 结果 ================");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  if (errors.length) console.log("捕获到的错误/警告：\n - " + errors.slice(0, 8).join("\n - "));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("测试脚本异常：" + (e && e.stack ? e.stack : e));
  process.exit(2);
});
