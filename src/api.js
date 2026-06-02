/**
 * API routes — Express router with all endpoints.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const store = require('./store');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'championship-flight-dev-secret';

// ---- Auth middleware ----
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Auth required' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    const user = store.getUserById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function sign(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

const JUNK_KEYS = new Set(['sandy', 'barky', 'sharky', 'hogan', 'gorilla', 'snake', 'polie', 'nasty', 'ctp', 'worm']);
/** Penalty junks — allowed even when score is over par. */
const JUNK_PENALTY_KEYS = new Set(['snake', 'worm']);
/** Not used on par-3 holes (no fairway / different eagle context). */
const JUNK_DISABLED_ON_PAR_THREE = new Set(['hogan', 'gorilla']);

function sanitizeJunk(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const k of JUNK_KEYS) {
    if (obj[k] === true) out[k] = true;
  }
  return out;
}

function normalizeJunkAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(500, Math.max(0.25, n)) * 100) / 100;
}

/** Explicit true/false only — avoids !!'false' === true and similar bugs. */
function coerceJunkEnabled(v) {
  if (v === undefined || v === null) return undefined;
  if (v === true || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0') return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

/** Winning junks need par or better; penalty junks always allowed. */
function filterJunkByPar(junkObj, strokes, par) {
  const clean = sanitizeJunk(junkObj);
  const out = {};
  const parNum = Number(par);
  const parOrBetter = Number(strokes) <= parNum;
  const par3 = parNum === 3;
  for (const k of Object.keys(clean)) {
    if (!clean[k]) continue;
    if (par3 && JUNK_DISABLED_ON_PAR_THREE.has(k)) continue;
    if (JUNK_PENALTY_KEYS.has(k) || parOrBetter) out[k] = true;
  }
  return out;
}

function sanitizeUser(u) {
  const { password_hash, friend_invite_code, ...rest } = u;
  const out = { ...rest };
  if (u.is_sub) delete out.email;
  return out;
}

function userIsInMatch(matchId, userId) {
  return store.getMatchPlayers(matchId).some((p) => p.user_id === userId);
}

// ============================================================
// AUTH
// ============================================================
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = store.getUserByEmail(email);
  if (!user || user.is_sub || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  store.ensureFriendInviteCode(user.id);
  const u2 = store.getUserById(user.id);
  const wallet = store.getWallet(u2.id);
  res.json({
    user: { ...sanitizeUser(u2), friend_invite_code: u2.friend_invite_code },
    token: sign(u2.id),
    wallet_balance: wallet?.balance,
  });
});

router.get('/auth/me', auth, (req, res) => {
  store.ensureFriendInviteCode(req.user.id);
  const user = store.getUserById(req.user.id);
  const wallet = store.getWallet(user.id);
  res.json({
    ...sanitizeUser(user),
    friend_invite_code: user.friend_invite_code,
    wallet_balance: wallet?.balance,
  });
});

router.patch('/auth/me', auth, (req, res) => {
  const { display_name, handicap_index } = req.body;
  const updates = {};
  if (typeof display_name === 'string' && display_name.trim()) {
    updates.display_name = display_name.trim();
  }
  if (handicap_index !== undefined && handicap_index !== null && handicap_index !== '') {
    const n = Number(handicap_index);
    if (Number.isFinite(n)) updates.handicap_index = Math.max(-10, Math.min(54, n));
  }
  if (Object.keys(updates).length) {
    store.update('users', req.user.id, updates);
  }
  const user = store.getUserById(req.user.id);
  const wallet = store.getWallet(user.id);
  res.json({
    ...sanitizeUser(user),
    friend_invite_code: user.friend_invite_code,
    wallet_balance: wallet?.balance,
  });
});

router.post('/auth/register', (req, res) => {
  const { email, password, displayName, display_name, handicap_index } = req.body;
  const em = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!em || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  if (em.endsWith('@sub.local')) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (store.getUserByEmail(em)) {
    return res.status(409).json({ error: 'Email already registered' });
  }
  const name = (typeof displayName === 'string' && displayName.trim())
    || (typeof display_name === 'string' && display_name.trim())
    || em.split('@')[0];
  let hcp = handicap_index != null && handicap_index !== '' ? Number(handicap_index) : 18;
  if (!Number.isFinite(hcp)) hcp = 18;
  hcp = Math.max(-10, Math.min(54, hcp));
  const user = store.insert('users', {
    email: em,
    password_hash: bcrypt.hashSync(String(password), 10),
    display_name: name,
    handicap_index: hcp,
    avatar_url: '',
  });
  store.db.wallets[user.id] = {
    id: store.uuid(),
    user_id: user.id,
    balance: 0,
  };
  store.ensureFriendInviteCode(user.id);
  const u2 = store.getUserById(user.id);
  const wallet = store.getWallet(u2.id);
  res.status(201).json({
    user: { ...sanitizeUser(u2), friend_invite_code: u2.friend_invite_code },
    token: sign(u2.id),
    wallet_balance: wallet?.balance ?? 0,
  });
});

// ============================================================
// COURSES
// ============================================================
router.get('/courses', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const courses = store.getAllCourses().map(c => ({
    ...c,
    tee_sets: store.getTeeSetsForCourse(c.id),
  }));
  res.json(courses);
});

