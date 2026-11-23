'use strict';
// 个人微信 ClawBot 扫码登录：在终端显示二维码，用手机微信扫码确认后，把机器人凭据保存到状态目录。
// 用法（在 VPS2 上，以 agentdesk 身份）：
//   sudo -u agentdesk /opt/agentdesk-orchestrator/node /opt/agentdesk-orchestrator/wechat/login.js
// 保存位置：/var/lib/agentdesk-orchestrator/wechat/ilink-account.json（0600），扫码人自动成为管理员（白名单）。
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { fetchQrCode, pollQrStatus, DEFAULT_BASE_URL } = require('./ilink');

const stateDir = process.env.AGENTDESK_STATE_DIR || '/var/lib/agentdesk-orchestrator';
const accountFile = path.join(stateDir, 'wechat', 'ilink-account.json');

function showQr(content) {
  try {
    require('qrcode-terminal').generate(content, { small: true });
  } catch {
    console.log('（没装 qrcode-terminal，把下面的链接转成二维码再扫）');
  }
  console.log(`二维码内容：${content}\n`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function main() {
  if (fs.existsSync(accountFile) && !process.argv.includes('--force')) {
    const old = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
    console.log(`已经登录过（${old.savedAt}）。要换号或重新登录请加 --force。`);
    return;
  }
  let baseUrl = DEFAULT_BASE_URL;
  let qr = await fetchQrCode({ baseUrl });
  let refreshes = 0;
  let verifyCode;
  console.log('用手机微信扫下面的二维码，并在手机上确认（8 分钟内有效）：\n');
  showQr(qr.qrcode_img_content);
  const deadline = Date.now() + 8 * 60_000;
  let scanned = false;
  while (Date.now() < deadline) {
    const status = await pollQrStatus({ qrcode: qr.qrcode, verifyCode, baseUrl });
    switch (status.status) {
      case 'wait': break;
      case 'scaned':
        verifyCode = undefined;
        if (!scanned) { console.log('已扫码，请在手机上确认…'); scanned = true; }
        break;
      case 'need_verifycode':
        verifyCode = await ask(verifyCode ? '数字不对，请重新输入手机上显示的数字：' : '输入手机微信上显示的数字：');
        continue;
      case 'scaned_but_redirect':
        if (status.redirect_host) baseUrl = `https://${status.redirect_host}`;
        break;
      case 'expired':
      case 'verify_code_blocked':
        refreshes += 1;
        if (refreshes > 3) { console.log('二维码多次失效，请稍后重新运行。'); process.exit(1); }
        console.log('二维码已过期，刷新中…\n');
        baseUrl = DEFAULT_BASE_URL;
        qr = await fetchQrCode({ baseUrl });
        scanned = false;
        showQr(qr.qrcode_img_content);
        break;
      case 'binded_redirect':
        console.log('这个微信已经绑定过一个 ClawBot。若要重新绑定，请先在手机微信里解除原来的绑定再运行。');
        process.exit(1);
        break;
      case 'confirmed': {
        if (!status.bot_token || !status.ilink_bot_id) { console.log('登录失败：服务器没有返回凭据。'); process.exit(1); }
        const account = {
          token: status.bot_token, botId: status.ilink_bot_id, userId: status.ilink_user_id || '',
          baseUrl: status.baseurl || baseUrl, savedAt: new Date().toISOString(),
        };
        fs.mkdirSync(path.dirname(accountFile), { recursive: true, mode: 0o700 });
        const temporary = `${accountFile}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(account, null, 1), { mode: 0o600 });
        fs.renameSync(temporary, accountFile);
        // 换号后旧的收信游标和会话令牌作废。
        fs.rmSync(path.join(path.dirname(accountFile), 'ilink-state.json'), { force: true });
        console.log(`\n✅ 登录成功。扫码的微信号已自动设为管理员（白名单）。`);
        console.log('现在重启服务：systemctl restart agentdesk-wechat');
        return;
      }
      default:
        break;
    }
  }
  console.log('超时未确认，请重新运行。');
  process.exit(1);
}

main().catch((error) => { console.error('登录出错：', error.message); process.exit(1); });
