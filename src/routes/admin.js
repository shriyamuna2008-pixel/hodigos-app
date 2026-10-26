const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ah, flash, requireAdmin, studentStatus } = require('../helpers');
const { STATES, DOC_TYPES, PHASES, SEAT_FEE, meritScore, appNo } = require('../constants');
const { runRound } = require('../allotment');
const { createSampleApplicants } = require('../seed');
const { loadDemo, DEMO_PASSWORD, DEMO_DOMAIN } = require('../demo');

const router = express.Router();
const actor = res => 'admin:' + res.locals.currentUser.email;
const back = (req, fallback) => req.get('Referer') || fallback;

/* ---------------- Login ---------------- */
router.get('/login', (req, res) => res.render('admin/login', { title: 'Admin login', area: 'admin', email: '' }));
router.post('/login', ah(async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const u = (await db.query("SELECT * FROM users WHERE email=$1 AND role='admin'", [email])).rows[0];
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) {
    return res.status(401).render('admin/login', { title: 'Admin login', area: 'admin', email, error: 'Email or password is incorrect.' });
  }
  req.session.uid = u.id;
  await db.audit('admin:' + u.email, 'login');
  res.redirect('/admin');
}));
router.post('/logout', (req, res) => { req.session = null; res.redirect('/admin/login'); });

router.use(requireAdmin);
router.use((req, res, next) => { res.locals.area = 'admin'; next(); });

