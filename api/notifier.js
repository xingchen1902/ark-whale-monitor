/**
 * Telegram Bot - 推送 + 添加地址
 * 在群里发地址 0x... 自动添加监控
 */
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');

const BOT_TOKEN = '8526583093:AAEOv3YC804ILxqPfYH-h_miZ9M6jpYHUDE';
const CHAT_ID = '-1002577657965';
const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';

let pushedTxs = new Set();
let bot = null;
let transfersRef = [];   // 引用全局数据
let onNewData = null;    // 回调：添加新数据

function init(transfersRef_, onNewData_) {
  transfersRef = transfersRef_;
  onNewData = onNewData_;
  
  if (bot) return;
  
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  
  // 监听群消息
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text?.trim() || '';
    
    // 只处理目标群的消息
    if (chatId !== CHAT_ID) return;
    
    // 检查是否是地址
    const addrMatch = text.match(/0x[a-fA-F0-9]{40}/);
    if (!addrMatch) return;
    
    const address = addrMatch[0].toLowerCase();
    
    // 检查是否已存在
    const existing = transfersRef.some(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder');
    if (existing) {
      const count = transfersRef.filter(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder').length;
      await bot.sendMessage(chatId, `⚠️ 地址已在监控中\n<code>${address}</code>\n已有 ${count} 条记录`, { parse_mode: 'HTML' });
      return;
    }
    
    await bot.sendMessage(chatId, `🔍 正在爬取 ${address.slice(0,10)}... 的转入记录...`);
    
    // 爬取 BSCScan
    const records = await fetchFromBscScan(address);
    
    if (records.length === 0) {
      await bot.sendMessage(chatId, `❌ 未找到从奖金池转入 ${address.slice(0,10)}... 的记录`, { parse_mode: 'HTML' });
      return;
    }
    
    // 添加到全局数据
    if (onNewData) onNewData(records);
    
    // 计算统计
    const total = records.reduce((s, r) => s + parseFloat(r.value), 0);
    const latest = records[0].timestamp.slice(0, 16).replace('T', ' ');
    
    const msgText = [
      `✅ <b>添加成功！</b>`,
      `<code>${address}</code>`,
      ``,
      `📊 统计：`,
      `笔数: ${records.length}`,
      `总共: ${total.toFixed(2)} ARK`,
      `最新: ${latest}`,
      ``,
      `🔗 <a href="https://bscscan.com/address/${address}">查看地址</a>`,
    ].join('\n');
    
    await bot.sendMessage(chatId, msgText, { parse_mode: 'HTML', disable_web_page_preview: true });
  });
  
  console.log('[Bot] Telegram Bot 已启动, 等待群消息...');
}