router.get('/courses/:id', (req, res) => {
  const course = store.getCourse(req.params.id);
  if (!course) return res.status(404).json({ error: 'Not found' });
  const tee_sets = store.getTeeSetsForCourse(course.id).map(ts => ({
    ...ts,
    holes: store.getHolesForTeeSet(ts.id),
  }));
  res.json({ ...course, tee_sets });
});

router.get('/courses/:id/tees/:teeSetId', (req, res) => {
  const ts = store.getTeeSet(req.params.teeSetId);
  if (!ts) return res.status(404).json({ error: 'Not found' });
  res.json({ ...ts, holes: store.getHolesForTeeSet(ts.id) });
});

// ============================================================
// MATCHES
// ============================================================
router.get('/matches', auth, (req, res) => {
  const matches = store.getMatchesForUser(req.user.id).map(m => {
    const course = store.getCourse(m.course_id);
    const junkOn = !!m.junk_enabled;
    const status = normalizeMatchStatus(m.status);
    return {
      ...m,
      status,
      junk_enabled: junkOn,
      junkEnabled: junkOn,
      course_name: course?.name,
      course_location: course?.location,
    };
  });
  res.json(matches);
});

router.get('/matches/:id', auth, (req, res) => {
  const detail = store.getMatchDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: 'Not found' });
  if (!userIsInMatch(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Not part of this match' });
  }
  res.json(detail);
});

function normalizeStrokesOffLeader(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(-18, Math.min(54, n));
}

function teeSetBelongsToCourse(teeSetId, courseId) {
  if (!teeSetId || !courseId) return false;
  const ts = store.getTeeSet(teeSetId);
  return !!(ts && ts.course_id === courseId);
}

function normalizeStampedeQuota(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(99, n));
}

const MATCH_GAME_TYPES = new Set(['skins', 'match_play', 'stroke_play', 'nassau', 'stampede', 'teams']);

function normalizeMatchStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'in_progress') return 'in_progress';
  if (s === 'completed' || s === 'finished') return 'finished';
  return status || 'in_progress';
}

function normalizeMatchPlayerTeamIndex(v) {
  const n = Number(v);
  return n === 2 ? 2 : 1;
}