/* ---------------- Dashboard ---------------- */
router.get('/', ah(async (req, res) => {
  const k = (await db.query(`SELECT
    (SELECT COUNT(*) FROM users WHERE role='student')::int AS students,
    (SELECT COUNT(*) FROM users WHERE role='student' AND is_sample)::int AS samples,
    (SELECT COUNT(*) FROM users WHERE role='student' AND prefs_locked)::int AS locked,
    (SELECT COUNT(*) FROM documents WHERE status='pending')::int AS docs_pending,
    (SELECT COUNT(*) FROM colleges)::int AS colleges,
    (SELECT COUNT(*) FROM programs)::int AS programs,
    (SELECT COALESCE(SUM(seats_open+seats_home+seats_reserved),0) FROM programs)::int AS seats,
    (SELECT COUNT(*) FROM payments)::int AS paid`)).rows[0];
  const runs = (await db.query('SELECT * FROM round_runs ORDER BY round')).rows;
  const audit = (await db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 12')).rows;
  res.render('admin/dashboard', { title: 'Dashboard', active: 'dashboard', k, runs, audit });
}));

/* ---------------- Colleges & seat matrix ---------------- */
const matrixLocked = phase => phase !== 'setup';
router.get('/colleges', ah(async (req, res) => {
  const colleges = (await db.query('SELECT * FROM colleges ORDER BY name')).rows;
  const programs = (await db.query('SELECT * FROM programs ORDER BY name')).rows;
  for (const c of colleges) c.programs = programs.filter(p => p.college_id === c.id);
  res.render('admin/colleges', { title: 'Colleges & seats', active: 'colleges', colleges, STATES, locked: matrixLocked(res.locals.phase) });
}));
router.post('/colleges', ah(async (req, res) => {
  if (matrixLocked(res.locals.phase)) { flash(req, 'warn', 'The seat matrix is frozen.'); return res.redirect('/admin/colleges'); }
  const { name, city, state, type, description } = req.body;
  if (!name || !city || !STATES.includes(state)) { flash(req, 'bad', 'Name, city and state are required.'); return res.redirect('/admin/colleges'); }
  await db.query('INSERT INTO colleges(name,city,state,type,description) VALUES($1,$2,$3,$4,$5)', [name.trim(), city.trim(), state, type === 'Private' ? 'Private' : 'Government', (description || '').trim() || null]);
  await db.audit(actor(res), 'add_college', name);
  flash(req, 'ok', `${name} added. Now add its programs.`);
  res.redirect('/admin/colleges');
}));
router.post('/colleges/:id/delete', ah(async (req, res) => {
  if (matrixLocked(res.locals.phase)) { flash(req, 'warn', 'The seat matrix is frozen.'); return res.redirect('/admin/colleges'); }
  const r = await db.query('DELETE FROM colleges WHERE id=$1 RETURNING name', [req.params.id]);
  if (r.rows[0]) await db.audit(actor(res), 'delete_college', r.rows[0].name);
  flash(req, 'ok', 'College deleted.');
  res.redirect('/admin/colleges');
}));
const seatInt = v => Math.max(0, Math.min(999, parseInt(v) || 0));
router.post('/programs', ah(async (req, res) => {
  if (matrixLocked(res.locals.phase)) { flash(req, 'warn', 'The seat matrix is frozen.'); return res.redirect('/admin/colleges'); }
  const { college_id, name } = req.body;
  if (!name || !name.trim()) { flash(req, 'bad', 'Program name is required.'); return res.redirect('/admin/colleges'); }
  try {
    await db.query('INSERT INTO programs(college_id,name,seats_open,seats_home,seats_reserved) VALUES($1,$2,$3,$4,$5)',
      [college_id, name.trim(), seatInt(req.body.seats_open), seatInt(req.body.seats_home), seatInt(req.body.seats_reserved)]);
  } catch (e) {
    if (e.code === '23505') { flash(req, 'bad', 'This college already has a program with that name.'); return res.redirect('/admin/colleges'); }
    throw e;
  }
  await db.audit(actor(res), 'add_program', name);
  flash(req, 'ok', 'Program added.');
  res.redirect('/admin/colleges#c' + college_id);
}));
router.post('/programs/:id', ah(async (req, res) => {
  if (matrixLocked(res.locals.phase)) { flash(req, 'warn', 'The seat matrix is frozen.'); return res.redirect('/admin/colleges'); }
  const r = await db.query('UPDATE programs SET seats_open=$1, seats_home=$2, seats_reserved=$3 WHERE id=$4 RETURNING name, college_id',
    [seatInt(req.body.seats_open), seatInt(req.body.seats_home), seatInt(req.body.seats_reserved), req.params.id]);
  if (r.rows[0]) await db.audit(actor(res), 'update_seats', `${r.rows[0].name}: ${seatInt(req.body.seats_open)}/${seatInt(req.body.seats_home)}/${seatInt(req.body.seats_reserved)}`);
  flash(req, 'ok', 'Seats updated.');
  res.redirect('/admin/colleges#c' + (r.rows[0] ? r.rows[0].college_id : ''));
}));
router.post('/programs/:id/delete', ah(async (req, res) => {
  if (matrixLocked(res.locals.phase)) { flash(req, 'warn', 'The seat matrix is frozen.'); return res.redirect('/admin/colleges'); }
  const r = await db.query('DELETE FROM programs WHERE id=$1 RETURNING name', [req.params.id]);
  if (r.rows[0]) await db.audit(actor(res), 'delete_program', r.rows[0].name);
  flash(req, 'ok', 'Program deleted.');
  res.redirect('/admin/colleges');
}));

/* ---------------- Applicants & document verification ---------------- */
router.get('/applicants', ah(async (req, res) => {
  const { filter = 'all', q = '' } = req.query;
  const rows = (await db.query(`
    SELECT u.*, (SELECT COUNT(*) FROM documents d WHERE d.user_id=u.id AND d.status='pending')::int AS pending,
                (SELECT COUNT(*) FROM documents d WHERE d.user_id=u.id AND d.status='verified')::int AS verified,
                (SELECT COUNT(*) FROM preferences p WHERE p.user_id=u.id)::int AS prefs
      FROM users u WHERE u.role='student'
        AND ($1='' OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%')
      ORDER BY u.is_sample, pending DESC, u.id`, [q.trim()])).rows
    .filter(u => filter === 'all' || (filter === 'pending' && u.pending > 0) || (filter === 'locked' && u.prefs_locked) || (filter === 'real' && !u.is_sample));
  res.render('admin/applicants', { title: 'Applicants', active: 'applicants', rows, filter, q });
}));
router.get('/applicants/:id', ah(async (req, res) => {
  const s = (await db.query("SELECT * FROM users WHERE id=$1 AND role='student'", [req.params.id])).rows[0];
  if (!s) return res.status(404).render('error', { title: 'Not found', message: 'No such applicant.', area: 'admin' });
  const st = await studentStatus(s);
  const prefs = (await db.query(`SELECT pr.rank, p.name AS program, c.name AS college, c.state FROM preferences pr JOIN programs p ON p.id=pr.program_id JOIN colleges c ON c.id=p.college_id WHERE pr.user_id=$1 ORDER BY pr.rank`, [s.id])).rows;
  const allots = (await db.query(`SELECT a.*, p.name AS program, c.name AS college FROM allotments a JOIN programs p ON p.id=a.program_id JOIN colleges c ON c.id=p.college_id WHERE a.user_id=$1 ORDER BY round`, [s.id])).rows;
  const decision = (await db.query('SELECT * FROM decisions WHERE user_id=$1', [s.id])).rows[0];
  const payment = (await db.query('SELECT * FROM payments WHERE user_id=$1', [s.id])).rows[0];
  res.render('admin/applicant', { title: s.name, active: 'applicants', s, st, prefs, allots, decision, payment });
}));
router.get('/documents/:id/file', ah(async (req, res) => {
  const d = (await db.query('SELECT filename, mimetype, data FROM documents WHERE id=$1', [req.params.id])).rows[0];
  if (!d || !d.data) return res.status(404).send('No file stored for this record.');
  res.setHeader('Content-Type', d.mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.filename)}"`);
  res.send(d.data);
}));
router.post('/documents/:id/review', ah(async (req, res) => {
  const status = req.body.action === 'verify' ? 'verified' : 'rejected';
  const note = (req.body.note || '').trim();
  if (status === 'rejected' && !note) { flash(req, 'bad', 'Give a reason so the student knows what to fix.'); return res.redirect(back(req, '/admin/applicants')); }
  const r = await db.query('UPDATE documents SET status=$1, note=$2, reviewed_at=now() WHERE id=$3 RETURNING user_id, doc_type', [status, status === 'rejected' ? note : null, req.params.id]);
  if (r.rows[0]) await db.audit(actor(res), 'document_' + status, `${appNo(r.rows[0].user_id)} ${r.rows[0].doc_type}${note ? ': ' + note : ''}`);
  flash(req, 'ok', `Document ${status}.`);
  res.redirect(back(req, '/admin/applicants'));
}));

