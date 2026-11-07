// 楽譜データを SVG の五線譜として描く。
// 色はすべて currentColor にして、ダークモードでは CSS の文字色の切りかえだけで追従させる。
import { staffStep } from './score.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LINE_GAP = 10;
const ROW_HEIGHT = 130;
const STAFF_TOP = 45;
const CLEF_WIDTH = 38;
const BAR_PAD = 16;
const BEAT_WIDTH = 44;
const BAR_WIDTH = BAR_PAD + BEAT_WIDTH * 4;
// 五線の一番下の線(E4)の段数。staffStep と同じ数え方。
const BOTTOM_STEP = 30;
const ACCIDENTAL_GLYPHS = { 1: '♯', '-1': '♭', 0: '♮' };

function el(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

function bottomY(row) {
  return row * ROW_HEIGHT + STAFF_TOP + LINE_GAP * 4;
}

function stepY(row, step) {
  return bottomY(row) - (step - BOTTOM_STEP) * (LINE_GAP / 2);
}

function drawStaff(svg, row, bars, isLastRow) {
  const top = bottomY(row) - LINE_GAP * 4;
  const right = CLEF_WIDTH + bars * BAR_WIDTH;
  for (let i = 0; i < 5; i++) {
    svg.append(el('line', { x1: 4, x2: right, y1: top + i * LINE_GAP, y2: top + i * LINE_GAP, class: 'staff-line' }));
  }
  svg.append(el('text', { x: 4, y: bottomY(row) + 12, class: 'clef' }, '\u{1D11E}'));
  for (let b = 1; b <= bars; b++) {
    const x = CLEF_WIDTH + b * BAR_WIDTH;
    const isEnd = isLastRow && b === bars;
    svg.append(el('line', { x1: isEnd ? x - 5 : x, x2: isEnd ? x - 5 : x, y1: top, y2: bottomY(row), class: 'bar-line' }));
    if (isEnd) svg.append(el('rect', { x: x - 3, y: top, width: 3, height: LINE_GAP * 4, class: 'ink' }));
  }
}

function drawLedgers(svg, x, row, step) {
  for (let s = BOTTOM_STEP - 2; s >= step; s -= 2) {
    svg.append(el('line', { x1: x - 10, x2: x + 10, y1: stepY(row, s), y2: stepY(row, s), class: 'staff-line' }));
  }
  for (let s = BOTTOM_STEP + 10; s <= step; s += 2) {
    svg.append(el('line', { x1: x - 10, x2: x + 10, y1: stepY(row, s), y2: stepY(row, s), class: 'staff-line' }));
  }
}

function drawDot(svg, x, y, onLine) {
  svg.append(el('circle', { cx: x, cy: onLine ? y - LINE_GAP / 2 : y, r: 2, class: 'ink' }));
}

function drawNote(svg, note, x, row) {
  const step = staffStep(note);
  const y = stepY(row, step);
  drawLedgers(svg, x, row, step);
  const hollow = note.duration >= 2;
  svg.append(el('ellipse', {
    cx: x, cy: y, rx: 6.2, ry: 4.4, transform: `rotate(-20 ${x} ${y})`,
    class: hollow ? 'head-hollow' : 'ink'
  }));
  if (note.duration < 4) {
    const up = step < BOTTOM_STEP + 4;
    const stemX = up ? x + 5.6 : x - 5.6;
    const tipY = up ? y - 34 : y + 34;
    svg.append(el('line', { x1: stemX, x2: stemX, y1: y, y2: tipY, class: 'stem' }));
    if (note.duration === 0.5) {
      const d = up ? `M${stemX} ${tipY} q2 10 9 15 q-4 -6 -9 -9` : `M${stemX} ${tipY} q2 -10 9 -15 q-4 6 -9 9`;
      svg.append(el('path', { d, class: 'flag' }));
    }
  }
  if (note.duration === 1.5 || note.duration === 3) drawDot(svg, x + 11, y, step % 2 === 0);
  if (note.shownAccidental !== null && note.shownAccidental !== undefined) {
    svg.append(el('text', { x: x - 11, y: y + 5, class: 'accidental' }, ACCIDENTAL_GLYPHS[note.shownAccidental]));
  }
  return { x, y, up: step < BOTTOM_STEP + 4 };
}

function drawRest(svg, rest, x, row, barX) {
  const mid = stepY(row, BOTTOM_STEP + 4);
  const d = rest.duration;
  if (d === 4) {
    svg.append(el('rect', { x: barX + BAR_WIDTH / 2 - 6, y: mid - LINE_GAP, width: 12, height: 5, class: 'ink' }));
  } else if (d >= 2) {
    svg.append(el('rect', { x: x - 6, y: mid - 5, width: 12, height: 5, class: 'ink' }));
  } else if (d >= 1) {
    const path = `M${x - 2} ${mid - 15} L${x + 4} ${mid - 7} L${x - 2} ${mid} L${x + 4} ${mid + 6} Q${x - 4} ${mid + 3} ${x} ${mid + 12}`;
    svg.append(el('path', { d: path, class: 'rest-stroke' }));
  } else {
    svg.append(el('circle', { cx: x - 3, cy: mid - 5, r: 2.4, class: 'ink' }));
    svg.append(el('path', { d: `M${x - 3} ${mid - 3} Q${x + 1} ${mid - 2} ${x + 4} ${mid - 6} L${x - 1} ${mid + 9}`, class: 'rest-stroke' }));
  }
  if (d === 1.5 || d === 3) drawDot(svg, x + 10, mid - LINE_GAP / 2, false);
}

function drawTie(svg, from, to) {
  const dir = from.up ? 1 : -1;
  const y = from.y + dir * 8;
  const midX = (from.x + to.x) / 2;
  svg.append(el('path', {
    d: `M${from.x + 4} ${y} Q${midX} ${y + dir * 9} ${to.x - 4} ${y}`, class: 'tie'
  }));
}

// 音符ごとにグループにまとめ、透明な当たり判定を重ねる。細い符頭だけだと指でタップしにくいため。
function drawSelectableNote(svg, note, x, row, { selected, onSelect }) {
  const group = el('g', { class: note.source === selected ? 'note is-selected' : 'note' });
  group.append(el('rect', {
    x: x - 12, y: bottomY(row) - 85, width: Math.max(24, note.duration * BEAT_WIDTH), height: 120, class: 'hit'
  }));
  const drawn = drawNote(group, note, x, row);
  group.addEventListener('click', () => onSelect(note.source));
  svg.append(group);
  return drawn;
}

export function renderScore(container, notes, totalBars, barsPerRow, selection) {
  const rows = Math.ceil(totalBars / barsPerRow);
  const width = CLEF_WIDTH + barsPerRow * BAR_WIDTH + 6;
  const svg = el('svg', { viewBox: `0 0 ${width} ${rows * ROW_HEIGHT}`, class: 'score', role: 'img', 'aria-label': '採譜した楽譜' });
  for (let row = 0; row < rows; row++) {
    drawStaff(svg, row, Math.min(barsPerRow, totalBars - row * barsPerRow), row === rows - 1);
  }
  let prev = null;
  for (const note of notes) {
    const row = Math.floor(note.barIndex / barsPerRow);
    const barX = CLEF_WIDTH + (note.barIndex % barsPerRow) * BAR_WIDTH;
    const x = barX + BAR_PAD + note.beatInBar * BEAT_WIDTH;
    if (note.rest) {
      drawRest(svg, note, x, row, barX);
      prev = null;
      continue;
    }
    const drawn = drawSelectableNote(svg, note, x, row, selection);
    if (note.tied && prev) drawTie(svg, prev, prev.row === row ? drawn : { ...drawn, x: prev.x + 24 });
    prev = { ...drawn, row };
  }
  container.replaceChildren(svg);
}
