/**
 * In-memory data store — replaces PostgreSQL for local testing.
 * Pre-loaded with UT Golf Club course data and sample users/match.
 */
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');

// ============================================================
// DATA TABLES (plain JS objects keyed by id)
// ============================================================
const db = {
  users: {},
  courses: {},
  teeSets: {},
  teeHoles: {},    // keyed by `${teeSetId}:${holeNumber}`
  matches: {},
  matchPlayers: {}, // keyed by `${matchId}:${userId}`
  scores: {},       // keyed by `${matchId}:${userId}:${holeNumber}`
  bets: {},
  betParticipants: {}, // keyed by `${betId}:${userId}`
  skinsResults: {},    // keyed by `${betId}:${holeNumber}`
  betSettlements: {},  // keyed by `${betId}:${holeNumber}`
  junkSettlements: {}, // keyed by `${matchId}:${holeNumber}` — hole closed for junk ledger
  junkSegmentSettlements: {}, // `${matchId}:front` | `${matchId}:back` — snake/worm paid for that side
  wallets: {},         // keyed by userId
  transactions: [],
  /** Undirected edges: key `${id}|${id}` lexicographically sorted UUIDs */
  friendPairs: {},
};

// ============================================================
// HELPERS
// ============================================================
function values(table) { return Object.values(db[table]); }
function find(table, predicate) { return values(table).filter(predicate); }
function findOne(table, predicate) { return values(table).find(predicate); }
function insert(table, record) {
  if (!record.id) record.id = uuid();
  record.created_at = record.created_at || new Date().toISOString();
  db[table][record.id] = record;
  return record;
}
function update(table, id, updates) {
  if (!db[table][id]) return null;
  Object.assign(db[table][id], updates, { updated_at: new Date().toISOString() });
  return db[table][id];
}

function friendshipPairKey(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join('|');
}

function recordFriendshipPair(userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;
  const key = friendshipPairKey(userIdA, userIdB);
  if (db.friendPairs[key]) return false;
  db.friendPairs[key] = {
    id: uuid(),
    user_id_a: userIdA,
    user_id_b: userIdB,
    created_at: new Date().toISOString(),
  };
  return true;
}

function friendIdsForUser(userId) {
  const out = [];
  for (const k of Object.keys(db.friendPairs)) {
    const [a, b] = k.split('|');
    if (a === userId) out.push(b);
    else if (b === userId) out.push(a);
  }
  return out;
}

const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateFriendInviteCode() {
  let code;
  let tries = 0;
  do {
    const part = Array.from({ length: 8 }, () =>
      INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)]
    ).join('');
    code = `CF-${part}`;
    tries++;
  } while (tries < 50 && findOne('users', (u) => u.friend_invite_code === code));
  return code;
}

function assignInviteCodeIfMissing(userId) {
  const u = db.users[userId];
  if (!u) return null;
  if (u.friend_invite_code) return u;
  const code = generateFriendInviteCode();
  return update('users', userId, { friend_invite_code: code });
}

function lookupUserByInviteCode(raw) {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!code) return null;
  return findOne('users', (u) => String(u.friend_invite_code || '').toUpperCase() === code);
}

// ============================================================
// SCORING UTILITIES
// ============================================================
function scoreLabel(strokes, par) {
  const d = strokes - par;
  if (d <= -3) return 'albatross';
  if (d === -2) return 'eagle';
  if (d === -1) return 'birdie';
  if (d === 0) return 'par';
  if (d === 1) return 'bogey';
  if (d === 2) return 'double_bogey';
  return 'triple_plus';
}

function courseHandicap(index, slope, cr, par) {
  if (!slope || !cr) return Math.round(index);
  return Math.round(index * (slope / 113) + (cr - par));
}

function getNetStrokes(gross, courseHcp, holeHcpRank, totalHoles = 18) {
  if (gross == null) return null;
  const full = Math.floor(courseHcp / totalHoles);
  const remainder = courseHcp % totalHoles;
  const extra = holeHcpRank <= remainder ? 1 : 0;
  return gross - full - extra;
}

/** USGA-style: allocate N handicap strokes to holes by stroke index (1 = hardest first). */
function allocateNetStrokesByHole(totalStrokes, holeList) {
  const list = (holeList || []).filter((h) => h.hole_number >= 1 && h.hole_number <= 18);
  if (!list.length) return {};
  const sorted = [...list].sort((a, b) => {
    const ha = Number(a.handicap);
    const hb = Number(b.handicap);
    const aOk = Number.isFinite(ha);
    const bOk = Number.isFinite(hb);
    if (aOk && bOk && ha !== hb) return ha - hb;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return a.hole_number - b.hole_number;
  });
  const n = Math.max(0, Math.round(Number(totalStrokes) || 0));
  const base = Math.floor(n / 18);
  const rem = n % 18;
  const out = {};
  sorted.forEach((h, i) => {
    out[h.hole_number] = base + (i < rem ? 1 : 0);
  });
  return out;
}

/**
 * Modified Stableford “Stampede” points (net or gross effective strokes vs par).
 * Hole-in-one overrides albatross math.
 */
function stampedeHolePoints(effectiveStrokes, par) {
  const s = Number(effectiveStrokes);
  const p = Number(par);
  if (!Number.isFinite(s) || !Number.isFinite(p)) return 0;
  if (s === 1) return 25;
  const d = s - p;
  if (d >= 2) return 0;
  if (d === 1) return 1;
  if (d === 0) return 2;
  if (d === -1) return 4;
  if (d === -2) return 8;
  return 16;
}

function addWalletDelta(userId, amount, type, description) {
  const wallet = db.wallets[userId];
  if (!wallet) return;
  wallet.balance += amount;
  db.transactions.push({
    id: uuid(),
    wallet_id: wallet.id,
    user_id: userId,
    type,
    amount: Math.abs(amount),
    description,
    created_at: new Date().toISOString(),
  });
}

const HOLES_FRONT9 = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const HOLES_BACK9 = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const HOLES_ALL18 = [...HOLES_FRONT9, ...HOLES_BACK9];

/** Per-hole wagers that honor bet_scope / hole_number (not skins / Nassau / stroke). */
const SCOPED_PROP_BET_TYPES = new Set([
  'match_play', 'teams', 'birdie_bet', 'par_save', 'eagle_bet', 'greenie',
]);

/** Valid junk keys for settlement (must match API). */
const JUNK_SETTLE_KEYS = new Set([
  'sandy', 'barky', 'sharky', 'hogan', 'gorilla', 'snake', 'polie', 'nasty', 'ctp', 'worm',
]);
const JUNK_PENALTY_KEYS = new Set(['snake', 'worm']);
const JUNK_DISABLED_ON_PAR_THREE = new Set(['hogan', 'gorilla']);

function propBetSettlesThisHole(bet, holeNumber) {
  const scope = bet.bet_scope || 'each_hole';
  const start = bet.hole_number != null ? Number(bet.hole_number) : null;
  if (scope === 'each_hole') return true;
  if (scope === 'one_hole') return start != null && holeNumber === start;
  if (scope === 'rest_of_round') return start != null && holeNumber >= start;
  return true;
}

function betWalletScopeFragment(bet, holeNumber) {
  const scope = bet.bet_scope || 'each_hole';
  const h = bet.hole_number != null ? Number(bet.hole_number) : null;
  if (scope === 'one_hole' && h) return ` · hole ${h} only`;
  if (scope === 'rest_of_round' && h) return ` · from hole ${h}`;
  return ` · hole ${holeNumber}`;
}

