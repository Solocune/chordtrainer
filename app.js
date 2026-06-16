'use strict';

/* ============================================================
   STORAGE MODULE
   ============================================================ */
const Storage = (() => {
  const K = {
    STATS:       'ct_word_stats',
    SETS:        'ct_word_sets',
    SESSIONS:    'ct_sessions',
    SETTINGS:    'ct_settings',
    WELCOMED:    'ct_welcomed',
    CHORD_MAP:   'ct_chord_map',
    PRACTICE_MS: 'ct_practice_ms',
    LEARNED_HISTORY: 'ct_learned_history',
  };

  const DEFAULTS = {
    testWordCount:          20,
    slowChordTimeThreshold: 3000,
    caseInsensitive:        true,
    showWordStats:          true,
    autoAdvanceDelay:       600,
    skipDelayMinutes:       5,
    theme:                  'dark',
    hintModes:              ['wrong','delay'],  // array; 'never'|'always' exclusive, 'wrong'+'delay' combinable
    hintDelaySeconds:       1,
    firstSuccessIntervalDays:  1,
    secondSuccessIntervalDays: 6,
    maxIntervalDays:        365,
    easeFactorDefault:      2.5,
    wrongTopN:              20,
    slowTopN:               20,
    afkThresholdSeconds:    5,
    learnedThresholdDays:   10,
    backupReminderDays:     7,
    // Learned chart defaults
    learnedChartRangeDays:  90,
    learnedChartAggregation: 'day', // 'day' | 'week' | 'month'
  };

  const load = (key, fallback) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  };
  const save = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { console.warn('Storage write failed:', e); }
  };

  const api = {
    getAllWordStats: () => load(K.STATS, {}),
    saveAllWordStats: (s) => save(K.STATS, s),
    getWordStat(word) { return api.getAllWordStats()[word] || null; },

    _initStat(word) {
      return {
        word, attempts: 0, correctFirstTry: 0, totalCorrect: 0, skipped: 0,
        delayHistory: [], chordTimeHistory: [], pureWpmHistory: [],
        // `baseIntervalDays` is the stored base interval used to compute next due dates.
        // `interval` is kept for backward-compatibility when migrating old stats.
        baseIntervalDays: 0, interval: 0, easeFactor: api.getSettings().easeFactorDefault ?? 2.5, repetitions: 0,
        due: Date.now(), firstSeen: Date.now(), lastSeen: null,
        // Per-word history of base interval values at each recorded attempt
        baseHistory: [],
      };
    },

    updateWordResult(word, result) {
      const all = api.getAllWordStats();
      const now = Date.now();
      const s   = all[word] || api._initStat(word);
      const settings = api.getSettings();
      const learnedThreshold = settings.learnedThresholdDays ?? 10;
      const wasLearned = (s.baseIntervalDays ?? s.interval ?? 0) >= learnedThreshold;
      s.lastSeen = now;
      if (result.skipped) {
        s.attempts++; s.skipped = (s.skipped || 0) + 1;
        s.repetitions = 0; s.baseIntervalDays = 0;
        const skipDelayMs = Math.max(0, (settings.skipDelayMinutes ?? 5)) * 60 * 1000;
        s.due = now + skipDelayMs;
        // record base interval history (0 when skipped)
        s.baseHistory = [...(s.baseHistory || []).slice(-499), { ts: now, baseIntervalDays: s.baseIntervalDays || 0 }];
        all[word] = s; save(K.STATS, all); return;
      }
      s.attempts++;
      if (result.correct) {
        s.totalCorrect++;
        if (!result.hadRetry) s.correctFirstTry++;
      }
      if (result.delay     != null) s.delayHistory     = [...(s.delayHistory     || []).slice(-49), result.delay];
      if (result.chordTime != null) s.chordTimeHistory = [...(s.chordTimeHistory || []).slice(-49), result.chordTime];
      const q = result.quality ?? 0;
      if (q >= 3) {
        const firstDays = Math.max(1, settings.firstSuccessIntervalDays ?? 1);
        const secondDays = Math.max(1, settings.secondSuccessIntervalDays ?? 6);
        // Determine new base interval (float days). Use existing baseIntervalDays if present,
        // fall back to legacy `interval` for migrated data.
        if (s.repetitions === 0) {
          s.baseIntervalDays = firstDays;
        } else if (s.repetitions === 1) {
          s.baseIntervalDays = secondDays;
        } else {
          const prevBase = (s.baseIntervalDays ?? s.interval ?? secondDays);
          s.baseIntervalDays = prevBase * s.easeFactor;
        }
        s.repetitions++;
        s.easeFactor = Math.max(1.3, s.easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
        s.baseIntervalDays = Math.min(s.baseIntervalDays, settings.maxIntervalDays ?? 365);
        // Set countdown (due) from the base interval. Round to milliseconds.
        s.due = now + Math.round((s.baseIntervalDays ?? s.interval ?? 0) * 86400 * 1000);
        // For compatibility, keep a rounded integer `interval` too (not used for scheduling).
        s.interval = Math.round(s.baseIntervalDays || 0);
        // record base interval history
        s.baseHistory = [...(s.baseHistory || []).slice(-499), { ts: now, baseIntervalDays: s.baseIntervalDays || 0 }];
        // Determine learned/unlearned transitions (record events)
        const isLearnedNow = (s.baseIntervalDays ?? s.interval ?? 0) >= learnedThreshold;
        if (!wasLearned && isLearnedNow) {
          s.learnedAt = now;
          api.addLearnedHistoryEvent({ word, type: 'learned', ts: now });
        }
      } else {
        // A corrected/hinted answer is not treated as memory success.
        s.repetitions = 0;
        s.baseIntervalDays = 0;
        s.interval = 0;
        s.due = now;
        // If the word was previously learned but now reset, record unlearned event
        const isLearnedNow = (s.baseIntervalDays ?? s.interval ?? 0) >= learnedThreshold;
        if (wasLearned && !isLearnedNow) {
          delete s.learnedAt;
          api.addLearnedHistoryEvent({ word, type: 'unlearned', ts: now });
        }
        // record base interval history for reset (0)
        s.baseHistory = [...(s.baseHistory || []).slice(-499), { ts: now, baseIntervalDays: 0 }];
      }
      all[word] = s; save(K.STATS, all);
    },

    resetWordStats(words) {
      const all = api.getAllWordStats();
      words.forEach(w => delete all[w]);
      save(K.STATS, all);
    },
    resetAllStats() { save(K.STATS, {}); save(K.SESSIONS, []); save(K.PRACTICE_MS, 0); },

    bringAllWordsDue() {
      const all = api.getAllWordStats(), now = Date.now();
      for (const s of Object.values(all)) s.due = now;
      save(K.STATS, all);
    },
    bringForwardByDays(days) {
      const all = api.getAllWordStats(), now = Date.now(), shift = days * 86400000;
      for (const s of Object.values(all)) {
        // Only shift the countdown (due). Do not change the base interval used to compute future due dates.
        s.due = Math.max(now, (s.due ?? now) - shift);
      }
      save(K.STATS, all);
    },

    // Reset the stored base interval for all words (useful to restart scheduling)
    resetAllBaseIntervals() {
      const all = api.getAllWordStats();
      const now = Date.now();
      for (const [word, s] of Object.entries(all)) {
        if (s.learnedAt) api.addLearnedHistoryEvent({ word, type: 'unlearned', ts: now });
        s.baseIntervalDays = 0;
        s.repetitions = 0;
        s.interval = 0;
        delete s.learnedAt;
        // record baseHistory reset event
        s.baseHistory = [...(s.baseHistory || []).slice(-499), { ts: now, baseIntervalDays: 0 }];
      }
      save(K.STATS, all);
    },

    getWordSets() {
      const d = load(K.SETS, { sets: [], activeIds: [] });
      /* Migrate legacy single activeId → activeIds array */
      if (!Array.isArray(d.activeIds)) {
        d.activeIds = d.activeId ? [d.activeId] : [];
      }
      return d;
    },
    saveWordSets: (d) => save(K.SETS, d),
    /* Learned history (append-only) — stores events {word,type:'learned'|'unlearned',ts} */
    getLearnedHistory() { return load(K.LEARNED_HISTORY, []); },
    saveLearnedHistory(arr) { save(K.LEARNED_HISTORY, arr); },
    addLearnedHistoryEvent(ev){
      try{
        const h = api.getLearnedHistory();
        h.push(ev);
        save(K.LEARNED_HISTORY, h);
      }catch(e){console.warn('Failed to append learned history',e);}
    },
    getActiveWords() {
      const { sets, activeIds = [] } = api.getWordSets();
      const seen = new Set();
      const words = [];
      for (const id of activeIds) {
        const set = sets.find(s => s.id === id);
        if (set) for (const w of set.words) { if (!seen.has(w)) { seen.add(w); words.push(w); } }
      }
      return words;
    },
    getActiveSetName() {
      const { sets, activeIds = [] } = api.getWordSets();
      const names = activeIds.map(id => sets.find(s => s.id === id)?.name).filter(Boolean);
      if (!names.length) return 'None';
      if (names.length === 1) return names[0];
      return `${names[0]} +${names.length - 1} more`;
    },

    /* Update word stats WITHOUT touching SM-2 scheduling (for non-SR practice modes) */
    updateWordStatsOnly(word, result) {
      const all = api.getAllWordStats();
      const s = all[word] || api._initStat(word);
      s.lastSeen = Date.now();
      if (result.skipped) {
        s.attempts++; s.skipped = (s.skipped || 0) + 1;
        // record base interval snapshot
        s.baseHistory = [...(s.baseHistory || []).slice(-499), { ts: Date.now(), baseIntervalDays: s.baseIntervalDays || 0 }];
        all[word] = s; save(K.STATS, all); return;
      }
      s.attempts++;
      if (result.correct) {
        s.totalCorrect++;
        if (!result.hadRetry) s.correctFirstTry++;
      }
      if (result.delay     != null) s.delayHistory     = [...(s.delayHistory     || []).slice(-49), result.delay];
      if (result.chordTime != null) s.chordTimeHistory = [...(s.chordTimeHistory || []).slice(-49), result.chordTime];
      // record base interval snapshot
      s.baseHistory = [...(s.baseHistory || []).slice(-499), { ts: Date.now(), baseIntervalDays: s.baseIntervalDays || 0 }];
      all[word] = s; save(K.STATS, all);
    },

    getSessions: () => load(K.SESSIONS, []),
    saveSession(sess) {
      const sessions = api.getSessions();
      sessions.push({ ...sess, id: Date.now() });
      if (sessions.length > 200) sessions.splice(0, sessions.length - 200);
      save(K.SESSIONS, sessions);
    },

    getSettings() {
      const HINT_VER = 4; // bump to force-reset hint mode when default changes
      const s = { ...DEFAULTS, ...load(K.SETTINGS, {}) };
      /* Migrate legacy single hintMode string → hintModes array */
      if (typeof s.hintMode === 'string') {
        if (!s.hintModes) s.hintModes = [s.hintMode];
        delete s.hintMode;
      }
      /* Version bump: reset hint mode to current default for old installations */
      if ((s._hintVer ?? 0) < HINT_VER) {
        s.hintModes = DEFAULTS.hintModes; // ['wrong','delay']
        s.hintDelaySeconds = DEFAULTS.hintDelaySeconds; // 1
        s._hintVer = HINT_VER;
        save(K.SETTINGS, s);
      }
      return s;
    },
    saveSettings: (s) => save(K.SETTINGS, s),

    getChordMap() {
      const stored = load(K.CHORD_MAP, null);
      if (!stored) return null;
      /* Normalize keys on read: strip non-printable chars and lowercase
         (fixes old stored data where keys had wrong case or trailing \x08). */
      if (stored.map) {
        const normalized = {};
        let changed = false;
        for (const [k, v] of Object.entries(stored.map)) {
          const clean = k.replace(/[^\x20-\x7e]/g, '').toLowerCase().trim();
          if (clean && !normalized[clean]) {
            normalized[clean] = v;
            if (clean !== k) changed = true;
          }
        }
        stored.map = normalized;
        if (changed) save(K.CHORD_MAP, stored); // persist normalized keys
      }
      return stored;
    },
    saveChordMap: (d) => save(K.CHORD_MAP, d),
    clearChordMap() { try { localStorage.removeItem(K.CHORD_MAP); } catch {} },

    getTotalPracticeMs: () => load(K.PRACTICE_MS, 0),
    addPracticeMs(ms) {
      if (!ms || ms <= 0) return;
      save(K.PRACTICE_MS, load(K.PRACTICE_MS, 0) + ms);
    },

    isFirstVisit() {
      const v = localStorage.getItem(K.WELCOMED);
      if (!v) { localStorage.setItem(K.WELCOMED, '1'); return true; }
      return false;
    },
    exportData() {
      return JSON.stringify({
        version: '1.5', exportDate: new Date().toISOString(),
        wordStats: api.getAllWordStats(), wordSets: api.getWordSets(),
        sessions: api.getSessions(), settings: api.getSettings(),
        totalPracticeMs: api.getTotalPracticeMs(),
        learnedHistory: api.getLearnedHistory(),
      }, null, 2);
    },
    importData(json, options = {}) {
      const d = JSON.parse(json);
      if (d.wordStats) save(K.STATS,    d.wordStats);
      if (d.wordSets)  save(K.SETS,     d.wordSets);
      if (d.sessions)  save(K.SESSIONS, d.sessions);
      if (d.settings)  save(K.SETTINGS, d.settings);
      const importedPracticeMs = d.totalPracticeMs ?? d.practiceMs;
      if (typeof importedPracticeMs === 'number' && importedPracticeMs > 0) {
        const mode = options.practiceTimeMode ?? 'keep'; // 'overwrite' | 'aggregate' | 'keep'
        const cur = load(K.PRACTICE_MS, 0);
        if (mode === 'overwrite') save(K.PRACTICE_MS, importedPracticeMs);
        else if (mode === 'aggregate') save(K.PRACTICE_MS, cur + importedPracticeMs);
      }
      // Import learned history if present
      if (d.learnedHistory) save(K.LEARNED_HISTORY, d.learnedHistory);
    },
  };
  return api;
})();


/* ============================================================
   ADAPTIVE MODULE
   ============================================================ */
const Adaptive = (() => {
  function weightedPick(scored) {
    if (!scored.length) return null;
    const total = scored.reduce((s, x) => s + x.score, 0);
    let r = Math.random() * total;
    for (const x of scored) { r -= x.score; if (r <= 0) return x.word; }
    return scored[scored.length - 1].word;
  }
  return {
    getNextWord(words, mode, lastWord, settings) {
      if (!words?.length) return null;
      let pool = words.length > 1 ? words.filter(w => w !== lastWord) : [...words];
      const all  = Storage.getAllWordStats();
      const now  = Date.now();
      const t    = settings.slowChordTimeThreshold ?? 3000;
      if (mode === 'adaptive') {
        const duePool = pool.filter(word => {
          const s = all[word];
          return !s || s.attempts === 0 || (s.due ?? now) <= now;
        });
        // In adaptive mode, never pull future-due words while due words exist.
        if (duePool.length) pool = duePool;
      }
      const scored = pool.map(word => {
        const s = all[word];
        let score = 1;
        if (mode === 'adaptive') {
          if (!s || s.attempts === 0) { score = 8; }
          else {
            const daysOverdue = Math.max(0, (now - (s.due ?? now)) / 86400000);
            score = 1 + daysOverdue * 2.5;
            const acc = s.attempts ? s.correctFirstTry / s.attempts : 0;
            if (acc < 0.5)  score *= 2.5;
            if (acc < 0.25) score *= 2;
            const ct = avgArr(s.chordTimeHistory);
            if (ct && ct > t) score *= 1.4;
          }
        }
        // For all non-adaptive modes the pool is pre-filtered; pick uniformly.
        return { word, score };
      });
      return weightedPick(scored);
    },
    calcQuality(hadRetry, chordTime, settings) {
      if (hadRetry) return 2;
      if (!chordTime) return 4;
      const t = settings.slowChordTimeThreshold ?? 3000;
      if (chordTime <= t * 0.5)  return 5;
      if (chordTime <= t)        return 4;
      if (chordTime <= t * 1.5)  return 3;
      return 2;
    },
  };
})();


/* ============================================================
   CHARACHORDER MODULE
   ============================================================ */