router.post('/matches', auth, (req, res) => {
  const { courseId, teeSetId, name, teeTime, playerIds = [], gameType, wagerAmount } = req.body;
  const guestPayload = req.body.guestPlayers ?? req.body.subs ?? [];
  const rawSetup = req.body.playerSetup ?? req.body.player_setup;
  const playerSetup = Array.isArray(rawSetup) ? rawSetup : [];
  if (!courseId) return res.status(400).json({ error: 'courseId required' });
  const junkOn = !!(req.body.junkEnabled ?? req.body.includeJunk);
  const scoringModeRaw = req.body.scoringMode ?? req.body.scoring_mode;
  const scoring_mode = scoringModeRaw === 'net' ? 'net' : 'gross';
  const normalizedGameTypePre =
    typeof gameType === 'string' ? gameType.toLowerCase().trim() : null;
  const persistedGameType =
    normalizedGameTypePre && MATCH_GAME_TYPES.has(normalizedGameTypePre)
      ? normalizedGameTypePre
      : null;
  if (persistedGameType === 'teams') {
    if (!Array.isArray(playerSetup) || playerSetup.length === 0) {
      return res.status(400).json({
        error:
          'Teams format must be started from the roster sheet (Head to the First Tee) so each golfer can be placed on Team 1 or Team 2.',
      });
    }
  }
  const match = store.insert('matches', {
    course_id: courseId, created_by: req.user.id, name,
    tee_time: teeTime || new Date().toISOString(),
    current_hole: 1, status: 'in_progress', scoring_mode,
    tee_set_id: teeSetId || null,
    game_type: persistedGameType,
    junk_enabled: junkOn,
    junk_amount: junkOn ? normalizeJunkAmount(req.body.junkAmount ?? req.body.junk_amount ?? 1) : 0,
    snake_tally: 0,
    worm_tally: 0,
    snake_holder_id: null,
    worm_holder_id: null,
  });

  const defaultTee = teeSetId || null;

  if (playerSetup.length > 0) {
    const seen = new Set();
    for (const row of playerSetup) {
      const isGuest = !!(row.guest === true || row.isGuest === true);
      let uid;
      let hcpForRow;
      if (isGuest) {
        const rawName = (row.displayName ?? row.display_name ?? row.name) || '';
        const nm = typeof rawName === 'string' ? rawName.trim() : '';
        if (!nm) continue;
        const hRaw = row.handicapIndex ?? row.handicap_index ?? row.handicap;
        const sub = store.createSubUser({ display_name: nm, handicap_index: hRaw });
        if (!sub) continue;
        uid = String(sub.id);
        hcpForRow = sub.handicap_index;
      } else {
        const rawId = row.userId ?? row.user_id;
        uid = rawId != null && rawId !== '' ? String(rawId).trim() : '';
        if (!uid || seen.has(uid)) continue;
        const u = store.getUserById(uid);
        if (!u || u.is_sub) continue;
        hcpForRow = u.handicap_index;
      }
      seen.add(uid);
      const rowTee = row.teeSetId || row.tee_set_id;
      const tid = teeSetBelongsToCourse(rowTee, courseId) ? rowTee : defaultTee;
      let hcpAt = row.handicapAtMatch != null ? Number(row.handicapAtMatch) : hcpForRow;
      if (!Number.isFinite(hcpAt)) hcpAt = Number(hcpForRow) || 18;
      hcpAt = Math.max(-10, Math.min(54, Math.round(hcpAt * 10) / 10));
      const sol = scoring_mode === 'net' ? normalizeStrokesOffLeader(row.strokesOffLeader ?? row.strokes_off_leader) : null;
      const inOnBetRaw = row.inOnBet ?? row.in_on_bet;
      const in_on_bet = inOnBetRaw === false || inOnBetRaw === 'false' ? false : true;
      let stampedeQ = null;
      if (persistedGameType === 'stampede') {
        stampedeQ = normalizeStampedeQuota(row.stampedeQuota ?? row.stampede_quota ?? row.quota);
        if (stampedeQ == null) {
          stampedeQ = Math.max(8, Math.min(45, Math.round(30 - Number(hcpAt || 18))));
        }
      }
      const team_index =
        persistedGameType === 'teams'
          ? normalizeMatchPlayerTeamIndex(row.teamIndex ?? row.team_index ?? 1)
          : null;
      const pKey = `${match.id}:${uid}`;
      store.db.matchPlayers[pKey] = {
        id: store.uuid(),
        match_id: match.id,
        user_id: uid,
        handicap_at_match: hcpAt,
        tee_set_id: tid || null,
        strokes_off_leader: sol,
        stampede_quota: stampedeQ,
        in_on_bet,
        team_index,
        junk_net_result: 0,
        junk_marks_for: 0,
        junk_marks_against: 0,
      };
    }
    if (seen.size === 0) {
      delete store.db.matches[match.id];
      return res.status(400).json({ error: 'No valid players in roster' });
    }
    if (persistedGameType === 'teams') {
      let n1 = 0;
      let n2 = 0;
      for (const uid of seen) {
        const mp = store.db.matchPlayers[`${match.id}:${uid}`];
        const t = Number(mp?.team_index);
        if (t === 2) n2 += 1;
        else n1 += 1;
      }
      if (n1 < 1 || n2 < 1) {
        for (const k of Object.keys(store.db.matchPlayers)) {
          if (store.db.matchPlayers[k].match_id === match.id) delete store.db.matchPlayers[k];
        }
        delete store.db.matches[match.id];
        return res.status(400).json({
          error: 'Teams format needs at least one player on Team 1 and one on Team 2.',
        });
      }
    }
    const creatorId = String(req.user.id);
    if (!seen.has(creatorId)) {
      for (const k of Object.keys(store.db.matchPlayers)) {
        if (store.db.matchPlayers[k].match_id === match.id) delete store.db.matchPlayers[k];
      }
      delete store.db.matches[match.id];
      return res.status(400).json({ error: 'You must include yourself in the match' });
    }
    if (seen.size < playerSetup.length) {
      for (const k of Object.keys(store.db.matchPlayers)) {
        if (store.db.matchPlayers[k].match_id === match.id) delete store.db.matchPlayers[k];
      }
      delete store.db.matches[match.id];
      return res.status(400).json({
        error:
          'Could not add every player in the roster. Check that each golfer has a valid account (or use a placeholder sub), and that user IDs are correct.',
      });
    }
  } else {
    const key = `${match.id}:${req.user.id}`;
    store.db.matchPlayers[key] = {
      id: store.uuid(), match_id: match.id, user_id: req.user.id,
      handicap_at_match: req.user.handicap_index, tee_set_id: defaultTee,
      strokes_off_leader: null,
      in_on_bet: true,
      team_index: persistedGameType === 'teams' ? 1 : null,
      junk_net_result: 0,
      junk_marks_for: 0,
      junk_marks_against: 0,
    };
    const extraGuestIds = [];
    if (Array.isArray(guestPayload)) {
      for (const g of guestPayload) {
        const rawName = (g && (g.displayName ?? g.display_name ?? g.name)) || '';
        const nm = typeof rawName === 'string' ? rawName.trim() : '';
        if (!nm) continue;
        const hRaw = g.handicapIndex ?? g.handicap_index ?? g.handicap;
        const sub = store.createSubUser({
          display_name: nm,
          handicap_index: hRaw,
        });
        if (sub) extraGuestIds.push(sub.id);
      }
    }

    const allExtraIds = [...new Set(extraGuestIds)];

    for (const userId of playerIds) {
      if (userId === req.user.id) continue;
      const user = store.getUserById(userId);
      if (!user || user.is_sub) continue;
      const pKey = `${match.id}:${userId}`;
      store.db.matchPlayers[pKey] = {
        id: store.uuid(), match_id: match.id, user_id: userId,
        handicap_at_match: user.handicap_index, tee_set_id: defaultTee,
        strokes_off_leader: null,
        in_on_bet: true,
        team_index: persistedGameType === 'teams' ? 1 : null,
        junk_net_result: 0,
        junk_marks_for: 0,
        junk_marks_against: 0,
      };
    }

    for (const userId of allExtraIds) {
      const user = store.getUserById(userId);
      if (!user || !user.is_sub) continue;
      const pKey = `${match.id}:${userId}`;
      if (store.db.matchPlayers[pKey]) continue;
      store.db.matchPlayers[pKey] = {
        id: store.uuid(), match_id: match.id, user_id: userId,
        handicap_at_match: user.handicap_index, tee_set_id: defaultTee,
        strokes_off_leader: null,
        in_on_bet: true,
        team_index: persistedGameType === 'teams' ? 1 : null,
        junk_net_result: 0,
        junk_marks_for: 0,
        junk_marks_against: 0,
      };
    }
    if (persistedGameType === 'teams') {
      for (const k of Object.keys(store.db.matchPlayers)) {
        if (store.db.matchPlayers[k].match_id !== match.id) continue;
        if (store.db.matchPlayers[k].team_index == null) {
          store.db.matchPlayers[k].team_index = 1;
        }
      }
    }
  }
  const normalizedGameType = typeof gameType === 'string' ? gameType.toLowerCase().trim() : null;
  const amount = Number(wagerAmount || 0);
  const supportedTypes = new Set(['skins', 'match_play', 'stroke_play', 'nassau', 'stampede', 'teams']);
  if (normalizedGameType && supportedTypes.has(normalizedGameType) && amount > 0) {
    const participantsAll = store.getMatchPlayers(match.id);
    const participants = participantsAll.filter((p) => p.in_on_bet !== false);
    if (participants.length === 0) {
      for (const k of Object.keys(store.db.matchPlayers)) {
        if (store.db.matchPlayers[k].match_id === match.id) delete store.db.matchPlayers[k];
      }
      delete store.db.matches[match.id];
      return res.status(400).json({ error: 'At least one player must be in on the bet when a wager is set' });
    }
    const betName =
      normalizedGameType === 'stampede'
        ? 'Stampede'
        : normalizedGameType === 'teams'
          ? 'Teams match play'
          : normalizedGameType.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const bet = store.insert('bets', {
      match_id: match.id,
      created_by: req.user.id,
      bet_type: normalizedGameType,
      name: betName,
      amount,
      hole_number: null,
      bet_scope: 'each_hole',
      status: 'active',
      carry_over: 0,
    });
    for (const p of participants) {
      const bKey = `${bet.id}:${p.user_id}`;
      store.db.betParticipants[bKey] = {
        id: store.uuid(),
        bet_id: bet.id,
        user_id: p.user_id,
        accepted: true,
        net_result: 0,
        display_name: p.display_name,
      };
    }
  }
  // Only one "your" active round: retire older matches you created so the scorecard
  // does not reopen a stale round after you start a new one.
  for (const m of store.getMatchesForUser(req.user.id)) {
    if (m.id === match.id || normalizeMatchStatus(m.status) !== 'in_progress') continue;
    if (m.created_by === req.user.id) {
      store.update('matches', m.id, { status: 'abandoned' });
    }
  }
  store.persistNow();
  res.status(201).json(store.getMatchDetail(match.id));
});

