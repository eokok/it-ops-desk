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

  /* 服务台与值班口径（单一来源，禁止在文案里另写死号码） */
  const DUTY_PHONE = "400-1111-2222";        // IT 值班热线，紧急问题必须立即告知
  const DESK_EXT = "分机 6000";               // 内部分机（非紧急）
  const EMERGENCY_TYPES = "大面积故障、生产中断、安全事件（勒索病毒 / 数据泄露 / 钓鱼入侵）";
  /** 紧急告知话术：原则 4 —— 紧急问题必须立即告知值班电话 */
  function hotlineLine(scene) {
    return "📞 **紧急问题请立即致电 IT 值班热线 " + DUTY_PHONE + "**（7×24 值守）" +
      (scene ? "，" + scene : "") + "。";
  }

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
    return { faq: f, tf, len, df: Object.keys(tf), polarity: faqPolarity(f), candText, src: "faq" };
  }

  /* ============================================================
     3.5 主系统知识库（KB）接入 —— 让 bot 能"学习"运维沉淀的文章
     KB 文章被映射成与 FAQ 同构的 doc，一起进 DOCS 参与四层打分，
     因此 KB 命中同样能晋升为「自助解决」或作为 RAG 引用来源。
     映射规则：
       title   → q      （文章标题即标准问）
       tags    → tags   （标签做高权重，与 FAQ 一致）
       category→ cat
       content → a/steps（正文按行拆分，首行作结论、其余作步骤）
     ============================================================ */
  const KB_ID_PREFIX = "kb:";
  /** 主系统 KB 文章 → 检索 doc 的规范化映射（保持幂等，可重复调用） */
  function kbToFaq(a) {
    const content = String(a.content || "");
    // 正文通常是「1. 登录 K8s 查看 Pod 资源；\n2. ...」这类编号步骤
    const lines = content.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const steps = lines.map((x) => x.replace(/^\s*\d+[.、)]\s*/, "").trim()).filter(Boolean);
    const title = String(a.title || "").trim();
    // 标题里若无疑问语气，补一个「怎么处理」的问法，提升与口语问句的短语匹配
    const ask = [title];
    if (!/[？?]$/.test(title)) ask.push(title + "怎么处理");
    return {
      id: KB_ID_PREFIX + a.id,
      kbId: a.id,
      cat: a.category || "知识库",
      pri: /安全|故障|中断|丢包|宕机/.test(title + (a.tags || []).join("")) ? "P2" : "P3",
      owner: "IT 运维团队",
      q: title,
      ask: ask,
      a: steps.length ? steps[0] : content.slice(0, 120),
      steps: steps.length > 1 ? steps : [],
      tags: (a.tags || []).slice(0, 8),
      fromKB: true,
      updatedAt: a.updatedAt,
      views: a.views || 0,
      ciId: a.ciId || null,
      _polarity: /申请|开通|如何申请/.test(title) ? "request" : "any",
    };
  }
  /** KB doc 不受 FAQ 语义极性影响（运维手册多为陈述式），单独返回极性 */
  function kbPolarity(f) { return f._polarity || "any"; }

  /* DOCS 在启动时构建，KB 变更后通过 rebuildIndex() 热更新 */
  let DOCS = [];
  let DF = {};
  let N = 1;
  let AVG_LEN = 1;
  let KB_SNAPSHOT = [];   // 已纳入索引的 KB 文章指纹，用于检测「学到了新知识」

  function buildAllDocs() {
    const kb = (mainState().kb || []).filter((a) => a && a.title && a.content);
    const kbDocs = kb.map((a) => {
      const f = kbToFaq(a);
      const d = buildDoc(f);
      d.src = "kb";
      d.pdf = kbPolarity(f);
      d.polarity = d.pdf;
      d.kb = a;
      return d;
    });
    const faqDocs = FAQS.map((f) => { const d = buildDoc(f); d.src = "faq"; return d; });
    return faqDocs.concat(kbDocs);
  }

  function rebuildIndex(silent) {
    DOCS = buildAllDocs();
    DF = {};
    DOCS.forEach((d) => d.df.forEach((t) => { DF[t] = (DF[t] || 0) + 1; }));
    N = DOCS.length || 1;
    AVG_LEN = DOCS.reduce((a, d) => a + d.len, 0) / N;
    // TF-IDF 归一化向量
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
    const changed = syncKbSnapshot();
    if (!silent && changed.learned.length) {
      logTool("kb", "learn_sync", { added: changed.learned.map((k) => k.id), count: changed.learned.length },
        { indexed: DOCS.length, kbTotal: KB_SNAPSHOT.length }, "ok", 0);
    }
    return { docs: DOCS.length, kb: KB_SNAPSHOT.length, learned: changed.learned };
  }

  /** 对比主系统 KB 与上次索引快照，得出「新学到了哪些文章」 */
  function syncKbSnapshot() {
    const prev = {};
    KB_SNAPSHOT.forEach((k) => { prev[k.id] = k.fp; });
    const now = (mainState().kb || []).filter((a) => a && a.title && a.content)
      .map((a) => ({ id: a.id, fp: String(a.updatedAt || "") + "|" + a.title.length + "|" + a.content.length }));
    const learned = now.filter((k) => prev[k.id] !== k.fp);
    KB_SNAPSHOT = now;
    return { learned, total: now.length };
  }

  function idf(t) {
    const n = DF[t] || 0;
    // 封顶：避免只在 1 篇出现的词拿到过高权重而压过真正有判别力的词
    return Math.min(Math.log(1 + (N - n + 0.5) / (n + 0.5)), 2.6);
  }

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
    // 索引为惰性构建：若调用方尚未 ensureInit（例如只 require 了 bot.js 的脚本），
    // 这里兜底重建一次，避免静默返回空结果、把所有提问误判成 low 置信度。
    if (!DOCS.length) rebuildIndex(true);
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
        src: d.src || "faq", kb: d.kb || null,
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
      kbTop: (scores.find((x) => x.src === "kb") || null),
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

  /**
   * 护栏评测（服务原则 1 / 3 / 4 / 5）
   * EVAL_SET 只衡量「答得对」，会掩盖高置信错答；本评测专测「该不该答」。
   * 判定完全基于 ask() 的真实链路（含护栏），不重新实现逻辑。
   */
  function evaluateGuards() {
    const rows = (DATA.GUARD_SET || []).map((item) => {
      const saveId = store.currentId;
      const tmp = { id: uid("G"), user: "评测", channel: "eval", startedAt: nowISO(), endedAt: null, messages: [], tools: [], resolution: { level: null, resolved: null, ticketId: null, escalated: false } };
      store.sessions.unshift(tmp);
      store.currentId = tmp.id;
      let res = null;
      try { res = ask(item.q); } catch (e) { res = null; }
      const out = (res && res.result) || {};
      const text = String(out.text || "");
      const cards = out.cards || [];
      const types = cards.map((c) => c.type);
      const guard = (res && res.message && res.message.guard) || null;
      const plugin = (res && res.plugin && res.plugin.id) || "—";
      // 输出证据
      const hasHotline = text.indexOf(DUTY_PHONE) >= 0 || cards.some((c) => c.phone === DUTY_PHONE);
      const hasRisk = types.indexOf("risk") >= 0;
      const hasBoundary = types.indexOf("boundary") >= 0;
      const saysNeedHuman = /需要人工确认|不做猜测/.test(text);
      // 逐类判定
      let ok = false;
      if (item.type === "boundary") ok = hasBoundary;
      else if (item.type === "risk") ok = hasRisk;
      else if (item.type === "hotline") ok = hasHotline;
      else if (item.type === "refuse") ok = guard === "lowconf" || guard === "risk_warn" || saysNeedHuman;
      else if (item.type === "clarify") ok = guard === "clarify";
      else if (item.type === "greeting") ok = guard === "greeting";
      // 清理临时会话与消息（评测不污染审计）
      store.sessions = store.sessions.filter((x) => x.id !== tmp.id);
      store.currentId = saveId;
      return { q: item.q, type: item.type, ok, plugin, guard, hasHotline, hasRisk, hasBoundary, saysNeedHuman, cards: types.join(",") };
    });
    const total = rows.length || 1;
    const by = (t) => {
      const g = rows.filter((r) => r.type === t);
      return g.length ? g.filter((r) => r.ok).length / g.length : 1;
    };
    const res = {
      at: nowISO(), total: rows.length,
      pass: rows.filter((r) => r.ok).length / total,
      boundary: by("boundary"), risk: by("risk"), hotline: by("hotline"),
      refuse: by("refuse"), clarify: by("clarify"), greeting: by("greeting"),
      rows,
    };
    store.lastGuardEval = { at: res.at, total: res.total, pass: res.pass, boundary: res.boundary, risk: res.risk, hotline: res.hotline, refuse: res.refuse, clarify: res.clarify };
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
    if (/知识库|沉淀|收录|学到|学习|同步知识|kb\b/.test(s)) return "knowledge";
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
     7.5 服务原则护栏（原则 1 / 3 / 4 / 5）
     边界判定 → 危险动作拦截 → 低置信拒答 → 寒暄与澄清
     这些都是「检索之前」的判定，避免错答案被高置信输出
     ============================================================ */

  /* 原则 5：IT 服务范围之外的主题 → 明确说"需要人工确认"，绝不硬套 IT FAQ */
  const OUT_OF_SCOPE = [
    { dept: "人力资源部门（HR）", words: ["体检", "绩效", "晋升", "调薪", "薪资", "工资", "社保", "公积金", "年假", "请假", "考勤", "招聘", "面试", "试用期", "转正", "调岗", "离职补偿", "劳动合同", "五险一金", "员工手册"] },
    { dept: "财务部门", words: ["报销", "发票", "差旅费", "付款", "打款", "预算", "费用申请", "开票", "对账单"] },
    { dept: "法务 / 合规部门", words: ["劳动仲裁", "法律", "诉讼", "起诉", "违约", "合同条款", "知识产权", "专利", "竞业"] },
    { dept: "行政 / 后勤部门", words: ["工位", "门禁卡", "食堂", "餐补", "住宿", "差旅", "快递", "会议室预定", "名片", "办公用品采购"] },
  ];
  /* 命中域外词的判据：要有主题词，且不是在问 IT 系统本身（避免「考勤系统的 VPN 连不上」被误判域外） */
  const IT_HINT = /系统|电脑|笔记本|网络|邮箱|账号|密码|登录|vpn|权限|软件|打印机|投屏|wi-?fi|客户端|平台|工具|网页|接口|服务|终端|键盘|鼠标|显示器|驱动/;
  function outOfScope(text) {
    const s = normalize(text);
    for (let i = 0; i < OUT_OF_SCOPE.length; i++) {
      const hit = OUT_OF_SCOPE[i].words.filter((w) => s.indexOf(w) >= 0);
      if (!hit.length) continue;
      // 若同时命中 IT 对象词，且 IT 词出现在域外词之后（如「考勤系统的密码忘了」），判为 IT 问题
      if (IT_HINT.test(s) && /忘记|重置|登录|连不上|打不开|报错|权限|安装|开通|下载/.test(s)) return null;
      return { dept: OUT_OF_SCOPE[i].dept, matched: hit };
    }
    return null;
  }

  /* 原则 3：涉及数据安全的高危操作 → 必须前置风险提醒，不得直接给出操作指引 */
  const RISK_RULES = [
    { level: "P1", topic: "生产数据删除 / 批量变更",
      words: ["删库", "删表", "删除数据", "清空", "truncate", "drop table", "delete from", "批量删除", "全删", "清库", "重置数据库", "覆盖数据"],
      warn: "该操作会**不可逆地破坏生产数据**，属于变更管理范畴，必须走变更审批并具备回滚方案，**不得由个人直接执行**。",
      path: "如确有数据修正需求，请提交「变更申请」并附回滚方案，由 DBA 与业务负责人在低峰期窗口执行。" },
    { level: "P1", topic: "批量导出 / 外发敏感数据",
      words: ["导出客户", "客户名单", "客户资料", "批量导出", "全部数据", "导出所有", "发给外部", "发给客户", "外发数据", "拷贝数据", "离职带走", "拷回家"],
      warn: "客户名单、手机号等属于**机密级数据**，私自导出或对外提供可能构成**违法泄露**，公司有权追责。",
      path: "如为业务必要，请提交「数据外发审批」，写明对象、用途、范围与期限；含个人信息须先脱敏，机密数据原则上禁止外发。" },
    { level: "P2", topic: "使用破解 / 非授权软件",
      words: ["破解", "破解版", "盗版", "注册机", "绿色版", "免激活", "keygen", "crack"],
      warn: "安装破解软件**违反公司安全规定并存在法律风险**，且破解包是勒索病毒与后门的主要传播载体。",
      path: "请从公司软件库安装正版；库外软件提交申请经信息安全审核后由 IT 推送安装包。" },
    { level: "P2", topic: "私自使用移动存储拷贝公司数据",
      words: ["私人u盘", "自己u盘", "私人移动硬盘", "拷到u盘", "拷进u盘", "私人网盘", "个人网盘"],
      warn: "公司数据**禁止用私人存储介质或私人网盘留存**，加密 U 盘仅限公司终端读写。",
      path: "业务需要请申请「加密 U 盘」；跨部门/外发请走数据外发审批。" },
    { level: "P2", topic: "私自留存公司资产",
      words: ["自己留着", "留着自己用", "带回家用", "能不能给我", "报废给我", "旧的给我", "资产归个人", "自己带走"],
      warn: "公司资产（含报废设备）**属公司财产，不得私自留存或处置**；设备存储介质可能残留公司数据，私自留存存在**数据泄露责任**。",
      path: "报废设备须走资产回收流程，由 IT 统一做数据擦除后移交资产管理员处置；如需长期借用请提交资产借用申请。" },
    { level: "P1", topic: "账号共享 / 绕过权限控制",
      words: ["借用账号", "共用账号", "共享账号", "借用权限", "用别人账号", "借用同事", "共用密码", "把密码给他"],
      warn: "账号**严禁共享或借用**，所有操作行为均会记入该账号日志，共享将导致责任无法追溯。",
      path: "请为实际使用者申请独立账号与最小必要权限，提交「权限申请」工单。" },
  ];
  function detectRisk(text) {
    const s = normalize(text);
    for (let i = 0; i < RISK_RULES.length; i++) {
      const r = RISK_RULES[i];
      const hit = r.words.filter((w) => s.indexOf(normalize(w)) >= 0);
      if (hit.length) return { level: r.level, topic: r.topic, warn: r.warn, path: r.path, matched: hit };
    }
    return null;
  }

  /* 原则 4：安全事件类关键词 —— 命中即在答复中附带值班电话
     （安全类问题往往命中 FAQ45/46 这类自助答案，但按原则必须同时给出值守电话） */
  const SECURITY_WORDS = ["勒索", "病毒", "木马", "中毒", "钓鱼", "泄密", "泄露", "入侵", "被攻击",
    "异常登录", "账号被盗", "数据被加密", "赎金", "中招"];
  const EMERGENCY_WORDS = ["生产", "线上", "宕机", "瘫痪", "全公司", "所有人", "大面积", "重大故障",
    "紧急", "p1", "交易失败", "下单失败", "中断", "加急"];
  /** 命中安全事件或紧急特征（用于强制附带值班电话） */
  function isEmergencyish(text) {
    const s = normalize(text);
    const sec = SECURITY_WORDS.some((w) => s.indexOf(w) >= 0);
    if (sec) return { hit: true, kind: "security" };
    const emg = EMERGENCY_WORDS.some((w) => s.indexOf(w) >= 0);
    // 纯咨询型问法（怎么申请/流程是什么）不算紧急
    if (emg && /紧急|上报|加急|事故|故障|瘫|宕机/.test(s)) return { hit: true, kind: "emergency" };
    return { hit: false };
  }
  /** 若回复里还没有值班电话，则在末尾补一行（避免重复追加） */
  function ensureHotline(out, text) {
    if (!out || !out.text) return out;
    if (out.text.indexOf(DUTY_PHONE) >= 0) return out;
    const e = isEmergencyish(text);
    if (!e.hit) return out;
    const note = e.kind === "security"
      ? "\n\n📞 **这属于安全事件，请立即致电 IT 值班热线 " + DUTY_PHONE + "**（7×24 值守），不要只在线上提问/提单。"
      : "\n\n📞 **紧急问题请立即致电 IT 值班热线 " + DUTY_PHONE + "**（7×24 值守）。";
    out.text = out.text + note;
    if (out.cards && out.cards.length) {
      const i = out.cards.findIndex((c) => c.type === "faq" || c.type === "kbAnswer");
      if (i >= 0) out.cards[i].phone = DUTY_PHONE;
    }
    return out;
  }

  /* 原则 1：寒暄与过泛描述 → 先澄清，不猜答案 */
  const GREET_PAT = /^(你好|您好|hi|hello|hey|在吗|在不在|有人吗|早上好|中午好|下午好|晚上好|早安|晚安|嗨|哈喽)[\s!！。~?？]*$/;
  const THANKS_PAT = /^(谢谢|多谢|感谢|thanks|thank you|thx|辛苦了|好的|ok|收到|明白了|知道了)[\s!！。~]*$/;
  const VAGUE_PAT = /^(电脑|设备|系统|网络|机器|笔记本|办公电脑)?\s*(有问题|坏了|不行了|出问题|出故障|不好用|用不了|有问题了|有点问题|异常|故障|报错)[\s!！。~]*$/;
  const TOO_SHORT = (s) => normalize(s).replace(/\s/g, "").length <= 2;
  /** 无意义输入：无空格无标点的纯拉丁串（如 asdfghjkl），或超短的纯符号 */
  function isGibberish(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return true;
    const norm = normalize(raw);
    if (!norm) return true;
    // 单个长拉丁串且不含常见英文词 → 视为乱敲
    if (/^[a-z]{5,}$/.test(norm.replace(/\s/g, ""))) {
      const known = /^(hello|thanks|password|wifi|vpn|email|mail|office|teams|zoom|dns|dhcp|ip|mac|ssd|hdmi|usb|pdf|word|excel|ppt|erp|crm|oa|mfa|vpn|sql|api|http|https)$/;
      if (!known.test(norm.replace(/\s/g, ""))) return true;
    }
    // 纯重复字符
    if (/^(.)\1+$/.test(norm.replace(/\s/g, ""))) return true;
    return false;
  }

  /** 过泛描述：返回澄清选项（先问清再答，而不是猜一个 FAQ） */
  function clarifyOptions() {
    return [
      { label: "上不了网 / 网络断", value: "__ask__:上不了网怎么办" },
      { label: "开不了机 / 蓝屏", value: "__ask__:电脑开不了机怎么办" },
      { label: "某个系统打不开", value: "__ask__:内部系统打不开怎么办" },
      { label: "打印机 / 投屏问题", value: "__ask__:打印机无法打印怎么办" },
      { label: "账号 / 密码问题", value: "__ask__:忘记域账号密码怎么重置" },
      { label: "都不是，帮我逐步诊断", value: "__diag__" },
    ];
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
    desc: "52 条 FAQ + 运维知识库，命中即给答案",
    canHandle(text, ctx) {
      return ctx.search && ctx.search.level === "high" ? 0.95 : 0;
    },
    handle(text, ctx) {
      const hit = ctx.search.hits[0];
      const f = hit.faq;
      const fromKB = hit.src === "kb";
      const kbHits = searchKB(text, 2);
      const others = ctx.search.hits.slice(1, 3).filter((h) => h.score >= CONF.mid);
      // 风险卡由 ask() 统一前置插入，插件内不再重复添加
      return {
        level: "self",
        // 正文只给结论与命中提示，答案与处置步骤由卡片承载，避免同一段文案重复两遍
        text: "已为你找到答案（匹配度 " + Math.round(hit.score * 100) + "%）：**" + f.q + "**" +
          (fromKB ? "\n\n📖 来源：**IT 知识库（KB）** · " + (f.kbId || "") + "，本文由运维团队沉淀，已纳入我的知识范围。" : "") +
          (others.length ? "\n\n若这不是你要问的，也可以看看：" + others.map((h) => h.faq.q).join(" / ") : ""),
        cards: [fromKB
          ? { type: "kbAnswer", kbId: f.kbId, title: f.q, cat: f.cat, content: f.a, steps: f.steps, tags: f.tags, score: hit.score, detail: hit.detail, updatedAt: f.updatedAt, views: f.views }
          : { type: "faq", faq: f, score: hit.score, detail: hit.detail }],        options: [
          { label: "👍 已解决", value: "__solved__" },
          { label: "👎 没解决，继续诊断", value: "__diag__" },
          { label: "转人工工单", value: "__ticket__" },
        ],
        sources: [{ id: f.id, type: fromKB ? "KB" : "FAQ", title: f.q, score: hit.score }]
          .concat(kbHits.filter((k) => !fromKB || k.item.id !== f.kbId)
            .map((k) => ({ id: k.item.id, type: "KB", title: k.item.title, score: k.score }))),
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
        // 知识库操作与安全事件也不该被困在决策树里
        if (it === "knowledge" || /勒索|病毒|钓鱼|泄密|攻击|异常登录/.test(normalize(text))) return 0;
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
    if (!out || !out.cards || !out.cards[0] || out.cards[0].type !== "ticket") {
      // 开单失败（如主系统未就绪）也必须完成原则 4 的紧急告知，不能连电话都没有
      const fallback = out || { level: "ticket", text: "已识别为**大面积影响**的故障，但本次未能自动开单。", cards: [], options: [], sources: [] };
      fallback.level = "ticket";
      fallback.text = "⚠️ 识别到**大面积影响**的故障。\n\n" + hotlineLine("请立即致电并声明「P1 生产故障」") +
        "\n\n" + (out && out.text ? out.text + "\n\n" : "本次未能自动创建工单，请通过电话或「事件管理」手动提单。\n\n") +
        "请尽快同步影响范围与已尝试的操作，应急值守会立即介入。";
      fallback.cards = [{ type: "blast", title: title, pri: "P1", ticketId: null, phone: DUTY_PHONE }].concat(fallback.cards || []);
      fallback.options = (fallback.options && fallback.options.length) ? fallback.options : [{ label: "🎫 手动建单", value: "__ticket__" }];
      return fallback;
    }
    const tk = out.cards[0].ticket;
    tk.priority = "P1";
    out.cards[0].response = SLA_RESPONSE.P1;
    out.cards[0].resolve = SLA_RESOLVE.P1;
    out.cards[0].owner = SLA_OWNER.P1;
    out.cards.unshift({ type: "blast", title: title, pri: "P1", ticketId: tk.id, phone: DUTY_PHONE });
    out.text = "⚠️ 识别到**大面积影响**的故障，已跳过自助排查与逐步诊断，**直达人工**并按 **P1 紧急** 立即开单。\n\n" +
      hotlineLine("请同步致电并声明「P1 生产故障」") + "\n\n" +
      out.text
        .replace(/优先级：P\d（自动按影响面判定）/, "优先级：P1（大面积影响，自动升级）")
        .replace(/响应时限：[^｜]*｜解决时限：[^\n]*/, "响应时限：" + SLA_RESPONSE.P1 + "｜解决时限：" + SLA_RESOLVE.P1) +
      "\n\n请尽快同步影响范围与已尝试的操作，应急值守会立即介入。";
    if (window.OpsDesk) {
      const inc = mainState().incidents.find((x) => x.id === tk.id);
      if (inc) { inc.priority = "P1"; inc.blast = true; window.OpsDesk.save(); window.OpsDesk.refresh(); }
    }    logTool("ticket", "blast_escalate", { query: text, matched: P1_BLAST.filter((w) => normalize(text).indexOf(w) >= 0) },
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
    // 紧急场景（P1）按原则 4 强制附带值班电话
    const hot = pri === "P1" ? "\n\n" + hotlineLine("已按 P1 建单，请同时致电以确保即时响应") : "";
    return {
      level: "ticket",
      text: "已为你创建工单 **" + id + "**：**" + title + "**\n\n" +
        "• 分类：" + cat + "\n• 优先级：" + pri + "（自动按影响面判定）\n" +
        "• 响应时限：" + SLA_RESPONSE[pri] + "｜解决时限：" + SLA_RESOLVE[pri] + "\n" +
        "• 处理方：" + SLA_OWNER[pri] + "\n\n" +
        "SLA 分级说明：" + slaTableText(pri) + "\n\n你可以在「事件管理」中查看该工单的 SLA 倒计时。" + hot,
      cards: [{ type: "ticket", ticket: inc, response: SLA_RESPONSE[pri], resolve: SLA_RESOLVE[pri], owner: SLA_OWNER[pri], phone: pri === "P1" ? DUTY_PHONE : "" }],
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

  /* ---------- 插件 6：知识库学习（KB 联动与沉淀） ---------- */
  const kbPlugin = {
    id: "kb", name: "知识库学习", icon: "📚",
    desc: "与主系统 KB 双向联动：学习新文章、沉淀已验证方案",
    canHandle(text, ctx) {
      const s = normalize(text);
      const it = detectIntent(text);

      if (it === "knowledge") {
        const kbHit = !!(ctx.search && ctx.search.kbTop &&
          ctx.search.kbTop.detail && (ctx.search.kbTop.detail.phrase || 0) >= 0.6);
        // 例外 1：显式诊断意图优先——
        // 用户真正要的是排查过程时应走决策树，不被知识库管理动作截胡。
        if (/诊断|排查|一步步|逐步|定位原因|帮我查原因|检测流程/.test(s)) return 0;
        // 例外 2：KB 文章强命中时让位给答案——
        // 若知识库里已有现成文章直答（且非仅靠散词拼凑），比展示"我学到了什么"更有价值。
        // 注意只对 KB 命中让步，FAQ 命中不参与：FAQ 语料本身含「排查」类标题，
        // 否则「帮我诊断打印机故障」会被 FAQ 抢答，显式诊断意图形同虚设。
        if (kbHit) return 0;
        if (/沉淀|收录|写进知识库|写入知识库|存到知识库|存进知识库|记录到知识库|保存到知识库/.test(s)) return 0.97;
        if (/同步知识|学习新知识|学习知识|更新知识|重学|refresh.*知识|知识库.*同步|同步.*知识库/.test(s)) return 0.96;
        if (/我的知识|知识规模|学到什么|会什么|知识库.*多少|有多少.*知识/.test(s)) return 0.94;
      }
      // 兜底：不含「知识库」字样时仍允许通过状态类问法进入
      if (/学到什么|我的知识|知识规模|学到哪些/.test(s)) return 0.94;
      return 0;
    },
    handle(text, ctx) {
      const s = normalize(text);
      // 风险卡统一由 ask() 前置插入，此处不再重复
      // 沉淀
      if (/沉淀|收录|写进知识库|写入知识库|存到知识库|存进知识库|记录到知识库|保存到知识库/.test(s)) {
        const r = distillSession(ctx.session.id);
        return {
          level: "self",
          text: r.ok
            ? "📚 已" + (r.action === "created" ? "新建" : "更新") + "知识库文章 **" + r.id + "**：**" + r.title + "**\n\n" +
              "已即时纳入检索索引，下次同类提问会直接命中。可在「知识库 (KB)」查看编辑。"
            : "暂时无法沉淀：**" + r.reason + "**\n\n可以先和我解决一个问题（命中 FAQ 或诊断出结论），再让我把它沉淀成文章。",
          cards: (r.ok ? [{ type: "learned", id: r.id, title: r.title, action: r.action }] : []),
          options: [{ label: "查看知识库", value: "__goto_kb__" }, { label: "继续咨询", value: "__reset__" }],
          sources: r.ok ? [{ id: r.id, type: "KB", title: r.title, score: 1 }] : [],
        };
      }
      // 同步新知
      if (/同步知识|学习新知识|学习知识|更新知识|重学|知识库.*同步|同步.*知识库/.test(s)) {
        const r = syncKnowledge();
        const list = r.learned.slice(0, 6).map((x) => "• " + x.id + "　" + x.title).join("\n");
        return {
          level: "self",
          text: r.added
            ? "🔄 已学习 **" + r.added + "** 篇新增/更新的知识库文章：\n\n" + list + "\n\n索引规模 **" + r.indexed + "** 条，后续同类提问会命中这些文章。"
            : "🔄 知识库已是最新，没有待学习的新文章。\n\n当前可检索知识 **" + r.indexed + "** 条（KB " + r.kb + " 篇 ＋ FAQ " + FAQS.length + " 条）。",
          cards: [{ type: "learnStatus", status: learnStatus() }],
          options: [{ label: "查看知识库", value: "__goto_kb__" }, { label: "继续咨询", value: "__reset__" }],
          sources: [],
        };
      }
      // 知识规模
      const st = learnStatus();
      return {
        level: "self",
        text: "我当前的知识规模：\n\n• **KB 运维文章 " + st.kbTotal + " 篇**（来自「知识库」模块，可随时新增）\n" +
          "• **FAQ " + st.faqTotal + " 条**（内置高频问题）\n" +
          "• 合计可检索知识 **" + st.indexedDocs + " 条**\n\n" +
          (st.pendingCount ? "⚠️ 有 **" + st.pendingCount + "** 篇 KB 文章尚未纳入索引，说「同步知识」即可学习。" : "✅ 知识库已全部纳入索引。"),
        cards: [{ type: "learnStatus", status: st }],
        options: [{ label: "🔄 同步知识库", value: "__sync_kb__" }, { label: "查看知识库", value: "__goto_kb__" }],
        sources: [],
      };
    },
  };

  const PLUGINS = [onboardPlugin, ticketPlugin, kbPlugin, diagPlugin, faqPlugin, ragPlugin];

  /* ============================================================
     10. 分级服务编排器
     自助排查(FAQ) → 智能诊断(RAG/工作流) → 人工工单，按置信度自动升级
     ============================================================ */
  function route(text, ctx) {
    const scored = PLUGINS.map((p) => ({ p, score: p.canHandle(text, ctx) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return { p: ragPlugin, score: 0.3 };
    // 高置信知识命中优先于「泛诊断意图」：
    // KB 标题常含「排查 / 诊断 / 定位」（如《订单服务响应慢排查手册》），
    // 会误触发 diag 的显式诊断意图，把已经命中的答案让给决策树。有现成答案时不该走诊断。
    const diag0 = scored.find((x) => x.p.id === "diag");
    const know0 = scored.find((x) => x.p.id === "faq" || x.p.id === "rag");
    // 仅当命中来自 KB 且证据确凿（精确短语）时，才允许用答案覆盖「显式诊断意图」。
    // 不能放宽到所有 high 命中：FAQ 标题里也有「排查 / 定位」类词，
    // 「帮我诊断打印机故障」会被 FAQ31 抢答，用户明确的诊断诉求就失效了。
    if (diag0 && know0 && ctx.search && ctx.search.level === "high" && ctx.search.kbTop) {
      const kt = ctx.search.kbTop;
      const exact = (kt.detail && (kt.detail.phrase || 0) >= 0.6) || (kt.cov || 0) >= 0.75;
      if (exact && kt.score >= (diag0.score - 0.08)) return scored.find((x) => x.p.id === know0.p.id) || know0;
    }
    return scored[0];
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

    // 服务原则护栏：在检索结果被当作答案输出之前先过闸
    const gate = applyGuards(text, ctx, search);
    if (gate && gate.type && gate.out) {
      logTool("engine", "guard_" + gate.type, { query: text, matched: gate.matched || [] },
        { action: gate.action, note: gate.note || "" }, "ok", Date.now() - t0);
      return commit("engine", gate.out, search, gate);
    }
    if (gate && gate.risk) ctx.risk = gate.risk;   // 风险提醒已挂到 ctx，由插件在答复前插入
    if (gate && gate.type === "risk_warn") {       // 风险类输入记一条审计，但不阻断
      logTool("engine", "guard_risk_warn", { query: text, matched: gate.matched || [] },
        { action: gate.action, topic: gate.risk.topic, level: gate.risk.level }, "ok", Date.now() - t0);
    }

    const r = route(text, ctx);
    // 用户切换到其它插件时，自动结束挂起的诊断流程（留审计痕迹）
    if (session.flow && session.flow.active && r.p.id !== "diag") {
      logTool("diag", "flow_abort", { flowId: session.flow.id, to: r.p.id, reason: "user_switch" },
        "已结束挂起的诊断流程（用户切换到「" + r.p.name + "」）", "ok", 0);
      session.flow = null;
    }
    const tr = callTool(r.p.id, "handle", { query: text, intent: detectIntent(text) }, () => r.p.handle(text, ctx));
    const out = tr.out || { level: "ticket", text: "处理出现异常，已记录审计日志。", cards: [], options: [{ label: "转人工工单", value: "__ticket__" }], sources: [] };

    // 原则 5：低置信度不得输出猜测答案，改为明确"需要人工确认"
    // 但若已识别为高危动作（原则 3），风险警示优先——它比通用拒答更有价值
    const lowConf = shouldRefuse(out, search, r.p.id);
    if (lowConf) {
      logTool("engine", "guard_lowconf", { query: text, score: search.hits[0] ? +search.hits[0].score.toFixed(3) : 0, level: search.level },
        { action: "refuse_and_escalate", picked: search.hits[0] ? search.hits[0].id : null }, "ok", 0);
      if (ctx.risk) {
        // 高危动作：以风险警示为主体，拒答话术降为说明，不再展示无关的"最接近条目"
        lowConf.text = "⚠️ **请注意：你描述的操作涉及数据安全风险，我不能直接给出操作指引。**\n\n" +
          "而且我在知识库中没有找到可安全套用的现成方案，**这个问题需要人工确认**。\n\n" +
          "📞 如需即时支持，可致电 IT 值班热线 **" + DUTY_PHONE + "**。";
        lowConf.cards = riskCard(ctx.risk);
        lowConf.options = [
          { label: "🎫 转人工工单", value: "__ticket__" },
          { label: "🧭 带我逐步诊断", value: "__diag__" },
        ];
        return commit("engine", lowConf, search, { type: "risk_warn", matched: ctx.risk.matched });
      }
      return commit("engine", lowConf, search, { type: "lowconf", matched: [] });
    }
    if (ctx.risk) out.cards = riskCard(ctx.risk).concat(out.cards || []);
    if (ctx.risk) out.text = riskLead(ctx.risk) + out.text;
    // 原则 4：安全事件 / 紧急问题，无论走哪个插件都要带上值班电话
    ensureHotline(out, text);

    return commit(r.p.id, out, search, { type: null });
  }

  /** 统一的落库 + 消息推送（护栏命中与插件正常返回共用，保证审计字段一致） */
  function commit(pluginId, out, search, gate) {
    const session = cur();
    const p = PLUGINS.find((x) => x.id === pluginId) || { id: pluginId, name: pluginNameOf(pluginId) };
    if (out.level === "self" && session.resolution.level !== "ticket") session.resolution.level = "self";
    if (out.level === "diagnose" && session.resolution.level !== "ticket") session.resolution.level = "diagnose";
    session.resolution.resolved = session.resolution.resolved || null;
    save();
    const hitScore = (search && search.hits && search.hits[0]) ? +search.hits[0].score.toFixed(3) : 0;
    const msg = pushMsg("bot", out.text, {
      plugin: p.id, pluginName: p.name, level: out.level,
      confidence: hitScore,
      cards: out.cards || [], options: out.options || [],
      sources: out.sources || [], keepFlow: !!out.keepFlow,
      audit: { tokens: search.tokens, expansions: search.expansions.extra.slice(0, 12), level: search.level, margin: search.margin, polarity: search.polarity },
      guard: (gate && gate.type) || null,
    });
    return { message: msg, plugin: p, result: out, search };
  }
  function pluginNameOf(id) {
    const m = (PLUGIN_META || []).find((x) => x.id === id);
    return m ? m.name : "服务编排";
  }

  /* 原则 3：风险警示卡（插入到任何答复之前） */
  function riskCard(risk) {
    return [{ type: "risk", level: risk.level, topic: risk.topic, warn: risk.warn, path: risk.path, phone: risk.level === "P1" ? DUTY_PHONE : "" }];
  }
  /** 风险提示的一句话前言，放在正文最前面，避免用户只看答案不看卡片 */
  function riskLead(risk) {
    return "⚠️ **风险提示：**" + risk.topic + " 属受管操作，以下信息仅供参考，**不得直接执行**。\n\n";
  }

  /**
   * 前置护栏：返回 { type, out }（命中即直接作答并跳过插件）
   * 优先级：域外边界 > 危险动作 > 寒暄 > 过泛澄清
   * 危险动作不直接作答，而是标记 risk 交给插件继续处理（保留可用信息 + 前置警示）
   */
  function applyGuards(text, ctx, search) {
    const s = normalize(text);

    // 1) IT 范围之外（原则 5）
    const oos = outOfScope(text);
    if (oos) {
      return {
        type: "out_of_scope", matched: oos.matched, action: "handoff_" + oos.dept,
        out: {
          level: "ticket",
          text: "抱歉，**这个问题不在我的服务范围内**，我不能给出准确答复，**需要人工确认**。\n\n" +
            "你问的属于 **" + oos.dept + "** 的职责范畴（我仅覆盖 IT 系统、网络、账号权限与办公设备相关问题）。\n\n" +
            "建议这样处理：\n1. 通过企业通讯录联系 " + oos.dept + " 对接人；\n" +
            "2. 若涉及 IT 系统上的权限或账号问题，可让我继续为你处理；\n" +
            "3. 紧急情况可致电 IT 值班热线 **" + DUTY_PHONE + "**。",
          cards: [{ type: "boundary", dept: oos.dept, matched: oos.matched, phone: DUTY_PHONE }],
          options: [
            { label: "我要问 IT 系统 / 账号问题", value: "__reset__" },
            { label: "🎫 仍然转人工工单", value: "__ticket__" },
          ],
          sources: [],
        },
      };
    }

    // 2) 危险动作（原则 3）—— 不阻断，交由插件补充可用信息，但警示卡强制前置
    const risk = detectRisk(text);
    if (risk) return { type: "risk_warn", matched: risk.matched, risk, action: "prepend_risk_card", out: null };

    // 3) 寒暄（原则 1）—— 不是故障，不该甩诊断流程
    if (GREET_PAT.test(s) || THANKS_PAT.test(s)) {
      const isThanks = THANKS_PAT.test(s);
      return {
        type: "greeting", matched: [], action: "greet",
        out: {
          level: "self",
          text: isThanks
            ? "不客气 🙂 还有其他问题随时说。如果问题还没解决，可以直接说「转人工」，我帮你按 SLA 建单。"
            : "你好，我是 IT 智能助手 👋\n\n我会按 **自助排查 → 智能诊断 → 人工工单** 三级流程帮你处理：\n" +
              "1. 常见问题（密码、网络、邮箱、打印机等）直接给步骤；\n2. 复杂故障带你一问一答定位根因；\n3. 需要人工时按 SLA 自动分级开单。\n\n" +
              "请直接描述你遇到的情况。⚠️ 紧急问题（大面积故障、安全事件）请立即致电 **" + DUTY_PHONE + "**。",
          cards: [],
          options: [
            { label: "🔑 密码 / 账号问题", value: "__ask__:忘记域账号密码怎么重置" },
            { label: "📶 网络 / VPN 连不上", value: "__ask__:上不了网怎么办" },
            { label: "✉️ 邮件收发异常", value: "__ask__:收不到邮件怎么办" },
            { label: "🧭 帮我逐步诊断故障", value: "__diag__" },
          ],
          sources: [],
        },
      };
    }

    // 4) 过泛描述、过短或乱码输入（原则 1）—— 先澄清，不猜 FAQ
    // 例外：诊断流程进行中时，用户回复的裸序号 / 极短选项（"1"、"亮或闪烁"）属于流程交互，
    // 不是含糊提问，必须放行给决策树消费，否则用户会被澄清话术困住、无法推进流程。
    const inFlow = !!(ctx && ctx.flow && ctx.flow.active);
    const shortAnswer = inFlow && /^[\d\s.、,，]{1,3}$/.test(s);
    const tooShort = TOO_SHORT(s) || !s;
    if (!shortAnswer && (VAGUE_PAT.test(s) || tooShort || isGibberish(text))) {
      const gib = isGibberish(text) && !VAGUE_PAT.test(s);
      return {
        type: "clarify", matched: [], action: "ask_clarify",
        out: {
          level: "diagnose",
          text: gib
            ? "我没看懂你的输入 😅\n\n请用一句话描述遇到的问题，例如「连不上公司 Wi-Fi」「邮箱收不到邮件」「电脑开机很慢」。\n\n告诉我：**哪个设备或系统**、**什么现象**、**多久了**，我就能给出准确的排查步骤。"
            : (tooShort && !s
              ? "我没看清你的问题，能再描述一下吗？\n\n请告诉我：**哪个设备或系统**、**什么现象**、**多久了**，这样我能给出准确的排查步骤。"
              : "为了给你准确的答案，我需要先确认一下具体情况：\n\n你说的是 **" + (normalize(text) || "这个") + "**，具体是下面哪种现象？"),
          cards: [],
          options: clarifyOptions(),
          sources: [],
        },
      };
    }

    return { type: null };
  }

  /**
   * 原则 5：是否应当拒答
   * 仅对"检索驱动型"插件（faq / rag）生效；诊断、工单、入职、知识库属流程型，不受影响
   * 拒答条件（任一命中）：
   *   a) 检索定级为 low
   *   b) 融合分低于作答下限 REFUSE_FLOOR
   *   c) 中等置信但证据薄弱：无短语命中、且关键 token 覆盖率偏低
   *      （典型是「客户名单手机号导出」这类含大量语料外词、靠个别 token 蹭到 0.6 的伪命中）
   */
  const REFUSE_FLOOR = 0.45;
  const WEAK_COV = 0.32;      // 关键 token 覆盖率下限
  function shouldRefuse(out, search, pluginId) {
    if (pluginId !== "faq" && pluginId !== "rag") return null;
    if (!out) return null;
    const top = search.hits[0];
    const score = top ? top.score : 0;
    const d = top ? top.detail : null;
    const phrased = d ? (d.phrase || 0) >= 0.4 : false;
    const weakEvidence = !!d && !phrased && (top.cov || 0) < WEAK_COV;
    const low = search.level === "low" || score < REFUSE_FLOOR || weakEvidence;
    if (!low) return null;
    const reason = score < REFUSE_FLOOR
      ? "匹配度过低"
      : (weakEvidence ? "仅个别关键词命中，缺少实质依据" : "未能确定答案");
    return {
      level: "ticket",
      text: "**这个问题我不确定，需要人工确认。**\n\n" +
        "我在 IT 知识库中没有找到足够匹配的答案" +
        (top ? "（最高匹配度仅 " + Math.round(score * 100) + "%，" + reason + "，不足以作为依据）" : "") +
        "，为避免给你错误信息，我不做猜测。\n\n" +
        "建议这样处理：\n1. 换个说法再描述一次现象（哪个系统、什么报错、影响范围）；\n" +
        "2. 让我带你做一次逐步诊断，多数故障能在 3–5 步内定位；\n" +
        "3. 也可以直接转人工，由工程师处理。\n\n" +
        (top ? "参考：知识库里最接近的条目是《" + top.faq.q + "》，但**匹配度不足，请勿直接照此操作**。\n\n" : "") +
        "📞 如需即时支持，可致电 IT 值班热线 **" + DUTY_PHONE + "**。",
      cards: [{ type: "lowconf", score: score, threshold: REFUSE_FLOOR, reason: reason, closest: top ? { id: top.faq.id, q: top.faq.q, score: top.score } : null, phone: DUTY_PHONE }],
      options: [
        { label: "🧭 带我逐步诊断", value: "__diag__" },
        { label: "🎫 转人工工单", value: "__ticket__" },
        { label: "🔁 换个说法重新提问", value: "__reset__" },
      ],
      sources: [],
    };
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
      // 学习闭环：把本次已验证的解决方案沉淀进主系统 KB（同标题自动转更新）
      const learned = autoLearnOnSolved();
      const lrn = learned.ok
        ? "\n\n📚 已把本次解决方案沉淀到 **IT 知识库**（" + learned.id + " · " + (learned.action === "created" ? "新建" : "更新") +
          "），下次有人问同类问题我会直接命中。"
        : "";
      return finalize("engine", {
        level: "self",
        text: "很好，问题已解决 ✅ 本次服务全程已记录在审计日志中。" + lrn + "\n\n有其它问题随时问我。",
        cards: [{ type: "closed", resolution: session.resolution }]
          .concat(learned.ok ? [{ type: "learned", id: learned.id, title: learned.title, action: learned.action }] : []),
        options: [{ label: "继续咨询", value: "__reset__" }, { label: "查看知识库", value: "__goto_kb__" }], sources: [],
      });
    }
    /* 手动沉淀：把当前会话最近一条解决方案写成 KB 文章 */
    if (value === "__learn__") {
      const r = distillSession(session.id);
      if (!r.ok) {
        return finalize("kb", { level: "self", text: "暂时无法沉淀：" + r.reason, cards: [], options: [{ label: "继续咨询", value: "__reset__" }], sources: [] });
      }
      return finalize("kb", {
        level: "self",
        text: "📚 已" + (r.action === "created" ? "新建" : "更新") + "知识库文章 **" + r.id + "**：**" + r.title + "**\n\n" +
          "该文章已**立即纳入我的检索索引**，后续同类提问会命中它并给出这个答案。你可以在「知识库 (KB)」页面查看与编辑。",
        cards: [{ type: "learned", id: r.id, title: r.title, action: r.action }],
        options: [{ label: "查看知识库", value: "__goto_kb__" }, { label: "继续咨询", value: "__reset__" }], sources: [],
      });
    }
    /* 手动同步：把主系统 KB 的新增/修改文章拉进索引 */
    if (value === "__sync_kb__") {
      const r = syncKnowledge();
      const list = r.learned.slice(0, 5).map((x) => "• " + x.id + " " + x.title).join("\n");
      return finalize("kb", {
        level: "self",
        text: (r.added
          ? "🔄 已学习 **" + r.added + "** 篇知识库文章，索引规模 " + r.indexed + " 条。\n\n" + list
          : "🔄 知识库已是最新状态，无需同步。\n\n") +
          "\n当前知识规模：**" + r.kb + "** 篇 KB 文章 ＋ **" + FAQS.length + "** 条 FAQ ＝ **" + r.indexed + "** 条可检索知识。",
        cards: [{ type: "learnStatus", status: learnStatus() }],
        options: [{ label: "查看知识库", value: "__goto_kb__" }, { label: "继续咨询", value: "__reset__" }], sources: [],
      });
    }
    if (value === "__goto_kb__") {
      if (window.OpsDesk) window.OpsDesk.switchPage("kb");
      return finalize("kb", { level: "self", text: "已为你跳转到「知识库 (KB)」页面。", cards: [], options: [{ label: "返回助手", value: "__back_bot__" }], sources: [] });
    }
    if (value === "__back_bot__") {
      if (window.OpsDesk) window.OpsDesk.switchPage("assistant");
      return finalize("kb", { level: "self", text: "已返回 IT 智能助手。", cards: [], options: [{ label: "继续咨询", value: "__reset__" }], sources: [] });
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
    // 索引必须在主系统 KB 就绪后构建（含 KB 文章），此处为兜底
    rebuildIndex(true);
  }

  /* ============================================================
     11.5 知识学习闭环
     KB 文章 → 索引 → 命中作答；并支持把已验证的解决方案写回主系统 KB
     ============================================================ */

  /** 学习状态：新文章如何进入索引、当前知识规模 */
  function learnStatus() {
    const kb = (mainState().kb || []).filter((a) => a && a.title && a.content);
    const snapshot = {};
    KB_SNAPSHOT.forEach((k) => { snapshot[k.id] = k.fp; });
    const pending = kb.filter((a) => snapshot[a.id] !== String(a.updatedAt || "") + "|" + a.title.length + "|" + a.content.length);
    return {
      kbTotal: kb.length,
      indexedDocs: DOCS.length,
      faqTotal: FAQS.length,
      pendingCount: pending.length,
      pending: pending.map((a) => ({ id: a.id, title: a.title })),
      lastSyncAt: store.lastKbSync || null,
    };
  }

  /** 增量同步：把主系统 KB 的新增/修改文章纳入检索索引 */
  function syncKnowledge() {
    const before = DOCS.length;
    const r = rebuildIndex(true);
    store.lastKbSync = nowISO();
    save();
    logTool("kb", "learn_sync", { trigger: "manual", pendingBefore: r.learned.length },
      { indexed: r.docs, kb: r.kb, added: r.learned.length, before: before }, "ok", 0);
    return { added: r.learned.length, learned: r.learned, indexed: r.docs, kb: r.kb };
  }

  /** 把一条已验证的解决方案沉淀进主系统 KB（学习闭环的写入侧）
      来源：会话中「已解决」的 FAQ/KB 命中、诊断结论、或用户显式要求 */
  function teachToKB(opts) {
    const o = opts || {};
    const st = mainState();
    if (!window.OpsDesk || !st.kb) return { ok: false, reason: "主系统知识库未就绪" };
    const title = String(o.title || "").trim();
    const content = String(o.content || "").trim();
    if (!title || !content) return { ok: false, reason: "标题与内容不能为空" };
    // 去重：标题完全相同则视为重复，改为更新
    const dup = st.kb.find((a) => a && String(a.title).trim() === title);
    const payload = {
      title: title,
      category: o.category || "应用",
      tags: (o.tags || []).slice(0, 8),
      ciId: o.ciId || null,
      content: content,
    };
    if (dup) {
      Object.assign(dup, payload, { updatedAt: nowISO() });
      window.OpsDesk.save();
      rebuildIndex(true);
      logTool("kb", "learn_update", { id: dup.id, title: title, from: o.from || "bot" }, { result: "updated" }, "ok", 0);
      return { ok: true, action: "updated", id: dup.id, title: title };
    }
    const id = nextKbId(st);
    st.kb.unshift(Object.assign({
      id: id, views: 0, createdAt: nowISO(), updatedAt: nowISO(), source: o.from || "bot",
      sourceSession: o.sessionId || null,
    }, payload));
    window.OpsDesk.save();
    rebuildIndex(true);
    logTool("kb", "learn_add", { id: id, title: title, from: o.from || "bot", tags: payload.tags },
      { result: "created", indexed: DOCS.length }, "ok", 0);
    return { ok: true, action: "created", id: id, title: title };
  }
  function nextKbId(st) {
    let n = 1000;
    (st.kb || []).forEach((a) => {
      const m = String(a.id || "").match(/^KB(\d+)$/);
      if (m) n = Math.max(n, parseInt(m[1], 10));
    });
    return "KB" + (n + 1);
  }

  /** 从当前会话沉淀知识：把最近一次成功的 FAQ / KB / 诊断结论写成 KB 文章 */
  function distillSession(sessionId) {
    const s = sessionId ? store.sessions.find((x) => x.id === sessionId) : cur();
    if (!s) return { ok: false, reason: "会话不存在" };
    // 找该会话里最后一条带 FAQ/KB 卡片或诊断结论的助手消息
    let pick = null;
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i];
      if (m.role !== "bot" || !m.cards) continue;
      const c = m.cards.find((x) => x.type === "faq" || x.type === "kbAnswer" || x.type === "result");
      if (c) { pick = { msg: m, card: c }; break; }
    }
    if (!pick) return { ok: false, reason: "本会话暂无可沉淀的解决方案（先解决一个问题再沉淀）" };
    const c = pick.card;
    let title = "", content = "", tags = [], category = "应用";
    if (c.type === "faq") {
      title = c.faq.q;
      content = [c.faq.a].concat((c.faq.steps || []).map((x, i) => (i + 1) + ". " + x)).join("\n");
      tags = c.faq.tags || [];
      category = c.faq.cat || "应用";
    } else if (c.type === "kbAnswer") {
      title = c.title;
      content = [c.content].concat((c.steps || []).map((x, i) => (i + 1) + ". " + x)).join("\n");
      tags = c.tags || [];
      category = c.cat || "应用";
    } else {
      title = pick.msg.text.replace(/[*#]/g, "").split("\n")[0].slice(0, 40);
      content = pick.msg.text.replace(/[*#]/g, "");
      tags = ["诊断结论"];
    }
    const r = teachToKB({ title: title, content: content, tags: tags, category: category, from: "session_distill", sessionId: s.id });
    if (r.ok) {
      s.resolution.knowledgeId = r.id;
      save();
    }
    return r;
  }

  /** 会话闭环时把「已解决」的经验自动沉淀（由 __solved__ 触发，可选自动） */
  function autoLearnOnSolved() {
    const s = cur();
    if (s.resolution.knowledgeId) return { ok: false, reason: "本会话已沉淀过" };
    return distillSession(s.id);
  }

  /* ============ 引擎对外 API（UI 层再挂载 render 等方法） ============ */
  return {
    // 状态
    get store() { return store; },
    save, load, cur, newSession, closeSession, pushMsg, logTool, callTool, summarize,
    // 检索
    tokenize, normalize, expandQuery, hybridSearch, evaluate, evaluateGuards, scoreText, searchKB, searchIncidents,
    // 编排与插件
    ask, act, route, stats, PLUGINS, PLUGIN_META, mainState,
    faqPlugin, ragPlugin, diagPlugin, ticketPlugin, onboardPlugin, kbPlugin,
    recommendFlow, getFlow, onboardStats, seedDemo, ensureInit,
    // 知识库学习闭环
    rebuildIndex, syncKnowledge, learnStatus, teachToKB, distillSession, autoLearnOnSolved,
    kbToFaq, get documents() { return DOCS; }, get kbSnapshot() { return KB_SNAPSHOT; },
    // 服务原则护栏（供测试与审计）
    applyGuards, shouldRefuse, outOfScope, detectRisk, hotlineLine,
    DUTY_PHONE, DESK_EXT, REFUSE_FLOOR, RISK_RULES, OUT_OF_SCOPE,
    // 常量
    FAQS, FLOWS, ONBOARD, EVAL_SET, SYNONYMS,
    get GUARD_SET() { return DATA.GUARD_SET || []; },
    SLA_RESPONSE, SLA_RESOLVE, SLA_OWNER, CONF, W,
    // 工具
    uid, nowISO, fmtTime, detectIntent, inferCategory, inferPriority, slaTableText,
    _internal: {},
  };
})();
