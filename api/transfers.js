const initialTransfers = require('./initial_transfers.json');
const { notifyNewTransfers, sendTestMessage } = require('./notifier');

const ARK_CONTRACT = '0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D';
const POOL_ADDRESS = '0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4';

const DEFAULT_WHALES = [
  '0xc2309bb33EFF8fB0A1a22435bB63844D320B130D',
  '0x8e5E761EAF35c8bc7a4F359A44EA2D255E25e052',
  '0xc6C6C5A8C629eAb947Eb610FB8B0936102ebA0AD',
  '0xd47b1565a31915e29B42a3948C1dCEc0f0e01d2A',
  '0x92F156Ce030CD3e0Ea999d7cB6adf62B480E63cc',
].map(a => a.toLowerCase());

let transfers = [...initialTransfers];
let lastNotifyTime = 0;

function getAllAddresses() {
  return [...new Set(transfers.map(t => t.to.toLowerCase()))];
}

function ensureDefaultAddresses() {
  const existing = getAllAddresses();
  for (const addr of DEFAULT_WHALES) {
    if (!existing.includes(addr)) {
      transfers.push({
        txHash: 'placeholder',
        blockNumber: 0,
        timestamp: '1970-01-01T00:00:00.000Z',
        from: POOL_ADDRESS,
        to: addr,
        value: '0',
      });
    }
  }
}
ensureDefaultAddresses();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  
  const action = req.query.action || 'list';
  const address = req.query.address?.toLowerCase().trim();

  // === 添加新地址 ===
  if (action === 'add') {
    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
      return res.json({ error: '无效地址' });
    }
    const existing = getAllAddresses();
    if (existing.includes(address)) {
      return res.json({ message: '地址已存在', count: transfers.filter(t => t.to.toLowerCase() === address && t.txHash !== 'placeholder').length });
    }
    transfers.push({
      txHash: 'placeholder',
      blockNumber: 0,
      timestamp: new Date().toISOString(),
      from: POOL_ADDRESS,
      to: address,
      value: '0',
    });
    return res.json({ message: '地址已添加, 开始爬取数据', address });
  }
  
  // === 爬取新地址数据 ===
  if (action === 'fetch') {
    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
      return res.json({ error: '无效地址' });
    }
    fetchFromBscScan(address).then(records => {
      if (records.length > 0) {
        transfers = transfers.filter(t => !(t.txHash === 'placeholder' && t.to.toLowerCase() === address));
        transfers.push(...records);
        transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      }
    }).catch(e => console.error('fetch error:', e.message));
    return res.json({ message: '开始爬取', address });
  }
  
  // === 列表 + 自动检查新转账并推送 ===
  const now = Date.now();
  
  // 每5分钟检查并推送一次
  if (now - lastNotifyTime > 5 * 60 * 1000) {
    lastNotifyTime = now;
    
    // 通过 RPC 检查最新区块是否有新转账
    try {
      const { ethers } = require('ethers');
      const provider = new ethers.providers.JsonRpcProvider({
        url: 'https://bsc-mainnet.nodereal.io/v1/fdc3ae39b7b845669e15f730ecf71475',
        timeout: 30000,
      });
      
      const currentBlock = await provider.getBlockNumber();
      const maxBlock = Math.max(...transfers.filter(t => t.txHash !== 'placeholder').map(t => t.blockNumber));
      
      if (maxBlock < currentBlock) {
        const startBlock = maxBlock + 1;
        const endBlock = Math.min(startBlock + 50000, currentBlock);
        const seenHashes = new Set(transfers.map(t => t.txHash));
        let newRecords = [];
        
        const allAddresses = getAllAddresses().filter(a => a !== POOL_ADDRESS.toLowerCase());
        
        for (const addr of allAddresses) {
          const whaleTopic = '0x000000000000000000000000' + addr.slice(2);
          try {
            const logs = await provider.getLogs({
              address: ARK_CONTRACT,
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x0000000000000000000000008501168656fcac4628f6910ccabea8b64ebe5bd4',
                whaleTopic,
              ],
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
          // 推送到 Telegram
          notifyNewTransfers(newRecords, transfers).catch(e => console.error('Bot notify error:', e));
        }
      }
    } catch(e) {
      console.error('RPC check error:', e.message);
    }
  }
  
  // 构建统计
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
    defaultAddresses: DEFAULT_WHALES,
  });
};