/**
 * Strokes used for per-hole bets (skins, match play, props) and for net stroke-play totals.
 * Net matches: gross minus handicap strokes received on that hole (same as scorecard net).
 */
function effectiveHoleStrokesForMatch(matchId, userId, holeNumber) {
  const match = db.matches[matchId];
  if (!match) return null;
  const rec = module.exports.getScore(matchId, userId, holeNumber);
  if (!rec || rec.strokes == null) return null;
  const gross = Number(rec.strokes);
  if (String(match.scoring_mode || '') !== 'net') return gross;
  const pk = `${matchId}:${userId}`;
  const mp = db.matchPlayers[pk];
  if (!mp) return gross;
  const sol = mp.strokes_off_leader != null ? Math.round(Number(mp.strokes_off_leader)) : 0;
  const playerTeeId = mp.tee_set_id || match.tee_set_id;
  const playerHoles = playerTeeId ? module.exports.getHolesForTeeSet(playerTeeId) : [];
  const netByHole = allocateNetStrokesByHole(Number.isFinite(sol) ? sol : 0, playerHoles);
  const hn = Number(holeNumber);
  const recv = netByHole[hn] || netByHole[String(hn)] || 0;
  return gross - recv;
}

/** Main game bet (matches match.game_type): only players who are In on the wager compete and settle money. */
function betParticipantsEligibleForMainGame(matchId, match, bet, allBps) {
  const mg = String(match.game_type || '').toLowerCase().trim();
  const bt = String(bet.bet_type || '').toLowerCase().trim();
  if (!mg || bt !== mg) return allBps;
  return allBps.filter((bp) => {
    const mp = db.matchPlayers[`${matchId}:${bp.user_id}`];
    return mp && mp.in_on_bet !== false;
  });
}

/** Lowest total (gross or net per match scoring_mode) wins; losers each pay `amount`, pool split among tied winners. */
function settlePoolByLowestTotal(matchId, bet, participants, holeNumbers, amount, settlementKey, label, competingBps = null) {
  if (db.betSettlements[settlementKey]) return;
  const competing = competingBps != null ? competingBps : participants;
  if (amount <= 0 || competing.length < 2) return;

  const rows = [];
  for (const bp of competing) {
    let sum = 0;
    for (const hn of holeNumbers) {
      const eff = effectiveHoleStrokesForMatch(matchId, bp.user_id, hn);
      if (eff == null || !Number.isFinite(eff)) {
        sum = null;
        break;
      }
      sum += eff;
    }
    if (sum != null) rows.push({ bp, sum });
  }

  if (rows.length < 2) return;

  const low = Math.min(...rows.map(r => r.sum));
  const winners = rows.filter(r => r.sum === low);
  const losers = rows.filter(r => r.sum > low);
  if (winners.length === 0 || losers.length === 0) return;

  const netByUser = {};
  const totalPool = losers.length * amount;
  const eachWinner = totalPool / winners.length;
  winners.forEach(w => {
    netByUser[w.bp.user_id] = (netByUser[w.bp.user_id] || 0) + eachWinner;
  });
  losers.forEach(w => {
    netByUser[w.bp.user_id] = (netByUser[w.bp.user_id] || 0) - amount;
  });

  for (const participant of participants) {
    const delta = netByUser[participant.user_id] || 0;
    participant.net_result = Number(participant.net_result || 0) + delta;
    if (delta > 0) {
      addWalletDelta(participant.user_id, delta, 'bet_payout', `${label} — ${bet.name || bet.bet_type}`);
    } else if (delta < 0) {
      addWalletDelta(participant.user_id, delta, 'bet_loss', `${label} — ${bet.name || bet.bet_type}`);
    }
  }
  db.betSettlements[settlementKey] = {
    id: uuid(), bet_id: bet.id, segment: settlementKey, created_at: new Date().toISOString(),
  };
}

/** Highest total Stampede points wins; losers each pay `amount`, pool split among tied winners. */
function settlePoolByHighestStampede(matchId, bet, participants, holeNumbers, amount, settlementKey, label, competingBps = null) {
  if (db.betSettlements[settlementKey]) return;
  const competing = competingBps != null ? competingBps : participants;
  if (amount <= 0 || competing.length < 2) return;

  const match = db.matches[matchId];
  if (!match) return;
  const scoringMode = match.scoring_mode === 'net' ? 'net' : 'gross';
  const teeSet = match.tee_set_id ? db.teeSets[match.tee_set_id] : null;
  const holesMeta = teeSet ? module.exports.getHolesForTeeSet(teeSet.id) : [];
  const holeMap = {};
  holesMeta.forEach((h) => {
    holeMap[h.hole_number] = h;
  });

  const rows = [];
  for (const bp of competing) {
    const pk = `${matchId}:${bp.user_id}`;
    const mp = db.matchPlayers[pk];
    if (!mp) continue;
    const playerTeeId = mp.tee_set_id || match.tee_set_id;
    const playerHoles = playerTeeId ? module.exports.getHolesForTeeSet(playerTeeId) : holesMeta;
    const sol = mp.strokes_off_leader != null ? Math.round(Number(mp.strokes_off_leader)) : 0;
    const netByHole = scoringMode === 'net' ? allocateNetStrokesByHole(sol, playerHoles) : {};
    let pts = 0;
    let complete = true;
    for (const hn of holeNumbers) {
      const rec = db.scores[`${matchId}:${bp.user_id}:${hn}`];
      if (!rec || rec.strokes == null) {
        complete = false;
        break;
      }
      const hole = holeMap[hn];
      const par = hole?.par ?? 4;
      const recv = netByHole[hn] || 0;
      const gross = rec.strokes;
      const eff = scoringMode === 'net' ? gross - recv : gross;
      pts += stampedeHolePoints(eff, par);
    }
    if (complete) rows.push({ bp, pts });
  }

  if (rows.length < 2) return;

  const high = Math.max(...rows.map((r) => r.pts));
  const winners = rows.filter((r) => r.pts === high);
  const losers = rows.filter((r) => r.pts < high);
  if (winners.length === 0 || losers.length === 0) return;

  const netByUser = {};
  const totalPool = losers.length * amount;
  const eachWinner = totalPool / winners.length;
  winners.forEach((w) => {
    netByUser[w.bp.user_id] = (netByUser[w.bp.user_id] || 0) + eachWinner;
  });
  losers.forEach((w) => {
    netByUser[w.bp.user_id] = (netByUser[w.bp.user_id] || 0) - amount;
  });

  for (const participant of participants) {
    const delta = netByUser[participant.user_id] || 0;
    participant.net_result = Number(participant.net_result || 0) + delta;
    if (delta > 0) {
      addWalletDelta(participant.user_id, delta, 'bet_payout', `${label} — ${bet.name || bet.bet_type}`);
    } else if (delta < 0) {
      addWalletDelta(participant.user_id, delta, 'bet_loss', `${label} — ${bet.name || bet.bet_type}`);
    }
  }
  db.betSettlements[settlementKey] = {
    id: uuid(), bet_id: bet.id, segment: settlementKey, created_at: new Date().toISOString(),
  };
}

