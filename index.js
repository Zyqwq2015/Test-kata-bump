process.setMaxListeners(20);
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');

chromium.use(stealth);

let SECRETS = {};
try { SECRETS = JSON.parse(process.env.ALL_SECRETS || '{}'); } catch (e) {}

const TG_TOKEN = SECRETS.TG_TOKEN || process.env.TG_TOKEN;
const TG_CHAT = SECRETS.TG_CHAT || process.env.TG_CHAT;

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const RENEW_MAX_ATTEMPTS = 3;
let singboxProcess = null;

function escapeHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function maskIp(ip) {
    if (!ip) return 'Unknown';
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.***.***`;
    const v6parts = ip.split(':');
    if (v6parts.length > 2) return `${v6parts[0]}:${v6parts[1]}:***::***`;
    return '***';
}

function maskUsernameForLog(username) {
    const value = String(username || '').trim();
    if (!value) return '(empty)';
    const atIndex = value.indexOf('@');
    if (atIndex <= 0) return '***';
    
    const name = value.slice(0, atIndex);
    const domain = value.slice(atIndex + 1);
    
    const maskedName = name.length <= 2 ? name[0] + '***' : name.slice(0, 2) + '***';
    
    const lastDotIndex = domain.lastIndexOf('.');
    const maskedDomain = lastDotIndex > 0 ? '***' + domain.slice(lastDotIndex) : '***';
    
    return `${maskedName}@${maskedDomain}`;
}

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try {
        if (imagePath && fs.existsSync(imagePath)) {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('chat_id', TG_CHAT);
            form.append('photo', fs.createReadStream(imagePath));
            form.append('caption', message);
            form.append('parse_mode', 'HTML');
            await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, form, { headers: form.getHeaders() });
        } else {
            await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { chat_id: TG_CHAT, text: message, parse_mode: 'HTML' });
        }
        console.log(`[Telegram] 消息推送成功`);
    } catch (e) {
        console.error(`[Telegram] 消息推送失败: ${e.message}`);
    }
}

let appState = {};
if (fs.existsSync('state.json')) {
    try { appState = JSON.parse(fs.readFileSync('state.json', 'utf8')); } catch (e) {}
}

function getUserHash(username) {
    return crypto.createHash('md5').update(String(username).trim().toLowerCase()).digest('hex');
}

function updateState(username, dateStr) {
    const hash = getUserHash(username);
    if (dateStr) appState[hash] = dateStr;
    else delete appState[hash];
    fs.writeFileSync('state.json', JSON.stringify(appState, null, 2));
}

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: getRandomInt(800, 1200) });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: getRandomInt(400, 600) });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            window.__turnstile_data = {
                                xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                                yRatio: (rect.top + rect.height / 2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

async function testProxyAndGetIP(proxyUrl) {
    try {
        const agent = new SocksProxyAgent(proxyUrl);
        const res = await axios.get('https://api.ipify.org?format=json', { httpAgent: agent, httpsAgent: agent, timeout: 8000 });
        return res.data.ip;
    } catch (e) { return null; }
}

async function setupProxyForAccount(proxyUrlStr) {
    console.log(`[代理] 正在清理旧代理进程...`);
    if (singboxProcess) {
        singboxProcess.kill('SIGKILL');
        singboxProcess = null;
        await new Promise(r => setTimeout(r, 1500));
    }

    if (proxyUrlStr) {
        console.log(`[代理] 检测到专线配置，正在编译路由规则...`);
        try {
            execSync('node proxyurl.js', { env: { ...process.env, PROXY_URL: proxyUrlStr }, stdio: 'ignore' });
            if (fs.existsSync('config.json')) {
                singboxProcess = spawn('./sing-box', ['run', '-c', 'config.json'], { detached: true, stdio: 'ignore' });
                singboxProcess.unref();
                await new Promise(r => setTimeout(r, 3000));
                console.log(`[代理] 正在测试专线连通性...`);
                const ip = await testProxyAndGetIP('socks5://127.0.0.1:8080');
                if (ip) return { url: 'socks5://127.0.0.1:8080', ip, type: 'Custom (Singbox)' };
            }
        } catch (e) {
            console.log(`[代理] 专线启动失败，准备降级。`);
        }
    }
    
    console.log(`[代理] 回退检测 WARP 节点状态...`);
    const warpIp = await testProxyAndGetIP('socks5://127.0.0.1:40000');
    if (warpIp) return { url: 'socks5://127.0.0.1:40000', ip: warpIp, type: 'WARP' };
    
    console.log(`[代理] WARP不可用，使用服务器本机网络直连。`);
    return { url: null, ip: null, type: 'Direct' };
}

function killChrome() {
    try { execSync('pkill -f google-chrome'); } catch(e) {}
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => { res.resume(); resolve(true); });
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
}

async function launchChrome(proxyUrl) {
    killChrome();
    await new Promise(r => setTimeout(r, 1000));
    console.log(`[系统] 正在挂载隔离环境并启动 Chrome...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];
    if (proxyUrl) {
        args.push(`--proxy-server=${proxyUrl}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) throw new Error('Chrome 启动超时');
}

async function dispatchCdpClick(page, x, y) {
    const client = await page.context().newCDPSession(page);
    try {
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return true;
    } catch (e) { return false; } finally { await client.detach().catch(() => {}); }
}

async function attemptTurnstileCdp(page) {
    for (const frame of page.frames()) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                await frame.evaluate(() => { window.__turnstile_data = null; }).catch(() => {});
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                return await dispatchCdpClick(page, box.x + (box.width * data.xRatio), box.y + (box.height * data.yRatio));
            }
        } catch (e) { }
    }
    return false;
}

async function checkTurnstileSuccess(page) {
    try {
        if (await page.locator('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').evaluateAll(els => els.some(el => el.value && el.value.trim().length > 0))) return true;
    } catch (e) { }
    for (const f of page.frames()) {
        if (f.url().includes('cloudflare')) {
            try { if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) return true; } catch (e) { }
        }
    }
    return false;
}

async function solveTurnstileIfPresent(page, accountLogPrefix, maxAttempts = 10, waitAfterClick = 5000) {
    console.log(`${accountLogPrefix} 开始检测 Turnstile 验证码...`);
    for (let i = 0; i < maxAttempts; i++) {
        if (await checkTurnstileSuccess(page)) {
            console.log(`${accountLogPrefix} ✅ Turnstile 验证已放行。`);
            return true;
        }
        if (await attemptTurnstileCdp(page)) {
            console.log(`${accountLogPrefix} 已发送交互点击，等待校验结果...`);
            await page.waitForTimeout(waitAfterClick);
            if (await checkTurnstileSuccess(page)) {
                console.log(`${accountLogPrefix} ✅ 校验通过。`);
                return true;
            }
        }
        if (i < maxAttempts - 1) await page.waitForTimeout(1000);
    }
    console.log(`${accountLogPrefix} ⚠️ 未通过 Turnstile 或未检测到验证组件。`);
    return false;
}

async function getAltchaStatus(page) {
    try {
        return await page.evaluate(() => {
            const n = v => v == null ? '' : String(v).trim();
            const w = document.querySelector('altcha-widget');
            const i = Array.from(document.querySelectorAll('input[name*="altcha" i], textarea[name*="altcha" i]')).find(e => n(e.value).length > 0);
            const s = w ? w.shadowRoot : null;
            const c = s ? s.querySelector('[type="checkbox"], [role="checkbox"]') : null;
            const state = n(w ? w.state : '') || n(w ? w.getAttribute('state') : '');
            const val = n(w ? w.value : '') || n(w ? w.getAttribute('value') : '');
            const hVal = n(i ? i.value : '');
            const chk = c && typeof c.checked === 'boolean' ? c.checked : null;
            const aChk = n(c ? c.getAttribute('aria-checked') : '');
            const busy = n(w ? w.getAttribute('aria-busy') : '');
            const solved = state === 'verified' || val.length > 0 || hVal.length > 0;
            return {
                exists: !!w || !!i,
                solved,
                isVerifying: !solved && (state === 'verifying' || state === 'processing' || state === 'working' || chk === true || aChk === 'true' || busy === 'true')
            };
        });
    } catch (e) { return { exists: false, solved: false, isVerifying: false }; }
}

async function attemptAltchaClick(page, currentStatus) {
    try {
        const altchaWidget = page.locator('altcha-widget').first();
        if (await altchaWidget.count() > 0) {
            const status = currentStatus || await getAltchaStatus(page);
            if (status.solved || status.isVerifying) return false;
            await page.waitForTimeout(500);
            await altchaWidget.scrollIntoViewIfNeeded().catch(() => {});
            let boxInfo = await page.evaluate(() => {
                const w = document.querySelector('altcha-widget');
                if (!w) return null;
                const p = r => r ? r.querySelector('input[type="checkbox"], [role="checkbox"], label, button') : null;
                const t = (w.shadowRoot && p(w.shadowRoot)) || p(w);
                if (t) { const r = t.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, e: true }; }
                const r = w.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, e: false };
            });
            if (boxInfo && boxInfo.w > 0 && boxInfo.h > 0) {
                const cx = boxInfo.e ? boxInfo.x + boxInfo.w / 2 : boxInfo.x + Math.min(25, Math.max(12, boxInfo.w * 0.15));
                const cy = boxInfo.y + boxInfo.h / 2;
                await dispatchCdpClick(page, cx, cy);
                await page.evaluate(() => {
                    const w = document.querySelector('altcha-widget');
                    if (w && w.shadowRoot) {
                        const cb = w.shadowRoot.querySelector('input[type="checkbox"]');
                        if (cb && !cb.checked) cb.click();
                    }
                });
                return true;
            }
        }
    } catch (e) {}
    return false;
}

async function solveAltchaIfPresent(page, accountLogPrefix, maxAttempts = 15, waitAfterClick = 8000) {
    console.log(`${accountLogPrefix} 正在检测弹窗内 ALTCHA 组件...`);
    let sawAltcha = false;
    const startedAt = Date.now();
    const budget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
    let attempts = 0;
    while (Date.now() - startedAt < budget) {
        const s = await getAltchaStatus(page);
        if (s.exists) sawAltcha = true;
        if (s.solved) {
            console.log(`${accountLogPrefix} ✅ ALTCHA 校验已完成。`);
            return true;
        }
        if (!s.exists || s.isVerifying) { await page.waitForTimeout(1000); continue; }
        if (attempts >= maxAttempts) { await page.waitForTimeout(1000); continue; }
        if (!await attemptAltchaClick(page, s)) { await page.waitForTimeout(1000); continue; }
        attempts++;
        console.log(`${accountLogPrefix} 已点击 ALTCHA，等待后台 PoW 算力计算...`);
        const cStart = Date.now();
        while (Date.now() - cStart < waitAfterClick) {
            await page.waitForTimeout(1000);
            const fs = await getAltchaStatus(page);
            if (fs.solved) {
                console.log(`${accountLogPrefix} ✅ PoW 计算完毕！`);
                return true;
            }
            if (fs.isVerifying) continue;
            if (Date.now() - cStart >= 2500) break;
        }
    }
    if (!sawAltcha) {
        console.log(`${accountLogPrefix} 未检测到 ALTCHA 拦截。`);
        return true;
    }
    console.log(`${accountLogPrefix} ❌ ALTCHA 校验最终失败或计算超时。`);
    return false;
}

(async () => {
    const users = [];
    for (const key in SECRETS) {
        const match = key.match(/^KATA_ACCOUNT_(\d+)$/);
        if (match) {
            const idx = match[1];
            const parts = SECRETS[key].trim().split(/\s+/);
            if (parts.length >= 2) {
                users.push({
                    index: parseInt(idx),
                    username: parts[0],
                    password: parts.slice(1).join(' '),
                    proxy: SECRETS[`PROXY_URL_${idx}`] || null
                });
            }
        }
    }
    users.sort((a, b) => a.index - b.index);

    if (users.length === 0) {
        console.error('[系统] 未在 ALL_SECRETS 中找到符合规则的账号信息！');
        process.exit(1);
    }
    console.log(`[系统] 成功解析到 ${users.length} 个账号准备执行。`);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const masked = maskUsernameForLog(user.username);
        const prefix = `[${masked}]`;
        
        const delayMins = Math.floor(Math.random() * (10 - 3 + 1)) + 3;
        console.log(`\n======================================================`);
        console.log(`${prefix} 任务开始，随机延时 ${delayMins} 分钟...`);
        await new Promise(r => setTimeout(r, delayMins * 60 * 1000));

        const activeProxy = await setupProxyForAccount(user.proxy);
        console.log(`${prefix} 分配代理: ${activeProxy.type} | 出口 IP: ${maskIp(activeProxy.ip)}`);

        await launchChrome(activeProxy.url);
        
        let browser;
        for (let k = 0; k < 5; k++) {
            try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); break; } 
            catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
        if (!browser) {
            console.error(`${prefix} 无法连接到浏览器内核，跳过该账户。`);
            continue;
        }

        const context = browser.contexts()[0];
        let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
        page.setDefaultTimeout(60000);
        await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }).catch(() => {});
        await page.addInitScript(INJECTED_SCRIPT);

        try {
            console.log(`${prefix} 清理环境并准备访问控制台...`);
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard') && !page.url().includes('login')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(2000);
            }
            await page.waitForTimeout(3000); 

            await solveTurnstileIfPresent(page, prefix, 10, 5000);

            console.log(`${prefix} 正在输入凭证进行登录...`);
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);
                await page.getByRole('button', { name: 'Login', exact: true }).click();
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`${prefix} ❌ 登录失败：账号或密码不正确。`);
                        const fpath = path.join(process.cwd(), 'screenshots', `${user.username.replace(/[^a-z0-9]/gi, '_')}_fail.png`);
                        if (!fs.existsSync(path.dirname(fpath))) fs.mkdirSync(path.dirname(fpath), { recursive: true });
                        try { await page.screenshot({ path: fpath, fullPage: true }); } catch (e) {}
                        await sendTelegramMessage(`❌ <b>${escapeHtml(user.username)}</b>\nLogin Failed: Incorrect credential.`, fpath);
                        await browser.close();
                        continue;
                    }
                } catch (e) { }
            } catch (e) { 
                console.log(`${prefix} 登录页异常(可能已自动登录)，继续流转。`);
            }

            console.log(`${prefix} 正在寻找机器控制面板...`);
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.error(`${prefix} ❌ 找不到控制面板入口，可能账号异常或无机器资源。`);
                await browser.close();
                continue; 
            }

            let renewSuccess = false;
            let failureReason = '';
            for (let attempt = 1; attempt <= RENEW_MAX_ATTEMPTS; attempt++) {
                if (page.url().includes('login')) break;
                
                console.log(`${prefix} [尝试 ${attempt}/${RENEW_MAX_ATTEMPTS}] 定位 Renew 按钮...`);
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { }
                
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log(`${prefix} 模态框已触发，准备处理续订。`);
                    const modal = page.locator('.modal-content, [role="dialog"]').filter({ hasText: 'Renew' }).first();
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { continue; }
                    try { const box = await modal.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }); } catch (e) { }
                    
                    const confirmBtn = modal.getByRole('button', { name: 'Renew', exact: true });
                    if (await confirmBtn.isVisible()) {
                        const photoDir = path.join(process.cwd(), 'screenshots');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const sname = user.username.replace(/[^a-z0-9]/gi, '_');
                        
                        if (!await solveAltchaIfPresent(page, prefix, 15, 8000)) {
                            failureReason = 'ALTCHA 挑战未通过';
                            console.log(`${prefix} 刷新页面重试...`);
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                        
                        console.log(`${prefix} 递交续订请求...`);
                        await confirmBtn.click();
                        
                        let hasCaptchaError = false;
                        try {
                            const startVerify = Date.now();
                            while (Date.now() - startVerify < 3000) {
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    hasCaptchaError = true;
                                    break;
                                }
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText().catch(() => '');
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = 'Unknown';
                                    if (match && match[1]) {
                                        dateStr = match[1];
                                        let pDate = new Date(dateStr + " UTC");
                                        if (!isNaN(pDate)) updateState(user.username, pDate.toISOString());
                                    }
                                    renewSuccess = true;
                                    console.log(`${prefix} ⏳ 续订时间未到，允许续订时间: ${dateStr}`);
                                    const spath = path.join(photoDir, `${sname}_skip.png`);
                                    try { await page.screenshot({ path: spath, fullPage: true }); } catch (e) {}
                                    await sendTelegramMessage(`⏳ <b>${escapeHtml(user.username)}</b>\nSkipped. Next Renew as of: ${dateStr}`, spath);
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break;
                        if (hasCaptchaError) {
                            failureReason = '官方要求验证 Captcha';
                            console.log(`${prefix} 遇到拦截错误，重试...`);
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                        
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log(`${prefix} ✅ 续期成功！`);
                            const spath = path.join(photoDir, `${sname}_success.png`);
                            try { await page.screenshot({ path: spath, fullPage: true }); } catch (e) {}
                            await sendTelegramMessage(`✅ <b>${escapeHtml(user.username)}</b>\nRenewed successfully!`, spath);
                            updateState(user.username, null);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log(`${prefix} ⚠️ 窗口未关闭，状态未知，将进行二次尝试...`);
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                } else { 
                    console.log(`${prefix} 当前无需续期或找不到可用资源。`);
                    break; 
                }
            } 
            if (!renewSuccess && failureReason) {
                console.log(`${prefix} ❌ 最终续期失败: ${failureReason}`);
                const failDir = path.join(process.cwd(), 'screenshots');
                if (!fs.existsSync(failDir)) fs.mkdirSync(failDir, { recursive: true });
                const fpath = path.join(failDir, `${user.username.replace(/[^a-z0-9]/gi, '_')}_fail.png`);
                try { await page.screenshot({ path: fpath, fullPage: true }); } catch (e) {}
                await sendTelegramMessage(`❌ <b>${escapeHtml(user.username)}</b>\nRenew Fail: ${failureReason}`, fpath);
            }
        } catch (err) {
            console.error(`${prefix} 发生代码级异常: ${err.message}`);
        }

        await browser.close();
        killChrome();
        if (singboxProcess) {
            singboxProcess.kill('SIGKILL');
            singboxProcess = null;
        }
    }
    
    console.log(`\n[系统] 全部执行完毕，安全退出。`);
    process.exit(0);
})();
