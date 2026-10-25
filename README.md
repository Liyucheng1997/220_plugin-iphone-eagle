# 手机照片同步 — Eagle 插件（iPhone + 安卓）

用数据线把手机连上电脑，就能在 Eagle 里浏览手机里的照片和视频，一键导入 Eagle、
导出备份到文件夹，或从手机删除来释放空间。**iPhone / iPad 和安卓手机都支持**，
不需要 iCloud、云盘或手机助手。

## 安装

1. 从 [Releases](https://github.com/Liyucheng1997/220_plugin-iphone-eagle/releases) 下载
   `phone-photo-sync-<版本>.eagleplugin`，双击用 Eagle 打开即可安装。
   （开发者也可以在 Eagle 里 **插件 → 开发者 → 导入本地项目**，选择本仓库的 `plugin` 文件夹。）
2. 在 Eagle 插件列表里点 **「手机照片同步」**。

## 使用

1. **插上手机并解锁**，插件会自动识别，不用点刷新。
   - **iPhone**：弹出「要信任此电脑吗？」时点 **信任** 并输入锁屏密码。
   - **安卓**：下拉通知栏，把 USB 用途改为 **文件传输（MTP）**（默认的「仅充电」读不到照片）。
   - 如果哪一步没做好，插件会直接显示该怎么做，做完后自动继续。
2. 照片按月份分组显示，边读边出现；缩略图随滚动加载，并缓存在本地，下次打开秒开。
3. **选择**：单击选中，Ctrl 单击多选，Shift 单击连选，在空白处拖框批量选，Ctrl+A 全选。
4. **导入**：右上角「导入新照片」只导入还没导过的（已导入的照片右上角有「已导入」标记，
   不会重复）；有选中时变成「导入所选」。可在「导入到」里选择 Eagle 文件夹。
   导入在后台进行，可以继续浏览，也可以随时取消。
5. **查看**：双击（或回车）打开大图，← → 切换，滚轮缩放，Esc 关闭。
6. **拖拽**：按住照片直接拖进 Eagle，拖的是原图。
7. **右键菜单**：查看大图、导入、导出到文件夹、从手机删除。导入完成后也可一键
   「从手机删除这些已导入的照片」。

## 常见问题

| 现象 | 处理 |
|---|---|
| 显示「已检测到 iPhone，但还不能读取」 | 解锁 iPhone 点「信任」；仍不行就从 Microsoft Store 安装 **Apple Devices**（会安装 iPhone 驱动），再重新插拔 |
| 提示「手机暂时没有响应」 | 手机锁屏了。解锁并保持亮屏即可自动继续（iPhone：设置 → 显示与亮度 → 自动锁定 → 永不） |
| 「手机正被其他程序占用」 | 关闭 Windows「照片」导入、iTunes / Apple Devices、手机助手，以及资源管理器里打开的手机窗口 |
| 有些 iPhone 照片导不出 | 开启了「iCloud 照片 · 优化 iPhone 存储」时原图只在 iCloud。在手机上打开该照片等原图下载后再试 |
| HEIC 大图预览不出来 | 安装 Microsoft Store 里免费的「HEIF 图像扩展」「HEVC 视频扩展」。导入 Eagle 不受影响 |
| 后台组件无法启动 | 多为杀毒软件拦截。把插件文件夹加入白名单；插件也会自动改用 PowerShell 兼容模式 |
| 其他问题 | 右上角 **⋯ → 复制诊断信息**，把内容发给开发者 |

照片很多时，**插上后的第一次读取较慢**（Windows 的 MTP 驱动在建立缓存，iPhone 约 8000 张需
几分钟），之后再读只要一两秒，所以不必频繁拔插。读取过程中照片会陆续显示，不用干等。

## 工作原理

```
Eagle 插件窗口 (index.html + js/app.js)
   │  JSON 行协议（stdin / stdout）
   ▼
bridge/PhoneBridge.exe   常驻后台进程，插件打开时启动一次
   │  Windows 便携设备接口（WPD / MTP），与资源管理器「此电脑 → 手机」同一通道
   ▼
iPhone（Apple 驱动） / 安卓（Windows 自带 MTP 驱动）
```

- **常驻进程 + 单会话**：MTP 一台设备同时只允许一个会话。后台进程只开一个会话并复用，
  空闲 12 秒自动释放，让资源管理器等程序也能访问手机。
- **按优先级调度**：大图预览 > 屏幕上的缩略图 > 后台导入，按「一个文件」为粒度轮转，
  所以导入几千张时浏览和看大图依然流畅；滚走的缩略图请求会被取消。
- **卡住能自愈**：手机锁屏导致无响应时，8 秒后提示用户解锁；超时用
  `IPortableDevice::Cancel()` 取消卡住的调用，而不是杀进程（杀进程会遗留 MTP 会话，
  导致之后每次都卡、只能拔线）。插件窗口关闭或崩溃时，后台进程检测到后会正常关闭会话退出。
- **兼容不同电脑**：`PhoneBridge.exe` 用每台 Windows 10/11 都自带的 .NET Framework 4 编译，
  不需要安装任何运行库；若被杀毒软件或组策略拦截，自动改用 PowerShell 编译同一份源码运行
  （走 `-EncodedCommand`，不受脚本执行策略限制）。所有路径通过 JSON 传递，中文用户名、
  中文路径都没问题。源码保持纯 ASCII，不受系统代码页影响。

## 开发

```
plugin/
  manifest.json          Eagle 插件清单
  index.html, css/       界面（苹果式简约风格，跟随 Eagle 深浅色主题）
  js/app.js              界面逻辑：设备检测、虚拟网格、选择、导入/导出/删除任务、查看器
  js/backend.js          Node 端：启动/重启后台进程、请求路由、日志
  bridge/PhoneBridge.cs  后台进程源码（C# 5，WPD COM 互操作、调度器、看门狗）
  bridge/PhoneBridge.exe 编译产物（随插件发布）
tools/build.ps1          编译 exe；加 -Package 打包 dist/*.eagleplugin
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1            # 编译
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1 -Package   # 编译并打包
```

日志在插件缓存目录的 `logs/bridge.log`（右上角 ⋯ → 打开日志文件夹）。

### 已知限制

- 安卓会列出相机、截图、下载、微信等相册文件夹里的全部图片（已过滤应用缓存）。
- 视频没有内嵌缩略图时，网格中显示为格式占位图（为一张缩略图传整个视频太慢）。
- 少数设备的 MTP 实现不允许删除，失败时会说明原因，可在手机上手动删除。
