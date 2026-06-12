// Cloudflare Pages Function: 代理彩票开奖 API
// 解决浏览器端跨域限制，服务端请求无 CORS 问题

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600', // 缓存1小时，开奖号码不变
  };

  // 处理 OPTIONS 预检请求
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  try {
    // 优先从 apihz.cn 获取
    const resp = await fetch(
      'https://cn.apihz.cn/api/caipiao/shuangseqiu.php?id=88888888&key=88888888',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    if (resp.ok) {
      const data = await resp.json();
      if (data.code === 200) {
        return new Response(
          JSON.stringify({
            ok: true,
            qihao: data.qihao,       // 期号
            number: data.number,     // 开奖号码 (红球|红球|...|蓝球)
            time: data.time,         // 开奖日期
            name: data.name,         // 彩种名
          }),
          { headers }
        );
      }
    }

    // 如果主 API 失败，返回错误
    return new Response(
      JSON.stringify({ ok: false, msg: '获取开奖数据失败，请稍后重试或手动输入' }),
      { headers, status: 502 }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, msg: '网络错误: ' + e.message }),
      { headers, status: 500 }
    );
  }
}