const CC = (() => {
  function decodeInputHex(hex) {
    const h = String(hex || '').trim();
    if (!/^[0-9a-fA-F]{32}$/.test(h)) return [];
    const bits = h.split('').map(c => parseInt(c,16).toString(2).padStart(4,'0')).join('');
    const slots = [];
    for (let off = 8; off < 128; off += 10) slots.push(parseInt(bits.slice(off, off+10), 2));
    return slots.filter(c => c !== 0).reverse();
  }
  function decodeOutputHex(hex) {
    if (!hex) return '';
    // Detect hex-encoded text: even length, all hex chars
    if (hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
      const bytes = [];
      for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i,i+2),16));
      const decoded = bytes.map(b => String.fromCharCode(b)).join('');
      // Trust the hex decode only when the result is printable ASCII
      if (/^[\x20-\x7e]+$/.test(decoded)) return decoded;
    }
    // Fall back: treat as plain text (handles charachorder.io plain-text phrase fields)
    return hex;
  }
  // CharaChorder action codes > 127 that map to specific Unicode characters.
  // Codes 1–127  = ASCII direct (String.fromCharCode works fine).
  // Codes 128–255 = Latin-1 Supplement (String.fromCharCode works for 160–255;
  //                 128–159 are C1 controls in Unicode but printable in CP-1252 —
  //                 mapped explicitly below where needed).
  // Codes 700–799 = US-International AltGr combinations (from actions.json).
  const CC_CHAR_MAP = {
    // --- German (QWERTZ / US-Intl) -------
    780: '\u00f6',  // ö  p+AltGr
    781: '\u00e4',  // ä  q+AltGr  ← confirmed from backup
    783: '\u00df',  // ß  s+AltGr
    789: '\u00fc',  // ü  y+AltGr  ← confirmed from backup
    748: '\u00d6',  // Ö  p+Shift+AltGr
    749: '\u00c4',  // Ä  q+Shift+AltGr
    757: '\u00dc',  // Ü  y+Shift+AltGr
    // --- US-International full table -----
    701: '\u00a1',  // ¡  746: '\u00d1',  // Ñ
    704: '\u00a3',  // £  747: '\u00d3',  // Ó
    706: '\u00bd',  // ½  750: '\u00cb',  // Ë
    710: '\u00be',  // ¾  751: '\u00a7',  // §
    711: '\u00f7',  // ÷  752: '\u00de',  // Þ
    712: '\u00e7',  // ç  753: '\u00da',  // Ú
    713: '\u00a5',  // ¥  754: '\u2122',  // ™
    715: '\u00bf',  // ¿  755: '\u00c5',  // Å
    716: '\u2019',  // '  758: '\u00c6',  // Æ
    717: '\u00b9',  // ¹  759: '\u00ab',  // «
    718: '\u00b2',  // ²  760: '\u00ac',  // ¬
    719: '\u00b3',  // ³  761: '\u00bb',  // »
    720: '\u00a4',  // ¤  762: '\u00bc',  // ¼
    721: '\u20ac',  // €  765: '\u00e1',  // á
    725: '\u2018',  // '  766: '\u00b7',  // ·
    726: '\u00b0',  // °  767: '\u00a9',  // ©
    727: '\u00b6',  // ¶  768: '\u00f0',  // ð
    728: '\u00c7',  // Ç  769: '\u00e9',  // é
    729: '\u00d7',  // ×  773: '\u00ed',  // í
    733: '\u00c1',  // Á  774: '\u00ef',  // ï
    735: '\u00a2',  // ¢  775: '\u0153',  // œ
    736: '\u00d0',  // Ð  776: '\u00f8',  // ø
    737: '\u00c9',  // É  777: '\u00b5',  // µ
    741: '\u00cd',  // Í  778: '\u00f1',  // ñ
    742: '\u00cf',  // Ï  779: '\u00f3',  // ó
    743: '\u0152',  // Œ  782: '\u00eb',  // ë
    744: '\u00d8',  // Ø  784: '\u00fe',  // þ
    745: '\u00b1',  // ±  785: '\u00fa',  // ú
                         786: '\u00ae',  // ®
                         787: '\u00e5',  // å
                         790: '\u00e6',  // æ
                         791: '\u201c',  // "
                         792: '\u00a6',  // ¦
                         793: '\u201d',  // "
  };
  // Convert an array of CharaChorder action codes to a Unicode string.
  // Used when parsing charaVersion:1 chord backup files.
  function decodeActionCodes(arr) {
    if (!Array.isArray(arr)) return '';
    return arr.map(code => {
      if (!code) return '';
      if (code >= 1 && code <= 255) return String.fromCharCode(code);
      return CC_CHAR_MAP[code] ?? '';
    }).join('');
  }
  function codeLabel(code) {
    // Special-key lookup FIRST — must precede range checks so e.g.
    // code 32 (SPACE, ASCII) is not caught by the HID 30–38 range (which maps to '1'–'9').
    // Covers both legacy HID codes (serial format) and CharaChorder action codes (JSON format).
    const sp = {
      // ASCII control codes
      8:'⌫', 9:'Tab', 13:'↵', 27:'Esc',
      // HID keyboard usage codes (serial / old charachorder.io JSON)
      40:'↵', 41:'Esc', 42:'⌫', 43:'Tab', 44:'Spc',
      45:'-', 46:'=', 47:'[', 48:']', 49:'\\', 51:';', 52:"'", 53:'`', 54:',', 55:'.', 56:'/',
      79:'→', 80:'←', 81:'↓', 82:'↑',
      // CharaChorder action codes (charaVersion:1 JSON format)
      32:'Spc', 127:'Del',
      296:'↵', 297:'Esc', 298:'⌫', 299:'Tab', 300:'Spc',
      313:'Caps', 330:'Home', 331:'PgUp', 333:'End', 334:'PgDn',
      335:'→', 336:'←', 337:'↓', 338:'↑',
      // Modifier keys (action codes 512–519)
      512:'⌃', 513:'⇧', 514:'⌥', 515:'⊞',
      516:'⌃', 517:'⇧', 518:'⌥', 519:'⊞',
      // Chording special actions
      536:'Dup', 573:'Cap↑', 574:'Join',
    };
    if (sp[code] !== undefined) return sp[code];
    // HID keyboard usage IDs (CharaChorder Serial / old charachorder.io JSON format)
    if (code >= 4  && code <= 29) return String.fromCharCode(code - 4 + 97); // a–z
    if (code >= 30 && code <= 38) return String.fromCharCode(code - 30 + 49); // 1–9
    if (code === 39) return '0';
    // Printable ASCII (charaVersion:1 uses direct ASCII action codes)
    if (code >= 33 && code <= 126) return String.fromCharCode(code);
    // Latin-1 Supplement 160–255 maps correctly via String.fromCharCode (ä=228, ü=252…)
    if (code >= 160 && code <= 255) return String.fromCharCode(code);
    // CharaChorder F-key action codes (314=F1 … 325=F12, 360=F13 … 371=F24)
    if (code >= 314 && code <= 325) return `F${code - 313}`;
    if (code >= 360 && code <= 371) return `F${code - 347}`;
    // US-International AltGr combos + device-specific extended codes
    if (CC_CHAR_MAP[code]) return CC_CHAR_MAP[code];
    return `#${code}`;
  }
  function formatChordKeys(codes) { return codes?.length ? codes.map(codeLabel).join('+') : ''; }
  /* Sort chord key codes so their labels appear in the order those characters
     occur in the target word.
     Special rules for keys whose label is not found in the word:
       – 'Spc': place after 'd' if 'd' is present in the chord, else at the start.
       – all other absent keys: insert immediately after their left neighbour
         from the original chord order (or append at the end if none). */
  function sortCodesByWordOrder(codes, word) {
    if (!codes?.length) return codes;
    const wl = (word || '').toLowerCase();
    const entries = codes.map((code, origIdx) => {
      const label = codeLabel(code);
      // Only single-char labels can appear in a word
      const pos = label.length === 1 ? wl.indexOf(label.toLowerCase()) : -1;
      return { code, label, origIdx, pos };
    });
    const inWord = entries.filter(e => e.pos >= 0).sort((a, b) => a.pos - b.pos || a.origIdx - b.origIdx);
    const notInWord = entries.filter(e => e.pos < 0); // already in original order
    const result = [...inWord];
    for (const entry of notInWord) {
      if (entry.label === 'Spc') {
        const dIdx = result.findIndex(e => e.label.toLowerCase() === 'd');
        dIdx >= 0 ? result.splice(dIdx + 1, 0, entry) : result.unshift(entry);
      } else {
        // Find closest preceding key (by original index) already placed in result
        let insertPos = -1;
        for (let i = entry.origIdx - 1; i >= 0; i--) {
          const idx = result.findIndex(e => e.origIdx === i);
          if (idx >= 0) { insertPos = idx + 1; break; }
        }
        insertPos >= 0 ? result.splice(insertPos, 0, entry) : result.push(entry);
      }
    }
    return result.map(e => e.code);
  }
  function formatChordKeysForWord(codes, word) { return formatChordKeys(sortCodesByWordOrder(codes, word)); }
  function parseCmlC0(line) {
    const m = String(line||'').trim().match(/^CML\s+C0\s+(\d+)$/);
    return m ? parseInt(m[1],10) : null;
  }
  function parseCmlC1(line) {
    const m = String(line||'').trim().match(/^CML\s+C1\s+(\d+)\s+([0-9A-Fa-f]{32})\s+([0-9A-Fa-f]*)\s+(\d+)$/);
    if (!m) return null;
    return { index:parseInt(m[1],10), inputHex:m[2].toUpperCase(), outputHex:m[3].toUpperCase() };
  }
  function combineSplitLines(lines) {
    const src = lines.map(l=>String(l||'').trim()).filter(Boolean);
    const out = [];
    for (let i=0; i<src.length; i++) {
      const cur=src[i], next=src[i+1];
      if ((cur==='CML C0'||/^CML\s+C1\s+\d+$/.test(cur))&&/^CML\b/.test(next||'')) {
        out.push(`${cur} ${next.replace(/^CML\s*/,'')}`); i++;
      } else out.push(cur);
    }
    return out;
  }
  async function openSession(port) {
    const reader=port.readable.getReader(), writer=port.writable.getWriter();
    const session={reader,writer,decoder:new TextDecoder(),buffer:'',lines:[],waiters:[],closed:false,readError:null};
    session.readTask=(async()=>{
      try { while(true){const{value,done}=await reader.read();if(done)break;if(value)appendChunk(session,value);} appendChunk(session,new Uint8Array(0),true); }
      catch(err){session.readError=err;} finally{session.closed=true;notifyWaiters(session);}
    })();
    return session;
  }
  function appendChunk(session,value,flush=false){
    session.buffer+=session.decoder.decode(value,{stream:!flush});
    const parts=session.buffer.replace(/\r/g,'').split('\n');
    session.buffer=parts.pop()||'';
    let added=false;
    for(const p of parts){const l=p.trim();if(l){session.lines.push(l);added=true;}}
    if(flush&&session.buffer.trim()){session.lines.push(session.buffer.trim());session.buffer='';added=true;}
    if(added)notifyWaiters(session);
  }
  function notifyWaiters(s){s.waiters.splice(0).forEach(r=>r());}
  function waitForSignal(session,ms){
    return new Promise(resolve=>{
      let done=false;
      const w=()=>{clearTimeout(tid);finish(false);};
      const finish=(to)=>{if(done)return;done=true;resolve(to);};
      const tid=setTimeout(()=>{const i=session.waiters.indexOf(w);if(i>=0)session.waiters.splice(i,1);finish(true);},ms);
      session.waiters.push(w);
    });
  }
  async function readUntilMatch(session,startIdx,regex,timeoutMs=5000){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const lines=session.lines.slice(startIdx);
      if(regex&&lines.some(l=>regex.test(l)))return lines;
      if(session.readError)throw session.readError;
      if(session.closed)return lines;
      const timedOut=await waitForSignal(session,Math.max(1,deadline-Date.now()));
      if(timedOut)break;
    }
    if(session.readError)throw session.readError;
    return session.lines.slice(startIdx);
  }
  async function sendCommand(session,cmd,regex,timeoutMs=5000){
    const enc=new TextEncoder().encode(cmd+'\r\n');
    const startIdx=session.lines.length;
    await session.writer.write(enc);
    return readUntilMatch(session,startIdx,regex,timeoutMs);
  }

  const api = {
    isSupported() { return 'serial' in navigator; },
    buildChordMap(entries) {
      const map = {};
      for (const e of entries) {
        if (!e.output || !e.inputCodes?.length) continue;
        /* Strip control chars (0x00–0x1F, 0x7F) but keep Latin-1 printable chars
           (0x80–0xFF) so German words with ä, ü, ö, etc. are preserved as keys. */
        const key = e.output.replace(/[\x00-\x1f\x7f]/g, '').toLowerCase().trim();
        if (!key) continue;
        if (!map[key] || e.inputCodes.length < map[key].keys.length)
          map[key] = { keys: e.inputCodes, display: formatChordKeys(e.inputCodes) };
      }
      return map;
    },
    getHint(word) {
      const stored = Storage.getChordMap();
      if (!stored?.map) return null;
      const entry = stored.map[word.toLowerCase()];
      if (!entry) return null;
      // Recompute from keys so hints are correct even if stored display used old codeLabel
      return entry.keys?.length ? formatChordKeysForWord(entry.keys, word) : (entry.display ?? null);
    },
    getWordList() {
      const stored = Storage.getChordMap();
      if (!stored?.map) return [];
      return Object.keys(stored.map)
        .filter(w => w.length > 0 && !/[\x00-\x1f\x7f]/.test(w))
        .sort();
    },
    async connectAndSync(onProgress) {
      if (!api.isSupported()) throw new Error('Web Serial API not available. Use Chrome or Edge, and serve via https:// or http://localhost (not file://).');
      let port = null;
      try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        await new Promise(r => setTimeout(r, 150));
        const session = await openSession(port);
        onProgress?.('Querying chord count…');
        const countLines = combineSplitLines(await sendCommand(session,'CML C0',/^CML\s+C0\b/,6000));
        const count = parseCmlC0(countLines.find(l=>/^CML\s+C0\b/.test(l)));
        if (!Number.isFinite(count)||count<0) throw new Error('Invalid chord count from device.');
        onProgress?.(`Found ${count} chords. Syncing…`);
        const entries = [];
        for (let i=0; i<count; i++) {
          if (i%100===0) onProgress?.(`Syncing chords… ${i}/${count}`);
          const re = new RegExp(`^CML\\s+C1\\s+${i}\\b`);
          const lines = combineSplitLines(await sendCommand(session,`CML C1 ${i}`,re,5000));
          const parsed = parseCmlC1(lines.find(l=>re.test(l)));
          if (!parsed) continue;
          const inputCodes = decodeInputHex(parsed.inputHex);
          const output     = decodeOutputHex(parsed.outputHex);
          if (output) entries.push({inputCodes,output});
        }
        try{session.reader.releaseLock();}catch{}
        try{session.writer.releaseLock();}catch{}
        try{await port.close();}catch{}
        const map = api.buildChordMap(entries);
        const stored = {source:'serial',syncedAt:Date.now(),entryCount:entries.length,map};
        Storage.saveChordMap(stored);
        onProgress?.(`Done! Loaded ${entries.length} chords.`);
        return stored;
      } catch(err){try{await port?.close();}catch{}throw err;}
    },
    importFromJson(json) {
      const data = JSON.parse(json);
      let entries = [];
      /* Unified entry converter — handles every known field-name variant.
         decodeOutputHex now handles both hex-encoded AND plain-text output fields. */
      const toEntry = (obj) => ({
        inputCodes: obj.inputCodes || decodeInputHex(obj.inputHex || obj.chord || obj.input || ''),
        output: decodeOutputHex(obj.outputHex || obj.phrase || obj.output || obj.result || ''),
      });
      if      (data.entries && Array.isArray(data.entries))  entries = data.entries.map(toEntry);
      else if (data.chords  && Array.isArray(data.chords)) {
        if (data.chords.length > 0 && Array.isArray(data.chords[0])) {
          // charaVersion:1 format: chords is [[inputActionCodes, outputActionCodes], ...]
          entries = data.chords.map(c => ({
            inputCodes: c[0].filter(x => x !== 0),
            output: decodeActionCodes(c[1]),
          }));
        } else {
          entries = data.chords.map(toEntry);
        }
      }
      else if (data.library && Array.isArray(data.library))  entries = data.library.map(toEntry);
      else if (Array.isArray(data))                          entries = data.map(toEntry);
      else if (typeof data === 'object') {
        for (const [word,val] of Object.entries(data)) {
          if (Array.isArray(val)) entries.push({inputCodes:val,output:word});
          else if (typeof val==='string') entries.push({inputCodes:val.split('+').map(k=>k.charCodeAt(0)),output:word});
        }
      }
      if (!entries.length) throw new Error('No chord entries found. Supported formats: charachorder.io Library JSON, CharaChorder backup JSON.');
      const map = api.buildChordMap(entries);
      const mapSize = Object.keys(map).length;
      if (!mapSize) {
        const sample = entries.slice(0,3).map(e=>`codes=[${e.inputCodes}] out="${e.output}"`).join('; ');
        throw new Error(`Parsed ${entries.length} entries but produced 0 usable chords. First entries: ${sample}`);
      }
      const stored={source:'json',syncedAt:Date.now(),entryCount:entries.length,mapSize,map};
      Storage.saveChordMap(stored);
      return stored;
    },
  };
  return api;
})();


