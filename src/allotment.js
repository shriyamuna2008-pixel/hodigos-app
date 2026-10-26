/**
 * Seat allotment engine (rule-based, deterministic).
 *
 * Every program has three seat buckets: Open (O), Home State (H) and Reserved (R).
 * A student's preference list is expanded into buckets: for each program, Open first,
 * then Home State (if the college is in the student's home state), then Reserved
 * (if the student is in the reserved category).
 *
 * Seats are matched with student-proposing deferred acceptance (Gale–Shapley).
 * Priority at a bucket:
 *   1. a seat already held from the previous round (Float / Slide keep their seat)
 *   2. higher merit score
 *   3. home-state tie-breaker: student from the college's state wins a tie
 *   4. older date of birth
 *   5. lower application id
 */
const crypto = require('crypto');
const { meritScore } = require('./constants');

function bucketsFor(student, prog) {
  const out = [prog.id + '|O'];
  if (student.home_state === prog.state) out.push(prog.id + '|H');
  if (student.category === 'RES') out.push(prog.id + '|R');
  return out;
}

function makeRanker(progById, guaranteed) {
  return function ranksAbove(a, b, bucket) {
    const ga = guaranteed[a.id] === bucket, gb = guaranteed[b.id] === bucket;
    if (ga !== gb) return ga;
    if (a.score !== b.score) return a.score > b.score;
    const st = progById.get(Number(bucket.split('|')[0])).state;
    const ah = a.home_state === st, bh = b.home_state === st;
    if (ah !== bh) return ah;
    const ad = a.dob ? new Date(a.dob).getTime() : Infinity, bd = b.dob ? new Date(b.dob).getTime() : Infinity;
    if (ad !== bd) return ad < bd;
    return a.id < b.id;
  };
}

function deferredAcceptance(students, lists, caps, ranksAbove) {
  const byId = new Map(students.map(s => [s.id, s]));
  const held = {}, next = {};
  const free = students.map(s => s.id).reverse();
  while (free.length) {
    const id = free.pop();
    const L = lists[id] || [];
    const i = next[id] || 0;
    if (i >= L.length) continue;               // list exhausted: no seat
    const b = L[i];
    next[id] = i + 1;
    if (!caps[b]) { free.push(id); continue; }
    const arr = held[b] || (held[b] = []);
    arr.push(id);
    if (arr.length > caps[b]) {                 // over capacity: reject the lowest-priority holder
      let wi = 0;
      for (let k = 1; k < arr.length; k++) if (ranksAbove(byId.get(arr[wi]), byId.get(arr[k]), b)) wi = k;
      const [w] = arr.splice(wi, 1);
      free.push(w);
    }
  }
  const assign = {};
  for (const b in held) for (const id of held[b]) assign[id] = b;
  return assign;
}

/**
 * Run a round inside an open transaction (client). Writes allotments + round_runs.
 * Round 2 uses Round 1 seats and each student's decision + payment.
 */
async function runRound(client, round) {
  const progs = (await client.query(
    `SELECT p.id, p.seats_open, p.seats_home, p.seats_reserved, p.college_id, c.state
       FROM programs p JOIN colleges c ON c.id = p.college_id`)).rows;
  const progById = new Map(progs.map(p => [p.id, p]));

  const students = (await client.query(
    `SELECT id, home_state, category, board_pct, entrance_pct, dob
       FROM users WHERE role='student' AND prefs_locked = TRUE ORDER BY id`)).rows
    .map(s => ({ ...s, score: meritScore(s) }));
  const prefRows = (await client.query(
    `SELECT pr.user_id, pr.program_id FROM preferences pr
       JOIN users u ON u.id = pr.user_id WHERE u.prefs_locked = TRUE ORDER BY pr.user_id, pr.rank`)).rows;
  const prefs = {};
  for (const r of prefRows) (prefs[r.user_id] ||= []).push(r.program_id);

  const fullList = s => (prefs[s.id] || []).filter(pid => progById.has(pid)).flatMap(pid => bucketsFor(s, progById.get(pid)));

  const caps = {};
  for (const p of progs) { caps[p.id + '|O'] = p.seats_open; caps[p.id + '|H'] = p.seats_home; caps[p.id + '|R'] = p.seats_reserved; }

  let assign;
  const guaranteed = {};
  if (round === 1) {
    const lists = {};
    for (const s of students) lists[s.id] = fullList(s);
    assign = deferredAcceptance(students, lists, caps, makeRanker(progById, guaranteed));
  } else {
    const r1 = {};
    for (const r of (await client.query('SELECT user_id, program_id, quota FROM allotments WHERE round=1')).rows) r1[r.user_id] = r.program_id + '|' + r.quota;
    const dec = {};
    for (const r of (await client.query('SELECT user_id, decision FROM decisions')).rows) dec[r.user_id] = r.decision;
    const paid = new Set((await client.query('SELECT user_id FROM payments')).rows.map(r => r.user_id));

    const active = [], lists = {}, frozen = {};
    for (const s of students) {
      const seat = r1[s.id];
      if (!seat) { active.push(s); lists[s.id] = fullList(s); continue; }        // no seat in R1: full list again
      // No decision or no fee paid = seat cancelled (same as withdraw).
      const d = paid.has(s.id) ? dec[s.id] : null;
      if (!d || d === 'withdraw') continue;
      if (d === 'freeze') { frozen[s.id] = seat; caps[seat] -= 1; continue; }
      const L = fullList(s), idx = L.indexOf(seat);
      let better = idx >= 0 ? L.slice(0, idx) : [];
      if (d === 'slide') {
        const col = progById.get(Number(seat.split('|')[0])).college_id;
        better = better.filter(b => progById.get(Number(b.split('|')[0])).college_id === col);
      }
      lists[s.id] = [...better, seat];
      guaranteed[s.id] = seat;
      active.push(s);
    }
    assign = deferredAcceptance(active, lists, caps, makeRanker(progById, guaranteed));
    Object.assign(assign, frozen);
    for (const id in frozen) caps[frozen[id]] += 1;
  }

  // SOP 4: no student twice (guaranteed by the map) and no bucket over capacity.
  const count = {};
  for (const id in assign) count[assign[id]] = (count[assign[id]] || 0) + 1;
  for (const b in count) if (count[b] > (caps[b] || 0)) throw new Error('Seat conflict detected in bucket ' + b + '. Round aborted.');

  await client.query('DELETE FROM allotments WHERE round >= $1', [round]);
  const scoreOf = new Map(students.map(s => [s.id, s.score]));
  const rows = Object.entries(assign).sort((a, b) => a[0] - b[0]);
  for (const [uid, b] of rows) {
    const [pid, quota] = b.split('|');
    const rank = (prefs[uid] || []).indexOf(Number(pid)) + 1;
    await client.query(
      'INSERT INTO allotments(round,user_id,program_id,quota,score,pref_rank) VALUES($1,$2,$3,$4,$5,$6)',
      [round, Number(uid), Number(pid), quota, scoreOf.get(Number(uid)), rank]);
  }
  const hash = crypto.createHash('sha256').update('R' + round + '|' + rows.map(([u, b]) => u + '=' + b).join(';')).digest('hex');
  await client.query(
    `INSERT INTO round_runs(round,participants,allotted,hash) VALUES($1,$2,$3,$4)
     ON CONFLICT(round) DO UPDATE SET run_at=now(), participants=EXCLUDED.participants, allotted=EXCLUDED.allotted, hash=EXCLUDED.hash`,
    [round, students.length, rows.length, hash]);
  return { participants: students.length, allotted: rows.length, hash };
}

module.exports = { runRound, bucketsFor };
