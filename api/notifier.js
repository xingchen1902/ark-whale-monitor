const https = require('https');
const { ethers } = require('ethers');

const BOT_TOKEN = '8526583093:AAEOv3YC804ILxqPfYH-h_miZ9M6jpYHUDE';
const CHAT_ID = '-1002577657965';
const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475';
const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';
const FROM_BLOCK = 33500000; // 大约 2025-08-27

let provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
let pushedTxs = new Set();
let transfersRef = [];
let onNewData = null;

function init(transfersRef_, onNewData_) {
  transfersRef = transfersRef_;
  onNewData = onNewData_;
  console.log('[Bot] 已就绪');
}

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

// 扫描地址从 FROM_BLOCK 到现在的全部记录
async function fetchFromRPC(address) {
  const whaleTopic = '0x000000000000000000000000' + address.slice(2).toLowerCase();
  const currentBlock = await provider.getBlockNumber();
  const records = [];
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
        records.push({
          txHash: l.transactionHash, blockNumber: l.blockNumber, timestamp,
          from: POOL_ADDRESS,
          to: ethers.utils.getAddress('0x' + l.topics[2].slice(26)),
          value: ethers.utils.formatUnits(l.data, 18),
        });
      }
    } catch(e) {
      console.error(`[Bot] getLogs 分段失败 ${from}-${to}:`, e.message);
    }
  }

  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return records;
}

// 处理 Telegram 消息 → 自动全量扫描 + 推送到群 + 加入监控
async function handleMessage(chatId, msgText) {
  const text = msgText.trim();

  if (text === '/start') {
    await sendTelegramTo(chatId, '🤖 <b>ARK 奖金池转入监控 Bot</b>\n\n发送任意 BSC 地址，我会：\n1️⃣ 扫描该地址从 2025-08-27 至今从奖金池转入的所有记录\n2️⃣ 推送到本群的完整统计数据\n3️⃣ 加入自动监控，后续有转入自动推送\n\n示例：<code>0x8e5E761EAF35c8bc7a4F359A44EA2D255E25e052</code>\n\n奖金池地址：<code>0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4</code>');
    return;
  }

  const addrMatch = text.match(/0x[a-fA-F0-9]{40}/);
  if (!addrMatch) return;

  const address = ethers.utils.getAddress(addrMatch[0]);
  const shortAddr = address.slice(0, 10) + '..' + address.slice(-6);

  // 检查是否已在监控
  const existing = transfersRef.some(t => t.to.toLowerCase() === address.toLowerCase() && t.txHash !== 'placeholder');
  if (existing) {
    const addrRecords = transfersRef.filter(t => t.to.toLowerCase() === address.toLowerCase() && t.txHash !== 'placeholder');
    const total = addrRecords.reduce((s, t) => s + parseFloat(t.value), 0);
    const latest = addrRecords[0];

    const msg = [
      `⚠️ <code>${shortAddr}</code> 已在监控中`,
      `已收录 ${addrRecords.length} 笔 | ${formatARK(total)} ARK`,
      ``,
      `<b>最近一笔转入</b>`,
      `${latest.timestamp.slice(0,16).replace('T',' ')}`,
      `${formatARK(latest.value)} ARK`,
      `<a href="https://bscscan.com/tx/${latest.txHash}">查看交易</a>`,
      `<a href="https://bscscan.com/address/${address}">🔗 BSCScan 地址详情</a>`,
    ].join('\n');
    await sendTelegramTo(chatId, msg);
    return;
  }

  await sendTelegramTo(chatId, `🔍 正在全量扫描 <code>${shortAddr}</code>\n从 2025-08-27 至今的奖金池转入记录...`);

  try {
    const records = await fetchFromRPC(address);

    if (records.length === 0) {
      await sendTelegramTo(chatId, `❌ <code>${shortAddr}</code>\n从 2025-08-27 至今没有从奖金池转入的记录`);
      return;
    }

    // 合并到全局数据
    if (onNewData) onNewData(records);

    const total = records.reduce((s, r) => s + parseFloat(r.value), 0);
    const earliest = records[records.length - 1].timestamp.slice(0, 10);
    const latest = records[0].timestamp.slice(0, 10);

    // 统计每月
    const monthly = {};
    for (const r of records) {
      const m = r.timestamp.slice(0, 7);
      if (!monthly[m]) monthly[m] = { count: 0, total: 0 };
      monthly[m].count++;
      monthly[m].total += parseFloat(r.value);
    }

    const monthlyLines = Object.entries(monthly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, v]) => `  ${m}: ${v.count} 笔 | ${formatARK(v.total)} ARK`)
      .join('\n');

    // 最近 5 条
    const recent5 = records.slice(0, 5).map(r => {
      const ts = r.timestamp.slice(0, 16).replace('T', ' ');
      const amt = formatARK(r.value);
      const shortTx = r.txHash.slice(0, 6) + '..' + r.txHash.slice(-4);
      return `▫ ${ts}  ${amt} ARK  <a href="https://bscscan.com/tx/${r.txHash}">${shortTx}</a>`;
    }).join('\n');

    const msg = [
      `✅ <b>监控添加成功！</b>`,
      `<code>${address}</code>`,
      ``,
      `<b>📊 统计汇总</b>`,
      `转入笔数: ${records.length}`,
      `累计数量: ${formatARK(total)} ARK`,
      `首次转入: ${earliest}`,
      `最近转入: ${latest}`,
      ``,
      `<b>📅 月度分布</b>`,
      monthlyLines,
      ``,
      `<b>📋 最近转入</b>`,
      recent5,
      ``,
      `🔔 后续有转入将自动推送`,
      `<a href="https://bscscan.com/address/${address}">🔗 BSCScan</a>`,
    ].join('\n');

    await sendTelegramTo(chatId, msg);
    console.log(`[Bot] 已添加监控: ${shortAddr}, ${records.length} 条, ${formatARK(total)} ARK`);
  } catch(e) {
    console.error('[Bot] 全量扫描失败:', e.message);
    await sendTelegramTo(chatId, `❌ 扫描失败: ${e.message}`);
  }
}

// 扫描地址并推送结果到默认群（HTTP API 调用）
async function scanAndPushAddress(address) {
  const existing = transfersRef.some(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder');
  if (existing) {
    const addrRecords = transfersRef.filter(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder');
    const total = addrRecords.reduce((s, t) => s + parseFloat(t.value || 0), 0);
    await sendTelegram(
      `⚠️ 地址已在监控中\n<code>${address}</code>\n已录入 ${addrRecords.length} 笔 | ${total.toFixed(2)} ARK`);
    return;
  }

  await sendTelegram(`🔍 正在全量扫描 ${address.slice(0,10)}... 的奖金池转入记录...`);

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

  const toPushRecords = newRecords.filter(t => !pushedTxs.has(t.txHash));
  if (toPushRecords.length === 0) return;

  for (const record of toPushRecords) {
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
    await sendTelegram('✅ ARK 监控已启动！');
    return true;
  } catch(e) {
    console.error('[Bot] 测试消息失败:', e.message);
    return false;
  }
}

module.exports = {
  init, scanAndPushAddress, notifyNewTransfers, sendTestMessage,
  handleMessage, sendTelegramTo, sendTelegram,
  provider, fetchFromRPC
};
