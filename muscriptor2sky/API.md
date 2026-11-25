# 网页版 API 契约（web/sky-core.js）

本文档是 **网页版唯一的技术契约**。写 UI 的、写测试的、写移植的都以它为准。

## 产品形态（用户明确要求）

浏览器打开网页 -> 选择文件 -> **在浏览器内本机处理，不上传任何字节** -> 从浏览器下载 .txt。

所以：没有后端、没有网络请求、没有服务端渲染。整个转换发生在用户自己的设备上。

## 定位

`sky-core.js` 是 `muscriptor2sky/core.py` 的 **1:1 JS 移植**。

硬性要求：

1. **输出与 Python 版逐字节一致**（同一个 MIDI + 同一组参数 -> 同一个 .txt 的每一个字节）。
2. **零依赖**，不引入任何 npm 包，不用构建工具。
3. 以 **经典脚本**（非 ES module）方式加载，因此既能被 `file://` 直接打开，也能被 Node `require`。
4. 目标环境：桌面 Chrome/Edge/Firefox/Safari + iOS Safari 13+ + Android Chrome。

加载方式：

    <!-- 浏览器 -->
    <script src="sky-core.js"></script>
    <!-- 之后可用 window.SkyCore -->

    // Node
    const SkyCore = require('./sky-core.js');

UMD 尾巴：

    (function (root, factory) {
      if (typeof module === 'object' && module.exports) module.exports = factory();
      else root.SkyCore = factory();
    })(typeof self !== 'undefined' ? self : this, function () {
      'use strict';
      /* ... */
      return { /* 见下 */ };
    });

## 导出表

| 成员 | 签名 | 说明 |
|---|---|---|
| `readMidi` | `(bytes: Uint8Array) -> Midi` | 解析标准 MIDI |
| `midiToSky` | `(midi: Midi, opts: Opts) -> {notes: SkyNote[], info: Info}` | 核心转换 |
| `writeSky` | `(notes, opts, info) -> {bytes: Uint8Array, text: string}` | 生成 SkyStudio 谱面字节 |
| `convert` | `(bytes: Uint8Array, opts: Opts) -> {bytes, text, info, fileName}` | 一步到位（UI 主要用这个） |
| `readSky` | `(bytes: Uint8Array) -> Song[]` | 读琴谱（反向） |
| `skyToMidi` | `(songs: Song[], opts: Opts) -> Uint8Array` | 琴谱 -> MIDI（反向） |
| `skyrParse` | `(bytes: Uint8Array) -> Verify` | 格式自检 |
| `preview` | `(notes: SkyNote[]) -> string` | 简谱预览文本 |
| `DEFAULTS` | `Opts` | 默认参数（见下） |
| `VERSION` | `string` | 网页版独立编号，形如 `1.5.0_web`（**不等于**主仓库版本） |

所有错误一律 `throw new Error('中文说明')`，UI 直接展示 `e.message`。

## Opts（对应 CLI 参数）

| 键 | 类型 | 默认 | 对应 CLI |
|---|---|---|---|
| `name` | string 或 null | null | `-n` |
| `author` | string 或 null | null | `-a` |
| `arranged` | string 或 null | null | `--arranged` |
| `transcribed` | string 或 null | null | `--transcribed` |
| `bpm` | number 或 null | null | `--bpm` |
| `bitsPerPage` | int | 16 | `--bits-per-page` |
| `pitchLevel` | int | 0 | `--pitch-level` |
| `virtualNotes` | bool | false | `--virtual-notes` |
| `encoding` | 'utf-16' 或 'utf-8' | 'utf-16' | `--encoding` |
| `root` | int | 60 | `--root` |
| `transpose` | 'auto' 或 'none' | 'auto' | `--transpose` |
| `grid` | number | 0.25 | `--grid` |
| `maxPoly` | int | 0 | `--max-poly` |
| `ppq` | int | 480 | `--ppq` |
| `noteLen` | number | 0.25 | `--note-len` |
| `fileName` | string 或 null | null | `-o`（仅用于生成默认输出名） |

## 数据结构

    Midi      = { notes: Note[], ppq: int, tempos: [tick, us][], drums: int, ntracks: int }
    Note      = { start: int, dur: int, pitch: int, vel: int, ch: int, track: int }
    SkyNote   = { time: int, key: int, layer: int, srcPitch: int, how: string }
    Song      = { name, author, bpm, bitsPerPage, pitchLevel, notes: [ms, layer, idx][] }
    Info      = { transpose, bpm, unitMs, range: [lo, hi], stat: {...}, drums, src,
                  playability, melody: { total, kept, rate }, pitchLevel, gridOk,
                  timeUnitBeats }
    Verify    = { name, encoding, noteCount, eventCount, polyphony, durationMs, keysUsed }

