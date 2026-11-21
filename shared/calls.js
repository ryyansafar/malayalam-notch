// shared/calls.js
// Six meanings, the (placeholder) call table, the deterministic English keyword
// matcher and the expected stroke response per meaning.
// Runs in the browser and in Node. No imports, no I/O.
//
// HONESTY: real race calls have not been collected yet. Every entry in CALLS is
// marked verified: false. The six drill entries carry English only (no invented
// Malayalam). Three real terms are known to exist (Aanjukuthi, Valicheduthu,
// Kuthiyerinju; Onmanorama, 25 Aug 2025) but their meanings are unconfirmed, so
// they are listed with meaning 'unconfirmed' and are never used for matching.

export const MEANINGS = Object.freeze(['start', 'speed_up', 'slow_down', 'hold', 'ready', 'stop']);

/** Marker used in CALLS for terms whose meaning nobody has confirmed yet. */
export const UNCONFIRMED = 'unconfirmed';

const PLACEHOLDER_SOURCE = 'placeholder: English drill phrase only, no Malayalam call collected yet';
const TERM_SOURCE = 'Onmanorama, 25 Aug 2025: term reported to exist, meaning not confirmed';

function placeholder(meaning, english) {
  return Object.freeze({
    id: `placeholder-${meaning}`,
    meaning,
    malayalam: null,
    transliteration: null,
    english,
    verified: false,
    source: PLACEHOLDER_SOURCE,
  });
}

function unconfirmedTerm(transliteration) {
  return Object.freeze({
    id: `term-${transliteration.toLowerCase()}`,
    meaning: UNCONFIRMED,
    malayalam: null, // script spelling not verified, so not written down
    transliteration,
    english: null,
    verified: false,
    source: TERM_SOURCE,
  });
}

export const CALLS = Object.freeze([
  placeholder('start', 'Start rowing'),
  placeholder('speed_up', 'Pull harder, go faster'),
  placeholder('slow_down', 'Slow down'),
  placeholder('hold', 'Hold the water'),
  placeholder('ready', 'Get ready'),
  placeholder('stop', 'Stop rowing'),
  unconfirmedTerm('Aanjukuthi'),
  unconfirmedTerm('Valicheduthu'),
  unconfirmedTerm('Kuthiyerinju'),
]);

// What stroke behaviour counts as obeyed, per meaning. shared/obedience.js reads
// these values; the reasoning for every number is documented here.
export const EXPECTED = Object.freeze({
  // Rate must rise by at least 4 strokes per minute over the pre-call baseline.
  // 4 spm is above the jitter of a hand-held phone detector (about 1-2 spm) yet
  // reachable within a few strokes by a beginner.
  speed_up: Object.freeze({ deltaSpmMin: 4 }),
  // Mirror image of speed_up: rate must fall by at least 4 spm.
  slow_down: Object.freeze({ deltaSpmMax: -4 }),
  // Strokes must cease. The rower gets withinMs (4 s, roughly two strokes at
  // 30 spm) of run-off; after that the observed rate must be below 5 spm, which
  // in practice means no further stroke in the rest of the window.
  stop: Object.freeze({ rateBelowSpm: 5, withinMs: 4000 }),
  // "Hold water" brakes the boat, so the stroke must cease sooner than for
  // stop: 2.5 s of run-off (about one stroke). A phone cannot tell a braking
  // blade from a lifted one; only the absence of strokes is measured.
  hold: Object.freeze({ rateBelowSpm: 5, withinMs: 2500 }),
  // Ready means poised and still. If the rower was rowing, strokes must cease
  // within 3 s. If the rower was at rest, 3 or more strokes after the call is a
  // false start (not obeyed); staying still is not evidence either way.
  ready: Object.freeze({ rateBelowSpm: 5, withinMs: 3000, falseStartStrokes: 3 }),
  // Start means rowing begins: at least 3 strokes inside the window (3 strokes
  // give 2 intervals, the minimum for a rate).
  start: Object.freeze({ minStrokes: 3 }),
});

const MAX_TEXT_LENGTH = 2000;

// Any of these tokens flips or blurs the instruction ("don't stop", "not so
// fast"). The matcher never guesses the intended meaning: it answers 'none'.
const NEGATIONS = new Set([
  'not', 'no', 'dont', 'never', 'cant', 'cannot', 'wont', 'without',
  'shouldnt', 'mustnt', 'neednt', 'non', 'nor', 'neither',
]);

