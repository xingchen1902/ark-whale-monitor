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

// 全局状态（Vercel 冷启动会重置，所以用 latestBlock 做增量）
let transfers = [...initialTransfers];
let maxBlock = Math.max(...transfers.map(t => t.blockNumber));
let lastUpdateTime = 0;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  
  const now = Date.now();
  
  try {
    const provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
    const currentBlock = await provider.getBlockNumber();
    
    // 每次最多扫 200000 个区块（约5分钟，在超时限制内）
    const BATCH_SIZE = 200000;
    const fromBlock = Math.min(maxBlock + 1, currentBlock);
    let toBlock = Math.min(fromBlock + BATCH_SIZE - 1, currentBlock);
    
    let scannedCount = 0;
    let newRecords = 0;
    const seenHashes = new Set(transfers.map(t => t.txHash));
    
    while (fromBlock + scannedCount * BATCH_SIZE <= currentBlock) {
      const batchFrom = Math.min(fromBlock + scannedCount * BATCH_SIZE, currentBlock);
      const batchTo = Math.min(batchFrom + BATCH_SIZE - 1, currentBlock);
      
      if (batchFrom > batchTo) break;
      
      for (const whaleAddr of WHALE_ADDRESSES) {
        const whaleTopic = '0x000000000000000000000000' + whaleAddr.slice(2).toLowerCase();
        try {
          const logs = await provider.getLogs({
            address: ARK_CONTRACT,
            topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
            fromBlock: batchFrom,
            toBlock: batchTo,
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
            transfers.push({
              txHash: l.transactionHash,
              blockNumber: l.blockNumber,
              timestamp,
              from: POOL_ADDRESS,
              to: whaleAddr,
              value: ethers.utils.formatUnits(l.data, 18),
            });
            newRecords++;
          }
        } catch(e) {
          // 超时或错误就停止
          if (e.message.includes('timeout') || e.code === 'SERVER_ERROR') {
            toBlock = batchFrom;
            break;
          }
        }
      }
      
      scannedCount++;
      
      // 如果已经接近超时了就停止
      if (Date.now() - now > 45000) break;
    }
    
    // 更新 maxBlock
    if (toBlock > maxBlock) {
      maxBlock = toBlock;
    }
    
    if (newRecords > 0) {
      transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    
    lastUpdateTime = now;
    
    res.json({
      transfers,
      totalCount: transfers.length,
      maxBlock,
      currentBlock,
      remaining: currentBlock - maxBlock,
      newRecords,
      updatedAt: new Date(lastUpdateTime).toISOString(),
    });
    
  } catch(e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message, totalCount: transfers.length });
  }
};
