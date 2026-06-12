const { ethers } = require('ethers');
const initialTransfers = require('./initial_transfers.json');

const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475';
const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// 默认地址
const DEFAULT_WHALES = [
  '0xc2309bb33EFF8fB0A1a22435bB63844D320B130D',
  '0x8e5E761EAF35c8bc7a4F359A44EA2D255E25e052',
  '0xc6C6C5A8C629eAb947Eb610FB8B0936102ebA0AD',
  '0xd47b1565a31915e29B42a3948C1dCEc0f0e01d2A',
  '0x92F156Ce030CD3e0Ea999d7cB6adf62B480E63cc',
];

const initialMaxBlock = Math.max(...initialTransfers.map(t => t.blockNumber));
let transfers = [...initialTransfers];
let maxBlock = initialMaxBlock;

// 存储动态添加地址的扫描状态
let dynamicProgress = {};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  
  // URL 参数解析
  const action = req.query.action || 'list';
  const fromBlock = parseInt(req.query.from) || 0;
  if (fromBlock > maxBlock) maxBlock = fromBlock;

  // === 添加新地址 ===
  if (action === 'add') {
    const address = req.query.address?.toLowerCase().trim();
    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
      return res.json({ error: '无效地址' });
    }
    
    // 检查是否已有
    const existing = transfers.filter(t => t.to.toLowerCase() === address);
    if (existing.length > 0) {
      return res.json({ message: '地址已存在', count: existing.length });
    }
    
    // 初始化扫描任务
    dynamicProgress[address] = { status: 'scanning', scanned: 0, found: 0 };
    
    // 异步扫描（返回后继续在后台执行）
    scanAddress(address).then(result => {
      dynamicProgress[address] = result;
    }).catch(e => {
      dynamicProgress[address] = { status: 'error', message: e.message };
    });
    
    return res.json({
      message: '开始扫描',
      address,
      progress: dynamicProgress[address],
    });
  }
  
  // === 查看扫描进度 ===
  if (action === 'progress') {
    const address = req.query.address?.toLowerCase();
    if (address && dynamicProgress[address]) {
      return res.json({ address, progress: dynamicProgress[address] });
    }
    return res.json({ dynamicProgress });
  }
  
  // === 列表/刷新数据 ===
  const provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
  const currentBlock = await provider.getBlockNumber();
  
  if (maxBlock < currentBlock) {
    const startBlock = maxBlock + 1;
    const endBlock = Math.min(startBlock + 300000, currentBlock);
    const seenHashes = new Set(transfers.map(t => t.txHash));
    let newRecords = [];
    
    // 查所有已监控地址
    // 从已有数据中提取所有 unique 地址
    const allAddresses = [...new Set(transfers.map(t => t.to.toLowerCase()))];
    
    for (const addr of allAddresses) {
      const whaleTopic = '0x000000000000000000000000' + addr.slice(2);
      try {
        const logs = await provider.getLogs({
          address: ARK_CONTRACT,
          topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
          fromBlock: startBlock,
          toBlock: endBlock,
        });
        for (const l of logs) {
          if (seenHashes.has(l.transactionHash)) continue;
          seenHashes.add(l.transactionHash);
          let timestamp;
          try {
            const block = await provider.getBlock(l.blockNumber);
            timestamp = new Date(block.timestamp * 1000).toISOString();
          } catch(e) { timestamp = new Date().toISOString(); }
          newRecords.push({
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
            timestamp,
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
    }
    maxBlock = endBlock;
  }
  
  // 构建按地址统计
  const whaleStats = {};
  for (const t of transfers) {
    if (!whaleStats[t.to]) whaleStats[t.to] = { count: 0, total: 0 };
    whaleStats[t.to].count++;
    whaleStats[t.to].total += parseFloat(t.value);
  }
  
  res.json({
    transfers,
    totalCount: transfers.length,
    maxBlock,
    currentBlock,
    whaleStats,
    defaultAddresses: DEFAULT_WHALES,
    dynamicProgress,
  });
};

// 后台扫描新地址
async function scanAddress(address) {
  const provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
  const whaleTopic = '0x000000000000000000000000' + address.slice(2);
  const currentBlock = await provider.getBlockNumber();
  
  let allRecords = [];
  const seenTxs = new Set();
  const FROM_BLOCK = 33500000;
  
  for (let from = FROM_BLOCK; from <= currentBlock; from += 50000) {
    const to = Math.min(from + 49999, currentBlock);
    try {
      const logs = await provider.getLogs({
        address: ARK_CONTRACT,
        topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        if (seenTxs.has(l.transactionHash)) continue;
        seenTxs.add(l.transactionHash);
        let timestamp;
        try {
          const block = await provider.getBlock(l.blockNumber);
          timestamp = new Date(block.timestamp * 1000).toISOString();
        } catch(e) { timestamp = new Date().toISOString(); }
        allRecords.push({
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          timestamp,
          from: POOL_ADDRESS,
          to: ethers.utils.getAddress(address),
          value: ethers.utils.formatUnits(l.data, 18),
        });
      }
    } catch(e) {}
    
    // 每10%更新一次进度
    const pct = Math.round((from - FROM_BLOCK) / (currentBlock - FROM_BLOCK) * 100);
    if (pct % 10 === 0) {
      dynamicProgress[address] = { status: 'scanning', pct, scanned: allRecords.length };
    }
  }
  
  // 合并到全局数据
  if (allRecords.length > 0) {
    const existingHashes = new Set(transfers.map(t => t.txHash));
    for (const r of allRecords) {
      if (!existingHashes.has(r.txHash)) {
        transfers.push(r);
      }
    }
    transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  
  const total = allRecords.reduce((s, t) => s + parseFloat(t.value), 0);
  
  return {
    status: 'completed',
    found: allRecords.length,
    totalARK: total,
  };
}
