/**
 * 69云自动签到脚本（GitHub Actions 版）
 *
 * 本项目修改自 CMLiussss 的 CF-Workers-checkin（Apache-2.0）：
 * https://github.com/cmliussss2024/CF-Workers-checkin
 * 原版运行在 Cloudflare Workers 上，本版改为在 GitHub Actions 中执行，
 * 推送通道由 Telegram 改为 PushPlus。
 *
 * 配置全部来自环境变量（见 README），不读取本地文件。
 */

/**
 * 封装配置读取逻辑
 *
 * 只读取带 CHECKIN_ 前缀的变量名（以及上游项目的 ZH/MM）。
 * 刻意不读 process.env.USER / PASS —— Linux runner 上 USER 恒为 runner，
 * 本地调试时又是本机用户名，一旦误用就会拿系统账号去登录，
 * 报"登录失败"而不是"配置缺失"，极难排查。
 * 旧版 Secret 名的兼容由 workflow 里的表达式回退处理。
 */
const CONFIG = {
    domain: process.env.CHECKIN_DOMAIN || process.env.JC,
    user: process.env.CHECKIN_USER || process.env.ZH,
    pass: process.env.CHECKIN_PASS || process.env.MM,
    pushplusToken: process.env.PUSHPLUS_TOKEN,
    pushplusTopic: process.env.PUSHPLUS_TOPIC,
    // 逃生开关：站点确实只支持 http 时才开启，否则拒绝明文传输账号密码
    allowInsecureHttp: /^(1|true|yes)$/i.test(process.env.ALLOW_INSECURE_HTTP || '')
};

// 辅助函数：等待
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// 单个请求的超时时间，避免站点挂起时把 job 拖到 GitHub 的 6 小时上限
const REQUEST_TIMEOUT_MS = 20000;
// 推送接口的超时时间
const PUSH_TIMEOUT_MS = 15000;
// 这些状态码代表"稍后重试可能成功"，其余 4xx 视为确定性失败
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// 整流程重试：单请求重试无法解决"session 尚未就绪"这类时序问题
const FLOW_RETRIES = 3;
const FLOW_RETRY_DELAY_MS = 5000;

// 登录后轮询 /user 确认 session 生效的次数与间隔
const SESSION_MAX_CHECKS = 6;
const SESSION_FIRST_DELAY_MS = 1500;
const SESSION_RETRY_DELAY_MS = 2000;
// 会话探测用较短超时：它只是"探一下通不通"，不值得等 20 秒
const SESSION_CHECK_TIMEOUT_MS = 8000;

// 整流程总时长上限（毫秒）。超过后不再发起新的重试，
// 保证 job 在 GitHub 的 5 分钟 timeout-minutes 内结束并给出结论。
const FLOW_BUDGET_MS = 240000;

/** 带可重试标记的错误 */
class CheckinError extends Error {
    constructor(message, { retryable = false } = {}) {
        super(message);
        this.name = 'CheckinError';
        this.retryable = retryable;
    }
}

/** 北京时间戳（runner 默认 UTC，直接用会差 8 小时） */
function nowBeijing() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
}

/** 账号脱敏：公开仓库的 Actions 日志对所有访问者可见 */
function maskAccount(account) {
    if (!account) return '(未配置)';
    const at = account.indexOf('@');
    if (at > 0) {
        return `${account.slice(0, 1)}***@${account.slice(at + 1)}`;
    }
    if (account.length <= 2) return '***';
    return `${account.slice(0, 1)}***`;
}

/**
 * HTML 转义。
 * 推送使用 template: 'html'，站点返回的 msg 若含 < > & 会破坏排版，
 * 也构成一处轻微的注入面。
 */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---- Cookie 辅助函数（移植自 CF-Workers-checkin） ----