/* ---------------- Counselling control ---------------- */
router.get('/counselling', ah(async (req, res) => {
  const k = (await db.query(`SELECT
    (SELECT COUNT(*) FROM users WHERE role='student' AND prefs_locked)::int AS locked,
    (SELECT COUNT(*) FROM users WHERE role='student' AND NOT prefs_locked)::int AS unlocked,
    (SELECT COUNT(*) FROM users WHERE role='student' AND is_sample)::int AS samples,
    (SELECT COALESCE(SUM(seats_open+seats_home+seats_reserved),0) FROM programs)::int AS seats`)).rows[0];
  const runs = Object.fromEntries((await db.query('SELECT * FROM round_runs')).rows.map(r => [r.round, r]));
  const dec = (await db.query(`SELECT d.decision, COUNT(*)::int AS n FROM decisions d JOIN allotments a ON a.user_id=d.user_id AND a.round=1 GROUP BY d.decision`)).rows;
  const r1seats = (await db.query('SELECT COUNT(*)::int AS n FROM allotments WHERE round=1')).rows[0].n;
  const r1paid = (await db.query('SELECT COUNT(*)::int AS n FROM allotments a JOIN payments p ON p.user_id=a.user_id WHERE a.round=1')).rows[0].n;
  res.render('admin/counselling', { title: 'Counselling rounds', active: 'counselling', k, runs, dec, r1seats, r1paid, frozenAt: await db.getSetting('frozen_at') });
}));
router.post('/counselling/freeze', ah(async (req, res) => {
  if (res.locals.phase !== 'setup') return res.redirect('/admin/counselling');
  const seats = (await db.query('SELECT COALESCE(SUM(seats_open+seats_home+seats_reserved),0)::int AS n FROM programs')).rows[0].n;
  if (!seats) { flash(req, 'bad', 'Add at least one program with seats before freezing.'); return res.redirect('/admin/counselling'); }
  await db.setSetting('phase', 'choice_filling');
  await db.setSetting('frozen_at', new Date().toISOString());
  await db.audit(actor(res), 'freeze_matrix', `${seats} seats; choice filling opened`);
  flash(req, 'ok', 'Seat matrix frozen. Choice filling is open for students.');
  res.redirect('/admin/counselling');
}));
router.post('/counselling/run/:round', ah(async (req, res) => {
  const round = Number(req.params.round);
  const phase = res.locals.phase;
  if (!((round === 1 && phase === 'choice_filling') || (round === 2 && phase === 'round1'))) {
    flash(req, 'bad', `Round ${round} cannot be run in the current phase.`); return res.redirect('/admin/counselling');
  }
  const out = await db.tx(async client => {
    const r = await runRound(client, round);
    if (round === 1) {
      // Sample applicants decide automatically so Round 2 has something to work with.
      const samples = (await client.query(`SELECT a.user_id, a.pref_rank, a.program_id FROM allotments a JOIN users u ON u.id=a.user_id WHERE a.round=1 AND u.is_sample`)).rows;
      for (const s of samples) {
        const x = Math.random();
        const d = s.pref_rank === 1 ? 'freeze' : x < 0.12 ? 'withdraw' : x < 0.4 ? 'freeze' : x < 0.55 ? 'slide' : 'float';
        await client.query('INSERT INTO decisions(user_id,decision) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET decision=EXCLUDED.decision', [s.user_id, d]);
        if (d !== 'withdraw') await client.query("INSERT INTO payments(user_id,amount,ref) VALUES($1,$2,'SAMPLE') ON CONFLICT DO NOTHING", [s.user_id, SEAT_FEE]);
      }
    }
    await db.setSetting('phase', round === 1 ? 'round1' : 'final', client);
    await db.audit(actor(res), `run_round_${round}`, `${r.allotted}/${r.participants} allotted · hash ${r.hash.slice(0, 16)}`, client);
    return r;
  });
  flash(req, 'ok', `Round ${round} published: ${out.allotted} of ${out.participants} applicants got a seat.`);
  res.redirect('/admin/results?round=' + round);
}));
router.post('/counselling/reset', ah(async (req, res) => {
  if (req.body.confirm !== 'RESET') { flash(req, 'bad', 'Type RESET to confirm.'); return res.redirect('/admin/counselling'); }
  await db.tx(async client => {
    await client.query('DELETE FROM allotments'); await client.query('DELETE FROM round_runs');
    await client.query('DELETE FROM decisions'); await client.query('DELETE FROM payments');
    await client.query("UPDATE users SET prefs_locked=FALSE, locked_at=NULL WHERE role='student' AND NOT is_sample");
    await db.setSetting('phase', 'setup', client); await db.setSetting('frozen_at', null, client);
    await db.audit(actor(res), 'reset_counselling', '', client);
  });
  flash(req, 'ok', 'Counselling reset. The seat matrix is editable again and student preferences are unlocked.');
  res.redirect('/admin/counselling');
}));
router.post('/counselling/samples', ah(async (req, res) => {
  if (!['setup', 'choice_filling'].includes(res.locals.phase)) { flash(req, 'warn', 'Add sample applicants before Round 1.'); return res.redirect('/admin/counselling'); }
  const n = Math.max(1, Math.min(300, parseInt(req.body.n) || 50));
  await createSampleApplicants(n);
  await db.audit(actor(res), 'add_sample_applicants', String(n));
  flash(req, 'ok', `${n} sample applicants added with verified documents and locked preferences.`);
  res.redirect('/admin/counselling');
}));
router.post('/counselling/samples/delete', ah(async (req, res) => {
  if (!['setup', 'choice_filling'].includes(res.locals.phase)) { flash(req, 'warn', 'Reset counselling before removing sample applicants.'); return res.redirect('/admin/counselling'); }
  const r = await db.query('DELETE FROM users WHERE is_sample'); await db.audit(actor(res), 'delete_sample_applicants', String(r.rowCount));
  flash(req, 'ok', `${r.rowCount} sample applicants removed.`);
  res.redirect('/admin/counselling');
}));

