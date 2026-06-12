# ARK 狗大户奖金池转入监控

监控 BSC 上 ARK 代币从奖金池地址到狗大户地址的转入记录。

## 配置

| 项 | 值 |
|---|---|
| 代币 | 0xCae117ca6Bc8A341D2E7207F30E180f0e5618B9D |
| 奖金池 | 0x8501168656FcaC4628F6910CcABEA8B64Ebe5BD4 |
| 监控地址 | 5 个狗大户 |

## 技术栈

- Node.js + Express + WebSocket
- BSC RPC (ethers.js)
- Chart.js 看板

## 运行

```bash
npm install
node server.js
```

## 部署到 Railway

1. Fork/Push 到 GitHub
2. Railway 连接仓库
3. 启动命令: `node server.js`
4. 部署完成
