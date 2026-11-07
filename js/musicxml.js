// 楽譜データを MusicXML(楽譜ソフト共通の保存形式)の文字列にする。
// Daily251 への取りこみは music21 で読むので、サックスは記譜音のまま書き、<transpose> で実音との差を伝える。

const TYPES = {
  0.5: ['eighth', 0], 1: ['quarter', 0], 1.5: ['quarter', 1],
  2: ['half', 0], 3: ['half', 1], 4: ['whole', 0]
};
const ACCIDENTAL_NAMES = { 1: 'sharp', '-1': 'flat', 0: 'natural' };
// 8分音符を1単位にする。このアプリで一番短い音符が8分音符のため。
const DIVISIONS = 2;

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attributesXml(instrument) {
  const t = instrument.xmlTranspose;
  const transpose = t
    ? `<transpose><diatonic>${t.diatonic}</diatonic><chromatic>${t.chromatic}</chromatic>`
      + (t.octaveChange ? `<octave-change>${t.octaveChange}</octave-change>` : '') + '</transpose>'
    : '';
  return `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>0</fifths></key>`
    + '<time><beats>4</beats><beat-type>4</beat-type></time>'
    + `<clef><sign>G</sign><line>2</line></clef>${transpose}</attributes>`;
}

function tempoXml(bpm) {
  return '<direction placement="above"><direction-type><metronome>'
    + `<beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type>`
    + `<sound tempo="${bpm}"/></direction>`;
}

function noteXml(note, tieStart) {
  const [type, dots] = TYPES[note.duration];
  const dotXml = dots ? '<dot/>' : '';
  const length = `<duration>${note.duration * DIVISIONS}</duration>`;
  if (note.rest) {
    return `<note><rest/>${length}<voice>1</voice><type>${type}</type>${dotXml}</note>`;
  }
  const alter = note.accidental ? `<alter>${note.accidental}</alter>` : '';
  const pitch = `<pitch><step>${note.letter}</step>${alter}<octave>${note.octave}</octave></pitch>`;
  const ties = (note.tied ? ['stop'] : []).concat(tieStart ? ['start'] : []);
  const tieXml = ties.map((t) => `<tie type="${t}"/>`).join('');
  const tiedXml = ties.length ? `<notations>${ties.map((t) => `<tied type="${t}"/>`).join('')}</notations>` : '';
  const accidental = note.shownAccidental === null || note.shownAccidental === undefined
    ? '' : `<accidental>${ACCIDENTAL_NAMES[note.shownAccidental]}</accidental>`;
  return `<note>${pitch}${length}${tieXml}<voice>1</voice><type>${type}</type>${dotXml}${accidental}${tiedXml}</note>`;
}

export function buildMusicXml(notes, { title, bpm, instrument, totalBars }) {
  const measures = [];
  for (let bar = 0; bar < totalBars; bar++) {
    const head = bar === 0 ? attributesXml(instrument) + tempoXml(bpm) : '';
    const body = notes
      .map((note, i) => ({ note, next: notes[i + 1] }))
      .filter(({ note }) => note.barIndex === bar)
      .map(({ note, next }) => noteXml(note, Boolean(next && next.tied)))
      .join('');
    const barline = bar === totalBars - 1 ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '';
    measures.push(`<measure number="${bar + 1}">${head}${body}${barline}</measure>`);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n'
    + `<score-partwise version="4.0"><work><work-title>${escapeXml(title)}</work-title></work>`
    + `<part-list><score-part id="P1"><part-name>${instrument.partName}</part-name></score-part></part-list>`
    + `<part id="P1">${measures.join('')}</part></score-partwise>\n`;
}
