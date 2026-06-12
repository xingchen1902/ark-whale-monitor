const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475';
const ARK = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const WHALES = [
  '0xc2309bb33EFF8fB0A1a22435bB63844D320B130D',
  '0x8e5E761EAF35c8bc7a4F359A44EA2D255E25e052',
  '0xc6C6C5A8C629eAb947Eb610FB8B0936102ebA0AD',
  '0xd47b1565a31915e29B42a3948C1dCEc0f0e01d2A',
  '0x92F156Ce030CD3e0Ea999d7cB6adf62B480E63cc',
].map(a => a.toLowerCase());

const DATA_FILE = path.join(__dirname, '..', 'api', 'initial_transfers.json');
const provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 30000 });

async function main() {
  const currentBlock = await provider.getBlockNumber();
  console.log('当前区块:', currentBlock);

  let allTransfers = [];
  const seenTxs = new Set();
  const FROM_BLOCK = 59200000;  // 从最早有记录的地方开始

  for (let from = FROM_BLOCK; from <= currentBlock; from += 50000) {
    const to = Math.min(from + 49999, currentBlock);
    
    for (const whale of WHALES) {
      const whaleTopic = '0x000000000000000000000000' + whale.slice(2);
      try {
        const logs = await provider.getLogs({
          address: ARK,
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
          } catch(e) {
            timestamp = new Date().toISOString();
          }
          
          allTransfers.push({
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
            timestamp,
            from: POOL,
            to: ethers.utils.getAddress('0x' + l.topics[2].slice(26)),
            value: ethers.utils.formatUnits(l.data, 18),
          });
        }
      } catch(e) {
        // skip
      }
    }
    
    if (from % 300000 === 0) {
      console.log(`扫描到 ${to}, 已找到 ${allTransfers.length} 条`);
    }
  }

  console.log('\n总记录:', allTransfers.length);
  allTransfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const stats = {};
  for (const t of allTransfers) {
    if (!stats[t.to]) stats[t.to] = { count: 0, total: ethers.BigNumber.from(0) };
    stats[t.to].count++;
    stats[t.to].total = stats[t.to].total.add(ethers.utils.parseUnits(t.value, 18));
  }
  for (const [addr, s] of Object.entries(stats)) {
    console.log(`${addr.slice(0,10)}...: ${s.count} 笔, ${ethers.utils.formatUnits(s.total, 2)} ARK`);
  }
  console.log('\n最新:', allTransfers[0]?.timestamp);
  console.log('最早:', allTransfers[allTransfers.length - 1]?.timestamp);

  fs.writeFileSync(DATA_FILE, JSON.stringify(allTransfers, null, 2));
  console.log('\n已更新:', DATA_FILE);
}

main().catch(e => console.error('Error:', e));
