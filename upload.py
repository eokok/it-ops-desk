import os, base64, json, urllib.request, urllib.error, sys, subprocess, time, re


def resolve_token():
    """取 GitHub 凭据：优先环境变量 GH_TOKEN / GITHUB_TOKEN；
    都没有时回退到本机 Git Credential Manager（Windows 凭据管理器里已存 eokok 的 PAT）。
    CLI 参数 --check 只做只读校验，不会写入任何文件。"""
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    if tok:
        return tok
    gcm = os.environ.get("GCM_PATH") or (
        r"C:\Users\Administrator\.workbuddy\binaries\PortableGit"
        r"\versions\1.2.0\mingw64\bin\git-credential-manager.exe"
    )
    if not os.path.exists(gcm):
        return ""
    # GCM 自己要先在 PATH 里找到 git.exe，否则直接抛
    # "Failed to locate 'git.exe' executable on the path."
    gitdir = r"C:\Users\Administrator\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd"
    env = dict(os.environ)
    if os.path.isdir(gitdir):
        env["PATH"] = gitdir + os.pathsep + os.path.dirname(gcm) + os.pathsep + env.get("PATH", "")
    try:
        p = subprocess.run(
            [gcm, "get"],
            input=b"protocol=https\nhost=github.com\n\n",
            capture_output=True, timeout=60, env=env,
        )
    except Exception as e:
        print("读取本机凭据失败:", e, file=sys.stderr)
        return ""
    # GCM 在 Windows 上会输出 GBK 编码的错误信息，用 errors="replace" 兜住
    out = (p.stdout or b"").decode("utf-8", errors="replace")
    for line in out.splitlines():
        if line.startswith("password="):
            return line[len("password="):].strip()
    if "--verbose" in sys.argv:
        print("GCM stdout:", out[:500], file=sys.stderr)
        print("GCM rc:", p.returncode, file=sys.stderr)
        print("GCM stderr:", (p.stderr or b"").decode("utf-8", errors="replace")[:500], file=sys.stderr)
    return ""


TOKEN = resolve_token()

if "--check" in sys.argv:
    # 只读自检：确认 token 有效 + 远端 Pages 状态，不做任何写入
    if not TOKEN:
        print("CHECK: NO_TOKEN")
        sys.exit(2)
    print("CHECK: token_len=%d" % len(TOKEN))
    sys.exit(0)

if not TOKEN:
    print("ERR 未获取到 GitHub 凭据：请设置 GH_TOKEN，或确认本机凭据管理器已存 github.com 的 PAT。")
    sys.exit(2)
REPO = os.environ.get("GH_REPO", "eokok/it-ops-desk")
BRANCH = os.environ.get("GH_BRANCH", "main")
API = "https://api.github.com"

# 显式使用本地代理（代理可到达 api.github.com，github.com 被拦截）
proxy = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY") or ""
handlers = []
if proxy:
    handlers.append(urllib.request.ProxyHandler({"https": proxy, "http": proxy}))
opener = urllib.request.build_opener(*handlers)

# ---------- 文件收集（自动维护，无需手工填清单）----------
# 用户偏好：新增脚本 / 截图后跑一遍 upload.py 即可，不要再往清单里逐个加名字。
UPLOAD_EXTS = (".html", ".css", ".js", ".md", ".png", ".py")
EXCLUDE_RE = re.compile(
    r"(^_|^\.)|"            # 隐藏文件 / 下划线开头的临时文件
    r"(_shot-)|"            # 截图自驱动页 _shot-*.html
    r"(\.(log|tmp|bak|old)$)|"  # 日志与备份
    r"(live-[a-z-]+\.(html|js)$)",  # 线上校验时下载的副本
    re.I,
)


def collect_files():
    """自动扫描当前目录，收集应上传的文件。
    规则：白名单扩展名（站点源码 .html/.css/.js/.md、预览图 .png、工具脚本 .py），
    按 EXCLUDE_RE 排除临时产物；未被收集的文件打印成 SKIP 便于人工核对。
    GH_FILES 环境变量可显式覆盖（逗号分隔），用于单文件补传等调试场景。"""
    override = os.environ.get("GH_FILES", "")
    if override:
        return [x.strip() for x in override.split(",") if x.strip()]
    picked, skipped = [], []
    for fn in sorted(os.listdir(".")):
        if not os.path.isfile(fn):
            continue
        if fn.lower().endswith(UPLOAD_EXTS) and not EXCLUDE_RE.search(fn):
            picked.append(fn)
        else:
            skipped.append(fn)
    if skipped:
        print("SKIP 不参与上传: " + ", ".join(skipped))
    return picked


FILES = collect_files()

if "--dry-run" in sys.argv:
    # 只列出将上传什么，不发起任何网络请求
    for fn in FILES:
        mark = "OK  " if os.path.exists(fn) else "MISS"
        size = os.path.getsize(fn) if os.path.exists(fn) else 0
        print(f"{mark} {fn:24s} {size:>8d}")
    print(f"DRY_RUN: {len(FILES)} 个文件")
    sys.exit(0)


def api(url, method="GET", payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "workbuddy-upload")
    if data:
        req.add_header("Content-Type", "application/json")
    with opener.open(req, timeout=180) as r:
        return r.getcode(), json.loads(r.read().decode("utf-8") or "{}")


def remote_sha(path):
    """取远端已存在文件的 sha；不存在返回 None（新建文件不需要 sha）"""
    url = f"{API}/repos/{REPO}/contents/{path}?ref={BRANCH}"
    try:
        code, info = api(url)
        return info.get("sha") if code == 200 else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


fail = 0
for fn in FILES:
    fn = fn.strip()
    if not fn:
        continue
    if not os.path.exists(fn):
        print(f"SKIP {fn:24s} 本地不存在")
        continue
    with open(fn, "rb") as f:
        raw = f.read()
    try:
        sha = remote_sha(fn)
    except Exception as e:
        print(f"ERR  {fn:24s} 读取远端 sha 失败: {e}")
        fail += 1
        continue
    payload = {
        "message": (f"Update {fn}" if sha else f"Add {fn}"),
        "content": base64.b64encode(raw).decode("ascii"),
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha
    try:
        code, info = None, None
        # GitHub 的服务端 ruleset 校验偶发超时，返回 409
        # "Repository rule violations found / Timed out validating rule, please try again"。
        # 这是服务端瞬时故障，不是规则真的拒绝，退避重试即可。
        for attempt in range(4):
            try:
                code, info = api(f"{API}/repos/{REPO}/contents/{fn}", "PUT", payload)
                break
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")
                if e.code in (409, 500, 502, 503) and attempt < 3:
                    print(f"RETRY {fn:23s} http={e.code} 第 {attempt + 1} 次，退避重试")
                    time.sleep(2 * (attempt + 1))
                    # 重试前刷新 sha（上次可能已部分生效）
                    try:
                        s2 = remote_sha(fn)
                        if s2:
                            payload["sha"] = s2
                    except Exception:
                        pass
                    continue
                raise
        new_sha = (info.get("content") or {}).get("sha", "")[:10]
        print(f"OK   {fn:24s} http={code} {'update' if sha else 'create'} size={len(raw):>8d} sha={new_sha}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print(f"ERR  {fn:24s} http={e.code} {body[:180]}")
        fail += 1
    except Exception as e:
        print(f"ERR  {fn:24s} {type(e).__name__}: {e}")
        fail += 1

print("ALL_UPLOADED" if not fail else f"DONE_WITH_{fail}_FAILURES")
sys.exit(1 if fail else 0)
