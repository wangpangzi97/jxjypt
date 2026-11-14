# Changelog

## [1.0.3] - 2026-11-14

### 修复
- **修复 68 个章节全部「加载超时」的致命问题**：Tampermonkey MV3 沙箱与页面 world 隔离，`window.courses` / `window.g_chapterId` / `window.vodPlayer` 读不到，导致加载判定永远为 false
- 新增 `@grant unsafeWindow`，所有页面全局变量改经 `unsafeWindow` 访问
- 新增播放器双层降级：Aliplayer API 不可用时自动改用原生 `<video>` 元素（play/pause/seek/currentTime/duration）
- 章节加载判定改为纯 DOM 信号（`#course-title` 文本变化 + video 元素变化），不再依赖页面全局变量
- 视频列表改为从 `#chapter-video-list .chapter_video` 读取，单视频章节自动兜底
- 启动时输出环境诊断日志（unsafeWindow / courses / vodPlayer 可见性）

## [1.0.2] - 2026-11-14

### 新增
- 双环境自适应：同一份代码可在 Tampermonkey 和控制台直接运行（存储与日志推送自动降级）
- 新增 `dist/console-run.js` 控制台直跑版，用于绕过油猴注入问题快速验证
- 注入时设置 `window.__JXA_LOADED__` 标记并做幂等保护，避免重复面板和双循环
- 控制台输出标注运行环境（Tampermonkey / 控制台）

## [1.0.1] - 2026-11-14

### 修复
- `@match` 从 `/classroom/start*` 放宽为整个 `kc.jxjypt.cn` 域名，解决入口 URL 不同导致的「脚本未被执行」
- 增加执行自检：注入即输出控制台标记，播放页左上角弹绿色「已加载」提示
- 非播放页不再静默，弹黄色提示说明当前页不匹配

## [1.0.0] - 2026-11-14

### 新增
- 章节视频自动播放，播完自动进入下一节
- 章节内多段视频逐段播完（基于 `window.courses` 数组）
- 播完后等待上报落库再切换，避免学时丢失
- 滑块验证码检测：弹出即暂停自动操作、响铃提示，验证通过后自动续播
- 播放器暂停/卡死自动恢复，长时间无进度强制续播
- 右下角控制面板：暂停/继续、下一节、导出日志
- 日志双通道：本地接收器实时落盘 + 浏览器内备份
- 已完成章节本地记忆，支持跳过

### 已知限制
- 不破解滑块验证码，仅提示人工完成
- 默认 1.0 倍速，倍速播放存在被平台判异常的风险