// ============================================================
// SEED DATA
// ============================================================
function seedData() {
  const hash = bcrypt.hashSync('password123', 10);

  // --- Users (Rex + three friends only) ---
  const rex = insert('users', {
    email: 'rex@example.com', password_hash: hash,
    display_name: 'Rex Ramza', handicap_index: 8.4,
    friend_invite_code: 'REX-RAMZA-CF',
    avatar_url: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDYywTPTPHZ1-FUnGCMvqo6K6xouMCUTbALLBl6vxP1J_160mAF24rQ32CF16tPhCAIYsIVlQtHzOFgx3oylUiJTsi8Q4seXKt5TdZjKG5NZw-KOWZGHe6TGvFBm4LZI0eohIeaO6e8a-dOmpp3eyj8Wan9WQQDXJkOERpTCzkESnX5PKnLRLl0ueSvX-2oKpTgTckyowNAafhYJP5t65SwGq1zBVnCyHU4r_KaiCWFIm-J6I_JwixHnEeXBP2W_O53L_VpyrVHwJU',
  });
  const timothy = insert('users', {
    email: 'timothy@example.com', password_hash: hash,
    display_name: 'Timothy Ramza', handicap_index: 10.2,
    friend_invite_code: 'TIMOTHY-RAMZA-CF',
    avatar_url: '',
  });
  const ricky = insert('users', {
    email: 'ricky@example.com', password_hash: hash,
    display_name: 'Ricky Mont', handicap_index: 11.0,
    friend_invite_code: 'RICKY-MONT-CF',
    avatar_url: '',
  });
  const holt = insert('users', {
    email: 'holt@example.com', password_hash: hash,
    display_name: 'Holt Moriarty', handicap_index: 9.1,
    friend_invite_code: 'HOLT-MORIARTY-CF',
    avatar_url: '',
  });

  recordFriendshipPair(rex.id, timothy.id);
  recordFriendshipPair(rex.id, ricky.id);
  recordFriendshipPair(rex.id, holt.id);

  // Wallets
  db.wallets[rex.id] = { id: uuid(), user_id: rex.id, balance: 14250 };
  db.wallets[timothy.id] = { id: uuid(), user_id: timothy.id, balance: 5000 };
  db.wallets[ricky.id] = { id: uuid(), user_id: ricky.id, balance: 5000 };
  db.wallets[holt.id] = { id: uuid(), user_id: holt.id, balance: 5000 };

  // --- UT Golf Club ---
  const utCourse = insert('courses', {
    external_id: 21065,
    name: 'University Of Texas Golf Club',
    club_name: 'University Of Texas Golf Club',
    location: 'Austin, TX',
    address: '2200 University Club Dr, Austin, TX 78732, USA',
    city: 'Austin', state: 'TX', country: 'United States',
    latitude: 30.356304, longitude: -97.8932,
    total_par: 71, num_holes: 18,
  });

  // Men's tee sets — UT Golf Club (external_id 21065), par 71 / ratings per source feed
  const teesData = [
    {
      tee_name: 'Texas', gender: 'male',
      course_rating: 76.7, slope_rating: 145, bogey_rating: 103.6,
      total_yards: 7412, par_total: 71,
      front_course_rating: 38.1, front_slope_rating: 147,
      back_course_rating: 38.6, back_slope_rating: 142,
      holes: [
        { par: 4, yardage: 370, handicap: 17 }, { par: 3, yardage: 194, handicap: 13 }, { par: 4, yardage: 493, handicap: 5 },
        { par: 4, yardage: 375, handicap: 15 }, { par: 4, yardage: 461, handicap: 1 }, { par: 4, yardage: 406, handicap: 7 },
        { par: 4, yardage: 462, handicap: 3 }, { par: 3, yardage: 237, handicap: 11 }, { par: 5, yardage: 605, handicap: 9 },
        { par: 4, yardage: 422, handicap: 10 }, { par: 5, yardage: 596, handicap: 6 }, { par: 3, yardage: 190, handicap: 16 },
        { par: 4, yardage: 375, handicap: 18 }, { par: 5, yardage: 562, handicap: 14 }, { par: 4, yardage: 472, handicap: 2 },
        { par: 3, yardage: 248, handicap: 12 }, { par: 4, yardage: 427, handicap: 8 }, { par: 4, yardage: 517, handicap: 4 },
      ],
    },
    {
      tee_name: 'George Hannon', gender: 'male',
      course_rating: 75.9, slope_rating: 144, bogey_rating: 102.7,
      total_yards: 7251, par_total: 71,
      front_course_rating: 37.7, front_slope_rating: 146,
      back_course_rating: 38.2, back_slope_rating: 141,
      holes: [
        { par: 4, yardage: 370, handicap: 17 }, { par: 3, yardage: 185, handicap: 13 }, { par: 4, yardage: 458, handicap: 5 },
        { par: 4, yardage: 375, handicap: 15 }, { par: 4, yardage: 461, handicap: 1 }, { par: 4, yardage: 406, handicap: 7 },
        { par: 4, yardage: 431, handicap: 3 }, { par: 3, yardage: 237, handicap: 11 }, { par: 5, yardage: 605, handicap: 9 },
        { par: 4, yardage: 422, handicap: 10 }, { par: 5, yardage: 579, handicap: 6 }, { par: 3, yardage: 190, handicap: 16 },
        { par: 4, yardage: 363, handicap: 18 }, { par: 5, yardage: 562, handicap: 14 }, { par: 4, yardage: 437, handicap: 2 },
        { par: 3, yardage: 248, handicap: 12 }, { par: 4, yardage: 427, handicap: 8 }, { par: 4, yardage: 495, handicap: 4 },
      ],
    },
    {
      tee_name: 'Orange Longhorn', gender: 'male',
      course_rating: 75.5, slope_rating: 142, bogey_rating: 101.8,
      total_yards: 7154, par_total: 71,
      front_course_rating: 37.5, front_slope_rating: 144,
      back_course_rating: 38.0, back_slope_rating: 139,
      holes: [
        { par: 4, yardage: 366, handicap: 17 }, { par: 3, yardage: 185, handicap: 13 }, { par: 4, yardage: 458, handicap: 5 },
        { par: 4, yardage: 356, handicap: 15 }, { par: 4, yardage: 459, handicap: 1 }, { par: 4, yardage: 406, handicap: 7 },
        { par: 4, yardage: 431, handicap: 3 }, { par: 3, yardage: 237, handicap: 11 }, { par: 5, yardage: 580, handicap: 9 },
        { par: 4, yardage: 409, handicap: 10 }, { par: 5, yardage: 579, handicap: 6 }, { par: 3, yardage: 183, handicap: 16 },
        { par: 4, yardage: 363, handicap: 18 }, { par: 5, yardage: 562, handicap: 14 }, { par: 4, yardage: 437, handicap: 2 },
        { par: 3, yardage: 248, handicap: 12 }, { par: 4, yardage: 400, handicap: 8 }, { par: 4, yardage: 495, handicap: 4 },
      ],
    },
    {
      tee_name: 'Harvey Penick', gender: 'male',
      course_rating: 74.1, slope_rating: 141, bogey_rating: 100.1,
      total_yards: 6833, par_total: 71,
      front_course_rating: 36.8, front_slope_rating: 143,
      back_course_rating: 37.3, back_slope_rating: 138,
      holes: [
        { par: 4, yardage: 366, handicap: 17 }, { par: 3, yardage: 185, handicap: 13 }, { par: 4, yardage: 392, handicap: 5 },
        { par: 4, yardage: 356, handicap: 15 }, { par: 4, yardage: 436, handicap: 1 }, { par: 4, yardage: 406, handicap: 7 },
        { par: 4, yardage: 409, handicap: 3 }, { par: 3, yardage: 195, handicap: 11 }, { par: 5, yardage: 580, handicap: 9 },
        { par: 4, yardage: 409, handicap: 10 }, { par: 5, yardage: 560, handicap: 6 }, { par: 3, yardage: 183, handicap: 16 },
        { par: 4, yardage: 363, handicap: 18 }, { par: 5, yardage: 531, handicap: 14 }, { par: 4, yardage: 408, handicap: 2 },
        { par: 3, yardage: 219, handicap: 12 }, { par: 4, yardage: 400, handicap: 8 }, { par: 4, yardage: 435, handicap: 4 },
      ],
    },
    {
      tee_name: 'White Longhorn', gender: 'male',
      course_rating: 73.2, slope_rating: 136, bogey_rating: 98.4,
      total_yards: 6635, par_total: 71,
      front_course_rating: 36.4, front_slope_rating: 137,
      back_course_rating: 36.8, back_slope_rating: 135,
      holes: [
        { par: 4, yardage: 348, handicap: 17 }, { par: 3, yardage: 174, handicap: 13 }, { par: 4, yardage: 392, handicap: 5 },
        { par: 4, yardage: 326, handicap: 15 }, { par: 4, yardage: 436, handicap: 1 }, { par: 4, yardage: 396, handicap: 7 },
        { par: 4, yardage: 409, handicap: 3 }, { par: 3, yardage: 195, handicap: 11 }, { par: 5, yardage: 553, handicap: 9 },
        { par: 4, yardage: 379, handicap: 10 }, { par: 5, yardage: 560, handicap: 6 }, { par: 3, yardage: 166, handicap: 16 },
        { par: 4, yardage: 348, handicap: 18 }, { par: 5, yardage: 531, handicap: 14 }, { par: 4, yardage: 408, handicap: 2 },
        { par: 3, yardage: 219, handicap: 12 }, { par: 4, yardage: 360, handicap: 8 }, { par: 4, yardage: 435, handicap: 4 },
      ],
    },
    {
      tee_name: 'Morris Williams', gender: 'male',
      course_rating: 71.5, slope_rating: 135, bogey_rating: 96.5,
      total_yards: 6363, par_total: 71,
      front_course_rating: 35.8, front_slope_rating: 136,
      back_course_rating: 35.7, back_slope_rating: 133,
      holes: [
        { par: 4, yardage: 348, handicap: 17 }, { par: 3, yardage: 174, handicap: 13 }, { par: 4, yardage: 359, handicap: 5 },
        { par: 4, yardage: 326, handicap: 15 }, { par: 4, yardage: 427, handicap: 1 }, { par: 4, yardage: 396, handicap: 7 },
        { par: 4, yardage: 385, handicap: 3 }, { par: 3, yardage: 159, handicap: 11 }, { par: 5, yardage: 553, handicap: 9 },
        { par: 4, yardage: 379, handicap: 10 }, { par: 5, yardage: 526, handicap: 6 }, { par: 3, yardage: 166, handicap: 16 },
        { par: 4, yardage: 348, handicap: 18 }, { par: 5, yardage: 495, handicap: 14 }, { par: 4, yardage: 359, handicap: 2 },
        { par: 3, yardage: 186, handicap: 12 }, { par: 4, yardage: 360, handicap: 8 }, { par: 4, yardage: 417, handicap: 4 },
      ],
    },
    {
      tee_name: 'Orange U T', gender: 'male',
      course_rating: 70.3, slope_rating: 131, bogey_rating: 94.6,
      total_yards: 6105, par_total: 71,
      front_course_rating: 35.2, front_slope_rating: 131,
      back_course_rating: 35.1, back_slope_rating: 130,
      holes: [
        { par: 4, yardage: 323, handicap: 17 }, { par: 3, yardage: 141, handicap: 13 }, { par: 4, yardage: 359, handicap: 5 },
        { par: 4, yardage: 290, handicap: 15 }, { par: 4, yardage: 427, handicap: 1 }, { par: 4, yardage: 387, handicap: 7 },
        { par: 4, yardage: 385, handicap: 3 }, { par: 3, yardage: 159, handicap: 11 }, { par: 5, yardage: 526, handicap: 9 },
        { par: 4, yardage: 346, handicap: 10 }, { par: 5, yardage: 526, handicap: 6 }, { par: 3, yardage: 137, handicap: 16 },
        { par: 4, yardage: 322, handicap: 18 }, { par: 5, yardage: 495, handicap: 14 }, { par: 4, yardage: 359, handicap: 2 },
        { par: 3, yardage: 186, handicap: 12 }, { par: 4, yardage: 320, handicap: 8 }, { par: 4, yardage: 417, handicap: 4 },
      ],
    },
    {
      tee_name: 'Ed White', gender: 'male',
      course_rating: 67.8, slope_rating: 125, bogey_rating: 91.0,
      total_yards: 5570, par_total: 71,
      front_course_rating: 33.5, front_slope_rating: 123,
      back_course_rating: 34.3, back_slope_rating: 127,
      holes: [
        { par: 4, yardage: 323, handicap: 17 }, { par: 3, yardage: 141, handicap: 13 }, { par: 4, yardage: 314, handicap: 5 },
        { par: 4, yardage: 290, handicap: 15 }, { par: 4, yardage: 427, handicap: 1 }, { par: 4, yardage: 266, handicap: 7 },
        { par: 4, yardage: 251, handicap: 3 }, { par: 3, yardage: 100, handicap: 11 }, { par: 5, yardage: 526, handicap: 9 },
        { par: 4, yardage: 346, handicap: 10 }, { par: 5, yardage: 526, handicap: 6 }, { par: 3, yardage: 137, handicap: 16 },
        { par: 4, yardage: 322, handicap: 18 }, { par: 5, yardage: 435, handicap: 14 }, { par: 4, yardage: 327, handicap: 2 },
        { par: 3, yardage: 186, handicap: 12 }, { par: 4, yardage: 320, handicap: 8 }, { par: 4, yardage: 333, handicap: 4 },
      ],
    },
    {
      tee_name: 'White U T', gender: 'male',
      course_rating: 66.2, slope_rating: 116, bogey_rating: 87.8,
      total_yards: 5102, par_total: 71,
      front_course_rating: 32.8, front_slope_rating: 114,
      back_course_rating: 33.4, back_slope_rating: 118,
      holes: [
        { par: 4, yardage: 278, handicap: 17 }, { par: 3, yardage: 112, handicap: 13 }, { par: 4, yardage: 314, handicap: 5 },
        { par: 4, yardage: 254, handicap: 15 }, { par: 4, yardage: 395, handicap: 1 }, { par: 4, yardage: 266, handicap: 7 },
        { par: 4, yardage: 251, handicap: 3 }, { par: 3, yardage: 100, handicap: 11 }, { par: 5, yardage: 452, handicap: 9 },
        { par: 4, yardage: 310, handicap: 10 }, { par: 5, yardage: 470, handicap: 6 }, { par: 3, yardage: 111, handicap: 16 },
        { par: 4, yardage: 296, handicap: 18 }, { par: 5, yardage: 435, handicap: 14 }, { par: 4, yardage: 327, handicap: 2 },
        { par: 3, yardage: 106, handicap: 12 }, { par: 4, yardage: 292, handicap: 8 }, { par: 4, yardage: 333, handicap: 4 },
      ],
    },
  ];

  const teeSetMap = {}; // tee_name -> id
  for (const tee of teesData) {
    const ts = insert('teeSets', {
      course_id: utCourse.id, tee_name: tee.tee_name, gender: tee.gender,
      course_rating: tee.course_rating, slope_rating: tee.slope_rating,
      bogey_rating: tee.bogey_rating, total_yards: tee.total_yards,
      par_total: tee.par_total,
      front_course_rating: tee.front_course_rating, front_slope_rating: tee.front_slope_rating,
      back_course_rating: tee.back_course_rating, back_slope_rating: tee.back_slope_rating,
    });
    teeSetMap[tee.tee_name] = ts.id;
    tee.holes.forEach((h, i) => {
      const key = `${ts.id}:${i + 1}`;
      db.teeHoles[key] = { id: uuid(), tee_set_id: ts.id, hole_number: i + 1, ...h };
    });
  }

  // --- Active Match ---
  const harveyId = teeSetMap['Harvey Penick'];
  const whiteId = teeSetMap['White Longhorn'];

  const match = insert('matches', {
    course_id: utCourse.id, created_by: rex.id,
    name: 'Saturday Skins', tee_time: new Date().toISOString(),
    current_hole: 7, status: 'active', scoring_mode: 'gross',
    tee_set_id: harveyId,
    game_type: 'skins',
    junk_enabled: true,
    junk_amount: 1,
    snake_tally: 0,
    worm_tally: 0,
    snake_holder_id: null,
    worm_holder_id: null,
  });

  // Add players
  const players = [
    { user: rex, tee: harveyId },
    { user: timothy, tee: whiteId },
    { user: ricky, tee: whiteId },
    { user: holt, tee: harveyId },
  ];
  for (const p of players) {
    const key = `${match.id}:${p.user.id}`;
    db.matchPlayers[key] = {
      id: uuid(), match_id: match.id, user_id: p.user.id,
      handicap_at_match: p.user.handicap_index, tee_set_id: p.tee,
      junk_net_result: 0, junk_marks_for: 0, junk_marks_against: 0,
    };
  }

  // Scores through hole 6
  const allScores = {
    [rex.id]: [4, 3, 5, 4, 5, 4],
    [timothy.id]: [4, 4, 4, 4, 5, 5],
    [ricky.id]: [5, 3, 5, 5, 6, 5],
    [holt.id]: [4, 3, 4, 4, 4, 4],
  };
  for (const [uid, scores] of Object.entries(allScores)) {
    scores.forEach((strokes, i) => {
      const key = `${match.id}:${uid}:${i + 1}`;
      db.scores[key] = {
        id: uuid(), match_id: match.id, user_id: uid,
        hole_number: i + 1, strokes,
        putts: 1 + Math.floor(Math.random() * 2),
        fairway_hit: Math.random() > 0.35,
        gir: Math.random() > 0.4,
        created_at: new Date().toISOString(),
      };
    });
  }

  // Skins bet
  const skinsBet = insert('bets', {
    match_id: match.id, created_by: rex.id,
    bet_type: 'skins', name: 'Match Skins',
    amount: 5, status: 'active', carry_over: 0,
    bet_scope: 'each_hole', hole_number: null,
  });
  for (const p of players) {
    const key = `${skinsBet.id}:${p.user.id}`;
    db.betParticipants[key] = {
      id: uuid(), bet_id: skinsBet.id, user_id: p.user.id,
      accepted: true, net_result: 0,
    };
  }

  // Transactions
  db.transactions.push({
    id: uuid(), wallet_id: db.wallets[rex.id].id, user_id: rex.id,
    type: 'deposit', amount: 5000, description: 'Wallet deposit',
    created_at: '2025-10-24T12:00:00Z',
  });

  return { rex, timothy, ricky, holt, utCourse, match, teeSetMap, skinsBet };
}

