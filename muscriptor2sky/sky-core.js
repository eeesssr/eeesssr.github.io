/*!
 * sky-core.js -- muscriptor2sky 网页版核心
 * ========================================
 *
 * 这是 muscriptor2sky/core.py 的 1:1 JavaScript 移植。
 * 目标：同一份 MIDI + 同一组参数，输出与 Python 版**逐字节一致**。
 *
 * 为什么要有它：网页版要在浏览器里本地完成转换，不能上传文件、
 * 不能依赖后端。所以核心算法必须能在 JS 里跑。
 *
 * 设计约束：
 *   1. 零依赖，不引入任何 npm 包，不用构建工具。
 *   2. 经典脚本（非 ES module），file:// 双击也能用。
 *   3. 不发起任何网络请求 —— 文件永远不离开用户的设备。
 *
 * 与 Python 的差异都集中在几个「必须照做」的点上，每个都写了注释：
 *   - pyRound：Python round() 是 half-to-even，JS Math.round() 是 half-up
 *   - pyMod：Python % 对负数返回非负，JS % 返回负
 *   - pyFloatStr：Python json.dumps(300.0) 是 "300.0"，JS 是 "300"
 *   - utf16le：浏览器 TextEncoder 只支持 UTF-8
 *
 * 许可证：MIT
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkyCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 网页版独立编号，不是主仓库的版本号。
  // 主仓库（Python 包）版本见 pyproject.toml，两者不要混。
  var VERSION = '1.5.0_web';

  // ============================================================ 常量

  var MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
  var DEGREE_NAMES = ['1', '2', '3', '4', '5', '6', '7',
                      "1'", "2'", "3'", "4'", "5'", "6'", "7'",
                      "1''"];
  var CONSONANT = { 0: 1, 3: 1, 4: 1, 5: 1, 7: 1, 8: 1, 9: 1 };

  // 虚音表（实验性）：目标音级 -> [键索引 a, 键索引 b, 音分误差, 说明]
  // 详见 core.py 的注释 —— 差音在物理上会被基音掩蔽，听感通常是「按错的两个音」。
  var VIRTUAL_NOTE_TABLE = {
    1: [11, 14, 5.5, '差音 B4+C6 -> C#5'],
    3: [5, 12, 6.1, '差音 F4+E5 -> D#4'],
    6: [4, 9, 5.5, '差音 E4+F5 -> F#4'],
    8: null,
    10: [0, 11, 6.1, '差音 C4+B4 -> A#3']
  };

  function virtualPairFor(pitchClass) {
    var v = VIRTUAL_NOTE_TABLE[pyMod(pitchClass, 12)];
    return v === undefined ? null : v;
  }

  var BEAT_SUBDIVISION = 16;

  // ============================================================ 数学工具

  // Python 的 round() 是「四舍六入五成双」，JS 的 Math.round() 是「四舍五入」。
  // 本算法里 round(pos * cell) 真的会撞上 .5：
  //   cell=500、pos=2/16 -> 62.5 -> Python 给 62，JS 给 63。
  // 差 1 毫秒就会让 gcd 塌成 1，SkyStudio 直接判谱面无效。
  function pyRound(x) {
    if (!isFinite(x)) return x;
    var f = Math.floor(x);
    var d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  // Python 的 % 对负数返回非负结果，JS 的 % 返回负数。
  function pyMod(a, b) {
    var r = a % b;
    return r < 0 ? r + b : r;
  }

  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  // Python 的 round(x, 9)，只用于 pickTranspose 的比较。
  // 相邻候选的差异 >= 1/total >= 7.6e-4，远大于 1e-9，所以这里不必精确到 ulp。
  function roundTo9(x) { return pyRound(x * 1e9) / 1e9; }

  // 60000 的因数里适合当 bpm 的那些（保证 60000/bpm 是整数毫秒）
  var _BPM_DIVISORS = (function () {
    var out = [];
    for (var b = 30; b <= 400; b++) if (60000 % b === 0) out.push(b);
    return out;
  })();

  // ============================================================ 15 键

  function buildKeys(root, count) {
    if (root === undefined || root === null) root = 60;
    if (count === undefined || count === null) count = 15;
    var keys = [];
    var octave = 0;
    var i = 0;
    while (keys.length < count) {
      keys.push(root + octave * 12 + MAJOR_STEPS[pyMod(i, 7)]);
      i += 1;
      if (i % 7 === 0) octave += 1;
    }
    return keys;
  }

  function keyId(index, layer) {
    if (layer === undefined || layer === null) layer = 1;
    return layer + 'Key' + index;
  }

  // ============================================================ 字节工具

  function readU32(b, p) {
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  }

  function readVarlen(b, pos, end) {
    var val = 0;
    while (true) {
      if (pos >= end) return { value: val, pos: pos };
      var byte = b[pos];
      pos += 1;
      val = val * 128 + (byte & 0x7F);
      if (!(byte & 0x80)) return { value: val, pos: pos };
    }
  }

  function writeVarlen(v) {
    var out = [v & 0x7F];
    v = Math.floor(v / 128);
    while (v > 0) {
      out.unshift(0x80 | (v & 0x7F));
      v = Math.floor(v / 128);
    }
    return out;
  }

  function pushBytes(arr, bytes) {
    for (var i = 0; i < bytes.length; i++) arr.push(bytes[i]);
  }

  function toU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes && bytes.buffer) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new Uint8Array(bytes);
  }

  // ============================================================ MIDI 读取

  function readMidi(input) {
    var bytes = toU8(input);
    if (bytes.length < 14 ||
        bytes[0] !== 0x4D || bytes[1] !== 0x54 || bytes[2] !== 0x68 || bytes[3] !== 0x64) {
      throw new Error('不是标准 MIDI 文件（缺少 MThd 头）');
    }
    var hdrLen = readU32(bytes, 4);
    var ntrk = (bytes[10] << 8) | bytes[11];
    var division = (bytes[12] << 8) | bytes[13];
    if (division & 0x8000) throw new Error('不支持 SMPTE 时间格式');

    var m = { notes: [], ppq: division, tempos: [], drums: 0, ntracks: ntrk };
    var pos = 8 + hdrLen;

    for (var trkI = 0; trkI < ntrk; trkI++) {
      if (pos + 8 > bytes.length) break;
      if (bytes[pos] !== 0x4D || bytes[pos + 1] !== 0x54 ||
          bytes[pos + 2] !== 0x72 || bytes[pos + 3] !== 0x6B) break;
      var ln = readU32(bytes, pos + 4);
      var trkStart = pos + 8;
      var trkEnd = Math.min(trkStart + ln, bytes.length);
      pos = trkStart + ln;

      var i = trkStart;
      var tick = 0;
      var status = null;
      var active = new Map();   // ch*128+pitch -> {tick, vel}，Map 保持插入顺序

      while (i < trkEnd) {
        var r = readVarlen(bytes, i, trkEnd);
        tick += r.value;
        i = r.pos;
        if (i >= trkEnd) break;
        var b0 = bytes[i];
        if (b0 & 0x80) { status = b0; i += 1; }
        else if (status === null) { i += 1; continue; }

        if (status === 0xFF) {
          var mtype = bytes[i];
          i += 1;
          var lr = readVarlen(bytes, i, trkEnd);
          var ln2 = lr.value;
          i = lr.pos;
          var payload = i;
          i += ln2;
          if (mtype === 0x51 && ln2 === 3) {
            m.tempos.push([tick, (bytes[payload] << 16) | (bytes[payload + 1] << 8) | bytes[payload + 2]]);
          }
          status = null;
          continue;
        }

        if (status === 0xF0 || status === 0xF7) {
          var lr2 = readVarlen(bytes, i, trkEnd);
          i = lr2.pos + lr2.value;
          status = null;
          continue;
        }

        var hi = status & 0xF0;
        var ch = status & 0x0F;
        if (hi === 0xC0 || hi === 0xD0) { i += 1; continue; }
        if (i + 1 >= trkEnd) break;
        var d1 = bytes[i], d2 = bytes[i + 1];
        i += 2;

        if (ch === 9) {
          if (hi === 0x90 && d2 > 0) m.drums += 1;
          continue;
        }

        var key2 = ch * 128 + d1;
        if (hi === 0x90 && d2 > 0) {
          active.set(key2, { tick: tick, vel: d2 });
        } else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
          if (active.has(key2)) {
            var a = active.get(key2);
            active.delete(key2);
            m.notes.push({
              start: a.tick,
              dur: Math.max(tick - a.tick, 1),
              pitch: d1, vel: a.vel, ch: ch, track: trkI
            });
          }
        }
      }

      var tailDur = Math.max(Math.floor(division / 4), 1);
      active.forEach(function (a, key3) {
        m.notes.push({
          start: a.tick, dur: tailDur,
          pitch: pyMod(key3, 128), vel: a.vel,
          ch: Math.floor(key3 / 128), track: trkI
        });
      });
    }

    m.notes.sort(function (a, b) { return (a.start - b.start) || (a.pitch - b.pitch); });
    return m;
  }

  // ============================================================ tick -> 毫秒

  function TempoMap(ppq, tempos) {
    this.ppq = ppq;
    var tps;
    if (tempos && tempos.length) {
      tps = tempos.slice().sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    } else {
      tps = [[0, 500000]];
    }
    if (tps[0][0] !== 0) tps.unshift([0, 500000]);

    var segs = [];
    var prevTick = 0;
    var prevUs = tps[0][1];
    var ms = 0.0;
    segs.push([0, 0.0, prevUs]);
    for (var i = 1; i < tps.length; i++) {
      var tk = tps[i][0], us = tps[i][1];
      ms += (tk - prevTick) * prevUs / ppq / 1000.0;
      segs.push([tk, ms, us]);
      prevTick = tk;
      prevUs = us;
    }
    this.segs = segs;
  }

  TempoMap.prototype.toMs = function (tick) {
    var cur = this.segs[0];
    for (var i = 0; i < this.segs.length; i++) {
      var s = this.segs[i];
      if (s[0] <= tick) cur = s; else break;
    }
    return cur[1] + (tick - cur[0]) * cur[2] / this.ppq / 1000.0;
  };

  TempoMap.prototype.msPerBeat = function () {
    return this.segs[0][2] / 1000.0;
  };

  TempoMap.prototype.bpm = function () {
    return pyRound(60000000.0 / this.segs[0][2]);
  };

  // ============================================================ 音高映射

  function fold(p, lo, hi) {
    while (p < lo) p += 12;
    while (p > hi) p -= 12;
    return p;
  }

  function pickTranspose(weighted, keyPcs, lo, hi) {
    if (!weighted || !weighted.length) return 0;
    var total = 0;
    var i;
    for (i = 0; i < weighted.length; i++) total += weighted[i][1];
    if (total === 0) total = 1.0;

    var white = {};
    for (var k in keyPcs) if (Object.prototype.hasOwnProperty.call(keyPcs, k)) white[k] = true;
    var scale = { 0: 1, 2: 1, 4: 1, 5: 1, 7: 1, 9: 1, 11: 1 };
    for (i = 0; i < 12; i++) {
      var q = pyMod(lo + i, 12);
      if (scale[q]) white[q] = true;
    }

    var bestKey = null;
    var bestT = 0;
    for (var t = -18; t <= 18; t++) {
      var octaveErr = 0.0;
      var pitchErr = 0.0;
      for (i = 0; i < weighted.length; i++) {
        var p = weighted[i][0], w = weighted[i][1];
        var qq = p + t;
        if (qq < lo || qq > hi) octaveErr += w;
        else if (!white[pyMod(qq, 12)]) pitchErr += w;
      }
      var key = (octaveErr + pitchErr) / total;
      var c0 = roundTo9(key);
      var c1 = Math.abs(t);
      if (bestKey === null || c0 < bestKey[0] || (c0 === bestKey[0] && c1 < bestKey[1])) {
        bestKey = [c0, c1];
        bestT = t;
      }
    }
    return bestT;
  }

  function pickSnapDirections(melody, keys) {
    var white = {};
    var i;
    for (i = 0; i < keys.length; i++) white[pyMod(keys[i], 12)] = true;
    var black = [];
    for (var pc = 0; pc < 12; pc++) if (!white[pc]) black.push(pc);
    if (!black.length || !melody || !melody.length || keys.length < 2) return {};

    var lo = keys[0], hi = keys[keys.length - 1];

    function snapWith(p, up) {
      var q = p;
      while (q < lo) q += 12;
      while (q > hi) q -= 12;
      if (white[pyMod(q, 12)]) return q;
      var c = q + (up ? 1 : -1);
      if (white[pyMod(c, 12)]) return c;
      c = q + (up ? 2 : -2);
      return white[pyMod(c, 12)] ? c : q;
    }

    function contourOf(seq) {
      var r = [];
      for (var j = 0; j + 1 < seq.length; j++) {
        var d = pyMod(seq[j + 1] - seq[j], 12);
        if (d > 6) d -= 12;
        r.push(d);
      }
      return r;
    }

    var srcContour = contourOf(melody);

    function fit(choice) {
      var o = [];
      for (var j = 0; j < melody.length; j++) {
        var m = pyMod(melody[j], 12);
        var up = Object.prototype.hasOwnProperty.call(choice, m) ? choice[m] : true;
        o.push(snapWith(melody[j], up));
      }
      var b = contourOf(o);
      var n = Math.min(srcContour.length, b.length);
      var s = 0;
      for (j = 0; j < n; j++) if (srcContour[j] === b[j]) s += 1;
      return s;
    }

    var bestFit = -1;
    var bestChoice = {};
    for (i = 0; i < black.length; i++) bestChoice[black[i]] = true;

    var totalMasks = 1 << black.length;
    for (var mask = 0; mask < totalMasks; mask++) {
      var choice = {};
      for (var bi = 0; bi < black.length; bi++) choice[black[bi]] = !!((mask >> bi) & 1);
      var f = fit(choice);
      if (f > bestFit) { bestFit = f; bestChoice = choice; }
    }
    return bestChoice;
  }

  function snap(p, keys, preferUp, bassPc) {
    var above = [], below = [];
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] > p) above.push(keys[i]);
      else if (keys[i] < p) below.push(keys[i]);
    }
    var cands = [];
    if (above.length) cands.push(above[0]);
    if (below.length) cands.push(below[below.length - 1]);
    if (!cands.length) return keys[0];

    function rank(k) {
      var d = Math.abs(k - p);
      var wrongSide = ((k > p) === !!preferUp) ? 0 : 1;
      var cons = 0;
      if (bassPc !== null && bassPc !== undefined) {
        cons = CONSONANT[pyMod(k - bassPc, 12)] ? 0 : 1;
      }
      return [wrongSide, cons, d];
    }

    var best = null;
    var bestK = cands[0];
    for (i = 0; i < cands.length; i++) {
      var r = rank(cands[i]);
      if (best === null || r[0] < best[0] ||
          (r[0] === best[0] && (r[1] < best[1] || (r[1] === best[1] && r[2] < best[2])))) {
        best = r;
        bestK = cands[i];
      }
    }
    return bestK;
  }

  // ============================================================ 节拍网格

  function beatUnitMs(bpm) {
    if (!(bpm > 0)) bpm = 120.0;
    return Math.max(1, pyRound(60000.0 / bpm));
  }

  function gridSafeBpm(bpm, maxRelErr) {
    if (maxRelErr === undefined) maxRelErr = 0.03;
    if (!(bpm > 0)) return 120.0;
    var cell = 60000.0 / bpm;
    if (Math.abs(cell - pyRound(cell)) < 1e-6) return pyRound(bpm) * 1.0;

    var best = null;
    var i, cand, rel;
    for (i = 0; i < _BPM_DIVISORS.length; i++) {
      cand = _BPM_DIVISORS[i];
      rel = Math.abs(cand - bpm) / bpm;
      if (rel > maxRelErr) continue;
      if (best === null || rel < best.rel) best = { rel: rel, cand: cand };
    }
    var limits = [0.03, 0.06, 0.10, 0.20, 0.50, 1.00];
    for (var li = 0; li < limits.length; li++) {
      var limit = limits[li];
      for (i = 0; i < _BPM_DIVISORS.length; i++) {
        cand = _BPM_DIVISORS[i];
        rel = Math.abs(cand - bpm) / bpm;
        if (rel > limit) continue;
        if (best === null || rel < best.rel) best = { rel: rel, cand: cand };
      }
      if (best !== null) break;
    }
    return best ? best.cand * 1.0 : pyRound(bpm) * 1.0;
  }

  function snapBeatPosition(pos, subdivision) {
    if (subdivision === undefined || subdivision === null) subdivision = BEAT_SUBDIVISION;
    if (subdivision <= 0) return pos;
    return pyRound(pos * subdivision) / subdivision;
  }

  function beatToMs(pos, bpm) {
    return pyRound(pos * beatUnitMs(bpm));
  }

  function uniqSortedInts(values) {
    var seen = {};
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var v = Math.trunc(values[i]);
      if (!seen[v]) { seen[v] = true; out.push(v); }
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function gridCompatible(msValues, bpm) {
    if (!msValues || !msValues.length || !(bpm > 0)) return false;
    var cell = 60000.0 / bpm;
    if (Math.abs(cell - pyRound(cell)) > 1e-6) return false;
    var cellI = pyRound(cell);

    var ts = uniqSortedInts(msValues);
    if (ts.length < 2) return true;

    var deltas = [];
    var i;
    for (i = 0; i + 1 < ts.length; i++) if (ts[i + 1] > ts[i]) deltas.push(ts[i + 1] - ts[i]);
    if (!deltas.length) return true;

    var gAll = 0;
    for (i = 0; i < deltas.length; i++) gAll = gcd(gAll, deltas[i]);
    if (gAll <= 0) return false;
    for (i = 0; i < ts.length; i++) if (pyMod(ts[i], gAll) !== 0) return false;

    var ratio = cellI / gAll;
    var lr = ratio > 0 ? Math.log2(ratio) : 0.0;
    return Math.abs(lr - pyRound(lr)) < 0.05;
  }

  // ============================================================ 参数

  var DEFAULTS = {
    name: null,
    author: null,
    arranged: null,
    transcribed: null,
    bpm: null,
    bitsPerPage: 16,
    pitchLevel: 0,
    virtualNotes: false,
    encoding: 'utf-16',
    root: 60,
    transpose: 'auto',
    grid: 0.25,
    maxPoly: 0,
    ppq: 480,
    noteLen: 0.25,
    fileName: null
  };

  function normalizeOpts(o) {
    var r = {};
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) r[k] = DEFAULTS[k];
    if (o) {
      for (var k2 in o) {
        if (Object.prototype.hasOwnProperty.call(o, k2) && o[k2] !== undefined) r[k2] = o[k2];
      }
    }
    if (r.bitsPerPage === null || r.bitsPerPage === undefined) r.bitsPerPage = 16;
    if (r.pitchLevel === null || r.pitchLevel === undefined) r.pitchLevel = 0;
    if (r.root === null || r.root === undefined) r.root = 60;
    if (r.ppq === null || r.ppq === undefined) r.ppq = 480;
    if (r.noteLen === null || r.noteLen === undefined) r.noteLen = 0.25;
    return r;
  }

  function baseNoExt(p) {
    if (!p) return 'output';
    var s = String(p).replace(/^.*[\\/]/, '');
    var dot = s.lastIndexOf('.');
    return dot > 0 ? s.slice(0, dot) : s;
  }

  // ============================================================ MIDI -> 光遇

  function midiToSky(midi, opts) {
    opts = normalizeOpts(opts);
    var ppq = midi.ppq;
    var tmap = new TempoMap(ppq, midi.tempos);
    var keys = buildKeys(opts.root, 15);
    var lo = keys[0], hi = keys[keys.length - 1];
    var keyPcs = {};
    var i, j;
    for (i = 0; i < keys.length; i++) keyPcs[pyMod(keys[i], 12)] = true;
    var gridBeats = (opts.grid && opts.grid > 0) ? opts.grid : 0.0;

    var notes = [];
    for (i = 0; i < midi.notes.length; i++) if (midi.notes[i].dur >= 1) notes.push(midi.notes[i]);
    if (!notes.length) return { notes: [], info: { error: '没有可用音符' } };

    // ---- 标记主旋律：每个起始点的最高音 ----
    var byOnset = new Map();
    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (!byOnset.has(n.start)) byOnset.set(n.start, []);
      byOnset.get(n.start).push(n.pitch);
    }

    // 同一位置同音高有多个音符时只取第一个（与 Python 的 first_at 一致）
    var firstAt = new Map();
    for (i = 0; i < notes.length; i++) {
      n = notes[i];
      var fk = n.start + ':' + n.pitch;
      if (!firstAt.has(fk)) firstAt.set(fk, n);
    }

    var melodyNoteIds = new Set();
    byOnset.forEach(function (pitches, startTick) {
      var mx = pitches[0];
      for (var q = 1; q < pitches.length; q++) if (pitches[q] > mx) mx = pitches[q];
      var nn = firstAt.get(startTick + ':' + mx);
      if (nn) melodyNoteIds.add(nn);
    });

    var onsetKeys = [];
    byOnset.forEach(function (v, k) { onsetKeys.push(k); });
    onsetKeys.sort(function (a, b) { return a - b; });
    var melody = [];
    for (i = 0; i < onsetKeys.length; i++) {
      var ps = byOnset.get(onsetKeys[i]);
      var mx2 = ps[0];
      for (j = 1; j < ps.length; j++) if (ps[j] > mx2) mx2 = ps[j];
      melody.push(mx2);
    }

    // ---- 移调 ----
    var transpose;
    if (opts.transpose === 'none') {
      transpose = 0;
    } else {
      var beatLen = ppq / 4.0;
      var weighted = [];
      for (i = 0; i < melody.length; i++) weighted.push([melody[i], 1.0]);
      if (!weighted.length) {
        for (i = 0; i < notes.length; i++) {
          weighted.push([notes[i].pitch, Math.pow(notes[i].dur / beatLen, 0.5)]);
        }
      }
      transpose = pickTranspose(weighted, keyPcs, lo, hi);
    }

    // ---- 旋律走向 ----
    var ordered = notes.slice().sort(function (a, b) {
      return (a.start - b.start) || (a.pitch - b.pitch);
    });
    var nxt = new Map();
    var prv = new Map();
    for (i = 0; i < ordered.length; i++) {
      if (i + 1 < ordered.length) nxt.set(ordered[i], ordered[i + 1].pitch);
      if (i > 0) prv.set(ordered[i], ordered[i - 1].pitch);
    }

    // ---- 按拍位置分桶（不是毫秒！）----
    var buckets = new Map();
    for (i = 0; i < notes.length; i++) {
      n = notes[i];
      var beat = n.start / ppq;
      if (gridBeats > 0) beat = pyRound(beat / gridBeats) * gridBeats;
      beat = snapBeatPosition(beat, BEAT_SUBDIVISION);
      if (!buckets.has(beat)) buckets.set(beat, []);
      buckets.get(beat).push(n);
    }

    var out = [];
    var stat = { exact: 0, octave: 0, snapped: 0, merged: 0, dropped: 0 };
    var melodyKept = 0;

    var bpmRaw = (opts.bpm || tmap.bpm()) * 1.0;
    var bpmNow = gridSafeBpm(bpmRaw);

    // ---- 求最细音符，据此定 cell ----
    var tickG = 0;
    buckets.forEach(function (v, p) {
      tickG = gcd(tickG, Math.abs(pyRound(p * BEAT_SUBDIVISION)));
    });
    if (tickG <= 0) tickG = BEAT_SUBDIVISION;
    tickG = Math.min(tickG, BEAT_SUBDIVISION);
    var finestBeats = tickG / BEAT_SUBDIVISION;

    var oldCell = 60000.0 / bpmRaw;
    var finestMs = Math.max(1.0, finestBeats * oldCell);
    var cellMs = Math.max(1, pyRound(finestMs));
    if (cellMs > 1 && Math.abs(cellMs - finestMs) > 0.4) cellMs = Math.max(1, pyRound(finestMs));

    bpmNow = 60000.0 / cellMs;
    var unitMs = cellMs;
    var timeUnitBeats = 1.0;

    // ---- 统一黑键吸附方向 ----
    var melShifted = [];
    for (i = 0; i < melody.length; i++) melShifted.push(melody[i] + transpose);
    var snapDirs = pickSnapDirections(melShifted, keys);

    function salience(it, hiP, loP) {
      return it[0].vel + (it[1] === hiP ? 1000 : 0) + (it[1] === loP ? 900 : 0);
    }

    var bucketKeys = [];
    buckets.forEach(function (v, k) { bucketKeys.push(k); });
    bucketKeys.sort(function (a, b) { return a - b; });

    for (var bk = 0; bk < bucketKeys.length; bk++) {
      var beatPos = bucketKeys[bk];
      var grp = buckets.get(beatPos);
      var raw = [];

      for (i = 0; i < grp.length; i++) {
        n = grp[i];
        var q = n.pitch + transpose;
        var folded = fold(q, lo, hi);
        var isScale = !!keyPcs[pyMod(folded, 12)];
        var np = nxt.has(n) ? nxt.get(n) : null;
        var pp = prv.has(n) ? prv.get(n) : null;
        var preferUp;
        if (np !== null && np !== undefined && np !== n.pitch) preferUp = np > n.pitch;
        else if (pp !== null && pp !== undefined && pp !== n.pitch) preferUp = n.pitch > pp;
        else preferUp = true;
        raw.push([n, q, folded, isScale, preferUp, melodyNoteIds.has(n)]);
      }

      var bassPc = null;
      if (raw.length) {
        var minFold = raw[0][2];
        for (i = 1; i < raw.length; i++) if (raw[i][2] < minFold) minFold = raw[i][2];
        bassPc = pyMod(minFold, 12);
      }

      var picked = [];
      for (i = 0; i < raw.length; i++) {
        var it = raw[i];
        var kk, how;
        if (it[3]) {
          kk = it[2];
          how = (it[1] !== it[2]) ? 'octave' : 'exact';
        } else {
          var mp = pyMod(it[2], 12);
          var dirUp = Object.prototype.hasOwnProperty.call(snapDirs, mp) ? snapDirs[mp] : it[4];
          kk = snap(it[2], keys, dirUp, bassPc);
          how = 'snapped';
        }
        picked.push([it[0], kk, how, it[1], it[5]]);
      }

      // ---- 复音限制：主旋律优先保留 ----
      if (opts.maxPoly && picked.length > opts.maxPoly) {
        var melodyPicks = [], accompPicks = [];
        for (i = 0; i < picked.length; i++) {
          if (picked[i][4]) melodyPicks.push(picked[i]); else accompPicks.push(picked[i]);
        }
        var kept = melodyPicks.slice();
        var remaining = opts.maxPoly - kept.length;
        if (remaining > 0 && accompPicks.length) {
          var hiP = accompPicks[0][1], loP = accompPicks[0][1];
          for (i = 1; i < accompPicks.length; i++) {
            if (accompPicks[i][1] > hiP) hiP = accompPicks[i][1];
            if (accompPicks[i][1] < loP) loP = accompPicks[i][1];
          }
          var accompSorted = accompPicks.slice().sort(function (a, b) {
            return salience(b, hiP, loP) - salience(a, hiP, loP);
          });
          for (i = 0; i < remaining && i < accompSorted.length; i++) kept.push(accompSorted[i]);
          stat.dropped += accompPicks.length - remaining;
        } else {
          stat.dropped += accompPicks.length;
        }
        picked = kept.slice().sort(function (a, b) { return a[1] - b[1]; });
      }

      // ---- 同键合并：主旋律优先 ----
      var seen = new Map();
      for (i = 0; i < picked.length; i++) {
        var pk = picked[i];
        if (seen.has(pk[1])) {
          stat.merged += 1;
          var oldv = seen.get(pk[1]);
          if (pk[4] || (!oldv[2] && pk[0].vel > oldv[0].vel)) {
            seen.set(pk[1], [pk[0], pk[2], pk[4]]);
          }
        } else {
          seen.set(pk[1], [pk[0], pk[2], pk[4]]);
        }
      }

      var wallMs = beatPos * oldCell;
      var ms = pyRound(wallMs / unitMs) * unitMs;
      if (ms < 0) ms = 0;

      // ---- 虚音（实验性）----
      var virtualExtra = {};
      if (opts.virtualNotes) {
        for (i = 0; i < picked.length; i++) {
          var pv = picked[i];
          if (pv[2] !== 'snapped') continue;
          var pair = virtualPairFor(pyMod(pv[3], 12));
          if (pair === null) continue;
          virtualExtra[pair[0]] = Math.max(virtualExtra[pair[0]] || 0, 1);
          virtualExtra[pair[1]] = Math.max(virtualExtra[pair[1]] || 0, 1);
          stat.virtual = (stat.virtual || 0) + 1;
        }
      }

      var seenKeys = [];
      seen.forEach(function (v, k) { seenKeys.push(k); });
      seenKeys.sort(function (a, b) { return a - b; });
      for (i = 0; i < seenKeys.length; i++) {
        var kIdx = seenKeys[i];
        var sv = seen.get(kIdx);
        stat[sv[1]] += 1;
        if (sv[2]) melodyKept += 1;
        out.push({
          time: ms,
          key: keys.indexOf(kIdx),
          layer: 1,
          srcPitch: kIdx - transpose,
          how: sv[1]
        });
      }

      var veKeys = Object.keys(virtualExtra).map(Number).sort(function (a, b) { return a - b; });
      for (i = 0; i < veKeys.length; i++) {
        if (seen.has(veKeys[i])) continue;
        out.push({ time: ms, key: veKeys[i], layer: 1, srcPitch: 0, how: 'virtual' });
      }
    }

    out.sort(function (a, b) { return (a.time - b.time) || (a.key - b.key); });

    // ---- 后验校准：数出实际 gcd，反推 bpm ----
    if (out.length) {
      var times = uniqSortedInts(out.map(function (s) { return s.time; }));
      if (times.length >= 2) {
        var gOut = 0;
        for (i = 0; i + 1 < times.length; i++) gOut = gcd(gOut, times[i + 1] - times[i]);
        if (gOut > 0 && gOut !== unitMs) {
          unitMs = gOut;
          cellMs = gOut;
          bpmNow = 60000.0 / cellMs;
          timeUnitBeats = 1.0;
        }
      }
    }

    var melodyTotal = melodyNoteIds.size;
    var info = {
      transpose: transpose,
      bpm: bpmNow,
      timeUnitBeats: timeUnitBeats,
      unitMs: unitMs,
      range: [lo, hi],
      stat: stat,
      drums: midi.drums,
      src: notes.length,
      playability: 100.0 * (1.0 - stat.snapped / Math.max(1, notes.length)),
      melody: {
        total: melodyTotal,
        kept: melodyKept,
        rate: 100.0 * melodyKept / Math.max(1, melodyTotal)
      },
      pitchLevel: opts.pitchLevel,
      gridOk: gridCompatible(out.map(function (s) { return s.time; }), bpmNow)
    };

    return { notes: out, info: info };
  }

  // ============================================================ 写谱面

  // Python 的 json.dumps(300.0) 输出 "300.0"，JS 的 JSON.stringify(300) 输出 "300"。
  // SkyStudio 读 bpm 时做的是数值解析，两者都能读；但我们要逐字节一致，
  // 而且带小数点更符合「这是浮点数」的语义。
  function pyFloatStr(v) {
    v = Number(v);
    if (!isFinite(v)) return '0.0';
    if (Number.isInteger(v) && Math.abs(v) < 1e16) return v.toFixed(1);
    var s = String(v);
    if (s.indexOf('.') < 0 && s.indexOf('e') < 0 && s.indexOf('E') < 0) s += '.0';
    return s;
  }

  function utf16le(s) {
    var out = new Uint8Array(2 + s.length * 2);
    out[0] = 0xFF;
    out[1] = 0xFE;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out[2 + i * 2] = c & 0xFF;
      out[3 + i * 2] = (c >> 8) & 0xFF;
    }
    return out;
  }

  function utf8Bytes(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return new Uint8Array(out);
  }

  function utf8Sig(s) {
    var body = utf8Bytes(s);
    var out = new Uint8Array(body.length + 3);
    out[0] = 0xEF; out[1] = 0xBB; out[2] = 0xBF;
    out.set(body, 3);
    return out;
  }

  function writeSky(notes, opts, info) {
    opts = normalizeOpts(opts);
    var parts = [];
    for (var i = 0; i < notes.length; i++) {
      var s = notes[i];
      parts.push('{"time":' + Math.trunc(s.time) +
                 ',"key":' + JSON.stringify(keyId(s.key, s.layer || 1)) + '}');
    }

    var bpmOut = (info && info.bpm !== undefined && info.bpm !== null)
      ? Number(info.bpm)
      : Number(opts.bpm || 300);

    var name = opts.name ? String(opts.name) : baseNoExt(opts.fileName);

    // 键顺序必须与 core.py 的 meta 完全一致，否则字节不同。
    var meta = '{'
      + '"name":' + JSON.stringify(name) + ','
      + '"author":' + JSON.stringify(opts.author ? String(opts.author) : '') + ','
      + '"arrangedBy":' + JSON.stringify(opts.arranged ? String(opts.arranged) : '') + ','
      + '"transcribedBy":' + JSON.stringify(opts.transcribed ? String(opts.transcribed) : 'MuScriptor') + ','
      + '"permission":"",'
      + '"isComposed":true,'
      + '"bpm":' + pyFloatStr(bpmOut) + ','
      + '"bitsPerPage":' + Math.trunc(opts.bitsPerPage) + ','
      + '"pitchLevel":' + Math.trunc(opts.pitchLevel) + ','
      + '"isEncrypted":false,'
      + '"songNotes":[' + parts.join(',') + ']'
      + '}';

    var text = '[' + meta + ']';
    var enc = String(opts.encoding || 'utf-16').toLowerCase();
    var bytes;
    if (enc === 'utf-16' || enc === 'utf16' || enc === 'unicode') bytes = utf16le(text);
    else if (enc === 'utf-8-sig' || enc === 'utf8-sig') bytes = utf8Sig(text);
    else bytes = utf8Bytes(text);

    return { bytes: bytes, text: text };
  }

  // ============================================================ 读谱面（反向）

  function decodeText(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try {
        return new TextDecoder('gb18030').decode(bytes);
      } catch (e2) {
        return new TextDecoder('utf-8').decode(bytes);
      }
    }
  }

  var SKYR_KEY_RE = /^(?:[0-9])?Key([0-9]+)$/;

  function readSky(input) {
    var bytes = toU8(input);
    var text = decodeText(bytes);
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('无法解析该琴谱文件（编码或 JSON 格式不支持）');
    }
    if (!data || typeof data !== 'object') throw new Error('无法解析该琴谱文件（编码或 JSON 格式不支持）');
    if (!Array.isArray(data)) data = [data];

    var songs = [];
    for (var i = 0; i < data.length; i++) {
      var s = data[i] || {};
      var rec = {
        name: s.name || '',
        author: s.author || '',
        bpm: Math.trunc(s.bpm === undefined ? 300 : s.bpm),
        bitsPerPage: s.bitsPerPage === undefined ? 16 : s.bitsPerPage,
        pitchLevel: s.pitchLevel === undefined ? 0 : s.pitchLevel,
        notes: []
      };
      var sn = s.songNotes || [];
      for (var j = 0; j < sn.length; j++) {
        var k = String(sn[j].key);
        var mm = SKYR_KEY_RE.exec(k);
        var idx = mm ? parseInt(mm[1], 10) : parseInt(k, 10);
        rec.notes.push([Math.trunc(sn[j].time), 1, idx]);
      }
      rec.notes.sort(function (a, b) {
        return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
      });
      songs.push(rec);
    }
    return songs;
  }

  function writeMidiFile(events, ppq, program, tempoUs) {
    if (program === undefined || program === null) program = 0;
    if (tempoUs === undefined || tempoUs === null) tempoUs = 500000;

    var ev = events.slice().sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]); });
    var track = [];
    pushBytes(track, writeVarlen(0));
    pushBytes(track, [0xFF, 0x51, 0x03,
                      (tempoUs >> 16) & 0xFF, (tempoUs >> 8) & 0xFF, tempoUs & 0xFF]);
    pushBytes(track, writeVarlen(0));
    pushBytes(track, [0xC0, program & 0x7F]);

    var last = 0;
    for (var i = 0; i < ev.length; i++) {
      var tick = ev[i][0], status = ev[i][1], d1 = ev[i][2], d2 = ev[i][3];
      if (tick < last) tick = last;
      pushBytes(track, writeVarlen(tick - last));
      pushBytes(track, [status, d1 & 0x7F, d2 & 0x7F]);
      last = tick;
    }
    pushBytes(track, writeVarlen(0));
    pushBytes(track, [0xFF, 0x2F, 0x00]);

    var out = [];
    pushBytes(out, [0x4D, 0x54, 0x68, 0x64]);
    pushBytes(out, [0x00, 0x00, 0x00, 0x06]);
    pushBytes(out, [0x00, 0x00, 0x00, 0x01]);
    pushBytes(out, [(ppq >> 8) & 0xFF, ppq & 0xFF]);
    pushBytes(out, [0x4D, 0x54, 0x72, 0x6B]);
    var len = track.length;
    pushBytes(out, [(len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF]);
    pushBytes(out, track);
    return new Uint8Array(out);
  }

  function skyToMidi(songs, opts) {
    opts = normalizeOpts(opts);
    if (!songs || !songs.length) throw new Error('琴谱里没有任何曲目');
    var song = songs[0];
    var keys = buildKeys(opts.root, 15);
    var bpm = song.bpm || 300;
    var ppq = opts.ppq;
    var msPerBeat = 60000.0 / bpm;
    var ev = [];
    for (var i = 0; i < song.notes.length; i++) {
      var ms = song.notes[i][0], layer = song.notes[i][1], idx = song.notes[i][2];
      if (idx < 0 || idx >= keys.length) continue;
      var pitch = keys[idx];
      var tick = pyRound(ms / msPerBeat * ppq);
      var dur = Math.max(1, pyRound(ppq * opts.noteLen));
      var ch = layer === 1 ? 0 : 1;
      ev.push([tick, 0x90 | ch, pitch, 100]);
      ev.push([tick + dur, 0x80 | ch, pitch, 64]);
    }
    var tempoUs = pyRound(60000.0 / bpm * 1000.0);
    return writeMidiFile(ev, ppq, 0, tempoUs);
  }

  // ============================================================ 格式自检

  function skyrParse(input) {
    var bytes = toU8(input);
    var enc, text;
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      enc = 'UTF-16LE(BOM)';
      text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      enc = 'UTF-16BE(BOM)';
      text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
    } else if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      enc = 'UTF-8(BOM)';
      text = new TextDecoder('utf-8').decode(bytes.subarray(3));
    } else {
      enc = 'UTF-8';
      text = new TextDecoder('utf-8').decode(bytes);
    }

    var root;
    try {
      root = JSON.parse(text);
    } catch (e) {
      throw new Error('顶层必须是 JSON 数组');
    }
    if (!Array.isArray(root) || !root.length) throw new Error('顶层必须是 JSON 数组');
    var song = root[0];
    if (song.isEncrypted) throw new Error('乐谱被标记为加密，APP 会拒绝播放');
    var notes = song.songNotes;
    if (!notes || !notes.length || typeof notes[0] !== 'object') {
      throw new Error('songNotes 为空或格式不符');
    }

    var events = [];
    var first = notes[0];
    var ft = Math.trunc(first.time === undefined ? 0 : first.time);
    if (ft > 0) events.push([ft, []]);
    var m = SKYR_KEY_RE.exec(String(first.key));
    if (!m) throw new Error('无法识别按键: ' + first.key);
    events.push([0, [parseInt(m[1], 10)]]);

    var prevT = ft;
    for (var i = 1; i < notes.length; i++) {
      var cur = notes[i];
      var ct = Math.trunc(cur.time === undefined ? 0 : cur.time);
      var m2 = SKYR_KEY_RE.exec(String(cur.key));
      if (!m2) throw new Error('无法识别按键: ' + cur.key);
      var k = parseInt(m2[1], 10);
      if (ct === prevT) {
        events[events.length - 1][1].push(k);
      } else {
        events.push([Math.max(0, ct - prevT), [k]]);
      }
      prevT = ct;
    }

    var poly = 0;
    var used = {};
    var duration = 0;
    for (i = 0; i < events.length; i++) {
      if (events[i][1].length > poly) poly = events[i][1].length;
      duration += events[i][0];
      for (var j = 0; j < events[i][1].length; j++) used[events[i][1][j]] = true;
    }

    return {
      name: song.name || '',
      encoding: enc,
      noteCount: notes.length,
      eventCount: events.length,
      polyphony: poly,
      durationMs: duration,
      keysUsed: Object.keys(used).map(Number).sort(function (a, b) { return a - b; })
    };
  }

  // ============================================================ 简谱预览

  // Python 的 "%.2f" 用的是「对 double 的精确值做四舍六入五成双」。
  // 而 toFixed 是「五入」，0.125 -> toFixed(2) = "0.13"，Python 给 "0.12"。
  // 时间点都是整数毫秒除以 1000，第三位小数撞上 5 的概率不低，所以这里
  // 用 BigInt 做精确十进制展开，保证与 Python 逐字符一致。
  function exactDecimalParts(x) {
    var neg = x < 0;
    x = Math.abs(x);
    if (x === 0) return { neg: false, digits: BigInt(0), exp10: 0 };
    var dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    var hi = dv.getUint32(0), lo = dv.getUint32(4);
    var e = (hi >>> 20) & 0x7FF;
    var mant = (BigInt(hi & 0xFFFFF) << BigInt(32)) | BigInt(lo);
    var exp2;
    if (e === 0) {
      exp2 = -1074;
    } else {
      mant = mant | (BigInt(1) << BigInt(52));
      exp2 = e - 1075;
    }
    if (exp2 >= 0) {
      return { neg: neg, digits: mant << BigInt(exp2), exp10: 0 };
    }
    var k = -exp2;
    var p5 = BigInt(1);
    for (var i = 0; i < k; i++) p5 *= BigInt(5);
    return { neg: neg, digits: mant * p5, exp10: -k };
  }

  function pyFixed(x, digits) {
    if (!isFinite(x)) return String(x);
    var p = exactDecimalParts(x);
    var d = p.digits;
    var e = p.exp10 + digits;
    var q;
    if (e >= 0) {
      var mul = BigInt(1);
      for (var i = 0; i < e; i++) mul *= BigInt(10);
      q = d * mul;
    } else {
      var div = BigInt(1);
      for (var j = 0; j < -e; j++) div *= BigInt(10);
      var quo = d / div;
      var rem = d % div;
      var twice = rem * BigInt(2);
      if (twice > div) quo += BigInt(1);
      else if (twice === div) { if (quo % BigInt(2) !== BigInt(0)) quo += BigInt(1); }
      q = quo;
    }
    var s = q.toString();
    while (s.length <= digits) s = '0' + s;
    var ip = s.slice(0, s.length - digits);
    var fp = digits > 0 ? '.' + s.slice(s.length - digits) : '';
    return (p.neg ? '-' : '') + ip + fp;
  }

  function padLeft(s, w) { while (s.length < w) s = ' ' + s; return s; }
  function padRight(s, w) { while (s.length < w) s = s + ' '; return s; }

  function preview(notes) {
    if (!notes || !notes.length) return '（空）';
    var t0 = notes[0].time;
    var cur = null;
    var row = [];
    var outRows = [];

    function flush(r) {
      if (!r.length) return '';
      var t = (r[0].time - t0) / 1000.0;
      var names = [];
      for (var i = 0; i < r.length; i++) names.push(DEGREE_NAMES[r[i].key]);
      var nm = names.join(' ');
      if (r.length > 1) nm = '[' + nm + ']';
      return padLeft(pyFixed(t, 2), 6) + 's ' + padRight(nm, 4);
    }

    for (var i = 0; i < notes.length; i++) {
      var s = notes[i];
      if (cur === null || s.time !== cur) {
        if (row.length) outRows.push(flush(row));
        row = [s];
        cur = s.time;
      } else {
        row.push(s);
      }
    }
    if (row.length) outRows.push(flush(row));

    var lines = [];
    var buf = '';
    for (i = 0; i < outRows.length; i++) {
      var cell = outRows[i];
      if (buf.length + cell.length > 76) {
        lines.push(buf);
        buf = '';
      }
      buf += cell + '  ';
    }
    if (buf.trim()) lines.push(buf);
    return lines.join('\n');
  }

  // ============================================================ 一步到位

  function convert(input, opts) {
    opts = normalizeOpts(opts);
    var midi = readMidi(input);
    var r = midiToSky(midi, opts);
    if (!r.notes.length) {
      throw new Error((r.info && r.info.error) ? r.info.error : '没有可输出的音符');
    }
    var w = writeSky(r.notes, opts, r.info);
    return {
      bytes: w.bytes,
      text: w.text,
      notes: r.notes,
      info: r.info,
      fileName: baseNoExt(opts.fileName) + '.txt'
    };
  }

  return {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    MAJOR_STEPS: MAJOR_STEPS,
    DEGREE_NAMES: DEGREE_NAMES,
    BEAT_SUBDIVISION: BEAT_SUBDIVISION,
    buildKeys: buildKeys,
    keyId: keyId,
    readMidi: readMidi,
    midiToSky: midiToSky,
    writeSky: writeSky,
    convert: convert,
    readSky: readSky,
    skyToMidi: skyToMidi,
    writeMidiFile: writeMidiFile,
    skyrParse: skyrParse,
    preview: preview,
    gridCompatible: gridCompatible,
    gridSafeBpm: gridSafeBpm,
    beatUnitMs: beatUnitMs,
    pickTranspose: pickTranspose,
    pickSnapDirections: pickSnapDirections,
    snap: snap,
    fold: fold,
    pyRound: pyRound,
    pyMod: pyMod,
    pyFixed: pyFixed,
    pyFloatStr: pyFloatStr,
    utf16le: utf16le
  };
});