router.post('/matches/:id/finish', auth, (req, res) => {
  const match = store.getMatch(req.params.id);
  if (!match) return res.status(404).json({ error: 'Not found' });
  const players = store.getMatchPlayers(req.params.id);
  if (!players.some(p => p.user_id === req.user.id)) {
    return res.status(403).json({ error: 'Not part of this match' });
  }
  if (normalizeMatchStatus(match.status) === 'finished') {
    return res.json(store.getMatchDetail(req.params.id));
  }
  store.finishMatch(req.params.id);
  store.persistNow();
  res.json(store.getMatchDetail(req.params.id));
});

router.patch('/matches/:id', auth, (req, res) => {
  const current = store.getMatch(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  if (!userIsInMatch(req.params.id, req.user.id)) {
    return res.status(403).json({ error: 'Not part of this match' });
  }

  if (req.body.finish === true) {
    const players = store.getMatchPlayers(req.params.id);
    if (!players.some(p => p.user_id === req.user.id)) {
      return res.status(403).json({ error: 'Not part of this match' });
    }
    if (normalizeMatchStatus(current.status) === 'finished') {
      return res.json(store.getMatchDetail(req.params.id));
    }
    store.finishMatch(req.params.id);
    store.persistNow();
    return res.json(store.getMatchDetail(req.params.id));
  }

  // Only apply known fields — spreading req.body was overwriting junk_enabled with falsey
  // defaults when clients sent partial payloads or duplicate keys.
  const updates = {};
  if (req.body.currentHole != null) {
    updates.current_hole = Number(req.body.currentHole);
  }
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.tee_set_id !== undefined) updates.tee_set_id = req.body.tee_set_id;
  if (req.body.teeSetId !== undefined) updates.tee_set_id = req.body.teeSetId;
  if (req.body.scoring_mode !== undefined) updates.scoring_mode = req.body.scoring_mode;
  if (req.body.scoringMode !== undefined) updates.scoring_mode = req.body.scoringMode;
  const junkRaw = req.body.junkEnabled !== undefined ? req.body.junkEnabled : req.body.junk_enabled;
  const junkCoerced = coerceJunkEnabled(junkRaw);
  if (junkCoerced !== undefined) updates.junk_enabled = junkCoerced;
  const junkAmt = req.body.junkAmount !== undefined ? req.body.junkAmount : req.body.junk_amount;
  if (junkAmt !== undefined) updates.junk_amount = normalizeJunkAmount(junkAmt);

  const nextHole = Number(updates.current_hole);
  if (Number.isInteger(nextHole) && nextHole > current.current_hole) {
    for (let hole = current.current_hole; hole < nextHole; hole++) {
      store.settleBetsForHole(req.params.id, hole);
      store.settleJunkForHole(req.params.id, hole);
      if (hole === 9) store.settleSnakeWormSegment(req.params.id, 'front');
      if (hole === 18) store.settleSnakeWormSegment(req.params.id, 'back');
    }
  }

  const match = store.update('matches', req.params.id, updates);
  if (!match) return res.status(404).json({ error: 'Not found' });
  store.persistNow();
  res.json(store.getMatchDetail(match.id));
});

