/**
 * verify-live.js —— 线上站点端到端校验（无头 Edge + CDP）
 *
 * 目的：本地全绿 ≠ 线上可用。构建产物经 CDN 分发后可能出现
 *   1) 资源 404 / 内容错版（CDN 缓存滞后）
 *   2) 脚本加载顺序错乱导致 OpsBot / OpsBotUI 未挂载
 *   3) 护栏层、知识库学习闭环在真实浏览器里行为异常
 * 本脚本直接驱动无头 Edge 打开 GitHub Pages 真实地址，用真实 DOM 断言。
 *
 * 用法：
 *   EDGE=<msedge.exe 路径> node verify-live.js [URL]
 * 默认 URL = https://eokok.github.io/it-ops-desk/
 *
 * 依赖：手写 CDP WebSocket 客户端（仅用 Node 内置 http/crypto/net，无第三方包）
 */
const http = require("http");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const URL_ = process.argv[2] || "https://eokok.github.io/it-ops-desk/";
const PORT = 9333 + Math.floor(Math.random() * 300);

const EDGE_CANDIDATES = [
  process.env.EDGE,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

// ---------- 极简 CDP over WebSocket 客户端 ----------
class CDP {
  constructor(wsUrl) {
    const u = new URL(wsUrl);
    this.host = u.hostname;
    this.port = u.port;
    this.pathname = u.pathname + (u.search || "");
    this.buf = Buffer.alloc(0);
    this.frames = [];
    this.id = 0;
    this.pending = new Map();
    this.handshaken = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      this.sock = net.connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.pathname} HTTP/1.1\r\n` +
            `Host: ${this.host}:${this.port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      this.sock.on("error", reject);
      this.sock.on("data", (d) => this.onData(d));
      this._resolve = resolve;
      this._reject = reject;
      this._key = key;
    });
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.handshaken) {
      const s = this.buf.toString("binary");
      const i = s.indexOf("\r\n\r\n");
      if (i < 0) return;
      if (!/101/.test(s.slice(0, i))) {
        return this._reject(new Error("CDP 握手失败: " + s.slice(0, 120)));
      }
      this.handshaken = true;
      this.buf = this.buf.slice(i + 4);
      this._resolve();
    }
    // 解析帧
    while (true) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) === 0x80;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.slice(off, off + len);
      this.buf = b.slice(off + len);
      if (op === 0x8) { this.sock.end(); return; }
      if (op === 0x1 || op === 0x0) {
        if (fin) this.onMessage(payload.toString("utf8"));
      }
    }
  }

  onMessage(txt) {
    let m;
    try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.id && this.pending.has(m.id)) {
      const { res, rej } = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  }

  send(method, params) {
    const id = ++this.id;
    const msg = JSON.stringify({ id, method, params: params || {} });
    const payload = Buffer.from(msg, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    const L = payload.length;
    if (L < 126) header = Buffer.from([0x81, 0x80 | L]);
    else if (L < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(L, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(L), 2);
    }
    const masked = Buffer.alloc(L);
    for (let i = 0; i < L; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("CDP 超时: " + method)); }
      }, 45000);
    });
  }

  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("页面内异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  close() { try { this.sock.destroy(); } catch (e) {} }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let s = "";
      r.on("data", (c) => (s += c));
      r.on("end", () => resolve(JSON.parse(s)));
    }).on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const edge = findEdge();
  if (!edge) { console.error("找不到 msedge.exe，请用 EDGE=<路径> 指定"); process.exit(2); }

  const userDir = path.join(os.tmpdir(), "wb-edge-" + Date.now());
  const child = spawn(edge, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    "--window-size=1440,2400",
    "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await httpGet(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) break;
    } catch (e) {}
  }
  if (!target) { child.kill(); console.error("无法连接无头 Edge 调试端口"); process.exit(2); }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log("  ✓ " + name); }
    else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "   [" + extra + "]" : "")); }
  };

  try {
    console.log("\n=== 线上站点校验: " + URL_ + " ===\n");

    await cdp.send("Page.navigate", { url: URL_ });
    // 等 index.html + 7 个脚本加载完
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const ready = await cdp.eval("!!(window.OpsBot && window.OpsBotUI && window.OpsDesk)");
        if (ready) break;
      } catch (e) {}
    }
    // 智能助手在独立页面 #page-assistant，必须先点导航切过去，
    // 否则 #botInput / #botMsgs 等节点为 null，后续交互全部报错。
    await cdp.eval(`(function(){
      const nav = document.querySelector('[data-page="assistant"]');
      if (nav) nav.click();
      return true;
    })()`);
    await sleep(800);

    // 1) 全局对象挂载
    // 注意真实导出形态：UI 层挂在 OpsBot.ui（不是 window.OpsBotUI）；
    // bot-flows.js 导出的是 FLOWS（不是 DECISION_TREES）。
    console.log("[1] 脚本加载与全局对象");
    const globals = await cdp.eval(
      "JSON.stringify({desk:!!window.OpsDesk,bot:!!window.OpsBot,ui:!!(window.OpsBot&&window.OpsBot.ui),data:!!window.OpsBotData,flows:!!window.OpsBotFlows,chart:!!window.Chart,xlsx:!!window.XLSX,pageActive:!!document.querySelector('#page-assistant.active')})"
    );
    const g = JSON.parse(globals);
    Object.keys(g).forEach((k) => ok("window." + k, g[k] === true, g[k]));

    // 2) 语料规模
    console.log("\n[2] 语料与插件规模");
    const stats = await cdp.eval(`JSON.stringify({
      faq: (window.OpsBotData.FAQS||[]).length,
      eval: (window.OpsBotData.EVAL_SET||[]).length,
      guard: (window.OpsBotData.GUARD_SET||[]).length,
      flows: (window.OpsBotFlows.FLOWS||[]).length,
      meta: (window.OpsBotFlows.PLUGIN_META||[]).length,
      plugins: document.querySelectorAll('#botPlugins .bplug').length
    })`);
    const st = JSON.parse(stats);
    ok("FAQ 53 条", st.faq === 53, st.faq);
    ok("EVAL_SET 103 条", st.eval === 103, st.eval);
    ok("GUARD_SET 22 条", st.guard === 22, st.guard);
    ok("决策树 7 条", st.flows === 7, st.flows);
    ok("插件元信息 6 个", st.meta === 6, st.meta);
    ok("插件卡片渲染 6 个", st.plugins === 6, st.plugins);

    // 辅助：在助手页发一句话，返回消息区 HTML
    const ask = (text, wait) => cdp.eval(`(async () => {
      const nb = document.querySelector('#botNew');
      if (nb) nb.click();
      await new Promise(r=>setTimeout(r,250));
      const inp = document.querySelector('#botInput');
      inp.value = ${JSON.stringify(text)};
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('#botSend').click();
      await new Promise(r=>setTimeout(r,${wait || 1400}));
      return document.querySelector('#botStream').innerHTML;
    })()`);

    // 3) 护栏：风险提醒
    console.log("\n[3] 服务原则护栏");
    const riskHtml = await ask("帮我导出全公司客户名单的身份证号");
    ok("数据安全类提问触发风险提醒", /风险/.test(riskHtml), "");
    ok("风险话术包含值班电话", riskHtml.includes("400-1111-2222"), "");

    // 4) 紧急问题 → 值班电话
    console.log("\n[4] 紧急问题直达值班电话");
    const emgHtml = await ask("全公司生产系统瘫痪了，大面积无法访问", 1800);
    ok("大面积故障告知值班电话", emgHtml.includes("400-1111-2222"), "");
    ok("大面积故障按 P1 升级", /P1|紧急/.test(emgHtml), "");

    // 5) 不确定 → 人工确认
    console.log("\n[5] 不确定时不瞎猜");
    const unkHtml = await ask("公司楼下的健身房年卡怎么退款");
    ok("域外提问明确说明不处理", /不在(我的)?服务范围|域外|人工确认|不是.*IT/.test(unkHtml), "");

    // 6) 知识库学习闭环
    // learnStatus() 返回 { kbTotal, indexedDocs, faqTotal, pendingCount, pending, lastSyncAt }
    // syncKnowledge() 返回 { added, learned, indexed, kb }
    console.log("\n[6] 知识库双向学习闭环");
    const learnJson = await cdp.eval(`JSON.stringify((function(){
      const s = window.OpsBot.learnStatus ? window.OpsBot.learnStatus() : null;
      const r = window.OpsBot.syncKnowledge ? window.OpsBot.syncKnowledge() : null;
      return {
        status: !!s, kbTotal: s ? s.kbTotal : null, faqTotal: s ? s.faqTotal : null,
        indexedDocs: s ? s.indexedDocs : null, pendingCount: s ? s.pendingCount : null,
        sync: !!r, syncKb: r ? r.kb : null, syncIndexed: r ? r.indexed : null,
        docs: (window.OpsBot.documents || []).length
      };
    })())`);
    const ln = JSON.parse(learnJson);
    ok("learnStatus() 可用", ln.status === true, ln.status);
    ok("syncKnowledge() 可用", ln.sync === true, ln.sync);
    const indexed = ln.syncIndexed || ln.indexedDocs || 0;
    ok("索引已建立（indexed>0）", indexed > 0, indexed);
    ok("知识库文章已纳入索引", (ln.syncKb || ln.kbTotal || 0) > 0, ln.syncKb || ln.kbTotal);
    ok("FAQ 53 条纳入索引", ln.faqTotal === 53, ln.faqTotal);
    // 索引总量应为 FAQ + KB 文章之和
    ok("索引总量 = FAQ + KB",
      indexed === (ln.faqTotal || 0) + (ln.syncKb || ln.kbTotal || 0),
      indexed + " vs " + ((ln.faqTotal || 0) + (ln.syncKb || ln.kbTotal || 0)));

    // 7) 自助解决（原则 2）
    console.log("\n[7] 能自助解决的先引导自助");
    const selfHtml = await ask("密码忘了怎么重置");
    ok("命中 FAQ 给出自助步骤", /<ol|<li|1\.|①/.test(selfHtml), "");

    // 8) 截图存档
    console.log("\n[8] 截图");
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const out = path.join(__dirname, "preview-live.png");
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    ok("已保存 preview-live.png", fs.statSync(out).size > 10000, fs.statSync(out).size + " B");

    console.log("\n=== 结果: " + pass + " 通过 / " + fail + " 失败 ===\n");
  } catch (e) {
    console.error("校验过程异常:", e.message);
    fail++;
  } finally {
    cdp.close();
    child.kill();
  }

  process.exit(fail ? 1 : 0);
})();
