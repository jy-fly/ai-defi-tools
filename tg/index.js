// 通用 Telegram 推送模块（与具体协议无关，其他 DeFi 监控可直接复用）
const API = 'https://api.telegram.org';


/** 网络类错误时，把「Node 忽略代理变量」这个坑直接写进报错信息 */
function netHint(err) {
  const msg = String(err?.message || err);
  if (!/fetch failed|timeout|aborted|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(msg)) return '';
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
             || process.env.ALL_PROXY  || process.env.all_proxy;
  if (proxy && !process.env.NODE_USE_ENV_PROXY) {
    return `\n  ↳ 检测到代理 ${proxy}，但 Node 的内置 fetch 默认忽略代理环境变量。`
         + `\n    改用 \`npm run <命令>\` 或 \`./aave/monitor <命令>\` 启动，`
         + `\n    或手动加前缀：NODE_USE_ENV_PROXY=1 node aave/index.js ...`;
  }
  if (!proxy) {
    return '\n  ↳ 连不上 api.telegram.org。国内网络需要代理：先 export HTTPS_PROXY=http://127.0.0.1:7890，'
         + '再用 npm run / ./aave/monitor 启动。';
  }
  return '';
}

/** 把消息里可能出现的 token 抹掉 —— 请求 URL 含 token，
 *  而 public repo 的 CI 日志是公开的，不能赌错误消息里不带 URL */
function redact(msg, token) {
  const t = String(msg ?? '');
  return token ? t.split(token).join('<token已隐藏>') : t;
}

function creds(override = {}) {
  return {
    token: override.token || process.env.TELEGRAM_BOT_TOKEN || process.env.AAVE_TELEGRAM_BOT_TOKEN,
    chatId: override.chatId || process.env.TELEGRAM_CHAT_ID,
  };
}

/** 是否已配置好 token / chatId */
export function isConfigured(override) {
  const { token, chatId } = creds(override);
  return Boolean(token && chatId);
}

/**
 * 发送一条消息（默认 HTML 解析）
 * @param {string} text
 * @param {{silent?:boolean, token?:string, chatId?:string, parseMode?:string, retries?:number}} opts
 */
export async function sendMessage(text, opts = {}) {
  const { token, chatId } = creds(opts);
  if (!token || !chatId) {
    throw new Error(`缺少 Telegram 凭据（token=${token ? '有' : '空'} chatId=${chatId ? '有' : '空'}）`);
  }

  const retries = opts.retries ?? 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: opts.parseMode ?? 'HTML',
          disable_web_page_preview: true,
          disable_notification: Boolean(opts.silent),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok !== false) return body;

      // 429 限流：按 Telegram 给的 retry_after 等待后重试
      const retryAfter = body.parameters?.retry_after;
      if (res.status === 429 && retryAfter && attempt < retries) {
        await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
        continue;
      }
      throw new Error(redact(`Telegram ${res.status}: ${body.description || JSON.stringify(body)}`, token));
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(redact(`Telegram 发送失败: ${lastErr?.message || lastErr}${netHint(lastErr)}`, token));
}

/** HTML 模式下必须转义的字符 */
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 拉取 chat_id：把 bot 加进群或私聊发一条消息后调用 */
export async function getChatIds(token = process.env.TELEGRAM_BOT_TOKEN) {
  if (!token) throw new Error('缺少 Telegram bot token');
  let res;
  try {
    res = await fetch(`${API}/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(redact(`拉取会话失败: ${e.message}${netHint(e)}`, token));
  }
  const body = await res.json();
  if (!body.ok) throw new Error(redact(`Telegram: ${body.description}`, token));
  const seen = new Map();
  for (const u of body.result || []) {
    const chat = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (chat) seen.set(chat.id, chat.title || chat.username || `${chat.first_name || ''}`.trim() || chat.type);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}
