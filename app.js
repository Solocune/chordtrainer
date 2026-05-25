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
  };

  const DEFAULTS = {
    testWordCount:          20,
    slowChordTimeThreshold: 3000,
    caseInsensitive:        true,
    showWordStats:          true,
    autoAdvanceDelay:       600,
    theme:                  'dark',
    hintModes:              ['wrong','delay'],  // array; 'never'|'always' exclusive, 'wrong'+'delay' combinable
    hintDelaySeconds:       1,
    maxIntervalDays:        365,
    easeFactorDefault:      2.5,
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
        interval: 1, easeFactor: api.getSettings().easeFactorDefault ?? 2.5, repetitions: 0,
        due: Date.now(), firstSeen: Date.now(), lastSeen: null,
      };
    },

    updateWordResult(word, result) {
      const all = api.getAllWordStats();
      const now = Date.now();
      const s   = all[word] || api._initStat(word);
      s.lastSeen = now;
      if (result.skipped) {
        s.attempts++; s.skipped = (s.skipped || 0) + 1;
        s.repetitions = 0; s.interval = 1;
        s.due = now + 5 * 60 * 1000;
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
        if      (s.repetitions === 0) s.interval = 1;
        else if (s.repetitions === 1) s.interval = 6;
        else s.interval = Math.round(s.interval * s.easeFactor);
        s.repetitions++;
        s.easeFactor = Math.max(1.3, s.easeFactor + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
      } else { s.repetitions = 0; s.interval = 1; }
      s.interval = Math.min(s.interval, api.getSettings().maxIntervalDays ?? 365);
      s.due = now + s.interval * 86400 * 1000;
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
        s.due = Math.max(now, (s.due ?? now) - shift);
        s.interval = Math.max(1, Math.round((s.interval ?? 1) - days));
      }
      save(K.STATS, all);
    },

    getWordSets:  () => load(K.SETS, { sets: [], activeId: null }),
    saveWordSets: (d) => save(K.SETS, d),
    getActiveWords() {
      const { sets, activeId } = api.getWordSets();
      return sets.find(s => s.id === activeId)?.words ?? [];
    },
    getActiveSetName() {
      const { sets, activeId } = api.getWordSets();
      return sets.find(s => s.id === activeId)?.name ?? 'None';
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
        version: '1.3', exportDate: new Date().toISOString(),
        wordStats: api.getAllWordStats(), wordSets: api.getWordSets(),
        sessions: api.getSessions(), settings: api.getSettings(),
      }, null, 2);
    },
    importData(json) {
      const d = JSON.parse(json);
      if (d.wordStats) save(K.STATS,    d.wordStats);
      if (d.wordSets)  save(K.SETS,     d.wordSets);
      if (d.sessions)  save(K.SESSIONS, d.sessions);
      if (d.settings)  save(K.SETTINGS, d.settings);
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
      const pool = words.length > 1 ? words.filter(w => w !== lastWord) : [...words];
      const all  = Storage.getAllWordStats();
      const now  = Date.now();
      const t    = settings.slowChordTimeThreshold ?? 3000;
      const scored = pool.map(word => {
        const s = all[word];
        let score = 1;
        switch (mode) {
          case 'adaptive': {
            if (!s || s.attempts === 0) { score = 8; break; }
            const daysOverdue = Math.max(0, (now - (s.due ?? now)) / 86400000);
            score = 1 + daysOverdue * 2.5;
            const acc = s.attempts ? s.correctFirstTry / s.attempts : 0;
            if (acc < 0.5)  score *= 2.5;
            if (acc < 0.25) score *= 2;
            const ct = avgArr(s.chordTimeHistory);
            if (ct && ct > t) score *= 1.4;
            break;
          }
          case 'slow': {
            if (!s?.chordTimeHistory?.length) { score = 4; break; }
            score = Math.max(0.1, avgArr(s.chordTimeHistory) / 500);
            break;
          }
          case 'wrong': {
            if (!s || s.attempts === 0) { score = 4; break; }
            const acc = s.correctFirstTry / s.attempts;
            score = Math.max(0.1, 2.2 - acc * 2);
            break;
          }
          default: score = 1;
        }
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
    const sp = {
      40:'↵', 41:'Esc', 42:'⌫', 43:'Tab', 44:'Spc',
      45:'-', 46:'=', 47:'[', 48:']', 49:'\\', 51:';', 52:"'", 53:'`', 54:',', 55:'.', 56:'/',
      79:'→', 80:'←', 81:'↓', 82:'↑',
      8:'⌫', 9:'Tab', 13:'↵', 27:'Esc',
      32:'Spc', 300:'Spc',   // 32 = ASCII space, 300 = KSC alias
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
    // US-International AltGr combos + device-specific extended codes
    if (CC_CHAR_MAP[code]) return CC_CHAR_MAP[code];
    return `#${code}`;
  }
  function formatChordKeys(codes) { return codes?.length ? codes.map(codeLabel).join('+') : ''; }
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
      return entry.keys?.length ? formatChordKeys(entry.keys) : (entry.display ?? null);
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
  if(ts<=Date.now())return'<span style="color:var(--err)">Overdue</span>';
  const d=Math.floor((ts-Date.now())/86400000);
  if(d===0)return'Today';if(d===1)return'Tomorrow';return`in ${d}d`;
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

  let wordSetEditId=null, wordSetSep='auto', confirmCb=null, wpmChart=null, testWpmChart=null;
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
    if(document.querySelector('#tab-stats.active')&&wpmChart)renderWpmChart(Storage.getSessions());
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
  function refreshPracticeHeader(){
    const data=Storage.getWordSets();
    const active=data.sets.find(s=>s.id===data.activeId);
    $('practiceActiveSetName').textContent=active?.name??'None';
    $('practiceWordCount').textContent=active?`(${active.words.length} words)`:'';
    const hasWords=active&&active.words.length>0;
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
    PS.word=null;
    nextPracticeWord();
  }

  function checkAllDone(words){
    const all=Storage.getAllWordStats(),now=Date.now();
    return words.length>0&&words.every(w=>{const s=all[w];return s&&s.attempts>0&&s.due>now;});
  }

  function nextPracticeWord(){
    const words=Storage.getActiveWords();
    if(!words.length)return;
    const settings=Storage.getSettings();
    if(PS.mode==='adaptive'&&checkAllDone(words)){showPracticeFinished();return;}
    const w=Adaptive.getNextWord(words,PS.mode,PS.word,settings);
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
    // AFK timer: if no activity for 5 s, exclude this attempt from stats
    if(PS.afkTimer){clearTimeout(PS.afkTimer);PS.afkTimer=null;}
    PS.wasAfk=false;
    PS.afkTimer=setTimeout(()=>{PS.afkTimer=null;PS.wasAfk=true;},5000);

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

    // AFK timer: reset on any activity
    if(PS.afkTimer){clearTimeout(PS.afkTimer);PS.afkTimer=null;}
    if(!PS.wasAfk){
      PS.afkTimer=setTimeout(()=>{PS.afkTimer=null;PS.wasAfk=true;},5000);
    }

    // Pause detection
    if(PS.lastActivityAt>0){
      const gap=now-PS.lastActivityAt;
      if(gap>5000){
        PS.totalPausedMs+=gap-5000;
        if(PS.firstKeyAt===null)PS.shownAt+=gap-5000;
      }
    } else if(PS.firstKeyAt===null){
      // No activity yet — check gap from when word was shown
      const gap=now-PS.shownAt;
      if(gap>5000){const excess=gap-5000;PS.totalPausedMs+=excess;PS.shownAt+=excess;}
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
      Storage.updateWordResult(target,{
        correct:true,hadRetry,delay,chordTime:chordTime>0?chordTime:null,quality,
      });
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
    Storage.updateWordResult(PS.word,{skipped:true});
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
    if (!word) { el.innerHTML = ''; return; }
    const stored = Storage.getChordMap();
    if (!stored?.map) {
      el.innerHTML = '<span class="cdsp-none">no chord map loaded — import one in <a href="#" onclick="App.switchTab(\'settings\');return false">Settings</a></span>';
      return;
    }
    const entry = stored.map[word.toLowerCase()];
    if (!entry) { el.innerHTML = '<span class="cdsp-none">no chord mapped for this word</span>'; return; }
    const keys = entry.keys?.length ? formatChordKeys(entry.keys) : (entry.display ?? '');
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
    const keys = entry.keys?.length ? formatChordKeys(entry.keys) : (entry.display ?? '?');
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
        if(gap>5000){
          const excess=gap-5000;
          TS.wordPausedMs+=excess;TS.totalPausedMs+=excess;
          if(TS.firstKeyAt===null)TS.shownAt+=excess;
        }
      } else if(TS.firstKeyAt===null){
        const gap=now-TS.shownAt;
        if(gap>5000){const excess=gap-5000;TS.wordPausedMs+=excess;TS.totalPausedMs+=excess;TS.shownAt+=excess;}
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
    const words=Object.values(all);
    $('statsTotalWords').textContent=words.length;
    $('statsTotalSessions').textContent=sessions.length;
    const allCts=words.flatMap(w=>w.chordTimeHistory??[]);
    $('statsAvgChordTime').textContent=allCts.length?fmtChordTime(Math.round(avgArr(allCts))):'—';
    const ta=words.reduce((s,w)=>s+(w.attempts??0),0);
    const tc=words.reduce((s,w)=>s+(w.correctFirstTry??0),0);
    $('statsOverallAccuracy').textContent=ta>0?Math.round(tc/ta*100)+'%':'—';
    $('statsTotalPractice').textContent=fmtPracticeTime(Storage.getTotalPracticeMs());
    renderWpmChart(sessions);renderWordStatsTable();renderSessionHistory(sessions);
  }

  function renderWpmChart(sessions){
    const canvas=$('wpmChart');
    if(!sessions.length){$('noChartMsg').style.display='block';canvas.style.display='none';return;}
    $('noChartMsg').style.display='none';canvas.style.display='block';
    const recent=sessions.slice(-40);
    const labels=recent.map(s=>{const d=new Date(s.date);return`${d.getMonth()+1}/${d.getDate()}`;});
    const data=recent.map(s=>s.wpm);
    const dark=document.documentElement.dataset.theme!=='light';
    const gc=dark?'rgba(255,255,255,.07)':'rgba(0,0,0,.07)';
    const tc=dark?'#8b949e':'#636c76';
    if(wpmChart)wpmChart.destroy();
    wpmChart=new Chart(canvas,{
      type:'line',
      data:{labels,datasets:[{label:'WPM',data,borderColor:'#58a6ff',backgroundColor:'rgba(88,166,255,.12)',tension:.35,fill:true,pointRadius:3,pointBackgroundColor:'#58a6ff'}]},
      options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{grid:{color:gc},ticks:{color:tc,maxTicksLimit:10}},y:{grid:{color:gc},ticks:{color:tc},beginAtZero:true}}},
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
    const{sets,activeId}=Storage.getWordSets();
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
      const isActive=set.id===activeId;
      return`<div class="word-set-card ${isActive?'is-active':''}">
        <div class="wsc-info">
          <div class="wsc-name ${isActive?'is-active':''}">${escHtml(set.name)}</div>
          <div class="wsc-meta">${set.words.length} word${set.words.length!==1?'s':''}</div>
          <div class="wsc-preview">${escHtml(set.words.slice(0,12).join(' '))}${set.words.length>12?'…':''}</div>
        </div>
        <div class="wsc-actions">
          ${!isActive?`<button class="btn btn-primary btn-small set-active-btn" data-id="${set.id}">Set Active</button>`:''}
          <button class="btn btn-secondary btn-small edit-set-btn" data-id="${set.id}">Edit</button>
          <button class="btn btn-danger btn-small delete-set-btn" data-id="${set.id}">Delete</button>
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.set-active-btn').forEach(b=>b.addEventListener('click',()=>setActiveWordSet(b.dataset.id)));
    list.querySelectorAll('.edit-set-btn').forEach(b=>b.addEventListener('click',()=>openWordSetModal(b.dataset.id)));
    list.querySelectorAll('.delete-set-btn').forEach(b=>b.addEventListener('click',()=>deleteWordSet(b.dataset.id)));
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
    if(!data.activeId&&data.sets.length)data.activeId=data.sets[0].id;
    if(activate&&!data.activeId&&data.sets.length)data.activeId=data.sets[0].id;
    Storage.saveWordSets(data);
    if(btn){btn.disabled=false;btn.textContent=`+ English Sets${added?` (${added} added)`:' (already loaded)'}` ;}
    renderWordSets();refreshPracticeHeader();refreshTestHeader();
    if(added)alert(`Loaded ${added} default English word set${added!==1?'s':''}! The first one is now active.`);
    else alert('Default word sets are already loaded.');
  }

  function setActiveWordSet(id){
    const data=Storage.getWordSets();data.activeId=id;Storage.saveWordSets(data);
    PS.word=null;renderWordSets();refreshPracticeHeader();refreshTestHeader();
  }
  function deleteWordSet(id){
    const data=Storage.getWordSets(),set=data.sets.find(s=>s.id===id);
    confirmAction(`Delete "${set?.name}"? Word progress is kept.`,()=>{
      data.sets=data.sets.filter(s=>s.id!==id);
      if(data.activeId===id)data.activeId=data.sets[0]?.id??null;
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
      $('wordSetInput').value=set.words.join('\n');
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
      if(!data.activeId)data.activeId=newSet.id;
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
    $('wordSetInput').value=words.join('\n');
    wordSetSep='\n';
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
    $('settingHintDelay').value=s.hintDelaySeconds??1;
    $('settingMaxIntervalDays').value=s.maxIntervalDays??365;
    $('settingEaseFactorDefault').value=s.easeFactorDefault??2.5;
    $('settingCaseInsensitive').checked=s.caseInsensitive;
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
    s.hintDelaySeconds=parseInt($('settingHintDelay').value)||1;
    s.maxIntervalDays=parseInt($('settingMaxIntervalDays').value)||365;
    s.easeFactorDefault=parseFloat($('settingEaseFactorDefault').value)||2.5;
    s.caseInsensitive=$('settingCaseInsensitive').checked;
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
      PS.word=null;nextPracticeWord();
    });
    $('trainSlowestWordsBtn')?.addEventListener('click',()=>{
      $('practiceFinished').classList.add('hidden');
      $('practiceContent').classList.remove('hidden');
      PS.mode='slow';
      document.querySelectorAll('#practiceModeBtns .mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode==='slow'));
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
    ['settingSlowChordTime','settingAutoAdvanceDelay','settingHintDelay',
     'settingMaxIntervalDays','settingEaseFactorDefault'].forEach(id=>$(id)?.addEventListener('change',saveSettings));
    ['settingCaseInsensitive'].forEach(id=>$(id)?.addEventListener('change',saveSettings));
    document.querySelectorAll('#hintModeBtns .mode-btn').forEach(b=>b.addEventListener('click',()=>setHintMode(b.dataset.hint)));

    // SM-2 tuning actions
    $('bringAllDueBtn')?.addEventListener('click',()=>
      confirmAction('Set all words due now? They will appear immediately in Adaptive mode.',()=>{
        Storage.bringAllWordsDue();
        alert('Done — all words are now due.');
      }));
    $('bringForwardBtn')?.addEventListener('click',()=>{
      const days=parseInt($('bringForwardDaysInput')?.value)||1;
      confirmAction(`Bring all words forward by ${days} day(s)?`,()=>{
        Storage.bringForwardByDays(days);
        alert(`Done — all word review intervals shifted forward by ${days} day(s).`);
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
    $('exportDataBtn').addEventListener('click',()=>{
      const a=document.createElement('a');
      a.href='data:application/json,'+encodeURIComponent(Storage.exportData());
      a.download=`chordtrainer-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();
    });
    $('importDataBtn').addEventListener('click',()=>$('importFileInput').click());
    $('importFileInput').addEventListener('change',e=>{
      const file=e.target.files[0];if(!file)return;
      const r=new FileReader();
      r.onload=ev=>{try{Storage.importData(ev.target.result);alert('Import successful! Reloading.');location.reload();}catch{alert('Import failed.');}};
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
    refreshTestHeader();
    if(Storage.isFirstVisit())openHelp();
    if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }

  return{init,switchTab,openHelp,closeHelp};
})();

document.addEventListener('DOMContentLoaded',App.init);
