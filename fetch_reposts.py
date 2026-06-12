#!/usr/bin/env python3
"""
微博转发用户抓取脚本
====================
从微博 m.weibo.cn API 抓取指定帖子的转发用户列表，输出为 JSON 和 TXT 文件。

使用方法：
  python3 fetch_reposts.py <微博帖子ID>

  微博帖子ID 从哪来？
  打开微博帖子，链接长这样：https://m.weibo.cn/status/5123456789012345
  里面那串数字 5123456789012345 就是帖子 ID

  Cookie 从哪来？运行脚本后会提示你输入，获取方式见下方。

如何获取 Cookie（只需一次，约 30 秒）：
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. 用 Chrome 或 Edge 打开 https://m.weibo.cn 并登录微博   │
  │ 2. 按 F12（或右键→检查）打开开发者工具                       │
  │ 3. 点顶部「Network」（网络）标签                              │
  │ 4. 在微博页面上随便点一下（刷新也行）                         │
  │ 5. 左侧列表会出现请求，点第一个                               │
  │ 6. 右侧找「Request Headers」→「Cookie」那一行               │
  │ 7. 双击 Cookie 值全选，Ctrl+C 复制                           │
  │ 8. 回到终端，粘贴后按回车                                     │
  └─────────────────────────────────────────────────────────────┘

选项：
  -o, --output   输出文件名（默认 reposts_<ID>.json）
  -m, --max      最大抓取页数（默认 200，约 4000 条转发）
  -v, --verbose  显示详细输出
"""

import json
import os
import ssl
import sys
import time
import argparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# macOS Python 常见 SSL 证书问题，跳过验证（仅影响本脚本的微博请求）
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

API_URL = "https://m.weibo.cn/api/statuses/repostTimeline"

# Cookie 缓存文件：输入过一次就记住，下次不用再粘贴
COOKIE_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".weibo_cookie")


def _extract_xsrf(cookie):
    """从 Cookie 字符串中提取 XSRF-TOKEN 值"""
    for part in cookie.split(";"):
        part = part.strip()
        if part.startswith("XSRF-TOKEN="):
            return part.split("=", 1)[1]
    return ""


def load_cookie():
    """从缓存文件或交互式输入获取 Cookie"""
    # 1. 尝试从缓存文件读取
    if os.path.exists(COOKIE_CACHE):
        with open(COOKIE_CACHE, "r") as f:
            cookie = f.read().strip()
        if cookie and len(cookie) > 50:
            print(f"🔑 已从缓存读取 Cookie（上次输入过的）")
            return cookie

    # 2. 交互式输入
    print()
    print("━" * 56)
    print("  需要你微博的 Cookie 来访问转发列表")
    print("  获取方法：")
    print()
    print("  1. Chrome 打开 https://m.weibo.cn 并登录")
    print("  2. 按 F12 打开开发者工具")
    print("  3. 点顶部「Network」标签")
    print("  4. 在微博页面点一下或刷新")
    print("  5. 点左侧出现的任意请求")
    print("  6. 右侧 Request Headers → Cookie")
    print("  7. 双击全选，Ctrl+C 复制")
    print("━" * 56)
    print()

    cookie = input("👉 粘贴 Cookie 后按回车：").strip()

    if not cookie or len(cookie) < 50:
        print("❌ Cookie 太短，可能复制不完整，请重新运行脚本")
        sys.exit(1)

    # 保存到缓存，下次不用再输入
    with open(COOKIE_CACHE, "w") as f:
        f.write(cookie)
    print("✅ Cookie 已保存到本地缓存，下次运行不用再输入")
    print("   （如需更换，删除 .weibo_cookie 文件即可）")
    print()

    return cookie


def resolve_post_id(post_id, cookie):
    """如果是短 ID（如 R1vno65Lz），自动转换为数字长 ID"""
    # 纯数字就无需转换
    if post_id.isdigit():
        return post_id

    print(f"🔄 检测到短 ID「{post_id}」，正在转换为数字 ID…")
    url = f"https://m.weibo.cn/api/statuses/show?id={post_id}"
    req = Request(url)
    req.add_header("Cookie", cookie)
    req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
    req.add_header("Referer", f"https://m.weibo.cn/status/{post_id}")
    req.add_header("X-Requested-With", "XMLHttpRequest")
    req.add_header("X-XSRF-TOKEN", _extract_xsrf(cookie))

    try:
        with urlopen(req, timeout=10, context=_ssl_ctx) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        numeric_id = str(data.get("id", ""))
        if numeric_id and numeric_id.isdigit():
            print(f"✅ 转换成功：{post_id} → {numeric_id}")
            return numeric_id
    except Exception as e:
        print(f"⚠️  短 ID 转换失败：{e}")

    print("   将尝试直接使用短 ID…")
    return post_id


