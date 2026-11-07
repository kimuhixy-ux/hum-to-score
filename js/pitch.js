// 録音した声から「いつ・どの高さの音が鳴ったか」を取り出す。
// 画面(DOM)に触れないので、Node でも単体で試せる。

// 声の基本周波数は1kHz以下なので、半分に間引いても高さの判定には足りる。計算量を約4分の1にするため。
const RATE_DIVISOR = 2;
const FRAME_SIZE = 1024;
const HOP_SIZE = 256;
const MIN_FREQ = 70;
const MAX_FREQ = 1100;
// YIN法のしきい値。小さいほど厳しく、息や子音を音程と誤認しにくい。
const YIN_THRESHOLD = 0.15;
// 一番大きい声の何割未満を「無音」とみなすか。マイク感度の端末差を吸収するため相対値にする。
const SILENCE_RATIO = 0.08;
const SILENCE_FLOOR = 0.003;
// 今の音から何半音以内なら同じ音の揺れとみなすか。ビブラートで音符が細切れになるのを防ぐ。
const HOLD_RANGE = 0.7;
// これより短い区間は、しゃくりや音の移り変わりの途中とみなして捨てる。
const MIN_SEGMENT_SEC = 0.05;
// 伸ばしている音の途中で、これ以内だけ別の高さを拾っても同じ音が続いているとみなす。
// 伴奏の漏れや判定ミスで、1つの長い音が細切れになるのを防ぐ。
const MAX_BLIP_SEC = 0.15;
// 1オクターブ以上離れた高さへ跳んですぐ戻ることは旋律ではまずないので、伴奏の漏れとみなしてもう少し長くても埋める。
const MAX_LEAP_BLIP_SEC = 0.25;
const LEAP = 12;

export function downsample(samples, factor) {
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += samples[i * factor + j];
    out[i] = sum / factor;
  }
  return out;
}

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function refineLag(values, tau) {
  if (tau <= 0 || tau >= values.length - 1) return tau;
  const a = values[tau - 1];
  const b = values[tau];
  const c = values[tau + 1];
  const denom = a - 2 * b + c;
  return denom === 0 ? tau : tau + (a - c) / (2 * denom);
}

// YIN法: 波形を少しずつずらして自分自身と比べ、一番よく重なるずれ幅＝周期を探す。
export function detectPitchYin(frame, sampleRate) {
  const half = frame.length / 2;
  const tauMin = Math.floor(sampleRate / MAX_FREQ);
  const tauMax = Math.min(half - 1, Math.ceil(sampleRate / MIN_FREQ));
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) {
      const d = frame[i] - frame[i + tau];
      sum += d * d;
    }
    running += sum;
    cmnd[tau] = running === 0 ? 1 : sum * tau / running;
  }
  for (let tau = Math.max(2, tauMin); tau <= tauMax; tau++) {
    if (cmnd[tau] >= YIN_THRESHOLD) continue;
    while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
    return sampleRate / refineLag(cmnd, tau);
  }
  return null;
}

export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

