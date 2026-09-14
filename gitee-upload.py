"""把当前目录的项目文件上传到 Gitee 仓库（OpenAPI v5）。

为什么不用 git push：本机代理只放行 api.github.com，github.com 被拦截；
Gitee 则相反 —— 直连可达、无需代理。

用法：
    python gitee-upload.py                 # 全量上传（自动收集文件清单）
    python gitee-upload.py --dry-run       # 只列清单，不发请求
    python gitee-upload.py --check         # 只读自检：验证凭据与仓库可达
    GITEE_FILES="README.md,app.js" python gitee-upload.py   # 只传指定文件

凭据来源：环境变量 GITEE_TOKEN / GITEE_ACCESS_TOKEN，
都没有时回退到本机 Git Credential Manager（Windows 凭据管理器里存的 gitee.com 令牌）。
"""
import os, base64, json, re, sys, time, subprocess, urllib.parse
import urllib.request, urllib.error

GITEE_API = "https://gitee.com/api/v5"
OWNER = os.environ.get("GITEE_OWNER", "eokok")
REPO_NAME = os.environ.get("GITEE_REPO", "it-ops-desk")
REPO = f"{OWNER}/{REPO_NAME}"
BRANCH = os.environ.get("GITEE_BRANCH", "main")


def resolve_token():
    """取 Gitee 令牌：优先环境变量，否则回退本机 Git Credential Manager。"""
    tok = (os.environ.get("GITEE_TOKEN") or os.environ.get("GITEE_ACCESS_TOKEN")
           or os.environ.get("GITEE_PAT") or "")
    if tok:
        return tok.strip()
    gcm = os.environ.get("GCM_PATH") or (
        r"C:\Users\Administrator\.workbuddy\binaries\PortableGit"
        r"\versions\1.2.0\mingw64\bin\git-credential-manager.exe"
    )
    if not os.path.exists(gcm):
        return ""
    # GCM 自己要先能在 PATH 里找到 git.exe，否则直接抛
    # "Failed to locate 'git.exe' executable on the path."
    gitdir = r"C:\Users\Administrator\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd"
    env = dict(os.environ)
    if os.path.isdir(gitdir):
        env["PATH"] = gitdir + os.pathsep + os.path.dirname(gcm) + os.pathsep + env.get("PATH", "")
    try:
        # 注意：input 必须是 bytes，且不能 text=True —— GCM 在 Windows 上输出 GBK，
        # 用 text 模式会撞 UnicodeDecodeError。
        p = subprocess.run([gcm, "get"], input=b"protocol=https\nhost=gitee.com\n\n",
                           capture_output=True, timeout=60, env=env)
    except Exception as e:
        print("读取本机凭据失败:", e, file=sys.stderr)
        return ""
    out = (p.stdout or b"").decode("utf-8", errors="replace")
    for line in out.splitlines():
        if line.startswith("password="):
            return line[len("password="):].strip()
    if "--verbose" in sys.argv:
        print("GCM rc:", p.returncode, file=sys.stderr)
        print("GCM stdout:", out[:400], file=sys.stderr)
        print("GCM stderr:", (p.stderr or b"").decode("utf-8", errors="replace")[:400], file=sys.stderr)
    return ""


TOKEN = resolve_token()

# ---------- 文件收集（自动维护，无需手工填清单）----------
# 与 upload.py（GitHub 侧）保持同一套规则，新增脚本 / 截图后直接跑即可。
UPLOAD_EXTS = (".html", ".css", ".js", ".md", ".png", ".py")
EXCLUDE_RE = re.compile(
    r"(^_|^\.)|"                # 隐藏文件 / 下划线开头的临时文件
    r"(_shot-)|"                # 截图自驱动页 _shot-*.html
    r"(\.(log|tmp|bak|old)$)|"  # 日志与备份
    r"(live-[a-z-]+\.(html|js)$)",  # 线上校验时下载的副本
    re.I,
)


def collect_files():
    override = os.environ.get("GITEE_FILES", "") or os.environ.get("GH_FILES", "")
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