def fetch_reposts(post_id, cookie, max_pages=200, verbose=False):
    """抓取指定帖子的所有转发用户"""

    # 先尝试把短 ID 转成数字 ID
    post_id = resolve_post_id(post_id, cookie)

    all_reposts = []
    seen_users = set()
    page = 1

    while page <= max_pages:
        url = f"{API_URL}?id={post_id}&page={page}"
        req = Request(url)
        req.add_header("Cookie", cookie)
        req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        req.add_header("Referer", f"https://m.weibo.cn/status/{post_id}")
        req.add_header("X-Requested-With", "XMLHttpRequest")
        req.add_header("X-XSRF-TOKEN", _extract_xsrf(cookie))

        try:
            with urlopen(req, timeout=10, context=_ssl_ctx) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            if e.code == 403:
                print(f"❌ 403 被拦截，Cookie 可能已过期")
                print("   删除 .weibo_cookie 文件后重新运行，输入新 Cookie")
                # 自动删除过期缓存
                if os.path.exists(COOKIE_CACHE):
                    os.remove(COOKIE_CACHE)
                    print("   已自动清除过期缓存")
                break
            elif e.code == 418:
                print(f"❌ 418 请求过快，等几分钟再来")
                break
            else:
                print(f"❌ HTTP {e.code}，停止抓取")
                break
        except URLError as e:
            print(f"❌ 网络错误: {e.reason}")
            break
        except Exception as e:
            print(f"❌ 解析错误: {e}")
            break

        # 检查返回数据
        if not data or data.get("ok") != 1:
            if data.get("msg"):
                print(f"⚠️  第 {page} 页: {data.get('msg')}")
            else:
                print(f"⚠️  第 {page} 页无数据，可能已到末尾")
            break

        reposts = data.get("data", {}).get("data", [])
        if not reposts:
            if verbose:
                print(f"📄 第 {page} 页: 无转发，已到末尾")
            break

        page_count = 0
        for r in reposts:
            user = r.get("user", {})
            screen_name = user.get("screen_name", "")
            uid = user.get("id", "")

            # 去重（同一用户多次转发只计一次）
            if uid and uid in seen_users:
                if verbose:
                    print(f"  ↳ 重复: @{screen_name}")
                continue

            if uid:
                seen_users.add(uid)

            all_reposts.append({
                "screen_name": screen_name,
                "uid": uid,
                "repost_text": (r.get("text", "") or "")[:100],
                "repost_time": r.get("created_at", ""),
            })
            page_count += 1

        print(f"📄 第 {page} 页: +{page_count} 人（累计 {len(all_reposts)}）")

        if page_count == 0:
            break

        page += 1
        # 随机延迟，避免被风控
        time.sleep(1.5 + (hash(page) % 10) * 0.1)

    return all_reposts


def main():
    parser = argparse.ArgumentParser(
        description="抓取微博转发用户列表",
        epilog="示例: python3 fetch_reposts.py 5123456789012345"
    )
    parser.add_argument("post_id", help="微博帖子 ID（链接里的那串数字）")
    parser.add_argument("-o", "--output", help="输出文件名", default=None)
    parser.add_argument("-m", "--max", type=int, default=200, help="最大抓取页数（默认200）")
    parser.add_argument("-v", "--verbose", action="store_true", help="显示详细输出")
    args = parser.parse_args()

    # 获取 Cookie（交互式或缓存）
    cookie = load_cookie()

    print(f"🔍 开始抓取微博 {args.post_id} 的转发用户…")
    print(f"   Cookie 长度: {len(cookie)} 字符")
    print()

    reposts = fetch_reposts(args.post_id, cookie=cookie, max_pages=args.max, verbose=args.verbose)

    if not reposts:
        print("\n❌ 未抓取到任何转发用户")
        sys.exit(1)

    # 输出文件
    output_file = args.output or f"reposts_{args.post_id}.json"

    output_data = {
        "post_id": args.post_id,
        "fetch_time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_reposts": len(reposts),
        "reposts": reposts,
    }

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    # 同时输出纯名单文本文件（方便直接粘贴到抽奖工具）
    names_file = output_file.replace(".json", "_names.txt")
    with open(names_file, "w", encoding="utf-8") as f:
        for r in reposts:
            f.write(r["screen_name"] + "\n")

    print(f"\n✅ 完成！")
    print(f"   转发用户: {len(reposts)} 人（已去重）")
    print(f"   详细数据: {output_file}")
    print(f"   纯名单:   {names_file}")
    print(f"\n💡 打开抽奖工具 index.html →「导入文件」→ 选择 {names_file}")


if __name__ == "__main__":
    main()
