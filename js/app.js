import { extractNotes } from './pitch.js';
import { INSTRUMENTS, quantizeNotes, buildEvents, autoOctaveShift, toWrittenNotes, editPlacedNote } from './score.js';
import { renderScore } from './score-view.js';
import { buildMusicXml } from './musicxml.js';
import { createAudioContext, scheduleClicks, playNotes } from './audio.js';

const COUNT_IN_BEATS = 4;
// 録音の最後の音が切れないよう、指定の小節が終わってから少し待って止める。
const TAIL_SEC = 0.4;
const WIDE_SCREEN = 640;
const DURATION_NAMES = { 0.5: '8分音符', 1: '4分音符', 1.5: '付点4分音符', 2: '2分音符', 3: '付点2分音符', 4: '全音符' };
const ACCIDENTAL_MARKS = { 1: '♯', '-1': '♭', 0: '' };

const $ = (id) => document.getElementById(id);
const tempoInput = $('tempo');
const barsSelect = $('bars');
const instrumentSelect = $('instrument');
const recordButton = $('record');
const statusText = $('status');
const resultSection = $('result');
const scoreBox = $('score');
const playButton = $('play');

let take = null;
let recording = null;
let result = null;
let playback = null;

function readSettings() {
  return { bpm: Number(tempoInput.value), bars: Number(barsSelect.value), instrumentKey: instrumentSelect.value };
}

function setStatus(text) {
  statusText.textContent = text;
}