def req(url, method="GET", payload=None, timeout=120):
    """Gitee 的 OpenAPI 用 form 编码最稳（JSON 传 bool 时会被忽略，例如 private=false）。"""
    body, ctype = None, None
    if payload is not None:
        body = urllib.parse.urlencode(payload, doseq=True).encode("utf-8")
        ctype = "application/x-www-form-urlencoded"
    r = urllib.request.Request(url, data=body, method=method)
    r.add_header("Authorization", "token " + TOKEN)
    r.add_header("User-Agent", "workbuddy-gitee-upload")
    if ctype:
        r.add_header("Content-Type", ctype)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8") or "{}"
        try:
            return resp.getcode(), json.loads(raw)
        except json.JSONDecodeError:
            return resp.getcode(), {"raw": raw[:300]}


def api(path, method="GET", payload=None):
    return req(f"{GITEE_API}/repos/{REPO}{path}", method, payload)


def remote_sha(path):
    """取远端已存在文件的 sha；不存在返回 None（新建不需要 sha）"""
    try:
        code, info = api(f"/contents/{path}")
        return info.get("sha") if code == 200 else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


# ---------- 只读自检 ----------
if "--check" in sys.argv:
    if not TOKEN:
        print("CHECK: NO_TOKEN（设置 GITEE_TOKEN 或确认凭据管理器存有 gitee.com 令牌）")
        sys.exit(2)
    print(f"CHECK: token_len={len(TOKEN)}")
    try:
        code, d = req(f"{GITEE_API}/user")
        print(f"CHECK: api/v5/user http={code} login={d.get('login')}")
        code2, d2 = api("")
        print(f"CHECK: repo {REPO} http={code2} private={d2.get('private')} "
              f"default_branch={d2.get('default_branch')}")
        print("CHECK: OK")
        sys.exit(0)
    except urllib.error.HTTPError as e:
        print(f"CHECK: FAIL http={e.code} {e.read().decode('utf-8', 'replace')[:200]}")
        sys.exit(1)
    except Exception as e:
        print(f"CHECK: FAIL {type(e).__name__}: {e}")
        sys.exit(1)

if not TOKEN:
    print("ERR 未获取到 Gitee 凭据：请设置 GITEE_TOKEN，或确认本机凭据管理器已存 gitee.com 的令牌。")
    sys.exit(2)

if "--dry-run" in sys.argv:
    for fn in FILES:
        exists = os.path.exists(fn)
        print(f"{'OK  ' if exists else 'MISS'} {fn:24s} {os.path.getsize(fn) if exists else 0:>8d}")
    print(f"DRY_RUN: {len(FILES)} 个文件 -> {REPO}@{BRANCH}")
    sys.exit(0)

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
        "content": base64.b64encode(raw).decode("ascii"),
        "message": f"{'Update' if sha else 'Add'} {fn}",
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha

    method = "PUT" if sha else "POST"
    try:
        code, info = None, None
        # Gitee 偶发限流 / 网关抖动（429/500/502/503），退避重试即可
        for attempt in range(4):
            try:
                code, info = api(f"/contents/{fn}", method, payload)
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")
                if e.code in (429, 500, 502, 503) and attempt < 3:
                    print(f"RETRY {fn:23s} http={e.code} 第 {attempt + 1} 次，退避重试")
                    time.sleep(2 * (attempt + 1))
                    try:
                        s2 = remote_sha(fn)
                        if s2:
                            payload["sha"] = s2
                            method = "PUT"
                    except Exception:
                        pass
                    continue
                raise urllib.error.HTTPError(e.url, e.code, detail, e.headers, None)
        new_sha = ((info or {}).get("content") or {}).get("sha", "")[:10]
        print(f"OK   {fn:24s} http={code} {'update' if sha else 'create'} "
              f"size={len(raw):>8d} sha={new_sha}")
    except urllib.error.HTTPError as e:
        body = e.reason if isinstance(e.reason, str) else str(e.reason)
        print(f"ERR  {fn:24s} http={e.code} {body[:180]}")
        fail += 1
    except Exception as e:
        print(f"ERR  {fn:24s} {type(e).__name__}: {e}")
        fail += 1
    time.sleep(0.25)  # 温和限速，避开 Gitee 的接口频率限制

print("ALL_UPLOADED" if not fail else f"DONE_WITH_{fail}_FAILURES")
sys.exit(1 if fail else 0)