router.post('/matches/:id/players', auth, (req, res) => {
  const { userId, teeSetId } = req.body;
  const user = store.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const m = store.getMatch(req.params.id);
  const isTeams = String(m?.game_type || '').toLowerCase() === 'teams';
  const ti = isTeams ? normalizeMatchPlayerTeamIndex(req.body.teamIndex ?? req.body.team_index) : null;
  const key = `${req.params.id}:${userId}`;
  store.db.matchPlayers[key] = {
    id: store.uuid(), match_id: req.params.id, user_id: userId,
    handicap_at_match: user.handicap_index, tee_set_id: teeSetId || null,
    in_on_bet: true,
    team_index: ti,
    junk_net_result: 0,
    junk_marks_for: 0,
    junk_marks_against: 0,
  };
  store.persistNow();
  res.status(201).json({ ok: true });
});

// ============================================================
// SCORES
// ============================================================
router.get('/matches/:matchId/scores', auth, (req, res) => {
  const match = store.getMatch(req.params.matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (!userIsInMatch(req.params.matchId, req.user.id)) {
    return res.status(403).json({ error: 'Not part of this match' });
  }

  const teeSet = match.tee_set_id ? store.getTeeSet(match.tee_set_id) : null;
  const holes = teeSet ? store.getHolesForTeeSet(teeSet.id) : [];
  const allScores = store.getScoresForMatch(req.params.matchId);
  const players = store.getMatchPlayers(req.params.matchId);
  const scoringMode = match.scoring_mode === 'net' ? 'net' : 'gross';
  const matchIsStampede = String(match.game_type || '').toLowerCase() === 'stampede';
  const matchIsTeamsFmt = String(match.game_type || '').toLowerCase() === 'teams';

  const holeMap = {};
  holes.forEach(h => { holeMap[h.hole_number] = h; });

  // One scoreboard row per match player (avoid object keyed by user_id colliding on type coercion).
  const scoreboard = players.map((p) => {
    const pid = p.user_id;
    const sol = p.strokes_off_leader != null ? Math.round(Number(p.strokes_off_leader)) : 0;
    const playerTeeId = p.tee_set_id || match.tee_set_id;
    const playerHoles = playerTeeId ? store.getHolesForTeeSet(playerTeeId) : holes;
    const netByHole =
      scoringMode === 'net' ? store.allocateNetStrokesByHole(Number.isFinite(sol) ? sol : 0, playerHoles) : {};
    const pHoles = allScores.filter((s) => s.user_id === pid);
    const tiRaw = Number(p.team_index);
    const team_index =
      matchIsTeamsFmt && (tiRaw === 1 || tiRaw === 2) ? tiRaw : null;
    const base = {
      user_id: pid, display_name: p.display_name, avatar_url: p.avatar_url,
      handicap_index: p.handicap_index, tee_name: p.tee_name,
      tee_set_id: playerTeeId || null,
      teeSetId: playerTeeId || null,
      strokes_off_leader: scoringMode === 'net' ? sol : null,
      strokesOffLeader: scoringMode === 'net' ? sol : null,
      in_on_bet: p.in_on_bet !== false,
      inOnBet: p.in_on_bet !== false,
      team_index,
      teamIndex: team_index,
      net_strokes_by_hole: netByHole,
      netStrokesByHole: netByHole,
      holes: pHoles,
    };
    let total = 0, parTotal = 0, front9 = 0, back9 = 0;
    let netTotal = 0, netParTotal = 0, netFront9 = 0, netBack9 = 0;
    pHoles.forEach((s) => {
      if (s.strokes == null) return;
      const recv = netByHole[s.hole_number] || 0;
      total += s.strokes;
      const netStrokes = s.strokes - recv;
      netTotal += netStrokes;
      const hole = holeMap[s.hole_number];
      if (hole) {
        parTotal += hole.par;
        netParTotal += hole.par;
      }
      if (s.hole_number <= 9) {
        front9 += s.strokes;
        netFront9 += netStrokes;
      } else {
        back9 += s.strokes;
        netBack9 += netStrokes;
      }
    });

    let stampede_quota = null;
    let stampedeQuota = null;
    let stampede_points = null;
    let stampedePoints = null;
    let stampede_vs_quota = null;
    let stampedeVsQuota = null;
    if (matchIsStampede) {
      const qRaw = p.stampede_quota != null ? Math.round(Number(p.stampede_quota)) : null;
      stampede_quota = qRaw;
      stampedeQuota = qRaw;
      let ptsSum = 0;
      pHoles.forEach((s) => {
        if (s.strokes == null) return;
        const hole = holeMap[s.hole_number];
        const par = hole?.par ?? 4;
        const recv = netByHole[s.hole_number] || 0;
        const eff = scoringMode === 'net' ? s.strokes - recv : s.strokes;
        ptsSum += store.stampedeHolePoints(eff, par);
      });
      stampede_points = ptsSum;
      stampedePoints = ptsSum;
      if (qRaw != null && Number.isFinite(qRaw)) {
        stampede_vs_quota = ptsSum - qRaw;
        stampedeVsQuota = ptsSum - qRaw;
      }
    }

    return {
      ...base,
      total,
      toPar: total - parTotal,
      front9,
      back9,
      net_total: netTotal,
      netTotal,
      net_to_par: netTotal - netParTotal,
      netToPar: netTotal - netParTotal,
      net_front9: netFront9,
      netFront9,
      net_back9: netBack9,
      netBack9,
      stampede_quota,
      stampedeQuota,
      stampede_points,
      stampedePoints,
      stampede_vs_quota,
      stampedeVsQuota,
    };
  });

  let team_best_ball = null;
  if (matchIsTeamsFmt) {
    team_best_ball = holes.map((holeMeta) => {
      const hn = holeMeta.hole_number;
      const pool = { 1: [], 2: [] };
      scoreboard.forEach((row) => {
        const t = row.team_index;
        if (t !== 1 && t !== 2) return;
        const rec = (row.holes || []).find((s) => s.hole_number === hn);
        if (!rec || rec.strokes == null) return;
        const nh = row.net_strokes_by_hole || row.netStrokesByHole || {};
        const recv = nh[hn] || nh[String(hn)] || 0;
        const eff = scoringMode === 'net' ? rec.strokes - recv : rec.strokes;
        if (Number.isFinite(eff)) pool[t].push(eff);
      });
      return {
        hole_number: hn,
        team_1: pool[1].length ? Math.min(...pool[1]) : null,
        team_2: pool[2].length ? Math.min(...pool[2]) : null,
      };
    });
  }

  res.json({
    holes,
    scoreboard,
    tee_set: teeSet,
    scoring_mode: scoringMode,
    scoringMode,
    teams_format: matchIsTeamsFmt,
    team_best_ball,
  });
});

router.post('/matches/:matchId/scores', auth, (req, res) => {
  const { holeNumber, strokes, putts, fairwayHit, gir, userId, junk } = req.body;
  if (holeNumber == null || strokes == null) {
    return res.status(400).json({ error: 'holeNumber and strokes required' });
  }
  const hn = Number(holeNumber);
  if (!Number.isInteger(hn) || hn < 1 || hn > 18) {
    return res.status(400).json({ error: 'holeNumber must be an integer 1–18' });
  }
  const targetUserId = userId || req.user.id;
  const inMatch = store.getMatchPlayers(req.params.matchId).some(p => p.user_id === targetUserId);
  if (!inMatch) return res.status(400).json({ error: 'User is not in this match' });

  const match = store.getMatch(req.params.matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (!userIsInMatch(req.params.matchId, req.user.id)) {
    return res.status(403).json({ error: 'Not part of this match' });
  }
  const holes = match?.tee_set_id ? store.getHolesForTeeSet(match.tee_set_id) : [];
  const hole = holes.find(h => Number(h.hole_number) === hn);
  const par = hole?.par ?? 4;

  const patch = {
    strokes, putts: putts ?? null, fairway_hit: fairwayHit ?? false, gir: gir ?? false,
  };
  if (junk !== undefined) {
    const raw = sanitizeJunk(junk);
    patch.junk = match?.junk_enabled ? filterJunkByPar(raw, strokes, par) : {};
  }

  const prevScore = store.getScore(req.params.matchId, targetUserId, hn);
  const hadSnake = !!(prevScore?.junk && prevScore.junk.snake);
  const hadWorm = !!(prevScore?.junk && prevScore.junk.worm);

  const score = store.upsertScore(req.params.matchId, targetUserId, hn, patch);
  if (!score) {
    return res.status(400).json({ error: 'Could not save score' });
  }

  if (junk !== undefined && match?.junk_enabled) {
    const merged = store.getScore(req.params.matchId, targetUserId, hn);
    const hasSnake = !!(merged?.junk && merged.junk.snake);
    const hasWorm = !!(merged?.junk && merged.junk.worm);
    if (hasSnake && !hadSnake) {
      match.snake_tally = (Number(match.snake_tally) || 0) + 1;
      match.snake_holder_id = targetUserId;
    } else if (!hasSnake && hadSnake) {
      match.snake_tally = Math.max(0, (Number(match.snake_tally) || 0) - 1);
      if ((Number(match.snake_tally) || 0) === 0) match.snake_holder_id = null;
    }
    if (hasWorm && !hadWorm) {
      match.worm_tally = (Number(match.worm_tally) || 0) + 1;
      match.worm_holder_id = targetUserId;
    } else if (!hasWorm && hadWorm) {
      match.worm_tally = Math.max(0, (Number(match.worm_tally) || 0) - 1);
      if ((Number(match.worm_tally) || 0) === 0) match.worm_holder_id = null;
    }
  }

  if (match) {
    store.update('matches', match.id, {
      snake_tally: match.snake_tally,
      worm_tally: match.worm_tally,
      snake_holder_id: match.snake_holder_id,
      worm_holder_id: match.worm_holder_id,
    });
  }

  const mid = req.params.matchId;
  const roster = store.getMatchPlayers(mid);
  const allPosted =
    roster.length >= 2
    && roster.every((p) => {
      const s = store.getScore(mid, p.user_id, hn);
      return s != null && s.strokes != null;
    });
  if (allPosted && match?.junk_enabled) {
    store.settleJunkForHole(mid, hn);
  }

  score.label = hole ? store.scoreLabel(strokes, hole.par) : null;
  score.par = hole?.par;

  store.persistNow();
  res.status(201).json(score);
});

// ============================================================
// BETS
// ============================================================
router.get('/matches/:matchId/bets', auth, (req, res) => {
  if (!userIsInMatch(req.params.matchId, req.user.id)) {
    return res.status(403).json({ error: 'Not part of this match' });
  }
  res.json(store.getBetsForMatch(req.params.matchId));
});

router.post('/matches/:matchId/bets', auth, (req, res) => {
  const rawType = typeof req.body.betType === 'string' ? req.body.betType.toLowerCase() : req.body.betType;
  const betType = rawType;
  const { name, amount } = req.body;
  const match = store.getMatch(req.params.matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (!userIsInMatch(req.params.matchId, req.user.id)) {
    return res.status(403).json({ error: 'Not part of this match' });
  }
  if (betType === 'teams' && String(match.game_type || '').toLowerCase() !== 'teams') {
    return res.status(400).json({ error: 'Teams wagers are only for matches started in Teams format' });
  }
  const mainGameTypes = new Set(['skins', 'nassau', 'stroke_play', 'stampede']);
  const allowedScopes = new Set(['each_hole', 'one_hole', 'rest_of_round']);
  let betScope = allowedScopes.has(req.body.betScope) ? req.body.betScope : 'each_hole';
  let holeNumber = req.body.holeNumber != null && req.body.holeNumber !== ''
    ? Number(req.body.holeNumber)
    : null;
  if (mainGameTypes.has(betType)) {
    betScope = 'each_hole';
    holeNumber = null;
  }
  if (betScope === 'each_hole') holeNumber = null;
  if ((betScope === 'one_hole' || betScope === 'rest_of_round')
    && (!Number.isInteger(holeNumber) || holeNumber < 1 || holeNumber > 18)) {
    return res.status(400).json({ error: 'holeNumber (1–18) required for one-hole or rest-of-round wagers' });
  }
  const bet = store.insert('bets', {
    match_id: req.params.matchId, created_by: req.user.id,
    bet_type: betType, name, amount, hole_number: holeNumber,
    bet_scope: betScope,
    status: 'active', carry_over: 0,
  });
  // Add all match players as participants
  const players = store.getMatchPlayers(req.params.matchId);
  for (const p of players) {
    const key = `${bet.id}:${p.user_id}`;
    store.db.betParticipants[key] = {
      id: store.uuid(), bet_id: bet.id, user_id: p.user_id,
      accepted: true, net_result: 0, display_name: p.display_name,
    };
  }
  store.persistNow();
  res.status(201).json(store.getBetsForMatch(req.params.matchId).find(b => b.id === bet.id));
});

// ============================================================
// WALLET
// ============================================================
router.get('/wallet', auth, (req, res) => {
  const wallet = store.getWallet(req.user.id);
  if (!wallet) return res.status(404).json({ error: 'No wallet' });
  res.json(wallet);
});

router.get('/wallet/transactions', auth, (req, res) => {
  res.json(store.getTransactions(req.user.id));
});

router.post('/wallet/deposit', auth, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const wallet = store.deposit(req.user.id, amount);
  if (!wallet) return res.status(400).json({ error: 'Deposit failed' });
  store.persistNow();
  res.json(wallet);
});

router.post('/wallet/withdraw', auth, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const wallet = store.withdraw(req.user.id, amount);
  if (!wallet) return res.status(400).json({ error: 'Insufficient balance' });
  store.persistNow();
  res.json(wallet);
});

router.get('/wallet/stats', auth, (req, res) => {
  // Simplified stats
  const bets = Object.values(store.db.betParticipants)
    .filter(bp => bp.user_id === req.user.id);
  const wins = bets.filter(b => b.net_result > 0).length;
  const losses = bets.filter(b => b.net_result < 0).length;
  const totalNet = bets.reduce((s, b) => s + (b.net_result || 0), 0);
  res.json({
    wins, losses, totalNet,
    winRate: (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0,
    streak: 0, streakType: 'wins', monthlyRoi: 0,
  });
});

// ============================================================
// LEADERBOARD
// ============================================================
router.get('/leaderboard', auth, (req, res) => {
  // Aggregate from bet participants
  const userStats = {};
  for (const bp of Object.values(store.db.betParticipants)) {
    if (!userStats[bp.user_id]) {
      const u = store.getUserById(bp.user_id);
      userStats[bp.user_id] = {
        id: bp.user_id, display_name: u?.display_name, avatar_url: u?.avatar_url,
        net_gain: 0, wins: 0, losses: 0,
      };
    }
    userStats[bp.user_id].net_gain += bp.net_result || 0;
    if (bp.net_result > 0) userStats[bp.user_id].wins++;
    if (bp.net_result < 0) userStats[bp.user_id].losses++;
  }
  const leaderboard = Object.values(userStats)
    .sort((a, b) => b.net_gain - a.net_gain)
    .map((p, i) => ({ rank: i + 1, ...p }));

  const bets = Object.values(store.db.bets);
  const totalPot = bets.reduce((sum, bet) => {
    const participantCount = Object.values(store.db.betParticipants)
      .filter(bp => bp.bet_id === bet.id).length;
    return sum + (Number(bet.amount || 0) * participantCount);
  }, 0);
  res.json({ leaderboard, summary: { totalPot, totalWagers: bets.length } });
});

// ============================================================
// FRIENDS
// ============================================================
router.get('/friends', auth, (req, res) => {
  const list = store.getFriendsForUser(req.user.id).map(sanitizeUser);
  res.json(list);
});

router.post('/friends/accept', auth, (req, res) => {
  const code = req.body?.code ?? req.body?.inviteCode;
  const result = store.acceptFriendInvite(req.user.id, code);
  if (!result.ok) {
    const status = result.error === 'invalid_code' ? 404 : 400;
    const msg = result.error === 'invalid_code'
      ? 'Invalid or expired invite code'
      : 'You cannot add yourself';
    return res.status(status).json({ error: msg });
  }
  res.json({
    friend: sanitizeUser(result.friend),
    already_friends: result.already_friends,
  });
});

// ============================================================
// USERS (for player search)
// ============================================================
router.get('/users', auth, (req, res) => {
  const friendIds = new Set(store.getFriendIds(req.user.id));
  const users = store
    .values('users')
    .filter((u) => u.id !== req.user.id && !u.is_sub)
    .map((u) => ({
      ...sanitizeUser(u),
      is_friend: friendIds.has(u.id),
    }))
    .sort((a, b) => {
      if (a.is_friend !== b.is_friend) return a.is_friend ? -1 : 1;
      return String(a.display_name || '').localeCompare(String(b.display_name || ''));
    });
  res.json(users);
});

// Health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