/** 从 Response 中提取 Cookie name=value 对 */
function extractCookies(response) {
    const pairs = [];
    if (response.headers.getSetCookie) {
        const setCookies = response.headers.getSetCookie();
        for (const cookie of setCookies) {
            const nameValue = cookie.split(';')[0];
            if (nameValue && nameValue.includes('=')) pairs.push(nameValue);
        }
    } else {
        const cookieHeader = response.headers.get('set-cookie');
        if (cookieHeader) {
            const parts = cookieHeader.split(/,\s*(?=[a-zA-Z0-9_-]+\s*=)/);
            for (const part of parts) {
                const nameValue = part.split(';')[0];
                if (nameValue && nameValue.includes('=')) pairs.push(nameValue);
            }
        }
    }
    return pairs;
}

/** Cookie pair 数组转 Map（按 name 去重） */
function cookieMap(pairs) {
    const map = new Map();
    for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) map.set(pair.substring(0, eqIdx).trim(), pair);
    }
    return map;
}

/** 合并两组 Cookie，同名以最新为准 */
function mergeCookies(existing, newPairs) {
    const map = cookieMap(existing);
    for (const pair of newPairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) map.set(pair.substring(0, eqIdx).trim(), pair);
    }
    return Array.from(map.values());
}

/** Cookie pair 数组转请求头字符串 */
function cookieString(pairs) {
    return pairs.join('; ');
}

/** 仅输出 Cookie 名称（调试用，不泄漏值） */
function cookieNameList(pairs) {
    return pairs.map(p => p.split('=')[0]).join(', ');
}

/** 丢弃响应体，释放底层连接 */
async function discardBody(response) {
    await response.body?.cancel().catch(() => {});
}

// ---- 带有重试机制的请求封装 ----

/**
 * 发起请求并处理重试。
 * - 2xx：直接返回
 * - 429 / 5xx / 408 / 网络错误 / 超时：退避后重试
 * - 3xx / 其它 4xx：确定性结果，原样返回交给调用方判断
 * 重试耗尽后抛出 CheckinError(retryable=true)，绝不返回 undefined。
 */
