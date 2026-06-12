const initialTransfers = require('./initial_transfers.json');

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

// 从已有数据提取所有地址
function getAllAddresses() {
  return [...new Set(transfers.map(t => t.to.toLowerCase()))];
}

// 确保默认地址都在数据里
function ensureDefaultAddresses() {
  const existing = getAllAddresses();
  for (const addr of DEFAULT_WHALES) {
    if (!existing.includes(addr)) {
      // 添加一个空记录占位
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
      return res.json({ message: '地址已存在', count: transfers.filter(t => t.to.toLowerCase() === address).length });
    }
    
    // 占位，前端会显示"正在扫描"状态
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
  
  // === 查询新地址数据（爬BSCScan） ===
  if (action === 'fetch') {
    if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
      return res.json({ error: '无效地址' });
    }
    
    // 异步爬取
    fetchFromBscScan(address).then(records => {
      if (records.length > 0) {
        // 删除占位记录
        transfers = transfers.filter(t => !(t.txHash === 'placeholder' && t.to.toLowerCase() === address));
        transfers.push(...records);
        transfers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      }
    }).catch(e => console.error('fetch error:', e.message));
    
    return res.json({ message: '开始爬取', address });
  }
  
  // === 列表 ===
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

// 爬取 BSCScan tokentxns 页面
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
    
    // 解析最大页数
    const lastMatch = html.match(/<a[^>]*href="[^"]*p=(\d+)"[^>]*>\s*Last\s*</i);
    const maxPage = lastMatch ? Math.min(parseInt(lastMatch[1]), 200) : 1;
    
    // 解析第1页
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
        if (amtMatch) {
          const m = amtMatch[1].match(/([\d,]+\.?\d*)/);
          if (m) amount = m[1].replace(',', '');
        }
        
        const record = {
          txHash: txMatch[1],
          blockNumber: blockMatch ? parseInt(blockMatch[1]) : 0,
          timestamp: (tsMatch ? tsMatch[1] : '').replace(' ', 'T') + ':00',
          from: '0x' + POOL.slice(-40),
          to: '0x' + TARGET.slice(-40),
          value: amount,
        };
        
        if (!seenTxs.has(record.txHash)) {
          seenTxs.add(record.txHash);
          results.push(record);
        }
      }
    }
    
    // 爬后续页面（最多10页，避免太慢）
    for (let p = 2; p <= Math.min(maxPage, 10); p++) {
      await new Promise(r => setTimeout(r, 1200)); // 延迟防封
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
          if (amtMatch) {
            const m = amtMatch[1].match(/([\d,]+\.?\d*)/);
            if (m) amount = m[1].replace(',', '');
          }
          
          const record = {
            txHash: txMatch[1],
            blockNumber: blockMatch ? parseInt(blockMatch[1]) : 0,
            timestamp: (tsMatch ? tsMatch[1] : '').replace(' ', 'T') + ':00',
            from: '0x' + POOL.slice(-40),
            to: '0x' + TARGET.slice(-40),
            value: amount,
          };
          
          if (!seenTxs.has(record.txHash)) {
            seenTxs.add(record.txHash);
            results.push(record);
          }
        }
      }
    }
    
  } catch(e) {
    console.error('BSCScan fetch error:', e.message);
  }
  
  return results;
}
