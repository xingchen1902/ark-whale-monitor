/**
 * Telegram Bot - 推送 + 添加地址
 * 使用 RPC eth_getLogs 替代 BSCScan 爬虫
 */
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');

const BOT_TOKEN = '8526583093:AAEOv3YC804ILxqPfYH-h_miZ9M6jpYHUDE';
const CHAT_ID = '-1002577657965';
const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475';
const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';

let pushedTxs = new Set();
let bot = null;
let transfersRef = [];
let onNewData = null;

function init(transfersRef_, onNewData_) {
  transfersRef = transfersRef_;
  onNewData = onNewData_;
  if (bot) return;
  
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text?.trim() || '';
    if (chatId !== CHAT_ID) return;
    
    const addrMatch = text.match(/0x[a-fA-F0-9]{40}/);
    if (!addrMatch) return;
    
    const address = ethers.utils.getAddress(addrMatch[0]).toLowerCase();
    
    const existing = transfersRef.some(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder');
    if (existing) {
      const records = transfersRef.filter(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder');
      const total = records.reduce((s, t) => s + parseFloat(t.value || 0), 0);
      await bot.sendMessage(chatId, 
        `⚠️ 地址已在监控中\n<code>${address}</code>\n已录入 ${records.length} 笔 | ${total.toFixed(2)} ARK`,
        { parse_mode: 'HTML' });
      return;
    }
    
    await bot.sendMessage(chatId, `🔍 正在扫描链上 ${address.slice(0,10)}... 的转入记录...`);
    
    // 用 RPC 查询
    const records = await fetchFromRPC(address);
    
    if (records.length === 0) {
      await bot.sendMessage(chatId, `❌ 未找到从奖金池转入 ${address.slice(0,10)}... 的记录`, { parse_mode: 'HTML' });
      return;
    }
    
    if (onNewData) onNewData(records);
    
    const total = records.reduce((s, r) => s + parseFloat(r.value), 0);
    const latest = records[0].timestamp.slice(0, 16).replace('T', ' ');
    const earliest = records[records.length - 1].timestamp.slice(0, 16).replace('T', ' ');
    
    const recent5 = records.slice(0, 5).map(r => {
      const ts = r.timestamp.slice(0, 16).replace('T', ' ');
      const amt = formatARK(r.value);
      const shortTx = r.txHash.slice(0, 8) + '..' + r.txHash.slice(-6);
      return `▫ ${ts}  ${amt} ARK  <a href="https://bscscan.com/tx/${r.txHash}">${shortTx}</a>`;
    }).join('\n');
    
    const msgText = [
      `✅ <b>添加成功！</b>`,
      `<code>${address}</code>`,
      ``,
      `<b>📋 最近转入记录：</b>`,
      recent5,
      records.length > 5 ? `      ... 共 ${records.length} 笔` : '',
      ``,
      `<b>📊 统计汇总</b>`,
      `转入笔数: ${records.length}`,
      `累计数量: ${total.toFixed(4)} ARK`,
      `最早转入: ${earliest}`,
      `最近转入: ${latest}`,
      ``,
      `<a href="https://bscscan.com/address/${address}">🔗 BSCScan 地址详情</a>`,
    ].filter(Boolean).join('\n');
    
    await bot.sendMessage(chatId, msgText, { parse_mode: 'HTML', disable_web_page_preview: true });
  });
  
  console.log('[Bot] Telegram Bot 已启动');
}

function formatARK(value) {
  const num = parseFloat(value);
  if (num >= 10000) return num.toLocaleString(undefined, {maximumFractionDigits: 0});
  if (num >= 1000) return num.toLocaleString(undefined, {maximumFractionDigits: 2});
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

// RPC 查询 — 只查最近 200 万区块（约 2 周），更早的数据用历史数据
async function fetchFromRPC(address) {
  const provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
  const whaleTopic = '0x000000000000000000000000' + address.slice(2);
  const currentBlock = await provider.getBlockNumber();
  
  // 从合约部署开始查
  const FROM_BLOCK = 33500000;
  let allRecords = [];
  const seenTxs = new Set();
  
  for (let from = FROM_BLOCK; from <= currentBlock; from += 50000) {
    const to = Math.min(from + 49999, currentBlock);
    try {
      const logs = await provider.getLogs({
        address: ARK_CONTRACT,
        topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
        fromBlock: from, toBlock: to,
      });
      for (const l of logs) {
        if (seenTxs.has(l.transactionHash)) continue;
        seenTxs.add(l.transactionHash);
        let timestamp;
        try {
          const block = await provider.getBlock(l.blockNumber);
          timestamp = new Date(block.timestamp * 1000).toISOString();
        } catch(e) {
          timestamp = new Date().toISOString();
        }
        allRecords.push({
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          timestamp,
          from: POOL_ADDRESS,
          to: ethers.utils.getAddress('0x' + l.topics[2].slice(26)),
          value: ethers.utils.formatUnits(l.data, 18),
        });
      }
    } catch(e) {
      console.error(`RPC error [${from}-${to}]:`, e.message);
    }
  }
  
  allRecords.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return allRecords;
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
    
    const addrRecords = allTransfers.filter(t => t.to.toLowerCase() === record.to.toLowerCase());
    const total = addrRecords.reduce((s, t) => s + parseFloat(t.value), 0);
    
    const message = [
      `🐋 <b>奖金池 → 狗大户</b>`,
      `━━━━━━━━━━━━━━━`,
      ``,
      `<b>交易详情</b>`,
      `时间: ${record.timestamp.slice(0, 16).replace('T', ' ')}`,
      `数量: <b>${formatARK(record.value)} ARK</b>`,
      `地址: <code>${record.to.slice(0,10)}..${record.to.slice(-6)}</code>`,
      `交易: <a href="https://bscscan.com/tx/${record.txHash}">${record.txHash.slice(0,10)}..${record.txHash.slice(-6)}</a>`,
      ``,
      `<b>📊 该地址累计</b>`,
      `转入: ${addrRecords.length} 笔`,
      `总计: ${formatARK(total)} ARK`,
      `<a href="https://bscscan.com/address/${record.to}">查看地址</a>`,
    ].join('\n');
    
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML', disable_web_page_preview: true });
      console.log(`[Bot] 已推送: ${record.txHash.slice(0, 16)}... ${formatARK(record.value)} ARK`);
    } catch(e) {
      console.error('[Bot] 推送失败:', e.message);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
}

async function sendTestMessage() {
  if (!bot) bot = new TelegramBot(BOT_TOKEN);
  try {
    await bot.sendMessage(CHAT_ID, '✅ ARK 监控已启动！在群里发送地址 0x... 即可添加监控', { parse_mode: 'HTML' });
    return true;
  } catch(e) {
    console.error('[Bot] 测试消息失败:', e.message);
    return false;
  }
}

module.exports = { init, notifyNewTransfers, sendTestMessage };
