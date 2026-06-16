import { onRequestOptions as __api_fetch_reposts_js_onRequestOptions } from "/Users/evaun/WorkBuddy/2026-06-12-11-20-25/weibo-lottery/functions/api/fetch-reposts.js"
import { onRequestPost as __api_fetch_reposts_js_onRequestPost } from "/Users/evaun/WorkBuddy/2026-06-12-11-20-25/weibo-lottery/functions/api/fetch-reposts.js"

export const routes = [
    {
      routePath: "/api/fetch-reposts",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_fetch_reposts_js_onRequestOptions],
    },
  {
      routePath: "/api/fetch-reposts",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_fetch_reposts_js_onRequestPost],
    },
  ]