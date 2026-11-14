/* 控制台直跑版 v1.0.3 —— 打开课程播放页，F12 → Console → 粘贴本文件全部内容 → 回车 */
(function () {
    'use strict';

    const VERSION = '1.0.3';

    // 幂等保护：油猴重复注入或控制台重复粘贴时，避免出现两个面板、两套循环
    if (window.__JXA_LOADED__) {
        console.warn('[自动连播] 已存在运行实例（' + window.__JXA_LOADED__ + '），本次注入跳过');
        return;
    }
    window.__JXA_LOADED__ = VERSION;

    // 页面上下文引用：Tampermonkey MV3 沙箱与页面 world 隔离，
    // 页面的 var 全局变量（g_chapterId / courses / vodPlayer）在 window 上读不到，
    // 必须经 unsafeWindow 访问；控制台环境下没有 unsafeWindow，退回 window。
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    /* ============================ 配置 ============================ */
    const CFG = {
        SPEED: 1.0,                 // 播放倍速，1.0 = 原速（最稳）
        POLL_MS: 1500,              // 巡检间隔
        END_GRACE_MS: 4000,         // 播完后等待，让服务端 watch/rec2 落库
        SWITCH_TIMEOUT_MS: 30000,   // 切章/切视频超时
        PLAYER_TIMEOUT_MS: 30000,   // 播放器就绪超时
        STALL_TIMEOUT_MS: 240000,   // 无进度超过此时长判定卡死
        SKIP_DONE: true,            // 跳过已打勾章节
        LOG_ENDPOINT: 'http://127.0.0.1:8791/log',
        LOG_PUSH_MIN_MS: 800,       // 日志推送最小间隔
    };

    /* ============================ 环境适配（油猴 / 控制台） ============================ */
    // 同时支持 Tampermonkey 注入和直接粘贴到浏览器控制台运行，
    // 便于在油猴不注入时快速定位是脚本问题还是扩展配置问题。
    const HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    const HAS_GM_XHR = typeof GM_xmlhttpRequest === 'function';

    const store = {
        get(key, def) {
            try {
                if (HAS_GM) {
                    const v = GM_getValue(key, def);
                    return v === undefined ? def : v;
                }
                const raw = localStorage.getItem('jxa_' + key);
                return raw === null ? def : JSON.parse(raw);
            } catch (e) {
                return def;
            }
        },
        set(key, val) {
            try {
                if (HAS_GM) GM_setValue(key, val);
                else localStorage.setItem('jxa_' + key, JSON.stringify(val));
            } catch (e) { /* 配额异常忽略 */ }
        },
    };

    function postLog(text) {
        if (HAS_GM_XHR) {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CFG.LOG_ENDPOINT,
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                data: text,
                timeout: 5000,
                onload: (res) => {
                    if (res.status >= 400) markEndpointDown(res.status);
                },
                onerror: () => markEndpointDown('network'),
                ontimeout: () => markEndpointDown('timeout'),
            });
            return;
        }
        fetch(CFG.LOG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: text,
            keepalive: true,
        }).then((r) => {
            if (!r.ok) markEndpointDown(r.status);
        }).catch(() => markEndpointDown('network'));
    }

    const savedCompleted = store.get('completed', []);

    /* ============================ 状态 ============================ */
    const S = {
        running: true,
        paused: false,
        logs: [],
        completed: new Set(Array.isArray(savedCompleted) ? savedCompleted : []),
        captchaWaiting: false,
        lastTime: 0,
        lastProgressAt: Date.now(),
        endpointOk: true,
        lastPushAt: 0,
        pushQueue: [],
        saveTimer: null,
        statusText: '初始化中',
    };

    /* ============================ 工具 ============================ */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function fmt(sec) {
        sec = Math.max(0, Math.floor(Number(sec) || 0));
        const h = String(Math.floor(sec / 3600)).padStart(2, '0');
        const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    async function waitFor(fn, timeout, label) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                if (fn()) return true;
            } catch (e) { /* 忽略单次异常 */ }
            await sleep(300);
        }
        return false;
    }

    /* ============================ 日志 ============================ */
    function log(msg, level) {
        level = level || 'INFO';
        const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
        console.log('[自动连播]', msg);
        S.logs.push(line);
        if (S.logs.length > 3000) S.logs.splice(0, S.logs.length - 3000);
        scheduleSave();
        enqueuePush(line);
        renderPanel();
    }

    function scheduleSave() {
        if (S.saveTimer) return;
        S.saveTimer = setTimeout(() => {
            S.saveTimer = null;
            try {
                store.set('logs', S.logs.slice(-1500).join('\n'));
                store.set('completed', Array.from(S.completed));
            } catch (e) { /* 配额异常忽略 */ }
        }, 3000);
    }

    function enqueuePush(line) {
        S.pushQueue.push(line);
        const now = Date.now();
        if (now - S.lastPushAt < CFG.LOG_PUSH_MIN_MS) return;
        if (!S.endpointOk) return;
        S.lastPushAt = now;
        const payload = S.pushQueue.splice(0, S.pushQueue.length).join('\n');
        try {
            postLog(payload);
        } catch (e) {
            markEndpointDown(e.message);
        }
    }

    function markEndpointDown(reason) {
        if (S.endpointOk) {
            S.endpointOk = false;
            console.warn('[自动连播] 本地日志接收器不可用：', reason);
            S.logs.push(`[${new Date().toISOString()}] [WARN] 本地日志接收器不可用(${reason})，日志仅保存在浏览器内`);
            renderPanel();
        }
    }

    /* ============================ 页面探针 ============================ */
    function getDds() {
        return Array.from(document.querySelectorAll('.course-l dd[data-jie-id]')).map((el) => ({
            el,
            id: String(el.getAttribute('data-jie-id')),
            title: (el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' '),
            done: !!el.querySelector('i.fa-check-circle') || S.completed.has(String(el.getAttribute('data-jie-id'))),
        }));
    }

    /* ==================== 播放器控制层（Aliplayer → 原生 video 双层降级） ==================== */
    function getPlayer() {
        try {
            const p = W.vodPlayer;
            if (p && typeof p.getStatus === 'function') return p;
        } catch (e) { /* 沙箱不可见 */ }
        return null;
    }

    function getVideoEl() {
        return document.querySelector('#video-content video') || document.querySelector('.prism-player video');
    }

    // 统一状态读取：优先 Aliplayer API，失败则读原生 video 元素
    function readState() {
        const p = getPlayer();
        if (p) {
            try {
                return { st: p.getStatus(), ct: p.getCurrentTime(), dur: p.getDuration(), src: 'aliplayer' };
            } catch (e) { /* 降级 */ }
        }
        const v = getVideoEl();
        if (v) {
            const st = v.ended ? 'ended' : (v.paused ? 'pause' : 'playing');
            return { st, ct: v.currentTime || 0, dur: v.duration || 0, src: 'video' };
        }
        return null;
    }

    function doPlay() {
        const p = getPlayer();
        if (p) {
            try { p.play(); return true; } catch (e) { /* 降级 */ }
        }
        const v = getVideoEl();
        if (v) {
            try { v.play().catch(() => {}); return true; } catch (e) { /* ignore */ }
        }
        return false;
    }

    function doPause() {
        const p = getPlayer();
        if (p) {
            try { p.pause(); return; } catch (e) { /* 降级 */ }
        }
        const v = getVideoEl();
        if (v) { try { v.pause(); } catch (e) { /* ignore */ } }
    }

    function doSeek(t) {
        const p = getPlayer();
        if (p) {
            try { p.seek(t); return; } catch (e) { /* 降级 */ }
        }
        const v = getVideoEl();
        if (v) { try { v.currentTime = t; } catch (e) { /* ignore */ } }
    }

    function doSetSpeed(rate) {
        const p = getPlayer();
        if (p && typeof p.setSpeed === 'function') {
            try { p.setSpeed(rate); return; } catch (e) { /* 降级 */ }
        }
        const v = getVideoEl();
        if (v) { try { v.playbackRate = rate; } catch (e) { /* ignore */ } }
    }

    // 本章视频列表：优先读 DOM（不受沙箱影响），读不到再退回页面 courses 数组
    function getVideoList() {
        const items = Array.from(document.querySelectorAll('#chapter-video-list .chapter_video'));
        if (items.length > 0) {
            return items.map((el) => ({
                id: el.id,
                name: (el.textContent || '').trim().replace(/\s+/g, ' ') || el.id,
                el,
            }));
        }
        // 单视频章节：列表容器被隐藏，整章只有一段
        try {
            const arr = W.courses;
            if (Array.isArray(arr) && arr.length > 0) {
                return arr.map((c) => ({ id: String(c.id), name: c.name || String(c.id), el: null }));
            }
        } catch (e) { /* 沙箱不可见 */ }
        return [{ id: null, name: '本章视频', el: null }];
    }

    function switchVideo(item) {
        if (item.el) {
            item.el.click();   // 触发页面内联 onclick="showVideo(id)"
            return;
        }
        if (item.id && typeof W.showVideo === 'function') {
            try { W.showVideo(item.id); return; } catch (e) { /* ignore */ }
        }
        if (item.id) {
            const el = document.getElementById(item.id);
            if (el) el.click();
        }
    }

    // 章节加载完成判定：纯 DOM 信号，不依赖页面全局变量
    // 最强信号是标题文本发生变化；其次才是视频元素/视频列表的变化
    function chapterLoaded(dd, prevVideoEl, prevTitle, prevListCount) {
        const titleEl = document.querySelector('#course-title');
        const title = (titleEl ? titleEl.textContent : '').trim();
        if (!title) return false;
        if (prevTitle !== undefined && title !== prevTitle) return true;
        const videoEl = getVideoEl();
        if (videoEl && videoEl !== prevVideoEl) return true;
        const listCount = document.querySelectorAll('#chapter-video-list .chapter_video').length;
        if (listCount > 0 && listCount !== prevListCount) return true;
        return false;
    }

    function captchaVisible() {
        const mask = document.getElementById('tac-captcha-mask');
        if (!mask) return false;
        const cs = getComputedStyle(mask);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        const r = mask.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    /* ============================ 提示音 ============================ */
    function beep() {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            const ctx = new AC();
            [0, 0.35, 0.7].forEach((delay) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = 880;
                gain.gain.value = 0.12;
                osc.connect(gain).connect(ctx.destination);
                osc.start(ctx.currentTime + delay);
                osc.stop(ctx.currentTime + delay + 0.22);
            });
            setTimeout(() => ctx.close && ctx.close(), 1500);
        } catch (e) { /* 静默 */ }
    }

    /* ============================ 核心流程 ============================ */
    function findStartIndex(dds) {
        const urlChapter = new URLSearchParams(location.search).get('chapter');
        let idx = dds.findIndex((d) => d.id === String(urlChapter));
        if (idx >= 0) return idx;
        const active = document.querySelector('.course-l dd.z-color');
        if (active) {
            const id = String(active.getAttribute('data-jie-id'));
            idx = dds.findIndex((d) => d.id === id);
            if (idx >= 0) return idx;
        }
        idx = dds.findIndex((d) => !d.done);
        return idx >= 0 ? idx : 0;
    }

    async function playOneVideo(item, label) {
        // 多段章节：切到目标视频；单段章节：直接播当前
        if (item.el) {
            const cur = document.querySelector('#chapter-video-list .chapter_video.video_current');
            if (!cur || cur.id !== item.id) switchVideo(item);
        } else if (item.id) {
            let curId = '';
            try { curId = String(W.currentCourseId || ''); } catch (e) { /* 沙箱不可见 */ }
            if (curId !== String(item.id)) switchVideo(item);
        }

        const ready = await waitFor(() => {
            const s = readState();
            return s && s.dur > 0;
        }, CFG.PLAYER_TIMEOUT_MS);

        if (!ready) {
            const s = readState();
            log(`  ${label} 播放器未就绪（state=${s ? s.st : 'null'}），跳过`, 'ERROR');
            return false;
        }

        const dur0 = readState().dur;
        doSetSpeed(CFG.SPEED);
        doPlay();

        S.lastTime = 0;
        S.lastProgressAt = Date.now();
        log(`  ${label} 开始播放，时长 ${fmt(dur0)}`);

        while (S.running) {
            await sleep(CFG.POLL_MS);

            if (S.paused) {
                doPause();
                S.statusText = '已暂停（手动）';
                continue;
            }

            if (captchaVisible()) {
                await handleCaptcha();
                continue;
            }

            const s = readState();
            if (!s) {
                await sleep(2000);
                continue;
            }

            if (s.ct > S.lastTime + 0.2) {
                S.lastTime = s.ct;
                S.lastProgressAt = Date.now();
                S.statusText = `播放中 ${fmt(s.ct)} / ${fmt(s.dur)}`;
                renderPanel();
            }

            if (s.st === 'ended' || (s.dur > 0 && s.ct >= s.dur - 1.5)) {
                log(`  ${label} 播放完成 (${fmt(s.ct)} / ${fmt(s.dur)})，等待上报…`);
                await sleep(CFG.END_GRACE_MS);
                return true;
            }

            if (s.st === 'pause' || s.st === 'ready' || s.st === 'loading' || s.st === 'idle') {
                doPlay();
            }

            if (s.st === 'error') {
                log('  播放器报错，尝试恢复', 'WARN');
                doPlay();
                await sleep(3000);
            }

            if (Date.now() - S.lastProgressAt > CFG.STALL_TIMEOUT_MS) {
                log('  长时间无进度，强制续播', 'WARN');
                doSeek(Math.min(S.lastTime + 1, Math.max(0, s.dur - 2)));
                doPlay();
                S.lastProgressAt = Date.now();
            }
        }
        return false;
    }

    async function handleCaptcha() {
        if (!S.captchaWaiting) {
            S.captchaWaiting = true;
            S.statusText = '⚠ 等待人工滑块验证';
            log('检测到滑块验证，已暂停自动操作，请手动完成验证', 'WARN');
            beep();
            doPause();
            renderPanel();
        }
        while (S.running && captchaVisible()) await sleep(1000);
        S.captchaWaiting = false;
        log('验证已通过，继续播放');
        doPlay();
        S.lastProgressAt = Date.now();
    }

    async function playChapter(dd, idx, total) {
        log(`=== [${idx + 1}/${total}] ${dd.title} (${dd.id}) ===`);
        S.statusText = `加载章节 ${idx + 1}/${total}`;
        renderPanel();

        const prevVideoEl = getVideoEl();
        const prevTitle = (() => {
            const t = document.querySelector('#course-title');
            return t ? t.textContent.trim() : '';
        })();
        const prevListCount = document.querySelectorAll('#chapter-video-list .chapter_video').length;

        let curChapter = '';
        try { curChapter = String(W.g_chapterId || ''); } catch (e) { /* 沙箱不可见 */ }
        const needSwitch = curChapter !== dd.id;

        if (needSwitch) {
            dd.el.click();
            log(`  切换章节：${curChapter || '(空)'} → ${dd.id}`);
        }

        // 纯 DOM 判定，不依赖页面全局变量，避免沙箱隔离导致永远判定失败
        const loaded = needSwitch
            ? await waitFor(() => chapterLoaded(dd, prevVideoEl, prevTitle, prevListCount), CFG.SWITCH_TIMEOUT_MS)
            : await waitFor(() => !!getVideoEl() || getVideoList().length > 0, CFG.PLAYER_TIMEOUT_MS);

        if (!loaded) {
            const t = document.querySelector('#course-title');
            const title = t ? t.textContent.trim() : '';
            log(`章节加载超时：标题="${title}" 视频元素=${!!getVideoEl()}，跳过本章`, 'ERROR');
            return false;
        }

        const videos = getVideoList();
        log(`本章共 ${videos.length} 段视频`);

        let okCount = 0;
        for (let i = 0; i < videos.length; i++) {
            if (!S.running) return false;
            const label = `第${i + 1}/${videos.length}段`;
            const ok = await playOneVideo(videos[i], label);
            if (ok) okCount++;
        }

        if (okCount === videos.length) {
            S.completed.add(dd.id);
            scheduleSave();
            log(`本章全部完成（${okCount}/${videos.length}）`);
        } else {
            log(`本章部分完成（${okCount}/${videos.length}）`, 'WARN');
        }
        await sleep(CFG.END_GRACE_MS);
        return okCount === videos.length;
    }

    async function main() {
        const diag = (() => {
            let c = 'null';
            let v = 'null';
            try { c = Array.isArray(W.courses) ? ('array(' + W.courses.length + ')') : typeof W.courses; } catch (e) { c = 'error'; }
            try { v = W.vodPlayer ? 'object' : 'null'; } catch (e) { v = 'error'; }
            return `unsafeWindow=${typeof unsafeWindow !== 'undefined'} courses=${c} vodPlayer=${v}`;
        })();
        log('环境诊断：' + diag);
        log('脚本启动，等待页面就绪…');
        const ready = await waitFor(() => {
            return getDds().length > 0 && document.getElementById('pagecode');
        }, 60000);
        if (!ready) {
            log('页面未就绪（60s），退出', 'ERROR');
            return;
        }

        const dds = getDds();
        log(`检测到 ${dds.length} 个章节`);
        let idx = findStartIndex(dds);
        log(`从第 ${idx + 1} 章开始`);

        while (S.running && idx < getDds().length) {
            const list = getDds();
            const dd = list[idx];
            if (!dd) break;

            if (CFG.SKIP_DONE && dd.done) {
                log(`跳过已完成：${dd.title}`);
                idx++;
                continue;
            }

            await playChapter(dd, idx, list.length);
            idx++;
        }

        if (S.running) {
            S.statusText = '✅ 全部章节处理完毕';
            log('全部章节处理完毕', 'DONE');
            beep();
        }
        renderPanel();
    }

    /* ============================ 面板 ============================ */
    let panelEl = null;

    function buildPanel() {
        const box = document.createElement('div');
        box.id = 'jxjypt-autoplay-panel';
        box.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:16px', 'z-index:999999',
            'width:260px', 'background:rgba(24,26,32,.95)', 'color:#e8eaed',
            'font:12px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif',
            'border-radius:10px', 'box-shadow:0 6px 24px rgba(0,0,0,.35)',
            'padding:10px 12px', 'user-select:none',
        ].join(';');

        box.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <strong style="font-size:13px;color:#8ab4f8">自动连播 v${VERSION}</strong>
                <span id="jxa-dot" style="width:8px;height:8px;border-radius:50%;background:#34a853;display:inline-block"></span>
            </div>
            <div id="jxa-status" style="color:#9aa0a6;word-break:break-all;min-height:34px">初始化中</div>
            <div style="display:flex;gap:6px;margin-top:8px">
                <button id="jxa-toggle" style="flex:1;padding:5px 0;border:0;border-radius:6px;background:#3c4043;color:#e8eaed;cursor:pointer">暂停</button>
                <button id="jxa-next" style="flex:1;padding:5px 0;border:0;border-radius:6px;background:#3c4043;color:#e8eaed;cursor:pointer">下一节</button>
                <button id="jxa-export" style="flex:1;padding:5px 0;border:0;border-radius:6px;background:#3c4043;color:#e8eaed;cursor:pointer">日志</button>
            </div>
        `;
        document.body.appendChild(box);
        panelEl = box;

        box.querySelector('#jxa-toggle').addEventListener('click', (e) => {
            S.paused = !S.paused;
            e.target.textContent = S.paused ? '继续' : '暂停';
            log(S.paused ? '手动暂停' : '手动继续');
            if (!S.paused) doPlay();
        });

        box.querySelector('#jxa-next').addEventListener('click', () => {
            log('手动跳到下一节', 'WARN');
            const s = readState();
            if (s && s.dur > 0) doSeek(Math.max(0, s.dur - 1));
        });

        box.querySelector('#jxa-export').addEventListener('click', exportLogs);
    }

    function renderPanel() {
        if (!panelEl) return;
        const st = panelEl.querySelector('#jxa-status');
        const dot = panelEl.querySelector('#jxa-dot');
        if (st) st.textContent = S.statusText;
        if (dot) dot.style.background = S.captchaWaiting ? '#fbbc04' : (S.running ? '#34a853' : '#ea4335');
    }

    function exportLogs() {
        const text = S.logs.join('\n');
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        a.download = `jxjypt-autoplay_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.log`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        log('日志已导出');
    }

    /* ============================ 启动 ============================ */
    const IS_PLAY_PAGE = /\/classroom\/start/.test(location.pathname);

    function flashBadge(text, color) {
        const b = document.createElement('div');
        b.textContent = text;
        b.style.cssText = [
            'position:fixed', 'left:16px', 'top:16px', 'z-index:999999',
            'padding:8px 14px', 'border-radius:8px',
            'background:' + (color || '#34a853'), 'color:#fff',
            'font:13px/1.5 -apple-system,Segoe UI,Microsoft YaHei,sans-serif',
            'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'pointer-events:none',
        ].join(';');
        document.body.appendChild(b);
        setTimeout(() => b.remove(), 4000);
    }

    function boot() {
        const env = HAS_GM ? 'Tampermonkey' : '控制台';
        console.log('%c[自动连播] v' + VERSION + ' 已注入（' + env + '）', 'color:#34a853;font-weight:bold', location.href);

        if (!IS_PLAY_PAGE) {
            console.log('[自动连播] 当前页不是播放页（需包含 /classroom/start），脚本待命不执行');
            flashBadge('自动连播已注入，但当前不是播放页', '#fbbc04');
            return;
        }

        buildPanel();
        flashBadge('自动连播已加载');
        log('面板已就绪，当前页：' + location.href);
        main().catch((e) => log('主流程异常：' + (e && e.stack ? e.stack : e), 'ERROR'));
    }

    console.log('[自动连播] 脚本已注入，等待 DOM 就绪…');

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(boot, 800);
    } else {
        window.addEventListener('load', () => setTimeout(boot, 800));
    }
})();