async function fetchWithRetry(url, options = {}, { retries = 3 } = {}) {
    let lastError;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });

            if (response.ok) return response;

            if (RETRYABLE_STATUS.has(response.status)) {
                lastError = new CheckinError(`HTTP ${response.status}`, { retryable: true });
                await discardBody(response);
            } else {
                // 3xx 与其它 4xx：重试也不会改变结果，交给调用方处理
                return response;
            }
        } catch (err) {
            lastError = err.name === 'TimeoutError'
                ? new CheckinError(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`, { retryable: true })
                : new CheckinError(`网络错误: ${err.message}`, { retryable: true });
        }

        if (attempt < retries - 1) {
            // 指数退避 + 抖动：2s、4s，避免连续失败时触发站点限流
            const backoff = 2000 * (2 ** attempt) + Math.floor(Math.random() * 1000);
            console.warn(`请求失败（${lastError.message}），${(backoff / 1000).toFixed(1)}s 后进行第 ${attempt + 1} 次重试...`);
            await sleep(backoff);
        }
    }

    throw lastError ?? new CheckinError('请求失败：未知原因', { retryable: true });
}

/**
 * 安全解析 JSON。
 * 站点返回 HTML 错误页 / 空响应时，给出可读的错误而不是 "Unexpected token '<'"。
 */
async function readJson(response, label) {
    const raw = await response.text();
    try {
        return JSON.parse(raw);
    } catch {
        const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
        throw new CheckinError(
            `${label}返回了非 JSON 内容 (HTTP ${response.status})：${snippet || '<空响应>'}`,
            { retryable: true }
        );
    }
}

// ---- PushPlus 通知 ----

/**
 * 发送推送。PushPlus 的业务错误一律返回 HTTP 200，错误码在 body 里，
 * 所以必须解析响应体，否则 token 失效时日志仍显示"已发出"。
 * @returns {{ok: boolean, skipped?: boolean, detail?: string}}
 */
async function sendPushPlusNotification(title, content) {
    if (!CONFIG.pushplusToken) {
        console.warn('未配置 PUSHPLUS_TOKEN，跳过推送');
        return { ok: false, skipped: true };
    }

    const body = {
        token: CONFIG.pushplusToken,
        title,
        content,
        template: 'html',
        topic: CONFIG.pushplusTopic || undefined
    };

    try {
        const res = await fetch('https://www.pushplus.plus/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
        });

        const json = await res.json().catch(() => null);
        if (!res.ok || !json || json.code !== 200) {
            const detail = json ? `code=${json.code} ${json.msg || ''}`.trim() : `HTTP ${res.status}`;
            console.error(`PushPlus 推送失败: ${detail}`);
            return { ok: false, detail };
        }

        console.log("PushPlus 通知已发出");
        return { ok: true };
    } catch (error) {
        console.error("发送通知失败:", error.message);
        return { ok: false, detail: error.message };
    }
}

// ---- 会话就绪校验 ----

/**
 * 登录成功后轮询 /user 确认 session 真正生效。
 * 机场面板常用 Redis 存 session，登录写入到可读之间有延迟，
 * 过早签到会被踢回登录页（表现为 302）。
 *
 * 注意：这里刻意使用裸 fetch 而非 fetchWithRetry —— 本函数自身就是轮询机制，
 * 若再叠加请求级重试，重试次数会相乘（6 检查 × 3 重试 × 3 轮流程 = 54 次），
 * 最坏耗时会膨胀到 20 分钟以上。
 *
 * @returns {Promise<boolean>} session 是否确认就绪
 */
async function waitForSession(baseUrl, cookies, log) {
    for (let check = 1; check <= SESSION_MAX_CHECKS; check++) {
        await sleep(check === 1 ? SESSION_FIRST_DELAY_MS : SESSION_RETRY_DELAY_MS);

        let res;
        try {
            res = await fetch(`${baseUrl}/user`, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
                headers: {
                    'Cookie': cookieString(cookies),
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Referer': `${baseUrl}/auth/login`,
                }
            });
        } catch (err) {
            // 单次探测失败不终止流程，继续下一轮
            log(`会话探测失败（${err.name === 'TimeoutError' ? '超时' : err.message}），继续检查... (${check}/${SESSION_MAX_CHECKS})`);
            continue;
        }

        await discardBody(res);

        if (res.status === 200 || res.status === 304) {
            log(`✓ 会话验证通过 (第 ${check} 次检查)`);
            return true;
        }

        if (res.status >= 300 && res.status < 400) {
            log(`会话尚未就绪 (HTTP ${res.status})，等待重试... (${check}/${SESSION_MAX_CHECKS})`);
            continue;
        }

        // 其它状态码无法用来判断 session 状态，不阻塞签到流程
        log(`会话验证返回 HTTP ${res.status}，跳过等待`);
        return true;
    }

    return false;
}

// ---- 单次签到流程 ----

/**
 * 执行一次完整的签到流程（登录 + 会话校验 + 签到）。
 * 成功返回结果文案；失败抛出 CheckinError，由上层决定是否整体重试。
 */
async function runCheckinOnce(baseUrl, log) {
    // Step 1: 访问登录页获取初始 session Cookie
    log("访问站点获取初始会话...");
    const initResponse = await fetchWithRetry(`${baseUrl}/auth/login`, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
    });
    let allCookies = extractCookies(initResponse);
    await discardBody(initResponse);
    if (allCookies.length > 0) {
        log(`初始 Cookie: ${cookieNameList(allCookies)}`);
    } else {
        log("初始访问未获取到 Cookie");
    }

    // Step 2: 登录（携带初始 Cookie 以绑定 session）
    log(`请求登录接口: ${baseUrl}/auth/login`);
    const loginRes = await fetchWithRetry(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Origin': baseUrl,
            'Referer': `${baseUrl}/auth/login`,
            'Cookie': cookieString(allCookies),
        },
        body: JSON.stringify({ email: CONFIG.user, passwd: CONFIG.pass, remember_me: 'on' })
    });

    if (!loginRes.ok) {
        throw new CheckinError(`登录请求失败 (HTTP ${loginRes.status})`, { retryable: true });
    }

    const loginJson = await readJson(loginRes, '登录接口');
    if (loginJson.ret !== 1) {
        // 账号密码错误重试也无用，直接判失败
        throw new CheckinError(`登录失败: ${loginJson.msg || '未知错误'}`, { retryable: false });
    }
    log("✓ 登录验证通过");

    // 合并登录后的 Cookie
    const loginCookies = extractCookies(loginRes);
    allCookies = mergeCookies(allCookies, loginCookies);
    if (allCookies.length === 0) {
        throw new CheckinError("登录后未能获取到有效的 Cookie", { retryable: true });
    }
    log(`登录后 Cookie (${allCookies.length}): ${cookieNameList(allCookies)}`);

    // Step 3: 确认 session 已生效，再随机延迟模拟真人操作
    const sessionReady = await waitForSession(baseUrl, allCookies, log);
    if (!sessionReady) {
        throw new CheckinError(
            `会话验证失败: 登录成功但 Session 始终未就绪（已检查 ${SESSION_MAX_CHECKS} 次）`,
            { retryable: true }
        );
    }

    const delay = Math.random() * 4000 + 1000;
    log(`等待 ${(delay / 1000).toFixed(1)}s 后签到...`);
    await sleep(delay);

    // Step 4: 签到
    log("发送签到请求...");
    const checkinRes = await fetchWithRetry(`${baseUrl}/user/checkin`, {
        method: 'POST',
        redirect: 'manual',   // 必须手动处理，否则 3xx 会被 fetch 内部跟随、永远看不到
        headers: {
            'Cookie': cookieString(allCookies),
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Origin': baseUrl,
            'Referer': `${baseUrl}/user`,
            'X-Requested-With': 'XMLHttpRequest'
        }
    });

    // 检测重定向（session 失效的典型信号）
    if (checkinRes.status >= 300 && checkinRes.status < 400) {
        const location = checkinRes.headers.get('location') || '未知';
        await discardBody(checkinRes);
        throw new CheckinError(
            `签到被重定向 (HTTP ${checkinRes.status}) → ${location}，Cookie/Session 已失效`,
            { retryable: true }
        );
    }

    if (!checkinRes.ok) {
        throw new CheckinError(`签到请求失败 (HTTP ${checkinRes.status})`, { retryable: true });
    }

    const result = await readJson(checkinRes, '签到接口');

    // 依据业务返回码判断结果：ret=1 成功，ret=0 失败
    const isSuccess = result.ret === 1 || result.ret === true || result.success === true;
    const isAlreadyCheckedIn = !isSuccess && /已签到|已经签到|重复签到|今日已签/.test(result.msg || '');

    if (isSuccess) {
        const msg = `🎉 ${result.msg || '签到成功'}`;
        log(`签到结果: ${msg}`);
        return msg;
    }

    if (isAlreadyCheckedIn) {
        // 幂等成功：今日已签到不是故障，多时段兜底重跑时会命中
        log(`签到结果: ✅ 今日已签到（无需重复）（站点提示: ${result.msg}）`);
        return '✅ 今日已签到（无需重复）';
    }

    // 站点 msg 常自带"签到失败："前缀，避免拼出"签到失败: 签到失败：xxx"
    const detail = (result.msg || '未知错误').replace(/^签到失败[：:]\s*/, '');
    throw new CheckinError(
        `签到失败: ${detail}（ret=${JSON.stringify(result.ret)}）`,
        { retryable: false }
    );
}

// ---- 核心签到逻辑 ----
async function runCheckin() {
    const log = (msg) => console.log(msg);
    let message = "";
    let failed = false;

    const buildReport = (msg) =>
        `<b>账号:</b> ${escapeHtml(maskAccount(CONFIG.user))}<br>` +
        `<b>域名:</b> ${escapeHtml(CONFIG.domain || '(未配置)')}<br>` +
        `<b>签到结果:</b> ${escapeHtml(msg)}`;

    // 配置校验必须放在任何解引用之前，否则缺配置时会在 try 外崩溃、连通知都发不出去
    const missingKeys = ['domain', 'user', 'pass'].filter(key => !CONFIG[key]);
    if (missingKeys.length > 0) {
        const names = missingKeys
            .map(k => ({ domain: 'CHECKIN_DOMAIN', user: 'CHECKIN_USER', pass: 'CHECKIN_PASS' })[k])
            .join(', ');
        message = `❌ 失败: 配置缺失 (${names})，请在 GitHub Secrets 中设置`;
        console.error(message);
        await sendPushPlusNotification('机场每日签到报告', buildReport(message));
        process.exitCode = 1;
        return;
    }

    // 统一去掉尾部斜杠，避免 "https://x.com/" 拼出 "https://x.com//auth/login"
    const baseUrl = (CONFIG.domain.startsWith('http') ? CONFIG.domain : `https://${CONFIG.domain}`)
        .replace(/\/+$/, '');

    try {
        // 明文 http 会暴露账号密码，默认拒绝
        if (!/^https:\/\//i.test(baseUrl)) {
            if (!CONFIG.allowInsecureHttp) {
                throw new CheckinError(
                    `域名必须使用 https://（当前: ${baseUrl}）。` +
                    `如站点确实只支持 http，请设置 ALLOW_INSECURE_HTTP=true 后重试`,
                    { retryable: false }
                );
            }
            log('⚠️ 警告: 正在使用 http:// 明文传输账号密码');
        }

        log(`[${nowBeijing()}] 开始执行签到: ${maskAccount(CONFIG.user)}`);

        const flowStart = Date.now();
        for (let attempt = 1; attempt <= FLOW_RETRIES; attempt++) {
            if (attempt > 1) {
                log(`—— 第 ${attempt}/${FLOW_RETRIES} 次整体重试 ——`);
            }

            try {
                message = await runCheckinOnce(baseUrl, log);
                log("✓ 签到流程完成");
                break;
            } catch (error) {
                const retryable = error instanceof CheckinError ? error.retryable : false;
                const elapsed = Date.now() - flowStart;
                const budgetLeft = FLOW_BUDGET_MS - elapsed;

                if (!retryable || attempt === FLOW_RETRIES) {
                    const suffix = retryable ? `（已重试 ${FLOW_RETRIES} 次）` : '';
                    throw new CheckinError(`${error.message}${suffix}`, { retryable: false });
                }

                // 剩余预算不足以再跑一轮时，直接放弃，避免 job 被 GitHub 强杀
                if (budgetLeft < FLOW_RETRY_DELAY_MS + 30000) {
                    throw new CheckinError(
                        `${error.message}（已耗时 ${Math.round(elapsed / 1000)}s，` +
                        `剩余时间不足以再重试一轮，提前结束）`,
                        { retryable: false }
                    );
                }

                log(`X 第 ${attempt} 次尝试失败: ${error.message}`);
                log(`等待 ${FLOW_RETRY_DELAY_MS / 1000}s 后重试整个流程...`);
                await sleep(FLOW_RETRY_DELAY_MS);
            }
        }
    } catch (error) {
        failed = true;
        message = `❌ 失败: ${error.message}`;
        log(`X ${error.message}`);
        console.error(message);
    } finally {
        const pushResult = await sendPushPlusNotification('机场每日签到报告', buildReport(message));
        // 推送失败意味着告警通道断了，同样应让 workflow 标红
        if (!pushResult.ok && !pushResult.skipped) {
            failed = true;
            console.error(`告警推送失败（${pushResult.detail}），本次运行标记为失败`);
        }
    }

    // 失败时以非零退出码结束，让 GitHub Actions 如实标记失败
    if (failed) process.exitCode = 1;
}

runCheckin().catch((error) => {
    // 兜底：finally 之外的意外异常（例如推送函数自身抛错）
    console.error('未捕获的异常:', error);
    process.exitCode = 1;
});