router.post('/demo', ah(async (req, res) => {
  const mode = req.body.mode === 'finished' ? 'finished' : 'live';
  if (req.body.confirm !== 'yes') { flash(req, 'bad', 'Tick the box to confirm. Loading demo data resets the counselling rounds.'); return res.redirect('/admin/counselling'); }
  await loadDemo(mode, actor(res));
  flash(req, 'ok', mode === 'finished'
    ? `Finished demo loaded: both rounds are done. Student logins: ananya${DEMO_DOMAIN} and rahul${DEMO_DOMAIN}, password ${DEMO_PASSWORD}.`
    : `Live demo loaded. Ananya's documents are waiting for you to verify. Student logins: ananya${DEMO_DOMAIN} and rahul${DEMO_DOMAIN}, password ${DEMO_PASSWORD}.`);
  res.redirect(mode === 'finished' ? '/admin/results?round=2' : '/admin/counselling');
}));

/* ---------------- Results ---------------- */
async function resultData(round) {
  const rows = (await db.query(`
    SELECT a.*, u.name, u.email, u.home_state, u.category, u.is_sample, p.name AS program, c.name AS college, c.state AS college_state
      FROM allotments a JOIN users u ON u.id=a.user_id JOIN programs p ON p.id=a.program_id JOIN colleges c ON c.id=p.college_id
     WHERE a.round=$1 ORDER BY c.name, p.name, a.quota, a.score DESC`, [round])).rows;
  const summary = (await db.query(`
    SELECT p.id, p.name AS program, c.name AS college, p.seats_open, p.seats_home, p.seats_reserved,
           MIN(a.score) FILTER (WHERE a.quota='O') AS close_o, MIN(a.score) FILTER (WHERE a.quota='H') AS close_h, MIN(a.score) FILTER (WHERE a.quota='R') AS close_r,
           COUNT(a.user_id)::int AS filled
      FROM programs p JOIN colleges c ON c.id=p.college_id LEFT JOIN allotments a ON a.program_id=p.id AND a.round=$1
     GROUP BY p.id, c.name ORDER BY c.name, p.name`, [round])).rows;
  return { rows, summary };
}
router.get('/results', ah(async (req, res) => {
  const runs = (await db.query('SELECT * FROM round_runs ORDER BY round')).rows;
  const round = Number(req.query.round) || (runs.length ? runs[runs.length - 1].round : 0);
  const data = round ? await resultData(round) : { rows: [], summary: [] };
  res.render('admin/results', { title: 'Results', active: 'results', runs, round, ...data, run: runs.find(r => r.round === round) });
}));
router.get('/results.csv', ah(async (req, res) => {
  const round = Number(req.query.round) || 1;
  const { rows } = await resultData(round);
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['application_no', 'name', 'email', 'home_state', 'category', 'score', 'college', 'program', 'quota', 'choice_no'].join(',')]
    .concat(rows.map(r => [appNo(r.user_id), r.name, r.email, r.home_state, r.category, r.score, r.college, r.program, r.quota, r.pref_rank].map(cell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hodigos-round-${round}.csv"`);
  res.send(lines.join('\n'));
}));

/* ---------------- Audit log ---------------- */
router.get('/audit', ah(async (req, res) => {
  const rows = (await db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300')).rows;
  res.render('admin/audit', { title: 'Audit log', active: 'audit', rows });
}));

module.exports = router;
