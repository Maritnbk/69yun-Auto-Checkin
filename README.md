# 🚀 69云自动签到助手

通过 GitHub Actions 每天自动完成 69云 签到，并将结果推送到微信。

本项目修改自 [CMLiussss](https://github.com/cmliussss2024) 的 [CF-Workers-checkin](https://github.com/cmliussss2024/CF-Workers-checkin)。
原项目运行在 Cloudflare Workers 上、通过 Telegram Bot 推送；本版改为在 GitHub Actions 中执行，推送通道改为 **PushPlus**。

---

## 🌟 功能特性

* **自动签到**：每天定时执行，失败时自动重试。
* **幂等安全**：脚本会识别"今日已签到"并视为成功，重复运行（手动触发或补跑）不会重复签到，也不会误报失败。
* **凭据安全**：账号密码保存在 GitHub Secrets，代码中不含任何敏感信息；日志与推送中的邮箱均做脱敏处理。
* **失败可感知**：签到失败、Cookie 失效、推送失败都会以**非零退出码**结束，GitHub Actions 会如实标记为失败并发送通知邮件。
* **智能重试**：网络抖动、5xx、429 自动指数退避重试；session 未就绪时整体重试整个流程。

---

## 🚀 快速上手

### 第一步：获取推送 Token

1. 访问 [PushPlus 官网](https://www.pushplus.plus/)，登录并获取 **Token**。
2. （可选）如需推送到群组，创建一个群组并记录 **群组编码 (Topic)**。

> PushPlus 免费版有每日发送条数限制，且 token 可能过期。本项目会校验 PushPlus 的返回码——**推送失败时 workflow 也会标红**，避免"以为收到了其实没发出去"。

### 第二步：配置 GitHub 仓库

进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加：

| 变量名 | 必填 | 说明 | 示例 |
| :--- | :---: | :--- | :--- |
| `CHECKIN_DOMAIN` | ✅ | 签到网站的域名 | `members.example.com` |
| `CHECKIN_USER` | ✅ | 登录账号 | `myname@email.com` |
| `CHECKIN_PASS` | ✅ | 登录密码 | `yourpassword123` |
| `PUSHPLUS_TOKEN` | ❌ | PushPlus 发送令牌，不配则跳过推送 | `a1b2c3d4e5f6...` |
| `PUSHPLUS_TOPIC` | ❌ | PushPlus 群组编码 | `1` |

**关于变量名**：本项目只使用带 `CHECKIN_` 前缀的变量名。旧版的 `DOMAIN` / `USER` / `PASS` 已废弃、不再兼容——这样做的原因是 `USER` 在 Linux 上是系统环境变量（值为 `runner`），一旦被误读就会拿系统账号去登录，报"登录失败"而不是"配置缺失"，极难排查。

**关于域名**：填 `members.example.com` 或 `https://members.example.com` 均可，不要带尾部斜杠（脚本会自动处理）。**默认只允许 https**；若站点确实只支持 http，需额外设置 `ALLOW_INSECURE_HTTP=true`，否则脚本会拒绝启动（避免明文传输密码）。

### 第三步：启用自动化

1. 点击仓库顶部的 **Actions** 选项卡。
2. 在左侧选择 **"Daily Checkin"**，点击 **Run workflow** 手动触发一次，确认配置正确。
3. 首次运行后检查日志：签到结果应出现在最后几行，微信应收到推送。

---

## ⚠️ 已知限制

请在配置前了解以下几点，它们不是 bug，而是本方案的固有限制：

### 1. 定时任务不会准点执行

GitHub 托管 runner 的 `schedule` 事件是**排队制**，高峰期会延迟。实测本项目历史 262 次定时运行：

| 指标 | 数值 |
| :--- | :--- |
| 延迟中位数 | 约 3.5 小时 |
| 最长延迟 | 超过 11 小时 |
| 实际启动时间（北京时间） | 中位数 12:02，最晚 19:57 |

因此本项目设置为 **北京时间 09:33**。请注意这只是"排队时间"而非"执行时间"——实际执行通常会晚于 09:33，可能落在中午甚至更晚。如果你对签到时间有严格要求（例如必须在某个时刻前完成），GitHub Actions 不是合适的选择，建议改用 Cloudflare Workers Cron 或自建定时器通过 API 触发 `workflow_dispatch`。

### 2. 站点启用 Cloudflare 盾时无法签到

多数机场站点有 Cloudflare 5 秒盾或 JS 挑战，纯 HTTP 请求（包括本脚本）无法通过。若日志中出现 `HTTP 403`、`HTTP 503` 或返回 HTML 而非 JSON，通常就是这个原因。这类情况需要浏览器环境，本脚本无法解决。

### 3. 仓库长期无活动会被自动禁用

GitHub 规定：公开仓库若 60 天无任何活动，其 scheduled workflow 会被自动禁用。建议**每 2 个月手动 Run 一次**，或提交一次改动，以保持任务存活。

### 4. 签到时间可能影响奖励

部分站点对签到时段有要求。本项目默认在北京时间上午执行，如站点规则特殊，请自行调整 `checkin.yml` 中的 cron（注意 cron 使用 **UTC**，北京时间需减 8 小时）。

---

## 🔍 排查问题

| 现象 | 可能原因 | 处理 |
| :--- | :--- | :--- |
| `配置缺失 (CHECKIN_DOMAIN)` | Secret 未配置或名字拼错 | 检查 Settings → Secrets |
| `登录失败: 邮箱或密码错误` | 账号密码错误 | 更新 `CHECKIN_PASS` |
| `登录失败` 但密码正确 | 站点要求验证码 / 开启了二次验证 | 本脚本不支持，需手动签到 |
| `签到被重定向 ... Session 已失效` | 登录成功但 session 未生效 | 脚本会自动重试；持续失败可能是站点风控 |
| `返回了非 JSON 内容 ... <html>` | 被 CF 盾拦截或站点维护 | 见"已知限制"第 2 条 |
| `域名必须使用 https://` | 域名填成了 http | 改为 https，或设 `ALLOW_INSECURE_HTTP=true` |
| `PushPlus 推送失败: code=903` | PushPlus token 无效 | 重新获取 token |
| `PushPlus 推送失败: code=900` 之类 | 触发免费版每日限额 | 次日恢复，或升级套餐 |
| Actions 显示红色失败 | 见上；红色是**预期行为**，表示确实出问题了 | 查看日志定位 |

---

## 🛠 本地调试

```bash
# 依赖 Node 18+（使用内置 fetch）
node --check checkin.js          # 语法检查

CHECKIN_DOMAIN=members.example.com \
CHECKIN_USER=you@example.com \
CHECKIN_PASS=yourpassword \
PUSHPLUS_TOKEN=your_token \
node checkin.js
```

脚本成功退出码为 `0`，任何失败为 `1`，可直接用于其他 CI 系统。

---

## 📄 许可证

本项目采用 [Apache License 2.0](LICENSE) 发布，与原项目一致。

原始项目版权归 [CMLiussss](https://github.com/cmliussss2024) 所有；本仓库为衍生作品，已按 Apache-2.0 第 4 条要求保留许可证文本并标注修改。

---

## 🙏 致谢

* **[CMLiussss](https://github.com/cmliussss2024)** — 原始项目作者，签到流程与 Cookie 处理逻辑来自其实现
* **[PushPlus](https://www.pushplus.plus/)** — 提供微信推送服务
