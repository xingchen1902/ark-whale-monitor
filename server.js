/**
 * ARK 狗大户奖金池转入监控 - 后端服务
 * 每小时自动检查新转账, 通过 WebSocket 推送更新
 */
const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ====== 链上配置 ======
const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/7b7adb4899124647867575e354005c07';
const RPC_FALLBACK = 'https://bsc-dataseed.binance.org/';

const ARK_CONTRACT = ethers.utils.getAddress('0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D');
const POOL_ADDRESS = ethers.utils.getAddress('0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4');
const WHALE_ADDRESSES = [
  ethers.utils.getAddress('0xc2309bb33EFF8fB0A1a22435bB63844D320B130D'),
  ethers.utils.getAddress('0x8e5E761EAF35c8bc7a4F359A44EA2D255E25e052'),
  ethers.utils.getAddress('0xc6C6C5A8C629eAb947Eb610FB8B0936102ebA0AD'),
  ethers.utils.getAddress('0xd47b1565a31915e29B42a3948C1dCEc0f0e01d2A'),
  ethers.utils.getAddress('0x92F156Ce030CD3e0Ea999d7cB6adf62B480E63cc'),
];
const WHALE_SET = new Set(WHALE_ADDRESSES.map(a => a.toLowerCase()));

const DATA_FILE = path.join(__dirname, 'data', 'transfers.json');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';

// ====== State ======
let transfers = [];
let lastCheckedBlock = 0;
let updateClients = [];

// ====== Provider ======
function getProvider() {
  try {
    return new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 60000 });
  } catch(e) {
    return new ethers.providers.JsonRpcProvider({ url: RPC_FALLBACK, timeout: 60000 });
  }
}

// ====== 加载历史数据 ======
function loadTransfers() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      transfers = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      console.log(`加载历史数据: ${transfers.length} 条记录`);
    }
  } catch(e) {
    console.error('加载历史数据失败:', e.message);
    transfers = [];
  }
  
  // 记录最后检查的区块
  if (transfers.length > 0) {
    lastCheckedBlock = Math.max(...transfers.map(t => t.blockNumber));
  }
}

// ====== 检查新区块 ======
async function checkNewTransfers() {
  const provider = getProvider();
  try {
    const currentBlock = await provider.getBlockNumber();
    
    // 如果 lastCheckedBlock 为 0, 从当前区块-100 开始
    const fromBlock = lastCheckedBlock > 0 ? lastCheckedBlock + 1 : currentBlock - 100;
    
    if (fromBlock > currentBlock) {
      return { newRecords: 0 };
    }
    
    // 限制一次最多查 50000 区块
    const toBlock = Math.min(fromBlock + 50000, currentBlock);
    
    console.log(`检查新转账: 区块 ${fromBlock} → ${toBlock} (当前: ${currentBlock})`);
    
    // 对每个狗大户查询
    let newRecords = [];
    const seenHashes = new Set(transfers.map(t => t.txHash));
    
    for (const whaleAddr of WHALE_ADDRESSES) {
      const whaleTopic = '0x000000000000000000000000' + whaleAddr.slice(2).toLowerCase();
      
      try {
        const logs = await provider.getLogs({
          address: ARK_CONTRACT,
          topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
          fromBlock,
          toBlock,
        });
        
        for (const l of logs) {
          if (seenHashes.has(l.transactionHash)) continue;
          seenHashes.add(l.transactionHash);
          
          let timestamp;
          try {
            const block = await provider.getBlock(l.blockNumber);
            timestamp = new Date(block.timestamp * 1000).toISOString();
          } catch(e) {
            timestamp = new Date().toISOString();
          }
          
          const record = {
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
            timestamp,
            from: POOL_ADDRESS,
            to: whaleAddr,
            value: ethers.utils.formatUnits(l.data, 18),
          };
          
          newRecords.push(record);
        }
      } catch(e) {
        console.error(`  查询 ${whaleAddr} 失败: ${e.message}`);
      }
    }
    
    if (newRecords.length > 0) {
      transfers = transfers.concat(newRecords);
      transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      fs.writeFileSync(DATA_FILE, JSON.stringify(transfers, null, 2));
      
      console.log(`  发现 ${newRecords.length} 条新转账!`);
      
      // 广播给 WebSocket 客户端
      broadcast({
        type: 'new_transfers',
        records: newRecords,
        totalCount: transfers.length,
      });
    }
    
    lastCheckedBlock = toBlock;
    return { newRecords: newRecords.length };
    
  } catch(e) {
    console.error('检查新转账失败:', e.message);
    return { newRecords: 0 };
  }
}

// ====== WebSocket 广播 ======
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of updateClients) {
    try { ws.send(msg); } catch(e) { /* ignore */ }
  }
}

// ====== API ======
app.get('/api/transfers', (req, res) => {
  res.json({ transfers, totalCount: transfers.length, lastCheckedBlock });
});

app.get('/api/stats', (req, res) => {
  const stats = {};
  for (const addr of WHALE_ADDRESSES) {
    const addrLower = addr.toLowerCase();
    const records = transfers.filter(t => t.to.toLowerCase() === addrLower);
    const total = records.reduce((s, t) => s + parseFloat(t.value), 0);
    stats[addr] = { count: records.length, total };
  }
  res.json({ stats, totalCount: transfers.length, lastCheckedBlock });
});

// ====== HTTP Server ======
const server = http.createServer(app);

// ====== WebSocket Server ======
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  updateClients.push(ws);
  
  // 发送当前全量数据
  ws.send(JSON.stringify({
    type: 'full_data',
    transfers,
    lastCheckedBlock,
  }));
  
  ws.on('close', () => {
    updateClients = updateClients.filter(c => c !== ws);
  });
});

// ====== 定时更新 ======
loadTransfers();

// 每小时检查一次
setInterval(async () => {
  console.log(`[${new Date().toISOString()}] 定时检查...`);
  await checkNewTransfers();
}, 60 * 60 * 1000);  // 1 小时

// 启动后立即检查一次
setTimeout(async () => {
  await checkNewTransfers();
}, 5000);

// ====== 启动 ======
server.listen(PORT, () => {
  console.log(`ARK 狗大户监控服务运行中: http://localhost:${PORT}`);
  console.log(`监控地址数: ${WHALE_ADDRESSES.length}`);
  console.log(`已有记录: ${transfers.length} 条`);
  console.log(`最后区块: ${lastCheckedBlock}`);
});
