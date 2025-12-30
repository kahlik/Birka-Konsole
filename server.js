// server.js
// Combined portal: Schedule + Checklist + Chat (placeholder)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Treat /route and /route/ as different (avoids redirect loops)
app.set('strict routing', true);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------
// Landing portal
// ---------------------------

// Pretty paths (no iframe): redirect base routes to trailing slash
app.get('/schedule', (req,res)=>res.redirect('/schedule/'));
app.get('/checklist', (req,res)=>res.redirect('/checklist/'));
app.get('/chat', (req,res)=>res.redirect('/chat/'));

app.use('/', express.static(path.join(__dirname, 'public')));

// =========================================================
// SCHEDULE APP (mounted at /schedule)
// =========================================================

const scheduleBase = path.join(__dirname, 'apps', 'schedule');
const schedulePublic = path.join(scheduleBase, 'public');
const prioritiesPath = path.join(scheduleBase, 'priorities.json');

const API_KEY = process.env.THESPORTSDB_KEY || '3';
const BASE_URL = 'https://www.thesportsdb.com/api/v1/json';
const TIME_OFFSET_MINUTES = 60; // Sweden winter-time correction used in the original app
const MATCH_DURATION_MINUTES = 120;

function loadPriorities() {
  try {
    const raw = fs.readFileSync(prioritiesPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      eventIds: parsed.eventIds || [],
      tags: parsed.tags || {}
    };
  } catch {
    return { eventIds: [], tags: {} };
  }
}
function savePriorities(data) {
  fs.writeFileSync(prioritiesPath, JSON.stringify(data, null, 2), 'utf8');
}
let PRIORITIES = loadPriorities();

const ALLOWED_LEAGUES = [
  { id: 4347, name: 'Allsvenskan',       seasonType: 'single' },
  { id: 4328, name: 'Premier League',    seasonType: 'range'  },
  { id: 4480, name: 'Champions League',  seasonType: 'range'  },
  { id: 4570, name: 'EFL Cup',           seasonType: 'range'  },
  { id: 4429, name: 'Fotbolls-VM',       seasonType: 'range'  },
  { id: 4419, name: 'SHL',               seasonType: 'range'  },
  { id: 5162, name: 'Hockeyallsvenskan', seasonType: 'range'  },
  { id: 4370, name: 'F1',                seasonType: 'single' },
  { id: 4373, name: 'IndyCar',           seasonType: 'single' },
  { id: 4554, name: 'Dart',              seasonType: 'single' }
];

const CHANNEL_RULES = [
  { test: /allsvenskan/i,                       channel: 'Discovery+' },
  { test: /premier league/i,                    channel: 'Viaplay / Viasat' },
  { test: /champions league/i,                  channel: 'Viaplay / V Sport Fotboll' },
  { test: /\bshl\b/i,                           channel: 'TV4' },
  { test: /hockeyallsvenskan/i,                 channel: 'TV4' },
  { test: /\bf1\b|\bformula 1\b/i,              channel: 'Viaplay / Viasat' },
  { test: /indycar/i,                           channel: 'Viaplay / Viasat' },
  { test: /dart/i,                              channel: 'Viaplay / Viasat' },
  { test: /fotbolls[- ]?vm|fifa world cup|vm/i, channel: 'Viaplay' },
  { test: /efl cup|league cup/i,                channel: 'Viaplay' }
];

function mapChannel(comp, text = '') {
  const combined = `${comp} ${text}`.toLowerCase();
  for (const rule of CHANNEL_RULES) {
    if (rule.test.test(combined)) return rule.channel;
  }
  return '';
}

function getSeasonForLeague(league) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (league.seasonType === 'single') return String(year);
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

function getPreviousSeason(league, season) {
  if (league.seasonType === 'single') return String(Number(season) - 1);
  const m = season.match(/(\d{4})-(\d{4})/);
  if (!m) return season;
  return `${Number(m[1]) - 1}-${Number(m[2]) - 1}`;
}