/* ============================================================
   UTILITIES
   ============================================================ */
function avgArr(arr) { return (!arr?.length)?0:arr.reduce((s,v)=>s+v,0)/arr.length; }
function calcWpm(chars,ms){ return (!ms||ms<=0)?0:Math.round((chars/5)/(ms/60000)); }
function fmtMs(ms)  { return ms!=null?Math.round(ms)+' ms':'—'; }
function fmtChordTime(ms) {
  if (ms==null) return '—';
  return ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(2)+' s';
}
function fmtDuration(ms){
  const s=Math.floor(ms/1000),m=Math.floor(s/60);
  return m>0?`${m}m ${s%60}s`:`${s}s`;
}
function fmtPracticeTime(ms){
  if(!ms||ms<=0)return'0 min';
  const totalMin=Math.floor(ms/60000);
  if(totalMin<60)return totalMin+' min';
  const h=Math.floor(totalMin/60),m=totalMin%60;
  return m>0?`${h}h ${m}m`:`${h}h`;
}
function fmtRelative(ts){
  if(!ts)return'Never';
  const d=Math.floor((Date.now()-ts)/86400000);
  if(d===0)return'Today';if(d===1)return'Yesterday';
  if(d<7)return`${d}d ago`;if(d<30)return`${Math.floor(d/7)}w ago`;
  return`${Math.floor(d/30)}mo ago`;
}
function fmtDue(ts){
  if(!ts)return'—';
  if(ts<=Date.now())return'<span style="color:var(--ok)">Now</span>';
  const delta=ts-Date.now();
  const MIN=60000;
  const HOUR=60*MIN;
  const DAY=24*HOUR;

  if(delta<MIN)return'in 1 min';
  if(delta<1*HOUR){
    const mins=Math.ceil(delta/MIN);
    return`in ${mins} min`;
  }
  if(delta<1*DAY){
    const hrs=Math.ceil(delta/HOUR);
    return`in ${hrs}h`;
  }
  const days=Math.ceil(delta/DAY);
  return`in ${days}d`;
}
function escHtml(str){
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function parseWords(text,sep){
  let parts;
  if(sep==='auto')parts=text.split(/[\s,;]+/);
  else if(sep==='\n')parts=text.split(/\r?\n/);
  else if(sep==='\t')parts=text.split(/\t/);
  else parts=text.split(sep);
  return[...new Set(parts.map(w=>w.trim()).filter(w=>w.length>0))];
}
function shuffle(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2);}
function renderSparkline(history,color='#58a6ff',label=''){
  if(!history?.length)return`<span style="font-size:.75rem;color:var(--txt2)">No data yet</span>`;
  const W=290,H=100,padL=42,padR=6,padT=10,padB=10;
  const vals=history.slice(-60);
  const max=Math.max(...vals,1),min=Math.min(...vals);
  const rng=max-min||1;
  const plotW=W-padL-padR,plotH=H-padT-padB;
  const toX=i=>padL+(i/Math.max(vals.length-1,1))*plotW;
  const toY=v=>padT+(1-(v-min)/rng)*plotH;
  const pts=vals.map((v,i)=>`${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const lx=toX(vals.length-1),ly=toY(vals[vals.length-1]);
  const dark=document.documentElement.dataset.theme!=='light';
  const gc=dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.08)';
  const tc=dark?'#8b949e':'#636c76';
  const mid=Math.round((max+min)/2);
  const ticks=[{v:max,y:toY(max)},{v:mid,y:toY(mid)},{v:min,y:toY(min)}];
  const gridLines=ticks.map(({y})=>`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W-padR}" y2="${y.toFixed(1)}" stroke="${gc}" stroke-width="1"/>`).join('');
  const yLabels=ticks.map(({v,y})=>`<text x="${padL-4}" y="${(y+3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="${tc}">${v}</text>`).join('');
  return`<div style="display:inline-flex;flex-direction:column;align-items:flex-start;gap:3px">
    <span style="font-size:.72rem;color:var(--txt2);font-weight:500">${escHtml(label)}</span>
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:visible">
      ${gridLines}
      ${yLabels}
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H-padB}" stroke="${tc}" stroke-width="1" opacity="0.5"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" fill="${color}"/>
    </svg>
  </div>`;
}


/* ============================================================
   MAIN APP
   ============================================================ */
