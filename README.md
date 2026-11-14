# jxjypt-autoplay

`kc.jxjypt.cn`（江西继续教育）课程页自动连播 Tampermonkey 脚本。

- 视频自动播放，**播完自动进入下一节**
- 一章内含多段视频时，**逐段播完**再跳章（避免学时不够）
- 播完后等待上报落库再切换，防止学时丢失
- 滑块验证码弹出时**自动暂停 + 响铃提示**，你滑完自动续播
- 播放器被暂停/卡死自动恢复
- 日志实时落盘到本地 `E:\AI任务\刷课\logs\`

## 一、原理（基于页面实测，非猜测）

| 机制 | 实现 |
|---|---|
| 播放器 | 阿里云 AliPlayer，全局实例 `window.vodPlayer` |
| 章节列表 | `.course-l dd[data-jie-id]`，DOM 顺序即播放顺序 |
| 切换章节 | 点击 `dd` → ajax `load/chapter/resource2` → 重建播放器，页面不刷新 |
| 章节内视频 | 全局 `window.courses` 数组，`showVideo(id)` 切换 |
| 计时心跳 | 播放中每 1 秒累加，写 cookie `watchTime` |
| 进度上报 | 每 30 秒 `fun_watch_rec()` → `watch/rec2` |
| 播放结束 | `ended` 事件触发一次上报，**平台本身不自动跳章** |

脚本不伪造接口，只驱动页面自身已有的函数与 DOM，因此不受 `getPlayAuth` 加密、CSRF token 影响。

## 二、安装

### 1. 安装 Tampermonkey

浏览器扩展商店安装 Tampermonkey。

### 2. 安装脚本

新建脚本 → 粘贴 `src/jxjypt-autoplay.user.js` 全文 → 保存。

或直接把该文件拖进浏览器窗口，Tampermonkey 会自动弹出安装页。

### 3. 启动日志接收器（可选，但推荐）

```bash
node tools/log-receiver.js
```

看到 `本地日志接收器已启动` 即成功，**保持窗口开启**。日志会写入：

```
E:\AI任务\刷课\logs\2026-11-14.log
```

端口被占用时可换端口：

```bash
LOG_PORT=8792 node tools/log-receiver.js
```

同时要把脚本顶部 `CFG.LOG_ENDPOINT` 改成对应端口。接收器未启动不影响脚本运行，日志会退回保存在浏览器内。

## 三、使用

1. 登录 `kc.jxjypt.cn`，打开课程播放页
2. 右下角出现「自动连播」面板，自动从**当前章节**开始
3. 默认跳过已打勾的章节（`CFG.SKIP_DONE`）

面板按钮：

- **暂停 / 继续**：暂停后不再自动播放，手动继续会恢复
- **下一节**：立即跳到本节末尾，触发切章
- **日志**：导出 `.log` 文件

## 四、可调参数

脚本顶部 `CFG`：

| 参数 | 默认 | 说明 |
|---|---|---|
| `SPEED` | `1.0` | 倍速。**建议保持 1.0**，平台可能校验真实时长 |
| `POLL_MS` | `1500` | 巡检间隔 |
| `END_GRACE_MS` | `4000` | 播完后等待上报的时间，太短会丢学时 |
| `SKIP_DONE` | `true` | 跳过已打勾章节 |
| `STALL_TIMEOUT_MS` | `240000` | 无进度多久判定卡死 |

## 五、更新维护

脚本头部有 `@version`，改动后递增。私有仓库的自动更新需要带 token 的 raw 地址：

```
@updateURL    https://<TOKEN>@raw.githubusercontent.com/wangpangzi97/jxjypt-autoplay/main/src/jxjypt-autoplay.user.js
@downloadURL  https://<TOKEN>@raw.githubusercontent.com/wangpangzi97/jxjypt-autoplay/main/src/jxjypt-autoplay.user.js
```

不想放 token 就手动更新：打开仓库 → 复制新文件内容 → 粘贴覆盖。

## 六、已知边界

1. **倍速风险**：服务端收到的是累计秒数，若与真实经过时间比对，倍速可能被判异常。默认 1.0 规避。
2. **验证码**：滑块为第三方 SDK（tianai-captcha），脚本只做暂停提示，不破解。弹出时必须人工完成。
3. **后台节流**：Chrome 会节流后台标签页定时器，建议单独开窗口保持前台，不要最小化。
4. **平台改版**：若页面 DOM 或函数名变更，脚本需同步更新；日志里的 `ERROR` 行可直接定位问题。
5. **一章多视频**：脚本按 `window.courses` 数组顺序全部播完才跳章，中途单段失败会记录并继续。

## 七、目录结构

```
jxjypt-autoplay/
├─ src/jxjypt-autoplay.user.js   # 油猴主脚本
├─ tools/log-receiver.js         # 本地日志接收器（Node，无依赖）
├─ README.md
└─ CHANGELOG.md
```