// 格式化
function formatARK(value) {
  const num = parseFloat(value);
  if (num >= 1000) return num.toLocaleString(undefined, {maximumFractionDigits: 2});
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

// 推送新转账
async function notifyNewTransfers(newRecords, allTransfers) {
  if (!newRecords || newRecords.length === 0) return;
  
  if (!bot) bot = new TelegramBot(BOT_TOKEN);
  
  if (pushedTxs.size === 0) {
    for (const t of allTransfers) pushedTxs.add(t.txHash);
  }
  
  const toPush = newRecords.filter(t => !pushedTxs.has(t.txHash));
  if (toPush.length === 0) return;
  
  for (const record of toPush) {
    pushedTxs.add(record.txHash);
    
    const shortAddr = record.to.slice(0, 10) + '...' + record.to.slice(-6);
    const shortTx = record.txHash.slice(0, 10) + '...' + record.txHash.slice(-6);
    const ts = record.timestamp.slice(0, 16).replace('T', ' ');
    const amount = formatARK(record.value);
    
    const message = [
      `🐋 <b>狗大户收到 ARK！</b>`,
      ``,
      `地址: <code>${shortAddr}</code>`,
      `数量: <b>${amount} ARK</b>`,
      `时间: ${ts}`,
      `交易: <a href="https://bscscan.com/tx/${record.txHash}">${shortTx}</a>`,
      `<a href="https://bscscan.com/address/${record.to}">查看地址详情</a>`,
    ].join('\n');
    
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', disable_web_page_preview: true });
      console.log(`[Bot] 已推送: ${record.txHash.slice(0, 16)}... ${amount} ARK`);
    } catch(e) {
      console.error('[Bot] 推送失败:', e.message);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
}

// 爬取 BSCScan
async function fetchFromBscScan(address) {
  function fetchPage(page) {
    return new Promise((resolve, reject) => {
      const url = `https://bscscan.com/tokentxns?a=${address}&contract=${ARK_CONTRACT}&p=${page}`;
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }
  
  const results = [];
  const seenTxs = new Set();
  const POOL = POOL_ADDRESS.toLowerCase();
  const TARGET = address.toLowerCase();
  
  try {
    const html = await fetchPage(1);
    const lastMatch = html.match(/<a[^>]*href="[^"]*p=(\d+)"[^>]*>\s*Last\s*</i);
    const maxPage = lastMatch ? Math.min(parseInt(lastMatch[1]), 200) : 1;
    
    const rows = html.match(/<tr[^>]*>.*?<\/tr>/gs) || [];
    for (const row of rows) {
      const txMatch = row.match(/href="\/tx\/(0x[a-fA-F0-9]{64})"/);
      if (!txMatch) continue;
      const fromAddrs = row.match(/data-highlight-target="(0x[a-fA-F0-9]{40})"/g) || [];
      const addrs = fromAddrs.map(a => a.match(/0x[a-fA-F0-9]{40}/)[0].toLowerCase());
      if ((addrs[0] || '') === POOL && (addrs[1] || '') === TARGET) {
        const tsMatch = row.match(/(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2})/);
        const amtMatch = row.match(/class="td_showAmount"[^>]*>\s*([^<]+)/);
        const blockMatch = row.match(/href="\/block\/(\d+)"/);
        let amount = '';
        if (amtMatch) { const m = amtMatch[1].match(/([\d,]+\.?\d*)/); if (m) amount = m[1].replace(',', ''); }
        const record = { txHash: txMatch[1], blockNumber: blockMatch ? parseInt(blockMatch[1]) : 0, timestamp: (tsMatch ? tsMatch[1] : '').replace(' ', 'T') + ':00', from: POOL_ADDRESS, to: address, value: amount };
        if (!seenTxs.has(record.txHash)) { seenTxs.add(record.txHash); results.push(record); }
      }
    }
    
    for (let p = 2; p <= Math.min(maxPage, 10); p++) {
      await new Promise(r => setTimeout(r, 1500));
      const html = await fetchPage(p);
      const rows = html.match(/<tr[^>]*>.*?<\/tr>/gs) || [];
      for (const row of rows) {
        const txMatch = row.match(/href="\/tx\/(0x[a-fA-F0-9]{64})"/);
        if (!txMatch) continue;
        const fromAddrs = row.match(/data-highlight-target="(0x[a-fA-F0-9]{40})"/g) || [];
        const addrs = fromAddrs.map(a => a.match(/0x[a-fA-F0-9]{40}/)[0].toLowerCase());
        if ((addrs[0] || '') === POOL && (addrs[1] || '') === TARGET) {
          const tsMatch = row.match(/(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2})/);
          const amtMatch = row.match(/class="td_showAmount"[^>]*>\s*([^<]+)/);
          const blockMatch = row.match(/href="\/block\/(\d+)"/);
          let amount = '';
          if (amtMatch) { const m = amtMatch[1].match(/([\d,]+\.?\d*)/); if (m) amount = m[1].replace(',', ''); }
          const record = { txHash: txMatch[1], blockNumber: blockMatch ? parseInt(blockMatch[1]) : 0, timestamp: (tsMatch ? tsMatch[1] : '').replace(' ', 'T') + ':00', from: POOL_ADDRESS, to: address, value: amount };
          if (!seenTxs.has(record.txHash)) { seenTxs.add(record.txHash); results.push(record); }
        }
      }
    }
  } catch(e) {
    console.error('BSCScan fetch error:', e.message);
  }
  
  return results;
}

// 发送测试消息
async function sendTestMessage() {
  if (!bot) bot = new TelegramBot(BOT_TOKEN);
  try {
    await bot.sendMessage(CHAT_ID, '✅ ARK 监控 Bot 已启动！在群里发地址 0x... 即可添加监控', { parse_mode: 'HTML' });
    return true;
  } catch(e) {
    console.error('[Bot] 测试消息失败:', e.message);
    return false;
  }
}

module.exports = { init, notifyNewTransfers, sendTestMessage };