const seeded = seedData();

// ============================================================
// PUBLIC API (used by routes)
// ============================================================
module.exports = {
  db, seeded, values, find, findOne, insert, update, uuid,
  scoreLabel, courseHandicap, getNetStrokes,
  allocateNetStrokesByHole, stampedeHolePoints,

  // --- Users ---
  getUserByEmail(email) { return findOne('users', u => u.email === email); },
  getUserById(id) {
    if (id == null || id === '') return undefined;
    const s = String(id).trim();
    return db.users[s] ?? db.users[id];
  },
  getFriendIds(userId) { return friendIdsForUser(userId); },
  addFriendship(userIdA, userIdB) { return recordFriendshipPair(userIdA, userIdB); },
  getUserByFriendInviteCode(code) { return lookupUserByInviteCode(code); },
  ensureFriendInviteCode(userId) { return assignInviteCodeIfMissing(userId); },
  acceptFriendInvite(accepterId, rawCode) {
    const owner = lookupUserByInviteCode(rawCode);
    if (!owner) return { ok: false, error: 'invalid_code' };
    if (owner.id === accepterId) return { ok: false, error: 'self' };
    const key = friendshipPairKey(owner.id, accepterId);
    const existed = !!db.friendPairs[key];
    recordFriendshipPair(owner.id, accepterId);
    return { ok: true, friend: owner, already_friends: existed };
  },
  getFriendsForUser(userId) {
    return friendIdsForUser(userId)
      .map((id) => db.users[id])
      .filter(Boolean);
  },

  /** Placeholder “sub” for a round — not listed in /users and cannot log in. */
  createSubUser({ display_name, handicap_index }) {
    const name = typeof display_name === 'string' ? display_name.trim().slice(0, 80) : '';
    if (!name) return null;
    let hcp = handicap_index != null && handicap_index !== '' ? Number(handicap_index) : 18;
    if (!Number.isFinite(hcp)) hcp = 18;
    hcp = Math.max(-10, Math.min(54, Math.round(hcp * 10) / 10));
    const email = `sub-${uuid()}@sub.local`;
    const user = insert('users', {
      email,
      password_hash: bcrypt.hashSync(`!sub:${uuid()}`, 10),
      display_name: name,
      handicap_index: hcp,
      avatar_url: '',
      is_sub: true,
    });
    db.wallets[user.id] = {
      id: uuid(),
      user_id: user.id,
      balance: 0,
    };
    return user;
  },

  // --- Courses ---
  getAllCourses() { return values('courses'); },
  getCourse(id) { return db.courses[id]; },
  getTeeSetsForCourse(courseId) { return find('teeSets', t => t.course_id === courseId); },
  getTeeSet(id) { return db.teeSets[id]; },
  getHolesForTeeSet(teeSetId) {
    return Object.values(db.teeHoles)
      .filter(h => h.tee_set_id === teeSetId)
      .sort((a, b) => a.hole_number - b.hole_number);
  },

  // --- Matches ---
  getMatch(id) { return db.matches[id]; },
  getMatchesForUser(userId) {
    const matchIds = new Set(
      find('matchPlayers', mp => mp.user_id === userId).map(mp => mp.match_id)
    );
    return values('matches').filter(m => matchIds.has(m.id)).sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );
  },
  getMatchPlayers(matchId) {
    return Object.values(db.matchPlayers)
      .filter(mp => mp.match_id === matchId)
      .map(mp => {
        const user = db.users[mp.user_id];
        const tee = mp.tee_set_id ? db.teeSets[mp.tee_set_id] : null;
        const hcpAt = mp.handicap_at_match != null ? Number(mp.handicap_at_match) : null;
        const sol = mp.strokes_off_leader != null ? Math.round(Number(mp.strokes_off_leader)) : null;
        const inOn = mp.in_on_bet !== false;
        const sq = mp.stampede_quota != null ? Math.round(Number(mp.stampede_quota)) : null;
        const jf = Number(mp.junk_marks_for) || 0;
        const ja = Number(mp.junk_marks_against) || 0;
        const jn = Number(mp.junk_net_result) || 0;
        const tri = mp.team_index;
        const team_index =
          tri == null || tri === '' ? null : Number(tri) === 2 ? 2 : 1;
        return {
          ...mp,
          team_index,
          teamIndex: team_index,
          display_name: user?.display_name,
          avatar_url: user?.avatar_url,
          handicap_index: hcpAt != null && Number.isFinite(hcpAt) ? hcpAt : user?.handicap_index,
          tee_name: tee?.tee_name,
          tee_total_yards: tee?.total_yards,
          strokes_off_leader: sol,
          strokesOffLeader: sol,
          stampede_quota: sq,
          stampedeQuota: sq,
          in_on_bet: inOn,
          inOnBet: inOn,
          junk_net_result: jn,
          junkNetResult: jn,
          junk_marks_for: jf,
          junk_marks_against: ja,
          junkMarksFor: jf,
          junkMarksAgainst: ja,
        };
      });
  },

  // --- Scores ---
  getScoresForMatch(matchId) {
    return Object.values(db.scores)
      .filter(s => s.match_id === matchId)
      .sort((a, b) => a.hole_number - b.hole_number);
  },
  getPlayerScores(matchId, userId) {
    return Object.values(db.scores)
      .filter(s => s.match_id === matchId && s.user_id === userId)
      .sort((a, b) => a.hole_number - b.hole_number);
  },
  getScore(matchId, userId, holeNumber) {
    const h = Number(holeNumber);
    if (!Number.isInteger(h) || h < 1 || h > 18) return null;
    return db.scores[`${matchId}:${userId}:${h}`] || null;
  },
  upsertScore(matchId, userId, holeNumber, data) {
    const h = Number(holeNumber);
    if (!Number.isInteger(h) || h < 1 || h > 18) return null;
    const key = `${matchId}:${userId}:${h}`;
    if (db.scores[key]) {
      Object.assign(db.scores[key], data, { updated_at: new Date().toISOString() });
    } else {
      db.scores[key] = {
        id: uuid(), match_id: matchId, user_id: userId,
        hole_number: h, ...data,
        created_at: new Date().toISOString(),
      };
    }
    return db.scores[key];
  },

  // --- Bets ---
  getBetsForMatch(matchId) {
    const bets = find('bets', b => b.match_id === matchId);
    return bets.map(b => {
      const participants = Object.values(db.betParticipants)
        .filter(bp => bp.bet_id === b.id)
        .map(bp => {
          const user = db.users[bp.user_id];
          return { ...bp, display_name: user?.display_name };
        });
      return { ...b, participants };
    });
  },
  settleBetsForHole(matchId, holeNumber) {
    const match = db.matches[matchId];
    if (!match) return;

    const teeSet = match.tee_set_id ? db.teeSets[match.tee_set_id] : null;
    const holes = teeSet ? module.exports.getHolesForTeeSet(teeSet.id) : [];
    const hole = holes.find(h => h.hole_number === holeNumber);
    const holeMeta = hole || { hole_number: holeNumber, par: 4 };

    const bets = find('bets', b => b.match_id === matchId && b.status === 'active');
    for (const bet of bets) {
      const participants = Object.values(db.betParticipants).filter(bp => bp.bet_id === bet.id);
      const amount = Number(bet.amount || 0);
      const poolBps = betParticipantsEligibleForMainGame(matchId, match, bet, participants);

      // --- Per-hole games (skins, match play, side props) — need scores on this hole
      const holeSettlementKey = `${bet.id}:${Number(holeNumber)}`;
      if (!db.betSettlements[holeSettlementKey]) {
        const scopedProp = SCOPED_PROP_BET_TYPES.has(bet.bet_type);
        if (!scopedProp || propBetSettlesThisHole(bet, holeNumber)) {
          const scoreRows = poolBps
            .map(bp => {
              const score = module.exports.getScore(matchId, bp.user_id, holeNumber);
              return { bp, score };
            })
            .filter(x => x.score && x.score.strokes != null);

          if (scoreRows.length > 0) {
            const scored = scoreRows.map((x) => {
              const effRaw = effectiveHoleStrokesForMatch(matchId, x.bp.user_id, holeNumber);
              const gross = Number(x.score.strokes);
              const eff = effRaw != null && Number.isFinite(effRaw) ? effRaw : gross;
              return { ...x, eff };
            });

            const netByUser = {};
            let settled = false;
            const scopeFrag = betWalletScopeFragment(bet, holeNumber);
            const labelBase = bet.name || bet.bet_type;

            if (bet.bet_type === 'skins') {
              // Carry on a push is (everyone on this skins wager − 1) × stake — the pot the next sole winner
              // collects from the field (e.g. 3 @ $5 → $10 carry). Do not use only "In" count here; one player
              // with in_on_bet false would wrongly make carry one stake (e.g. $5) and underpay the next win.
              const nSkins = Math.max(0, participants.length);
              // Classic skins: low / tie uses **gross** strokes only so a tied card (e.g. all 4s) is always a push.
              const forSkin = scored.map((x) => ({
                ...x,
                skinStrokes: Number(x.score.strokes),
              }));
              const low = Math.min(...forSkin.map((x) => x.skinStrokes));
              const winners = forSkin.filter((x) => x.skinStrokes === low);

              if (winners.length >= 2) {
                // Tie for low: no winner, no split — ties get nothing. Carry += (skins field size − 1) × stake.
                if (amount > 0 && nSkins > 1) {
                  bet.carry_over = Number(bet.carry_over || 0) + (nSkins - 1) * amount;
                }
                settled = true;
              } else if (winners.length === 1) {
                const winnerId = winners[0].bp.user_id;
                // Losers = everyone who posted and is not the sole winner; each pays stake + equal share of carry.
                const payers = forSkin.filter((x) => x.bp.user_id !== winnerId);
                const carry = Number(bet.carry_over || 0);
                const payout = amount * payers.length + carry;
                if (payout > 0) {
                  netByUser[winnerId] = (netByUser[winnerId] || 0) + payout;
                  if (payers.length > 0) {
                    const carryPerPayer = carry / payers.length;
                    payers.forEach((x) => {
                      netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) - (amount + carryPerPayer);
                    });
                  }
                  bet.carry_over = 0;
                  settled = true;
                } else if (payers.length === 0 && carry === 0) {
                  settled = true;
                }
              }
            } else if (bet.bet_type === 'match_play') {
              const low = Math.min(...scored.map((x) => x.eff));
              const winners = scored.filter((x) => x.eff === low);
              const losers = scored.filter((x) => x.eff !== low);
              if (winners.length > 0 && losers.length > 0 && amount > 0) {
                const totalPool = losers.length * amount;
                const eachWinner = totalPool / winners.length;
                winners.forEach(x => {
                  netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) + eachWinner;
                });
                losers.forEach(x => {
                  netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) - amount;
                });
                settled = true;
              }
            } else if (bet.bet_type === 'teams') {
              // Best-ball team match play: Team 1's low eff vs Team 2's low eff (gross if match is gross).
              const rowsByTeam = (teamNum) =>
                scored.filter((x) => {
                  const mp = db.matchPlayers[`${matchId}:${x.bp.user_id}`];
                  const ti = mp?.team_index != null ? (Number(mp.team_index) === 2 ? 2 : 1) : null;
                  return ti === teamNum;
                });
              const t1Rows = rowsByTeam(1);
              const t2Rows = rowsByTeam(2);
              if (t1Rows.length > 0 && t2Rows.length > 0) {
                const t1Best = Math.min(...t1Rows.map((x) => x.eff));
                const t2Best = Math.min(...t2Rows.map((x) => x.eff));
                if (t1Best === t2Best) {
                  settled = true;
                } else {
                  const winTeam = t1Best < t2Best ? 1 : 2;
                  const loseTeam = winTeam === 1 ? 2 : 1;
                  const winners = rowsByTeam(winTeam);
                  const losers = rowsByTeam(loseTeam);
                  if (winners.length > 0 && losers.length > 0) {
                    if (amount > 0) {
                      const totalPool = losers.length * amount;
                      const eachWinner = totalPool / winners.length;
                      winners.forEach((x) => {
                        netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) + eachWinner;
                      });
                      losers.forEach((x) => {
                        netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) - amount;
                      });
                    }
                    settled = true;
                  }
                }
              }
            } else if (bet.bet_type === 'birdie_bet' || bet.bet_type === 'par_save') {
              const threshold = bet.bet_type === 'birdie_bet' ? holeMeta.par - 1 : holeMeta.par;
              const winners = scored.filter((x) => x.eff <= threshold);
              const losers = scored.filter((x) => x.eff > threshold);
              if (winners.length > 0 && losers.length > 0 && amount > 0) {
                const totalPool = losers.length * amount;
                const eachWinner = totalPool / winners.length;
                winners.forEach(x => {
                  netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) + eachWinner;
                });
                losers.forEach(x => {
                  netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) - amount;
                });
                settled = true;
              }
            } else if (bet.bet_type === 'eagle_bet') {
              const threshold = holeMeta.par - 2;
              const winners = scored.filter((x) => x.eff <= threshold);
              const losers = scored.filter((x) => x.eff > threshold);
              if (winners.length > 0 && losers.length > 0 && amount > 0) {
                const totalPool = losers.length * amount;
                const eachWinner = totalPool / winners.length;
                winners.forEach(x => {
                  netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) + eachWinner;
                });
                losers.forEach(x => {
                  netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) - amount;
                });
                settled = true;
              }
            } else if (bet.bet_type === 'greenie') {
              const winners = scored.filter((x) => x.score.gir === true && x.eff <= holeMeta.par);
              const losers = scored.filter((x) => !(x.score.gir === true && x.eff <= holeMeta.par));
              if (winners.length > 0 && losers.length > 0 && amount > 0) {
                const totalPool = losers.length * amount;
                const eachWinner = totalPool / winners.length;
                winners.forEach(x => {
                  netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) + eachWinner;
                });
                losers.forEach(x => {
                  netByUser[x.bp.user_id] = (netByUser[x.bp.user_id] || 0) - amount;
                });
                settled = true;
              }
            }

            if (settled) {
              for (const participant of participants) {
                const delta = netByUser[participant.user_id] || 0;
                participant.net_result = Number(participant.net_result || 0) + delta;
                if (delta > 0) {
                  addWalletDelta(participant.user_id, delta, 'bet_payout', `${labelBase} payout${scopeFrag}`);
                } else if (delta < 0) {
                  addWalletDelta(participant.user_id, delta, 'bet_loss', `${labelBase} loss${scopeFrag}`);
                }
              }
              db.betSettlements[holeSettlementKey] = {
                id: uuid(), bet_id: bet.id, hole_number: holeNumber, created_at: new Date().toISOString(),
              };
            }
          }
        }
      }

      // --- Nassau: front after hole 9, back + total after hole 18
      if (bet.bet_type === 'nassau') {
        if (holeNumber === 9) {
          settlePoolByLowestTotal(matchId, bet, participants, HOLES_FRONT9, amount, `${bet.id}:nassau_front`, 'Nassau front 9', poolBps);
        }
        if (holeNumber === 18) {
          settlePoolByLowestTotal(matchId, bet, participants, HOLES_BACK9, amount, `${bet.id}:nassau_back`, 'Nassau back 9', poolBps);
          settlePoolByLowestTotal(matchId, bet, participants, HOLES_ALL18, amount, `${bet.id}:nassau_total`, 'Nassau 18-hole', poolBps);
        }
      }

      // --- Stroke play: lowest total for the round (settle when hole 18 closes)
      if (bet.bet_type === 'stroke_play' && holeNumber === 18) {
        settlePoolByLowestTotal(matchId, bet, participants, HOLES_ALL18, amount, `${bet.id}:stroke_play`, 'Stroke play', poolBps);
      }

      // --- Stampede: highest modified-Stableford points after 18
      if (bet.bet_type === 'stampede' && holeNumber === 18) {
        settlePoolByHighestStampede(
          matchId,
          bet,
          participants,
          HOLES_ALL18,
          amount,
          `${bet.id}:stampede`,
          'Stampede',
          poolBps
        );
      }
    }
  },

  /**
   * Settle junk money for a completed hole: winning marks collect `junk_amount` from each other player;
   * penalty marks (Snake, Worm) pay each other player. Idempotent per hole.
   */
  settleJunkForHole(matchId, holeNumber) {
    const hn = Number(holeNumber);
    if (!Number.isInteger(hn) || hn < 1 || hn > 18) return;
    const settleKey = `${matchId}:${hn}`;
    if (db.junkSettlements[settleKey]) return;

    const match = db.matches[matchId];
    if (!match) return;

    const markRecorded = {
      id: uuid(),
      match_id: matchId,
      hole_number: hn,
      created_at: new Date().toISOString(),
    };

    const participants = Object.values(db.matchPlayers).filter(mp => mp.match_id === matchId);
    const ids = participants.map(p => p.user_id);
    const n = ids.length;

    // Do not record junkSettlements here — otherwise a skip (junk off, etc.) blocks forever.
    if (n < 2 || !match.junk_enabled) {
      return;
    }

    const perRaw = Number(match.junk_amount);
    const moneyOk = Number.isFinite(perRaw) && perRaw > 0;
    const per = moneyOk ? perRaw : 0;

    const netByUser = {};
    ids.forEach((uid) => { netByUser[uid] = 0; });

    const teeSet = match.tee_set_id ? db.teeSets[match.tee_set_id] : null;
    const holesMeta = teeSet ? module.exports.getHolesForTeeSet(teeSet.id) : [];
    const holeMeta = holesMeta.find(h => h.hole_number === hn);
    const holePar = holeMeta?.par != null ? Number(holeMeta.par) : null;
    const par3NoHoganGorilla = holePar === 3;

    for (const uid of ids) {
      const score = module.exports.getScore(matchId, uid, hn);
      if (!score?.junk || typeof score.junk !== 'object') continue;
      for (const jk of Object.keys(score.junk)) {
        if (!score.junk[jk] || !JUNK_SETTLE_KEYS.has(jk)) continue;
        if (par3NoHoganGorilla && JUNK_DISABLED_ON_PAR_THREE.has(jk)) continue;
        if (JUNK_PENALTY_KEYS.has(jk)) continue; // Snake/Worm settle at holes 9 & 18 only
        const payers = ids.filter((q) => q !== uid);
        for (const q of payers) {
          netByUser[uid] += per;
          netByUser[q] -= per;
        }
        const mpEarn = db.matchPlayers[`${matchId}:${uid}`];
        if (mpEarn) {
          mpEarn.junk_marks_for = Number(mpEarn.junk_marks_for || 0) + 1;
        }
        for (const q of payers) {
          const mpPay = db.matchPlayers[`${matchId}:${q}`];
          if (mpPay) {
            mpPay.junk_marks_against = Number(mpPay.junk_marks_against || 0) + 1;
          }
        }
      }
    }

    const label = `Junk · hole ${hn}`;
    for (const uid of ids) {
      const delta = netByUser[uid];
      const pk = `${matchId}:${uid}`;
      const mp = db.matchPlayers[pk];
      if (mp && moneyOk) {
        mp.junk_net_result = Number(mp.junk_net_result || 0) + delta;
      }
      if (moneyOk) {
        if (delta > 0) {
          addWalletDelta(uid, delta, 'bet_payout', label);
        } else if (delta < 0) {
          addWalletDelta(uid, delta, 'bet_loss', label);
        }
      }
    }

    db.junkSettlements[settleKey] = { ...markRecorded, settled: true };
  },

  /**
   * Pay out Snake & Worm for front nine (after hole 9) or back nine (after hole 18).
   * Holder pays each other player (tally × junk_amount). Then tallies and holders reset for the next segment.
   */
  settleSnakeWormSegment(matchId, segment) {
    if (segment !== 'front' && segment !== 'back') return;
    const segKey = `${matchId}:${segment}`;
    if (db.junkSegmentSettlements[segKey]) return;

    const match = db.matches[matchId];
    if (!match || !match.junk_enabled) {
      db.junkSegmentSettlements[segKey] = { id: uuid(), match_id: matchId, segment, skipped: true, created_at: new Date().toISOString() };
      return;
    }

    const per = Number(match.junk_amount);
    if (!Number.isFinite(per) || per <= 0) {
      db.junkSegmentSettlements[segKey] = { id: uuid(), match_id: matchId, segment, skipped: true, created_at: new Date().toISOString() };
      return;
    }

    const participants = Object.values(db.matchPlayers).filter(mp => mp.match_id === matchId);
    const ids = participants.map(p => p.user_id);
    if (ids.length < 2) {
      db.junkSegmentSettlements[segKey] = { id: uuid(), match_id: matchId, segment, skipped: true, created_at: new Date().toISOString() };
      return;
    }

    const netByUser = {};
    ids.forEach((uid) => { netByUser[uid] = 0; });

    const paySegmentPenalty = (holderId, tally) => {
      const t = Number(tally) || 0;
      if (!holderId || t <= 0) return;
      const payEach = t * per;
      ids.forEach((q) => {
        if (q === holderId) return;
        netByUser[holderId] -= payEach;
        netByUser[q] += payEach;
      });
    };

    paySegmentPenalty(match.snake_holder_id, match.snake_tally);
    paySegmentPenalty(match.worm_holder_id, match.worm_tally);

    const combinedLabel = `Snake/Worm · holes ${segment === 'front' ? '1–9' : '10–18'}`;
    for (const uid of ids) {
      const delta = netByUser[uid];
      const pk = `${matchId}:${uid}`;
      const mp = db.matchPlayers[pk];
      if (mp) {
        mp.junk_net_result = Number(mp.junk_net_result || 0) + delta;
      }
      if (delta > 0) {
        addWalletDelta(uid, delta, 'bet_payout', combinedLabel);
      } else if (delta < 0) {
        addWalletDelta(uid, delta, 'bet_loss', combinedLabel);
      }
    }

    match.snake_tally = 0;
    match.snake_holder_id = null;
    match.worm_tally = 0;
    match.worm_holder_id = null;
    match.updated_at = new Date().toISOString();

    db.junkSegmentSettlements[segKey] = {
      id: uuid(),
      match_id: matchId,
      segment,
      created_at: new Date().toISOString(),
    };
  },

  finishMatch(matchId) {
    const match = db.matches[matchId];
    if (!match) return null;
    // Always sweep 1–18; betSettlements prevents double-counting. Avoids missing holes when
    // current_hole is out of sync with how scores were entered.
    for (let h = 1; h <= 18; h++) {
      module.exports.settleBetsForHole(matchId, h);
      module.exports.settleJunkForHole(matchId, h);
      if (h === 9) module.exports.settleSnakeWormSegment(matchId, 'front');
      if (h === 18) module.exports.settleSnakeWormSegment(matchId, 'back');
    }
    find('bets', b => b.match_id === matchId).forEach(b => {
      module.exports.update('bets', b.id, { status: 'completed' });
    });
    return module.exports.update('matches', matchId, {
      status: 'completed',
      current_hole: 18,
      finished_at: new Date().toISOString(),
    });
  },

  // --- Wallet ---
  getWallet(userId) { return db.wallets[userId]; },
  getTransactions(userId) {
    return db.transactions.filter(t => t.user_id === userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  deposit(userId, amount) {
    const w = db.wallets[userId];
    if (!w) return null;
    w.balance += amount;
    db.transactions.push({
      id: uuid(), wallet_id: w.id, user_id: userId,
      type: 'deposit', amount, description: 'Wallet deposit',
      created_at: new Date().toISOString(),
    });
    return w;
  },
  withdraw(userId, amount) {
    const w = db.wallets[userId];
    if (!w || w.balance < amount) return null;
    w.balance -= amount;
    db.transactions.push({
      id: uuid(), wallet_id: w.id, user_id: userId,
      type: 'withdrawal', amount, description: 'Wallet withdrawal',
      created_at: new Date().toISOString(),
    });
    return w;
  },

  // --- Full match detail (for scorecard) ---
  getMatchDetail(matchId) {
    const match = db.matches[matchId];
    if (!match) return null;
    const course = db.courses[match.course_id];
    const teeSet = match.tee_set_id ? db.teeSets[match.tee_set_id] : null;
    const players = module.exports.getMatchPlayers(matchId);
    const holes = teeSet
      ? module.exports.getHolesForTeeSet(teeSet.id)
      : [];
    const scores = module.exports.getScoresForMatch(matchId);
    const bets = module.exports.getBetsForMatch(matchId);

    const junkOn = !!match.junk_enabled;
    const snakeHolder = match.snake_holder_id ? db.users[match.snake_holder_id] : null;
    const wormHolder = match.worm_holder_id ? db.users[match.worm_holder_id] : null;
    return {
      ...match,
      junk_enabled: junkOn,
      junkEnabled: junkOn,
      snake_tally: Number(match.snake_tally) || 0,
      worm_tally: Number(match.worm_tally) || 0,
      snake_holder_name: snakeHolder?.display_name || null,
      worm_holder_name: wormHolder?.display_name || null,
      course_name: course?.name, course_location: course?.location,
      tee_name: teeSet?.tee_name, tee_total_yards: teeSet?.total_yards,
      tee_par_total: teeSet?.par_total, course_rating: teeSet?.course_rating,
      slope_rating: teeSet?.slope_rating,
      players, holes, scores, bets,
    };
  },
};
