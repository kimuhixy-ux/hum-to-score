// メトロノームと楽譜の再生音。
// iOS は放置すると AudioContext を止めてしまうので、使うたびに新しく作り、終わったら close する。

export function createAudioContext() {
  const ctx = new AudioContext();
  const bus = ctx.createGain();
  bus.gain.value = 0.6;
  // 音が重なったときの割れを防ぐ。
  const limiter = ctx.createDynamicsCompressor();
  bus.connect(limiter).connect(ctx.destination);
  return { ctx, bus };
}

export function scheduleClicks({ ctx, bus }, startTime, count, secPerBeat) {
  for (let i = 0; i < count; i++) {
    const t = startTime + i * secPerBeat;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = i % 4 === 0 ? 1600 : 1000;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    osc.connect(gain).connect(bus);
    osc.start(t);
    osc.stop(t + 0.05);
  }
}

// タイでつながった音符は1つの長い音として鳴らす。
function toSoundEvents(notes, transpose) {
  const events = [];
  for (const n of notes) {
    if (n.rest) continue;
    const start = n.barIndex * 4 + n.beatInBar;
    const last = events[events.length - 1];
    if (n.tied && last) {
      last.beats += n.duration;
    } else {
      events.push({ start, beats: n.duration, midi: n.midi - transpose });
    }
  }
  return events;
}

export function playNotes(audio, notes, { bpm, transpose }) {
  const { ctx, bus } = audio;
  const secPerBeat = 60 / bpm;
  const t0 = ctx.currentTime + 0.1;
  let endTime = t0;
  for (const e of toSoundEvents(notes, transpose)) {
    const start = t0 + e.start * secPerBeat;
    const end = start + e.beats * secPerBeat * 0.95;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 440 * 2 ** ((e.midi - 69) / 12);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.4, start + 0.015);
    gain.gain.setValueAtTime(0.4, end - 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(bus);
    osc.start(start);
    osc.stop(end + 0.01);
    endTime = end;
  }
  return endTime - ctx.currentTime;
}
