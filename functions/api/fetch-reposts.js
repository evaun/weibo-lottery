/**
 * Cloudflare Pages Function: 微博转发用户抓取代理
 * 同时支持 PC 版(weibo.com) 与 手机版(m.weibo.cn) 的 Cookie，自动探测可用平台
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

// 手机版 m.weibo.cn 请求头
function mobileHeaders(cookie, refererId) {
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

// PC 版 weibo.com 请求头
function pcHeaders(cookie, uid, bid) {
  const ref = uid && bid ? `https://weibo.com/${uid}/${bid}` : 'https://weibo.com/';
  const h = {
    'Cookie': cookie,
    'User-Agent': UA,
    'Referer': ref,
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'client-version': 'v2.47.42',
  };
  const xsrf = extractXsrf(cookie);
  if (xsrf) h['X-XSRF-TOKEN'] = xsrf;
  return h;
}

// 解析帖子 ID → 数字 mid（通过微博官方接口，最可靠）
async function resolveMid(cookie, postId, uid, bid) {
  if (/^\d+$/.test(String(postId))) return String(postId);
  // 1) PC show 接口
  try {
    const r = await fetch(`https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(postId)}`, { headers: pcHeaders(cookie, uid, bid) });
    const d = await r.json();
    if (d && (d.idstr || d.id)) return String(d.idstr || d.id);
  } catch {}
  // 2) 手机版 show 接口
  try {
    const r = await fetch(`https://m.weibo.cn/api/statuses/show?id=${encodeURIComponent(postId)}`, { headers: mobileHeaders(cookie, postId) });
    const d = await r.json();
    if (d && d.id) return String(d.id);
  } catch {}
  return null;
}

// 从一页响应里提取用户名数组
function extractUsers(list) {
  const users = [];
  for (const r of (list || [])) {
    const name = r.user?.screen_name || r.user?.name;
    if (name) users.push(name);
  }
  return users;
}

// 尝试 PC 版抓取
async function fetchPC(cookie, mid, page, uid, bid) {
  const url = `https://weibo.com/ajax/statuses/repostTimeline?id=${mid}&page=${page}&moduleID=feed&count=20`;
  const resp = await fetch(url, { headers: pcHeaders(cookie, uid, bid) });
  let data;
  try { data = await resp.json(); } catch { return { list: null, raw: null }; }
  let list = null;
  if (Array.isArray(data?.data)) list = data.data;
  else if (Array.isArray(data?.data?.data)) list = data.data.data;
  const total = data?.total_number ?? data?.data?.total_number ?? 0;
  return { list, total, raw: data };
}

// 尝试手机版抓取
async function fetchMobile(cookie, mid, page) {
  const url = `https://m.weibo.cn/api/statuses/repostTimeline?id=${mid}&page=${page}`;
  const resp = await fetch(url, { headers: mobileHeaders(cookie, mid) });
  if (resp.status === 403) return { list: null, status: 403, raw: null };
  let data;
  try { data = await resp.json(); } catch { return { list: null, raw: null }; }
  const list = Array.isArray(data?.data?.data) ? data.data.data : null;
  const total = data?.data?.total ?? 0;
  return { list, total, raw: data };
}

function isLoginError(raw) {
  if (!raw) return false;
  if (raw.ok === -100) return true;
  const s = JSON.stringify(raw);
  return /passport\.weibo|sso\/signin|未登录|login/i.test(s);
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
    const { cookie, post_id, page, uid, bid, platform } = body;

    if (!cookie || !post_id) {
      return new Response(JSON.stringify({ ok: false, msg: '缺少帖子ID或Cookie' }), { headers: corsHeaders });
    }

    const pageNum = parseInt(page) || 1;

    // 1) 解析数字 mid
    const numericId = await resolveMid(cookie, post_id, uid, bid);
    if (!numericId) {
      return new Response(JSON.stringify({ ok: false, msg: '无法解析帖子 ID，请检查链接或直接使用数字 ID' }), { headers: corsHeaders });
    }

    // 2) 抓取一页 —— 已知平台则只跑该平台，否则 PC→手机 自动探测
    let result, used, lastRaw = null;

    if (platform === 'pc') {
      result = await fetchPC(cookie, numericId, pageNum, uid, bid); used = 'pc'; lastRaw = result.raw;
    } else if (platform === 'mobile') {
      result = await fetchMobile(cookie, numericId, pageNum); used = 'mobile'; lastRaw = result.raw;
    } else {
      // 自动探测：先 PC（用户多用电脑版 Cookie），失败再手机
      result = await fetchPC(cookie, numericId, pageNum, uid, bid); used = 'pc'; lastRaw = result.raw;
      if (!Array.isArray(result.list)) {
        const m = await fetchMobile(cookie, numericId, pageNum);
        lastRaw = m.raw || lastRaw;
        if (Array.isArray(m.list)) { result = m; used = 'mobile'; }
      }
    }

    // 3) 成功
    if (Array.isArray(result.list)) {
      const users = extractUsers(result.list);
      return new Response(JSON.stringify({
        ok: true,
        numericId,
        page: pageNum,
        platform: used,
        users,
        hasMore: result.list.length > 0,
        total: result.total || 0,
      }), { headers: corsHeaders });
    }

    // 4) 失败：判断是否登录问题
    if (isLoginError(lastRaw)) {
      return new Response(JSON.stringify({
        ok: false,
        code: 403,
        msg: 'Cookie 未登录或已失效。请重新登录微博（电脑版 weibo.com 或手机版 m.weibo.cn 均可），再用复制代码重新获取 Cookie。注意：复制时所在的网站，要和你登录的是同一个。',
      }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({
      ok: false,
      msg: '未获取到转发数据。微博返回：' + (lastRaw ? JSON.stringify(lastRaw).slice(0, 150) : '空响应'),
      numericId,
    }), { headers: corsHeaders });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, msg: '服务器错误：' + e.message }), { headers: corsHeaders });
  }
}