// [meaning, strength, phrases]. 'high' = specific phrase or unambiguous word,
// 'low' = weak single word that often appears in other senses.
const RULE_TABLE = [
  ['speed_up', 'high', [
    'pick up the pace', 'pick up pace', 'pick it up', 'speed up', 'speed it up',
    'go faster', 'row faster', 'pull faster', 'move faster', 'pull harder',
    'row harder', 'push harder', 'go harder', 'increase the pace', 'increase the rate',
    'increase the speed', 'increase speed', 'more speed', 'more power', 'hurry up',
    'faster', 'quicker',
    // Phrasings returned by the live translate API in tests ("Row fast", "Row quickly").
    'row fast', 'row quickly', 'row quick', 'go fast', 'go quickly', 'pull fast',
    'pull quickly', 'move fast', 'move quickly', 'paddle faster', 'paddle fast',
    'paddle quickly',
  ]],
  ['speed_up', 'low', ['harder', 'fast', 'quick', 'quickly', 'hurry', 'too slow']],
  ['slow_down', 'high', [
    'slow down', 'slow it down', 'go slower', 'row slower', 'go slow', 'ease up',
    'ease off', 'take it easy', 'go easy', 'reduce the pace', 'reduce the speed',
    'reduce speed', 'slower',
    // Mirror of the speed-up phrasings above.
    'row slowly', 'row slow', 'go slowly', 'pull slowly', 'row gently', 'row easy',
    'paddle slowly', 'paddle slower',
  ]],
  ['slow_down', 'low', ['slow', 'slowly', 'ease', 'easy', 'gently', 'too fast']],
  ['stop', 'high', ['stop rowing', 'stop the boat', 'stop now', 'stop', 'halt']],
  ['stop', 'low', ['finish', 'easy oar', 'easy oars', 'way enough', 'weigh enough', 'enough']],
  ['hold', 'high', [
    'hold the water', 'hold water', 'hold the boat', 'hold it', 'hold',
  ]],
  ['hold', 'low', ['hold on']],
  ['ready', 'high', [
    'ready to row', 'ready to go', 'ready to start', 'get ready', 'be ready',
    'sit ready', 'get set', 'stand by', 'standby', 'ready', 'attention', 'prepare',
  ]],
  ['start', 'high', [
    'start rowing', 'begin rowing', 'start now', 'here we go', 'let us go',
    'lets go', 'lets row', 'lets start', 'lets begin', 'start', 'begin',
  ]],
  ['start', 'low', ['go', 'row']],
];

// Longest phrases first so "go faster" is consumed before the bare "go" rule.
const RULES = RULE_TABLE
  .flatMap(([meaning, strength, phrases]) =>
    phrases.map((keyword) => ({ meaning, strength, keyword, tokens: keyword.split(' ') })))
  .sort((a, b) => b.tokens.length - a.tokens.length);

const NONE = Object.freeze({ meaning: null, confidence: 'none' });

function tokenize(text) {
  return text
    .slice(0, MAX_TEXT_LENGTH)
    .toLowerCase()
    .replace(/['‘’ʼ`]/g, '') // let's -> lets, don't -> dont
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function ruleMatchesAt(rule, tokens, used, start) {
  return rule.tokens.every((tok, k) => tokens[start + k] === tok && !used[start + k]);
}

function findMatches(tokens) {
  const used = new Array(tokens.length).fill(false);
  const matches = [];
  for (const rule of RULES) {
    const last = tokens.length - rule.tokens.length;
    for (let i = 0; i <= last; i += 1) {
      if (ruleMatchesAt(rule, tokens, used, i)) {
        used.fill(true, i, i + rule.tokens.length);
        matches.push({ meaning: rule.meaning, strength: rule.strength, keyword: rule.keyword, index: i });
      }
    }
  }
  return matches;
}

/** Why the matcher answered 'none'. Only 'no_match' may be handed to a model fallback. */
export const NO_MATCH_REASONS = Object.freeze(['empty', 'negation', 'conflict', 'no_match']);

// One pass over the text shared by matchMeaning and noMatchReason, so the two can never disagree.
function analyse(text) {
  if (typeof text !== 'string') return { reason: 'empty', matches: [] };
  const tokens = tokenize(text);
  if (tokens.length === 0) return { reason: 'empty', matches: [] };
  if (tokens.some((tok) => NEGATIONS.has(tok))) return { reason: 'negation', matches: [] };
  const matches = findMatches(tokens);
  const meanings = new Set(matches.map((m) => m.meaning));
  if (meanings.size === 0) return { reason: 'no_match', matches };
  if (meanings.size > 1) return { reason: 'conflict', matches };
  return { reason: null, matches };
}

/**
 * Map translated English text to one of the six meanings.
 * Deterministic: whole-word keyword rules, longest phrase first.
 * Returns { meaning: null, confidence: 'none' } when nothing matches, when two
 * different meanings match (conflict) or when a negation is present.
 * @param {string} text
 * @returns {{ meaning: string|null, confidence: 'high'|'low'|'none', matchedKeyword?: string }}
 */
export function matchMeaning(text) {
  const { reason, matches } = analyse(text);
  if (reason !== null) return NONE;

  const strong = matches.filter((m) => m.strength === 'high');
  const pool = strong.length > 0 ? strong : matches;
  const best = pool.reduce((a, b) => (b.index < a.index ? b : a));
  return {
    meaning: best.meaning,
    confidence: strong.length > 0 ? 'high' : 'low',
    matchedKeyword: best.keyword,
  };
}

/**
 * Why matchMeaning(text) returns 'none', or null when it finds a meaning.
 *   'empty'    not a string, or no word left after tokenising
 *   'negation' a negation token is present ("do not stop"); checked before any keyword
 *   'conflict' keywords of two different meanings are present ("stop, go faster")
 *   'no_match' no keyword at all
 * Negation and conflict are deliberate refusals and must stay "not sure": only
 * 'no_match' may be passed to a model-assisted fallback.
 * @param {string} text
 * @returns {'empty'|'negation'|'conflict'|'no_match'|null}
 */
export function noMatchReason(text) {
  return analyse(text).reason;
}
