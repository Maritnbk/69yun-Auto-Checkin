const fs = require('fs');

/**
 * 封装配置读取逻辑
 * 优先从环境变量读取（GitHub Actions 规范），备选本地 config.json
 */
const CONFIG = {
    domain: process.env.DOMAIN,
    user: process.env.USER,
    pass: process.env.PASS,
    pushplusToken: process.env.PUSHPLUS_TOKEN,
    pushplusTopic: process.env.PUSHPLUS_TOPIC
};

// 辅助函数：等待
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 带有重试机制的请求封装
 */
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            if (response.status >= 500) throw new Error(`Server Error: ${response.status}`);
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`请求失败，正在进行第 ${i + 1} 次重试...`);
            await sleep(2000);
        }
    }
}

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

async function runCheckin() {
    let message = "";
    const baseUrl = CONFIG.domain.startsWith('http') ? CONFIG.domain : `https://${CONFIG.domain}`;

    try {
        if (!CONFIG.domain || !CONFIG.user || !CONFIG.pass) {
            throw new Error('配置缺失：请在 GitHub Secrets 中设置 DOMAIN, USER, PASS');
        }

        console.log(`[${new Date().toLocaleTimeString()}] 开始执行签到: ${CONFIG.user}`);

        // 1. 登录
        const loginRes = await fetchWithRetry(`${baseUrl}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: JSON.stringify({ email: CONFIG.user, passwd: CONFIG.pass })
        });

        const loginJson = await loginRes.json();
        if (loginJson.ret !== 1) throw new Error(`登录失败: ${loginJson.msg}`);

        // 提取 Cookie
        const setCookie = loginRes.headers.get('set-cookie');
        const cookies = setCookie ? setCookie.split(',').map(c => c.split(';')[0]).join('; ') : '';

        // 2. 随机延迟 (1-5秒)，模拟真人操作
        await sleep(Math.random() * 4000 + 1000);

        // 3. 签到
        const checkinRes = await fetchWithRetry(`${baseUrl}/user/checkin`, {
            method: 'POST',
            headers: {
                'Cookie': cookies,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const result = await checkinRes.json();
        message = `🎉 ${result.msg || '签到成功'}`;
        console.log("签到结果:", result.msg);

    } catch (error) {
        message = `❌ 失败: ${error.message}`;
        console.error(message);
    } finally {
        const report = `账号: ${CONFIG.user}<br>域名: ${CONFIG.domain}<br>状态: ${message}`;
        await sendPushPlusNotification('每日签到报告', report);
    }
}

runCheckin();
