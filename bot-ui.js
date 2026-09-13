/* ============================================================
   IT 智能助手 — 界面层
   1) 对话界面（消息流 / 插件卡片 / 诊断选项 / 入职清单 / 引用来源）
   2) 审计与故障回放（会话审计表 + 工具调用明细 + 时间轴回放播放器）
   3) 数据看板挂件（自助解决率 / 插件调用分布 / 检索评测）
   依赖：bot-data.js → bot-flows.js → bot.js（本文件最后加载）
   ============================================================ */
(function () {
  "use strict";
  const B = window.OpsBot;
  if (!B) { console.error("[OpsBot UI] 引擎未加载，界面层跳过"); return; }

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  /* ============================================================
     0. 通用工具
     ============================================================ */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  /** 轻量富文本：**加粗** + 换行 */
  function rich(text) {
    return esc(text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  }
  const pct0 = (n) => (n == null ? "–" : Math.round(n * 100) + "%");
  const pct1 = (n) => (n == null ? "–" : (n * 100).toFixed(1) + "%");
  const num = (n) => (n == null ? "–" : Number(n).toLocaleString("zh-CN"));

  function levelMeta(lv) {
    return ({
      self: { t: "自助解决", cls: "lv-self", ico: "✅" },
      diagnose: { t: "智能诊断", cls: "lv-diag", ico: "🔍" },
      diag: { t: "诊断结论", cls: "lv-diag", ico: "🔍" },
      ticket: { t: "人工工单", cls: "lv-ticket", ico: "🎫" },
    })[lv] || { t: "会话", cls: "lv-any", ico: "💬" };
  }
  const PLUGIN_EXTRA = [{ id: "engine", name: "编排引擎", icon: "⚙️" }];
  function pluginMeta(id) {
    return B.PLUGIN_META.concat(PLUGIN_EXTRA).find((p) => p.id === id) || { id: id, name: id, icon: "🔧" };
  }
  function scoreBar(score) {
    const w = Math.max(4, Math.min(100, Math.round((score || 0) * 100)));
    return '<span class="bscore" title="混合检索融合分">' +
      '<i style="width:' + w + '%"></i></span>' +
      '<b class="bscore-num">' + pct0(score) + '</b>';
  }
  function priPill(p) {
    if (!p) return "";
    return '<span class="pill pr' + String(p).slice(1) + '">' + esc(p) + '</span>';
  }
  function dateStamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }
  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }
  const toast = (m) => { if (window.OpsDesk && window.OpsDesk.toast) window.OpsDesk.toast(m); };

  /* ============================================================
     1. 卡片渲染器（与插件返回的 cards[].type 一一对应）
     ============================================================ */
  const CARDS = {
    /* FAQ 命中卡片：答案 + 处置步骤 + 归属信息 */
    faq(c) {
      const f = c.faq || {};
      return '<div class="bcard bcard-faq">' +
        '<div class="bcard-h"><span class="bcard-t">📚 ' + esc(f.q) + '</span>' + scoreBar(c.score) + '</div>' +
        '<div class="bcard-b">' +
          '<div class="bcard-ans">' + rich(f.a) + '</div>' +
          (f.steps && f.steps.length
            ? '<div class="bcard-steps-h">处置步骤</div><ol class="bcard-steps">' +
              f.steps.map((s) => "<li>" + rich(s) + "</li>").join("") + "</ol>"
            : "") +
          '<div class="bcard-tags">' +
            '<span class="tag">' + esc(f.cat || "未分类") + '</span>' +
            '<span class="tag ghost">归属 ' + esc(f.owner || "服务台") + '</span>' +
            '<span class="tag ghost">' + esc(f.pri || "P3") + '</span>' +
            '<span class="tag ghost">' + esc(f.id || "") + '</span>' +
          '</div>' +
        '</div></div>';
    },
    /* RAG 多来源召回：候选清单，点击可直达 */
    rag(c) {
      const hits = c.hits || [];
      return '<div class="bcard">' +
        '<div class="bcard-h"><span class="bcard-t">🔎 语义召回候选（' + hits.length + '）</span></div>' +
        '<div class="bcard-b"><div class="bhit-list">' +
        hits.map((h, i) => '<div class="bhit" data-pick="' + esc(h.id) + '">' +
          '<span class="bhit-i">' + (i + 1) + '</span>' +
          '<span class="bhit-q">' + esc(h.q) + '</span>' +
          '<span class="tag ghost">' + esc(h.cat || "") + '</span>' +
          scoreBar(h.score) + '</div>').join("") +
        '</div></div></div>';
    },
    kbList(c) {
      const items = c.items || [];
      return '<div class="bcard">' +
        '<div class="bcard-h"><span class="bcard-t">❏ 关联知识库文章</span></div>' +
        '<div class="bcard-b"><div class="blist">' +
        items.map((k) => '<div class="blist-item"><b>' + esc(k.title) + '</b>' +
          '<span class="tag">' + esc(k.category || "K B") + '</span>' +
          '<div class="blist-sub">' + esc(String(k.content || "").slice(0, 110)) + '…</div></div>').join("") +
        '</div></div></div>';
    },
    incList(c) {
      const items = c.items || [];
      return '<div class="bcard">' +
        '<div class="bcard-h"><span class="bcard-t">🎫 相似历史工单</span></div>' +
        '<div class="bcard-b"><div class="blist">' +
        items.map((i) => '<div class="blist-item"><b>' + esc(i.id) + ' · ' + esc(i.title) + '</b>' +
          priPill(i.priority) +
          '<div class="blist-sub">' + esc(i.status || "") + ' · ' + esc(i.assignee || i.owner || "待分派") + '</div></div>').join("") +
        '</div></div></div>';
    },
    /* 诊断流程清单 */
    flowList(c) {
      const flows = c.flows || [];
      return '<div class="bcard">' +
        '<div class="bcard-h"><span class="bcard-t">🧭 可用诊断流程（' + flows.length + '）</span></div>' +
        '<div class="bcard-b"><div class="bflow-grid">' +
        flows.map((f) => '<button class="bflow" data-flow="' + esc(f.id) + '">' +
          '<span class="bflow-ico">' + esc(f.icon || "🧭") + '</span>' +
          '<span class="bflow-name">' + esc(f.name) + '</span>' +
          '<span class="bflow-meta">' + esc(f.cat || "") + ' · ' + esc(f.sla || "") + '</span>' +
          '</button>').join("") +
        '</div></div></div>';
    },
    /* 当前流程节点进度 */
    flow(c) {
      const node = c.node || {};
      return '<div class="bcard bcard-flow">' +
        '<div class="bcard-h"><span class="bcard-t">🧭 ' + esc(c.name || "诊断流程") + '</span>' +
        '<span class="tag">' + esc(c.cat || "") + '</span><span class="tag ghost">SLA ' + esc(c.sla || "—") + '</span></div>' +
        '<div class="bcard-b">' +
        (node.type === "result"
          ? '<div class="bcard-ans">已到达结论节点：<b>' + esc(node.title || "") + '</b></div>'
          : '<div class="bcard-ans">当前节点：<b>' + esc(node.q || "") + '</b></div>' +
            '<div class="bstep-hint">请点击下方选项，或直接回复序号</div>') +
        '</div></div>';
    },
    /* 诊断结论 */
    result(c) {
      const lm = levelMeta(c.level);
      return '<div class="bcard bcard-result ' + lm.cls + '">' +
        '<div class="bcard-h"><span class="bcard-t">' + lm.ico + ' ' + esc(c.title || "诊断结论") + '</span>' +
        '<span class="bpill ' + lm.cls + '">' + lm.t + '</span></div>' +
        '<div class="bcard-b">' +
        (c.steps && c.steps.length
          ? '<div class="bcard-steps-h">建议操作</div><ol class="bcard-steps">' +
            c.steps.map((s) => "<li>" + rich(s) + "</li>").join("") + "</ol>"
          : "") +
        '<div class="bcard-tags">' +
          (c.pri ? '<span class="tag">建议优先级 ' + esc(c.pri) + '</span>' : "") +
          (c.pri ? '<span class="tag ghost">响应 ' + esc(B.SLA_RESPONSE[c.pri] || "—") + ' / 解决 ' + esc(B.SLA_RESOLVE[c.pri] || "—") + '</span>' : "") +
          '<span class="tag ghost">分类 ' + esc(c.cat || "其他") + '</span>' +
        '</div></div></div>';
    },
    /* 工单卡片 */
    ticket(c) {
      const t = c.ticket || {};
      return '<div class="bcard bcard-ticket">' +
        '<div class="bcard-h"><span class="bcard-t">🎫 ' + esc(t.id) + ' · ' + esc(t.title) + '</span>' + priPill(t.priority) + '</div>' +
        '<div class="bcard-b">' +
          '<div class="bkv">' +
            '<div><span>状态</span><b>' + esc(t.status || "open") + '</b></div>' +
            '<div><span>分类</span><b>' + esc(t.category || "其他") + '</b></div>' +
            '<div><span>负责人</span><b>' + esc(t.assignee || "待分派") + '</b></div>' +
            '<div><span>响应时限</span><b>' + esc(c.response || "—") + '</b></div>' +
            '<div><span>解决时限</span><b>' + esc(c.resolve || "—") + '</b></div>' +
            '<div><span>处理方</span><b>' + esc(c.owner || "—") + '</b></div>' +
          '</div>' +
          (t.source ? '<div class="bcard-tags"><span class="tag ghost">来源 ' + esc(t.source) + '</span>' +
            '<span class="tag ghost">会话 ' + esc(t.sourceSession || "") + '</span></div>' : "") +
        '</div></div>';
    },
    ticketList(c) {
      const items = c.items || [];
      if (!items.length) return '<div class="bcard"><div class="bcard-b"><div class="empty">暂无工单</div></div></div>';
      return '<div class="bcard">' +
        '<div class="bcard-h"><span class="bcard-t">🎫 工单列表（' + items.length + '）</span></div>' +
        '<div class="bcard-b" style="padding:0">' +
        '<div style="overflow-x:auto"><table class="btable"><thead><tr>' +
        '<th>编号</th><th>标题</th><th>状态</th><th>优先级</th><th>负责人</th><th>创建</th></tr></thead><tbody>' +
        items.map((i) => '<tr><td>' + esc(i.id) + '</td><td>' + esc(i.title) + '</td>' +
          '<td>' + esc(i.status || "") + '</td><td>' + priPill(i.priority) + '</td>' +
          '<td>' + esc(i.assignee || i.owner || "—") + '</td><td>' + esc(String(i.createdAt || i.created || "").slice(0, 16).replace("T", " ")) + '</td></tr>').join("") +
        '</tbody></table></div></div></div>';
    },
    escalate(c) {
      return '<div class="bcard bcard-result lv-ticket">' +
        '<div class="bcard-h"><span class="bcard-t">🎫 已升级人工工单</span>' + priPill(c.pri) + '</div>' +
        '<div class="bcard-b"><div class="bkv">' +
        '<div><span>标题</span><b>' + esc(c.title) + '</b></div>' +
        '<div><span>分类</span><b>' + esc(c.cat || "其他") + '</b></div>' +
        '<div><span>响应时限</span><b>' + esc(B.SLA_RESPONSE[c.pri] || "—") + '</b></div>' +
        '<div><span>解决时限</span><b>' + esc(B.SLA_RESOLVE[c.pri] || "—") + '</b></div>' +
        '</div></div></div>';
    },
    /* 入职清单总览 */
    onboard(c) {
      const stages = c.stages || [];
      const overall = c.overall || { done: 0, total: 0, pct: 0 };
      return '<div class="bcard">' +
        '<div class="bcard-h"><span class="bcard-t">🎓 新员工 IT 入职指引</span>' +
        '<span class="tag">总进度 ' + overall.done + "/" + overall.total + "（" + overall.pct + '%）</span></div>' +
        '<div class="bcard-b">' +
        '<div class="bobar"><i style="width:' + overall.pct + '%"></i></div>' +
        '<div class="bob-stage">' +
        stages.map((s) => {
          const done = s.items.filter((i) => c.progress && c.progress[i.id]).length;
          const p = s.items.length ? Math.round((done / s.items.length) * 100) : 0;
          return '<button class="bob-card" data-opt="' + esc("__stage__:" + s.id) + '" data-label="' + esc("查看阶段：" + s.name) + '">' +
            '<div class="bob-top"><b>' + esc(s.name) + '</b><span>' + done + "/" + s.items.length + '</span></div>' +
            '<div class="bob-bar"><i style="width:' + p + '%"></i></div>' +
            '<div class="bob-meta">归属：' + esc(s.owner) + '</div></button>';
        }).join("") +
        '</div></div></div>';
    },
    /* 单个阶段明细 */
    stage(c) {
      const s = c.stage || { items: [] };
      const prog = c.progress || {};
      return '<div class="bcard">' +
        '<div class="bcard-h"><span class="bcard-t">🎓 ' + esc(s.name) + '</span>' +
        '<span class="tag ghost">' + esc(s.owner) + '</span></div>' +
        '<div class="bcard-b"><div class="bob-list">' +
        s.items.map((i) => '<div class="bob-row' + (prog[i.id] ? " done" : "") + '" data-opt="' + esc("__toggle__:" + i.id) + '" data-label="' + esc((prog[i.id] ? "取消勾选：" : "已办妥：") + i.t) + '">' +
          '<span class="bob-chk">' + (prog[i.id] ? "☑" : "☐") + '</span>' +
          '<span class="bob-t">' + esc(i.t) + '</span>' +
          '<span class="tag ghost">' + esc(i.owner) + ' · ' + esc(i.sla) + '</span>' +
          '<span class="bob-d">' + esc(i.d) + '</span></div>').join("") +
        '</div></div></div>';
    },
    /* 大面积故障直达人工告警 */
    blast(c) {
      return '<div class="bcard bcard-blast">' +
        '<div class="bcard-h"><span class="bcard-t">🚨 大面积故障 · 已直达人工</span>' + priPill(c.pri || "P1") + '</div>' +
        '<div class="bcard-b"><div class="bb-blast">' +
        '已跳过自助排查与逐步诊断，按 <b>P1 紧急</b> 立即开单（响应 ' + esc(B.SLA_RESPONSE.P1) + ' / 解决 ' + esc(B.SLA_RESOLVE.P1) +
        '，' + esc(B.SLA_OWNER.P1) + '）。' +
        (c.ticketId ? '<div class="bb-blast-t">工单 <b>' + esc(c.ticketId) + '</b>：' + esc(c.title) + '</div>' : "") +
        '</div></div></div>';
    },
    /* 会话闭环 */
    closed(c) {
      const r = c.resolution || {};
      return '<div class="bcard bcard-closed">' +
        '<div class="bcard-h"><span class="bcard-t">✅ 会话已闭环</span></div>' +
        '<div class="bcard-b"><div class="bkv">' +
        '<div><span>解决层级</span><b>' + esc(levelMeta(r.level).t) + '</b></div>' +
        '<div><span>用户确认</span><b>' + (r.resolved ? "已解决" : "未标注") + '</b></div>' +
        '<div><span>关联工单</span><b>' + esc(r.ticketId || "无（未转人工）") + '</b></div>' +
        '</div></div></div>';
    },
  };

  function renderCard(c) {
    const fn = CARDS[c && c.type];
    return fn ? fn(c) : "";
  }
  function renderCards(cards) {
    if (!cards || !cards.length) return "";
    return '<div class="bcard-wrap">' + cards.map(renderCard).join("") + "</div>";
  }
  function renderSources(sources) {
    if (!sources || !sources.length) return "";
    return '<details class="bsrc"><summary>引用来源（' + sources.length + '）</summary><div class="bsrc-b">' +
      sources.map((s) => '<div class="bsrc-row"><span class="tag">' + esc(s.type) + '</span>' +
        '<span class="bsrc-t">' + esc(s.title) + '</span>' +
        '<span class="tag ghost">' + esc(s.id) + '</span>' +
        (s.score != null ? scoreBar(s.score) : "") + '</div>').join("") +
      "</div></details>";
  }
  function renderOptions(options) {
    if (!options || !options.length) return "";
    return '<div class="bopts">' + options.map((o) => {
      const lv = String(o.label || "");
      const cls = o.value === "__ticket__" ? " bopt-warn" : (/已解决|👍/.test(lv) ? " bopt-ok" : "");
      return '<button class="bopt' + cls + '" data-opt="' + esc(o.value) + '" data-label="' + esc(lv) + '">' + esc(lv) + "</button>";
    }).join("") + "</div>";
  }

  /* ============================================================
     2. 助手页 — 侧栏 / 头部 / 消息流
     ============================================================ */
  const DEMO_QUERY = {
    faq: "忘记域账号密码怎么重置",
    rag: "跨部门共享盘权限怎么申请",
    diag: "帮我诊断网络问题",
    ticket: "我的工单进度",
    onboard: "新员工入职电脑要准备什么",
  };
  const QUICK = [
    "忘记域账号密码怎么重置",
    "公司 Wi-Fi 老是掉线",
    "帮我诊断打印机故障",
    "在家连 VPN 连不上",
    "财务系统全公司都打不开了",
    "想申请共享盘读写权限",
    "新员工入职要准备什么",
    "我的工单进度",
  ];

  function renderSide() {
    const box = $("#botPlugins");
    if (box) {
      const use = B.stats().pluginUse || {};
      box.innerHTML = B.PLUGIN_META.map((p) =>
        '<button class="bplug" data-demo="' + esc(p.id) + '">' +
        '<span class="bplug-ico">' + esc(p.icon) + '</span>' +
        '<span class="bplug-main"><b>' + esc(p.name) + '</b><small>' + esc(p.desc) + '</small></span>' +
        '<span class="bplug-n">' + (use[p.id] || 0) + '</span></button>').join("");
    }
    const tiers = $("#botTiers");
    if (tiers) {
      const st = B.stats();
      const total = st.sessions || 1;
      tiers.innerHTML = [
        { t: "① 自助排查", d: "FAQ 命中即答", n: st.self, i: "✅", cls: "lv-self" },
        { t: "② 智能诊断", d: "决策树 / RAG 溯源", n: st.diagnose, i: "🔍", cls: "lv-diag" },
        { t: "③ 人工工单", d: "按 SLA 分级响应", n: st.ticket, i: "🎫", cls: "lv-ticket" },
      ].map((x, i) =>
        '<div class="btier ' + x.cls + '">' +
        '<span class="btier-ico">' + x.i + '</span>' +
        '<span class="btier-main"><b>' + x.t + '</b><small>' + x.d + '</small></span>' +
        '<span class="btier-n">' + x.n + '</span></div>' +
        (i < 2 ? '<div class="btier-arrow">↓ 置信度不足则升级</div>' : "")).join("") +
        '<div class="btier-foot">当前自助解决率 <b>' + pct1(st.deflectRate) + '</b> / 共 ' + total + ' 个会话</div>';
    }
    const sla = $("#botSla");
    if (sla) {
      sla.innerHTML = '<thead><tr><th>级别</th><th>响应</th><th>解决</th></tr></thead><tbody>' +
        ["P1", "P2", "P3", "P4"].map((p) =>
          '<tr><td>' + priPill(p) + '</td><td>' + esc(B.SLA_RESPONSE[p]) + '</td><td>' + esc(B.SLA_RESOLVE[p]) + '</td></tr>').join("") +
        "</tbody>";
    }
  }

  function renderHead() {
    const s = B.cur();
    const sub = $("#botSub");
    if (sub) {
      sub.innerHTML = "会话 <b>" + esc(s.id) + "</b> · " + esc(B.fmtTime(s.startedAt)) +
        " · " + s.messages.length + " 条消息 · " + s.tools.length + " 次工具调用" +
        (s.endedAt ? " · <span class=\"c-teal\">已结束</span>" : "");
    }
    const chip = $("#botLevelChip");
    if (chip) {
      const lv = (s.resolution || {}).level;
      if (!lv) chip.innerHTML = '<span class="bpill lv-any">未产生结论</span>';
      else {
        const m = levelMeta(lv);
        chip.innerHTML = '<span class="bpill ' + m.cls + '">' + m.ico + " " + m.t + "</span>" +
          (s.resolution.ticketId ? ' <span class="tag">' + esc(s.resolution.ticketId) + "</span>" : "");
      }
    }
  }

  function msgHtml(m, i) {
    if (m.role === "user") {
      return '<div class="bmsg bmsg-u" data-idx="' + i + '">' +
        '<div class="bbubble">' + rich(m.text) + "</div>" +
        '<div class="bmeta"><span>' + esc(B.fmtTime(m.at)) + "</span>" +
        (m.channel === "button" ? '<span class="tag ghost">选项点击</span>' : "") + "</div>" +
        "</div>";
    }
    const pm = pluginMeta(m.plugin);
    const lm = levelMeta(m.level);
    const a = m.audit || {};
    return '<div class="bmsg bmsg-b" data-idx="' + i + '">' +
      '<div class="bava">' + esc(pm.icon || "🤖") + "</div>" +
      '<div class="bmsg-main">' +
        '<div class="bhead">' +
          '<span class="bwho">' + esc(m.pluginName || pm.name) + "</span>" +
          '<span class="bpill ' + lm.cls + '">' + lm.t + "</span>" +
          (m.confidence ? '<span class="tag ghost" title="混合检索融合分">匹配度 ' + pct0(m.confidence) + "</span>" : "") +
        "</div>" +
        '<div class="bbubble">' + rich(m.text) + "</div>" +
        renderCards(m.cards) +
        renderOptions(m.options) +
        renderSources(m.sources) +
        (a.tokens || a.expansions
          ? '<details class="baudit"><summary>检索审计明细</summary><div class="baudit-b">' +
            '<div><span>查询分词</span><code>' + esc((a.tokens || []).join(" / ")) + "</code></div>" +
            '<div><span>概念扩展</span><code>' + esc((a.expansions || []).join(" / ") || "—") + "</code></div>" +
            '<div><span>置信等级</span><code>' + esc(a.level || "—") + "（领先幅度 " + (a.margin == null ? "—" : a.margin.toFixed(3)) + "，意图 " + esc(a.polarity || "any") + "）</code></div>" +
            "</div></details>"
          : "") +
        '<div class="bmeta"><span>' + esc(B.fmtTime(m.at)) + "</span>" +
          '<span class="tag ghost">插件 ' + esc(m.plugin || "—") + "</span>" +
          (m.fromAction ? '<span class="tag ghost">由选项触发</span>' : "") + "</div>" +
      "</div></div>";
  }

  function renderStream() {
    const el = $("#botStream");
    if (!el) return;
    const s = B.cur();
    if (!s.messages.length) {
      el.innerHTML =
        '<div class="bwelcome">' +
        '<div class="bw-ico">🤖</div>' +
        '<h3>你好，我是 IT 智能助手</h3>' +
        '<p>我会按 <b>自助排查 → 智能诊断 → 人工工单</b> 三级流程为你服务：' +
        '常见问题直接给答案，复杂故障带你逐步定位，需要人工时按 SLA 自动分级开单。</p>' +
        '<div class="bw-grid">' +
        B.PLUGIN_META.map((p) => '<div class="bw-cell"><span>' + esc(p.icon) + "</span><b>" + esc(p.name) + "</b><small>" + esc(p.desc) + "</small></div>").join("") +
        "</div>" +
        '<div class="bw-hint">试试下面的问题，或直接在输入框描述你的故障 ↓</div>' +
        "</div>";
    } else {
      el.innerHTML = s.messages.map(msgHtml).join("");
    }
    const q = $("#botQuick");
    if (q) q.innerHTML = QUICK.map((t) => '<button class="bquick" data-q="' + esc(t) + '">' + esc(t) + "</button>").join("");
    renderHead();
    renderSide();
    setTimeout(() => { el.scrollTop = el.scrollHeight; }, 30);
  }

  function send(text) {
    const t = String(text == null ? $("#botInput").value : text).trim();
    if (!t) return;
    const inp = $("#botInput");
    if (inp) inp.value = "";
    try {
      B.ask(t);
    } catch (e) {
      B.pushMsg("bot", "⚠️ 处理出错：" + (e && e.message ? e.message : e), { plugin: "engine", level: "ticket" });
    }
    renderStream();
  }
  function choose(value, label) {
    try {
      // 诊断选项：用可读文案代替裸序号，交给引擎的模糊匹配解析（保证确定性匹配）
      if (value.indexOf("__opt__:") === 0) B.ask(label);
      else B.act(value, label);
    } catch (e) {
      B.pushMsg("bot", "⚠️ 动作执行失败：" + (e && e.message ? e.message : e), { plugin: "engine", level: "ticket" });
    }
    renderStream();
    if (typeof renderDashboardWidgets === "function") renderDashboardWidgets();
  }

  function bindAssistant() {
    const page = $("#page-assistant");
    if (!page || page.dataset.bound) return;
    page.dataset.bound = "1";

    page.addEventListener("click", (e) => {
      const opt = e.target.closest("[data-opt]");
      if (opt) { choose(opt.dataset.opt, opt.dataset.label || opt.textContent.trim()); return; }
      const demo = e.target.closest("[data-demo]");
      if (demo) { send(DEMO_QUERY[demo.dataset.demo] || "你好"); return; }
      const q = e.target.closest("[data-q]");
      if (q) { send(q.dataset.q); return; }
      const flow = e.target.closest("[data-flow]");
      if (flow) {
        const f = B.FLOWS.find((x) => x.id === flow.dataset.flow) || {};
        B.act("__flow__:" + flow.dataset.flow, "启动诊断流程：" + (f.name || flow.dataset.flow));
        renderStream();
        return;
      }
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        const id = pick.dataset.pick;
        const f = B.FAQS.find((x) => x.id === id);
        B.ask(f ? f.q : id);
        renderStream();
        return;
      }
    });
    $("#botSend").addEventListener("click", () => send());
    $("#botInput").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    $("#botNew").addEventListener("click", () => { B.newSession(); renderStream(); toast("已创建新会话"); });
    $("#botClose").addEventListener("click", () => { B.closeSession(); renderStream(); toast("会话已结束并归档到审计日志"); });
  }

  /* ============================================================
     3. 审计与回放
     ============================================================ */
  const aud = { q: "", plugin: "", result: "", range: "", selected: null, idx: 0, playing: false, timer: null, speed: 900 };

  function sessionResult(s) {
    const r = s.resolution || {};
    if (r.ticketId) return "ticket";
    if (r.level === "diagnose") return "diagnose";
    if (r.level === "self") return "self";
    return "open";
  }
  function resultLabel(k) {
    return ({ self: "自助解决", diagnose: "智能诊断", ticket: "转人工工单", open: "未产生结论" })[k] || k;
  }
  function filtered() {
    const now = Date.now();
    const rangeMs = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 }[aud.range] || 0;
    return B.store.sessions.filter((s) => {
      if (rangeMs && now - new Date(s.startedAt).getTime() > rangeMs) return false;
      if (aud.plugin && !(s.tools || []).some((t) => t.plugin === aud.plugin)) return false;
      if (aud.result && sessionResult(s) !== aud.result) return false;
      if (aud.q) {
        const q = aud.q.toLowerCase();
        const hay = [s.id, s.resolution && s.resolution.ticketId, s.user, s.channel]
          .concat((s.messages || []).map((m) => m.text))
          .concat((s.tools || []).map((t) => t.plugin + " " + t.action + " " + t.input))
          .join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  function renderAuditStats() {
    const el = $("#auditStats");
    if (!el) return;
    const st = B.stats();
    const all = B.store.sessions.length;
    const cards = [
      { label: "会话总数", value: num(st.sessions), sub: "全量留痕，可逐条回放", pct: 100, color: "" },
      { label: "自助解决率", value: pct1(st.deflectRate), sub: "未转人工会话占比（目标 ≥95%）", pct: st.deflectRate * 100, color: st.deflectRate >= 0.95 ? "ok" : "warn" },
      { label: "智能诊断会话", value: num(st.diagnose), sub: "走决策树 / RAG 定位", pct: all ? (st.diagnose / all) * 100 : 0, color: "" },
      { label: "转人工工单", value: num(st.ticket), sub: "已按 SLA 分级响应", pct: st.escalateRate * 100, color: "" },
      { label: "消息总条数", value: num(st.messages), sub: "含用户与助手全部回复", pct: 100, color: "" },
      { label: "工具调用次数", value: num(st.toolCalls), sub: "每次插件调用均有审计记录", pct: 100, color: "" },
      { label: "平均对话轮次", value: st.avgTurns.toFixed(1), sub: "每会话平均往返轮次", pct: 100, color: "" },
      { label: "用户已确认解决", value: num(st.resolved), sub: "点击「已解决」的会话", pct: all ? (st.resolved / all) * 100 : 0, color: "" },
    ];
    el.innerHTML = cards.map((c) =>
      '<div class="stat' + (c.color ? " " + c.color : "") + '"><div class="label">' + c.label + '</div>' +
      '<div class="value">' + c.value + '</div><div class="sub">' + c.sub + '</div>' +
      '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, c.pct)) + '%"></i></div></div>').join("");
  }

  function renderAuditTable() {
    const rows = filtered();
    const el = $("#audBody");
    const cnt = $("#auditCount");
    if (cnt) cnt.textContent = "共 " + rows.length + " 条（全库 " + B.store.sessions.length + "）";
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<tr><td colspan="8"><div class="empty">没有符合条件的会话</div></td></tr>'; return; }
    el.innerHTML = rows.map((s) => {
      const k = sessionResult(s);
      const dur = s.endedAt ? Math.max(1, Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000)) + " 分钟" : "进行中";
      const plugins = Array.from(new Set((s.tools || []).map((t) => t.plugin))).map((p) => pluginMeta(p).icon + pluginMeta(p).id).join(" ");
      return '<tr class="' + (aud.selected === s.id ? "row-active" : "") + '" data-sess="' + esc(s.id) + '">' +
        '<td><code>' + esc(s.id) + '</code></td>' +
        '<td>' + esc(B.fmtTime(s.startedAt)) + '</td>' +
        '<td>' + esc(s.user) + '<div class="bsub">' + esc(s.channel) + '</div></td>' +
        '<td class="num">' + (s.messages || []).length + '</td>' +
        '<td class="num">' + (s.tools || []).length + '</td>' +
        '<td><span class="bpill ' + levelMeta(k === "open" ? null : k).cls + '">' + resultLabel(k) + '</span>' +
          (s.resolution && s.resolution.ticketId ? ' <span class="tag">' + esc(s.resolution.ticketId) + '</span>' : "") + '</td>' +
        '<td>' + dur + '</td>' +
        '<td>' + esc(plugins) + '</td>' +
        '<td><button class="link-btn" data-replay="' + esc(s.id) + '">▶ 回放</button>' +
          '<button class="link-btn" data-json="' + esc(s.id) + '">导出</button>' +
          '<button class="link-btn danger" data-drop="' + esc(s.id) + '">删除</button></td></tr>';
    }).join("");
  }

  function selectedSession() {
    return B.store.sessions.find((s) => s.id === aud.selected) || null;
  }

  /** 保证当前选中项落在筛选结果内；否则回落到首条「有内容」的会话 */
  function ensureSelection() {
    const rows = filtered();
    if (aud.selected && rows.some((s) => s.id === aud.selected)) return;
    const pick = rows.find((s) => (s.messages || []).length || (s.tools || []).length) || rows[0] || null;
    aud.selected = pick ? pick.id : null;
    aud.idx = 0;
    stopPlay();
  }
  /** 筛选条件变化后统一刷新（表格 + 明细 + 回放，避免三者指向不同会话） */
  function refreshAudit() {
    ensureSelection();
    renderAuditTable();
    renderToolTable();
    renderReplay();
  }

  function eventsOf(s) {
    const order = { user: 0, tool: 1, bot: 2 };
    const evs = [];
    (s.messages || []).forEach((m, i) => evs.push({ kind: m.role === "user" ? "user" : "bot", at: m.at, seq: i, m: m }));
    (s.tools || []).forEach((t, i) => evs.push({ kind: "tool", at: t.at, seq: i, t: t }));
    evs.sort((a, b) => {
      const d = new Date(a.at) - new Date(b.at);
      return d !== 0 ? d : (order[a.kind] - order[b.kind]) || (a.seq - b.seq);
    });
    return evs;
  }

  function renderToolTable() {
    const s = selectedSession();
    const el = $("#audToolBody");
    const cnt = $("#audToolCount");
    if (cnt) cnt.textContent = s ? "会话 " + s.id + " · " + (s.tools || []).length + " 次调用" : "未选择会话";
    if (!el) return;
    if (!s) { el.innerHTML = '<tr><td colspan="7"><div class="empty">请在上方选择一个会话</div></td></tr>'; return; }
    const tools = s.tools || [];
    if (!tools.length) { el.innerHTML = '<tr><td colspan="7"><div class="empty">该会话没有工具调用记录</div></td></tr>'; return; }
    el.innerHTML = tools.map((t, i) => {
      const pm = pluginMeta(t.plugin);
      return '<tr>' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td>' + esc(B.fmtTime(t.at)) + '</td>' +
        '<td><span class="tag">' + esc(pm.icon + " " + pm.name) + '</span></td>' +
        '<td><code>' + esc(t.action) + '</code></td>' +
        '<td><code class="bcode">' + esc(t.input) + '</code></td>' +
        '<td><code class="bcode">' + esc(t.output) + '</code></td>' +
        '<td>' + (t.status === "ok" ? '<span class="pill p-resolved">成功</span>' : '<span class="pill p-open">失败</span>') +
          ' <span class="tag ghost">' + (t.ms || 0) + ' ms</span></td></tr>';
    }).join("");
  }

  function renderReplay() {
    const s = selectedSession();
    const tl = $("#audTimeline");
    const idEl = $("#audReplayId");
    if (idEl) idEl.textContent = s ? "· 会话 " + s.id : "";
    if (!tl) return;
    if (!s) { tl.innerHTML = '<div class="empty">选择会话后即可回放完整对话与工具调用链路</div>'; return; }
    const evs = eventsOf(s);
    if (!evs.length) { tl.innerHTML = '<div class="empty">该会话无内容</div>'; return; }

    const r = s.resolution || {};
    const head = '<div class="aur-head">' +
      '<span class="tag">共 ' + evs.length + ' 个事件</span>' +
      '<span class="tag">消息 ' + (s.messages || []).length + '</span>' +
      '<span class="tag">工具调用 ' + (s.tools || []).length + '</span>' +
      '<span class="bpill ' + levelMeta(r.level).cls + '">' + esc(levelMeta(r.level).t) + '</span>' +
      (r.ticketId ? '<span class="tag">' + esc(r.ticketId) + '</span>' : '<span class="tag ghost">未转人工</span>') +
      '<span class="tag ghost">' + esc(B.fmtTime(s.startedAt)) + " → " + esc(s.endedAt ? B.fmtTime(s.endedAt) : "进行中") + '</span>' +
      "</div>";

    const list = '<div class="aur-list">' + evs.map((e, i) => {
      const st = i < aud.idx ? "done" : (i === aud.idx ? "current" : "pending");
      const time = esc(B.fmtTime(e.at));
      if (e.kind === "user") {
        return '<div class="aur-ev ' + st + '"><span class="aur-i">' + (i + 1) + '</span>' +
          '<span class="aur-type tu">用户</span><span class="aur-time">' + time + '</span>' +
          '<div class="aur-body">' + rich(e.m.text) + "</div></div>";
      }
      if (e.kind === "bot") {
        const pm = pluginMeta(e.m.plugin);
        return '<div class="aur-ev ' + st + '"><span class="aur-i">' + (i + 1) + '</span>' +
          '<span class="aur-type tb">助手</span><span class="aur-time">' + time + '</span>' +
          '<div class="aur-body"><span class="tag ghost">' + esc(pm.icon + " " + (e.m.pluginName || pm.name)) + "</span>" +
          '<span class="bpill ' + levelMeta(e.m.level).cls + '">' + levelMeta(e.m.level).t + "</span>" +
          (e.m.confidence ? '<span class="tag ghost">匹配度 ' + pct0(e.m.confidence) + "</span>" : "") +
          '<div class="aur-text">' + rich(e.m.text) + "</div>" +
          // 回放需完整还原当时下发的卡片内容，否则 FAQ 答案等关键信息会缺失
          (e.m.cards && e.m.cards.length ? '<div class="aur-cards">' + renderCards(e.m.cards) + "</div>" : "") +
          (e.m.options && e.m.options.length ? '<div class="aur-opts">当时给出的选项：' +
            e.m.options.map((o) => '<span class="tag ghost">' + esc(o.label) + "</span>").join("") + "</div>" : "") +
          "</div></div>";
      }
      const pm = pluginMeta(e.t.plugin);
      return '<div class="aur-ev tool ' + st + '"><span class="aur-i">' + (i + 1) + '</span>' +
        '<span class="aur-type tt">工具</span><span class="aur-time">' + time + '</span>' +
        '<div class="aur-body"><code>' + esc(pm.icon + " " + e.t.plugin + "." + e.t.action) + "</code>" +
        '<span class="tag ghost">' + (e.t.ms || 0) + " ms</span>" +
        '<span class="' + (e.t.status === "ok" ? "sla-ok" : "sla-breach") + '">' + (e.t.status === "ok" ? "成功" : "失败") + "</span>" +
        '<div class="aur-io"><span>IN</span><code>' + esc(e.t.input) + "</code></div>" +
        '<div class="aur-io"><span>OUT</span><code>' + esc(e.t.output) + "</code></div></div></div>";
    }).join("") + "</div>";

    const bar = '<div class="aur-prog"><i style="width:' + Math.round((aud.idx / evs.length) * 100) + '%"></i></div>' +
      '<div class="aur-prog-t">回放进度 ' + aud.idx + " / " + evs.length + "</div>";

    tl.innerHTML = head + bar + list;
  }

  function stopPlay() {
    aud.playing = false;
    if (aud.timer) { clearInterval(aud.timer); aud.timer = null; }
    const btn = $("#audPlay");
    if (btn) btn.textContent = "▶ 播放";
  }
  function stepPlay() {
    const s = selectedSession();
    if (!s) return;
    const total = eventsOf(s).length;
    if (aud.idx >= total) { stopPlay(); return; }
    aud.idx++;
    renderReplay();
    if (aud.idx >= total) stopPlay();
  }
  function togglePlay() {
    if (aud.playing) { stopPlay(); return; }
    const s = selectedSession();
    if (!s) { toast("请先选择会话"); return; }
    if (aud.idx >= eventsOf(s).length) aud.idx = 0;
    aud.playing = true;
    const btn = $("#audPlay");
    if (btn) btn.textContent = "⏸ 暂停";
    aud.timer = setInterval(stepPlay, aud.speed);
    stepPlay();
  }

  function exportAuditXlsx() {
    if (!window.XLSX) { toast("导出组件未就绪"); return; }
    const rows = filtered();
    const wb = XLSX.utils.book_new();
    const sessSheet = XLSX.utils.json_to_sheet(rows.map((s) => ({
      会话编号: s.id, 开始时间: B.fmtTime(s.startedAt), 结束时间: s.endedAt ? B.fmtTime(s.endedAt) : "进行中",
      消息数: (s.messages || []).length, 工具调用数: (s.tools || []).length,
      服务层级: resultLabel(sessionResult(s)), 关联工单: (s.resolution || {}).ticketId || "",
      用户确认解决: (s.resolution || {}).resolved ? "是" : "否",
      首条问题: ((s.messages || []).find((m) => m.role === "user") || {}).text || "",
    })));
    XLSX.utils.book_append_sheet(wb, sessSheet, "会话审计");
    const toolRows = [];
    rows.forEach((s) => (s.tools || []).forEach((t) => toolRows.push({
      会话编号: s.id, 时间: B.fmtTime(t.at), 插件: t.plugin, 动作: t.action,
      输入: t.input, 输出: t.output, 状态: t.status, 耗时ms: t.ms,
    })));
    const toolSheet = XLSX.utils.json_to_sheet(toolRows.length ? toolRows : [{ 说明: "无工具调用记录" }]);
    XLSX.utils.book_append_sheet(wb, toolSheet, "工具调用明细");
    XLSX.writeFile(wb, "IT智能助手-审计日志-" + dateStamp() + ".xlsx");
    toast("已导出 " + rows.length + " 个会话 / " + toolRows.length + " 条工具调用");
  }

  function bindAudit() {
    const page = $("#page-audit");
    if (!page || page.dataset.bound) return;
    page.dataset.bound = "1";

    $("#audSearch").addEventListener("input", (e) => { aud.q = e.target.value.trim(); refreshAudit(); });
    $("#audPlugin").addEventListener("change", (e) => { aud.plugin = e.target.value; refreshAudit(); });
    $("#audResult").addEventListener("change", (e) => { aud.result = e.target.value; refreshAudit(); });
    $("#audRange").addEventListener("change", (e) => { aud.range = e.target.value; refreshAudit(); });
    $("#audExportXlsx").addEventListener("click", exportAuditXlsx);
    $("#audExportJson").addEventListener("click", () => {
      const rows = filtered();
      download("IT智能助手-审计原始数据-" + dateStamp() + ".json", JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, sessions: rows }, null, 2), "application/json");
      toast("已导出原始审计数据");
    });
    $("#audClear").addEventListener("click", () => {
      if (!confirm("确定清空全部助手审计数据（会话、消息与工具调用记录）？此操作不可撤销。")) return;
      B.store.sessions = [];
      B.store.currentId = null;
      B.save();
      aud.selected = null; aud.idx = 0; stopPlay();
      renderAudit();
      toast("审计数据已清空，可重新开始会话");
    });
    $("#audPlay").addEventListener("click", togglePlay);
    $("#audStepBtn").addEventListener("click", () => { stopPlay(); stepPlay(); });
    $("#audReset").addEventListener("click", () => { stopPlay(); aud.idx = 0; renderReplay(); });
    $("#audSpeed").addEventListener("change", (e) => {
      aud.speed = parseInt(e.target.value, 10) || 900;
      if (aud.playing) { clearInterval(aud.timer); aud.timer = setInterval(stepPlay, aud.speed); }
    });

    page.addEventListener("click", (e) => {
      const rp = e.target.closest("[data-replay]");
      if (rp) {
        aud.selected = rp.dataset.replay; aud.idx = 0; stopPlay();
        renderAuditTable(); renderToolTable(); renderReplay();
        toast("已载入会话 " + aud.selected + "，点击「播放」逐步回放");
        return;
      }
      const jn = e.target.closest("[data-json]");
      if (jn) {
        const s = B.store.sessions.find((x) => x.id === jn.dataset.json);
        download("会话-" + s.id + ".json", JSON.stringify(s, null, 2), "application/json");
        return;
      }
      const dp = e.target.closest("[data-drop]");
      if (dp) {
        if (!confirm("确定删除该会话的审计记录？")) return;
        B.store.sessions = B.store.sessions.filter((x) => x.id !== dp.dataset.drop);
        if (aud.selected === dp.dataset.drop) { aud.selected = null; aud.idx = 0; stopPlay(); }
        B.save();
        renderAudit();
        return;
      }
      const row = e.target.closest("[data-sess]");
      if (row) {
        aud.selected = row.dataset.sess; aud.idx = 0; stopPlay();
        renderAuditTable(); renderToolTable(); renderReplay();
      }
    });

    // 插件筛选项
    const sel = $("#audPlugin");
    if (sel) sel.innerHTML = '<option value="">全部插件</option>' +
      B.PLUGIN_META.concat(PLUGIN_EXTRA).map((p) => '<option value="' + esc(p.id) + '">' + esc(p.icon + " " + p.name) + "</option>").join("");
  }

  function renderAudit() {
    B.ensureInit();
    ensureSelection();
    renderAuditStats();
    renderAuditTable();
    renderToolTable();
    renderReplay();
  }

  /* ============================================================
     4. 数据看板挂件
     ============================================================ */
  let botChart = null;
  function renderDashboardWidgets() {
    B.ensureInit();
    const st = B.stats();

    const g = $("#botDashStats");
    if (g) {
      const cards = [
        { l: "自助解决率", v: pct1(st.deflectRate), s: "目标 ≥95%", p: st.deflectRate * 100, ok: st.deflectRate >= 0.95 },
        { l: "助手会话", v: num(st.sessions), s: "近 120 条留痕", p: 100 },
        { l: "工具调用", v: num(st.toolCalls), s: "全部可审计", p: 100 },
        { l: "转人工率", v: pct1(st.escalateRate), s: "按 SLA 分级开单", p: st.escalateRate * 100 },
      ];
      g.innerHTML = cards.map((c) =>
        '<div class="stat' + (c.ok ? " ok" : "") + '"><div class="label">' + c.l + '</div>' +
        '<div class="value">' + c.v + '</div><div class="sub">' + c.s + '</div>' +
        '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, c.p)) + '%"></i></div></div>').join("");
    }

    const cv = $("#botChartPlugin");
    if (cv && window.Chart) {
      const labels = [], data = [];
      B.PLUGIN_META.concat(PLUGIN_EXTRA).forEach((p) => {
        labels.push(p.icon + p.name);
        data.push((st.pluginUse || {})[p.id] || 0);
      });
      if (botChart) { botChart.destroy(); botChart = null; }
      botChart = new Chart(cv, {
        type: "bar",
        data: { labels: labels, datasets: [{ label: "调用次数", data: data, backgroundColor: "#2563eb", hoverBackgroundColor: "#1d4ed8", borderRadius: 6, maxBarThickness: 42 }] },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: "y",
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => " " + c.parsed.x + " 次" } } },
          scales: { x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#eef2f7" } }, y: { grid: { display: false } } },
        },
      });
    }

    const rc = $("#botRecent");
    if (rc) {
      const list = B.store.sessions.slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 5);
      rc.innerHTML = list.length ? '<div class="brecent">' + list.map((s) => {
        const k = sessionResult(s);
        const first = ((s.messages || []).find((m) => m.role === "user") || {}).text || "（无提问）";
        return '<div class="brecent-row" data-goto="' + esc(s.id) + '">' +
          '<span class="bpill ' + levelMeta(k === "open" ? null : k).cls + '">' + resultLabel(k) + '</span>' +
          '<span class="brecent-q">' + esc(first.slice(0, 26)) + '</span>' +
          '<span class="tag ghost">' + esc(B.fmtTime(s.startedAt).slice(5, 16)) + "</span></div>";
      }).join("") + "</div>" + '<button class="btn sm" id="botGotoAudit" style="margin-top:10px">前往审计与回放 →</button>'
        : '<div class="empty">暂无会话记录</div>';
      const go = $("#botGotoAudit");
      if (go) go.onclick = () => window.OpsDesk.switchPage("audit");
      $$("[data-goto]", rc).forEach((r) => {
        r.onclick = () => { aud.selected = r.dataset.goto; aud.idx = 0; window.OpsDesk.switchPage("audit"); };
      });
    }

    renderEvalBox();
  }

  function renderEvalBox() {
    const box = $("#botEvalBox");
    if (!box) return;
    const ev = B.store.lastEval;
    const head = '<div class="beval-h"><b>混合检索评测（' + B.EVAL_SET.length + ' 条标注样本）</b>' +
      '<button class="btn sm primary" id="botRunEval">▶ 运行评测</button></div>';
    const body = ev
      ? '<div class="beval-grid">' +
        '<div><span>Top-1 命中率</span><b>' + pct1(ev.top1Hit) + '</b></div>' +
        '<div><span>Top-3 命中率</span><b>' + pct1(ev.top3Hit) + '</b></div>' +
        '<div class="' + (ev.selfRate >= 0.95 ? "ok" : "warn") + '"><span>自助解决率</span><b>' + pct1(ev.selfRate) + '</b></div>' +
        '<div><span>平均融合分</span><b>' + ev.avgScore.toFixed(3) + '</b></div>' +
        '<div><span>样本数</span><b>' + ev.total + '</b></div>' +
        '<div><span>评测时间</span><b>' + esc(B.fmtTime(ev.at)) + '</b></div>' +
        '</div><div class="beval-tip">' +
        (ev.selfRate >= 0.95
          ? "✅ 已达到并超过 FAQ 自助解决率 95% 的目标。"
          : "⚠️ 低于 95% 目标，可检查 bot-data.js 中的同义词表与 FAQ 问法变体。") +
        "</div>"
      : '<div class="empty" style="padding:18px">尚未评测。点击右上角运行，将回归 ' + B.EVAL_SET.length + ' 条标注样本并写入审计。</div>';
    box.innerHTML = head + body;
    const btn = $("#botRunEval");
    if (btn) btn.onclick = () => {
      btn.disabled = true; btn.textContent = "评测中…";
      setTimeout(() => {
        const r = B.evaluate();
        renderEvalBox();
        renderDashboardWidgets();
        renderSide();
        toast("评测完成：Top-1 " + pct1(r.top1Hit) + " / 自助解决率 " + pct1(r.selfRate));
      }, 30);
    };
  }

  /* ============================================================
     5. 挂载到引擎并启动
     ============================================================ */
  B.render = render;
  B.renderAudit = renderAudit;
  B.renderDashboardWidgets = renderDashboardWidgets;
  B.renderStream = renderStream;
  B.ui = { esc: esc, rich: rich, renderCard: renderCard, choose: choose, send: send, aud: aud, renderSide: renderSide };

  function render() {
    B.ensureInit();
    bindAssistant();
    renderSide();
    renderStream();
  }

  function boot() {
    B.ensureInit();
    bindAssistant();
    bindAudit();
    renderDashboardWidgets();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
