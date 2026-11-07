// 秒単位の音のならびを、拍にそろえた楽譜データ(サックスの記譜音)に直す。
// データの形は Daily251 の notes と同じ { barIndex, beatInBar, duration, letter, octave, accidental } にそろえる。

const BEATS_PER_BAR = 4;
// 8分音符単位にそろえる。鼻歌で16分を狙うと誤差のほうが大きくなるため。
const GRID = 0.5;
// 8分音符の長さの何割未満の音を捨てるか。音から音へ移るときのすべりを音符にしないため。
const MIN_NOTE_RATIO = 0.35;
const DURATIONS = [4, 3, 2, 1.5, 1, 0.5];
const LETTERS = 'CDEFGAB';
const SPELLING = [
  ['C', 0], ['C', 1], ['D', 0], ['E', -1], ['E', 0], ['F', 0],
  ['F', 1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]
];

// transpose: 実音から記譜音へ何半音上げるか。low/high は記譜音で無理なく吹ける範囲。
export const INSTRUMENTS = {
  alto: { label: 'アルトサックス', partName: 'Alto Saxophone', transpose: 9, low: 58, high: 89,
    xmlTranspose: { diatonic: -5, chromatic: -9, octaveChange: 0 } },
  tenor: { label: 'テナーサックス', partName: 'Tenor Saxophone', transpose: 14, low: 58, high: 89,
    xmlTranspose: { diatonic: -1, chromatic: -2, octaveChange: -1 } },
  concert: { label: '実音(C)', partName: 'Voice', transpose: 0, low: 55, high: 84, xmlTranspose: null }
};

function snap(beats) {
  return Math.round(beats / GRID) * GRID;
}

export function quantizeNotes(rawNotes, { beat0, secPerBeat, totalBeats }) {
  const minSec = GRID * secPerBeat * MIN_NOTE_RATIO;
  const placed = [];
  for (const raw of rawNotes) {
    if (raw.end - raw.start < minSec || raw.end <= beat0) continue;
    const start = Math.max(0, snap((raw.start - beat0) / secPerBeat));
    if (start >= totalBeats) continue;
    const end = Math.min(totalBeats, Math.max(start + GRID, snap((raw.end - beat0) / secPerBeat)));
    addWithoutOverlap(placed, { midi: raw.midi, start, end, weight: raw.end - raw.start });
  }
  return placed.map(({ midi, start, end }) => ({ midi, start, end }));
}

// 同じ拍に2つの音が丸められたら、長く歌っていたほうを残す。
function addWithoutOverlap(placed, note) {
  const prev = placed[placed.length - 1];
  if (prev && note.start <= prev.start) {
    if (note.weight > prev.weight) placed[placed.length - 1] = { ...note, start: prev.start };
    return;
  }
  if (prev && note.start < prev.end) prev.end = note.start;
  placed.push(note);
}

// 拍の頭から始まらない長い音符は読みにくいので、タイで分ける。
function startsCleanly(pos, value) {
  if (value === 4) return pos === 0;
  if (value === 3) return pos === 0 || pos === 1;
  if (value >= 1.5) return Number.isInteger(pos);
  return true;
}

function splitInBar(pos, length) {
  const pieces = [];
  let rest = length;
  let at = pos;
  while (rest > 0) {
    const value = DURATIONS.find((d) => d <= rest && startsCleanly(at, d));
    pieces.push({ at, value });
    at += value;
    rest -= value;
  }
  return pieces;
}

function pushSpan(events, start, length, midi, source) {
  let pos = start;
  const end = start + length;
  let first = true;
  while (pos < end) {
    const barIndex = Math.floor(pos / BEATS_PER_BAR);
    const inBar = pos - barIndex * BEATS_PER_BAR;
    const room = Math.min(end - pos, BEATS_PER_BAR - inBar);
    for (const { at, value } of splitInBar(inBar, room)) {
      events.push({ barIndex, beatInBar: at, duration: value, midi, tied: midi !== null && !first, source });
      first = false;
    }
    pos += room;
  }
}

export function buildEvents(placed, totalBeats) {
  const events = [];
  let pos = 0;
  placed.forEach((note, index) => {
    if (note.start > pos) pushSpan(events, pos, note.start - pos, null, null);
    pushSpan(events, note.start, note.end - note.start, note.midi, index);
    pos = note.end;
  });
  if (pos < totalBeats) pushSpan(events, pos, totalBeats - pos, null, null);
  return events;
}

// 声とサックスでは出しやすい音域が違うので、記譜音が楽器の音域に一番多く収まるオクターブを選ぶ。
export function autoOctaveShift(placed, instrumentKey) {
  if (placed.length === 0) return 0;
  const { transpose, low, high } = INSTRUMENTS[instrumentKey];
  let best = 0;
  let bestScore = -Infinity;
  for (let shift = -2; shift <= 2; shift++) {
    const written = placed.map((n) => n.midi + transpose + shift * 12);
    const inRange = written.filter((m) => m >= low && m <= high).length;
    const center = written.reduce((sum, m) => sum + m, 0) / written.length;
    const score = inRange * 100 - Math.abs(center - (low + high) / 2);
    if (score > bestScore) {
      bestScore = score;
      best = shift;
    }
  }
  return best;
}

export function spellMidi(midi) {
  const [letter, accidental] = SPELLING[((midi % 12) + 12) % 12];
  return { letter, accidental, octave: Math.floor(midi / 12) - 1 };
}

export function staffStep(note) {
  return LETTERS.indexOf(note.letter) + 7 * note.octave;
}

// 同じ小節で一度付けた臨時記号は繰り返さず、元に戻すときだけナチュラルを付ける。
function markAccidentals(notes) {
  let bar = -1;
  let state = {};
  for (const n of notes) {
    if (n.barIndex !== bar) {
      bar = n.barIndex;
      state = {};
    }
    if (n.rest) continue;
    const key = `${n.letter}${n.octave}`;
    const current = state[key] ?? 0;
    n.shownAccidental = n.tied || current === n.accidental ? null : n.accidental;
    state[key] = n.accidental;
  }
}

export function toWrittenNotes(events, instrumentKey, octaveShift) {
  const { transpose } = INSTRUMENTS[instrumentKey];
  const notes = events.map((e) => {
    const base = { barIndex: e.barIndex, beatInBar: e.beatInBar, duration: e.duration, source: e.source };
    if (e.midi === null) return { ...base, rest: true };
    const midi = e.midi + transpose + octaveShift * 12;
    return { ...base, midi, ...spellMidi(midi), tied: e.tied };
  });
  markAccidentals(notes);
  return notes;
}

// 選んだ音を1つ編集した新しい並びを返す。長さは後ろの音と重ならない範囲でだけ伸ばす。
export function editPlacedNote(placed, index, action, totalBeats) {
  const notes = placed.map((n) => ({ ...n }));
  const note = notes[index];
  const limit = index + 1 < notes.length ? notes[index + 1].start : totalBeats;
  if (action === 'up') note.midi += 1;
  if (action === 'down') note.midi -= 1;
  if (action === 'longer' && note.end + GRID <= limit) note.end += GRID;
  if (action === 'shorter' && note.end - GRID > note.start) note.end -= GRID;
  if (action === 'delete') notes.splice(index, 1);
  return notes;
}
