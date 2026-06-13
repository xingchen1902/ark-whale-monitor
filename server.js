/**
 * ARK 狗大户监控 - 主服务
 * - 提供 Web 看板 (public/index.html)
 * - API 接口 (/api/transfers)
 * - Telegram Bot 实时推送 (每分钟检查)
 */
const express = require('express');
const path = require('path');
const { ethers } = require('ethers');
const { notifyNewTransfers } = require('./api/notifier');
const initialTransfers = require('./api/initial_transfers.json');

const app = express();
const PORT = process.env.PORT || 3000;

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// ====== 数据 ======
const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475';
const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

let transfers = [...initialTransfers];
let maxBlock = Math.max(...transfers.filter(t => t.txHash !== 'placeholder').map(t => t.blockNumber), 0);
let lastNotifyTime = 0;

function getAllAddresses() {
  return [...new Set(transfers.map(t => t.to.toLowerCase()).filter(a => a !== POOL_ADDRESS.toLowerCase()))];
}

// ====== API ======
app.get('/api/transfers', async (req, res) => {
  const action = req.query.action || 'list';
  const address = req.query.address?.toLowerCase().trim();

  // 查询地址的转入
  if (action === 'add') {
    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) return res.json({ error: '无效地址' });
    const existing = getAllAddresses();
    if (existing.includes(address)) return res.json({ message: '地址已存在' });
    transfers.push({ txHash: 'placeholder', blockNumber: 0, timestamp: new Date().toISOString(), from: POOL_ADDRESS, to: address, value: '0' });
    return res.json({ message: '地址已添加, 开始爬取', address });
  }

  if (action === 'fetch') {
    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) return res.json({ error: '无效地址' });
    fetchFromBscScan(address).then(records => {
      if (records.length > 0) {
        transfers = transfers.filter(t => !(t.txHash === 'placeholder' && t.to.toLowerCase() === address));
        transfers.push(...records);
        transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      }
    });
    return res.json({ message: '开始爬取', address });
  }

  const whaleStats = {};
  for (const t of transfers) {
    if (t.txHash === 'placeholder') continue;
    if (!whaleStats[t.to]) whaleStats[t.to] = { count: 0, total: 0 };
    whaleStats[t.to].count++;
    whaleStats[t.to].total += parseFloat(t.value);
  }

  res.json({
    transfers,
    totalCount: transfers.filter(t => t.txHash !== 'placeholder').length,
    whaleStats,
  });
});

// 所有其他路由
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ====== Bot 定时检查 ======
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
      console.log(`[Bot] 发现 ${newRecords.length} 条新转账, 推送中...`);
      await notifyNewTransfers(newRecords, transfers);
    }
    
    maxBlock = endBlock;
    console.log(`[Bot] 已检查到区块 ${endBlock}, 监控 ${getAllAddresses().length} 个地址`);
    
  } catch(e) {
    console.error('[Bot] 检查失败:', e.message);
  }
}

// 启动后立即检查一次，然后每60秒检查
setTimeout(() => checkNewTransfers(), 3000);
setInterval(() => checkNewTransfers(), 60 * 1000);

// ====== 启动 ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ARK 监控服务运行中: http://localhost:${PORT}`);
  console.log(`数据: ${transfers.filter(t => t.txHash !== 'placeholder').length} 条`);
  console.log(`监控: ${getAllAddresses().length} 个地址`);
  console.log(`Bot 实时推送已启动 (每60秒检查)`);
});
