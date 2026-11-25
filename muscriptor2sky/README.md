# muscriptor2sky 网页版

在线使用：**https://eeesssr.github.io/muscriptor2sky/**

把 MIDI 文件转成光遇（Sky: Children of the Light）15 键琴谱，
输出 SkyStudio 能直接读的 `.txt`。

**全程在浏览器里完成，文件不会上传到任何服务器。**
没有后端、没有 `fetch`、没有 `XMLHttpRequest`，断网也能用。

---

## 这个目录是什么

本目录是 [muscriptor2sky](https://github.com/eeesssr/muscriptor2sky) 的网页版构建产物，
由主仓库的 GitHub Actions 自动同步到这里。

**请不要直接在本目录改代码** —— 下次同步会被覆盖。
源码在 [主仓库的 `web/` 目录](https://github.com/eeesssr/muscriptor2sky/tree/main/web)。

## 怎么用

1. 打开 https://eeesssr.github.io/muscriptor2sky/
2. 把 `.mid` 拖进虚线框（手机上是点一下选文件）
3. 点「转换」
4. 点「下载 .txt」

得到的 `.txt` 直接导入 SkyStudio 或各种光遇弹琴工具即可。
手机上可以「添加到主屏幕」当 App 用（PWA，支持离线）。

## 上游工具

音频不能直接转琴谱，需要先转成 MIDI。推荐 [MuScriptor](https://muscriptor.kyutai.org/)，
免费开源，上传音频就能下载 MIDI。页面里点「友情链接」旁边的「i」有完整步骤。

## 文件说明

| 文件 | 说明 |
|---|---|
| `index.html` | 页面本体，HTML + CSS + JS 全在一个文件里，无外部依赖 |
| `sky-core.js` | 转换核心，是主仓库 `core.py` 的 1:1 JavaScript 移植 |
| `sw.js` | Service Worker，负责离线缓存 |
| `manifest.webmanifest` | PWA 清单 |
| `API.md` | 核心的接口契约 |
| `.nojekyll` | 关闭 Jekyll 处理，让静态文件原样发布 |

## 版本

网页版有独立编号 `1.5.0_web`，与主仓库（Python 包）的版本号分开走。
网页版只是同一套算法的另一个入口，不算主仓库的功能更新。

## 许可

[MIT](https://github.com/eeesssr/muscriptor2sky/blob/main/LICENSE)

本项目只做格式转换，不附带任何乐谱。转谱他人作品请自行取得授权。