export function analyzeFrames(samples, sampleRate) {
  const data = downsample(samples, RATE_DIVISOR);
  const rate = sampleRate / RATE_DIVISOR;
  const frames = [];
  for (let start = 0; start + FRAME_SIZE <= data.length; start += HOP_SIZE) {
    const frame = data.subarray(start, start + FRAME_SIZE);
    frames.push({ frame, time: (start + FRAME_SIZE / 2) / rate, level: rms(frame) });
  }
  const loudest = frames.reduce((max, f) => Math.max(max, f.level), 0);
  const silence = Math.max(SILENCE_FLOOR, loudest * SILENCE_RATIO);
  return {
    hopSec: HOP_SIZE / rate,
    frames: frames.map(({ frame, time, level }) => {
      const freq = level < silence ? null : detectPitchYin(frame, rate);
      return { time, midi: freq ? freqToMidi(freq) : null, silent: level < silence };
    })
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// 1オクターブ下を拾うなどの一瞬の誤判定を、前後の値で打ち消す。
export function medianSmooth(frames) {
  return frames.map((f, i) => {
    if (f.midi === null) return f;
    const around = frames.slice(Math.max(0, i - 2), i + 3)
      .map((x) => x.midi)
      .filter((m) => m !== null);
    return { ...f, midi: median(around) };
  });
}

function isHolding(frame, anchor) {
  return frame.midi !== null && Math.abs(frame.midi - anchor) < HOLD_RANGE;
}

// 一瞬だけ別の高さを拾ってすぐ元に戻った箇所を、前後の音で埋める。
// 無音をはさむ場合は同じ音の吹き直し(連打)なので埋めない。
export function bridgeBlips(frames, hopSec) {
  const shortFrames = Math.round(MAX_BLIP_SEC / hopSec);
  const leapFrames = Math.round(MAX_LEAP_BLIP_SEC / hopSec);
  const out = frames.map((f) => ({ ...f }));
  for (let i = 1; i < out.length; i++) {
    const anchor = out[i - 1].midi;
    if (anchor === null || out[i].silent || isHolding(out[i], anchor)) continue;
    let j = i;
    while (j < out.length && j - i <= leapFrames && !out[j].silent && !isHolding(out[j], anchor)) j++;
    if (j >= out.length || j - i > leapFrames || !isHolding(out[j], anchor)) continue;
    const isLeap = out.slice(i, j).every((f) => f.midi === null || Math.abs(f.midi - anchor) >= LEAP);
    if (j - i <= shortFrames || isLeap) {
      for (let k = i; k < j; k++) out[k].midi = anchor;
    }
  }
  return out;
}

// 歌い手の音感が全体に少し高い/低いずれを推定する。
// 半音の端数を角度とみなして平均すると、-0.5と+0.5の境目でも正しく平均できる。
export function estimateTuningOffset(frames) {
  let x = 0;
  let y = 0;
  for (const f of frames) {
    if (f.midi === null) continue;
    x += Math.cos(2 * Math.PI * f.midi);
    y += Math.sin(2 * Math.PI * f.midi);
  }
  if (x === 0 && y === 0) return 0;
  return Math.atan2(y, x) / (2 * Math.PI);
}

export function segmentNotes(frames, offset, hopSec) {
  const segments = [];
  let current = null;
  for (const f of frames) {
    const value = f.midi === null ? null : f.midi - offset;
    if (current && value !== null && Math.abs(value - current.anchor) < HOLD_RANGE) {
      current.values.push(value);
      current.end = f.time + hopSec / 2;
      continue;
    }
    if (current) segments.push(current);
    current = value === null ? null
      : { anchor: Math.round(value), values: [value], start: f.time - hopSec / 2, end: f.time + hopSec / 2 };
  }
  if (current) segments.push(current);
  const notes = segments
    .map((s) => ({ midi: Math.round(median(s.values)), start: s.start, end: s.end }))
    .filter((n) => n.end - n.start >= MIN_SEGMENT_SEC);
  return mergeSamePitch(notes, hopSec);
}

// 判定が1フレームだけ途切れた同じ高さの音は、1つの音につなぎ直す。
function mergeSamePitch(notes, hopSec) {
  const merged = [];
  for (const note of notes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.midi === note.midi && note.start - prev.end <= hopSec * 1.5) {
      prev.end = note.end;
    } else {
      merged.push({ ...note });
    }
  }
  return merged;
}

export function extractNotes(samples, sampleRate) {
  const { frames, hopSec } = analyzeFrames(samples, sampleRate);
  const smoothed = bridgeBlips(medianSmooth(frames), hopSec);
  const offset = estimateTuningOffset(smoothed);
  return { notes: segmentNotes(smoothed, offset, hopSec), tuningOffset: offset };
}
