/**
 * 快速增量更新：只查 99937516 ~ 当前区块的新记录，追加到初始数据
 */
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

// 并行查5个地址
async function getLogsForBlocks(fromBlock, toBlock) {
  const results = await Promise.allSettled(WHALES.map(whale => {
    const whaleTopic = '0x000000000000000000000000' + whale.slice(2);
    return provider.getLogs({
      address: ARK,
      topics: [TRANSFER_TOPIC, POOL_TOPIC, whaleTopic],
      fromBlock, toBlock,
    });
  }));
  
  let all = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      for (const l of results[i].value) {
        all.push({ log: l, whale: WHALES[i] });
      }
    }
  }
  return all;
}

async function main() {
  const currentBlock = await provider.getBlockNumber();
  console.log('当前区块:', currentBlock);

  // 读取已有数据
  let allTransfers = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const oldCount = allTransfers.length;
  const seenTxs = new Set(allTransfers.map(t => t.txHash));
  
  const FROM_BLOCK = 99937516;  // 初始数据最新区块+1
  
  console.log(`已有: ${oldCount} 条, 扫描 ${FROM_BLOCK} → ${currentBlock}`);

  for (let from = FROM_BLOCK; from <= currentBlock; from += 50000) {
    const to = Math.min(from + 49999, currentBlock);
    
    const logs = await getLogsForBlocks(from, to);
    
    for (const { log, whale } of logs) {
      if (seenTxs.has(log.transactionHash)) continue;
      seenTxs.add(log.transactionHash);
      
      let timestamp;
      try {
        const block = await provider.getBlock(log.blockNumber);
        timestamp = new Date(block.timestamp * 1000).toISOString();
      } catch(e) {
        timestamp = new Date().toISOString();
      }
      
      allTransfers.push({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        timestamp,
        from: POOL,
        to: ethers.utils.getAddress('0x' + log.topics[2].slice(26)),
        value: ethers.utils.formatUnits(log.data, 18),
      });
    }
    
    console.log(`${from}→${to}: 本次 ${logs.length} 条, 累计 ${allTransfers.length} 条`);
  }

  console.log('\n完成!');
  console.log(`原数据: ${oldCount} 条`);
  console.log(`新数据: ${allTransfers.length} 条`);
  console.log(`新增: ${allTransfers.length - oldCount} 条`);
  
  allTransfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  console.log('最新:', allTransfers[0]?.timestamp);
  console.log('最早:', allTransfers[allTransfers.length - 1]?.timestamp);

  fs.writeFileSync(DATA_FILE, JSON.stringify(allTransfers, null, 2));
}

main().catch(e => console.error('Error:', e));
