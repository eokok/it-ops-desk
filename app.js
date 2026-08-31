/* ============================================================
   IT 运维工单管理系统 — 前端逻辑（纯前端 + localStorage）
   功能：Incident / CMDB / 数据看板 / 知识库 / 审批流转 / SLA / Excel 导出
   ============================================================ */
(() => {
  "use strict";

  const LS_KEY = "opsdesk.db.v2";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s,  r = document) => Array.from(r.querySelectorAll(s));

  const STATUS = {
    open:        { label: "新建",   cls: "p-open" },
    in_progress: { label: "处理中", cls: "p-in_progress" },
    resolved:    { label: "已解决", cls: "p-resolved" },
    closed:      { label: "已关闭", cls: "p-closed" },
  };
  const PRIORITY = {
    P1: { label: "P1", cls: "pr1", color: "#dc2626" },
    P2: { label: "P2", cls: "pr2", color: "#f97316" },
    P3: { label: "P3", cls: "pr3", color: "#f59e0b" },
    P4: { label: "P4", cls: "pr4", color: "#16a34a" },
  };
  const APPROVAL = {
    none:     { label: "无需审批", cls: "ap-none" },
    pending:  { label: "待审批",   cls: "ap-pending" },
    approved: { label: "已批准",   cls: "ap-approved" },
    rejected: { label: "已驳回",   cls: "ap-rejected" },
  };
  const SLA_HOURS = { P1: 4, P2: 8, P3: 24, P4: 72 }; // 目标解决时限（小时）
  const CI_TYPES = ["服务器", "网络设备", "应用系统", "数据库", "人员", "其他"];
  const CI_STATUS = ["运行中", "停用", "维护中"];
  const CATEGORIES = ["网络", "服务器", "数据库", "应用", "终端", "安全", "其他"];
  const KB_CATS = ["网络", "服务器", "数据库", "应用", "安全", "终端", "其他"];

  // 服务请求 (Request)
  const REQ_STATUS = {
    draft:     { label: "草稿",   cls: "p-closed" },
    submitted: { label: "待审批", cls: "ap-pending" },
    approved:  { label: "已批准", cls: "ap-approved" },
    rejected:  { label: "已拒绝", cls: "ap-rejected" },
    done:      { label: "已完成", cls: "p-resolved" },
  };
  const REQ_TYPES = ["权限申请", "设备采购", "其他"];

  // 变更 (Change)
  const CHG_STATUS = {
    draft:       { label: "草稿",     cls: "p-closed" },
    submitted:   { label: "待审批",   cls: "ap-pending" },
    approved:    { label: "已批准",   cls: "ap-approved" },
    in_progress: { label: "实施中",   cls: "p-in_progress" },
    done:        { label: "已完成",   cls: "p-resolved" },
    rolled_back: { label: "已回滚",   cls: "p-open" },
  };
  const CHG_TYPES = ["交换机变更", "服务器升级", "数据库变更", "其他"];
  const CHG_RISK = ["高", "中", "低"];

  let state = { incidents: [], cis: [], kb: [], requests: [], changes: [] };

  /* ---------- 工具 ---------- */
  const uid = (p) => p + String(Math.floor(Math.random() * 1e6)).padStart(4, "0");
  const nowISO = () => new Date().toISOString();
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtDay(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`;
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    const h = Math.floor(m / 60), mm = m % 60;
    if (h >= 24) return `${Math.floor(h / 24)}天${h % 24}时`;
    if (h > 0) return `${h}时${mm}分`;
    return `${mm}分`;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        state = JSON.parse(raw);
        state.requests = state.requests || [];
        state.changes = state.changes || [];
        return true;
      }
    } catch (e) { console.warn("load failed", e); }
    return false;
  }
  function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------- SLA ---------- */
  function slaDeadline(inc) {
    return new Date(new Date(inc.createdAt).getTime() + SLA_HOURS[inc.priority] * 3600 * 1000);
  }
  function slaInfo(inc) {
    if (inc.status === "resolved" || inc.status === "closed") {
      const used = new Date(inc.resolvedAt) - new Date(inc.createdAt);
      const within = used <= SLA_HOURS[inc.priority] * 3600 * 1000;
      return { text: "已闭环 " + fmtDur(used), cls: "sla-done", breached: false, done: true, within };
    }
    const diff = slaDeadline(inc) - Date.now();
    if (diff <= 0) return { text: "超时 " + fmtDur(-diff), cls: "sla-breach", breached: true };
    return { text: "剩余 " + fmtDur(diff), cls: "sla-ok", breached: false };
  }

  /* ---------- 种子数据 ---------- */
  function seed() {
    const today = new Date();
    const daysAgo = (n) => new Date(today.getTime() - n * 86400000).toISOString();
    const cis = [
      { id: "CI1001", name: "Web服务器-W01", type: "服务器", ip: "10.0.1.11", owner: "张伟", location: "机房A", status: "运行中", desc: "生产环境 Web 节点" },
      { id: "CI1002", name: "核心交换机-SW1", type: "网络设备", ip: "10.0.0.1", owner: "李强", location: "机房A", status: "运行中", desc: "核心三层交换机" },
      { id: "CI1003", name: "订单服务-OrderSvc", type: "应用系统", ip: "10.0.2.20", owner: "王芳", location: "K8s集群", status: "运行中", desc: "订单核心微服务" },
      { id: "CI1004", name: "主数据库-DB1", type: "数据库", ip: "10.0.3.5", owner: "赵磊", location: "机房B", status: "维护中", desc: "MySQL 主库" },
      { id: "CI1005", name: "堡垒机-Jump", type: "服务器", ip: "10.0.0.99", owner: "张伟", location: "DMZ", status: "运行中", desc: "运维跳板机" },
    ];
    const incidents = [
      { id: "INC1001", title: "订单服务响应超时", desc: "订单接口平均响应时间超过 5s，影响下单。", status: "in_progress", priority: "P1", category: "应用", assignee: "王芳", requester: "客服组", ciId: "CI1003", approval: "pending", approver: "", approvalNote: "", approvalLog: [], createdAt: daysAgo(1), updatedAt: daysAgo(0), resolvedAt: null },
      { id: "INC1002", title: "核心交换机端口丢包", desc: "SW1 上联端口存在丢包，部分网段抖动。", status: "open", priority: "P2", category: "网络", assignee: "李强", requester: "运维组", ciId: "CI1002", approval: "none", approvalNote: "", approvalLog: [], createdAt: daysAgo(2), updatedAt: daysAgo(1), resolvedAt: null },
      { id: "INC1003", title: "DB1 磁盘使用率 92%", desc: "主库磁盘逼近阈值，需扩容或清理。", status: "resolved", priority: "P1", category: "数据库", assignee: "赵磊", requester: "监控告警", ciId: "CI1004", approval: "approved", approver: "孙主管", approvalNote: "已确认扩容方案", approvalLog: [{action:"提交审批",by:"赵磊",at:daysAgo(2)},{action:"批准",by:"孙主管",at:daysAgo(2),note:"已确认扩容方案"}], createdAt: daysAgo(3), updatedAt: daysAgo(1), resolvedAt: daysAgo(1) },
      { id: "INC1004", title: "员工笔记本无法联网", desc: "研发同学 Wi-Fi 频繁掉线。", status: "closed", priority: "P4", category: "终端", assignee: "张伟", requester: "研发部", ciId: null, approval: "approved", approver: "孙主管", approvalNote: "已处理", approvalLog: [], createdAt: daysAgo(5), updatedAt: daysAgo(4), resolvedAt: daysAgo(4) },
      { id: "INC1005", title: "堡垒机登录异常", desc: "Jump 偶发拒绝 SSH 连接。", status: "in_progress", priority: "P3", category: "安全", assignee: "张伟", requester: "运维组", ciId: "CI1005", approval: "none", approvalNote: "", approvalLog: [], createdAt: daysAgo(1), updatedAt: daysAgo(0), resolvedAt: null },
      { id: "INC1006", title: "Web 服务器 CPU 飙高", desc: "W01 CPU 持续 95%+，疑似慢 SQL。", status: "open", priority: "P2", category: "服务器", assignee: "王芳", requester: "监控告警", ciId: "CI1001", approval: "none", approvalNote: "", approvalLog: [], createdAt: daysAgo(0), updatedAt: daysAgo(0), resolvedAt: null },
    ];
    const kb = [
      { id: "KB1001", title: "订单服务响应慢排查手册", category: "应用", tags: ["性能","慢SQL","OrderSvc"], ciId: "CI1003", content: "1. 登录 K8s 查看 Pod 资源；\n2. 检查 MySQL 慢查询日志；\n3. 定位热点 SQL 并加索引；\n4. 必要时扩容副本。", views: 12, createdAt: daysAgo(10), updatedAt: daysAgo(2) },
      { id: "KB1002", title: "交换机端口丢包处理流程", category: "网络", tags: ["丢包","SW1","链路"], ciId:  "CI1002", content: "1. 确认端口光模块与线缆；\n2. 收集接口计数器；\n3. 若存在 CRC 错误则更换端口；\n4. 升级固件。", views: 8, createdAt: daysAgo(8), updatedAt: daysAgo(3) },
      { id: "KB1003", title: "数据库磁盘扩容步骤", category: "数据库", tags: ["磁盘","扩容","MySQL"], ciId: "CI1004", content: "1. 评估增长趋势；\n2. 在线扩展 LVM；\n3. 扩容文件系统；\n4. 清理历史归档。", views: 5, createdAt: daysAgo(6), updatedAt: daysAgo(6) },
    ];
    const requests = [
      { id: "REQ1001", title: "研发部申请生产库只读账号", type: "权限申请", status: "submitted", priority: "P3", requester: "研发部", handler: "赵磊", desc: "需要查询生产订单库用于排障。", items: "只读账号 x1，限定 IP 白名单", approval: "pending", approver: "", approvalNote: "", approvalLog: [], createdAt: daysAgo(1), updatedAt: daysAgo(0), doneAt: null },
      { id: "REQ1002", title: "采购 10 台新服务器", type: "设备采购", status: "approved", priority: "P2", requester: "运维组", handler: "张伟", desc: "扩容计算资源，支撑双十一。", items: "机架服务器 x10 / 64C256G / 2T SSD", approval: "approved", approver: "孙主管", approvalNote: "同意采购", approvalLog: [{action:"提交审批",by:"张伟",at:daysAgo(2)},{action:"批准",by:"孙主管",at:daysAgo(1),note:"同意采购"}], createdAt: daysAgo(2), updatedAt: daysAgo(1), doneAt: null },
      { id: "REQ1003", title: "新员工 VPN 权限申请", type: "权限申请", status: "done", priority: "P4", requester: "人事部", handler: "张伟", desc: "新入职同事需要 VPN 访问内网。", items: "VPN 账号 x1", approval: "approved", approver: "孙主管", approvalNote: "已开通", approvalLog: [], createdAt: daysAgo(4), updatedAt: daysAgo(3), doneAt: daysAgo(3) },
    ];
    const changes = [
      { id: "CHG1001", title: "核心交换机 SW1 固件升级", type: "交换机变更", risk: "高", status: "submitted", priority: "P1", owner: "李强", scheduledAt: daysAgo(-2), relatedCis: ["CI1002"], desc: "升级至稳定版本修复已知漏洞。", rollback: "回退至上一版本固件。", approval: "pending", approver: "", approvalNote: "", approvalLog: [], createdAt: daysAgo(1), updatedAt: daysAgo(0) },
      { id: "CHG1002", title: "订单服务扩容至 6 副本", type: "服务器升级", risk: "中", status: "approved", priority: "P2", owner: "王芳", scheduledAt: daysAgo(1), relatedCis: ["CI1001","CI1003"], desc: "大促前扩容以应对峰值。", rollback: "缩容回 4 副本。", approval: "approved", approver: "孙主管", approvalNote: "同意", approvalLog: [{action:"提交审批",by:"王芳",at:daysAgo(1)},{action:"批准",by:"孙主管",at:daysAgo(0),note:"同意"}], createdAt: daysAgo(1), updatedAt: daysAgo(0) },
      { id: "CHG1003", title: "DB1 内存升级", type: "服务器升级", risk: "高", status: "done", priority: "P2", owner: "赵磊", scheduledAt: daysAgo(3), relatedCis: ["CI1004"], desc: "内存 128G→256G。", rollback: "恢复原内存配置。", approval: "approved", approver: "孙主管", approvalNote: "", approvalLog: [], createdAt: daysAgo(4), updatedAt: daysAgo(3) },
    ];
    state = { incidents, cis, kb, requests, changes };
    save();
  }

  /* ---------- 导航 ---------- */
  function switchPage(page) {
    $$(".page").forEach(p => p.classList.remove("active"));
    $("#page-" + page).classList.add("active");
    $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.page === page));
    const titles = { dashboard: "数据看板", incidents: "事件管理 (Incident)", cmdb: "配置管理 (CMDB)", kb: "知识库 (KB)", requests: "服务请求 (Request)", changes: "变更管理 (Change)" };
    $("#pageTitle").textContent = titles[page] || "";
    $("#sidebar").classList.remove("open");
    if (page === "dashboard") renderDashboard();
    if (page === "incidents") renderIncidents();
    if (page === "cmdb") renderCMDB();
    if (page === "kb") renderKB();
    if (page === "requests") renderRequests();
    if (page === "changes") renderChanges();
  }

  /* ---------- Dashboard ---------- */
  let charts = {};
  function destroyCharts() { Object.values(charts).forEach(c => c && c.destroy()); charts = {}; }
  function renderDashboard() {
    destroyCharts();
    const inc = state.incidents;
    const total = inc.length;
    const open = inc.filter(i => i.status === "open").length;
    const inProg = inc.filter(i => i.status === "in_progress").length;
    const resolved = inc.filter(i => i.status === "resolved" || i.status === "closed").length;
    const breached = inc.filter(i => slaInfo(i).breached).length;
    const slaHit = total ? Math.round(((total - breached) / total) * 100) : 0;

    const reqPending = state.requests.filter(r => r.status === "submitted" || r.status === "draft").length;
    const chgPending = state.changes.filter(c => c.status === "submitted" || c.status === "approved" || c.status === "in_progress").length;
    const stats = [
      { label: "工单总数", value: total, sub: "所有事件", pct: 100 },
      { label: "待处理", value: open + inProg, sub: `新建 ${open} · 处理中 ${inProg}`, pct: total ? ((open + inProg) / total) * 100 : 0 },
      { label: "已解决", value: resolved, sub: "已解决+已关闭", pct: slaHit },
      { label: "SLA 逾期", value: breached, sub: `达标率 ${slaHit}%`, pct: 100 - slaHit },
      { label: "请求待办", value: state.requests.length, sub: `待审批/草稿 ${reqPending}`, pct: state.requests.length ? (reqPending / state.requests.length) * 100 : 0 },
      { label: "变更进行中", value: state.changes.length, sub: `待审批/实施 ${chgPending}`, pct: state.changes.length ? (chgPending / state.changes.length) * 100 : 0 },
    ];
    $("#statGrid").innerHTML = stats.map(s => `
      <div class="stat">
        <div class="label">${s.label}</div>
        <div class="value">${s.value}</div>
        <div class="sub">${s.sub}</div>
        <div class="bar"><i style="width:${Math.max(0, s.pct)}%"></i></div>
      </div>`).join("");

    // SLA 告警横幅
    const bl = inc.filter(i => slaInfo(i).breached);
    $("#slaAlert").innerHTML = bl.length
      ? `<div class="alert-bar">⚠️ 当前有 ${bl.length} 个工单已超出 SLA 时限，请优先处理：${bl.map(i => i.id).join("、")}</div>`
      : "";

    $("#slaList").innerHTML = bl.length
      ? `<table style="width:100%"><thead><tr><th>编号</th><th>标题</th><th>优先级</th><th>负责人</th><th>超时</th></tr></thead><tbody>${bl.map(i => `
        <tr><td>${i.id}</td><td>${escapeHtml(i.title)}</td><td><span class="pill ${PRIORITY[i.priority].cls}">${i.priority}</span></td><td>${i.assignee}</td><td class="sla-breach">${slaInfo(i).text}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">🎉 暂无 SLA 逾期工单</div>`;

    const stCount = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
    inc.forEach(i => stCount[i.status]++);
    charts.status = new Chart($("#chartStatus"), {
      type: "doughnut",
      data: { labels: Object.values(STATUS).map(s => s.label), datasets: [{ data: Object.values(stCount), backgroundColor: ["#dc2626", "#2563eb", "#16a34a", "#94a3b8"] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
    });

    const prCount = { P1: 0, P2: 0, P3: 0, P4: 0 };
    inc.forEach(i => prCount[i.priority]++);
    charts.priority = new Chart($("#chartPriority"), {
      type: "bar",
      data: { labels: ["P1", "P2", "P3", "P4"], datasets: [{ label: "数量", data: Object.values(prCount), backgroundColor: ["#dc2626", "#f97316", "#f59e0b", "#16a34a"] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });

    const labels = [], createdArr = [], resolvedArr = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000);
      const key = day.toDateString();
      labels.push(fmtDay(day.toISOString()));
      createdArr.push(inc.filter(x => new Date(x.createdAt).toDateString() === key).length);
      resolvedArr.push(inc.filter(x => x.resolvedAt && new Date(x.resolvedAt).toDateString() === key).length);
    }
    charts.trend = new Chart($("#chartTrend"), {
      type: "line",
      data: { labels, datasets: [
        { label: "新建", data: createdArr, borderColor: "#2563eb", backgroundColor: "rgba(37,99, 235,.12)", fill: true, tension: .3 },
        { label: "解决", data: resolvedArr, borderColor: "#16a34a", backgroundColor: "rgba(22,163,74,.12)", fill: true, tension: .3 },
      ]},
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, scales: { y: { beginAtZero: true } } }
    });

    const catCount = {};
    inc.forEach(i => catCount[i.category] = (catCount[i.category] || 0) + 1);
    charts.category = new Chart($("#chartCategory"), {
      type: "pie",
      data: { labels: Object.keys(catCount), datasets: [{ data: Object.values(catCount), backgroundColor: ["#2563eb", "#0ea5e9", "#f97316", "#16a34a", "#a855f7", "#94a3b8"] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } }
    });
  }

  /* ---------- Incidents ---------- */
  function ciName(id) { const c = state.cis.find(x => x.id === id); return c ? c.name : "—"; }
  function renderIncidents() {
    const q = ($("#incSearch").value || "").toLowerCase();
    const fStatus = $("#incFilterStatus").value;
    const fPri = $("#incFilterPriority").value;
    const sort = $("#incSort").value;

    let list = state.incidents.filter(i => {
      if (fStatus && i.status !== fStatus) return false;
      if (fPri && i.priority !== fPri) return false;
      if (q) { const hay = (i.id + i.title + i.assignee + ciName(i.ciId)).toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
    const prRank = { P1: 0, P2: 1, P3: 2, P4: 3 };
    list.sort((a, b) => {
      if (sort === "priority_desc") return prRank[a.priority] - prRank[b.priority];
      if (sort === "updated_desc") return new Date(b.updatedAt) - new Date(a.updatedAt);
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    $("#incCount").textContent = `共 ${list.length} 条`;
    $("#incBody").innerHTML = list.map(i => {
      const s = slaInfo(i);
      const ap = APPROVAL[i.approval];
      return `<tr>
        <td class="num">${i.id}</td>
        <td><a class="link-btn" data-edit-inc="${i.id}">${escapeHtml(i.title)}</a></td>
        <td><span class="pill ${STATUS[i.status].cls}">${STATUS[i.status].label}</span></td>
        <td><span class="pill ${PRIORITY[i.priority].cls}">${i.priority}</span></td>
        <td class="${s.cls}">${s.text}</td>
        <td><span class="pill ${ap.cls}">${ap.label}</span></td>
        <td>${i.category}</td>
        <td>${i.assignee}</td>
        <td>${i.ciId ? `<span class="link-btn" data-goto-ci="${i.ciId}">${escapeHtml(ciName(i.ciId))}</span>` : "—"}</td>
        <td class="num">${fmtDate(i.createdAt)}</td>
        <td>
          <button class="link-btn" data-edit-inc="${i.id}">编辑</button>
          <button class="link-btn" data-del-inc="${i.id}">删除</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="11" class="empty">暂无工单</td></tr>`;
  }

  /* ---------- CMDB ---------- */
  function ciIncidentCount(id) { return state.incidents.filter(i => i.ciId === id).length; }
  function renderCMDB() {
    const q = ($("#ciSearch").value || "").toLowerCase();
    const fType = $("#ciFilterType").value;
    let list = state.cis.filter(c => {
      if (fType && c.type !== fType) return false;
      if (q) { const hay = (c.name + c.ip + c.owner).toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
    $("#ciCount").textContent = `共 ${list.length} 项`;
    $("#ciBody").innerHTML = list.map(c => `
      <tr>
        <td><a class="link-btn" data-edit-ci="${c.id}">${escapeHtml(c.name)}</a></td>
        <td>${c.type}</td>
        <td class="num">${c.ip}</td>
        <td>${c.owner}</td>
        <td>${c.location}</td>
        <td>${c.status}</td>
        <td class="num">${ciIncidentCount(c.id)}</td>
        <td>
          <button class="link-btn" data-edit-ci="${c.id}">编辑</button>
          <button class="link-btn" data-del-ci="${c.id}">删除</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="8" class="empty">暂无配置项</td></tr>`;
  }

  /* ---------- Knowledge Base ---------- */
  function renderKB() {
    const q = ($("#kbSearch").value || "").toLowerCase();
    const fCat = $("#kbFilterCat").value;
    let list = state.kb.filter(k => {
      if (fCat && k.category !== fCat) return false;
      if (q) { const hay = (k.title + k.tags.join(" ") + k.content).toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
    $("#kbGrid").innerHTML = list.map(k => `
      <div class="kb-card" data-view-kb="${k.id}">
        <h4>${escapeHtml(k.title)}</h4>
        <div class="kb-tags"><span class="kb-tag">${k.category}</span>${k.tags.map(t => `<span class="kb-tag">#${escapeHtml(t)}</span>`).join("")}</div>
        <div class="meta">关联 CI：${k.ciId ? escapeHtml(ciName(k.ciId)) : "—"} · 浏览 ${k.views} 次 · 更新 ${fmtDate(k.updatedAt)}</div>
      </div>`).join("") || `<div class="empty">暂无知识文章</div>`;
  }

  /* ---------- Requests ---------- */
  function renderRequests() {
    const q = ($("#reqSearch").value || "").toLowerCase();
    const fStatus = $("#reqFilterStatus").value;
    const fType = $("#reqFilterType").value;
    let list = state.requests.filter(r => {
      if (fStatus && r.status !== fStatus) return false;
      if (fType && r.type !== fType) return false;
      if (q) { const hay = (r.id + r.title + r.requester + r.handler).toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
    $("#reqCount").textContent = `共 ${list.length} 条`;
    $("#reqBody").innerHTML = list.map(r => {
      const ap = APPROVAL[r.approval];
      return `<tr>
        <td class="num">${r.id}</td>
        <td><a class="link-btn" data-edit-req="${r.id}">${escapeHtml(r.title)}</a></td>
        <td>${r.type}</td>
        <td><span class="pill ${REQ_STATUS[r.status].cls}">${REQ_STATUS[r.status].label}</span></td>
        <td><span class="pill ${ap.cls}">${ap.label}</span></td>
        <td><span class="pill ${PRIORITY[r.priority].cls}">${r.priority}</span></td>
        <td>${r.requester}</td>
        <td>${r.handler || "—"}</td>
        <td class="num">${fmtDate(r.createdAt)}</td>
        <td><button class="link-btn" data-edit-req="${r.id}">编辑</button><button class="link-btn" data-del-req="${r.id}">删除</button></td>
      </tr>`;
    }).join("") || `<tr><td colspan="10" class="empty">暂无请求</td></tr>`;
  }
  function requestForm(data) {
    data = data || {};
    const typeOpts = REQ_TYPES.map(t => `<option value="${t}" ${data.type === t ? "selected" : ""}>${t}</option>`).join("");
    const statusOpts = Object.entries(REQ_STATUS).map(([k, v]) => `<option value="${k}" ${data.status === k ? "selected" : ""}>${v.label}</option>`).join("");
    const priOpts = Object.keys(PRIORITY).map(k => `<option value="${k}" ${data.priority === k ? "selected" : ""}>${k}</option>`).join("");
    const isEdit = !!data.id;
    const ap = APPROVAL[data.approval || "none"];
    const logHtml = (data.approvalLog && data.approvalLog.length)
      ? `<div class="form-row"><label>审批记录</label><div style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">${data.approvalLog.map(l => `<div>• ${escapeHtml(l.action)} - ${escapeHtml(l.by)} @ ${fmtDate(l.at)}${l.note ? "（" + escapeHtml(l.note) + "）" : ""}</div>`).join("")}</div></div>`
      : "";
    const approveBlock = isEdit ? `
      <div class="form-row"><label>审批状态</label><div style="display:flex;align-items:center;gap:10px"><span class="pill ${ap.cls}">${ap.label}</span>
        ${data.approval === "none" ? `<button class="btn sm" id="submitAppr">提交审批</button>` : ""}
        ${data.approval === "pending" ? `<input type="text" id="approver" placeholder="审批人" style="max-width:140px"><button class="btn sm primary" id="approveBtn">批准</button><button class="btn sm danger" id="rejectBtn">驳回</button>` : ""}
      </div></div>
      <div class="form-row"><label>审批意见</label><input type="text" id="apprNote" placeholder="审批备注（可选）"></div>` : "";
    return `
      <div class="form-row"><label>标题 *</label><input type="text" id="r_title" value="${escapeHtml(data.title || "")}"></div>
      <div class="form-grid">
        <div class="form-row"><label>类型</label><select id="r_type">${typeOpts}</select></div>
        <div class="form-row"><label>优先级</label><select id="r_priority">${priOpts}</select></div>
        <div class="form-row"><label>申请人</label><input type="text" id="r_requester" value="${escapeHtml(data.requester || "")}"></div>
        <div class="form-row"><label>处理人</label><input type="text" id="r_handler" value="${escapeHtml(data.handler || "")}"></div>
      </div>
      <div class="form-row"><label>申请内容 / 采购明细 *</label><textarea id="r_items" placeholder="权限说明或设备清单">${escapeHtml(data.items || "")}</textarea></div>
      <div class="form-row"><label>说明</label><textarea id="r_desc" placeholder="背景与理由">${escapeHtml(data.desc || "")}</textarea></div>
      ${approveBlock}${logHtml}
      ${isEdit ? `<div class="form-row"><label>编号</label><input type="text" value="${data.id}" disabled></div>` : ""}
    `;
  }
  function requestFoot(isEdit) { return `<button class="btn" id="cancelBtn">取消</button><button class="btn primary" id="saveReqBtn">${isEdit ? "保存修改" : "创建请求"}</button>`; }
  function collectRequest(id) {
    const data = {
      title: $("#r_title").value.trim(),
      type: $("#r_type").value,
      priority: $("#r_priority").value,
      requester: $("#r_requester").value.trim(),
      handler: $("#r_handler").value.trim(),
      items: $("#r_items").value.trim(),
      desc: $("#r_desc").value.trim(),
    };
    if (!data.title || !data.items) { toast("请填写标题与申请内容"); return null; }
    if (id) { Object.assign(state.requests.find(r => r.id === id), data); }
    else { state.requests.push({ id: uid("REQ"), approval: "none", approvalNote: "", approvalLog: [], createdAt: nowISO(), updatedAt: nowISO(), doneAt: null, ...data }); }
    save();
    return data;
  }
  function exportRequests() {
    const rows = state.requests.map(r => ({
      "编号": r.id, "标题": r.title, "类型": r.type, "状态": REQ_STATUS[r.status].label, "审批": APPROVAL[r.approval].label,
      "优先级": r.priority, "申请人": r.requester, "处理人": r.handler, "申请内容": r.items, "创建时间": fmtDate(r.createdAt),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "请求");
    XLSX.writeFile(wb, "requests_" + new Date().toISOString().slice(0, 10) + ".xlsx");
    toast("请求已导出为 Excel");
  }

  /* ---------- Changes ---------- */
  function renderChanges() {
    const q = ($("#chgSearch").value || "").toLowerCase();
    const fStatus = $("#chgFilterStatus").value;
    const fRisk = $("#chgFilterRisk").value;
    let list = state.changes.filter(c => {
      if (fStatus && c.status !== fStatus) return false;
      if (fRisk && c.risk !== fRisk) return false;
      if (q) { const hay = (c.id + c.title + c.owner).toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
    $("#chgCount").textContent = `共 ${list.length} 项`;
    $("#chgBody").innerHTML = list.map(c => {
      const ap = APPROVAL[c.approval];
      const riskCls = c.risk === "高" ? "ap-rejected" : c.risk === "中" ? "ap-pending" : "ap-approved";
      const cis = (c.relatedCis || []).map(ciName).filter(Boolean).join("、") || "—";
      return `<tr>
        <td class="num">${c.id}</td>
        <td><a class="link-btn" data-edit-chg="${c.id}">${escapeHtml(c.title)}</a></td>
        <td>${c.type}</td>
        <td><span class="pill ${riskCls}">${c.risk}</span></td>
        <td><span class="pill ${CHG_STATUS[c.status].cls}">${CHG_STATUS[c.status].label}</span></td>
        <td><span class="pill ${ap.cls}">${ap.label}</span></td>
        <td class="num">${fmtDate(c.scheduledAt)}</td>
        <td>${c.owner || "—"}</td>
        <td><button class="link-btn" data-edit-chg="${c.id}">编辑</button><button class="link-btn" data-del-chg="${c.id}">删除</button></td>
      </tr>`;
    }).join("") || `<tr><td colspan="9" class="empty">暂无变更</td></tr>`;
  }
  function changeForm(data) {
    data = data || {};
    const typeOpts = CHG_TYPES.map(t => `<option value="${t}" ${data.type === t ? "selected" : ""}>${t}</option>`).join("");
    const statusOpts = Object.entries(CHG_STATUS).map(([k, v]) => `<option value="${k}" ${data.status === k ? "selected" : ""}>${v.label}</option>`).join("");
    const riskOpts = CHG_RISK.map(t => `<option value="${t}" ${data.risk === t ? "selected" : ""}>${t}</option>`).join("");
    const priOpts = Object.keys(PRIORITY).map(k => `<option value="${k}" ${data.priority === k ? "selected" : ""}>${k}</option>`).join("");
    const cisOpts = state.cis.map(c => `<option value="${c.id}" ${(data.relatedCis || []).includes(c.id) ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
    const schedVal = data.scheduledAt ? new Date(data.scheduledAt).toISOString().slice(0, 16) : "";
    const isEdit = !!data.id;
    const ap = APPROVAL[data.approval || "none"];
    const logHtml = (data.approvalLog && data.approvalLog.length)
      ? `<div class="form-row"><label>审批记录</label><div style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">${data.approvalLog.map(l => `<div>• ${escapeHtml(l.action)} - ${escapeHtml(l.by)} @ ${fmtDate(l.at)}${l.note ? "（" + escapeHtml(l.note) + "）" : ""}</div>`).join("")}</div></div>`
      : "";
    const approveBlock = isEdit ? `
      <div class="form-row"><label>审批状态</label><div style="display:flex;align-items:center;gap:10px"><span class="pill ${ap.cls}">${ap.label}</span>
        ${data.approval === "none" ? `<button class="btn sm" id="submitAppr">提交审批</button>` : ""}
        ${data.approval === "pending" ? `<input type="text" id="approver" placeholder="审批人" style="max-width: 140px"><button class="btn sm primary" id="approveBtn">批准</button><button class="btn sm danger" id="rejectBtn">驳回</button>` : ""}
      </div></div>
      <div class="form-row"><label>审批意见</label><input type="text" id="apprNote" placeholder="审批备注（可选）"></div>` : "";
    return `
      <div class="form-row"><label>标题 *</label><input type="text" id="c_title" value="${escapeHtml(data.title || "")}"></div>
      <div class="form-grid">
        <div class="form-row"><label>类型</label><select id="c_type">${typeOpts}</select></div>
        <div class="form-row"><label>风险等级</label><select id="c_risk">${riskOpts}</select></div>
        <div class="form-row"><label>优先级</label><select id="c_priority">${priOpts}</select></div>
        <div class="form-row"><label>计划时间</label><input type="datetime-local" id="c_sched" value="${schedVal}"></div>
        <div class="form-row"><label>负责人</label><input type="text" id="c_owner" value="${escapeHtml(data.owner || "")}"></div>
      </div>
      <div class="form-row"><label>关联配置项（可多选 Ctrl/⌘+点击）</label><select id="c_cis" multiple size="4">${cisOpts}</select></div>
      <div class="form-row"><label>变更内容 *</label><textarea id="c_desc" placeholder="具体变更步骤">${escapeHtml(data.desc || "")}</textarea></div>
      <div class="form-row"><label>回滚方案 *</label><textarea id="c_rollback" placeholder="回滚步骤">${escapeHtml(data.rollback || "")}</textarea></div>
      ${approveBlock}${logHtml}
      ${isEdit ? `<div class="form-row"><label>编号</label><input type="text" value="${data.id}" disabled></div>` : ""}
    `;
  }
  function changeFoot(isEdit) { return `<button class="btn" id="cancelBtn">取消</button><button class="btn primary" id="saveChgBtn">${isEdit ? "保存修改" : "创建变更"}</button>`; }
  function collectChange(id) {
    const sel = $("#c_cis");
    const relatedCis = Array.from(sel.selectedOptions).map(o => o.value);
    const schedRaw = $("#c_sched").value;
    const data = {
      title: $("#c_title").value.trim(),
      type: $("#c_type").value,
      risk: $("#c_risk").value,
      priority: $("#c_priority").value,
      scheduledAt: schedRaw ? new Date(schedRaw).toISOString() : nowISO(),
      owner: $("#c_owner").value.trim(),
      relatedCis,
      desc: $("#c_desc").value.trim(),
      rollback: $("#c_rollback").value.trim(),
    };
    if (!data.title || !data.desc || !data.rollback) { toast("请填写标题、变更内容与回滚方案"); return null; }
    if (id) { Object.assign(state.changes.find(c => c.id === id), data); }
    else { state.changes.push({ id: uid("CHG"), approval: "none", approvalNote: "", approvalLog: [], createdAt: nowISO(), updatedAt: nowISO(), ...data }); }
    save();
    return data;
  }
  function exportChanges() {
    const rows = state.changes.map(c => ({
      "编号": c.id, "标题": c.title, "类型": c.type, "风险": c.risk, "状态": CHG_STATUS[c.status].label, "审批": APPROVAL[c.approval].label,
      "计划时间": fmtDate(c.scheduledAt), "负责人": c.owner, "关联CI": (c.relatedCis || []).map(ciName).join("、"), "变更内容": c.desc,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "变更");
    XLSX.writeFile(wb, "changes_" + new Date().toISOString().slice(0, 10) + ".xlsx");
    toast("变更已导出为 Excel");
  }

  /* ---------- Modal ---------- */
  function openModal(title, bodyHtml, footHtml) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    $("#modalFoot").innerHTML = footHtml;
    $("#modal").classList.add("open");
  }
  function closeModal() { $("#modal").classList.remove("open"); }

  /* ---------- Incident 表单 ---------- */
  function incidentForm(data) {
    data = data || {};
    const ciOpts = `<option value="">无</option>` + state.cis.map(c => `<option value="${c.id}" ${data.ciId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
    const statusOpts = Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${data.status === k ? "selected" : ""}>${v.label}</option>`).join("");
    const priOpts = Object.keys(PRIORITY).map(k => `<option value="${k}" ${data.priority === k ? "selected" : ""}>${k}</option>`).join("");
    const catOpts = CATEGORIES.map(c => `<option value="${c}" ${data.category === c ? "selected" : ""}>${c}</option>`).join("");
    const isEdit = !!data.id;
    const ap = APPROVAL[data.approval || "none"];
    const logHtml = (data.approvalLog && data.approvalLog.length)
      ? `<div class="form-row"><label>审批记录</label><div style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px">
          ${data.approvalLog.map(l => `<div>• ${escapeHtml(l.action)} - ${escapeHtml(l.by)} @ ${fmtDate(l.at)}${l.note ? "（" + escapeHtml(l.note) + "）" : ""}</div>`).join("")}
        </div></div>`
      : "";
    const approveBlock = isEdit ? `
      <div class="form-row">
        <label>审批状态</label>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="pill ${ap.cls}">${ap.label}</span>
          ${data.approval === "none" ? `<button class="btn sm" id="submitAppr">提交审批</button>` : ""}
          ${data.approval === "pending" ? `<input type="text" id="approver" placeholder="审批人" style="max-width:140px"><button class="btn sm primary" id="approveBtn">批准</button><button class="btn sm danger" id="rejectBtn">驳回</button>` : ""}
        </div>
      </div>
      <div class="form-row"><label>审批意见</label><input type="text" id="apprNote" placeholder="审批备注（可选）"></div>` : "";
    return `
      <div class="form-row"><label>标题 *</label>
        <input type="text" id="f_title" value="${escapeHtml(data.title || "")}" placeholder="简要描述问题"></div>
      <div class="form-row"><label>描述</label>
        <textarea id="f_desc" placeholder="详细现象、影响范围、报错信息">${escapeHtml(data.desc || "")}</textarea></div>
      <div class="form-grid">
        <div class="form-row"><label>状态</label><select id="f_status">${statusOpts}</select></div>
        <div class="form-row"><label>优先级</label><select id="f_priority">${priOpts}</select></div>
        <div class="form-row"><label>分类</label><select id="f_category">${catOpts}</select></div>
        <div class="form-row"><label>负责人</label><input type="text" id="f_assignee" value="${escapeHtml(data.assignee || "")}" placeholder="处理人"></div>
        <div class="form-row"><label>申请人</label><input type="text" id="f_requester" value="${escapeHtml(data.requester || "")}" placeholder="提单人"></div>
        <div class="form-row"><label>关联配置项</label><select id="f_ci">${ciOpts}</select></div>
      </div>
      ${approveBlock}
      ${logHtml}
      ${isEdit ? `<div class="form-row"><label>编号</label><input type="text" value="${data.id}" disabled></div>` : ""}
    `;
  }
  function incidentFoot(isEdit) {
    return `<button class="btn" id="cancelBtn">取消</button><button class="btn primary" id="saveIncBtn">${isEdit ? "保存修改" : "创建工单"}</button>`;
  }
  function auditLog(item) { return item.approvalLog || (item.approvalLog = []); }
  function collectIncident(id) {
    const data = {
      title: $("#f_title").value.trim(),
      desc: $("#f_desc").value.trim(),
      status: $("#f_status").value,
      priority: $("#f_priority").value,
      category: $("#f_category").value,
      assignee: $("#f_assignee").value.trim(),
      requester: $("#f_requester").value.trim(),
      ciId: $("#f_ci").value || null,
    };
    if (!data.title) { toast("请填写标题"); return null; }
    if (id) {
      const item = state.incidents.find(i => i.id === id);
      Object.assign(item, data);
      item.updatedAt = nowISO();
      if (data.status === "resolved" && !item.resolvedAt) item.resolvedAt = nowISO();
      if (data.status !== "resolved" && data.status !== "closed") item.resolvedAt = null;
    } else {
      state.incidents.push({ id: uid("INC"), approval: "none", approvalNote: "", approvalLog: [], ...data, createdAt: nowISO(), updatedAt: nowISO(), resolvedAt: data.status === "resolved" ? nowISO() : null });
    }
    save();
    return data;
  }

  /* ---------- CI 表单 ---------- */
  function ciForm(data) {
    data = data || {};
    const typeOpts = CI_TYPES.map(t => `<option value="${t}" ${data.type === t ? "selected" : ""}>${t}</option>`).join("");
    const stOpts = CI_STATUS.map(t => `<option value="${t}" ${data.status === t ? "selected" : ""}>${t}</option>`).join("");
    const isEdit = !!data.id;
    return `
      <div class="form-row"><label>名称 *</label><input type="text" id="c_name" value="${escapeHtml(data.name || "")}" placeholder="配置项名称"></div>
      <div class="form-grid">
        <div class="form-row"><label>类型</label><select id="c_type">${typeOpts}</select></div>
        <div class="form-row"><label>IP / 标识</label><input type="text" id="c_ip" value="${escapeHtml(data.ip || "")}" placeholder="IP 或标识"></div>
        <div class="form-row"><label>负责人</label><input type="text" id="c_owner" value="${escapeHtml(data.owner || "")}"></div>
        <div class="form-row"><label>位置</label><input type="text" id="c_location" value="${escapeHtml(data.location || "")}"></div>
        <div class="form-row"><label>状态</label><select id="c_status">${stOpts}</select></div>
      </div>
      <div class="form-row"><label>描述</label><textarea id="c_desc" placeholder="用途说明">${escapeHtml(data.desc || "")}</textarea></div>
      ${isEdit ? `<div class="form-row"><label>编号</label><input type="text" value="${data.id}" disabled></div>` : ""}
    `;
  }
  function ciFoot() { return `<button class="btn" id="cancelBtn">取消</button><button class="btn primary" id="saveCIBtn">保存</button>`; }
  function collectCI(id) {
    const data = {
      name: $("#c_name").value.trim(),
      type: $("#c_type").value,
      ip: $("#c_ip").value.trim(),
      owner: $("#c_owner").value.trim(),
      location: $("#c_location").value.trim(),
      status: $("#c_status").value,
      desc: $("#c_desc").value.trim(),
    };
    if (!data.name) { toast("请填写名称"); return null; }
    if (id) { Object.assign(state.cis.find(c => c.id === id), data); }
    else { state.cis.push({ id: uid("CI"), ...data }); }
    save();
    return data;
  }

  /* ---------- KB 表单 ---------- */
  function kbForm(data) {
    data = data || {};
    const catOpts = KB_CATS.map(t => `<option value="${t}" ${data.category === t ? "selected" : ""}>${t}</option>`).join("");
    const ciOpts = `<option value="">无</option>` + state.cis.map(c => `<option value="${c.id}" ${data.ciId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
    const isEdit = !!data.id;
    return `
      <div class="form-row"><label>标题 *</label><input type="text" id="k_title" value="${escapeHtml(data.title || "")}" placeholder="解决方案标题"></div>
      <div class="form-grid">
        <div class="form-row"><label>分类</label><select id="k_cat">${catOpts}</select></div>
        <div class="form-row"><label>关联配置项</label><select id="k_ci">${ciOpts}</select></div>
      </div>
      <div class="form-row"><label>标签（逗号分隔）</label><input type="text" id="k_tags" value="${(data.tags || []).join(", ")}" placeholder="慢SQL, 性能"></div>
      <div class="form-row"><label>解决方案 / 内容 *</label><textarea id="k_content" placeholder="步骤化的处理方案">${escapeHtml(data.content || "")}</textarea></div>
      ${isEdit ? `<div class="form-row"><label>编号</label><input type="text" value="${data.id}" disabled></div>` : ""}
    `;
  }
  function kbFoot() { return `<button class="btn" id="cancelBtn">取消</button><button class="btn primary" id="saveKbBtn">保存</button>`; }
  function collectKB(id) {
    const data = {
      title: $("#k_title").value.trim(),
      category: $("#k_cat").value,
      ciId: $("#k_ci").value || null,
      tags: ($("#k_tags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean)),
      content: $("#k_content").value.trim(),
    };
    if (!data.title || !data.content) { toast("请填写标题与内容"); return null; }
    if (id) { const item = state.kb.find(k => k.id === id); Object.assign(item, data, { updatedAt: nowISO() }); }
    else { state.kb.push({ id: uid("KB"), views: 0, createdAt: nowISO(), updatedAt: nowISO(), ...data }); }
    save();
    return data;
  }

  /* ---------- Excel 导出 ---------- */
  function exportIncidents() {
    const rows = state.incidents.map(i => ({
      "编号": i.id, "标题": i.title, "状态": STATUS[i.status].label, "优先级": i.priority,
      "SLA状态": slaInfo(i).text, "审批": APPROVAL[i.approval].label, "分类": i.category,
      "负责人": i.assignee, "申请人": i.requester, "关联CI": ciName(i.ciId),
      "创建时间": fmtDate(i.createdAt), "更新时间": fmtDate(i.updatedAt), "解决时间": fmtDate(i.resolvedAt), "描述": i.desc,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "工单");
    XLSX.writeFile(wb, "incidents_" + new Date().toISOString().slice(0, 10) + ".xlsx");
    toast("工单已导出为 Excel");
  }
  function exportCI() {
    const rows = state.cis.map(c => ({
      "编号": c.id, "名称": c.name, "类型": c.type, "IP/标识": c.ip, "负责人": c.owner,
      "位置": c.location, "状态": c.status, "关联工单数": ciIncidentCount(c.id), "描述": c.desc,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "CMDB");
    XLSX.writeFile(wb, "cmdb_" + new Date().toISOString().slice(0, 10) + ".xlsx");
    toast("CMDB 已导出为 Excel");
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    $$(".nav-item").forEach(n => {
      if (n.dataset.page) n.addEventListener("click", () => switchPage(n.dataset.page));
      if (n.dataset.action === "reset") n.addEventListener("click", () => {
        if (confirm("确定重置为演示数据？将清除当前所有改动。")) { seed(); toast("已重置演示数据"); switchPage("dashboard"); }
      });
    });
    $("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $("#modalClose").addEventListener("click", closeModal);
    $("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });

    ["incSearch", "incFilterStatus", "incFilterPriority", "incSort"].forEach(id => $("#" + id).addEventListener("input", renderIncidents));
    $("#btnNewIncident").addEventListener("click", () => {
      openModal("新建工单", incidentForm(), incidentFoot(false));
      $("#saveIncBtn").addEventListener("click", () => { if (collectIncident()) { closeModal(); renderIncidents(); renderDashboard(); toast("工单已创建"); } });
      $("#cancelBtn").addEventListener("click", closeModal);
    });
    $("#btnExportInc").addEventListener("click", exportIncidents);

    ["ciSearch", "ciFilterType"].forEach(id => $("#" + id).addEventListener("input", renderCMDB));
    $("#btnNewCI").addEventListener("click", () => {
      openModal("新建配置项", ciForm(), ciFoot());
      $("#saveCIBtn").addEventListener("click", () => { if (collectCI()) { closeModal(); renderCMDB(); toast("配置项已创建"); } });
      $("#cancelBtn").addEventListener("click", closeModal);
    });
    $("#btnExportCI").addEventListener("click", exportCI);

    ["kbSearch", "kbFilterCat"].forEach(id => $("#" + id).addEventListener("input", renderKB));
    $("#btnNewKB").addEventListener("click", () => {
      openModal("新建知识文章", kbForm(), kbFoot());
      $("#saveKbBtn").addEventListener("click", () => { if (collectKB()) { closeModal(); renderKB(); toast("知识文章已创建"); } });
      $("#cancelBtn").addEventListener("click", closeModal);
    });

    ["reqSearch", "reqFilterStatus", "reqFilterType"].forEach(id => $("#" + id).addEventListener("input", renderRequests));
    $("#btnNewReq").addEventListener("click", () => {
      openModal("新建请求", requestForm(), requestFoot(false));
      $("#saveReqBtn").addEventListener("click", () => { if (collectRequest()) { closeModal(); renderRequests(); toast("请求已创建"); } });
      $("#cancelBtn").addEventListener("click", closeModal);
    });
    $("#btnExportReq").addEventListener("click", exportRequests);

    ["chgSearch", "chgFilterStatus", "chgFilterRisk"].forEach(id => $("#" + id).addEventListener("input", renderChanges));
    $("#btnNewChg").addEventListener("click", () => {
      openModal("新建变更", changeForm(), changeFoot(false));
      $("#saveChgBtn").addEventListener("click", () => { if (collectChange()) { closeModal(); renderChanges(); toast("变更已创建"); } });
      $("#cancelBtn").addEventListener("click", closeModal);
    });
    $("#btnExportChg").addEventListener("click", exportChanges);

    // 列表内操作（事件委托）
    document.addEventListener("click", e => {
      const t = e.target.closest("[data-edit-inc],[data-del-inc],[data-edit-ci],[data-del-ci],[data-goto-ci],[data-view-kb],[data-edit-kb],[data-edit-req],[data-del-req],[data-edit-chg],[data-del-chg]");
      if (!t) return;

      if (t.dataset.editInc) {
        const item = state.incidents.find(i => i.id === t.dataset.editInc);
        openModal("编辑工单 - " + item.id, incidentForm(item), incidentFoot(true));
        $("#saveIncBtn").addEventListener("click", () => { if (collectIncident(item.id)) { closeModal(); renderIncidents(); renderDashboard(); toast("已保存"); } });
        $("#cancelBtn").addEventListener("click", closeModal);
        // 审批动作
        if (item.approval === "none" && $("#submitAppr")) {
          $("#submitAppr").addEventListener("click", () => {
            item.approval = "pending";
            auditLog(item).push({ action: "提交审批", by: item.assignee || "经办人", at: nowISO() });
            item.updatedAt = nowISO(); save(); closeModal(); renderIncidents(); renderDashboard(); toast("已提交审批");
          });
        }
        if (item.approval === "pending") {
          $("#approveBtn").addEventListener("click", () => {
            const apr = $("#approver").value.trim() || "审批人";
            item.approval = "approved"; item.approver = apr; item.approvalNote = $("#apprNote").value.trim();
            auditLog(item).push({ action: "批准", by: apr, at: nowISO(), note: item.approvalNote });
            item.updatedAt = nowISO(); save(); closeModal(); renderIncidents(); renderDashboard(); toast("已批准");
          });
          $("#rejectBtn").addEventListener("click", () => {
            const apr = $("#approver").value.trim() || "审批人";
            item.approval = "rejected"; item.approver = apr; item.approvalNote = $("#apprNote").value.trim();
            auditLog(item).push({ action: "驳回", by: apr, at: nowISO(), note: item.approvalNote });
            item.updatedAt = nowISO(); save(); closeModal(); renderIncidents(); renderDashboard(); toast("已驳回");
          });
        }
      }
      if (t.dataset.delInc) {
        if (confirm("确定删除该工单？")) { state.incidents = state.incidents.filter(i => i.id !== t.dataset.delInc); save(); renderIncidents(); renderDashboard(); toast("已删除"); }
      }
      if (t.dataset.editCi) {
        const item = state.cis.find(c => c.id === t.dataset.editCi);
        openModal("编辑配置项 - " + item.id, ciForm(item), ciFoot());
        $("#saveCIBtn").addEventListener("click", () => { if (collectCI(item.id)) { closeModal(); renderCMDB(); renderDashboard(); toast("已保存"); } });
        $("#cancelBtn").addEventListener("click", closeModal);
      }
      if (t.dataset.delCi) {
        if (confirm("确定删除该配置项？")) {
          state.cis = state.cis.filter(c => c.id !== t.dataset.delCi);
          state.incidents.forEach(i => { if (i.ciId === t.dataset.delCi) i.ciId = null; });
          save(); renderCMDB(); renderDashboard(); toast("已删除");
        }
      }
      if (t.dataset.gotoCi) { switchPage("cmdb"); $("#ciSearch").value = ciName(t.dataset.gotoCi); renderCMDB(); }
      if (t.dataset.viewKb) {
        const k = state.kb.find(x => x.id === t.dataset.viewKb);
        k.views = (k.views || 0) + 1; save();
        openModal(k.title, `<div class="kb-detail">${escapeHtml(k.content)}</div>
          <div class="meta" style="margin-top:12px;color:var(--text-faint);font-size:12px">分类：${k.category} · 关联CI：${k.ciId ? escapeHtml(ciName(k.ciId)) : "—"} · 标签：${(k.tags||[]).map(escapeHtml).join("、")}</div>`, `<button class="btn primary" id="editKbBtn">编辑</button><button class="btn" id="closeKb">关闭</button>`);
        $("#closeKb").addEventListener("click", closeModal);
        $("#editKbBtn").addEventListener("click", () => {
          openModal("编辑知识文章 - " + k.id, kbForm(k), kbFoot());
          $("#saveKbBtn").addEventListener("click", () => { if (collectKB(k.id)) { closeModal(); renderKB(); toast("已保存"); } });
          $("#cancelBtn").addEventListener("click", closeModal);
        });
      }
      if (t.dataset.editReq) {
        const item = state.requests.find(r => r.id === t.dataset.editReq);
        openModal("编辑请求 - " + item.id, requestForm(item), requestFoot(true));
        $("#saveReqBtn").addEventListener("click", () => { if (collectRequest(item.id)) { closeModal(); renderRequests(); toast("已保存"); } });
        $("#cancelBtn").addEventListener("click", closeModal);
        if (item.approval === "none" && $("#submitAppr")) {
          $("#submitAppr").addEventListener("click", () => {
            item.approval = "pending";
            auditLog(item).push({ action: "提交审批", by: item.handler || "经办人", at: nowISO() });
            item.updatedAt = nowISO(); save(); closeModal(); renderRequests(); toast("已提交审批");
          });
        }
        if (item.approval === "pending") {
          $("#approveBtn").addEventListener("click", () => {
            const apr = $("#approver").value.trim() || "审批人";
            item.approval = "approved"; item.approver = apr; item.approvalNote = $("#apprNote").value.trim();
            auditLog(item).push({ action: "批准", by: apr, at: nowISO(), note: item.approvalNote });
            item.updatedAt = nowISO(); save(); closeModal(); renderRequests(); toast("已批准");
          });
          $("#rejectBtn").addEventListener("click", () => {
            const apr = $("#approver").value.trim() || "审批人";
            item.approval = "rejected"; item.approver = apr; item.approvalNote = $("#apprNote").value.trim();
            auditLog(item).push({ action: "驳回", by: apr, at: nowISO(), note: item.approvalNote });
            item.updatedAt = nowISO(); save(); closeModal(); renderRequests(); toast("已驳回");
          });
        }
      }
      if (t.dataset.delReq) {
        if (confirm("确定删除该请求？")) { state.requests = state.requests.filter(r => r.id !== t.dataset.delReq); save(); renderRequests(); toast("已删除"); }
      }
      if (t.dataset.editChg) {
        const item = state.changes.find(c => c.id === t.dataset.editChg);
        openModal("编辑变更 - " + item.id, changeForm(item), changeFoot(true));
        $("#saveChgBtn").addEventListener("click", () => { if (collectChange(item.id)) { closeModal(); renderChanges(); toast("已保存"); } });
        $("#cancelBtn").addEventListener("click", closeModal);
        if (item.approval === "none" && $("#submitAppr")) {
          $("#submitAppr").addEventListener("click", () => {
            item.approval = "pending";
            auditLog(item).push({ action: "提交审批", by: item.owner || "经办人", at: nowISO() });
            item.updatedAt = nowISO(); save(); closeModal(); renderChanges(); toast("已提交审批");
          });
        }
        if (item.approval === "pending") {
          $("#approveBtn").addEventListener("click", () => {
            const apr = $("#approver").value.trim() || "审批人";
            item.approval = "approved"; item.approver = apr; item.approvalNote = $("#apprNote").value.trim();
            auditLog(item).push({ action: "批准", by: apr, at: nowISO(), note: item.approvalNote });
            item.updatedAt = nowISO(); save(); closeModal(); renderChanges(); toast("已批准");
          });
          $("#rejectBtn").addEventListener("click", () => {
            const apr = $("#approver").value.trim() || "审批人";
            item.approval = "rejected"; item.approver = apr; item.approvalNote = $("#apprNote").value.trim();
            auditLog(item).push({ action: "驳回", by: apr, at: nowISO(), note: item.approvalNote });
            item.updatedAt = nowISO(); save(); closeModal(); renderChanges(); toast("已驳回");
          });
        }
      }
      if (t.dataset.delChg) {
        if (confirm("确定删除该变更？")) { state.changes = state.changes.filter(c => c.id !== t.dataset.delChg); save(); renderChanges(); toast("已删除"); }
      }
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    if (!load()) seed();
    bind();
    switchPage("dashboard");
  }
  document.addEventListener("DOMContentLoaded", init);
})();
