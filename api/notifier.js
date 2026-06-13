const https = require('https');
const { ethers } = require('ethers');

const BOT_TOKEN = '8526583093:AAEOv3YC804ILxqPfYH-h_miZ9M6jpYHUDE';
const CHAT_ID = '-1002577657965';
const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475';
const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';

let provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
let pushedTxs = new Set();
let transfersRef = [];
let onNewData = null;

function init(transfersRef_, onNewData_) {
  transfersRef = transfersRef_;
  onNewData = onNewData_;
  console.log('[Bot] 已就绪（仅发送模式）');
}

// 发送 Telegram 消息到指定 chat_id
function sendTelegramTo(chatId, text, parseMode = 'HTML') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 发送到默认群
function sendTelegram(text, parseMode = 'HTML') {
  return sendTelegramTo(CHAT_ID, text, parseMode);
}

function formatARK(value) {
  const num = parseFloat(value);
  if (num >= 10000) return num.toLocaleString(undefined, {maximumFractionDigits: 0});
  if (num >= 1000) return num.toLocaleString(undefined, {maximumFractionDigits: 2});
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

// 获取今天的 UTC 起始和结束 block
async function getTodayRange() {
  const currentBlockNum = await provider.getBlockNumber();
  const currentBlock = await provider.getBlock(currentBlockNum);
  const now = new Date(currentBlock.timestamp * 1000);
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  const todayStartSec = Math.floor(todayStart.getTime() / 1000);
  const todayEndSec = Math.floor(todayEnd.getTime() / 1000);
  return { todayStart, todayEnd, todayStartSec, todayEndSec, currentBlockNum, currentBlock };
}

// 获取指定日期范围的所有区块
async function getBlocksInTimeRange(fromTs, toTs) {
  const currentBlockNum = await provider.getBlockNumber();
  let low = 33500000, high = currentBlockNum;
  
  // 二分查找起始区块
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const block = await provider.getBlock(mid);
    if (block.timestamp < fromTs) low = mid + 1;
    else high = mid;
  }
  const startBlock = low;
  
  low = startBlock; high = currentBlockNum;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const block = await provider.getBlock(mid);
    if (block.timestamp > toTs) high = mid - 1;
    else low = mid;
  }
  const endBlock = low;
  
  return { startBlock, endBlock };
}

// 处理 Telegram 收到的消息（webhook）
async function handleMessage(chatId, msgText) {
  const text = msgText.trim();
  
  if (text === '/start') {
    await sendTelegramTo(chatId, '🤖 <b>ARK 奖金池转入查询 Bot</b>\n\n发送任意 BSC 地址，我会查询该地址<b>今天</b>从奖金池转入的 ARK 记录。\n\n示例：\n<code>0x8e5E761EAF35c8bc7a4F359A44EA2D255E25e052</code>\n\n奖金池地址：\n<code>0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4</code>');
    return;
  }
  
  // 提取地址
  const addrMatch = text.match(/0x[a-fA-F0-9]{40}/);
  if (!addrMatch) return;
  
  const address = ethers.utils.getAddress(addrMatch[0]);
  
  await sendTelegramTo(chatId, `🔍 正在扫描从奖金池转入 <code>${address.slice(0,10)}...${address.slice(-6)}</code> 今天的记录...`);
  
  try {
    const { todayStart, todayEnd, todayStartSec, todayEndSec } = await getTodayRange();
    const { startBlock, endBlock } = await getBlocksInTimeRange(todayStartSec, todayEndSec);
    
    console.log(`[Bot] 查询 ${address.slice(0,10)}: 区块 ${startBlock} ~ ${endBlock} (日期范围: ${todayStart.toISOString().slice(0,10)})`);
    
    const whaleTopic = '0x000000000000000000000000' + address.slice(2).toLowerCase();
    
    let allLogs = [];
    for (let from = startBlock; from <= endBlock; from += 50000) {
      const to = Math.min(from + 49999, endBlock);
      try {
        const logs = await provider.getLogs({
          address: ARK_CONTRACT,
          topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
          fromBlock: from,
          toBlock: to,
        });
        allLogs.push(...logs);
      } catch(e) {
        console.error(`[Bot] getLogs 失败 ${from}-${to}:`, e.message);
      }
    }
    
    if (allLogs.length === 0) {
      await sendTelegramTo(chatId, `❌ <code>${address.slice(0,10)}...${address.slice(-6)}</code>\n今天没有从奖金池转入的记录`);
      return;
    }
    
    // 获取区块时间戳
    const records = [];
    const seenTxs = new Set();
    for (const l of allLogs) {
      if (seenTxs.has(l.transactionHash)) continue;
      seenTxs.add(l.transactionHash);
      let timestamp;
      try {
        const block = await provider.getBlock(l.blockNumber);
        timestamp = new Date(block.timestamp * 1000).toISOString();
      } catch(e) {
        timestamp = new Date().toISOString();
      }
      records.push({
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        timestamp,
        to: ethers.utils.getAddress('0x' + l.topics[2].slice(26)),
        value: ethers.utils.formatUnits(l.data, 18),
      });
    }
    
    // 过滤今天
    const todayStr = todayStart.toISOString().slice(0, 10);
    const todayRecords = records.filter(r => r.timestamp.slice(0, 10) === todayStr);
    
    if (todayRecords.length === 0) {
      await sendTelegramTo(chatId, `❌ <code>${address.slice(0,10)}...${address.slice(-6)}</code>\n今天没有从奖金池转入的记录`);
      return;
    }
    
    todayRecords.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const total = todayRecords.reduce((s, r) => s + parseFloat(r.value), 0);
    
    const detailLines = todayRecords.map((r, i) => {
      const ts = r.timestamp.slice(11, 19);
      const amt = formatARK(r.value);
      const shortTx = r.txHash.slice(0,6) + '..' + r.txHash.slice(-4);
      return `${i+1}. ${ts}  ${amt} ARK  <a href="https://bscscan.com/tx/${r.txHash}">${shortTx}</a>`;
    }).join('\n');
    
    const msg = [
      `📋 <b>${todayStr} 奖金池转入明细</b>`,
      `<code>${address}</code>`,
      ``,
      detailLines,
      ``,
      `<b>📊 合计：${todayRecords.length} 笔 | ${formatARK(total)} ARK</b>`,
      `<a href="https://bscscan.com/address/${address}">🔗 BSCScan</a>`,
    ].join('\n');
    
    await sendTelegramTo(chatId, msg);
    
    // 如果来自默认群，也更新到内存
    if (onNewData && address.toLowerCase() !== POOL_ADDRESS.toLowerCase()) {
      onNewData(todayRecords);
    }
    
    console.log(`[Bot] 已推送 ${address.slice(0,10)} 的 ${todayRecords.length} 条记录`);
  } catch(e) {
    console.error('[Bot] 查询失败:', e.message);
    await sendTelegramTo(chatId, `❌ 查询失败: ${e.message}`);
  }
}

