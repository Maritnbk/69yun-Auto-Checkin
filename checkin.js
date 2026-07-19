const fs = require('fs');

/**
 * 封装配置读取逻辑
 * 优先从环境变量读取（GitHub Actions 规范），备选本地 config.json
 * 兼容原项目 CF-Workers-checkin 的变量名 (JC/ZH/MM)
 */
const CONFIG = {
    domain: process.env.DOMAIN || process.env.JC,
    user: process.env.USER || process.env.ZH,
    pass: process.env.PASS || process.env.MM,
    pushplusToken: process.env.PUSHPLUS_TOKEN,
    pushplusTopic: process.env.PUSHPLUS_TOPIC
};

// 辅助函数：等待
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

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

// ---- 带有重试机制的请求封装 ----
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            // 服务器错误可重试
            if (response.status >= 500) throw new Error(`Server Error: ${response.status}`);
            // 客户端错误（4xx）无需重试，直接返回
            if (response.status >= 400 && response.status < 500) return response;
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`请求失败，正在进行第 ${i + 1} 次重试...`);
            await sleep(2000);
        }
    }
}

// ---- PushPlus 通知 ----
async function sendPushPlusNotification(title, content) {
    if (!CONFIG.pushplusToken) return;

    const body = {
        token: CONFIG.pushplusToken,
        title,
        content,
        template: 'html',
        topic: CONFIG.pushplusTopic || undefined
    };

    try {
        await fetch('https://www.pushplus.plus/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        console.log("PushPlus 通知已发出");
    } catch (error) {
        console.error("发送通知失败:", error.message);
    }
}

// ---- 核心签到逻辑 ----
async function runCheckin() {
    const capturedLogs = [];
    const log = (msg) => { console.log(msg); capturedLogs.push(msg); };
    let message = "";
    const baseUrl = CONFIG.domain.startsWith('http') ? CONFIG.domain : `https://${CONFIG.domain}`;

    try {
        if (!CONFIG.domain || !CONFIG.user || !CONFIG.pass) {
            throw new Error('配置缺失：请在 GitHub Secrets 中设置 DOMAIN, USER, PASS');
        }

        log(`[${new Date().toLocaleTimeString()}] 开始执行签到: ${CONFIG.user}`);

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

        const loginJson = await loginRes.json();
        if (loginJson.ret !== 1) throw new Error(`登录失败: ${loginJson.msg || '未知错误'}`);
        log("✓ 登录验证通过");

        // 合并登录后的 Cookie
        const loginCookies = extractCookies(loginRes);
        allCookies = mergeCookies(allCookies, loginCookies);
        if (allCookies.length === 0) throw new Error("登录后未能获取到有效的 Cookie");
        log(`登录后 Cookie (${allCookies.length}): ${cookieNameList(allCookies)}`);

        // Step 3: 随机延迟 (1-5秒)，模拟真人操作
        const delay = Math.random() * 4000 + 1000;
        log(`等待 ${(delay / 1000).toFixed(1)}s 后签到...`);
        await sleep(delay);

        // Step 4: 签到
        log("发送签到请求...");
        const checkinRes = await fetchWithRetry(`${baseUrl}/user/checkin`, {
            method: 'POST',
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
            throw new Error(`签到请求被重定向 (HTTP ${checkinRes.status}) -> ${location}，Cookie/Session 失效`);
        }

        if (!checkinRes.ok) {
            throw new Error(`签到请求失败 (HTTP ${checkinRes.status})`);
        }

        const result = await checkinRes.json();
        message = `🎉 ${result.msg || '签到成功'}`;
        log(`签到结果: ${result.msg}`);
        log("✓ 签到流程完成");

    } catch (error) {
        message = `❌ 失败: ${error.message}`;
        log(`X ${error.message}`);
        console.error(message);
    } finally {
        const report = `<b>账号:</b> ${CONFIG.user}<br><b>域名:</b> ${CONFIG.domain}<br><b>签到结果:</b> ${message}`;
        await sendPushPlusNotification('机场每日签到报告', report);
    }
}

runCheckin();