`stat` 的键与 Python 完全一致：`exact / octave / snapped / merged / dropped`，虚音模式下多一个 `virtual`。

## 逐字节对齐的 4 个坑（必须照做）

### 1. 舍入必须用 pyRound（四舍六入五成双）

Python 的 `round()` 是 **half-to-even**，JS 的 `Math.round()` 是 **half-up**。
本算法里 `round(pos * cell)` 真的会撞上 `.5`（例：cell=500、pos=2/16 -> 62.5，
Python 给 62，JS 给 63），所以每个 `round` 都要换掉：

    function pyRound(x) {
      var f = Math.floor(x), d = x - f;
      if (d > 0.5) return f + 1;
      if (d < 0.5) return f;
      return (f % 2 === 0) ? f : f + 1;   // Math.floor 向下取整，负数也成立
    }

（`round(x, 9)` 这种小数位舍入在 pick_transpose 里只用于比较，
两边数值差 >= 1/total >= 7.6e-4，远大于 1e-9，直接比浮点即可。）

### 2. JSON 里浮点要带 .0

Python `json.dumps(300.0)` -> `300.0`；JS `JSON.stringify(300)` -> `300`。
所以**不要用 JSON.stringify 拼谱面**，自己拼字符串：

- 整数字段（time / bitsPerPage / pitchLevel / isEncrypted）按整数输出；
- `bpm` 一定是浮点：整数值时要补 `.0`（`pyFloatStr`）；
- 字符串用 `JSON.stringify(s)` 转义（Python `ensure_ascii=False` 行为一致）；
- 键顺序必须与 core.py `write_sky()` 里 `meta` 的定义顺序完全一致：
  `name, author, arrangedBy, transcribedBy, permission, isComposed, bpm,
  bitsPerPage, pitchLevel, isEncrypted, songNotes`；
- 分隔符无空格：`{"a":1,"b":2}`；`songNotes` 元素同理 `{"time":400,"key":"1Key5"}`。

### 3. 编码

`encoding: 'utf-16'` -> **UTF-16LE + BOM(FF FE)**，无结尾 NUL。浏览器 `TextEncoder` 只有 UTF-8，
必须手写：

    function utf16le(s) {
      var out = new Uint8Array(2 + s.length * 2);
      out[0] = 0xFF; out[1] = 0xFE;
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        out[2 + i * 2] = c & 0xFF;
        out[3 + i * 2] = (c >> 8) & 0xFF;
      }
      return out;
    }

（注意：JS 字符串是 UTF-16 码元序列，BMP 之外的字会占 2 个码元，正好等于 UTF-16LE 的 4 字节，
所以上面这种写法天然正确，不要用 `for...of`。）

### 4. 稳定性与排序

Python `list.sort()` 稳定，JS `Array.prototype.sort` 在 ES2019 起也稳定。
但 JS 默认比较器把元素转字符串，**任何多键排序都必须传显式比较器**。

## 测试夹具格式（parity-tests 用）

    web/tests/fixtures/<slug>.json
    {
      "slug": "...",
      "source": "synthetic" 或 "examples/flower-dance/input.mid",
      "midiB64": "...",            // 合成用例直接内嵌，仓库不引入第三方版权 MIDI
      "cases": [
        { "name": "default", "opts": {}, "sha256": "...", "size": 134846,
          "info": { "transpose": -12, "bpm": 319.1489361702128,
                    "noteCount": 2245, "stat": {...}, "melody": {...} } }
      ]
    }

- `sha256` 是 **writeSky 输出的完整字节** 的哈希（Node `crypto.createHash('sha256')`）。
- 另存 2~3 个极小用例的**完整期望文本**（`"expectText": "..."`）方便出错时定位。
- 夹具由 `tools/gen_fixtures.py` 用 **Python 实现**生成，是唯一真源。

## 与 Python 版的一致性验收

    python tools/gen_fixtures.py            # 生成/刷新夹具
    node --test web/tests/                  # JS 实现必须全绿

只要夹具比对通过，网页版就与命令行版**逐字节等价**。

## 版本号约定

网页版有**自己的**版本号，形如 `1.5.0_web`，与主仓库（Python 包）的版本号是两条线：

- 主仓库版本在 `pyproject.toml` / `__init__.py`，代表命令行工具的功能版本；
- 网页版只是同一套算法的另一个入口，**不算主仓库的功能更新**，所以单独编号；
- `web/tests/core.test.js` 会断言 `VERSION` 匹配 `^\d+\.\d+\.\d+_web$`
  且**不等于** `pyproject.toml` 里的版本，防止两者被误改成一个。

## 隐私说明（写进 README 与页面）

页面必须明确写：所有处理都在你的浏览器里完成，文件不会离开你的设备。
这不是宣传语，是架构事实 —— 代码里不存在任何 `fetch` / `XMLHttpRequest` 上传路径。
