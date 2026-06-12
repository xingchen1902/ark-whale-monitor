const initialTransfers = require('./initial_transfers.json');
const { ethers } = require('ethers');

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

let transfers = [...initialTransfers];
let maxBlock = transfers.length > 0 ? Math.max(...transfers.map(t => t.blockNumber)) : 33500000;
let lastUpdateTime = 0;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  
  const now = Date.now();
  if (now - lastUpdateTime > 5 * 60 * 1000) {
    try {
      const provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.min(maxBlock + 1, currentBlock);
      const toBlock = Math.min(fromBlock + 50000, currentBlock);
      
      if (fromBlock <= toBlock) {
        const seenHashes = new Set(transfers.map(t => t.txHash));
        for (const whaleAddr of WHALE_ADDRESSES) {
          const whaleTopic = '0x000000000000000000000000' + whaleAddr.slice(2).toLowerCase();
          try {
            const logs = await provider.getLogs({
              address: ARK_CONTRACT,
              topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
              fromBlock, toBlock,
            });
            for (const l of logs) {
              if (seenHashes.has(l.transactionHash)) continue;
              seenHashes.add(l.transactionHash);
              const block = await provider.getBlock(l.blockNumber);
              transfers.push({
                txHash: l.transactionHash,
                blockNumber: l.blockNumber,
                timestamp: new Date(block.timestamp * 1000).toISOString(),
                from: POOL_ADDRESS,
                to: whaleAddr,
                value: ethers.utils.formatUnits(l.data, 18),
              });
            }
          } catch(e) {}
        }
        maxBlock = fromBlock + 50000;
        transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      }
      lastUpdateTime = now;
    } catch(e) {
      console.error('Update error:', e.message);
    }
  }
  
  const stats = {};
  for (const addr of WHALE_ADDRESSES) {
    const records = transfers.filter(t => t.to.toLowerCase() === addr.toLowerCase());
    const total = records.reduce((s, t) => s + parseFloat(t.value), 0);
    stats[addr] = { count: records.length, total };
  }
  
  res.json({
    stats,
    totalCount: transfers.length,
    maxBlock,
    updatedAt: new Date(lastUpdateTime).toISOString(),
  });
};
