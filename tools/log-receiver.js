#!/usr/bin/env node
/**
 * 本地日志接收器
 * 用途：油猴脚本无法直接写本地磁盘，由本服务接收日志并落盘。
 * 启动：node log-receiver.js
 * 落盘：<LOG_DIR>/YYYY-MM-DD.log
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.LOG_PORT || 8791);
const HOST = process.env.LOG_HOST || '127.0.0.1';
const LOG_DIR = process.env.LOG_DIR || 'E:/AI任务/刷课/logs';
const MAX_BODY = 1024 * 1024;

function todayFile() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return path.join(LOG_DIR, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

function ensureDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function append(text) {
    ensureDir();
    const file = todayFile();
    fs.appendFile(file, text.endsWith('\n') ? text : text + '\n', 'utf8', (err) => {
        if (err) console.error('[错误] 写入失败：', err.message);
    });
    return file;
}

const server = http.createServer((req, res) => {
    cors(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'GET' && (req.url === '/ping' || req.url === '/')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, logDir: LOG_DIR, file: todayFile() }));
        return;
    }

    if (req.method === 'POST' && req.url.startsWith('/log')) {
        let body = '';
        let tooLarge = false;

        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY) {
                tooLarge = true;
                req.destroy();
            }
        });

        req.on('end', () => {
            if (tooLarge) {
                res.writeHead(413);
                res.end('payload too large');
                return;
            }
            const file = append(body);
            process.stdout.write(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 收到 ${body.length} 字节 -> ${path.basename(file)}\n`);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
        });

        req.on('error', () => {
            try { res.writeHead(500); res.end('error'); } catch (e) { /* ignore */ }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
});

server.listen(PORT, HOST, () => {
    ensureDir();
    console.log('==============================================');
    console.log('  本地日志接收器已启动');
    console.log(`  监听地址 : http://${HOST}:${PORT}`);
    console.log(`  日志目录 : ${LOG_DIR}`);
    console.log(`  当日文件 : ${todayFile()}`);
    console.log('  保持本窗口开启，油猴脚本会自动推送日志');
    console.log('  按 Ctrl+C 停止');
    console.log('==============================================');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[错误] 端口 ${PORT} 已被占用，请关闭占用程序或设置环境变量 LOG_PORT 换端口`);
    } else {
        console.error('[错误]', err.message);
    }
    process.exit(1);
});
