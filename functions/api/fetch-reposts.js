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
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); }
  catch { return { list: null, raw: { _status: resp.status, _nonjson: text.slice(0, 200) } }; }
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
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); }
  catch { return { list: null, raw: { _status: resp.status, _nonjson: text.slice(0, 200) } }; }
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

// 截取原始返回的关键信息，用于前端诊断
function snippet(raw) {
  if (raw === null || raw === undefined) return '无响应';
  try {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return s.slice(0, 200);
  } catch {
    return String(raw).slice(0, 200);
  }
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
    let pcRaw = null, mobileRaw = null;

    if (platform === 'pc') {
      result = await fetchPC(cookie, numericId, pageNum, uid, bid); used = 'pc'; lastRaw = result.raw; pcRaw = result.raw;
    } else if (platform === 'mobile') {
      result = await fetchMobile(cookie, numericId, pageNum); used = 'mobile'; lastRaw = result.raw; mobileRaw = result.raw;
    } else {
      // 自动探测：先 PC（用户多用电脑版 Cookie），失败再手机
      result = await fetchPC(cookie, numericId, pageNum, uid, bid); used = 'pc'; lastRaw = result.raw; pcRaw = result.raw;
      if (!Array.isArray(result.list)) {
        const m = await fetchMobile(cookie, numericId, pageNum);
        mobileRaw = m.raw;
        if (Array.isArray(m.list)) { result = m; used = 'mobile'; lastRaw = m.raw; }
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

    // 4) 失败：PC 是否登录问题（PC Cookie 是主路径，以 PC 结果为准判断）
    const pcLogin = isLoginError(pcRaw);
    const mobileLogin = isLoginError(mobileRaw);

    // 仅当 PC 也判定为登录失败时，才提示重新登录（避免被手机回退误导）
    if (pcLogin || (platform === 'mobile' && mobileLogin)) {
      return new Response(JSON.stringify({
        ok: false,
        code: 403,
        msg: 'Cookie 未登录或已失效。请重新登录微博后，用复制代码重新获取 Cookie。',
        _debug: { pc: snippet(pcRaw), mobile: snippet(mobileRaw), mid: numericId },
      }), { headers: corsHeaders });
    }

    // 其它失败：把 PC + 手机的原始返回都带回，便于诊断
    return new Response(JSON.stringify({
      ok: false,
      msg: '未获取到转发数据（诊断信息见下）。PC：' + snippet(pcRaw) + ' ｜ 手机：' + snippet(mobileRaw),
      numericId,
      _debug: { pc: snippet(pcRaw), mobile: snippet(mobileRaw), mid: numericId },
    }), { headers: corsHeaders });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, msg: '服务器错误：' + e.message }), { headers: corsHeaders });
  }
}
