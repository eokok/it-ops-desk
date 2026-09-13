/* ============================================================
   IT 智能助手 — 核心引擎
   混合检索（BM25 关键词 + TF-IDF 语义 + 同义词概念扩展）
   分级服务编排 / 5 个插件 / 审计日志 / 故障回放数据
   ============================================================ */
window.OpsBot = (() => {
  "use strict";

  const LS_KEY = "opsdesk.bot.v1";
  const $ = (s, r = document) => r.querySelector(s);
  const DATA = window.OpsBotData || { SYNONYMS: {}, STOPWORDS: [], FAQS: [], EVAL_SET: [] };
  const FLOW_DATA = window.OpsBotFlows || { FLOWS: [], ONBOARD: { stages: [] }, PLUGIN_META: [] };

  const SYNONYMS = DATA.SYNONYMS;
  const STOPWORDS = DATA.STOPWORDS;
  const FAQS = DATA.FAQS;
  const EVAL_SET = DATA.EVAL_SET;
  const FLOWS = FLOW_DATA.FLOWS;
  const ONBOARD = FLOW_DATA.ONBOARD;
  const PLUGIN_META = FLOW_DATA.PLUGIN_META;

  /* SLA 分级响应（与主系统 SLA_HOURS 对齐：P1 4h / P2 8h / P3 24h / P4 72h） */
  const SLA_RESPONSE = { P1: "15 分钟", P2: "30 分钟", P3: "2 小时", P4: "1 个工作日" };
  const SLA_RESOLVE = { P1: "4 小时", P2: "8 小时", P3: "24 小时", P4: "72 小时" };
  const SLA_OWNER = { P1: "7×24 应急值守", P2: "一线 + 二线工程师", P3: "一线工程师", P4: "服务台排队处理" };

  /* 混合检索权重与置信度阈值（由评测集回归校准） */
  const W = { bm25: 0.27, cosine: 0.33, concept: 0.18, phrase: 0.22 };
  /* strong：融合分足够高时视为高置信（多路信号一致），不再要求领先幅度 */
  const CONF = { high: 0.42, mid: 0.22, margin: 0.06, strong: 0.75, minCov: 0.34, minMidCov: 0.15 };

  /* ============================================================
     1. 状态与持久化
     ============================================================ */
  let store = {
    sessions: [],          // 会话（含消息与工具调用，用于审计与回放）
    currentId: null,
    onboardProgress: {},   // 入职清单勾选状态 {itemId:true}
    lastEval: null,        // 最近一次评测结果
  };

  const uid = (p) => p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 90 + 10);
  const nowISO = () => new Date().toISOString();
  function fmtTime(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function save() {
    try {
      // 控制体量：仅保留最近 120 条会话
      if (store.sessions.length > 120) store.sessions = store.sessions.slice(0, 120);
      localStorage.setItem(LS_KEY, JSON.stringify(store));
    } catch (e) { console.warn("bot save failed", e); }
  }
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        store = s || store;
        store.sessions = store.sessions || [];
        store.onboardProgress = store.onboardProgress || {};
        store.currentId = store.currentId || null;
        store.lastEval = store.lastEval || null;
        return true;
      }
    } catch (e) { console.warn("bot load failed", e); }
    return false;
  }

  /* ============================================================
     2. 中文分词（归一化 + 领域词典 + bigram）
     ============================================================ */
  function normalize(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[\u3000\u00a0]/g, " ")
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* 领域词典：同义词表的键与值，长词优先匹配 */
  const DOMAIN_TERMS = (() => {
    const set = new Set();
    Object.keys(SYNONYMS).forEach((k) => {
      set.add(k);
      (SYNONYMS[k] || []).forEach((v) => set.add(v));
    });
    PLUGIN_META.forEach(() => {});
    FAQS.forEach((f) => (f.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).filter((t) => t.length >= 2).sort((a, b) => b.length - a.length);
  })();
  const DOMAIN_SET = new Set(DOMAIN_TERMS);

  const STOP = new Set(STOPWORDS);

  function tokenize(text) {
    const norm = normalize(text);
    if (!norm) return [];
    const tokens = [];
    // 拉丁 token：英文单词、缩写、IP、版本号（如 ssh、mfa、pdf、169.254）
    // 必须先抽出，避免与中文黏连成整段（例："怎么把pdf转成word"）
    const latin = norm.match(/[a-z0-9][a-z0-9._-]*/g) || [];
    latin.forEach((w) => tokens.push(w));
    // 中文段：剔除拉丁 token 后分段，段内做领域词命中 + bigram
    const zhOnly = norm.replace(/[a-z0-9][a-z0-9._-]*/g, " ");
    zhOnly.split(" ").forEach((seg) => {
      if (!/[\u4e00-\u9fa5]/.test(seg)) return;
      DOMAIN_TERMS.forEach((t) => { if (seg.indexOf(t) >= 0) tokens.push(t); });
      const chars = seg.match(/[\u4e00-\u9fa5]/g) || [];
      if (chars.length === 1) tokens.push(chars[0]);
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
    });
    return tokens.filter((t) => !STOP.has(t));
  }

  /* 关键 token：领域词（含标签）与拉丁词。
     中文 bigram 噪声大（如「我密」「码忘」），不能作为置信度依据 */
  function keyTokens(tokens) {
    const set = new Set();
    tokens.forEach((t) => {
      if (DOMAIN_SET.has(t) || !/^[\u4e00-\u9fa5]+$/.test(t)) set.add(t);
    });
    return Array.from(set);
  }

  /* 概念扩展：命中同义词组任一词，把整组词注入查询 */
  function expandQuery(text) {
    const norm = normalize(text);
    const extra = [];
    const hitGroups = [];
    Object.keys(SYNONYMS).forEach((k) => {
      const group = [k].concat(SYNONYMS[k] || []);
      if (group.some((w) => norm.indexOf(w) >= 0)) {
        hitGroups.push(k);
        group.forEach((w) => { if (extra.indexOf(w) < 0) extra.push(w); });
      }
    });
    return { extra, groups: hitGroups };
  }

  /* ============================================================
     3. 索引构建（FAQ 语料）
     字段加权：标准问 3.0 / 口语问法 2.5 / 标签 3.0 / 结论 1.0；
     步骤文本仅取前 3 条并按 0.5 降权（长文本会造成词频膨胀、淹没判别词）
     ============================================================ */
  const FIELD_W = { q: 3.0, ask: 2.5, tags: 3.0, cat: 1.0, a: 1.0, steps: 0.5 };

  /* FAQ 意图极性：区分「故障类」与「申请类」，避免答非所问 */
  function faqPolarity(f) {
    const t = f.q + " " + (f.ask || []).join(" ");
    const req = /申请|开通/.test(t);
    const inc = /怎么办|失败|无法|连不上|上不了|打不开|异常|慢|卡|坏了|不能/.test(t);
    if (req && !inc) return "request";
    if (inc && !req) return "incident";
    return "any";
  }

  function buildDoc(f) {
    const tf = {};
    const add = (text, w) => {
      if (!text) return;
      tokenize(text).forEach((t) => { tf[t] = (tf[t] || 0) + w; });
    };
    add(f.q, FIELD_W.q);
    (f.ask || []).forEach((x) => add(x, FIELD_W.ask));
    add((f.tags || []).join(" "), FIELD_W.tags);
    add(f.cat, FIELD_W.cat);
    add(f.a, FIELD_W.a);
    (f.steps || []).slice(0, 3).forEach((x) => add(x, FIELD_W.steps));
    let len = 0;
    Object.keys(tf).forEach((t) => { len += tf[t]; });
    // 短语匹配用的候选文本（标准问 + 口语问法 + 标签）
    const candText = [f.q].concat(f.ask || []).concat(f.tags || [])
      .map((x) => normalize(x).replace(/\s+/g, "")).join("|");
    return { faq: f, tf, len, df: Object.keys(tf), polarity: faqPolarity(f), candText };
  }

  const DOCS = FAQS.map(buildDoc);

  const DF = {};
  DOCS.forEach((d) => d.df.forEach((t) => { DF[t] = (DF[t] || 0) + 1; }));
  const N = DOCS.length || 1;
  const AVG_LEN = DOCS.reduce((a, d) => a + d.len, 0) / N;

  function idf(t) {
    const n = DF[t] || 0;
    // 封顶：避免只在 1 篇出现的词拿到过高权重而压过真正有判别力的词
    return Math.min(Math.log(1 + (N - n + 0.5) / (n + 0.5)), 2.6);
  }

  /* 预计算文档 TF-IDF 归一化向量（语义层） */
  DOCS.forEach((d) => {
    const vec = {};
    let norm = 0;
    Object.keys(d.tf).forEach((t) => {
      const w = (1 + Math.log(d.tf[t])) * idf(t);
      vec[t] = w;
      norm += w * w;
    });
    norm = Math.sqrt(norm) || 1;
    Object.keys(vec).forEach((t) => { vec[t] = vec[t] / norm; });
    d.vec = vec;
  });

  /* ============================================================
     4. 三层打分
     ============================================================ */
  function bm25Scores(tokens) {
    const k1 = 1.5, b = 0.75;
    const qtf = {};
    tokens.forEach((t) => { qtf[t] = (qtf[t] || 0) + 1; });
    return DOCS.map((d) => {
      let s = 0;
      Object.keys(qtf).forEach((t) => {
        const f = d.tf[t] || 0;
        if (!f) return;
        const w = idf(t);
        if (w <= 0) return;
        // 领域词判别力最强；中文 bigram 噪声大，降权以免淹没判别词
        const isBigram = t.length === 2 && /^[\u4e00-\u9fa5]{2}$/.test(t);
        const boost = DOMAIN_SET.has(t) ? 1.8 : (isBigram ? 0.6 : 1);
        s += boost * w * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / (AVG_LEN || 1)));
      });
      return s;
    });
  }

  function cosineScores(qTokens, extraTokens) {
    const qv = {};
    let qn = 0;
    qTokens.forEach((t) => { qv[t] = (qv[t] || 0) + 1; });
    // 概念扩展词以低权重注入语义向量（仅用于补召回，不主导排序）
    extraTokens.forEach((t) => {
      tokenize(t).forEach((tk) => { qv[tk] = (qv[tk] || 0) + 0.25; });
      qv[t] = (qv[t] || 0) + 0.25;
    });
    Object.keys(qv).forEach((t) => {
      const w = (1 + Math.log(qv[t])) * idf(t);
      qv[t] = w;
      qn += w * w;
    });
    qn = Math.sqrt(qn) || 1;
    Object.keys(qv).forEach((t) => { qv[t] = qv[t] / qn; });

    return DOCS.map((d) => {
      let s = 0;
      Object.keys(qv).forEach((t) => { if (d.vec[t]) s += qv[t] * d.vec[t]; });
      return s;
    });
  }

  /* 概念覆盖层：查询直接命中的领域词权重 1.0，同义词扩展词权重 0.4 */
  function conceptScores(directTerms, extraTokens) {
    const list = [];
    directTerms.forEach((t) => list.push({ t, w: 1 }));
    extraTokens.forEach((t) => { if (directTerms.indexOf(t) < 0) list.push({ t, w: 0.4 }); });
    if (!list.length) return DOCS.map(() => 0);
    const total = list.reduce((a, x) => a + x.w, 0);
    return DOCS.map((d) => {
      let hit = 0;
      list.forEach((x) => {
        const tks = tokenize(x.t);
        const ok = tks.length ? tks.some((tk) => d.tf[tk]) : !!d.tf[x.t];
        if (ok) hit += x.w;
      });
      return hit / total;
    });
  }

  /* 短语层：查询与 FAQ 问法/标签的连续短语匹配（≥4 字）——最强的判别信号
     中文口语常在词组中间插入虚词（"申请个邮箱" / "重启一下打印机" / "想给新人开权限"），
     会让连续子串匹配失效，因此额外构造一条「去虚词」变体参与匹配（原串保留，只增不减）。 */
  const PARTICLE_WORDS = ["请问", "麻烦", "帮我", "帮忙", "我想", "想给", "帮忙给", "帮我给", "给", "一下", "个", "的", "了", "吧", "呢", "啊", "呀", "哦", "我", "想", "要"];
  function departicle(s) {
    let t = s;
    PARTICLE_WORDS.forEach((w) => { if (t.indexOf(w) >= 0) t = t.split(w).join(""); });
    return t;
  }
  function phraseScores(queryNorm) {
    const variants = [queryNorm.replace(/\s+/g, "")];
    const de = departicle(variants[0]);
    if (de.length >= 4 && de !== variants[0]) variants.push(de);
    return DOCS.map((d) => {
      let best = 0;
      variants.forEach((q) => {
        for (let len = Math.min(q.length, 14); len >= 4; len--) {
          let found = false;
          for (let i = 0; i + len <= q.length; i++) {
            if (d.candText.indexOf(q.slice(i, i + len)) >= 0) { best = Math.max(best, len / 10); found = true; break; }
          }
          if (found) break;
        }
      });
      return Math.min(best, 1);
    });
  }

  function minMax(arr) {
    const mx = Math.max.apply(null, arr);
    const mn = Math.min.apply(null, arr);
    if (mx === mn) return arr.map(() => 0);
    return arr.map((v) => (v - mn) / (mx - mn));
  }

  /**
   * 混合检索主入口
   * 关键词层 BM25（权重 0.40） + 语义层 TF-IDF 余弦（0.45） + 概念扩展（0.15）
   */
  /* 查询意图极性：申请类 vs 故障类 */
  const REQ_PAT = /申请|开通|需要开|帮我开|怎么开|办理|审批/;
  const INC_PAT = /失败|连不上|上不了|打不开|不能用|用不了|报错|异常|无法|没反应|没动静|坏了|故障|不工作|中断|没网|登不上|死机|蓝屏|卡住/;
  function queryPolarity(text) {
    const s = normalize(text);
    const r = REQ_PAT.test(s);
    const i = INC_PAT.test(s);
    if (r && !i) return "request";
    if (i && !r) return "incident";
    return "any";
  }

  function hybridSearch(queryText, topK) {
    const tokens = tokenize(queryText);
    const ex = expandQuery(queryText);
    const scores = [];
    if (!tokens.length && !ex.extra.length) {
      return { hits: scores, tokens, expansions: ex, level: "low", margin: 0, polarity: "any" };
    }

    const normQuery = normalize(queryText);
    const qp = queryPolarity(queryText);
    const directTerms = DOMAIN_TERMS.filter((t) => normQuery.indexOf(t) >= 0);
    const keys = keyTokens(tokens);
    // 绝对覆盖率：minMax 归一化会丢失绝对匹配度，必须用关键 token 覆盖情况兜底。
    // 只统计语料中真实出现过的关键 token，避免生僻词稀释分母
    const validKeys = keys.filter((k) => (DF[k] || 0) > 0);
    const cov = DOCS.map((d) => {
      if (!validKeys.length) return 0;
      let hit = 0;
      validKeys.forEach((k) => { if (d.tf[k]) hit++; });
      return hit / validKeys.length;
    });
    const bm = bm25Scores(tokens);
    const cs = cosineScores(tokens, ex.extra);
    const cn = conceptScores(directTerms, ex.extra);
    const ps = phraseScores(normQuery);
    const nbm = minMax(bm);
    const ncs = minMax(cs);
    const ncn = minMax(cn);
    const nps = minMax(ps);

    DOCS.forEach((d, i) => {
      let score = W.bm25 * nbm[i] + W.cosine * ncs[i] + W.concept * ncn[i] + W.phrase * nps[i];
      // 意图极性冲突时降权（例：问「VPN 连接失败」不应导向「如何申请 VPN」）
      let penalty = 1;
      if (qp !== "any" && d.polarity !== "any" && d.polarity !== qp) { score *= 0.5; penalty = 0.5; }
      if (score <= 0.001) return;
      scores.push({
        id: d.faq.id, faq: d.faq, score, polarity: d.polarity, penalty, cov: cov[i],
        detail: { bm25: +nbm[i].toFixed(3), cosine: +ncs[i].toFixed(3), concept: +ncn[i].toFixed(3), phrase: +nps[i].toFixed(3), cov: +cov[i].toFixed(3) },
      });
    });
    scores.sort((a, b) => b.score - a.score);

    // 置信度分级：融合分 + 绝对覆盖率 双门槛
    const top = scores[0];
    const second = scores[1];
    let level = "low";
    let margin = 0;
    if (top) {
      margin = second ? (top.score - second.score) / (top.score || 1) : 1;
      const d = top.detail;
      // 高置信需：融合分达标 + 至少一条强证据（关键覆盖 / 精确短语 / 关键词与语义同时强）+ 不歧义
      const strong = top.score >= 0.75 && d.bm25 >= 0.45 && d.cosine >= 0.45;
      const covered = top.cov >= CONF.minCov;
      const phrased = (d.phrase || 0) >= 0.4;
      if (top.score >= CONF.high && (covered || phrased || strong) && (margin >= CONF.margin || strong)) level = "high";
      else if (top.score >= CONF.mid && (covered || phrased || strong || margin >= CONF.margin)) level = "mid";
    }
    return {
      hits: topK ? scores.slice(0, topK) : scores,
      tokens, expansions: ex, level, margin: +margin.toFixed(3), polarity: qp,
      keys, coverage: top ? +top.cov.toFixed(3) : 0,
    };
  }

  /* ============================================================
     5. 检索评测（自助解决率回归）
     ============================================================ */
  function evaluate() {
    const rows = EVAL_SET.map((item) => {
      const r = hybridSearch(item.q);
      const top1 = r.hits[0];
      const top3 = r.hits.slice(0, 3);
      const hit1 = !!top1 && top1.id === item.e;
      const hit3 = top3.some((x) => x.id === item.e);
      // 自助解决 = 首条即正确 且 置信度达到「可直接作答」
      const selfResolved = hit1 && r.level === "high";
      return { q: item.q, expect: item.e, got: top1 ? top1.id : "—", score: top1 ? +top1.score.toFixed(3) : 0, level: r.level, hit1, hit3, selfResolved };
    });
    const total = rows.length || 1;
    const res = {
      at: nowISO(),
      total: rows.length,
      top1Hit: rows.filter((r) => r.hit1).length / total,
      top3Hit: rows.filter((r) => r.hit3).length / total,
      selfRate: rows.filter((r) => r.selfResolved).length / total,
      avgScore: rows.reduce((a, r) => a + r.score, 0) / total,
      rows,
    };
    store.lastEval = { at: res.at, total: res.total, top1Hit: res.top1Hit, top3Hit: res.top3Hit, selfRate: res.selfRate, avgScore: res.avgScore };
    save();
    return res;
  }

  /* ============================================================
     6. 会话 / 审计 / 回放
     ============================================================ */
  function newSession(silent) {
    const s = {
      id: uid("S"),
      user: "运维管理员",
      channel: "Web 助手",
      startedAt: nowISO(),
      endedAt: null,
      messages: [],
      tools: [],
      resolution: { level: null, resolved: null, ticketId: null, escalated: false },
    };
    store.sessions.unshift(s);
    store.currentId = s.id;
    if (!silent) save();
    return s;
  }
  function cur() {
    let s = store.sessions.find((x) => x.id === store.currentId);
    if (!s) s = newSession(true);
    return s;
  }
  function pushMsg(role, text, extra) {
    const m = Object.assign({ role, text: text || "", at: nowISO() }, extra || {});
    cur().messages.push(m);
    save();
    return m;
  }
  /** 工具调用审计（所有插件调用均落库，可追溯可回放） */
  function logTool(plugin, action, input, output, status, ms) {
    const rec = {
      id: uid("T"), plugin, action,
      input: typeof input === "string" ? input : JSON.stringify(input || {}),
      output: typeof output === "string" ? output : JSON.stringify(output || {}),
      status: status || "ok",
      ms: ms == null ? 0 : ms,
      at: nowISO(),
    };
    cur().tools.push(rec);
    save();
    return rec;
  }
  /** 带计时的工具调用包装 */
  function callTool(plugin, action, input, fn) {
    const t0 = Date.now();
    try {
      const out = fn();
      const rec = logTool(plugin, action, input, summarize(out), "ok", Date.now() - t0);
      return { out: out, rec: rec };
    } catch (e) {
      const rec = logTool(plugin, action, input, String(e && e.message ? e.message : e), "error", Date.now() - t0);
      return { out: null, rec: rec, error: e };
    }
  }
  function summarize(out) {
    if (out == null) return "";
    if (typeof out === "string") return out.slice(0, 200);
    if (out.summary) return String(out.summary).slice(0, 200);
    if (out.text) return String(out.text).slice(0, 200);
    try { return JSON.stringify(out).slice(0, 200); } catch (e) { return "…"; }
  }

  function closeSession() {
    const s = cur();
    s.endedAt = nowISO();
    save();
  }

  /* ============================================================
     7. 意图识别与工单分级推断
     ============================================================ */
  function detectIntent(text) {
    const s = normalize(text);
    if (!s) return "search";
    if (/(建|提|开|创建|发起|报).{0,3}(工单|单子|报障|故障单)|帮我建单|代建工单|报障|报修/.test(s)) return "ticket_create";
    if (/我的工单|工单进度|工单状态|查.{0,3}工单|工单.{0,3}(进度|状态)|inc\d{3,}/.test(s)) return "ticket_query";
    if (/入职|新人|新员工|新同事|报到|第一天|onboard/.test(s)) return "onboard";
    if (/诊断|排查|一步步|逐步|定位原因|帮我查原因|检测流程/.test(s)) return "diag";
    if (/转人工|找人工|人工服务|找工程师|叫工程师|升级为工单/.test(s)) return "escalate";
    return "search";
  }

  const CAT_RULES = [
    { cat: "网络", words: ["网络", "网线", "无线", "wifi", "wi-fi", "vpn", "dns", "ip", "断网", "连不上网", "上不了网", "上网", "交换机", "路由器", "带宽", "丢包", "延迟", "远程接入", "网关", "端口", "ping"] },
    { cat: "数据库", words: ["数据库", "mysql", "oracle", "sql", "主库", "从库", "慢查询", "db"] },
    { cat: "服务器", words: ["服务器", "主机", "cpu", "内存", "磁盘", "虚拟机", "宕机", "负载"] },
    { cat: "应用", words: ["系统", "应用", "服务", "接口", "页面", "erp", "crm", "oa", "订单", "业务系统", "502", "报错"] },
    { cat: "终端", words: ["电脑", "笔记本", "显示器", "键盘", "鼠标", "打印机", "开机", "蓝屏", "卡顿", "驱动", "office", "摄像头", "投屏", "扫描", "电池"] },
    { cat: "安全", words: ["病毒", "钓鱼", "木马", "勒索", "泄密", "加密", "攻击", "异常登录"] },
    { cat: "终端", words: ["账号", "密码", "登录", "权限", "邮箱", "邮件", "u盘", "共享盘"] },
  ];
  function inferCategory(text) {
    const s = normalize(text);
    for (let i = 0; i < CAT_RULES.length; i++) {
      if (CAT_RULES[i].words.some((w) => s.indexOf(normalize(w)) >= 0)) return CAT_RULES[i].cat;
    }
    return "其他";
  }
  const P1_WORDS = ["生产", "线上", "宕机", "中断", "瘫痪", "全公司", "所有人", "大面积", "都无法", "交易失败", "下单失败", "紧急", "p1", "重大故障", "全挂"];
  const P2_WORDS = ["多人", "部门", "整个", "团队", "无法办公", "影响业务", "关键", "重要", "p2", "好几个同事"];
  const P4_WORDS = ["咨询", "怎么", "如何", "优化", "建议", "想了解", "能不能", "流程是什么", "p4"];
  function inferPriority(text) {
    const s = normalize(text);
    if (P1_WORDS.some((w) => s.indexOf(w) >= 0)) return "P1";
    if (P2_WORDS.some((w) => s.indexOf(w) >= 0)) return "P2";
    if (P4_WORDS.some((w) => s.indexOf(w) >= 0)) return "P4";
    return "P3";
  }
  function slaTableText(pri) {
    return "P1 响应 " + SLA_RESPONSE.P1 + " / 解决 " + SLA_RESOLVE.P1 + "；" +
      "P2 响应 " + SLA_RESPONSE.P2 + " / 解决 " + SLA_RESOLVE.P2 + "；" +
      "P3 响应 " + SLA_RESPONSE.P3 + " / 解决 " + SLA_RESOLVE.P3 + "；" +
      "P4 响应 " + SLA_RESPONSE.P4 + " / 解决 " + SLA_RESOLVE.P4 + "。";
  }

  /* ============================================================
     8. 检索扩展到知识库与历史工单（RAG 的真实数据来源）
     ============================================================ */
  function scoreText(qTokens, text) {
    if (!qTokens.length) return 0;
    const set = new Set(tokenize(text));
    let hit = 0;
    qTokens.forEach((t) => { if (set.has(t)) hit++; });
    return hit / qTokens.length;
  }
  function mainState() {
    return (window.OpsDesk && window.OpsDesk.getState) ? window.OpsDesk.getState() : { incidents: [], cis: [], kb: [], requests: [], changes: [] };
  }
  function searchKB(text, limit) {
    const st = mainState();
    const qs = tokenize(text);
    return (st.kb || [])
      .map((a) => ({ item: a, score: scoreText(qs, (a.title || "") + " " + (a.tags || []).join(" ") + " " + (a.category || "") + " " + (a.content || "")) }))
      .filter((x) => x.score >= 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 3);
  }
  function searchIncidents(text, limit) {
    const st = mainState();
    const qs = tokenize(text);
    return (st.incidents || [])
      .map((i) => ({ item: i, score: scoreText(qs, (i.title || "") + " " + (i.desc || "") + " " + (i.category || "")) }))
      .filter((x) => x.score >= 0.14)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 3);
  }

  /* ============================================================
     9. 五个核心插件（统一契约）
     canHandle(text, ctx) -> 0..1 置信分；handle(text, ctx) -> 回复结构
     回复结构：{ text, cards:[], options:[], sources:[], level }
     ============================================================ */

  /* ---------- 插件 1：FAQ 知识库（自助排查，命中即答） ---------- */
  const faqPlugin = {
    id: "faq", name: "FAQ 知识库", icon: "📚",
    desc: "52 条高频问题，命中即给答案",
    canHandle(text, ctx) {
      return ctx.search && ctx.search.level === "high" ? 0.95 : 0;
    },
    handle(text, ctx) {
      const hit = ctx.search.hits[0];
      const f = hit.faq;
      const kbHits = searchKB(text, 2);
      const others = ctx.search.hits.slice(1, 3).filter((h) => h.score >= CONF.mid);
      return {
        level: "self",
        // 正文只给结论与命中提示，答案与处置步骤由 FAQ 卡片承载，避免同一段文案重复两遍
        text: "已为你找到答案（匹配度 " + Math.round(hit.score * 100) + "%）：**" + f.q + "**" +
          (others.length ? "\n\n若这不是你要问的，也可以看看：" + others.map((h) => h.faq.q).join(" / ") : ""),
        cards: [{ type: "faq", faq: f, score: hit.score, detail: hit.detail }],
        options: [
          { label: "👍 已解决", value: "__solved__" },
          { label: "👎 没解决，继续诊断", value: "__diag__" },
          { label: "转人工工单", value: "__ticket__" },
        ],
        sources: [{ id: f.id, type: "FAQ", title: f.q, score: hit.score }]
          .concat(kbHits.map((k) => ({ id: k.item.id, type: "KB", title: k.item.title, score: k.score }))),
      };
    },
  };

  /* ---------- 插件 2：语义检索 RAG（多来源召回 + 生成带引用的回答） ---------- */
  const ragPlugin = {
    id: "rag", name: "语义检索 RAG", icon: "🔎",
    desc: "从知识库与历史工单中检索并生成带引用的回答",
    canHandle(text, ctx) {
      if (ctx.search && ctx.search.level === "mid") return 0.72;
      return 0.30;
    },
    handle(text, ctx) {
      const raw = (ctx.search.hits || []).slice(0, 3);
      const good = raw.filter((h) => h.score >= 0.35);
      const hits = good.length ? good.slice(0, 2) : raw.slice(0, 1);
      const kbHits = searchKB(text, 3);
      const incHits = searchIncidents(text, 2);
      const top = hits[0];
      const ok = top && top.score >= 0.68;
      let body = "";
      if (!top) {
        body = "我没有在 IT 知识库中找到相关条目。你可以换个说法描述现象，或让我带你做一次故障诊断。";
      } else if (!ok) {
        body = "⚠️ 没有找到高度匹配的条目（最高匹配度仅 " + Math.round(top.score * 100) + "%）。以下内容仅供参考，建议改用故障诊断逐步定位：\n\n**" + top.faq.q + "**\n" + top.faq.a;
      } else {
        body = "我找到几个可能相关的问题，请确认为哪一个：\n\n**" + top.faq.q + "**（匹配度 " + Math.round(top.score * 100) + "%）\n" + top.faq.a;
        if (top.faq.steps && top.faq.steps.length) {
          body += "\n\n处理步骤：\n" + top.faq.steps.map((s, i) => (i + 1) + ". " + s).join("\n");
        }
      }
      const optList = hits.map((h) => ({ label: h.faq.q + "（" + Math.round(h.score * 100) + "%）", value: "__pick__:" + h.id }));
      optList.push({ label: "🔍 都不是，帮我逐步诊断", value: "__diag__" });
      optList.push({ label: "🎫 转人工工单", value: "__ticket__" });

      return {
        level: hits.length ? "diagnose" : "ticket",
        text: body,
        cards: [
          { type: "rag", hits: hits.map((h) => ({ id: h.id, q: h.faq.q, score: h.score, cat: h.faq.cat })) },
        ].concat(kbHits.length ? [{ type: "kbList", items: kbHits.map((k) => k.item) }] : [])
          .concat(incHits.length ? [{ type: "incList", items: incHits.map((k) => k.item) }] : []),
        options: optList,
        sources: hits.map((h) => ({ id: h.id, type: "FAQ", title: h.faq.q, score: h.score }))
          .concat(kbHits.map((k) => ({ id: k.item.id, type: "KB", title: k.item.title, score: k.score })))
          .concat(incHits.map((k) => ({ id: k.item.id, type: "工单", title: k.item.title, score: k.score }))),
      };
    },
  };

  /* ---------- 插件 3：故障诊断工作流（决策树逐步定位） ---------- */
  function recommendFlow(text) {
    const s = normalize(text);
    const rules = [
      { id: "wifi", words: ["wifi", "wi-fi", "无线", "信号", "掉线"] },
      { id: "vpn", words: ["vpn", "远程接入", "拨号", "远程办公"] },
      { id: "print", words: ["打印", "打印机", "队列", "文印"] },
      { id: "mail", words: ["邮件", "邮箱", "收发", "退信"] },
      { id: "slow", words: ["卡顿", "开机慢", "性能", "反应慢", "很卡"] },
      { id: "net", words: ["上网", "网络", "断网", "网线", "网关", "dns", "ip", "网页打不开", "连不上网"] },
      { id: "app", words: ["系统", "应用", "访问不了", "报错", "502", "打不开"] },
    ];
    let best = null, bestScore = 0;
    rules.forEach((r) => {
      const hit = r.words.filter((w) => s.indexOf(normalize(w)) >= 0).length;
      const score = hit / r.words.length;
      if (score > bestScore) { bestScore = score; best = r.id; }
    });
    return bestScore > 0 ? best : null;
  }
  function getFlow(id) { return FLOWS.find((f) => f.id === id); }
  function matchOption(node, text) {
    const s = normalize(text);
    const num = s.match(/^\s*(\d+)\s*$/);
    if (num) {
      const i = parseInt(num[1], 10) - 1;
      if (node.options && node.options[i]) return i;
    }
    let best = -1, bestScore = 0;
    const st = tokenize(text);
    (node.options || []).forEach((o, i) => {
      const label = normalize(o.label);
      if (label && (s.indexOf(label) >= 0 || label.indexOf(s) >= 0)) {
        if (label.length > bestScore) { bestScore = label.length; best = i; }
        return;
      }
      const lt = tokenize(o.label);
      const overlap = lt.filter((t) => st.indexOf(t) >= 0).length;
      const ratio = overlap / (lt.length || 1);
      if (ratio > bestScore) { bestScore = ratio; best = i; }
    });
    return bestScore >= 0.34 ? best : -1;
  }

  const diagPlugin = {
    id: "diag", name: "故障诊断工作流", icon: "🧭",
    desc: "7 条决策树流程，逐步定位故障根因",
    canHandle(text, ctx) {
      if (ctx.flow && ctx.flow.active) {
        const it = detectIntent(text);
        // 流程进行中优先，但用户明确切换到其它意图时让位（避免被困在流程里）
        if (it === "ticket_query" || it === "ticket_create" || it === "onboard") return 0;
        // 中途上报大面积故障：必须立刻让位给工单直达，不允许继续走决策树
        if (isBlast(text)) return 0;
        return 1.0;
      }
      if (detectIntent(text) === "diag") return 0.97;   // 用户显式要求诊断，优先于 FAQ 直答
      if (ctx.search && ctx.search.level === "low") return 0.60;
      return 0;
    },
    handle(text, ctx) {
      const s = ctx.session;
      // 已在流程中：推进节点
      if (s.flow && s.flow.active) return diagStep(s, text);
      // 启动流程
      const rec = recommendFlow(text);
      if (rec) return diagStart(s, rec);
      // 无明确指向：给出流程清单
      return {
        level: "diagnose",
        text: "我可以带你逐步排查。请选择最接近的故障场景，我会一问一答帮你定位：",
        cards: [{ type: "flowList", flows: FLOWS.map((f) => ({ id: f.id, name: f.name, cat: f.cat, icon: f.icon, sla: f.sla })) }],
        options: FLOWS.map((f) => ({ label: f.icon + " " + f.name, value: "__flow__:" + f.id }))
          .concat([{ label: "转人工工单", value: "__ticket__" }]),
        sources: [],
      };
    },
  };

  function diagStart(session, flowId) {
    const fl = getFlow(flowId);
    if (!fl) return { level: "diagnose", text: "未找到对应的诊断流程。", cards: [], options: [], sources: [] };
    session.flow = { id: flowId, nodeId: fl.start, active: true, path: [], startedAt: nowISO() };
    const node = fl.nodes[fl.start];
    return {
      level: "diagnose",
      text: "**" + fl.name + "**\n" + fl.intro + "\n\n" + renderNodeQuestion(node),
      cards: [{ type: "flow", flowId, name: fl.name, cat: fl.cat, sla: fl.sla, node: summarizeNode(node) }],
      options: flowOptions(node),
      sources: [],
      flowId,
    };
  }

  function renderNodeQuestion(node) {
    if (node.type === "result") return "";
    return "❓ " + node.q + (node.hint ? "\n（" + node.hint + "）" : "");
  }
  function summarizeNode(node) {
    if (node.type === "result") return { type: "result", title: node.title };
    return { type: node.type, q: node.q, options: (node.options || []).map((o) => o.label) };
  }
  function flowOptions(node) {
    if (!node || node.type === "result" || !node.options) return [];
    return node.options.map((o, i) => ({ label: (i + 1) + ". " + o.label, value: "__opt__:" + i }));
  }

  /** 推进一个诊断节点（返回回复结构） */
  function diagStep(session, input) {
    const flow = getFlow(session.flow.id);
    if (!flow) { session.flow = null; return { level: "diagnose", text: "诊断流程已失效，请重新选择。", cards: [], options: [], sources: [] }; }
    let node = flow.nodes[session.flow.nodeId];

    // 结论节点：展示结论并结束
    if (node.type === "result") return diagResult(session, flow, node);

    // 正常情况：node 应为 choice
    if (session.flow.pendingResult) {
      // 上一轮已给出结论，用户继续输入 → 重新解析
      session.flow.pendingResult = false;
    }
    const idx = matchOption(node, input);
    if (idx < 0) {
      return {
        level: "diagnose",
        text: "我没有理解你的选择，请从下面的选项中选择，或直接回复序号：\n\n" + renderNodeQuestion(node),
        cards: [],
        options: flowOptions(node),
        sources: [],
        keepFlow: true,
      };
    }
    const chosen = node.options[idx];
    session.flow.path.push({ q: node.q, a: chosen.label, at: nowISO() });
    session.flow.nodeId = chosen.next;
    const next = flow.nodes[chosen.next];
    if (!next) { session.flow = null; return { level: "diagnose", text: "流程配置异常，已结束。", cards: [], options: [], sources: [] }; }

    if (next.type === "result") {
      session.flow.pendingResult = true;
      return diagResult(session, flow, next);
    }
    // 若跳转到另一条流程（swipe）
    return {
      level: "diagnose",
      text: renderNodeQuestion(next),
      cards: [{ type: "flow", flowId: flow.id, name: flow.name, node: summarizeNode(next) }],
      options: flowOptions(next),
      sources: [],
      keepFlow: true,
    };
  }

  function diagResult(session, flow, node) {
    const level = node.level || "diag";
    const isTicket = level === "ticket";
    const opts = [];
    if (isTicket) {
      opts.push({ label: "✅ 按建议提交工单", value: "__create__:" + encodeURIComponent(node.ticketTitle || node.title) + "|" + (node.pri || "P3") + "|" + (node.cat || flow.cat) });
      opts.push({ label: "继续排查其他问题", value: "__diag__" });
    } else if (level === "diag") {
      if (node.swipe) opts.push({ label: "→ 转到「" + (getFlow(node.swipe) ? getFlow(node.swipe).name : "相关流程") + "」", value: "__flow__:" + node.swipe });
      opts.push({ label: "按建议处理后已解决", value: "__solved__" });
      opts.push({ label: "仍未解决，转人工工单", value: "__ticket__" });
    } else {
      opts.push({ label: "👍 已解决", value: "__solved__" });
      opts.push({ label: "还是不行，转人工工单", value: "__ticket__" });
    }
    session.flow = isTicket || level === "self" ? null : session.flow;
    if (session.flow) session.flow.active = true;

    return {
      level,
      text: (isTicket ? "⚠️ " : level === "self" ? "✅ " : "🔍 ") + "**" + node.title + "**\n\n" + node.text +
        (node.steps && node.steps.length ? "\n\n建议操作：\n" + node.steps.map((s, i) => (i + 1) + ". " + s).join("\n") : "") +
        (isTicket ? "\n\n推荐工单：**" + (node.ticketTitle || node.title) + "**｜建议优先级 **" + (node.pri || "P3") + "**（响应 " + SLA_RESPONSE[node.pri || "P3"] + "，解决 " + SLA_RESOLVE[node.pri || "P3"] + "，处理方：" + SLA_OWNER[node.pri || "P3"] + "）" : ""),
      cards: [{ type: "result", level, title: node.title, pri: node.pri, cat: node.cat || flow.cat, steps: node.steps || [] }],
      options: opts,
      sources: [{ id: flow.id, type: "诊断流程", title: flow.name, score: 1 }],
      keepFlow: !isTicket,
    };
  }

  /* ---------- 插件 4：工单系统（对话中建单 / 查单，SLA 分级） ---------- */
  /* 大面积影响（P1 级）的故障特征词：命中即跳过自助与诊断，直达人工按 SLA 开单 */
  const P1_BLAST = ["全公司", "全体", "全员", "全线", "整个公司", "所有人都", "大面积", "批量", "全部报错",
    "生产系统", "核心系统", "交易失败", "下单失败", "重大故障", "瘫痪", "全挂了", "整体不可用", "全部系统不可用"];
  const HOWTO_PAT = /怎么|如何|怎样|能否|能不能|想了解|流程是|咨询|申请|需要开|在哪/;
  /** 是否为「大面积故障」：既要有影响面特征词，也要是故障描述而非咨询问法 */
  function isBlast(text) {
    const s = normalize(text);
    if (!s || HOWTO_PAT.test(s)) return false;
    return P1_BLAST.some((w) => s.indexOf(w) >= 0) && INC_PAT.test(s);
  }

  const ticketPlugin = {
    id: "ticket", name: "工单系统", icon: "🎫",
    desc: "对话中直接建单、查进度，按 SLA 分级响应",
    canHandle(text, ctx) {
      const i = detectIntent(text);
      if (i === "ticket_create" || i === "ticket_query" || i === "escalate") return 0.98;
      if (isBlast(text)) return 0.96;   // 大面积故障优先于 FAQ 自助直答
      if (ctx.search && ctx.search.level === "low" && detectIntent(text) === "search") return 0.40;
      return 0;
    },
    handle(text, ctx) {
      const intent = detectIntent(text);
      if (intent === "ticket_query") return ticketQuery(text);
      if (intent === "ticket_create" && !/^(转人工|找人工|人工服务|叫工程师)/.test(normalize(text))) {
        return ticketCreate(text, ctx);
      }
      if (isBlast(text)) return ticketBlast(text, ctx);
      return ticketEscalate(text, ctx);
    },
  };

  /** 大面积故障直达：不走自助/逐步诊断，直接按 P1 开单并锁定 7×24 应急值守 */
  function ticketBlast(text, ctx) {
    const title = buildTicketTitle(text, ctx);
    const out = ticketCreate(text, { session: ctx.session, pendingTitle: title });
    if (!out || !out.cards || !out.cards[0] || out.cards[0].type !== "ticket") return out;
    const tk = out.cards[0].ticket;
    tk.priority = "P1";
    out.cards[0].response = SLA_RESPONSE.P1;
    out.cards[0].resolve = SLA_RESOLVE.P1;
    out.cards[0].owner = SLA_OWNER.P1;
    out.cards.unshift({ type: "blast", title: title, pri: "P1", ticketId: tk.id });
    out.text = "⚠️ 识别到**大面积影响**的故障，已跳过自助排查与逐步诊断，**直达人工**并按 **P1 紧急** 立即开单。\n\n" +
      out.text
        .replace(/优先级：P\d（自动按影响面判定）/, "优先级：P1（大面积影响，自动升级）")
        .replace(/响应时限：[^｜]*｜解决时限：[^\n]*/, "响应时限：" + SLA_RESPONSE.P1 + "｜解决时限：" + SLA_RESOLVE.P1) +
      "\n\n请尽快同步影响范围与已尝试的操作，应急值守会立即介入。";
    if (window.OpsDesk) {
      const inc = mainState().incidents.find((x) => x.id === tk.id);
      if (inc) { inc.priority = "P1"; inc.blast = true; window.OpsDesk.save(); window.OpsDesk.refresh(); }
    }
    logTool("ticket", "blast_escalate", { query: text, matched: P1_BLAST.filter((w) => normalize(text).indexOf(w) >= 0) },
      { ticketId: tk.id, priority: "P1", sla: SLA_RESPONSE.P1 + " / " + SLA_RESOLVE.P1 }, "ok", 0);
    return out;
  }

  function nextTicketId() {
    const st = mainState();
    let id;
    let guard = 0;
    do {
      id = "INC" + String(Math.floor(Math.random() * 9000) + 1000);
      guard++;
    } while ((st.incidents || []).some((x) => x.id === id) && guard < 50);
    return id;
  }

  function ticketCreate(text, ctx) {
    const st = mainState();
    const title = buildTicketTitle(text, ctx);
    const pri = inferPriority(text);
    const cat = inferCategory(text);
    const id = nextTicketId();
    const now = window.OpsDesk ? window.OpsDesk.util.nowISO() : nowISO();
    const inc = {
      id: id,
      title: title,
      desc: "由 IT 智能助手创建。原始描述：" + text + (ctx.session.id ? "\n会话编号：" + ctx.session.id : ""),
      status: "open",
      priority: pri,
      category: cat,
      assignee: "待分派",
      requester: "IT 智能助手",
      ciId: null,
      approval: "none", approver: "", approvalNote: "", approvalLog: [],
      createdAt: now, updatedAt: now, resolvedAt: null,
      source: "AI 助手",
      sourceSession: ctx.session.id,
    };
    if (window.OpsDesk) {
      st.incidents.unshift(inc);
      window.OpsDesk.save();
      window.OpsDesk.refresh();
    } else {
      return { level: "ticket", text: "主系统未就绪，无法创建工单。", cards: [], options: [], sources: [] };
    }
    ctx.session.resolution.level = "ticket";
    ctx.session.resolution.ticketId = id;
    return {
      level: "ticket",
      text: "已为你创建工单 **" + id + "**：**" + title + "**\n\n" +
        "• 分类：" + cat + "\n• 优先级：" + pri + "（自动按影响面判定）\n" +
        "• 响应时限：" + SLA_RESPONSE[pri] + "｜解决时限：" + SLA_RESOLVE[pri] + "\n" +
        "• 处理方：" + SLA_OWNER[pri] + "\n\n" +
        "SLA 分级说明：" + slaTableText(pri) + "\n\n你可以在「事件管理」中查看该工单的 SLA 倒计时。",
      cards: [{ type: "ticket", ticket: inc, response: SLA_RESPONSE[pri], resolve: SLA_RESOLVE[pri], owner: SLA_OWNER[pri] }],
      options: [
        { label: "查看我的工单", value: "__ticketlist__" },
        { label: "继续咨询其他问题", value: "__reset__" },
      ],
      sources: [{ id: id, type: "工单", title: title, score: 1 }],
      ticketId: id,
    };
  }

  function buildTicketTitle(text, ctx) {
    // 若来自诊断结论或选项，优先使用建议标题
    if (ctx && ctx.pendingTitle) return ctx.pendingTitle;
    if (ctx && ctx.search && ctx.search.hits[0] && ctx.search.level !== "low") {
      const f = ctx.search.hits[0].faq;
      return f.q.replace(/[？?]$/, "").slice(0, 40);
    }
    let t = normalize(text).replace(/^(帮我|请|麻烦|我想|我要|需要|请帮我|帮我建个|提个)/, "").trim();
    if (t.length > 40) t = t.slice(0, 40);
    return t || "IT 支持请求";
  }

  function ticketQuery(text) {
    const st = mainState();
    const m = normalize(text).match(/inc\d{3,}/);
    let list;
    if (m) {
      const id = m[0].toUpperCase();
      list = (st.incidents || []).filter((i) => i.id.toUpperCase().indexOf(id) >= 0);
    } else {
      list = (st.incidents || []).slice(0, 6);
    }
    if (!list.length) {
      return { level: "ticket", text: "没有找到匹配的工单。你可以说「帮我建工单」来创建一个。", cards: [], options: [{ label: "帮我建工单", value: "__ticket__" }], sources: [] };
    }
    const lines = list.map((i) => {
      const sla = window.OpsDesk ? window.OpsDesk.util.slaInfo(i) : { text: "—" };
      return "• **" + i.id + "** " + i.title + "\n　状态：" + i.status + "｜优先级：" + i.priority + "｜SLA：" + sla.text + "｜负责人：" + (i.assignee || "待分派");
    });
    return {
      level: "ticket",
      text: "为你查到 " + list.length + " 条工单：\n\n" + lines.join("\n") +
        "\n\nSLA 分级响应：" + slaTableText("P1"),
      cards: [{ type: "ticketList", items: list, slaHours: SLA_RESOLVE }],
      options: [{ label: "只看 P1/P2 高优先级", value: "__ticketlist_high__" }, { label: "帮我建工单", value: "__ticket__" }],
      sources: list.map((i) => ({ id: i.id, type: "工单", title: i.title, score: 1 })),
    };
  }

  function ticketEscalate(text, ctx) {
    const pri = inferPriority(text) === "P4" ? "P3" : inferPriority(text);
    const cat = inferCategory(text);
    const title = (ctx && ctx.pendingTitle) ? ctx.pendingTitle : ("［转人工］" + (normalize(text).slice(0, 28) || "用户请求人工支持"));
    return {
      level: "ticket",
      text: "好的，我将转人工处理。请确认是否按以下信息建单（可先在下方选择优先级，或直接确认）：\n\n" +
        "• 标题：" + title + "\n• 分类：" + cat + "\n• 建议优先级：" + pri + "（响应 " + SLA_RESPONSE[pri] + " / 解决 " + SLA_RESOLVE[pri] + "）",
      cards: [{ type: "escalate", title, cat, pri }],
      options: [
        { label: "确认建单（" + pri + "）", value: "__create__:" + encodeURIComponent(title) + "|" + pri + "|" + cat },
        { label: "改为 P1 紧急", value: "__create__:" + encodeURIComponent(title) + "|P1|" + cat },
        { label: "改为 P2 重要", value: "__create__:" + encodeURIComponent(title) + "|P2|" + cat },
        { label: "先不建单", value: "__reset__" },
      ],
      sources: [],
    };
  }

  /* ---------- 插件 5：新员工入职指引 ---------- */
  function onboardStats() {
    const all = ONBOARD.stages.reduce((a, s) => a.concat(s.items), []);
    const done = all.filter((i) => store.onboardProgress[i.id]).length;
    return { total: all.length, done, pct: all.length ? Math.round((done / all.length) * 100) : 0 };
  }

  const onboardPlugin = {
    id: "onboard", name: "新员工入职指引", icon: "🎓",
    desc: "四阶段清单，进度可保存",
    canHandle(text, ctx) {
      if (detectIntent(text) !== "onboard") return 0;
      const s = normalize(text);
      // 泛化的入职咨询走指引；具体问题（如「新员工账号怎么开通」）让检索优先
      if (/(指引|流程|准备|做什么|要做什么|清单|checklist|入职需要|新人需要|安排|规划|带什么)/.test(s)) return 0.96;
      return 0.55;
    },
    handle(text, ctx) {
      const st = onboardStats();
      const stageOpts = ONBOARD.stages.map((s) => {
        const done = s.items.filter((i) => store.onboardProgress[i.id]).length;
        return { label: s.name + "（" + done + "/" + s.items.length + "）", value: "__stage__:" + s.id };
      });
      return {
        level: "self",
        text: "**" + ONBOARD.title + "**\n" + ONBOARD.intro + "\n\n当前进度：**" + st.done + "/" + st.total + "** 项（" + st.pct + "%）。\n\n选择阶段查看详情，也可直接说「IT 账号怎么开通」这类具体问题。",
        cards: [{ type: "onboard", stages: ONBOARD.stages, progress: store.onboardProgress, overall: st }],
        options: stageOpts.concat([
          { label: "🔑 账号密码怎么弄", value: "__ask__:忘记域账号密码怎么重置" },
          { label: "🔐 MFA 怎么绑定", value: "__ask__:双因素认证MFA如何绑定" },
          { label: "📶 怎么连 Wi-Fi 和 VPN", value: "__ask__:vpn怎么连" },
        ]),
        sources: [],
      };
    },
  };

  const PLUGINS = [onboardPlugin, ticketPlugin, diagPlugin, faqPlugin, ragPlugin];

  /* ============================================================
     10. 分级服务编排器
     自助排查(FAQ) → 智能诊断(RAG/工作流) → 人工工单，按置信度自动升级
     ============================================================ */
  function route(text, ctx) {
    const scored = PLUGINS.map((p) => ({ p, score: p.canHandle(text, ctx) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.length ? scored[0] : { p: ragPlugin, score: 0.3 };
  }

  /** 主入口：处理一条用户输入，返回机器人回复结构并落库 */
  function ask(text) {
    const session = cur();
    pushMsg("user", text, { channel: "web" });

    const ctx = { session, flow: session.flow || null };
    const t0 = Date.now();
    const search = hybridSearch(text, 5);
    ctx.search = search;
    logTool("engine", "hybrid_search", { query: text, weights: W },
      { level: search.level, top: search.hits[0] ? search.hits[0].id : null, score: search.hits[0] ? +search.hits[0].score.toFixed(3) : 0, expansions: search.expansions.groups },
      "ok", Date.now() - t0);

    const r = route(text, ctx);
    // 用户切换到其它插件时，自动结束挂起的诊断流程（留审计痕迹）
    if (session.flow && session.flow.active && r.p.id !== "diag") {
      logTool("diag", "flow_abort", { flowId: session.flow.id, to: r.p.id, reason: "user_switch" },
        "已结束挂起的诊断流程（用户切换到「" + r.p.name + "」）", "ok", 0);
      session.flow = null;
    }
    const tr = callTool(r.p.id, "handle", { query: text, intent: detectIntent(text) }, () => r.p.handle(text, ctx));
    const out = tr.out || { level: "ticket", text: "处理出现异常，已记录审计日志。", cards: [], options: [{ label: "转人工工单", value: "__ticket__" }], sources: [] };

    // 解决结果落库
    if (out.level === "self" && !session.resolution.level) session.resolution.level = "self";
    if (out.level === "diagnose" && session.resolution.level !== "ticket") session.resolution.level = "diagnose";
    session.resolution.resolved = session.resolution.resolved || null;
    if (!/结束/.test(text)) save();

    const msg = pushMsg("bot", out.text, {
      plugin: r.p.id, pluginName: r.p.name, level: out.level,
      confidence: search.hits[0] ? +search.hits[0].score.toFixed(3) : 0,
      cards: out.cards || [], options: out.options || [],
      sources: out.sources || [], keepFlow: !!out.keepFlow,
      audit: { tokens: search.tokens, expansions: search.expansions.extra.slice(0, 12), level: search.level, margin: search.margin, polarity: search.polarity },
    });
    return { message: msg, plugin: r.p, result: out, search };
  }

  /** 处理选项/动作点击（与自由输入共用审计链路） */
  function act(value, label) {
    const session = cur();
    if (label) pushMsg("user", label, { channel: "button", action: value });

    // 诊断选项
    if (value.indexOf("__opt__:") === 0) {
      const idx = parseInt(value.split(":")[1], 10) + 1;
      return ask(String(idx));
    }
    if (value.indexOf("__pick__:") === 0) return ask(value.split(":")[1] + " " + (FAQbyId(value.split(":")[1]) ? FAQbyId(value.split(":")[1]).q : ""));
    if (value.indexOf("__ask__:") === 0) return ask(value.slice(8));
    if (value.indexOf("__flow__:") === 0) {
      const r = callTool("diag", "start_flow", { flowId: value.split(":")[1] }, () => diagStart(session, value.split(":")[1]));
      return finalize("diag", r.out);
    }
    if (value.indexOf("__create__:") === 0) {
      const raw = decodeURIComponent(value.slice(11));
      const parts = raw.split("|");
      const title = parts[0], pri = parts[1] || "P3", cat = parts[2] || "其他";
      const r = callTool("ticket", "create", { title, pri, cat }, () => ticketCreate("（来自诊断流程）" + title, { session, pendingTitle: title }));
      const out = r.out;
      // 覆盖优先级 / 分类为用户选择值
      if (out && out.cards && out.cards[0] && out.cards[0].type === "ticket") {
        const tk = out.cards[0].ticket;
        tk.priority = pri; tk.category = cat;
        out.cards[0].response = SLA_RESPONSE[pri]; out.cards[0].resolve = SLA_RESOLVE[pri]; out.cards[0].owner = SLA_OWNER[pri];
        out.text = out.text.replace(/优先级：[^\n]*/, "优先级：" + pri + "（按诊断结论选定）")
          .replace(/响应时限：[^\n]*/, "响应时限：" + SLA_RESPONSE[pri] + "｜解决时限：" + SLA_RESOLVE[pri]);
        if (window.OpsDesk) {
          const inc = mainState().incidents.find((x) => x.id === tk.id);
          if (inc) { inc.priority = pri; inc.category = cat; window.OpsDesk.save(); window.OpsDesk.refresh(); }
        }
      }
      return finalize("ticket", out);
    }
    if (value === "__ticket__") {
      const lastUser = lastUserText(session);
      const r = callTool("ticket", "escalate", { from: lastUser }, () => ticketEscalate(lastUser, { session }));
      return finalize("ticket", r.out);
    }
    if (value === "__diag__") {
      const lastUser = lastUserText(session);
      const rec = recommendFlow(lastUser);
      const r = callTool("diag", "start_flow", { query: lastUser, recommended: rec },
        () => (rec ? diagStart(session, rec) : diagPlugin.handle(lastUser, { session, search: hybridSearch(lastUser, 5) })));
      return finalize("diag", r.out);
    }
    if (value === "__solved__") {
      session.resolution.resolved = true;
      session.resolution.level = session.resolution.level || "self";
      session.flow = null;
      save();
      return finalize("engine", {
        level: "self", text: "很好，问题已解决 ✅ 本次服务全程已记录在审计日志中。有其它问题随时问我。",
        cards: [{ type: "closed", resolution: session.resolution }],
        options: [{ label: "继续咨询", value: "__reset__" }], sources: [],
      });
    }
    if (value === "__ticketlist__" || value === "__ticketlist_high__") {
      const st = mainState();
      let list = st.incidents || [];
      if (value === "__ticketlist_high__") list = list.filter((i) => i.priority === "P1" || i.priority === "P2");
      list = list.slice(0, 6);
      return finalize("ticket", {
        level: "ticket", text: list.length ? ("共 " + list.length + " 条：") : "暂无工单。",
        cards: [{ type: "ticketList", items: list }], options: [{ label: "帮我建工单", value: "__ticket__" }], sources: [],
      });
    }
    if (value === "__reset__") return ask("你好");
    if (value.indexOf("__stage__:") === 0) {
      const sid = value.split(":")[1];
      session.onboardStage = sid;   // 记住当前阶段，勾选后原地刷新而非跳回总览
      const stage = ONBOARD.stages.find((s) => s.id === sid);
      if (!stage) return finalize("onboard", { level: "self", text: "未找到该阶段。", cards: [], options: [], sources: [] });
      const done = stage.items.filter((i) => store.onboardProgress[i.id]).length;
      const all = onboardStats();
      return finalize("onboard", {
        level: "self",
        text: "**" + stage.name + "**（归属：" + stage.owner + "）\n本阶段进度 " + done + "/" + stage.items.length +
          "，总体进度 " + all.done + "/" + all.total + "（" + all.pct + "%）。点击条目可打勾/取消：",
        cards: [{ type: "stage", stage, progress: store.onboardProgress }],
        options: stage.items.map((i) => ({ label: (store.onboardProgress[i.id] ? "☑ " : "☐ ") + i.t, value: "__toggle__:" + i.id }))
          .concat([{ label: "← 返回阶段总览", value: "__onboard__" }]),
        sources: [],
      });
    }
    if (value.indexOf("__toggle__:") === 0) {
      const iid = value.split(":")[1];
      store.onboardProgress[iid] = !store.onboardProgress[iid];
      save();
      const back = session.onboardStage;
      if (back && ONBOARD.stages.some((s) => s.id === back)) return act("__stage__:" + back, null);
      return act("__onboard__", null);
    }
    if (value === "__onboard__") {
      const r = callTool("onboard", "overview", {}, () => onboardPlugin.handle("入职", { session }));
      return finalize("onboard", r.out);
    }
    return finalize("engine", { level: "self", text: "已收到。", cards: [], options: [], sources: [] });
  }

  function finalize(pluginId, out) {
    const session = cur();
    const o = out || { level: "ticket", text: "处理异常，已记录审计日志。", cards: [], options: [], sources: [] };
    if (o.level === "self" && !session.resolution.level) session.resolution.level = "self";
    save();
    const msg = pushMsg("bot", o.text, {
      plugin: pluginId, level: o.level, cards: o.cards || [], options: o.options || [],
      sources: o.sources || [], keepFlow: !!o.keepFlow, fromAction: true,
    });
    return { message: msg, result: o };
  }

  function FAQbyId(id) { return FAQS.find((f) => f.id === id); }
  function lastUserText(session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === "user") return session.messages[i].text;
    }
    return "";
  }

  /* ---------- 统计（供看板与审计使用） ---------- */
  function stats() {
    const ss = store.sessions || [];
    const total = ss.length;
    let msgs = 0, tools = 0, selfN = 0, diagN = 0, ticketN = 0, resolved = 0, noTicket = 0;
    const pluginUse = {};
    ss.forEach((s) => {
      msgs += (s.messages || []).length;
      tools += (s.tools || []).length;
      const r = s.resolution || {};
      const escalated = !!r.ticketId;
      if (escalated) ticketN++;
      else { noTicket++; if (r.level === "diagnose") diagN++; else selfN++; }
      if (r.resolved) resolved++;
      (s.tools || []).forEach((t) => { pluginUse[t.plugin] = (pluginUse[t.plugin] || 0) + 1; });
    });
    return {
      sessions: total, messages: msgs, toolCalls: tools,
      self: selfN, diagnose: diagN, ticket: ticketN, resolved: resolved,
      deflectRate: total ? noTicket / total : 0,     // 自助解决率 = 未转人工占比
      escalateRate: total ? ticketN / total : 0,
      avgTurns: total ? msgs / total / 2 : 0,
      pluginUse: pluginUse,
      lastEval: store.lastEval,
    };
  }

  /* ---------- 演示会话种子（审计与看板开箱即有数据） ---------- */
  function seedDemo() {
    const now = Date.now();
    const iso = (h) => new Date(now - h * 3600000).toISOString();
    const nameOf = (id) => (PLUGIN_META.find((x) => x.id === id) || {}).name || id;
    const defs = [
      { h: 1, res: { level: "self", resolved: true, ticketId: null }, turns: [
        { u: "我密码忘了进不去系统了", b: "已为你找到答案（匹配度 94%）：忘记域账号密码，如何重置？— 通过自助密码重置门户重置，或联系服务台人工重置。", p: "faq", lv: "self", cf: 0.94 }] },
      { h: 3, res: { level: "self", resolved: true, ticketId: null }, turns: [
        { u: "公司Wi-Fi老是掉线", b: "已为你找到答案（匹配度 91%）：Wi-Fi 连不上或频繁掉线怎么办？— 先判断单设备问题还是区域覆盖问题。", p: "faq", lv: "self", cf: 0.91 }] },
      { h: 5, res: { level: "self", resolved: true, ticketId: null }, turns: [
        { u: "帮我诊断一下打印机", b: "打印故障诊断：你的打印机是怎么连接的？", p: "diag", lv: "diagnose" },
        { u: "1", b: "ping 打印机 IP 能否通？", p: "diag", lv: "diagnose" },
        { u: "能 ping 通", b: "打印队列里是否有卡住不动的任务？", p: "diag", lv: "diagnose" },
        { u: "有卡住的任务", b: "✅ 打印队列卡死，清空后即可恢复 — 清空队列并重启 Print Spooler 服务。", p: "diag", lv: "self" }] },
      { h: 8, res: { level: "ticket", resolved: null, ticketId: "INC1001" }, turns: [
        { u: "财务系统全公司都打不开了", b: "已为你创建工单（P1 紧急）：响应 15 分钟 / 解决 4 小时，7×24 应急值守。", p: "ticket", lv: "ticket" }] },
      { h: 12, res: { level: "self", resolved: true, ticketId: null }, turns: [
        { u: "新人入职电脑要准备什么", b: "新员工 IT 入职指引：四阶段 21 项清单，当前进度 0/21。", p: "onboard", lv: "self", cf: 0.92 }] },
      { h: 20, res: { level: "self", resolved: true, ticketId: null }, turns: [
        { u: "在家连vpn连不上", b: "已为你找到答案（匹配度 88%）：VPN 连接失败怎么办？— 按账号→客户端→网络→证书顺序排查。", p: "faq", lv: "self", cf: 0.88 }] },
      { h: 26, res: { level: "self", resolved: true, ticketId: null }, turns: [
        { u: "邮箱提示容量满了", b: "已为你找到答案（匹配度 93%）：邮箱容量已满怎么办？— 先清空已删除邮件与大附件。", p: "faq", lv: "self", cf: 0.93 }] },
      { h: 30, res: { level: "self", resolved: true, ticketId: null }, turns: [
        { u: "会议室投屏连不上急着开会", b: "已为你找到答案（匹配度 90%）：会议室投屏连不上怎么办？— 有线投屏优先，或核对投屏码与同网段。", p: "faq", lv: "self", cf: 0.90 }] },
      { h: 36, res: { level: "self", resolved: false, ticketId: null }, turns: [
        { u: "同事的电脑一直蓝屏", b: "已为你找到答案（匹配度 86%）：电脑蓝屏、死机或自动重启怎么办？— 记录错误码并排查驱动与内存。", p: "faq", lv: "self", cf: 0.86 }] },
      { h: 44, res: { level: "diagnose", resolved: null, ticketId: null }, turns: [
        { u: "要申请一个共享盘的读写权限", b: "最接近的问题是：如何申请共享盘访问权限？（匹配度 72%）— 由目录归属部门负责人审批。", p: "rag", lv: "diagnose", cf: 0.72 }] },
    ];
    /* 用 FAQ 语料再派生一批自助会话，使演示数据的运营口径自助解决率贴近真实水位（≥95%） */
    const FAQ_SEED = ["FAQ07", "FAQ09", "FAQ11", "FAQ13", "FAQ18", "FAQ21", "FAQ24", "FAQ29",
      "FAQ33", "FAQ36", "FAQ41", "FAQ45", "FAQ48", "FAQ50"];
    FAQ_SEED.forEach((id, i) => {
      const f = FAQS.find((x) => x.id === id);
      if (!f) return;
      const cf = 0.79 + (i % 6) * 0.03;
      defs.push({
        h: 48 + i * 4,
        res: { level: "self", resolved: true, ticketId: null },
        turns: [{
          u: (f.ask && f.ask[0]) || f.q,
          b: "已为你找到答案（匹配度 " + Math.round(cf * 100) + "%）：**" + f.q + "**",
          p: "faq", lv: "self", cf: cf,
        }],
      });
    });
    store.sessions = defs.map((d) => {
      const at = iso(d.h);
      const s = {
        id: uid("S"), user: "运维管理员", channel: "Web 助手",
        startedAt: at, endedAt: new Date(new Date(at).getTime() + 240000).toISOString(),
        messages: [], tools: [],
        resolution: { level: d.res.level, resolved: d.res.resolved, ticketId: d.res.ticketId, escalated: !!d.res.ticketId },
      };
      d.turns.forEach((t, i) => {
        const tAt = new Date(new Date(at).getTime() + i * 60000).toISOString();
        s.messages.push({ role: "user", text: t.u, at: tAt, channel: "web" });
        s.messages.push({
          role: "bot", text: t.b, at: tAt, plugin: t.p, pluginName: nameOf(t.p), level: t.lv,
          confidence: t.cf || 0.8, cards: [], options: [], sources: [],
          audit: { tokens: [], expansions: [], level: t.lv },
        });
        s.tools.push({ id: uid("T"), plugin: "engine", action: "hybrid_search", input: JSON.stringify({ query: t.u }), output: JSON.stringify({ level: t.lv, score: t.cf || 0.8 }), status: "ok", ms: 2 + i, at: tAt });
        s.tools.push({ id: uid("T"), plugin: t.p, action: "handle", input: JSON.stringify({ query: t.u }), output: "ok", status: "ok", ms: 1 + i, at: tAt });
      });
      return s;
    });
    store.currentId = null;
    save();
  }

  function ensureInit() {
    if (!load()) seedDemo();
  }

  /* ============ 引擎对外 API（UI 层再挂载 render 等方法） ============ */
  return {
    // 状态
    get store() { return store; },
    save, load, cur, newSession, closeSession, pushMsg, logTool, callTool, summarize,
    // 检索
    tokenize, normalize, expandQuery, hybridSearch, evaluate, scoreText, searchKB, searchIncidents,
    // 编排与插件
    ask, act, route, stats, PLUGINS, PLUGIN_META, mainState,
    faqPlugin, ragPlugin, diagPlugin, ticketPlugin, onboardPlugin,
    recommendFlow, getFlow, onboardStats, seedDemo, ensureInit,
    // 常量
    FAQS, FLOWS, ONBOARD, EVAL_SET, SYNONYMS,
    SLA_RESPONSE, SLA_RESOLVE, SLA_OWNER, CONF, W,
    // 工具
    uid, nowISO, fmtTime, detectIntent, inferCategory, inferPriority, slaTableText,
    _internal: {},
  };
})();
