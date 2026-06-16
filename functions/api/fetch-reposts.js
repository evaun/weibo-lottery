/**
 * Cloudflare Pages Function: 微博转发用户抓取代理
 * 解决浏览器 CORS 限制，服务端转发请求到 m.weibo.cn
 * Cookie 仅用于本次请求，不存储、不记录
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function extractXsrf(cookie) {
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('XSRF-TOKEN=')) {
      return trimmed.split('=').slice(1).join('=');
    }
  }
  return '';
}

function makeHeaders(cookie, refererId) {
  const h = {
    'Cookie': cookie,
    'User-Agent': UA,
    'Referer': `https://m.weibo.cn/status/${refererId}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  const xsrf = extractXsrf(cookie);
  if (xsrf) h['X-XSRF-TOKEN'] = xsrf;
  return h;
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  try {
    const body = await context.request.json();
    const { cookie, post_id, page } = body;

    if (!cookie || !post_id) {
      return new Response(JSON.stringify({ ok: false, msg: '缺少帖子ID或Cookie' }), { headers: corsHeaders });
    }

    const pageNum = parseInt(page) || 1;

    // 1) 短 ID → 数字 ID
    let numericId = post_id;
    if (!/^\d+$/.test(String(post_id))) {
      try {
        const showResp = await fetch(
          `https://m.weibo.cn/api/statuses/show?id=${encodeURIComponent(post_id)}`,
          { headers: makeHeaders(cookie, post_id) }
        );
        const showData = await showResp.json();
        if (showData && showData.id) {
          numericId = String(showData.id);
        } else {
          return new Response(JSON.stringify({ ok: false, msg: '短ID转换失败，请使用数字ID' }), { headers: corsHeaders });
        }
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, msg: '短ID转换出错：' + e.message }), { headers: corsHeaders });
      }
    }

    // 2) 抓取一页转发
    const url = `https://m.weibo.cn/api/statuses/repostTimeline?id=${numericId}&page=${pageNum}`;
    const resp = await fetch(url, { headers: makeHeaders(cookie, numericId) });

    if (resp.status === 403) {
      return new Response(JSON.stringify({ ok: false, msg: 'Cookie已过期或被微博拦截，请重新获取', code: 403 }), { headers: corsHeaders });
    }

    if (!resp.ok) {
      return new Response(JSON.stringify({ ok: false, msg: `微博返回HTTP ${resp.status}` }), { headers: corsHeaders });
    }

    let data;
    try {
      data = await resp.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, msg: '微博返回了非JSON数据' }), { headers: corsHeaders });
    }

    // 3) 提取用户名
    const reposts = data?.data?.data || [];

    // 微博接口层错误（如 ok:0 / 错误码），透传给前端便于诊断
    if (reposts.length === 0 && data && data.ok !== undefined && data.ok !== 1) {
      // ok:-100 或跳转登录页 = Cookie 未登录/失效
      const raw = JSON.stringify(data);
      const isLogin = data.ok === -100 || /passport\.weibo|sso\/signin|login/i.test(raw);
      if (isLogin) {
        return new Response(JSON.stringify({
          ok: false,
          code: 403,
          msg: 'Cookie 未登录或已失效。请确认：① Cookie 必须从手机版 m.weibo.cn 复制（不是电脑版 weibo.com）；② 复制前已在 m.weibo.cn 登录；③ Cookie 没有过期。请重新获取 Cookie 后再试。',
        }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify({
        ok: false,
        msg: '微博接口返回：' + (data.msg || raw.slice(0, 120)),
        weiboOk: data.ok,
        numericId,
      }), { headers: corsHeaders });
    }

    const users = [];
    const seen = new Set();
    for (const r of reposts) {
      const name = r.user?.screen_name || r.user?.name;
      if (name && !seen.has(name)) {
        seen.add(name);
        users.push(name);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      numericId,
      page: pageNum,
      users,
      hasMore: reposts.length > 0,
      total: data?.data?.total || 0,
    }), { headers: corsHeaders });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, msg: '服务器错误：' + e.message }), { headers: corsHeaders });
  }
}