const App = (() => {
  /* ── Practice state ── */
  const PS = {
    mode:'adaptive', word:null,
    shownAt:0, firstKeyAt:null,
    hadRetry:false, hadWrongWord:false,
    retryCount:0, lastLen:0, waiting:false,
    streak:0, sCorrect:0, sTotal:0,
    graceUntil:0,
    totalPausedMs:0, lastActivityAt:0,
    matchTimeout:null, matchedAt:0, lastChordAt:0,
    hintShown:false, hintTimer:null,
    afkTimer:null, wasAfk:false,
    wrongDetectTimer:null, lastTypedAt:0,
  };

  /* ── Test state ── */
  const TS = {
    words:[], idx:0, results:[], running:false, source:'all',
    shownAt:0, firstKeyAt:null,
    hadRetry:false, hadWrongWord:false, hadBackspace:false, hadWrongPress:false,
    lastLen:0, prevConfirmedAt:null,
    globalStart:0, lastConfirmedAt:0,
    totalPausedMs:0, wordPausedMs:0, lastActivityAt:0,
    lastMatchWord:null, lastMatchAt:0, lastChordAt:0,
    hintTimer:null,
  };

  let wordSetEditId=null, wordSetSep='auto', confirmCb=null, wpmChart=null, testWpmChart=null, dragSrcId=null;
  const $=id=>document.getElementById(id);

  function cmp(a,b){
    const s=Storage.getSettings();
    return s.caseInsensitive?a.toLowerCase()===b.toLowerCase():a===b;
  }

  /* Returns true when the active hint modes include `mode`.
     Works with both the new hintModes array and the legacy hintMode string. */
  function isHintActive(s, mode) {
    return (s.hintModes ?? (s.hintMode ? [s.hintMode] : ['wrong'])).includes(mode);
  }

  /* Helper: is val the "trailing backspace" remnant of target?
     Returns true when target.startsWith(val) and val is exactly one char shorter.
     This fires when the CharaChorder outputs "word\b" and the browser processes
     the backspace before we can read the exact match. */
  function isTrailingBs(val, target, ci) {
    if (!val || val.length === 0) return false;
    if (val.length !== target.length - 1) return false;
    return ci
      ? target.toLowerCase().startsWith(val.toLowerCase())
      : target.startsWith(val);
  }

  /* ============================================================
     THEME
  ============================================================ */
  function applyTheme(t){
    document.documentElement.dataset.theme=t;
    $('themeToggle').textContent=t==='dark'?'☀':'🌙';
    $('themeDarkBtn').classList.toggle('active',t==='dark');
    $('themeLightBtn').classList.toggle('active',t==='light');
    const s=Storage.getSettings();s.theme=t;Storage.saveSettings(s);
    if(document.querySelector('#tab-stats.active'))renderStats();
  }

  /* ============================================================
     TAB SWITCHING
  ============================================================ */
  function switchTab(tab){
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
    document.querySelectorAll('.tab-content').forEach(s=>s.classList.toggle('active',s.id===`tab-${tab}`));
    if(tab==='practice'){refreshPracticeHeader();setTimeout(()=>$('practiceInput')?.focus(),80);}
    if(tab==='test'){refreshTestHeader();if(TS.running)setTimeout(()=>$('testInput')?.focus(),80);}
    if(tab==='stats')renderStats();
    if(tab==='wordsets')renderWordSets();
    if(tab==='settings')renderSettings();
  }

  /* ============================================================
     HINT TIMER
  ============================================================ */
  function startHintTimer(stateObj, elId, word) {
    clearHintTimer(stateObj);
    const settings = Storage.getSettings();
    if (!isHintActive(settings, 'delay')) return;
    const delay = Math.max(500, (settings.hintDelaySeconds || 3) * 1000);
    stateObj.hintTimer = setTimeout(() => {
      stateObj.hintTimer = null;
      if (!stateObj.waiting) {
        setHintEl(elId, word);
        stateObj.hintShown = true; // flag so attempt is marked as correction
      }
    }, delay);
  }
  function clearHintTimer(stateObj) {
    if (stateObj.hintTimer) { clearTimeout(stateObj.hintTimer); stateObj.hintTimer = null; }
  }

  /* ============================================================
     PRACTICE
  ============================================================ */

  /* Returns the word pool for non-SR modes.
     wrong: top N words by lowest accuracy (worst first).
     slow:  top N words by highest avg chord time.
     random/adaptive: all words unchanged. */
  function getEffectivePool(words, mode) {
    if (mode === 'adaptive' || mode === 'random') return words;
    const all = Storage.getAllWordStats();
    const settings = Storage.getSettings();
    if (mode === 'wrong') {
      const n = Math.max(1, settings.wrongTopN ?? 20);
      return [...words]
        .sort((a, b) => {
          const sa = all[a], sb = all[b];
          // Words with no attempts treated as worst (0 accuracy)
          const accA = sa?.attempts ? sa.correctFirstTry / sa.attempts : 0;
          const accB = sb?.attempts ? sb.correctFirstTry / sb.attempts : 0;
          return accA - accB; // ascending — worst first
        })
        .slice(0, n);
    }
    if (mode === 'slow') {
      const n = Math.max(1, settings.slowTopN ?? 20);
      const withData    = words.filter(w =>  all[w]?.chordTimeHistory?.length)
        .sort((a, b) => avgArr(all[b].chordTimeHistory) - avgArr(all[a].chordTimeHistory));
      const withoutData = words.filter(w => !all[w]?.chordTimeHistory?.length);
      return [...withData, ...withoutData].slice(0, n);
    }
    return words;
  }

  /* Renders mode-specific quick settings below the mode buttons. */
  function renderQuickSettings(mode) {
    const el = $('practiceQuickSettings');
    if (!el) return;
    const settings = Storage.getSettings();
    if (mode === 'wrong') {
      el.innerHTML = `<div class="quick-settings-row">
        <span class="label">Show worst</span>
        <input id="psWrongTopN" class="input-small input-tiny" type="number" min="1" max="9999" value="${settings.wrongTopN ?? 20}">
        <span class="label">words by accuracy</span>
      </div>`;
      $('psWrongTopN')?.addEventListener('change', e => {
        const s = Storage.getSettings();
        s.wrongTopN = Math.max(1, parseInt(e.target.value) || 20);
        Storage.saveSettings(s);
        PS.word = null; nextPracticeWord();
      });
    } else if (mode === 'slow') {
      el.innerHTML = `<div class="quick-settings-row">
        <span class="label">Show worst</span>
        <input id="psSlowTopN" class="input-small input-tiny" type="number" min="1" max="9999" value="${settings.slowTopN ?? 20}">
        <span class="label">words by chord time</span>
      </div>`;
      $('psSlowTopN')?.addEventListener('change', e => {
        const s = Storage.getSettings();
        s.slowTopN = Math.max(1, parseInt(e.target.value) || 20);
        Storage.saveSettings(s);
        PS.word = null; nextPracticeWord();
      });
    } else {
      el.innerHTML = '';
    }
  }

  function refreshPracticeHeader(){
    const words=Storage.getActiveWords();
    const data=Storage.getWordSets();
    const activeIds=data.activeIds??[];
    const activeSets=data.sets.filter(s=>activeIds.includes(s.id));
    if(activeSets.length===0)$('practiceActiveSetName').textContent='None';
    else if(activeSets.length===1)$('practiceActiveSetName').textContent=activeSets[0].name;
    else $('practiceActiveSetName').textContent=activeSets.map(s=>s.name).join(', ');
    $('practiceWordCount').textContent=activeSets.length?`(${words.length} words)`:'';
    const hasWords=words.length>0;
    $('noWordSetMsg').classList.toggle('hidden',hasWords);
    $('practiceContent').classList.toggle('hidden',!hasWords);
    $('practiceFinished').classList.add('hidden');
    if(hasWords&&!PS.word)nextPracticeWord();
    else if(hasWords&&PS.word){
      /* Returning to Practice after changing settings — refresh hint for current word */
      const settings=Storage.getSettings();
      if(isHintActive(settings,'always'))setHintEl('practiceHint',PS.word,true);
    }
  }

  function setPracticeMode(mode){
    PS.mode=mode;
    document.querySelectorAll('#practiceModeBtns .mode-btn').forEach(b=>
      b.classList.toggle('active',b.dataset.mode===mode));
    renderQuickSettings(mode);
    PS.word=null;
    nextPracticeWord();
  }

  function checkAllDone(words){
    const all=Storage.getAllWordStats(),now=Date.now();
    return words.length>0&&words.every(w=>{const s=all[w];return s&&s.attempts>0&&s.due>now;});
  }

  function nextPracticeWord(){
    const allWords=Storage.getActiveWords();
    if(!allWords.length)return;
    const settings=Storage.getSettings();
    if(PS.mode==='adaptive'&&checkAllDone(allWords)){showPracticeFinished();return;}
    const pool=getEffectivePool(allWords,PS.mode);
    const w=Adaptive.getNextWord(pool,PS.mode,PS.word,settings);
    PS.word=w;PS.shownAt=Date.now();PS.firstKeyAt=null;
    PS.hadRetry=false;PS.hadWrongWord=false;PS.retryCount=0;
    PS.lastLen=0;PS.waiting=false;
    PS.graceUntil=Date.now()+200;
    PS.totalPausedMs=0;PS.lastActivityAt=0;
    PS.matchedAt=0;PS.lastChordAt=0;PS.hintShown=false;
    PS.lastTypedAt=0;
    if(PS.wrongDetectTimer){clearTimeout(PS.wrongDetectTimer);PS.wrongDetectTimer=null;}
    if(PS.matchTimeout){clearTimeout(PS.matchTimeout);PS.matchTimeout=null;}
    clearHintTimer(PS);
    // AFK timer: if no activity for afkThresholdSeconds, exclude this attempt from stats
    if(PS.afkTimer){clearTimeout(PS.afkTimer);PS.afkTimer=null;}
    PS.wasAfk=false;
    const _nextAfkMs=(Storage.getSettings().afkThresholdSeconds??5)*1000;
    PS.afkTimer=setTimeout(()=>{PS.afkTimer=null;PS.wasAfk=true;},_nextAfkMs);

    $('wordDisplay').textContent=w;
    $('wordDisplay').className='word-display';
    $('practiceInput').value='';
    $('practiceInput').className='word-input';
    $('wordResult').classList.add('hidden');
    $('practiceFinished').classList.add('hidden');
    setHintEl('practiceHint',null);
    if(isHintActive(settings,'always')) setHintEl('practiceHint',w,true);
    else if(isHintActive(settings,'delay')) startHintTimer(PS,'practiceHint',w);
    updateChordDisplay(w,'practiceChordDisplay');
    $('practiceInput').focus();
  }

  function showPracticeFinished(){
    PS.word=null;PS.waiting=false;
    clearHintTimer(PS);
    $('practiceContent').classList.add('hidden');
    $('practiceFinished').classList.remove('hidden');
    checkBackupReminder();
  }

  function onPracticeInput(e){
    if(PS.waiting)return;
    const val=e.target.value,target=PS.word;
    if(!target)return;
    const now=Date.now();
    const settings=Storage.getSettings();
    const ci=settings.caseInsensitive;
    /* valTrim: trailing spaces come from chords that include a Space in their output
       (e.g. CharaChorder outputs "word "). Trim so matching works correctly. */
    const valTrim=val.trimEnd();

    // Guard: if target is merely a prefix of what's typed, cancel any pending match.
    // Prevents e.g. target="we" being confirmed while user is still choriding "were".
    if (valTrim.length > target.length) {
      const startsWith = ci
        ? valTrim.toLowerCase().startsWith(target.toLowerCase())
        : valTrim.startsWith(target);
      if (startsWith) {
        PS.matchedAt = 0;
        if (PS.matchTimeout) { clearTimeout(PS.matchTimeout); PS.matchTimeout = null; }
      }
    }

    // AFK timer: reset on any activity
    if(PS.afkTimer){clearTimeout(PS.afkTimer);PS.afkTimer=null;}
    if(!PS.wasAfk){
      const afkMs=(settings.afkThresholdSeconds??5)*1000;
      PS.afkTimer=setTimeout(()=>{PS.afkTimer=null;PS.wasAfk=true;},afkMs);
    }

    // Pause detection
    const _afkMs=(settings.afkThresholdSeconds??5)*1000;
    if(PS.lastActivityAt>0){
      const gap=now-PS.lastActivityAt;
      if(gap>_afkMs){
        PS.totalPausedMs+=gap-_afkMs;
        if(PS.firstKeyAt===null)PS.shownAt+=gap-_afkMs;
      }
    } else if(PS.firstKeyAt===null){
      // No activity yet — check gap from when word was shown
      const gap=now-PS.shownAt;
      if(gap>_afkMs){const excess=gap-_afkMs;PS.totalPausedMs+=excess;PS.shownAt+=excess;}
    }
    PS.lastActivityAt=now;

    // Grace window for brand-new word: swallow any immediate backspace
    if(val.length<PS.lastLen&&now<PS.graceUntil&&PS.firstKeyAt===null){
      PS.lastLen=val.length;return;
    }

    // First real keystroke
    if(val.length>PS.lastLen&&PS.firstKeyAt===null)PS.firstKeyAt=now;

    const lenJump=val.length-PS.lastLen;
    PS.lastLen=val.length;
    // Track last time input grew — device corrections always produce recent typing
    if(lenJump>0) PS.lastTypedAt=now;

    // Full wipe → re-attempt (device correction wipes <300ms after last typed char)
    if(val.length===0&&lenJump<0&&PS.firstKeyAt!==null){
      if(now-PS.lastTypedAt>300){PS.hadRetry=true;PS.retryCount++;}
      if(now-PS.matchedAt>200){PS.matchedAt=0;}
    }

    // Reset hint delay timer on any keystroke
    if(isHintActive(settings,'delay'))startHintTimer(PS,'practiceHint',target);

    // Wrong chord — debounced 200ms: device auto-corrections clear the timer before it fires
    if(PS.wrongDetectTimer){clearTimeout(PS.wrongDetectTimer);PS.wrongDetectTimer=null;}
    if(valTrim.length>0&&!cmp(valTrim,target)){
      const snapWord=PS.word,snapSettings=settings;
      PS.wrongDetectTimer=setTimeout(()=>{
        PS.wrongDetectTimer=null;
        if(PS.waiting)return;
        const cur=$('practiceInput').value.trimEnd();
        if(cur.length>0&&!cmp(cur,snapWord)){
          PS.hadWrongWord=true;
          if(!PS.hintShown&&isHintActive(snapSettings,'wrong')){
            setHintEl('practiceHint',snapWord);PS.hintShown=true;
          }
        }
      },200);
    }

    /* Match detection:
       - Exact match (including chord with trailing space): always confirm
       - Atomic trailing-bs (case A): chord jumped >= (target.length-1) chars directly
         into trailing-bs state — browser processed "word\b" as net "wor" in one event
       - Trailing-bs after exact (case B): exact match seen < 500ms ago, now one char shorter
       Never fire on gradual manual typing that happens to reach target.length-1 chars. */
    const exact=cmp(valTrim,target);
    const chordThreshold=Math.max(2,target.length-1);
    const atomicChordBs=lenJump>=chordThreshold&&isTrailingBs(valTrim,target,ci);

    if(exact){
      PS.matchedAt=now;
      if(PS.matchTimeout)clearTimeout(PS.matchTimeout);
      PS.matchTimeout=setTimeout(()=>{
        PS.matchTimeout=null;
        if(PS.waiting)return;
        const cur=$('practiceInput').value.trimEnd();
        const elapsed=Date.now()-PS.matchedAt;
        /* Accept: still exact, OR trailing-bs within 500ms of exact match (chord "word\b" case B). */
        if(cmp(cur,target)||(PS.matchedAt>0&&elapsed<500&&isTrailingBs(cur,target,ci)))
          handlePracticeMatch(target);
      },80);
    }else if(atomicChordBs){
      /* Chord jumped directly into trailing-bs state — case A. */
      PS.matchedAt=now;PS.lastChordAt=now;
      if(PS.matchTimeout)clearTimeout(PS.matchTimeout);
      PS.matchTimeout=setTimeout(()=>{
        PS.matchTimeout=null;
        if(PS.waiting)return;
        handlePracticeMatch(target);
      },80);
    }
  }

  function handlePracticeMatch(target){
    PS.waiting=true;
    PS.graceUntil=Date.now()+600;
    clearHintTimer(PS);
    // Cancel AFK timer — user is active
    if(PS.afkTimer){clearTimeout(PS.afkTimer);PS.afkTimer=null;}
    const now=Date.now();
    const delay=PS.firstKeyAt?PS.firstKeyAt-PS.shownAt:null;
    const chordTime=Math.max(0,(now-PS.shownAt)-PS.totalPausedMs);
    const settings=Storage.getSettings();
    // hintShown flags the attempt as a correction even if no wrong chord was typed
    const hadRetry=PS.hadRetry||PS.hadWrongWord||PS.hintShown;
    const wasAfk=PS.wasAfk;

    $('wordDisplay').classList.add('state-correct','anim-ok');
    $('practiceInput').classList.add('state-ok');

    if(!wasAfk){
      // Normal attempt — record stats and update streak
      if(!hadRetry){PS.streak++;PS.sCorrect++;}else{PS.streak=0;}
      PS.sTotal++;
      updateStreakDisplay();
      const quality=Adaptive.calcQuality(hadRetry,chordTime,settings);
      showWordResult(delay,chordTime,hadRetry);
      if(PS.mode==='adaptive'){
        Storage.updateWordResult(target,{
          correct:true,hadRetry,delay,chordTime:chordTime>0?chordTime:null,quality,
        });
      }else{
        Storage.updateWordStatsOnly(target,{
          correct:true,hadRetry,delay,chordTime:chordTime>0?chordTime:null,
        });
      }
      Storage.addPracticeMs(chordTime>0?chordTime:0);
    } else {
      // AFK attempt — show result info but don't record stats
      showWordResult(delay,chordTime,hadRetry);
    }
    setTimeout(nextPracticeWord,settings.autoAdvanceDelay??600);
  }

  function skipWord(){
    if(PS.waiting||!PS.word)return;
    if(PS.matchTimeout){clearTimeout(PS.matchTimeout);PS.matchTimeout=null;}
    clearHintTimer(PS);
    if(PS.afkTimer){clearTimeout(PS.afkTimer);PS.afkTimer=null;}
    PS.streak=0;PS.sTotal++;
    updateStreakDisplay();
    $('wordDisplay').classList.add('state-wrong','anim-err');
    if(PS.mode==='adaptive'){
      Storage.updateWordResult(PS.word,{skipped:true});
    }else{
      Storage.updateWordStatsOnly(PS.word,{skipped:true});
    }
    // Focus input immediately so subsequent keypresses don't re-trigger the Skip button
    $('practiceInput').focus();
    setTimeout(nextPracticeWord,450);
  }

  function showWordResult(delay,chordTime,hadRetry){
    $('resultDelay').textContent=delay!=null?fmtMs(delay):'—';
    $('resultChordTime').textContent=chordTime!=null?fmtChordTime(chordTime):'—';
    $('resultCorrection').textContent=hadRetry?'⚠ Yes':'✓ No';
    const stat=Storage.getWordStat(PS.word);
    $('resultAttempts').textContent=stat?stat.attempts:1;
    $('wordResult').classList.remove('hidden');
  }

  function updateStreakDisplay(){
    $('streakCount').textContent=PS.streak;
    $('sessionCorrect').textContent=PS.sCorrect;
    $('sessionTotal').textContent=PS.sTotal;
    const pct=PS.sTotal>0?Math.round((PS.sCorrect/PS.sTotal)*100)+'%':'';
    $('sessionAccuracy').textContent=pct?`(${pct})`:'';
  }

  function setHintEl(id,word,alwaysMode=false){
    const el=$(id);if(!el)return;
    if(!word){el.innerHTML='';el.classList.add('hidden');return;}
    const hint=CC.getHint(word);
    if(hint){
      el.innerHTML=`<div class="hint-box">⌨ Chord hint: <span class="hint-keys">${escHtml(hint)}</span></div>`;
      el.classList.remove('hidden');
    }else if(alwaysMode&&!Storage.getChordMap()){
      el.innerHTML='<div class="hint-box hint-box-dim">⌨ No chord map loaded — <a href="#" onclick="App.switchTab(\'settings\');return false" style="color:inherit;text-decoration:underline">load one in Settings</a> for hints</div>';
      el.classList.remove('hidden');
    }else{
      el.innerHTML='';el.classList.add('hidden');
    }
  }

  /* Permanent chord display — always shows the chord for the current word,
     completely independent of hint settings or timing conditions. */
  function updateChordDisplay(word, elId) {
    const el = $(elId); if (!el) return;
    // If visual hints are enabled (wrong/delay/always), avoid rendering the
    // permanent chord display to prevent showing the same hint twice.
    try {
      const settings = Storage.getSettings();
      if (!settings || !isHintActive(settings, 'never')) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    } catch (e) { /* ignore and proceed to render if settings unavailable */ }
    if (!word) { el.innerHTML = ''; return; }
    const stored = Storage.getChordMap();
    if (!stored?.map) {
      el.innerHTML = '<span class="cdsp-none">no chord map loaded — import one in <a href="#" onclick="App.switchTab(\'settings\');return false">Settings</a></span>';
      return;
    }
    const entry = stored.map[word.toLowerCase()];
    if (!entry) { el.innerHTML = '<span class="cdsp-none">no chord mapped for this word</span>'; return; }
    const keys = CC.getHint(word) ?? (entry.display ?? '');
    if (!keys) { el.innerHTML = '<span class="cdsp-none">chord has no keys</span>'; return; }
    el.innerHTML = `⌨ <span class="cdsp-keys">${escHtml(keys)}</span>`;
  }

  function lookupChordForWord(word) {
    const result = $('chordLookupResult'); if (!result) return;
    if (!word) { result.innerHTML = ''; return; }
    const stored = Storage.getChordMap();
    if (!stored?.map) { result.innerHTML = '<span style="color:var(--warn)">No chord map loaded.</span>'; return; }
    const entry = stored.map[word.toLowerCase()];
    if (!entry) { result.innerHTML = `<span style="color:var(--txt2)">“${escHtml(word)}” not in chord map.</span>`; return; }
    const keys = CC.getHint(word) ?? (entry.display ?? '?');
    result.innerHTML = `<div style="margin:.25rem 0"><span class="cdsp-keys" style="font-size:1rem">${escHtml(keys)}</span></div><div style="font-size:.72rem;opacity:.55">Raw codes: ${escHtml(JSON.stringify(entry.keys??[]))}</div>`;
  }

  function toggleChordSample() {
    const el = $('chordSampleTable'), btn = $('showSampleBtn'); if (!el||!btn) return;
    if (!el.classList.contains('hidden')) {
      el.classList.add('hidden'); btn.textContent = 'Show first 20 entries ▾'; return;
    }
    const stored = Storage.getChordMap();
    if (!stored?.map) { el.textContent = 'No chord map.'; el.classList.remove('hidden'); return; }
    const rows = Object.entries(stored.map).slice(0,20).map(([w,e]) => {
      const keys = e.keys?.length ? formatChordKeys(e.keys) : (e.display ?? '?');
      return `<tr><td>${escHtml(w)}</td><td><span class="cdsp-keys">${escHtml(keys)}</span></td><td style="opacity:.5;font-size:.7rem">${escHtml(JSON.stringify(e.keys??[]))}</td></tr>`;
    }).join('');
    el.innerHTML = `<table class="data-table" style="font-size:.82rem"><thead><tr><th>Word</th><th>Keys</th><th>Raw codes</th></tr></thead><tbody>${rows}</tbody></table>`;
    el.classList.remove('hidden'); btn.textContent = 'Hide ▴';
  }

  /* ============================================================
     TEST — Monkeytype style
     Words shown in block; Space confirms each word.
     Backspace freely corrects before confirming.
  ============================================================ */
  function refreshTestHeader(){
    $('testActiveSetName').textContent=Storage.getActiveSetName();
    $('testWordCount').value=Storage.getSettings().testWordCount;
  }

  function setTestSource(source){
    TS.source=source;
    document.querySelectorAll('#testSourceBtns .mode-btn').forEach(b=>
      b.classList.toggle('active',b.dataset.source===source));
  }

  function startTest(){
    const allWords=Storage.getActiveWords();
    if(!allWords.length){alert('Please create and activate a word set first.');return;}
    const settings=Storage.getSettings();
    const count=Math.min(parseInt($('testWordCount').value)||20,allWords.length);
    const all=Storage.getAllWordStats();
    const now=Date.now();
    const t=settings.slowChordTimeThreshold??3000;
    let pool=[...allWords];
    switch(TS.source){
      case'due':   pool=allWords.filter(w=>{const s=all[w];return!s||s.attempts===0||s.due<=now;});break;
      case'slow':  pool=allWords.filter(w=>{const s=all[w];return!s?.chordTimeHistory?.length||avgArr(s.chordTimeHistory)>t;});break;
      case'wrong': pool=allWords.filter(w=>{const s=all[w];return!s||s.attempts===0||(s.correctFirstTry/s.attempts)<0.7;});break;
    }
    if(!pool.length)pool=[...allWords];
    const words=shuffle(pool).slice(0,count);
    Object.assign(TS,{
      words,idx:0,results:[],running:true,
      shownAt:0,firstKeyAt:null,hadRetry:false,hadWrongWord:false,hadBackspace:false,hadWrongPress:false,
      lastLen:0,prevConfirmedAt:null,
      globalStart:0,lastConfirmedAt:0,
      totalPausedMs:0,wordPausedMs:0,lastActivityAt:0,
      lastMatchWord:null,lastMatchAt:0,lastChordAt:0,hintTimer:null,
    });
    $('testSetup').classList.add('hidden');
    $('testResults').classList.add('hidden');
    $('testRunning').classList.remove('hidden');
    $('testTotal').textContent=words.length;
    renderTestWordBlock();
    loadTestWord();
    setTimeout(()=>$('testInput').focus(),80);
  }

  function renderTestWordBlock(){
    const block=$('testWordBlock');if(!block)return;
    block.innerHTML=TS.words.map((w,i)=>
      `<span class="tw-${i===0?'current':'pending'}" data-idx="${i}">${escHtml(w)}</span>`
    ).join(' ');
  }

  function updateTestWordBlock(){
    const block=$('testWordBlock');if(!block)return;
    block.querySelectorAll('span').forEach((span,i)=>{
      if(i<TS.idx){
        if(!span.classList.contains('tw-done-correct')&&!span.classList.contains('tw-done-wrong')&&!span.classList.contains('tw-done-corrected'))
          span.className='tw-done-correct';
      } else if(i===TS.idx){
        span.className='tw-current';
        span.textContent=TS.words[i];
      } else {
        span.className='tw-pending';
      }
    });
    const cur=block.querySelector('.tw-current');
    if(cur)cur.scrollIntoView({block:'nearest',behavior:'smooth'});
  }

  function loadTestWord(){
    const w=TS.words[TS.idx];
    TS.shownAt=Date.now();TS.firstKeyAt=null;
    TS.hadRetry=false;TS.hadWrongWord=false;TS.hadBackspace=false;TS.hadWrongPress=false;TS.lastLen=0;
    TS.wordPausedMs=0;TS.lastActivityAt=0;
    TS.lastMatchWord=null;TS.lastMatchAt=0;TS.lastChordAt=0;
    clearHintTimer(TS);
    $('testInput').value='';$('testInput').className='word-input';
    $('testCurrent').textContent=TS.idx+1;
    $('testProgressFill').style.width=(TS.idx/TS.words.length*100)+'%';
    updateTestWordBlock();
    setHintEl('testHint',null);
    const settings=Storage.getSettings();
    if(isHintActive(settings,'always'))setHintEl('testHint',w,true);
    else if(isHintActive(settings,'delay'))startHintTimer(TS,'testHint',w);
    updateChordDisplay(w,'testChordDisplay');
  }

  function updateTestWordLive(val,target){
    const block=$('testWordBlock');
    const span=block?.querySelector('.tw-current');
    if(!span)return;
    if(!val){span.textContent=target;return;}
    let html='';
    for(let i=0;i<target.length;i++){
      const ch=escHtml(target[i]);
      if(i>=val.length)            html+=`<span class="tw-char-untyped">${ch}</span>`;
      else if(val[i]===target[i])  html+=`<span class="tw-char-ok">${ch}</span>`;
      else                         html+=`<span class="tw-char-wrong">${ch}</span>`;
    }
    if(val.length>target.length){
      for(let i=target.length;i<val.length;i++)
        html+=`<span class="tw-char-extra">${escHtml(val[i])}</span>`;
    }
    span.innerHTML=html;
  }

  function markTestWord(idx,firstTry){
    const block=$('testWordBlock');
    const span=block?.querySelector(`span[data-idx="${idx}"]`);
    if(!span)return;
    span.className=firstTry?'tw-done-correct':'tw-done-corrected';
    span.textContent=TS.words[idx];
  }

  function onTestInput(e){
    if(!TS.running)return;
    const val=e.target.value,target=TS.words[TS.idx];
    if(!target)return;
    const now=Date.now();
    const settings=Storage.getSettings();
    const ci=settings.caseInsensitive;

    // First-keystroke detection
    const isFirstKeystroke=val.length>TS.lastLen&&TS.firstKeyAt===null;
    const startingTestNow=isFirstKeystroke&&TS.idx===0&&TS.globalStart===0;

    if(startingTestNow){
      // Word 0, first keypress: start the test clock here, discard pre-typing wait
      TS.globalStart=now;
      TS.shownAt=now;
      TS.wordPausedMs=0;
      TS.firstKeyAt=now;
    } else {
      // Pause detection
      if(TS.lastActivityAt>0){
        const gap=now-TS.lastActivityAt;
        const afkMs=(settings.afkThresholdSeconds??5)*1000;
        if(gap>afkMs){
          const excess=gap-afkMs;
          TS.wordPausedMs+=excess;TS.totalPausedMs+=excess;
          if(TS.firstKeyAt===null)TS.shownAt+=excess;
        }
      } else if(TS.firstKeyAt===null){
        const gap=now-TS.shownAt;
        const afkMs=(settings.afkThresholdSeconds??5)*1000;
        if(gap>afkMs){const excess=gap-afkMs;TS.wordPausedMs+=excess;TS.totalPausedMs+=excess;TS.shownAt+=excess;}
      }
      if(isFirstKeystroke) TS.firstKeyAt=now;
    }
    TS.lastActivityAt=now;

    // Manual clear (full wipe via backspace) — reset match memory only
    if(val.length===0&&TS.lastLen>0&&TS.firstKeyAt!==null){
      // Only invalidate lastMatchWord if it's been >300ms (not a trailing-bs wipe)
      if(now-TS.lastMatchAt>300){TS.lastMatchWord=null;TS.lastMatchAt=0;}
    }
    const lenJump=val.length-TS.lastLen;
    TS.lastLen=val.length;
    // Track chord-sized jumps to distinguish device corrections from user backspaces
    const valTrim=val.trimEnd();

    // Reset hint delay timer on any keystroke
    if(isHintActive(settings,'delay'))startHintTimer(TS,'testHint',target);

    /* Track match state for Space-confirmation.
       ONLY set lastMatchWord on:
       1. Exact match (val === target)
       2. Chord jump directly into trailing-bs state (lenJump >= threshold, atomic "word\b")
       Do NOT set on gradual typing that reaches target.length-1 chars — that would
       cause false positives where typing "hell" of "hello" is confirmed as correct. */
    const chordThreshold=Math.max(2,target.length-1);
    if(cmp(valTrim,target)){
      TS.lastMatchWord=target;
      TS.lastMatchAt=now;
      TS.lastChordAt=now;
    }else if(lenJump>=chordThreshold&&isTrailingBs(valTrim,target,ci)){
      /* Atomic chord trailing-bs: browser saw "word\b" as net "wor" in one event. */
      TS.lastMatchWord=target;
      TS.lastMatchAt=now;
      TS.lastChordAt=now;
    }

    updateTestWordLive(valTrim,target);
  }

  function onTestKeydown(e){
    if(!TS.running)return;
    // Only flag user-intentional backspace — device correction backspaces come within
    // milliseconds of the last input event; deliberate user backspaces come 300+ms later
    if(e.key==='Backspace'&&Date.now()-TS.lastActivityAt>300) TS.hadBackspace=true;
    if(e.key===' '){
      e.preventDefault();
      e.stopPropagation(); // prevent global keydown from double-confirming
      confirmTestWord();
    }
  }

  function confirmTestWord(){
    if(!TS.running)return;
    const target=TS.words[TS.idx];
    const inputVal=$('testInput').value;
    const inputValTrim=inputVal.trimEnd();
    const now=Date.now();
    const settings=Storage.getSettings();

    // Require at least some input attempt
    if(inputVal.length===0&&TS.lastMatchWord===null&&TS.firstKeyAt===null)return;

    const ci=settings.caseInsensitive;
    const directMatch=cmp(inputValTrim,target);
    const memoryMatch=TS.lastMatchWord!==null
      &&cmp(TS.lastMatchWord,target)
      &&(now-TS.lastMatchAt<3000);
    const trailingBsAtConfirm=isTrailingBs(inputValTrim,target,ci)&&memoryMatch;
    const isCorrect=directMatch||memoryMatch||trailingBsAtConfirm;

    if(!isCorrect){
      // Wrong press: stay on current word, show hint, clear input for retry
      TS.hadWrongPress=true;
      const block=$('testWordBlock');
      const span=block?.querySelector('.tw-current');
      if(span)span.classList.add('tw-tried-wrong');
      if(isHintActive(settings,'wrong'))setHintEl('testHint',target);
      $('testInput').value='';
      TS.lastLen=0;
      TS.lastMatchWord=null;
      TS.lastMatchAt=0;
      $('testInput').focus();
      return;
    }

    // Correct! Record result and advance.
    const hadRetry=TS.hadBackspace||TS.hadWrongPress;
    const delay=TS.firstKeyAt?TS.firstKeyAt-TS.shownAt:null;
    const chordTime=Math.max(0,(now-TS.shownAt)-TS.wordPausedMs);
    const interWpm=(TS.idx>0&&TS.prevConfirmedAt!=null)
      ?calcWpm(target.length,now-TS.prevConfirmedAt):null;
    const globalRef=TS.globalStart>0?TS.globalStart:now;
    TS.results.push({word:target,idx:TS.idx,correct:true,hadRetry,delay,chordTime,interWpm,pausedMs:TS.wordPausedMs,confirmedRelativeMs:now-globalRef});
    TS.lastConfirmedAt=now;
    TS.prevConfirmedAt=now;

    const quality=Adaptive.calcQuality(hadRetry,chordTime,settings);
    Storage.updateWordResult(target,{correct:true,hadRetry,delay,chordTime:chordTime>0?chordTime:null,quality});
    Storage.addPracticeMs(chordTime>0?chordTime:0);

    markTestWord(TS.idx,!hadRetry);
    clearHintTimer(TS);
    setHintEl('testHint',null);

    TS.idx++;
    if(TS.idx>=TS.words.length)finishTest();
    else{loadTestWord();$('testInput').focus();}
  }

  function finishTest(){
    TS.running=false;
    clearHintTimer(TS);
    $('testProgressFill').style.width='100%';

    const n=TS.results.length;
    const firstTryCount=TS.results.filter(r=>!r.hadRetry).length;
    const accuracy=n>0?Math.round(firstTryCount/n*100):0;
    const rawTotal=TS.globalStart>0?TS.lastConfirmedAt-TS.globalStart:0;
    const totalPaused=TS.results.reduce((s,r)=>s+(r.pausedMs||0),0);
    const effectiveMs=Math.max(1000,rawTotal-totalPaused);
    const overWpm=Math.round(n/(effectiveMs/60000));

    $('summaryWpm').textContent=overWpm;
    $('summaryAccuracy').textContent=accuracy+'%';
    $('summaryWords').textContent=n;
    $('summaryTime').textContent=fmtDuration(rawTotal);

    // Per-word WPM chart (inter-word speed + overall reference line)
    renderTestWpmChart(overWpm);

    const tbody=$('testResultsBody');
    tbody.innerHTML=TS.results.map((r,i)=>{
      const res=r.hadRetry
        ?'<span class="badge badge-warn">⚠ Corrected</span>'
        :'<span class="badge badge-ok">✓ First try</span>';
      return`<tr>
        <td>${i+1}</td>
        <td class="word-cell">${escHtml(r.word)}</td>
        <td>${res}</td>
        <td>${i===0?'<span style="color:var(--txt2)">—</span>':(r.interWpm!=null?r.interWpm:'—')}</td>
        <td>${r.chordTime!=null?fmtChordTime(r.chordTime):'—'}</td>
        <td>${r.delay!=null?Math.round(r.delay):'—'}</td>
      </tr>`;
    }).join('');

    Storage.saveSession({date:new Date().toISOString(),words:n,wpm:overWpm,accuracy,durationMs:rawTotal,source:TS.source});
    $('testRunning').classList.add('hidden');
    $('testResults').classList.remove('hidden');
  }

  function renderTestWpmChart(overWpm) {
    const canvas=$('testWpmCanvas');
    if(!canvas||TS.results.length<2)return;
    const dark=document.documentElement.dataset.theme!=='light';
    const gc=dark?'rgba(255,255,255,.07)':'rgba(0,0,0,.07)';
    const tc=dark?'#8b949e':'#636c76';

    /* Build cumulative WPM at each confirmation point.
       We subtract paused time accumulated up to each word. */
    let cumPausedMs=0;
    const points=TS.results.map((r)=>{
      cumPausedMs+=(r.pausedMs||0);
      const elapsedMs=Math.max(1000,r.confirmedRelativeMs-cumPausedMs);
      const cumChars=TS.results.slice(0,r.idx+1).reduce((s,x)=>s+x.word.length,0);
      const wpm=Math.round((cumChars/5)/(elapsedMs/60000));
      return {x: parseFloat((r.confirmedRelativeMs/1000).toFixed(1)), y: wpm, word: r.word, correct: r.correct};
    });

    const refData=points.map(p=>({x:p.x, y:overWpm}));
    const pointColors=points.map(p=>p.hadRetry?'rgba(240,196,67,1)':'rgba(63,185,80,1)');

    if(testWpmChart)testWpmChart.destroy();
    testWpmChart=new Chart(canvas,{
      type:'line',
      data:{
        datasets:[
          {
            label:'Cumulative WPM',
            data: points.map(p=>({x:p.x,y:p.y})),
            borderColor:'#58a6ff',
            backgroundColor:'rgba(88,166,255,.08)',
            pointBackgroundColor: pointColors,
            pointBorderColor: pointColors,
            pointRadius: 5,
            pointHoverRadius: 7,
            borderWidth: 2,
            fill: true,
            tension: 0.3,
          },
          {
            label:'Final WPM',
            data: refData,
            borderColor:'rgba(240,196,67,.6)',
            borderDash:[5,3],
            pointRadius: 0,
            borderWidth: 1.5,
            fill: false,
            tension: 0,
          },
        ],
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{labels:{color:tc,font:{size:11}}},
          tooltip:{
            callbacks:{
              title:(items)=>{
                const p=points[items[0].dataIndex];
                return p?`"${p.word}" @ ${items[0].parsed.x}s`:'';
              },
              label:(item)=>{
                if(item.datasetIndex===0){
                  const p=points[item.dataIndex];
                  return [
                    `WPM: ${item.parsed.y}`,
                    p&&p.hadRetry?'⚠ Corrected':'✓ First try',
                  ];
                }
                return `Final WPM: ${item.parsed.y}`;
              },
            },
          },
        },
        scales:{
          x:{
            type:'linear',
            grid:{color:gc},
            ticks:{color:tc,font:{size:10}},
            title:{display:true,text:'Time (seconds)',color:tc},
          },
          y:{
            grid:{color:gc},
            ticks:{color:tc},
            beginAtZero:true,
            title:{display:true,text:'WPM',color:tc},
          },
        },
      },
    });
  }

  function abortTest(){
    clearHintTimer(TS);
    TS.running=false;
    $('testRunning').classList.add('hidden');
    $('testSetup').classList.remove('hidden');
  }

  /* ============================================================
     STATISTICS
  ============================================================ */
  function renderStats(){
    const all=Storage.getAllWordStats(),sessions=Storage.getSessions();
    const settings=Storage.getSettings();
    const words=Object.values(all);
    const threshold=settings.learnedThresholdDays??10;
    $('statsTotalWords').textContent=words.length;
    $('statsTotalSessions').textContent=sessions.length;
    const allCts=words.flatMap(w=>w.chordTimeHistory??[]);
    $('statsAvgChordTime').textContent=allCts.length?fmtChordTime(Math.round(avgArr(allCts))):'—';
    const ta=words.reduce((s,w)=>s+(w.attempts??0),0);
    const tc=words.reduce((s,w)=>s+(w.correctFirstTry??0),0);
    $('statsOverallAccuracy').textContent=ta>0?Math.round(tc/ta*100)+'%':'—';
    $('statsTotalPractice').textContent=fmtPracticeTime(Storage.getTotalPracticeMs());
    // Learned words: base interval >= threshold (support legacy `interval` field)
    const learnedCount = words.filter(w => (w.baseIntervalDays ?? w.interval ?? 0) >= threshold).length;
    $('statsLearnedWords').textContent=learnedCount;
    renderLearnedWordsChart(words,threshold);
    renderWordStatsTable();renderSessionHistory(sessions);
  }

  function renderLearnedWordsChart(words,threshold){
    const canvas = $('learnedChart');
    const noMsg = $('noLearnedChartMsg');
    if (!canvas) return;
    // Prefer per-word `baseHistory` to compute learned/unlearned transitions dynamically.
    // Migrate legacy `learnedAt` values into append-only history if needed.
    let globalHistory = Storage.getLearnedHistory() || [];
    if ((!globalHistory || globalHistory.length === 0)) {
      const allStats = Storage.getAllWordStats();
      const migr = [];
      for (const [w, s] of Object.entries(allStats)) {
        if (s.learnedAt) migr.push({ word: w, type: 'learned', ts: s.learnedAt });
      }
      if (migr.length) {
        for (const ev of migr) Storage.addLearnedHistoryEvent(ev);
        globalHistory = Storage.getLearnedHistory() || [];
      }
    }

    // Build events from per-word baseHistory where available
    const learnedEvents = [];
    const allStats = Storage.getAllWordStats();
    for (const [w, s] of Object.entries(allStats)) {
      if (Array.isArray(s.baseHistory) && s.baseHistory.length) {
        const h = s.baseHistory.slice().sort((a, b) => a.ts - b.ts);
        let prevBase = 0;
        for (const be of h) {
          const nb = Number(be.baseIntervalDays || 0);
          if (prevBase < threshold && nb >= threshold) learnedEvents.push({ word: w, type: 'learned', ts: be.ts });
          if (prevBase >= threshold && nb < threshold) learnedEvents.push({ word: w, type: 'unlearned', ts: be.ts });
          prevBase = nb;
        }
      }
    }
    // Append globalHistory events for words without baseHistory (fallback)
    for (const ev of (globalHistory || [])) {
      const s = allStats[ev.word];
      if (s && Array.isArray(s.baseHistory) && s.baseHistory.length) continue;
      learnedEvents.push(ev);
    }

    if (!learnedEvents || learnedEvents.length === 0) {
      if (noMsg) noMsg.style.display = 'block';
      canvas.style.display = 'none';
      return;
    }
    if (noMsg) noMsg.style.display = 'none';
    canvas.style.display = 'block';

    // Read compact UI controls (range & aggregation) — fall back to settings
    const rangeSel = $('learnedChartRange');
    const aggSel = $('learnedChartAgg');
    const settings = Storage.getSettings();
    const rangeVal = rangeSel?.value || (settings.learnedChartRangeDays ? String(settings.learnedChartRangeDays) : '90');
    const aggVal = aggSel?.value || (settings.learnedChartAggregation || 'day');

    // sort the computed events by timestamp
    learnedEvents.sort((a, b) => a.ts - b.ts);

    // Helper: compute bucket key (YYYY-MM-DD) representing start of bucket
    function bucketKeyForTs(ts, agg) {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      if (agg === 'day') return d.toISOString().slice(0, 10);
      if (agg === 'week') {
        // week starting Sunday
        const wk = new Date(d);
        wk.setDate(d.getDate() - d.getDay()); wk.setHours(0, 0, 0, 0);
        return wk.toISOString().slice(0, 10);
      }
      if (agg === 'month') {
        const m = new Date(d);
        m.setDate(1); m.setHours(0, 0, 0, 0);
        return m.toISOString().slice(0, 10);
      }
      return d.toISOString().slice(0, 10);
    }

    // Build bucketed net changes
    const bucketChanges = {};
    for (const ev of learnedEvents) {
      const key = bucketKeyForTs(ev.ts, aggVal);
      bucketChanges[key] = (bucketChanges[key] || 0) + ((ev.type === 'learned') ? 1 : -1);
    }

    // Determine start and end buckets based on selected range
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let startBucket;
    if (rangeVal === 'all') {
      startBucket = bucketKeyForTs(learnedEvents[0].ts, aggVal);
    } else {
      const days = parseInt(rangeVal) || 90;
      const s = new Date(today);
      s.setDate(s.getDate() - (days - 1));
      // align to bucket boundary
      startBucket = bucketKeyForTs(s.getTime(), aggVal);
    }
    const endBucket = bucketKeyForTs(today.getTime(), aggVal);

    // Compute initial cumulative from events before startBucket
    let cum = 0;
    for (const ev of learnedEvents) {
      const k = bucketKeyForTs(ev.ts, aggVal);
      if (k < startBucket) cum += (ev.type === 'learned' ? 1 : -1);
    }
    if (cum < 0) cum = 0;

    // Iterate buckets from startBucket to endBucket
    const labels = [];
    const data = [];
    let cursor = new Date(startBucket + 'T00:00:00Z');
    const endDate = new Date(endBucket + 'T00:00:00Z');
    while (cursor <= endDate) {
      const key = cursor.toISOString().slice(0, 10);
      cum += (bucketChanges[key] || 0);
      if (cum < 0) cum = 0;
      // Label formatting
      if (aggVal === 'day') labels.push(key.slice(5));
      else if (aggVal === 'week') labels.push(key.slice(5));
      else labels.push(key.slice(0, 7)); // month -> YYYY-MM
      data.push(cum);
      // advance cursor by aggregation
      if (aggVal === 'day') cursor.setDate(cursor.getDate() + 1);
      else if (aggVal === 'week') cursor.setDate(cursor.getDate() + 7);
      else cursor.setMonth(cursor.getMonth() + 1);
    }

    const dark = document.documentElement.dataset.theme !== 'light';
    const gc = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)';
    const tc = dark ? '#8b949e' : '#636c76';
    if (wpmChart) wpmChart.destroy();
    wpmChart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{
        label: 'Learned words (cumulative)',
        data,
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63,185,80,.12)',
        tension: .35, fill: true, pointRadius: 3, pointBackgroundColor: '#3fb950',
      }] },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => `${i.parsed.y} words learned` } } },
        scales: {
          x: { grid: { color: gc }, ticks: { color: tc, maxTicksLimit: 10 } },
          y: { grid: { color: gc }, ticks: { color: tc }, beginAtZero: true, title: { display: true, text: 'Learned words', color: tc } },
        },
      },
    });
  }

  function renderWordStatsTable(){
    const all=Storage.getAllWordStats();
    const search=($('wordStatsSearch')?.value??'').toLowerCase();
    const sortKey=$('wordStatsSort')?.value??'word';
    let words=Object.values(all).filter(s=>!search||s.word.toLowerCase().includes(search));
    words.sort((a,b)=>{
      switch(sortKey){
        case'accuracy_asc':{const ra=a.attempts?a.correctFirstTry/a.attempts:1,rb=b.attempts?b.correctFirstTry/b.attempts:1;return ra-rb;}
        case'chordtime_desc':return avgArr(b.chordTimeHistory)-avgArr(a.chordTimeHistory);
        case'attempts':return(b.attempts??0)-(a.attempts??0);
        case'due':return(a.due??Date.now())-(b.due??Date.now());
        default:return a.word.localeCompare(b.word);
      }
    });
    const tbody=$('wordStatsBody');
    if(!words.length){
      tbody.innerHTML=`<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--txt2)">No word data yet — start practicing!</td></tr>`;
      updateResetSelectedBtn();return;
    }
    tbody.innerHTML=words.map(s=>{
      const acc=s.attempts>0?Math.round(s.correctFirstTry/s.attempts*100):null;
      const avgCt=s.chordTimeHistory?.length?Math.round(avgArr(s.chordTimeHistory)):null;
      const avgDel=s.delayHistory?.length?Math.round(avgArr(s.delayHistory)):null;
      const barClr=acc==null?'var(--txt2)':acc>=80?'var(--ok)':acc>=50?'var(--warn)':'var(--err)';
      const accCell=acc!=null
        ?`<div class="acc-bar"><div class="acc-bar-bg"><div class="acc-bar-fill" style="width:${acc}%;background:${barClr}"></div></div><span>${acc}%</span></div>`
        :'—';
      const hint=CC.getHint(s.word);
      return`<tr class="word-stats-row" data-word="${escHtml(s.word)}" title="Click to expand">
        <td><input type="checkbox" class="word-check" data-word="${escHtml(s.word)}" onclick="event.stopPropagation()"></td>
        <td class="word-cell">${escHtml(s.word)} <span class="expand-arrow" aria-hidden="true">›</span></td>
        <td>${s.attempts??0}</td>
        <td>${accCell}</td>
        <td>${avgCt!=null?fmtChordTime(avgCt):'—'}</td>
        <td>${avgDel!=null?fmtMs(avgDel):'—'}</td>
        <td>${fmtDue(s.due)}</td>
        <td><button class="btn btn-secondary btn-small reset-word-btn" data-word="${escHtml(s.word)}" onclick="event.stopPropagation()">Reset</button></td>
      </tr>
      <tr class="word-detail-row hidden" data-for="${escHtml(s.word)}">
        <td colspan="8">
          <div class="word-detail-content">
            <div class="word-detail-charts">
              ${renderSparkline(s.chordTimeHistory,'#58a6ff','Chord Time (ms)')}
              ${renderSparkline(s.delayHistory,'#3fb950','Delay (ms)')}
            </div>
            <div class="word-detail-meta">
              <span>First seen: ${fmtRelative(s.firstSeen)}</span>
              <span>Last seen: ${fmtRelative(s.lastSeen)}</span>
              <span>Skipped: ${s.skipped??0}</span>
              <span>Next review: ${fmtDue(s.due)}</span>
              ${hint?`<span>Chord: <strong class="hint-keys">${escHtml(hint)}</strong></span>`:''}
            </div>
          </div>
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.word-stats-row').forEach(row=>{
      row.addEventListener('click',()=>{
        const word=row.dataset.word;
        const detail=tbody.querySelector(`.word-detail-row[data-for="${CSS.escape(word)}"]`);
        if(!detail)return;
        const isOpen=!detail.classList.contains('hidden');
        tbody.querySelectorAll('.word-detail-row').forEach(r=>r.classList.add('hidden'));
        tbody.querySelectorAll('.expand-arrow').forEach(a=>a.textContent='›');
        if(!isOpen){detail.classList.remove('hidden');row.querySelector('.expand-arrow').textContent='⌄';}
      });
    });
    tbody.querySelectorAll('.word-check').forEach(cb=>cb.addEventListener('change',updateResetSelectedBtn));
    tbody.querySelectorAll('.reset-word-btn').forEach(btn=>
      btn.addEventListener('click',()=>
        confirmAction(`Reset progress for "${btn.dataset.word}"?`,()=>{
          Storage.resetWordStats([btn.dataset.word]);renderWordStatsTable();
        })));
  }

  function updateResetSelectedBtn(){
    $('resetSelectedBtn').disabled=document.querySelectorAll('#wordStatsBody .word-check:checked').length===0;
  }

  function renderSessionHistory(sessions){
    const tbody=$('sessionHistoryBody');
    if(!sessions.length){
      tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--txt2)">No test sessions yet.</td></tr>`;
      return;
    }
    tbody.innerHTML=[...sessions].reverse().slice(0,50).map(s=>{
      const d=new Date(s.date);
      return`<tr>
        <td>${d.toLocaleDateString()} ${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</td>
        <td>${s.words}</td><td>${s.wpm}</td><td>${s.accuracy}%</td>
        <td>${fmtDuration(s.durationMs)}</td>
        <td><span class="badge badge-neutral">${escHtml(s.source??'all')}</span></td>
      </tr>`;
    }).join('');
  }

  /* ============================================================
     WORD SETS
  ============================================================ */
  function renderWordSets(){
    const{sets,activeIds=[]}=Storage.getWordSets();
    const list=$('wordSetsList');
    if(!sets.length){
      list.innerHTML=`<div class="empty-state">
        <div class="empty-icon">📝</div>
        <h3>No word sets yet</h3>
        <p>Create your first word set, or load one of the built-in English word sets to get started quickly.</p>
        <div class="btn-row" style="justify-content:center;margin-top:.5rem">
          <button class="btn btn-primary" id="loadDefaultsFromEmpty">Load English word sets</button>
          <button class="btn btn-secondary" id="newFromEmptyBtn">+ Create custom set</button>
        </div>
      </div>`;
      $('loadDefaultsFromEmpty')?.addEventListener('click',()=>loadDefaultWordSets(true));
      $('newFromEmptyBtn')?.addEventListener('click',()=>openWordSetModal(null));
      return;
    }
    list.innerHTML=sets.map(set=>{
      const isActive=activeIds.includes(set.id);
      const sep=set.sep??'auto';
      const sepOpts=[['auto','Auto'],[' ','Space'],[',','Comma'],['\n','Newline'],['\t','Tab']];
      return`<div class="word-set-card ${isActive?'is-active':''}" data-id="${set.id}" data-edit-sep="${escHtml(sep)}" draggable="true">
        <div class="wsc-drag-handle" title="Drag to reorder">⠿</div>
        <div class="wsc-body">
          <div class="wsc-view">
            <div class="wsc-info">
              <div class="wsc-name ${isActive?'is-active':''}">${escHtml(set.name)}</div>
              <div class="wsc-meta">${set.words.length} word${set.words.length!==1?'s':''}</div>
              <div class="wsc-preview">${escHtml(set.words.slice(0,12).join(' '))}${set.words.length>12?'\u2026':''}</div>
            </div>
            <div class="wsc-actions">
              <button class="btn ${isActive?'btn-primary':'btn-secondary'} btn-small set-toggle-btn" data-id="${set.id}">${isActive?'\u2713 Active':'Activate'}</button>
              <button class="btn btn-secondary btn-small edit-set-btn" data-id="${set.id}">Edit</button>
              <button class="btn btn-secondary btn-small split-set-btn" data-id="${set.id}" title="Split into smaller subsets">Split</button>
              <button class="btn btn-danger btn-small delete-set-btn" data-id="${set.id}">Delete</button>
            </div>
          </div>
          <div class="wsc-split hidden">
            <div class="wsc-split-inner">
              <div style="font-size:.85rem;color:var(--txt2);margin-bottom:.5rem">Split <strong>${escHtml(set.name)}</strong> (${set.words.length} words) into:</div>
              <div class="btn-group mode-btns" style="margin-bottom:.5rem">
                <button class="mode-btn active wsc-split-mode" data-split-mode="bySize">Subsets of N words</button>
                <button class="mode-btn wsc-split-mode" data-split-mode="byCount">N equal subsets</button>
              </div>
              <div class="form-row" style="gap:.5rem;align-items:center">
                <input type="number" class="wsc-split-n input-small" min="1" max="9999" value="30">
                <span class="label wsc-split-label">words per subset</span>
              </div>
              <div class="wsc-split-preview" style="font-size:.8rem;color:var(--txt2);margin-top:.35rem"></div>
              <div class="btn-row" style="margin-top:.5rem">
                <button class="btn btn-primary btn-small do-split-btn">Create subsets</button>
                <button class="btn btn-secondary btn-small cancel-split-btn">Cancel</button>
              </div>
            </div>
          </div>
          <div class="wsc-edit">
            <div class="wsc-edit-inner">
              <div class="form-group" style="margin-top:.75rem">
                <label>Name</label>
                <input class="wsc-edit-name input-full" type="text" value="${escHtml(set.name)}">
              </div>
              <div class="form-group">
                <label>Separator</label>
                <div class="wsc-sep-btns btn-group mode-btns">${sepOpts.map(([v,l])=>`<button class="mode-btn${sep===v?' active':''}" data-sep="${escHtml(v)}">${l}</button>`).join('')}</div>
              </div>
              <div class="form-group">
                <label>Words <span class="wsc-edit-count"></span></label>
                <textarea class="wsc-edit-words input-full textarea-words-inline" rows="5">${escHtml(set.words.join(' '))}</textarea>
              </div>
              <div class="form-group">
                <label>Preview</label>
                <div class="wsc-edit-preview word-set-preview">\u2014</div>
              </div>
              <div class="wsc-edit-actions">
                <button class="btn btn-secondary btn-small cancel-edit-btn" data-id="${set.id}">Cancel</button>
                <button class="btn btn-primary btn-small save-edit-btn" data-id="${set.id}">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.word-set-card').forEach(card=>{
      const id=card.dataset.id;
      card.querySelector('.set-toggle-btn')?.addEventListener('click',()=>toggleActiveWordSet(id));
      card.querySelector('.edit-set-btn')?.addEventListener('click',()=>startInlineEdit(card));
      card.querySelector('.delete-set-btn')?.addEventListener('click',()=>deleteWordSet(id));
      card.querySelector('.split-set-btn')?.addEventListener('click',()=>toggleSplitPanel(card));
      card.querySelector('.cancel-edit-btn')?.addEventListener('click',()=>cancelInlineEdit(card));
      card.querySelector('.save-edit-btn')?.addEventListener('click',()=>saveInlineEdit(card));
      card.querySelector('.do-split-btn')?.addEventListener('click',()=>executeSplit(card));
      card.querySelector('.cancel-split-btn')?.addEventListener('click',()=>{
        card.querySelector('.wsc-split')?.classList.add('hidden');
      });
      card.querySelectorAll('.wsc-split-mode').forEach(btn=>btn.addEventListener('click',()=>{
        card.querySelectorAll('.wsc-split-mode').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const label=card.querySelector('.wsc-split-label');
        if(label)label.textContent=btn.dataset.splitMode==='bySize'?'words per subset':'equal subsets';
        updateSplitPreview(card);
      }));
      card.querySelector('.wsc-split-n')?.addEventListener('input',()=>updateSplitPreview(card));
      card.querySelectorAll('.wsc-sep-btns .mode-btn').forEach(btn=>btn.addEventListener('click',()=>{
        card.querySelectorAll('.wsc-sep-btns .mode-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        card.dataset.editSep=btn.dataset.sep;
        updateInlinePreview(card);
      }));
      card.querySelector('.wsc-edit-words')?.addEventListener('input',()=>updateInlinePreview(card));
      card.addEventListener('dragstart',e=>{
        if(e.target.closest('button,input,textarea,select,.wsc-edit')||card.classList.contains('is-editing')){e.preventDefault();return;}
        dragSrcId=id;card.classList.add('dragging');
        e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id);
      });
      card.addEventListener('dragend',()=>{
        card.classList.remove('dragging');
        list.querySelectorAll('.word-set-card').forEach(c=>c.classList.remove('drag-over'));
      });
      card.addEventListener('dragover',e=>{
        e.preventDefault();
        if(id!==dragSrcId){
          e.dataTransfer.dropEffect='move';
          list.querySelectorAll('.word-set-card').forEach(c=>c.classList.remove('drag-over'));
          card.classList.add('drag-over');
        }
      });
      card.addEventListener('dragleave',e=>{
        if(!card.contains(e.relatedTarget))card.classList.remove('drag-over');
      });
      card.addEventListener('drop',e=>{
        e.preventDefault();
        if(id!==dragSrcId)reorderWordSet(dragSrcId,id);
        card.classList.remove('drag-over');
      });
    });
  }

  /* ── Backup reminder ── */
  function checkBackupReminder(){
    const s=Storage.getSettings();
    const days=s.backupReminderDays??7;
    if(days<=0) return;
    const last=s.lastBackupPromptAt??0;
    if(Date.now()-last>=days*86400000){
      s.lastBackupPromptAt=Date.now();
      Storage.saveSettings(s);
      const banner=$('backupReminderBanner');
      const modal=$('backupReminderModal');
      const practiceFinishedEl=$('practiceFinished');
      // If we're currently on the congratulations card, show the inline banner there.
      if(practiceFinishedEl && !practiceFinishedEl.classList.contains('hidden')){
        if(banner) banner.classList.remove('hidden');
        else if(modal) modal.classList.remove('hidden');
      } else {
        // Otherwise show a popup modal so the user sees the reminder regardless of tab.
        if(modal) modal.classList.remove('hidden');
        else if(banner) banner.classList.remove('hidden');
      }
    }
  }

  /* ── Word set split helpers ── */
  function toggleSplitPanel(card){
    const panel=card.querySelector('.wsc-split');
    if(!panel)return;
    // Close any other open split panels
    $('wordSetsList').querySelectorAll('.wsc-split:not(.hidden)').forEach(p=>{if(p!==panel)p.classList.add('hidden');});
    panel.classList.toggle('hidden');
    updateSplitPreview(card);
  }
  function updateSplitPreview(card){
    const preview=card.querySelector('.wsc-split-preview');
    if(!preview)return;
    const id=card.dataset.id;
    const set=Storage.getWordSets().sets.find(s=>s.id===id);
    if(!set){preview.textContent='';return;}
    const n=Math.max(1,parseInt(card.querySelector('.wsc-split-n')?.value)||30);
    const mode=card.querySelector('.wsc-split-mode.active')?.dataset.splitMode??'bySize';
    const total=set.words.length;
    let count,size;
    if(mode==='bySize'){size=n;count=Math.ceil(total/size);}
    else{count=n;size=Math.ceil(total/count);}
    preview.textContent=`→ ${count} subset${count!==1?'s':''} of ~${size} words each`;
  }
  function executeSplit(card){
    const id=card.dataset.id;
    const data=Storage.getWordSets();
    const set=data.sets.find(s=>s.id===id);
    if(!set)return;
    const n=Math.max(1,parseInt(card.querySelector('.wsc-split-n')?.value)||30);
    const mode=card.querySelector('.wsc-split-mode.active')?.dataset.splitMode??'bySize';
    const words=[...set.words];
    let chunkSize;
    if(mode==='bySize'){chunkSize=n;}
    else{chunkSize=Math.ceil(words.length/Math.max(1,n));}
    const chunks=[];
    for(let i=0;i<words.length;i+=chunkSize)chunks.push(words.slice(i,i+chunkSize));
    const total=chunks.length;
    const newSets=chunks.map((chunk,i)=>({
      id:uid(),name:`${set.name} (${i+1}/${total})`,words:chunk,sep:'auto',created:Date.now(),
    }));
    // Insert new sets right after the original
    const origIdx=data.sets.findIndex(s=>s.id===id);
    data.sets.splice(origIdx+1,0,...newSets);
    Storage.saveWordSets(data);
    renderWordSets();refreshPracticeHeader();refreshTestHeader();
    alert(`Created ${total} subsets from "${set.name}". Original set kept.`);
  }

  function startInlineEdit(card){
    $('wordSetsList').querySelectorAll('.word-set-card.is-editing').forEach(c=>{if(c!==card)cancelInlineEdit(c);});
    card.dataset.editSep=card.dataset.editSep??'auto';
    card.classList.add('is-editing');
    updateInlinePreview(card);
    setTimeout(()=>card.querySelector('.wsc-edit-name')?.focus(),50);
  }
  function cancelInlineEdit(card){
    card.classList.remove('is-editing');
    const id=card.dataset.id;
    const set=Storage.getWordSets().sets.find(s=>s.id===id);
    if(!set)return;
    card.querySelector('.wsc-edit-name').value=set.name;
    const ta=card.querySelector('.wsc-edit-words');if(ta)ta.value=set.words.join(' ');
    const sep=set.sep??'auto';
    card.dataset.editSep=sep;
    card.querySelectorAll('.wsc-sep-btns .mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.sep===sep));
    updateInlinePreview(card);
  }
  function saveInlineEdit(card){
    const id=card.dataset.id;
    const name=card.querySelector('.wsc-edit-name').value.trim();
    const sep=card.dataset.editSep??'auto';
    const words=parseWords(card.querySelector('.wsc-edit-words').value,sep);
    if(!name){alert('Please enter a name.');return;}
    if(!words.length){alert('No words found.');return;}
    const data=Storage.getWordSets();
    const set=data.sets.find(s=>s.id===id);
    if(set){set.name=name;set.words=words;set.sep=sep;}
    Storage.saveWordSets(data);
    renderWordSets();refreshPracticeHeader();refreshTestHeader();
  }
  function updateInlinePreview(card){
    const sep=card.dataset.editSep??'auto';
    const words=parseWords(card.querySelector('.wsc-edit-words')?.value??'',sep);
    const countEl=card.querySelector('.wsc-edit-count');
    const prevEl=card.querySelector('.wsc-edit-preview');
    if(countEl)countEl.textContent=`(${words.length} word${words.length!==1?'s':''})`;
    if(prevEl)prevEl.textContent=words.slice(0,20).join(' ')+(words.length>20?'\u2026':'');
  }
  function reorderWordSet(srcId,targetId){
    const data=Storage.getWordSets();
    const si=data.sets.findIndex(s=>s.id===srcId),ti=data.sets.findIndex(s=>s.id===targetId);
    if(si<0||ti<0)return;
    const[moved]=data.sets.splice(si,1);data.sets.splice(ti,0,moved);
    Storage.saveWordSets(data);renderWordSets();refreshPracticeHeader();refreshTestHeader();
  }

  /* Load the bundled English word sets from JSON files */
  async function loadDefaultWordSets(activate=false) {
    const btn=$('loadDefaultSetsBtn');
    if(btn){btn.disabled=true;btn.textContent='Loading…';}
    const defs=[
      {file:'english.json',  name:'English Top 200'},
      {file:'english_1k.json',name:'English Top 1000'},
    ];
    const data=Storage.getWordSets();
    let added=0;
    for(const{file,name}of defs){
      if(data.sets.find(s=>s.name===name))continue;
      try{
        const resp=await fetch(file);
        if(!resp.ok)continue;
        const json=await resp.json();
        const words=Array.isArray(json.words)?json.words.filter(w=>w&&w.trim()):[];
        if(!words.length)continue;
        data.sets.push({id:uid(),name,words,sep:'auto',created:Date.now()});
        added++;
      }catch(err){console.warn('Could not load',file,err);}
    }
    if(activate&&data.sets.length){
      if(!data.activeIds)data.activeIds=[];
      if(!data.activeIds.length)data.activeIds=[data.sets[0].id];
    }
    Storage.saveWordSets(data);
    if(btn){btn.disabled=false;btn.textContent=`+ English Sets${added?` (${added} added)`:' (already loaded)'}` ;}
    renderWordSets();refreshPracticeHeader();refreshTestHeader();
    if(added)alert(`Loaded ${added} default English word set${added!==1?'s':''}! The first one is now active.`);
    else alert('Default word sets are already loaded.');
  }

  function toggleActiveWordSet(id){
    const data=Storage.getWordSets();
    if(!Array.isArray(data.activeIds))data.activeIds=data.activeId?[data.activeId]:[];
    const idx=data.activeIds.indexOf(id);
    if(idx>=0)data.activeIds.splice(idx,1);
    else data.activeIds.push(id);
    Storage.saveWordSets(data);
    PS.word=null;renderWordSets();refreshPracticeHeader();refreshTestHeader();
  }
  function deleteWordSet(id){
    const data=Storage.getWordSets(),set=data.sets.find(s=>s.id===id);
    confirmAction(`Delete "${set?.name}"? Word progress is kept.`,()=>{
      data.sets=data.sets.filter(s=>s.id!==id);
      data.activeIds=(data.activeIds||[]).filter(x=>x!==id);
      if(!data.activeIds.length&&data.sets.length)data.activeIds=[data.sets[0].id];
      Storage.saveWordSets(data);PS.word=null;
      renderWordSets();refreshPracticeHeader();refreshTestHeader();
    });
  }

  function openWordSetModal(editId=null){
    wordSetEditId=editId;wordSetSep='auto';
    if(editId){
      const set=Storage.getWordSets().sets.find(s=>s.id===editId);
      $('wordSetModalTitle').textContent='Edit Word Set';
      $('wordSetName').value=set.name;
      $('wordSetInput').value=set.words.join(' ');
      wordSetSep=set.sep??'auto';
    }else{
      $('wordSetModalTitle').textContent='New Word Set';
      $('wordSetName').value='';$('wordSetInput').value='';
    }
    document.querySelectorAll('#separatorBtns .mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.sep===wordSetSep));
    updateWordSetPreview();$('wordSetModal').classList.remove('hidden');
    setTimeout(()=>$('wordSetName').focus(),50);
  }
  function closeWordSetModal(){$('wordSetModal').classList.add('hidden');}
  function updateWordSetPreview(){
    const words=parseWords($('wordSetInput').value,wordSetSep);
    $('wordSetCount').textContent=`(${words.length} word${words.length!==1?'s':''})`;
    $('wordSetPreview').textContent=words.slice(0,20).join(' ')+(words.length>20?'…':'');
  }
  function saveWordSet(){
    const name=$('wordSetName').value.trim(),words=parseWords($('wordSetInput').value,wordSetSep);
    if(!name){alert('Please enter a name.');return;}
    if(!words.length){alert('No words found.');return;}
    const data=Storage.getWordSets();
    if(wordSetEditId){
      const set=data.sets.find(s=>s.id===wordSetEditId);
      if(set){set.name=name;set.words=words;set.sep=wordSetSep;}
    }else{
      const newSet={id:uid(),name,words,sep:wordSetSep,created:Date.now()};
      data.sets.push(newSet);
      if(!data.activeIds?.length)data.activeIds=[newSet.id];
    }
    Storage.saveWordSets(data);closeWordSetModal();
    renderWordSets();refreshPracticeHeader();refreshTestHeader();
  }

  function generateWordSetFromChordMap(){
    const words=CC.getWordList();
    if(!words.length){
      alert('No chord map loaded. Connect your CharaChorder via Settings first, or import a JSON chord file.');
      return;
    }
    openWordSetModal(null);
    $('wordSetModalTitle').textContent=`New Set from Chord Map (${words.length} words)`;
    $('wordSetName').value=`ChordMap (${words.length} words)`;
    $('wordSetInput').value=words.join(' ');
    wordSetSep='auto';
    document.querySelectorAll('#separatorBtns .mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.sep==='\n'));
    updateWordSetPreview();
  }

  /* ============================================================
     SETTINGS
  ============================================================ */
  function renderSettings(){
    const s=Storage.getSettings();
    $('settingSlowChordTime').value=s.slowChordTimeThreshold??3000;
    $('settingAutoAdvanceDelay').value=s.autoAdvanceDelay??600;
    $('settingSkipDelay').value=s.skipDelayMinutes??5;
    $('settingHintDelay').value=s.hintDelaySeconds??1;
    $('settingFirstSuccessInterval').value=s.firstSuccessIntervalDays??1;
    $('settingSecondSuccessInterval').value=s.secondSuccessIntervalDays??6;
    $('settingMaxIntervalDays').value=s.maxIntervalDays??365;
    $('settingEaseFactorDefault').value=s.easeFactorDefault??2.5;
    $('settingCaseInsensitive').checked=s.caseInsensitive;
    $('settingAfkThreshold').value=s.afkThresholdSeconds??5;
    $('settingLearnedThreshold').value=s.learnedThresholdDays??10;
    $('settingBackupReminderDays').value=s.backupReminderDays??7;
    $('themeDarkBtn').classList.toggle('active',s.theme==='dark');
    $('themeLightBtn').classList.toggle('active',s.theme==='light');
    /* Multi-select hint mode: highlight all active modes */
    const activeModes=s.hintModes??['wrong'];
    document.querySelectorAll('#hintModeBtns .mode-btn').forEach(b=>
      b.classList.toggle('active',activeModes.includes(b.dataset.hint)));
    const hintDelayRow=$('hintDelayRow');
    if(hintDelayRow)hintDelayRow.style.display=activeModes.includes('delay')?'':'none';
    renderCCStatus();
  }
  function saveSettings(){
    const s=Storage.getSettings();
    s.slowChordTimeThreshold=parseInt($('settingSlowChordTime').value)||3000;
    s.autoAdvanceDelay=parseInt($('settingAutoAdvanceDelay').value)||600;
    s.skipDelayMinutes=Math.max(0, parseInt($('settingSkipDelay').value) || 0);
    s.hintDelaySeconds=parseInt($('settingHintDelay').value)||1;
    s.firstSuccessIntervalDays=Math.max(1, parseInt($('settingFirstSuccessInterval').value) || 1);
    s.secondSuccessIntervalDays=Math.max(1, parseInt($('settingSecondSuccessInterval').value) || 6);
    s.maxIntervalDays=parseInt($('settingMaxIntervalDays').value)||365;
    s.easeFactorDefault=parseFloat($('settingEaseFactorDefault').value)||2.5;
    s.caseInsensitive=$('settingCaseInsensitive').checked;
    s.afkThresholdSeconds=Math.max(1, parseInt($('settingAfkThreshold').value)||5);
    s.learnedThresholdDays=Math.max(1, parseInt($('settingLearnedThreshold').value)||10);
    s.backupReminderDays=Math.max(0, parseInt($('settingBackupReminderDays').value)||7);
    Storage.saveSettings(s);
  }
  function setHintMode(mode){
    const s=Storage.getSettings();
    let modes=s.hintModes??['wrong'];
    if(mode==='never'||mode==='always'){
      /* Exclusive: selecting 'never' or 'always' clears everything else */
      modes=[mode];
    } else {
      /* 'wrong' and 'delay' are combinable; remove exclusive modes first */
      modes=modes.filter(m=>m!=='never'&&m!=='always');
      if(modes.includes(mode)){
        /* Toggle off */
        modes=modes.filter(m=>m!==mode);
        if(modes.length===0)modes=['never'];
      } else {
        modes.push(mode);
      }
    }
    s.hintModes=modes;
    delete s.hintMode; // clean up legacy key
    Storage.saveSettings(s);
    document.querySelectorAll('#hintModeBtns .mode-btn').forEach(b=>
      b.classList.toggle('active',modes.includes(b.dataset.hint)));
    const hintDelayRow=$('hintDelayRow');
    if(hintDelayRow)hintDelayRow.style.display=modes.includes('delay')?'':'none';
  }

  function renderCCStatus(){
    const stored=Storage.getChordMap(),el=$('ccStatus');if(!el)return;
    if(stored){
      const d=new Date(stored.syncedAt);
      const mapSize=stored.mapSize??Object.keys(stored.map||{}).length;
      el.innerHTML=`<span class="badge badge-ok">✓ Loaded</span> ${mapSize} chords from ${stored.source==='serial'?'device':'JSON'} (${d.toLocaleDateString()})`;
      $('chordMapInspector')?.classList.remove('hidden');
    }else{
      el.innerHTML='<span class="badge badge-neutral">Not loaded</span>';
      $('chordMapInspector')?.classList.add('hidden');
    }
    const btn=$('ccConnectBtn');
    if(btn){
      if(!CC.isSupported()){
        btn.disabled=true;
        btn.title='Web Serial not available in this browser or context.';
        const warn=$('ccBrowserWarn');if(warn)warn.classList.remove('hidden');
      }
    }
  }
  async function connectCharaChorder(){
    const btn=$('ccConnectBtn'),status=$('ccConnectStatus');
    btn.disabled=true;status.textContent='Connecting…';status.className='cc-status-msg';status.classList.remove('hidden');
    try{
      await CC.connectAndSync(msg=>{status.textContent=msg;});
      status.textContent='✓ Chord map loaded successfully!';status.className='cc-status-msg cc-status-ok';
      renderCCStatus();
    }catch(err){
      status.textContent='✗ '+(err.message||'Connection failed.');status.className='cc-status-msg cc-status-err';
    }finally{btn.disabled=false;}
  }

  /* ============================================================
     HELP / MODALS
  ============================================================ */
  function openHelp(){$('helpModal').classList.remove('hidden');}
  function closeHelp(){$('helpModal').classList.add('hidden');}
  function confirmAction(msg,cb){
    confirmCb=cb;$('confirmMessage').textContent=msg;$('confirmModal').classList.remove('hidden');
  }

  /* ============================================================
     INIT
  ============================================================ */
  function init(){
    const settings=Storage.getSettings();
    applyTheme(settings.theme);

    document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
    $('themeToggle').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
    $('themeDarkBtn').addEventListener('click',()=>applyTheme('dark'));
    $('themeLightBtn').addEventListener('click',()=>applyTheme('light'));
    $('helpBtn').addEventListener('click',openHelp);
    $('helpClose').addEventListener('click',closeHelp);
    $('helpCloseBtn').addEventListener('click',closeHelp);
    $('helpBackdrop').addEventListener('click',closeHelp);

    // Practice
    document.querySelectorAll('#practiceModeBtns .mode-btn').forEach(b=>
      b.addEventListener('click',()=>setPracticeMode(b.dataset.mode)));
    $('practiceInput').addEventListener('input',onPracticeInput);
    $('skipBtn').addEventListener('click',skipWord);
    $('continueTrainingBtn')?.addEventListener('click',()=>{
      $('practiceFinished').classList.add('hidden');
      $('practiceContent').classList.remove('hidden');
      PS.mode='random';
      document.querySelectorAll('#practiceModeBtns .mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode==='random'));
      renderQuickSettings('random');
      PS.word=null;nextPracticeWord();
    });
    $('trainSlowestWordsBtn')?.addEventListener('click',()=>{
      $('practiceFinished').classList.add('hidden');
      $('practiceContent').classList.remove('hidden');
      PS.mode='slow';
      document.querySelectorAll('#practiceModeBtns .mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode==='slow'));
      renderQuickSettings('slow');
      PS.word=null;nextPracticeWord();
    });
    $('goToWordSetsBtn')?.addEventListener('click',()=>switchTab('wordsets'));

    // Test
    $('startTestBtn').addEventListener('click',startTest);
    $('abortTestBtn').addEventListener('click',abortTest);
    $('newTestBtn').addEventListener('click',()=>{$('testResults').classList.add('hidden');$('testSetup').classList.remove('hidden');});
    $('testInput').addEventListener('input',onTestInput);
    $('testInput').addEventListener('keydown',onTestKeydown);
    document.querySelectorAll('#testSourceBtns .mode-btn').forEach(b=>
      b.addEventListener('click',()=>setTestSource(b.dataset.source)));

    // Stats
    $('wordStatsSearch').addEventListener('input',renderWordStatsTable);
    $('wordStatsSort').addEventListener('change',renderWordStatsTable);
    $('selectAllWords').addEventListener('change',e=>{
      document.querySelectorAll('#wordStatsBody .word-check').forEach(cb=>cb.checked=e.target.checked);
      updateResetSelectedBtn();
    });
    $('resetSelectedBtn').addEventListener('click',()=>{
      const words=[...document.querySelectorAll('#wordStatsBody .word-check:checked')].map(cb=>cb.dataset.word);
      if(!words.length)return;
      confirmAction(`Reset progress for ${words.length} word(s)?`,()=>{
        Storage.resetWordStats(words);$('selectAllWords').checked=false;
        renderWordStatsTable();updateResetSelectedBtn();
      });
    });

    // Word sets
    $('newWordSetBtn').addEventListener('click',()=>openWordSetModal(null));
    $('importFromChordMapBtn')?.addEventListener('click',generateWordSetFromChordMap);
    $('loadDefaultSetsBtn')?.addEventListener('click',()=>loadDefaultWordSets(false));
    $('wordSetClose').addEventListener('click',closeWordSetModal);
    $('wordSetBackdrop').addEventListener('click',closeWordSetModal);
    $('wordSetCancelBtn').addEventListener('click',closeWordSetModal);
    $('saveWordSetBtn').addEventListener('click',saveWordSet);
    $('wordSetInput').addEventListener('input',updateWordSetPreview);
    $('wordSetName').addEventListener('keydown',e=>{if(e.key==='Enter')saveWordSet();});
    document.querySelectorAll('#separatorBtns .mode-btn').forEach(b=>
      b.addEventListener('click',()=>{
        wordSetSep=b.dataset.sep;
        document.querySelectorAll('#separatorBtns .mode-btn').forEach(x=>x.classList.toggle('active',x===b));
        updateWordSetPreview();
      }));

    // Settings
    ['settingSlowChordTime','settingAutoAdvanceDelay','settingSkipDelay','settingHintDelay',
     'settingFirstSuccessInterval','settingSecondSuccessInterval',
     'settingMaxIntervalDays','settingEaseFactorDefault',
     'settingAfkThreshold','settingLearnedThreshold','settingBackupReminderDays'].forEach(id=>$(id)?.addEventListener('change',saveSettings));
    // Learned chart controls: initialize from settings and re-render on change
    const lcRange = $('learnedChartRange');
    const lcAgg = $('learnedChartAgg');
    if (lcRange) {
      const s = Storage.getSettings();
      const rv = s.learnedChartRangeDays ? String(s.learnedChartRangeDays) : '90';
      lcRange.value = rv;
      lcRange.addEventListener('change',()=>{
        const ss = Storage.getSettings();
        ss.learnedChartRangeDays = lcRange.value === 'all' ? 'all' : parseInt(lcRange.value)||90;
        Storage.saveSettings(ss);
        renderStats();
      });
    }
    if (lcAgg) {
      const s2 = Storage.getSettings();
      lcAgg.value = s2.learnedChartAggregation || 'day';
      lcAgg.addEventListener('change',()=>{
        const ss = Storage.getSettings(); ss.learnedChartAggregation = lcAgg.value||'day'; Storage.saveSettings(ss); renderStats();
      });
    }
    ['settingCaseInsensitive'].forEach(id=>$(id)?.addEventListener('change',saveSettings));
    document.querySelectorAll('#hintModeBtns .mode-btn').forEach(b=>b.addEventListener('click',()=>setHintMode(b.dataset.hint)));

    // SM-2 tuning actions
    $('bringAllDueBtn')?.addEventListener('click',()=>
      confirmAction('Set all words due now? They will appear immediately in Adaptive mode.',()=>{
        Storage.bringAllWordsDue();
        alert('Done — all words are now due.');
      }));
    $('bringForwardBtn')?.addEventListener('click',()=>{
      const days=parseInt($('bringForwardDaysInput')?.value)||0;
      const hours=Math.max(0,parseInt($('bringForwardHoursInput')?.value)||0);
      const fracDays = days + (hours/24);
      const label = `${days} day(s)` + (hours?` + ${hours} hour(s)`:'');
      confirmAction(`Bring all words forward by ${label}?`,()=>{
        Storage.bringForwardByDays(fracDays);
        alert(`Done — all due dates shifted forward by ${label}.`);
      });
    });

    $('resetBaseIntervalsBtn')?.addEventListener('click',()=>{
      confirmAction('Reset base intervals for ALL words? This will restart scheduling and clear learned states.',()=>{
        Storage.resetAllBaseIntervals();
        alert('Done — all base intervals reset to zero.');
      });
    });

    // CharaChorder
    $('ccConnectBtn')?.addEventListener('click',connectCharaChorder);
    $('ccImportBtn')?.addEventListener('click',()=>$('ccJsonInput')?.click());
    $('ccClearBtn')?.addEventListener('click',()=>
      confirmAction('Clear chord map? Hints will be hidden.',()=>{Storage.clearChordMap();renderCCStatus();}));
    // Chord map inspector
    $('chordLookupBtn')?.addEventListener('click',()=>lookupChordForWord($('chordLookupInput')?.value?.trim()));
    $('chordLookupInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')lookupChordForWord($('chordLookupInput')?.value?.trim());});
    $('showSampleBtn')?.addEventListener('click',toggleChordSample);
    $('ccJsonInput')?.addEventListener('change',e=>{
      const file=e.target.files[0];if(!file)return;
      const reader=new FileReader();
      reader.onload=ev=>{
        const status=$('ccConnectStatus');status.classList.remove('hidden');
        try{CC.importFromJson(ev.target.result);status.textContent='✓ Chord map loaded from JSON!';status.className='cc-status-msg cc-status-ok';renderCCStatus();}
        catch(err){status.textContent='✗ '+err.message;status.className='cc-status-msg cc-status-err';}
      };
      reader.readAsText(file);e.target.value='';
    });

    // Export / Import / Reset
    function downloadText(filename, text, mime='application/json'){
      try{
        const blob = new Blob([text], { type: mime+';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none'; a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=>URL.revokeObjectURL(url), 1500);
      }catch(e){
        // Fallback to data: URI if Blob/URL APIs are unavailable
        const a = document.createElement('a');
        a.href = 'data:application/json,' + encodeURIComponent(text);
        a.download = filename; a.click();
      }
    }

    $('exportDataBtn').addEventListener('click',()=>{
      const filename = `chordtrainer-backup-${new Date().toISOString().slice(0,10)}.json`;
      downloadText(filename, Storage.exportData());
    });
    $('importDataBtn').addEventListener('click',()=>$('importFileInput').click());
    $('importFileInput').addEventListener('change',e=>{
      const file=e.target.files[0];if(!file)return;
      const r=new FileReader();
      r.onload=ev=>{
        try{
          const choice=(prompt(
            'How should total practice time be imported?\n\n'
            + '1 = Overwrite current total with backup\n'
            + '2 = Aggregate (add backup + current)\n'
            + '3 = Keep current total (ignore backup total)\n\n'
            + 'Enter 1, 2, or 3 (default: 3).',
            '3'
          )||'3').trim();
          const practiceTimeMode=choice==='1'?'overwrite':choice==='2'?'aggregate':'keep';
          Storage.importData(ev.target.result,{practiceTimeMode});
          alert('Import successful! Reloading.');location.reload();
        }catch{alert('Import failed.');}
      };
      r.readAsText(file);e.target.value='';
    });
    $('resetAllBtn').addEventListener('click',()=>
      confirmAction('Reset ALL progress? Cannot be undone.',()=>{Storage.resetAllStats();PS.word=null;location.reload();}));

    // Confirm modal
    $('confirmOk').addEventListener('click',()=>{$('confirmModal').classList.add('hidden');if(confirmCb){confirmCb();confirmCb=null;}});
    $('confirmCancel').addEventListener('click',()=>{$('confirmModal').classList.add('hidden');confirmCb=null;});

    /* ── Global keydown ── */
    document.addEventListener('keydown',e=>{
      // Skip word on Escape (practice)
      if(e.key==='Escape'){
        const practiceActive=document.querySelector('#tab-practice.active');
        if(practiceActive&&document.activeElement===$('practiceInput'))skipWord();
      }

      // Space in test mode: confirm current word even if testInput momentarily lost focus
      // (CharaChorder trailing-space chord can cause brief focus drift)
      if(e.key===' '&&TS.running){
        const testActive=document.querySelector('#tab-test.active');
        if(testActive&&document.activeElement!==$('testInput')){
          e.preventDefault();
          $('testInput').focus();
          confirmTestWord();
          return;
        }
      }

      // Keep test input focused during a running test (Backspace, printable chars, etc.)
      if(TS.running&&document.activeElement!==$('testInput')){
        const testActive=document.querySelector('#tab-test.active');
        if(testActive){
          // Refocus without swallowing the key — let the browser replay it into the input
          $('testInput').focus();
        }
      }

      // Enter on test results → start new test with same settings
      if(e.key==='Enter'){
        const resultsVisible=$('testResults')&&!$('testResults').classList.contains('hidden');
        const testActive=document.querySelector('#tab-test.active');
        if(resultsVisible&&testActive&&document.activeElement?.tagName!=='BUTTON'){
          e.preventDefault();
          $('testResults').classList.add('hidden');
          $('testSetup').classList.remove('hidden');
          startTest();
        }
      }

      // Pulse input when typing in practice tab but focus is elsewhere
      if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
        const practiceActive=document.querySelector('#tab-practice.active');
        if(practiceActive&&PS.word&&document.activeElement!==$('practiceInput')){
          const inp=$('practiceInput');
          inp.classList.remove('anim-pulse');
          void inp.offsetWidth; // force reflow to restart animation
          inp.classList.add('anim-pulse');
        }
      }
    });

    refreshPracticeHeader();
    renderQuickSettings(PS.mode);
    refreshTestHeader();

    /* ── Out-of-focus / AFK detection ── */
    // When the page tab is hidden (user switches tabs) → treat as AFK for current attempt
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){
        if(PS.word&&!PS.waiting){PS.wasAfk=true;clearHintTimer(PS);}
      }
    });
    // When the browser window loses focus entirely → treat as AFK
    window.addEventListener('blur',()=>{
      if(PS.word&&!PS.waiting){PS.wasAfk=true;clearHintTimer(PS);}
    });
    // When practice input loses focus (user clicked somewhere in the page) → treat as AFK
    $('practiceInput')?.addEventListener('blur',(e)=>{
      // Except when focus moves to the Skip button (intentional action)
      if(PS.word&&!PS.waiting&&e.relatedTarget!==$('skipBtn')){
        PS.wasAfk=true;clearHintTimer(PS);
      }
    });

    // Backup reminder banner export button: delegate to the Settings export button
    $('backupReminderExportBtn')?.addEventListener('click',()=>{
      // Reuse the same export action as the Settings export button to ensure consistent behavior
      const settingsExport = $('exportDataBtn');
      if(settingsExport){ settingsExport.click(); }
      else {
        const filename = `chordtrainer-backup-${new Date().toISOString().slice(0,10)}.json`;
        downloadText(filename, Storage.exportData());
      }
      $('backupReminderBanner')?.classList.add('hidden');
    });
    $('backupReminderDismissBtn')?.addEventListener('click',()=>{
      $('backupReminderBanner')?.classList.add('hidden');
    });

    // Congratulation card export button (always visible on finished card)
    $('practiceExportBtn')?.addEventListener('click',()=>{
      const settingsExport = $('exportDataBtn');
      if(settingsExport) settingsExport.click();
      else { const filename = `chordtrainer-backup-${new Date().toISOString().slice(0,10)}.json`; downloadText(filename, Storage.exportData()); }
    });

    // Modal buttons for backup reminder (shown when reminder triggers off the congrats page)
    $('backupReminderModalExportBtn')?.addEventListener('click',()=>{
      $('exportDataBtn')?.click();
      $('backupReminderModal')?.classList.add('hidden');
    });
    $('backupReminderModalDismissBtn')?.addEventListener('click',()=>{
      $('backupReminderModal')?.classList.add('hidden');
    });
    $('backupModalClose')?.addEventListener('click',()=>{$('backupReminderModal')?.classList.add('hidden');});
    $('backupModalBackdrop')?.addEventListener('click',()=>{$('backupReminderModal')?.classList.add('hidden');});

    // Changelog modal: fetch a local CHANGELOG.md (with fallbacks) and render markdown (sanitized)
    $('changelogBtn')?.addEventListener('click', async ()=>{
      const modal = $('changelogModal'); if(!modal) return; modal.classList.remove('hidden');
      const content = $('changelogContent'); if(content) content.innerHTML = '<div style="opacity:.7">Loading…</div>';

      const tryFetchText = async (url) => {
        try {
          const res = await fetch(url);
          if (!res || !res.ok) return null;
          const txt = await res.text();
          return { txt, contentType: (res.headers.get('content-type') || '') };
        } catch (e) { return null; }
      };

      const escapeHtml = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      // Candidate paths: try common names and extensions
      const candidates = ['CHANGELOG.md','CHANGELOG.html','changelog.md','changelog.html','CHANGELOG','changelog','/CHANGELOG.md','/CHANGELOG.html'];

      // If hosted on GitHub Pages, try raw.githubusercontent.com fallbacks (common branches)
      try {
        const host = window.location.hostname || '';
        if (host.endsWith('.github.io')) {
          const owner = host.split('.')[0];
          const pathSegs = (window.location.pathname || '').split('/').filter(Boolean);
          const repoGuess = pathSegs.length ? pathSegs[0] : owner;
          const branches = ['main','master','gh-pages'];
          for (const br of branches) {
            candidates.push(`https://raw.githubusercontent.com/${owner}/${repoGuess}/${br}/CHANGELOG.md`);
            candidates.push(`https://raw.githubusercontent.com/${owner}/${repoGuess}/${br}/changelog.md`);
          }
        }
      } catch (e) {}

      let loaded = false;
      for (const url of candidates) {
        const res = await tryFetchText(url);
        if (!res) continue;
        let { txt, contentType } = res;
        let html = '';
        // If server returned HTML (likely Jekyll-rendered), try to extract main/article/markdown section
        if (contentType.includes('text/html') || /<\/html>/i.test(txt)) {
          try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(txt, 'text/html');
            const candidate = doc.querySelector('main') || doc.querySelector('article') || doc.querySelector('.markdown-body') || doc.querySelector('#content') || doc.body;
            html = candidate ? candidate.innerHTML : doc.documentElement.innerHTML;
          } catch (e) {
            html = txt; // fallback: treat as HTML
          }
        } else {
          if (window.marked) html = marked.parse(txt);
          else html = '<pre style="white-space:pre-wrap;margin:0">'+escapeHtml(txt)+'</pre>';
        }
        if (window.DOMPurify) html = DOMPurify.sanitize(html);
        if (content) content.innerHTML = html;
        loaded = true; break;
      }

      if (!loaded) {
        if (content) content.textContent = 'Could not load Update News. On GitHub Pages raw .md files may not be published; try adding a pre-rendered changelog or a raw link in Settings.';
      }
    });
    $('changelogClose')?.addEventListener('click',()=>{$('changelogModal')?.classList.add('hidden');});
    $('changelogBackdrop')?.addEventListener('click',()=>{$('changelogModal')?.classList.add('hidden');});

    if(Storage.isFirstVisit())openHelp();
    if('serviceWorker' in navigator){
      const host=window.location.hostname;
      const isLocal=host==='localhost'||host==='127.0.0.1'||host==='::1';
      if(isLocal){
        navigator.serviceWorker.getRegistrations().then(regs=>regs.forEach(r=>r.unregister()));
        if('caches' in window)caches.keys().then(keys=>Promise.all(keys.map(k=>caches.delete(k))));
      }else{
        navigator.serviceWorker.register('./sw.js').catch(()=>{});
      }
    }
  }

  return{init,switchTab,openHelp,closeHelp};
})();

document.addEventListener('DOMContentLoaded',App.init);