// BSCScan 爬取（同之前代码）
async function fetchFromBscScan(address) {
  const https = require('https');
  
  function fetchPage(page) {
    return new Promise((resolve, reject) => {
      const url = `https://bscscan.com/tokentxns?a=${address}&contract=${ARK_CONTRACT}&p=${page}`;
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }
  
  const results = [];
  const seenTxs = new Set();
  const POOL = POOL_ADDRESS.toLowerCase();
  const TARGET = address.toLowerCase();
  
  try {
    const html = await fetchPage(1);
    const lastMatch = html.match(/<a[^>]*href="[^"]*p=(\d+)"[^>]*>\s*Last\s*</i);
    const maxPage = lastMatch ? Math.min(parseInt(lastMatch[1]), 200) : 1;
    
    const rows = html.match(/<tr[^>]*>.*?<\/tr>/gs) || [];
    for (const row of rows) {
      const txMatch = row.match(/href="\/tx\/(0x[a-fA-F0-9]{64})"/);
      if (!txMatch) continue;
      const fromAddrs = row.match(/data-highlight-target="(0x[a-fA-F0-9]{40})"/g) || [];
      const addrs = fromAddrs.map(a => a.match(/0x[a-fA-F0-9]{40}/)[0].toLowerCase());
      const fromAddr = addrs[0] || '';
      const toAddr = addrs[1] || '';
      if (fromAddr === POOL && toAddr === TARGET) {
        const tsMatch = row.match(/(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2})/);
        const amtMatch = row.match(/class="td_showAmount"[^>]*>\s*([^<]+)/);
        const blockMatch = row.match(/href="\/block\/(\d+)"/);
        let amount = '';
        if (amtMatch) { const m = amtMatch[1].match(/([\d,]+\.?\d*)/); if (m) amount = m[1].replace(',', ''); }
        const record = { txHash: txMatch[1], blockNumber: blockMatch ? parseInt(blockMatch[1]) : 0, timestamp: (tsMatch ? tsMatch[1] : '').replace(' ', 'T') + ':00', from: '0x' + POOL.slice(-40), to: '0x' + TARGET.slice(-40), value: amount };
        if (!seenTxs.has(record.txHash)) { seenTxs.add(record.txHash); results.push(record); }
      }
    }
    
    for (let p = 2; p <= Math.min(maxPage, 10); p++) {
      await new Promise(r => setTimeout(r, 1500));
      const html = await fetchPage(p);
      const rows = html.match(/<tr[^>]*>.*?<\/tr>/gs) || [];
      for (const row of rows) {
        const txMatch = row.match(/href="\/tx\/(0x[a-fA-F0-9]{64})"/);
        if (!txMatch) continue;
        const fromAddrs = row.match(/data-highlight-target="(0x[a-fA-F0-9]{40})"/g) || [];
        const addrs = fromAddrs.map(a => a.match(/0x[a-fA-F0-9]{40}/)[0].toLowerCase());
        const fromAddr = addrs[0] || '';
        const toAddr = addrs[1] || '';
        if (fromAddr === POOL && toAddr === TARGET) {
          const tsMatch = row.match(/(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2})/);
          const amtMatch = row.match(/class="td_showAmount"[^>]*>\s*([^<]+)/);
          const blockMatch = row.match(/href="\/block\/(\d+)"/);
          let amount = '';
          if (amtMatch) { const m = amtMatch[1].match(/([\d,]+\.?\d*)/); if (m) amount = m[1].replace(',', ''); }
          const record = { txHash: txMatch[1], blockNumber: blockMatch ? parseInt(blockMatch[1]) : 0, timestamp: (tsMatch ? tsMatch[1] : '').replace(' ', 'T') + ':00', from: '0x' + POOL.slice(-40), to: '0x' + TARGET.slice(-40), value: amount };
          if (!seenTxs.has(record.txHash)) { seenTxs.add(record.txHash); results.push(record); }
        }
      }
    }
  } catch(e) {
    console.error('BSCScan fetch error:', e.message);
  }
  
  return results;
}
