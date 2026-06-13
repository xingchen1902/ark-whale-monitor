const express = require('express');
const path = require('path');
const { ethers } = require('ethers');
const { init: initBot, scanAndPushAddress, notifyNewTransfers, sendTestMessage, handleMessage, sendTelegramTo } = require('./api/notifier');
const initialTransfers = require('./api/initial_transfers.json');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // 解析 JSON body（Telegram webhook 需要）

const BOT_TOKEN = '8526583093:AAEOv3YC804ILxqPfYH-h_miZ9M6jpYHUDE';
const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475';
const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

let transfers = [...initialTransfers];
let maxBlock = Math.max(...transfers.filter(t => t.txHash !== 'placeholder').map(t => t.blockNumber), 0);

function getAllAddresses() {
  return [...new Set(transfers.map(t => t.to.toLowerCase()).filter(a => a !== POOL_ADDRESS.toLowerCase()))];
}

function onNewBotData(records) {
  if (records.length === 0) return;
  const addr = records[0].to.toLowerCase();
  // 移除旧 placeholder，合并新数据
  transfers = transfers.filter(t => !(t.to.toLowerCase() === addr && t.txHash === 'placeholder'));
  const existingHashes = new Set(transfers.map(t => t.txHash));
  const newOnes = records.filter(r => !existingHashes.has(r.txHash));
  transfers.push(...newOnes);
  transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  console.log(`[Bot] 合并新数据: ${newOnes.length} 条, 总数: ${transfers.length}`);
}

initBot(transfers, onNewBotData);

// ===== Telegram Webhook =====
// 接收 Telegram 的消息更新
app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200); // 立即返回 200 避免 Telegram 重试
  
  const update = req.body;
  if (!update) return;
  
  const message = update.message || update.channel_post;
  if (!message || !message.text) return;
  
  const chatId = message.chat.id;
  const text = message.text;
  
  console.log(`[Bot Webhook] 收到消息: ${text.slice(0, 50)}`);
  
  // 异步处理，不阻塞响应
  handleMessage(chatId, text).catch(e => {
    console.error('[Bot Webhook] 处理失败:', e.message);
  });
});

// ===== 设置 Webhook（启动时） =====
async function setWebhook() {
  const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  const webhookUrl = `${railwayUrl}/webhook/telegram`;
  
  const https = require('https');
  const data = JSON.stringify({ url: webhookUrl, drop_pending_updates: true });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/setWebhook`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const result = JSON.parse(body);
        console.log('[Bot Webhook] 设置结果:', result.description || JSON.stringify(result));
        resolve(result);
      });
    });
    req.on('error', (e) => {
      console.error('[Bot Webhook] 设置失败:', e.message);
      reject(e);
    });
    req.write(data);
    req.end();
  });
}

// ===== 现有 API =====
app.get('/api/add-address', async (req, res) => {
  const address = req.query.address?.trim().toLowerCase();
  if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
    return res.json({ error: '无效地址' });
  }
  scanAndPushAddress(address).catch(e => console.error('[Bot] 扫描失败:', e.message));
  res.json({ message: '已开始扫描, 结果将通过 Telegram 推送' });
});

app.get('/api/transfers', async (req, res) => {
  const whaleStats = {};
  for (const t of transfers) {
    if (t.txHash === 'placeholder') continue;
    if (!whaleStats[t.to]) whaleStats[t.to] = { count: 0, total: 0 };
    whaleStats[t.to].count++;
    whaleStats[t.to].total += parseFloat(t.value);
  }
  res.json({ transfers, totalCount: transfers.filter(t => t.txHash !== 'placeholder').length, whaleStats });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 定时检查新转账
async function checkNewTransfers() {
  try {
    const provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
    const currentBlock = await provider.getBlockNumber();
    if (maxBlock >= currentBlock) return;
    
    const startBlock = maxBlock + 1;
    const endBlock = Math.min(startBlock + 50000, currentBlock);
    const seenHashes = new Set(transfers.map(t => t.txHash));
    let newRecords = [];
    
    for (const addr of getAllAddresses()) {
      const whaleTopic = '0x000000000000000000000000' + addr.slice(2);
      try {
        const logs = await provider.getLogs({
          address: ARK_CONTRACT,
          topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
          fromBlock: startBlock, toBlock: endBlock,
        });
        for (const l of logs) {
          if (seenHashes.has(l.transactionHash)) continue;
          seenHashes.add(l.transactionHash);
          let timestamp;
          try { const block = await provider.getBlock(l.blockNumber); timestamp = new Date(block.timestamp * 1000).toISOString(); }
          catch(e) { timestamp = new Date().toISOString(); }
          newRecords.push({
            txHash: l.transactionHash, blockNumber: l.blockNumber, timestamp,
            from: POOL_ADDRESS,
            to: ethers.utils.getAddress('0x' + l.topics[2].slice(26)),
            value: ethers.utils.formatUnits(l.data, 18),
          });
        }
      } catch(e) {}
    }
    
    if (newRecords.length > 0) {
      transfers = [...newRecords, ...transfers];
      transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      console.log(`[Bot] 发现 ${newRecords.length} 条新转账`);
      await notifyNewTransfers(newRecords, transfers);
    }
    
    maxBlock = endBlock;
    console.log(`[Bot] 已检查到区块 ${endBlock}, 监控 ${getAllAddresses().length} 个地址`);
  } catch(e) {
    console.error('[Bot] 检查失败:', e.message);
  }
}

setTimeout(() => checkNewTransfers(), 3000);
setInterval(() => checkNewTransfers(), 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ARK 监控服务: http://localhost:${PORT}`);
  console.log(`数据: ${transfers.filter(t => t.txHash !== 'placeholder').length} 条`);
  console.log(`监控: ${getAllAddresses().length} 个地址`);
  
  // 启动后设置 webhook
  setTimeout(() => setWebhook(), 2000);
});
