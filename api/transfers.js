const { ethers } = require('ethers');
const initialTransfers = require('./initial_transfers.json');

const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475';
const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WHALE_ADDRESSES = [
  '0xc2309bb33EFF8fB0A1a22435bB63844D320B130D',
  '0x8e5E761EAF35c8bc7a4F359A44EA2D255E25e052',
  '0xc6C6C5A8C629eAb947Eb610FB8B0936102ebA0AD',
  '0xd47b1565a31915e29B42a3948C1dCEc0f0e01d2A',
  '0x92F156Ce030CD3e0Ea999d7cB6adf62B480E63cc',
];

// 初始数据
const initialMaxBlock = Math.max(...initialTransfers.map(t => t.blockNumber));
let transfers = [...initialTransfers];
let maxBlock = initialMaxBlock;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  
  // 支持从 URL 参数传入已扫到的区块，避免冷启动重复扫描
  const fromBlockParam = parseInt(req.query.from) || 0;
  if (fromBlockParam > maxBlock) {
    maxBlock = fromBlockParam;
  }
  
  try {
    const provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
    const currentBlock = await provider.getBlockNumber();
    
    if (maxBlock >= currentBlock) {
      return res.json({
        transfers,
        totalCount: transfers.length,
        maxBlock,
        currentBlock,
        remaining: 0,
        newRecords: 0,
        synced: true,
      });
    }
    
    // 每次扫 300000 个区块
    const BATCH_SIZE = 300000;
    const startBlock = maxBlock + 1;
    const endBlock = Math.min(startBlock + BATCH_SIZE - 1, currentBlock);
    
    const seenHashes = new Set(transfers.map(t => t.txHash));
    let newRecords = [];
    
    for (const whaleAddr of WHALE_ADDRESSES) {
      const whaleTopic = '0x000000000000000000000000' + whaleAddr.slice(2).toLowerCase();
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
          } catch(e) {
            timestamp = new Date().toISOString();
          }
          newRecords.push({
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
            timestamp,
            from: POOL_ADDRESS,
            to: whaleAddr,
            value: ethers.utils.formatUnits(l.data, 18),
          });
        }
      } catch(e) {
        if (e.message.includes('out of requests')) {
          // RPC 限流，返回已找到的数据
          break;
        }
      }
    }
    
    if (newRecords.length > 0) {
      transfers = [...newRecords, ...transfers];
      transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    
    maxBlock = endBlock;
    
    const remaining = currentBlock - maxBlock;
    const pct = Math.round((maxBlock - 33500000) / (currentBlock - 33500000) * 100);
    
    res.json({
      transfers,
      totalCount: transfers.length,
      maxBlock,
      currentBlock,
      remaining,
      pct: Math.min(100, pct),
      newRecords: newRecords.length,
      synced: remaining <= 0,
    });
    
  } catch(e) {
    res.json({
      transfers,
      totalCount: transfers.length,
      maxBlock,
      error: e.message,
    });
  }
};
