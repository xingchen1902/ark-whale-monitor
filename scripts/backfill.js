/**
 * 历史数据补全 - 通过 BSC RPC eth_getLogs 查询
 * 只查询奖金池 → 5个狗大户地址的 Transfer 事件
 * 使用 getLogs 直接过滤 from=pool, to=whale
 */
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

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

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'transfers.json');
const LOG_FILE = path.join(__dirname, '..', 'data', 'backfill.log');

const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const POOL_TOPIC = '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  try { fs.writeFileSync(LOG_FILE, ''); } catch(e) {}

  log('=== ARK 历史数据补全 ===');
  log(`兔子: ${ARK_CONTRACT}`);
  log(`奖金池: ${POOL_ADDRESS}`);

  let provider = new ethers.providers.JsonRpcProvider({ url: RPC_URL, timeout: 120000 });
  
  try {
    const bn = await provider.getBlockNumber();
    log(`当前区块: ${bn}`);
  } catch (e) {
    log(`主RPC失败: ${e.message}, 切换备选`);
    provider = new ethers.providers.JsonRpcProvider({ url: RPC_FALLBACK, timeout: 120000 });
  }

  const currentBlock = await provider.getBlockNumber();
  
  // 从 3500万区块开始（ARK合约大约在3350万部署，预留余量）
  const FROM_BLOCK = 33500000;
  const TO_BLOCK = currentBlock;
  const CHUNK_SIZE = 50000;  // NodeReal 限制 50k
    
  log(`扫描范围: ${FROM_BLOCK} → ${TO_BLOCK}`);

  // 已保存的
  let allTransfers = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    try { allTransfers = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8')); log(`已有: ${allTransfers.length} 条`); } catch(e) {}
  }
  const seenTxs = new Set(allTransfers.map(t => t.txHash));

  // 对每个狗大户地址单独查询，减少数据量
  for (const whaleAddr of WHALE_ADDRESSES) {
    const whaleTopic = '0x000000000000000000000000' + whaleAddr.slice(2).toLowerCase();
    
    log(`\n查询: ${whaleAddr}`);
    let addrCount = 0;
    
    for (let from = FROM_BLOCK; from <= TO_BLOCK; from += CHUNK_SIZE) {
      const to = Math.min(from + CHUNK_SIZE - 1, TO_BLOCK);
      
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
          
          const value = ethers.utils.formatUnits(l.data, 18);
          
          // Get block timestamp
          let timestamp;
          try {
            const block = await provider.getBlock(l.blockNumber);
            timestamp = new Date(block.timestamp * 1000).toISOString();
          } catch(e) {
            // 如果获取区块失败，用当前时间标记
            timestamp = new Date().toISOString();
          }
          
          allTransfers.push({
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
            timestamp,
            from: POOL_ADDRESS,
            to: whaleAddr,
            value,
          });
          addrCount++;
        }
      } catch(e) {
        if (!e.message.includes('exceed maximum block range')) {
          log(`  [${from}-${to}] 错误: ${e.message}`);
        }
      }
      
      if (addrCount > 0) {
        
      }
    }
    
    log(`\n  ${whaleAddr}: 共 ${addrCount} 条新记录`);
    
    // 每查完一个地址保存一次
    allTransfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allTransfers, null, 2));
  }
  
  log(`\n=== 完成 ===`);
  log(`总计: ${allTransfers.length} 条`);
  
  const stats = {};
  for (const t of allTransfers) {
    const addr = t.to;
    if (!stats[addr]) stats[addr] = { count: 0, total: ethers.BigNumber.from(0) };
    stats[addr].count++;
    stats[addr].total = stats[addr].total.add(ethers.utils.parseUnits(t.value, 18));
  }
  for (const [addr, s] of Object.entries(stats)) {
    log(`  ${addr}: ${s.count} 笔, ${ethers.utils.formatUnits(s.total, 18)} ARK`);
  }
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