async function openMicrophone(ctx) {
  // 自動音量調整やノイズ除去は声の高さの判定をゆがめるので切る。
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  await ctx.audioWorklet.addModule('js/recorder-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'recorder-processor');
  const mute = ctx.createGain();
  mute.gain.value = 0;
  // Safari は出力につながっていない処理ノードを動かさないことがあるため、無音でつないでおく。
  source.connect(node).connect(mute).connect(ctx.destination);
  return { stream, node };
}

function showBeats(ctx, startTime, settings) {
  const secPerBeat = 60 / settings.bpm;
  const totalBeats = COUNT_IN_BEATS + settings.bars * 4;
  const timers = [];
  for (let i = 0; i < totalBeats; i++) {
    const delay = (startTime + i * secPerBeat - ctx.currentTime) * 1000;
    const label = i < COUNT_IN_BEATS
      ? `カウント ${i + 1}`
      : `歌ってください　${Math.floor((i - COUNT_IN_BEATS) / 4) + 1} / ${settings.bars} 小節`;
    timers.push(setTimeout(() => setStatus(label), Math.max(0, delay)));
  }
  return timers;
}

async function startRecording() {
  const settings = readSettings();
  // iPhone ではタップの直後に作らないと音が出ないので、マイクの許可を待つ前に作る。
  const audio = createAudioContext();
  await audio.ctx.resume();
  let mic;
  try {
    mic = await openMicrophone(audio.ctx);
  } catch (error) {
    audio.ctx.close();
    setStatus('マイクを使えませんでした。設定でマイクの使用を許可してください。');
    return;
  }
  const chunks = [];
  mic.node.port.onmessage = (event) => chunks.push(event.data);
  const secPerBeat = 60 / settings.bpm;
  const startTime = audio.ctx.currentTime + 0.3;
  const totalBeats = COUNT_IN_BEATS + settings.bars * 4;
  scheduleClicks(audio, startTime, totalBeats, secPerBeat);
  const timers = showBeats(audio.ctx, startTime, settings);
  const stopDelay = (startTime + totalBeats * secPerBeat + TAIL_SEC - audio.ctx.currentTime) * 1000;
  timers.push(setTimeout(finishRecording, stopDelay));
  // 聞こえたクリックに合わせて歌うので、スピーカーから音が出るまでの遅れぶん後ろにずらす。
  const latency = audio.ctx.outputLatency || audio.ctx.baseLatency || 0;
  recording = { audio, mic, chunks, timers, settings, bar1Time: startTime + COUNT_IN_BEATS * secPerBeat + latency };
  recordButton.textContent = '停止';
  recordButton.classList.add('is-recording');
}

function joinChunks(chunks) {
  const length = chunks.reduce((sum, c) => sum + c.samples.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    samples.set(c.samples, offset);
    offset += c.samples.length;
  }
  return { samples, firstFrame: chunks.length ? chunks[0].frame : 0 };
}

function finishRecording() {
  if (!recording) return;
  const { audio, mic, chunks, timers, settings, bar1Time } = recording;
  recording = null;
  timers.forEach(clearTimeout);
  mic.stream.getTracks().forEach((track) => track.stop());
  mic.node.port.onmessage = null;
  const sampleRate = audio.ctx.sampleRate;
  audio.ctx.close();
  recordButton.textContent = '録音';
  recordButton.classList.remove('is-recording');
  setStatus('音符に直しています…');
  const { samples, firstFrame } = joinChunks(chunks);
  // 解析で画面が固まる前に「直しています」を表示させるため、一拍おいてから始める。
  setTimeout(() => analyzeTake(samples, sampleRate, (bar1Time * sampleRate - firstFrame) / sampleRate, settings), 50);
}

function analyzeTake(samples, sampleRate, beat0, settings) {
  const { notes } = extractNotes(samples, sampleRate);
  const placed = quantizeNotes(notes, { beat0, secPerBeat: 60 / settings.bpm, totalBeats: settings.bars * 4 });
  if (placed.length === 0) {
    setStatus('音が聞き取れませんでした。もう少し大きな声で、マイクの近くで歌ってみてください。');
    return;
  }
  take = { placed, bpm: settings.bpm, bars: settings.bars, recordedAt: new Date(), selected: 0 };
  take.octaveShift = autoOctaveShift(placed, instrumentSelect.value);
  setStatus(`${placed.length}個の音符になりました。`);
  showResult();
}

function showResult() {
  if (!take) return;
  stopPlayback();
  const events = buildEvents(take.placed, take.bars * 4);
  result = toWrittenNotes(events, instrumentSelect.value, take.octaveShift);
  // 隠れたままだと幅が0と測られるので、先に表示してから1行の小節数を決める。
  resultSection.hidden = false;
  const barsPerRow = Math.min(take.bars, scoreBox.clientWidth >= WIDE_SCREEN ? 4 : 2);
  renderScore(scoreBox, result, take.bars, barsPerRow, { selected: take.selected, onSelect: selectNote });
  updateEditorLabel();
}

function updateEditorLabel() {
  const written = result.find((n) => !n.rest && n.source === take.selected);
  if (!written) {
    $('selected-note').textContent = 'なし';
    return;
  }
  const note = take.placed[take.selected];
  const length = note.end - note.start;
  const name = `${written.letter}${ACCIDENTAL_MARKS[written.accidental]}${written.octave}`;
  $('selected-note').textContent = `${name}・${DURATION_NAMES[length] || `${length}拍`}`;
}

function selectNote(index) {
  take.selected = index;
  showResult();
}

function moveSelection(step) {
  if (!take || take.placed.length === 0) return;
  const current = take.selected ?? 0;
  take.selected = Math.min(take.placed.length - 1, Math.max(0, current + step));
  showResult();
}

function editSelected(action) {
  if (!take || take.selected === null || !take.placed[take.selected]) return;
  take.placed = editPlacedNote(take.placed, take.selected, action, take.bars * 4);
  if (action === 'delete') {
    take.selected = take.placed.length ? Math.min(take.selected, take.placed.length - 1) : null;
  }
  showResult();
}

function shiftOctave(direction) {
  if (!take) return;
  take.octaveShift += direction;
  showResult();
}

function stopPlayback() {
  if (!playback) return;
  clearTimeout(playback.timer);
  playback.audio.ctx.close();
  playback = null;
  playButton.textContent = '再生';
}

async function togglePlayback() {
  if (playback) {
    stopPlayback();
    return;
  }
  const audio = createAudioContext();
  await audio.ctx.resume();
  const { transpose } = INSTRUMENTS[instrumentSelect.value];
  const seconds = playNotes(audio, result, { bpm: take.bpm, transpose });
  playback = { audio, timer: setTimeout(stopPlayback, (seconds + 0.3) * 1000) };
  playButton.textContent = '止める';
}

function fileStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

async function saveMusicXml() {
  if (!take) return;
  const stamp = fileStamp(take.recordedAt);
  const xml = buildMusicXml(result, {
    title: `Scat ${stamp}`, bpm: take.bpm, instrument: INSTRUMENTS[instrumentSelect.value], totalBars: take.bars
  });
  const file = new File([xml], `scat-${stamp}.musicxml`, { type: 'application/vnd.recordare.musicxml+xml' });
  // iPhone では共有シートから「ファイルに保存」やAirDropでMacへ送れるようにする。
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      // 共有シートを閉じただけのときは何もしない。
    }
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

tempoInput.addEventListener('input', () => {
  $('tempo-value').textContent = tempoInput.value;
});
recordButton.addEventListener('click', () => (recording ? finishRecording() : startRecording()));
instrumentSelect.addEventListener('change', () => {
  if (!take) return;
  take.octaveShift = autoOctaveShift(take.placed, instrumentSelect.value);
  showResult();
});
$('octave-down').addEventListener('click', () => shiftOctave(-1));
$('octave-up').addEventListener('click', () => shiftOctave(1));
playButton.addEventListener('click', togglePlayback);
$('retake').addEventListener('click', () => {
  if (recording) return;
  stopPlayback();
  // 楽譜の下で押しても、カウントと進み具合の表示が見える位置へ戻す。
  recordButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
  startRecording();
});
$('save').addEventListener('click', saveMusicXml);
$('prev-note').addEventListener('click', () => moveSelection(-1));
$('next-note').addEventListener('click', () => moveSelection(1));
$('pitch-down').addEventListener('click', () => editSelected('down'));
$('pitch-up').addEventListener('click', () => editSelected('up'));
$('shorter').addEventListener('click', () => editSelected('shorter'));
$('longer').addEventListener('click', () => editSelected('longer'));
$('delete-note').addEventListener('click', () => editSelected('delete'));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}
