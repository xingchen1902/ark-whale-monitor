/**
 * Telegram Bot 推送模块
 * 只在 Vercel 冷启动或 API 调用时触发检查
 * 记录上次推送的 txHash，避免重复
 */
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = '8526583093:AAEOv3YC804ILxqPfYH-h_miZ9M6jpYHUDE';
const CHAT_ID = '-1002577657965';

// 记录已推送的 txHash（内存中，Vercel冷启动会重置）
let pushedTxs = new Set();

function formatARK(value) {
  const num = parseFloat(value);
  if (num >= 1000) return num.toLocaleString(undefined, {maximumFractionDigits: 2});
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

/**
 * 检查并推送新转账
 * @param {Array} newRecords - 新增的转账记录
 * @param {Array} allTransfers - 当前全量数据（用于首次启动时忽略旧的）
 */
async function notifyNewTransfers(newRecords, allTransfers) {
  if (!newRecords || newRecords.length === 0) return;
  
  const bot = new TelegramBot(BOT_TOKEN);
  
  // 如果是首次启动（pushedTxs为空），先初始化已推送集合
  if (pushedTxs.size === 0) {
    for (const t of allTransfers) {
      pushedTxs.add(t.txHash);
    }
    // 但新纪录还是要推
  }
  
  // 过滤出未推送的
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
      await bot.sendMessage(CHAT_ID, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      console.log(`[Bot] 已推送: ${record.txHash.slice(0, 16)}... ${amount} ARK`);
    } catch(e) {
      console.error('[Bot] 推送失败:', e.message);
    }
    
    // 推送间隔，避免被限流
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * 发送测试消息
 */
async function sendTestMessage() {
  const bot = new TelegramBot(BOT_TOKEN);
  try {
    await bot.sendMessage(CHAT_ID, '✅ ARK 监控 Bot 已启动！', { parse_mode: 'HTML' });
    console.log('[Bot] 测试消息已发送');
    return true;
  } catch(e) {
    console.error('[Bot] 测试消息失败:', e.message);
    return false;
  }
}

module.exports = { notifyNewTransfers, sendTestMessage };
