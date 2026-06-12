/**
 * Vercel 入口文件 - 路由 / 到前端, /api 到 API 函数
 */
const express = require('express');
const path = require('path');
const app = express();

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// API 路由
app.use('/api/transfers', require('./api/transfers'));
app.use('/api/stats', require('./api/stats'));

// 所有其他路由返回 index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;