function addDaysISO(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function applyTimeOffset(dateStr, rawTime) {
  if (!rawTime) return { date: dateStr, time: '' };
  const [hStr, mStr] = rawTime.split(':');
  if (hStr == null || mStr == null) return { date: dateStr, time: rawTime };

  let minutesTotal = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
  minutesTotal += TIME_OFFSET_MINUTES;

  let base = new Date(dateStr + 'T12:00:00Z');

  while (minutesTotal < 0) {
    minutesTotal += 1440;
    base.setUTCDate(base.getUTCDate() - 1);
  }
  while (minutesTotal >= 1440) {
    minutesTotal -= 1440;
    base.setUTCDate(base.getUTCDate() + 1);
  }

  const newDate = base.toISOString().slice(0, 10);
  const hh = String(Math.floor(minutesTotal / 60)).padStart(2, '0');
  const mm = String(minutesTotal % 60).padStart(2, '0');

  return { date: newDate, time: `${hh}:${mm}` };
}

async function fetchEventsForLeague(league) {
  const season = getSeasonForLeague(league);
  const url1 = `${BASE_URL}/${API_KEY}/eventsseason.php?id=${league.id}&s=${season}`;
  try {
    const r1 = await axios.get(url1);
    let events = r1.data.events || [];
    if (!events.length) {
      const prev = getPreviousSeason(league, season);
      const url2 = `${BASE_URL}/${API_KEY}/eventsseason.php?id=${league.id}&s=${prev}`;
      const r2 = await axios.get(url2);
      events = r2.data.events || [];
    }
    return events;
  } catch (e) {
    console.log('Fetch error', league.name, e.message);
    return [];
  }
}

const scheduleRouter = express.Router();

// static UI
scheduleRouter.use('/', express.static(schedulePublic));

// API: schedule
scheduleRouter.get('/api/schedule', async (req, res) => {
  try {
    const now = new Date();
    const results = await Promise.all(ALLOWED_LEAGUES.map(fetchEventsForLeague));
    const dayMap = new Map();

    results.forEach((events, idx) => {
      const league = ALLOWED_LEAGUES[idx];
      events.forEach((ev) => {
        const rawDate = ev.dateEvent || ev.dateEventLocal;
        const rawTime = ev.strTime ? ev.strTime.slice(0, 5) : (ev.strTimeLocal ? ev.strTimeLocal.slice(0, 5) : '');
        if (!rawDate) return;

        const { date: adjDate, time: adjTime } = applyTimeOffset(rawDate, rawTime);

        const startDT = adjTime ? new Date(`${adjDate}T${adjTime}:00`) : new Date(`${adjDate}T12:00:00`);
        const endDT = new Date(startDT.getTime() + MATCH_DURATION_MINUTES * 60000);
        if (endDT < now) return;

        if (!dayMap.has(adjDate)) dayMap.set(adjDate, { date: adjDate, matches: [] });

        const id = String(ev.idEvent || '');
        const isPriority = PRIORITIES.eventIds.includes(id);
        const tagsForId = Array.isArray(PRIORITIES.tags[id]) ? PRIORITIES.tags[id] : [];

        dayMap.get(adjDate).matches.push({
          id,
          time: adjTime,
          competition: league.name,
          home: ev.strHomeTeam || '',
          away: ev.strAwayTeam || '',
          channel: mapChannel(league.name, (ev.strHomeTeam || '') + (ev.strAwayTeam || '')),
          priority: isPriority,
          tags: tagsForId,
        });
      });
    });

    const allDays = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    allDays.forEach((day) => {
      day.matches.sort((a, b) => {
        if (!a.time && !b.time) return 0;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time.localeCompare(b.time);
      });
    });

    const today = new Date().toISOString().slice(0, 10);
    const end = addDaysISO(today, 13);

    let windowDays = allDays.filter((d) => d.date >= today && d.date <= end);
    if (!windowDays.length) {
      const future = allDays.filter((d) => d.date >= today);
      windowDays = future.length ? future.slice(0, 14) : allDays.slice(0, 14);
    }

    return res.json({ generatedAt: new Date().toISOString(), days: windowDays });
  } catch (e) {
    console.error('schedule error', e);
    return res.status(500).json({ error: e.message });
  }
});

scheduleRouter.post('/api/priorities/toggle', (req, res) => {
  const id = String(req.body?.id || '');
  if (!id) return res.json({ ok: false });

  const idx = PRIORITIES.eventIds.indexOf(id);
  if (idx >= 0) PRIORITIES.eventIds.splice(idx, 1);
  else PRIORITIES.eventIds.push(id);

  savePriorities(PRIORITIES);
  return res.json({ ok: true, eventIds: PRIORITIES.eventIds });
});

scheduleRouter.post('/api/tags/toggle', (req, res) => {
  const id = String(req.body?.id || '');
  const tag = req.body?.tag;
  if (!id || !tag) return res.json({ ok: false });

  if (!PRIORITIES.tags) PRIORITIES.tags = {};
  if (!Array.isArray(PRIORITIES.tags[id])) PRIORITIES.tags[id] = [];

  const list = PRIORITIES.tags[id];
  const idx = list.indexOf(tag);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(tag);

  savePriorities(PRIORITIES);
  return res.json({ ok: true, tagsForId: PRIORITIES.tags[id] });
});

app.use('/schedule', scheduleRouter);

// =========================================================
// CHECKLIST APP (mounted at /checklist)
// =========================================================

const checklistBase = path.join(__dirname, 'apps', 'checklist');
const checklistPublic = path.join(checklistBase, 'public');
const checklistDataDir = path.join(checklistBase, 'data');
const TEMPLATE_PATH = path.join(checklistBase, 'checklist.default.json');
const SUBMISSIONS_PATH = path.join(checklistDataDir, 'submissions.json');

if (!fs.existsSync(checklistDataDir)) fs.mkdirSync(checklistDataDir, { recursive: true });
if (!fs.existsSync(SUBMISSIONS_PATH)) fs.writeFileSync(SUBMISSIONS_PATH, '[]', 'utf8');

function nowIso() {
  return new Date().toISOString();
}

function loadTemplate() {
  try {
    const raw = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    const t = JSON.parse(raw);
    return {
      opening: Array.isArray(t.opening) ? t.opening : [],
      closing: Array.isArray(t.closing) ? t.closing : [],
    };
  } catch {
    return { opening: [], closing: [] };
  }
}

function loadSubmissions() {
  try {
    if (!fs.existsSync(SUBMISSIONS_PATH)) return [];
    const raw = fs.readFileSync(SUBMISSIONS_PATH, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function saveSubmissions(list) {
  atomicWriteJson(SUBMISSIONS_PATH, list);
}

function nextId(submissions) {
  let maxId = 0;
  for (const s of submissions) {
    const n = Number(s.id);
    if (Number.isFinite(n) && n > maxId) maxId = n;
  }
  return maxId + 1;
}

function findByDateType(submissions, date, type) {
  return submissions.find((s) => s && s.date === date && s.type === type);
}

const checklistRouter = express.Router();

// static UI
checklistRouter.use('/', express.static(checklistPublic));

// Template
checklistRouter.get('/api/template/:type', (req, res) => {
  const type = req.params.type;
  if (!['opening', 'closing'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const template = loadTemplate();
  return res.json({ type, items: template[type] || [] });
});

// Fetch existing submission for same date+type
checklistRouter.get('/api/current', (req, res) => {
  const { date, type } = req.query || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: 'Bad date' });
  if (!['opening', 'closing'].includes(String(type))) return res.status(400).json({ error: 'Bad type' });

  const submissions = loadSubmissions();
  const s = findByDateType(submissions, String(date), String(type));
  if (!s) return res.json({ found: false });

  return res.json({
    found: true,
    id: s.id,
    date: s.date,
    type: s.type,
    checked: Array.isArray(s.checked) ? s.checked.map(Boolean) : [],
    signature: s.signature || '',
    note: s.note || '',
    created_at: s.created_at || null,
    updated_at: s.updated_at || null,
  });
});

// Submit (UPSERT same date+type)
checklistRouter.post('/api/submit', (req, res) => {
  const { date, type, checked, signature, note } = req.body || {};

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });
  if (!['opening', 'closing'].includes(type)) return res.status(400).json({ error: 'Bad type' });
  if (!Array.isArray(checked)) return res.status(400).json({ error: 'Checked must be array' });
  if (!signature || String(signature).trim().length < 2) return res.status(400).json({ error: 'Signature required' });

  const template = loadTemplate()[type] || [];
  if (checked.length !== template.length) return res.status(400).json({ error: 'Checked length mismatch with template' });

  const submissions = loadSubmissions();
  const existing = findByDateType(submissions, date, type);
  const now = nowIso();

  if (existing) {
    existing.checked = checked.map(Boolean);
    existing.signature = String(signature).trim();
    existing.note = note ? String(note).trim() : null;
    existing.updated_at = now;

    try {
      saveSubmissions(submissions);
      return res.json({ ok: true, id: existing.id, mode: 'updated' });
    } catch {
      return res.status(500).json({ error: 'Could not save' });
    }
  }

  const id = nextId(submissions);
  const submission = {
    id,
    date,
    type,
    checked: checked.map(Boolean),
    signature: String(signature).trim(),
    note: note ? String(note).trim() : null,
    created_at: now,
    updated_at: now,
  };

  submissions.push(submission);
  try {
    saveSubmissions(submissions);
    return res.json({ ok: true, id, mode: 'created' });
  } catch {
    return res.status(500).json({ error: 'Could not save' });
  }
});

// History
checklistRouter.get('/api/history', (req, res) => {
  const days = Math.min(parseInt(req.query.days || '14', 10), 90);
  const submissions = loadSubmissions();

  submissions.sort((a, b) => {
    if (a.date === b.date) {
      const au = String(a.updated_at || a.created_at || '');
      const bu = String(b.updated_at || b.created_at || '');
      return bu.localeCompare(au);
    }
    return String(b.date).localeCompare(String(a.date));
  });

  const rows = submissions.slice(0, days * 4).map((s) => ({
    id: s.id,
    date: s.date,
    type: s.type,
    signature: s.signature,
    note: s.note,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  return res.json({ rows });
});

// Detail
checklistRouter.get('/api/submission/:id', (req, res) => {
  const id = Number(req.params.id);
  const submissions = loadSubmissions();
  const s = submissions.find((x) => Number(x.id) === id);
  if (!s) return res.status(404).json({ error: 'Not found' });

  const items = loadTemplate()[s.type] || [];
  const checked = Array.isArray(s.checked) ? s.checked : [];

  return res.json({
    id: s.id,
    date: s.date,
    type: s.type,
    signature: s.signature,
    note: s.note,
    created_at: s.created_at,
    updated_at: s.updated_at,
    items: items.map((text, i) => ({ text, checked: !!checked[i] })),
  });
});

app.use('/checklist', checklistRouter);

// =========================================================
// CHAT PLACEHOLDER (mounted at /chat)
// =========================================================
app.use('/chat', express.static(path.join(__dirname, 'apps', 'chat', 'public')));

// Fallback to portal for unknown routes
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- Chat (socket.io) ----------------
const server = http.createServer(app);

// Allow extension / any origin to connect
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// In-memory message store
let CHAT_MESSAGES = [];

// Track connected users (socket.id -> name)
const USERS = new Map();

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  // Send history to the newly connected client
  socket.emit("chatHistory", CHAT_MESSAGES);

  // Client announces their display name
  socket.on('join', (data) => {
    const name = String(data?.name || '').trim().slice(0, 40);
    if (!name) return;
    USERS.set(socket.id, name);
    io.emit('users', Array.from(new Set(USERS.values())).sort((a,b)=>a.localeCompare(b, 'sv')));
  });

  // Typing indicator
  socket.on('typing', (data) => {
    const name = String(data?.name || '').trim().slice(0, 40);
    const typing = !!data?.typing;
    if (!name) return;
    socket.broadcast.emit('typing', { name, typing });
  });

  // Receive new message from client
  socket.on("sendMessage", (data) => {
    if (!data) return;

    const name = String(data.name || "").trim();
    const message = String(data.message || "").trim();
    if (!name || !message) return;

    const msg = {
      id: Date.now(),
      from: socket.id,
      name: name.slice(0, 40),
      message: message.slice(0, 280),
      time: new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })
    };

    CHAT_MESSAGES.push(msg);
    if (CHAT_MESSAGES.length > 200) CHAT_MESSAGES.shift();

    // Broadcast to everyone (page + extension)
    io.emit("chatMessage", msg);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);

    const name = USERS.get(socket.id);
    USERS.delete(socket.id);
    if (name) {
      // Recompute unique list
      io.emit('users', Array.from(new Set(USERS.values())).sort((a,b)=>a.localeCompare(b, 'sv')));
      socket.broadcast.emit('typing', { name, typing: false });
    }
  });
});

// IMPORTANT for Render: use env PORT and 0.0.0.0
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Birka Combined running on http://localhost:${PORT}`);
  console.log(`   - Portal:     /`);
  console.log(`   - Schedule:   /schedule/`);
  console.log(`   - Checklist:  /checklist/`);
  console.log(`   - Chat:       /chat/`);
});
