#!/usr/bin/env python3
"""
直接从BSCScan tokentxns页面抓取每个狗大户地址的转入记录，过滤出从奖金池转来的
"""
import json
import time
import re
import urllib.request
import urllib.error
from collections import defaultdict

ARK_CONTRACT = "0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D"
POOL_ADDRESS = "0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4".lower()

WHALE_ADDRESSES = [
    "0xc2309bb33EFF8fB0A1a22435bB63844D320B130D",
    "0x8e5E761EAF35c8bc7a4F359A44EA2D255E25e052",
    "0xc6C6C5A8C629eAb947Eb610FB8B0936102ebA0AD",
    "0xd47b1565a31915e29B42a3948C1dCEc0f0e01d2A",
    "0x92F156Ce030CD3e0Ea999d7cB6adf62B480E63cc",
]

DATA_FILE = "/Users/huge/Documents/Codex/2026-06-12/ark-ark-ark-0xcae117ca6bc8a341d2e7207f30e180f0e5618b9d-0x8501168656fcac4628f6910/api/initial_transfers.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/125.0.0.0 Safari/537.36",
}

def fetch_page(address, page=1):
    url = f"https://bscscan.com/tokentxns?a={address}&contract={ARK_CONTRACT}&p={page}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  [WARN] 第{page}页失败: {e}")
        return None

def parse_page(html, target_addr):
    """从页面中提取从奖金池到目标地址的转账"""
    results = []
    target_lower = target_addr.lower()
    
    tb = re.search(r'<tbody[^>]*>(.*?)</tbody>', html, re.DOTALL)
    if not tb:
        return results
    
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', tb.group(1), re.DOTALL)
    
    for row in rows:
        # Tx hash
        tx_m = re.search(r'href="/tx/(0x[a-fA-F0-9]{64})"', row)
        if not tx_m:
            continue
        tx_hash = tx_m.group(1)
        
        # Timestamp
        ts_m = re.search(r'(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2})', row)
        timestamp = ts_m.group(1) if ts_m else ""
        
        # From/To 地址
        addrs = re.findall(r'data-highlight-target="(0x[a-fA-F0-9]{40})"', row)
        from_addr = addrs[0].lower() if len(addrs) >= 1 else ""
        to_addr = addrs[1].lower() if len(addrs) >= 2 else ""
        
        # 方向
        dir_m = re.search(r'badge[^>]*>\s*(IN|OUT)\s*</span', row, re.IGNORECASE)
        direction = dir_m.group(1).upper() if dir_m else ""
        
        # 数量
        amt_m = re.search(r'class="td_showAmount"[^>]*>\s*([^<]+)', row)
        amount = ""
        if amt_m:
            m2 = re.search(r'([\d,]+\.?\d*)', amt_m.group(1))
            if m2:
                amount = m2.group(1).replace(",", "")
        
        # 只取奖金池 -> 目标地址的
        if from_addr == POOL_ADDRESS and to_addr == target_lower:
            # 获取区块号
            block_m = re.search(r'href="/block/(\d+)"', row)
            block_number = int(block_m.group(1)) if block_m else 0
            
            results.append({
                "txHash": tx_hash,
                "blockNumber": block_number,
                "timestamp": timestamp.replace(" ", "T") + ":00",
                "from": "0x" + from_addr[-40:],
                "to": "0x" + to_addr[-40:],
                "value": amount,
            })
    
    return results

def get_max_page(html):
    m = re.search(r'<a[^>]*href="[^"]*p=(\d+)"[^>]*>\s*Last\s*<', html, re.IGNORECASE)
    if m:
        return int(m.group(1))
    pages = re.findall(r'href="[^"]*[?&]p=(\d+)"', html)
    return max(int(p) for p in pages) if pages else 1

def fetch_all_for_address(address):
    print(f"\n{'='*50}")
    print(f"采集: {address}")
    print(f"{'='*50}")
    
    html = fetch_page(address, 1)
    if not html:
        return []
    
    records = parse_page(html, address)
    print(f"  第1页: {len(records)} 条")
    
    max_page = min(get_max_page(html), 200)  # 最多200页
    print(f"  总{max_page}页")
    
    for p in range(2, max_page + 1):
        time.sleep(1.2)
        h = fetch_page(address, p)
        if h:
            r = parse_page(h, address)
            records.extend(r)
            print(f"  第{p}页: {len(r)} 条 (累计{len(records)})")
    
    print(f"  => 共{len(records)}条")
    return records

def main():
    print("从BSCScan采集各狗大户地址的奖金池转入记录...")
    
    all_records = []
    seen_txs = set()
    
    for addr in WHALE_ADDRESSES:
        records = fetch_all_for_address(addr)
        for r in records:
            if r["txHash"] not in seen_txs:
                seen_txs.add(r["txHash"])
                all_records.append(r)
    
    # 按时间排序（最新的在前）
    all_records.sort(key=lambda x: x["timestamp"], reverse=True)
    
    print(f"\n{'='*50}")
    print(f"共采集到 {len(all_records)} 条去重记录")
    
    # 按地址统计
    stats = defaultdict(lambda: {"count": 0, "total": 0.0})
    for r in all_records:
        stats[r["to"]]["count"] += 1
        stats[r["to"]]["total"] += float(r["value"])
    
    for addr, s in stats.items():
        print(f"  {addr[:10]}...: {s['count']}笔, {s['total']:.2f} ARK")
    
    print(f"\n最新: {all_records[0]['timestamp'][:19]}")
    print(f"最早: {all_records[-1]['timestamp'][:19]}")
    
    # 写入文件
    with open(DATA_FILE, "w") as f:
        json.dump(all_records, f, indent=2, ensure_ascii=False)
    
    print(f"\n已保存到: {DATA_FILE}")

if __name__ == "__main__":
    main()