// RPC 查询全部记录（用于添加地址）
async function fetchFromRPC(address) {
  const whaleTopic = '0x000000000000000000000000' + address.slice(2);
  const currentBlock = await provider.getBlockNumber();
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
        try { const block = await provider.getBlock(l.blockNumber); timestamp = new Date(block.timestamp * 1000).toISOString(); }
        catch(e) { timestamp = new Date().toISOString(); }
        allRecords.push({
          txHash: l.transactionHash, blockNumber: l.blockNumber, timestamp,
          from: POOL_ADDRESS,
          to: ethers.utils.getAddress('0x' + l.topics[2].slice(26)),
          value: ethers.utils.formatUnits(l.data, 18),
        });
      }
    } catch(e) {}
  }
  
  allRecords.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return allRecords;
}

// 扫描地址并推送结果到群
async function scanAndPushAddress(address) {
  const existing = transfersRef.some(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder');
  if (existing) {
    const records = transfersRef.filter(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder');
    const total = records.reduce((s, t) => s + parseFloat(t.value || 0), 0);
    await sendTelegram(
      `⚠️ 地址已在监控中\n<code>${address}</code>\n已录入 ${records.length} 笔 | ${total.toFixed(2)} ARK`);
    return;
  }
  
  await sendTelegram(`🔍 正在扫描 ${address.slice(0,10)}... 的转入记录...`);
  
  const records = await fetchFromRPC(address);
  
  if (records.length === 0) {
    await sendTelegram(`❌ 未找到从奖金池转入 ${address.slice(0,10)}... 的记录`);
    return;
  }
  
  if (onNewData) onNewData(records);
  
  const total = records.reduce((s, r) => s + parseFloat(r.value), 0);
  
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
    `<a href="https://bscscan.com/address/${address}">🔗 BSCScan 地址详情</a>`,
  ].filter(Boolean).join('\n');
  
  await sendTelegram(msgText);
}

// 推送新转账到默认群
async function notifyNewTransfers(newRecords, allTransfers) {
  if (!newRecords || newRecords.length === 0) return;
  
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
      await sendTelegram(message);
      console.log(`[Bot] 已推送: ${record.txHash.slice(0, 16)}... ${formatARK(record.value)} ARK`);
    } catch(e) {
      console.error('[Bot] 推送失败:', e.message);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
}

async function sendTestMessage() {
  try {
    await sendTelegram('✅ ARK 监控已启动！推送模式');
    return true;
  } catch(e) {
    console.error('[Bot] 测试消息失败:', e.message);
    return false;
  }
}

module.exports = { 
  init, scanAndPushAddress, notifyNewTransfers, sendTestMessage, 
  handleMessage, sendTelegramTo, sendTelegram, 
  getTodayRange, getBlocksInTimeRange, provider 
};
