const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { ah, flash, requireStudent, studentStatus, requiredDocs } = require('../helpers');
const { STATES, DOC_TYPES, SEAT_FEE, MAX_PREFS, meritScore, appNo } = require('../constants');
const { bucketsFor } = require('../allotment');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png'];

/* ---------------- Public pages ---------------- */
router.get('/', ah(async (req, res) => {
  if (res.locals.currentUser && res.locals.currentUser.role === 'student') return res.redirect('/dashboard');
  const stats = (await db.query(`SELECT (SELECT COUNT(*) FROM colleges)::int AS colleges, (SELECT COUNT(*) FROM programs)::int AS programs,
    (SELECT COALESCE(SUM(seats_open+seats_home+seats_reserved),0) FROM programs)::int AS seats`)).rows[0];
  res.render('student/home', { title: 'Welcome', stats });
}));

router.get('/register', (req, res) => res.render('student/register', { title: 'Create account', form: {} }));
router.post('/register', ah(async (req, res) => {
  const { name = '', email = '', password = '', confirm = '' } = req.body;
  const form = { name, email };
  const err = !name.trim() ? 'Enter your full name.'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Enter a valid email address.'
    : password.length < 8 ? 'Password must be at least 8 characters.'
    : password !== confirm ? 'The two passwords do not match.' : null;
  if (err) return res.status(400).render('student/register', { title: 'Create account', form, error: err });
  const exists = await db.query('SELECT 1 FROM users WHERE email=$1', [email.toLowerCase().trim()]);
  if (exists.rows.length) return res.status(400).render('student/register', { title: 'Create account', form, error: 'An account with this email already exists. Log in instead.' });
  const r = await db.query("INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'student') RETURNING id",
    [name.trim(), email.toLowerCase().trim(), await bcrypt.hash(password, 10)]);
  req.session.uid = r.rows[0].id;
  await db.audit(appNo(r.rows[0].id), 'register', email);
  flash(req, 'ok', `Account created. Your application number is ${appNo(r.rows[0].id)}. Start by completing your profile.`);
  res.redirect('/profile');
}));

router.get('/login', (req, res) => res.render('student/login', { title: 'Log in', email: '' }));
router.post('/login', ah(async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  const r = await db.query("SELECT * FROM users WHERE email=$1 AND role='student' AND is_sample=FALSE", [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) {
    return res.status(401).render('student/login', { title: 'Log in', email, error: 'Email or password is incorrect.' });
  }
  req.session.uid = u.id;
  res.redirect('/dashboard');
}));
router.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });

/* ---------------- Logged-in student pages ---------------- */
router.use(requireStudent);

router.get('/dashboard', ah(async (req, res) => {
  const u = res.locals.currentUser;
  const st = await studentStatus(u);
  const allot = (await db.query(
    `SELECT a.*, p.name AS program, c.name AS college FROM allotments a JOIN programs p ON p.id=a.program_id JOIN colleges c ON c.id=p.college_id
      WHERE a.user_id=$1 ORDER BY a.round DESC LIMIT 1`, [u.id])).rows[0];
  const decision = (await db.query('SELECT * FROM decisions WHERE user_id=$1', [u.id])).rows[0];
  const payment = (await db.query('SELECT * FROM payments WHERE user_id=$1', [u.id])).rows[0];
  res.render('student/dashboard', { title: 'Dashboard', active: 'dashboard', st, allot, decision, payment });
}));

/* Profile */
router.get('/profile', ah(async (req, res) => {
  res.render('student/profile', { title: 'Profile', active: 'profile', STATES });
}));
router.post('/profile', ah(async (req, res) => {
  const u = res.locals.currentUser;
  if (u.prefs_locked) { flash(req, 'warn', 'Your profile is locked because your preferences are locked.'); return res.redirect('/profile'); }
  const { name, phone, home_state, category, board_pct, entrance_pct, dob } = req.body;
  const b = parseFloat(board_pct), e = parseFloat(entrance_pct);
  const err = !name || !name.trim() ? 'Name is required.'
    : !STATES.includes(home_state) ? 'Choose your home state.'
    : !['GEN', 'RES'].includes(category) ? 'Choose a category.'
    : !(b >= 0 && b <= 100) ? 'Board percentage must be between 0 and 100.'
    : !(e >= 0 && e <= 100) ? 'Entrance percentile must be between 0 and 100.'
    : !dob || isNaN(Date.parse(dob)) ? 'Enter your date of birth.' : null;
  if (err) { flash(req, 'bad', err); return res.redirect('/profile'); }
  await db.query('UPDATE users SET name=$1, phone=$2, home_state=$3, category=$4, board_pct=$5, entrance_pct=$6, dob=$7 WHERE id=$8',
    [name.trim(), (phone || '').trim() || null, home_state, category, b, e, dob, u.id]);
  flash(req, 'ok', 'Profile saved.');
  res.redirect('/profile');
}));

/* Colleges */
router.get('/colleges', ah(async (req, res) => {
  const { q = '', state = '' } = req.query;
  const u = res.locals.currentUser;
  const rows = (await db.query(
    `SELECT c.*, p.id AS pid, p.name AS program, p.seats_open, p.seats_home, p.seats_reserved,
            (SELECT MIN(score) FROM allotments a WHERE a.program_id=p.id AND a.quota='O' AND a.round=(SELECT MAX(round) FROM round_runs)) AS close_o,
            (SELECT MIN(score) FROM allotments a WHERE a.program_id=p.id AND a.quota='H' AND a.round=(SELECT MAX(round) FROM round_runs)) AS close_h
       FROM colleges c LEFT JOIN programs p ON p.college_id=c.id
      WHERE ($1='' OR c.name ILIKE '%'||$1||'%' OR c.city ILIKE '%'||$1||'%' OR p.name ILIKE '%'||$1||'%')
        AND ($2='' OR c.state=$2)
      ORDER BY c.name, p.name`, [q.trim(), state])).rows;
  const colleges = [];
  for (const r of rows) {
    let c = colleges.find(x => x.id === r.id);
    if (!c) { c = { id: r.id, name: r.name, city: r.city, state: r.state, type: r.type, description: r.description, programs: [] }; colleges.push(c); }
    if (r.pid) c.programs.push({ id: r.pid, name: r.program, o: r.seats_open, h: r.seats_home, r: r.seats_reserved, close_o: r.close_o, close_h: r.close_h });
  }
  const mine = new Set((await db.query('SELECT program_id FROM preferences WHERE user_id=$1', [u.id])).rows.map(r => r.program_id));
  const states = (await db.query('SELECT DISTINCT state FROM colleges ORDER BY state')).rows.map(r => r.state);
  res.render('student/colleges', { title: 'Colleges', active: 'colleges', colleges, mine, q, state, states });
}));

/* Documents */
router.get('/documents', ah(async (req, res) => {
  const st = await studentStatus(res.locals.currentUser);
  res.render('student/documents', { title: 'Documents', active: 'documents', st });
}));
router.post('/documents/:type', (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) { flash(req, 'bad', err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 2 MB. Compress it and try again.' : 'Upload failed. Try again.'); return res.redirect('/documents'); }
    next();
  });
}, ah(async (req, res) => {
  const u = res.locals.currentUser;
  const type = req.params.type;
  if (!requiredDocs(u).some(d => d.key === type)) { flash(req, 'bad', 'Unknown document type.'); return res.redirect('/documents'); }
  if (u.prefs_locked) { flash(req, 'warn', 'Documents cannot be changed after preferences are locked.'); return res.redirect('/documents'); }
  const f = req.file;
  if (!f) { flash(req, 'bad', 'Choose a file to upload.'); return res.redirect('/documents'); }
  if (!ALLOWED.includes(f.mimetype)) { flash(req, 'bad', 'Only PDF, JPG or PNG files are accepted.'); return res.redirect('/documents'); }
  if (f.size < 5 * 1024) { flash(req, 'bad', 'This file is too small to be a readable scan. Upload a clearer copy (at least 5 KB).'); return res.redirect('/documents'); }
  await db.query(
    `INSERT INTO documents(user_id,doc_type,filename,mimetype,size,data,status,note,uploaded_at,reviewed_at)
     VALUES($1,$2,$3,$4,$5,$6,'pending',NULL,now(),NULL)
     ON CONFLICT(user_id,doc_type) DO UPDATE SET filename=EXCLUDED.filename, mimetype=EXCLUDED.mimetype, size=EXCLUDED.size,
       data=EXCLUDED.data, status='pending', note=NULL, uploaded_at=now(), reviewed_at=NULL`,
    [u.id, type, f.originalname.slice(0, 120), f.mimetype, f.size, f.buffer]);
  flash(req, 'ok', `${DOC_TYPES.find(d => d.key === type).name} uploaded. It will be verified by the counselling office.`);
  res.redirect('/documents');
}));
router.get('/documents/:id/file', ah(async (req, res) => {
  const r = await db.query('SELECT filename, mimetype, data FROM documents WHERE id=$1 AND user_id=$2', [req.params.id, res.locals.currentUser.id]);
  const d = r.rows[0];
  if (!d || !d.data) return res.status(404).send('Not found');
  res.setHeader('Content-Type', d.mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.filename)}"`);
  res.send(d.data);
}));

/* Preferences */
async function loadPrefs(uid) {
  return (await db.query(
    `SELECT pr.rank, p.id, p.name AS program, c.id AS college_id, c.name AS college, c.city, c.state
       FROM preferences pr JOIN programs p ON p.id=pr.program_id JOIN colleges c ON c.id=p.college_id
      WHERE pr.user_id=$1 ORDER BY pr.rank`, [uid])).rows;
}
async function renumber(client, uid) {
  await client.query(`UPDATE preferences p SET rank=s.rn FROM (SELECT program_id, ROW_NUMBER() OVER (ORDER BY rank) AS rn FROM preferences WHERE user_id=$1) s
                      WHERE p.user_id=$1 AND p.program_id=s.program_id`, [uid]);
}
const canEditPrefs = (u, phase) => !u.prefs_locked && (phase === 'setup' || phase === 'choice_filling');

router.get('/preferences', ah(async (req, res) => {
  const u = res.locals.currentUser;
  const prefs = await loadPrefs(u.id);
  const all = (await db.query(`SELECT p.id, p.name, c.name AS college, c.state FROM programs p JOIN colleges c ON c.id=p.college_id ORDER BY c.name, p.name`)).rows;
  const chosen = new Set(prefs.map(p => p.id));
  const st = await studentStatus(u);
  res.render('student/preferences', { title: 'Preferences', active: 'preferences', prefs, available: all.filter(p => !chosen.has(p.id)), st, canEdit: canEditPrefs(u, res.locals.phase) });
}));
router.post('/preferences/add', ah(async (req, res) => {
  const u = res.locals.currentUser;
  if (!canEditPrefs(u, res.locals.phase)) { flash(req, 'warn', 'Preferences cannot be changed now.'); return res.redirect(req.get('Referer') || '/preferences'); }
  const pid = parseInt(req.body.program_id);
  const n = (await db.query('SELECT COUNT(*)::int AS n FROM preferences WHERE user_id=$1', [u.id])).rows[0].n;
  if (n >= MAX_PREFS) { flash(req, 'warn', `You can list at most ${MAX_PREFS} choices.`); return res.redirect(req.get('Referer') || '/preferences'); }
  const ok = await db.query('SELECT 1 FROM programs WHERE id=$1', [pid]);
  if (!ok.rows.length) { flash(req, 'bad', 'That program no longer exists.'); return res.redirect(req.get('Referer') || '/preferences'); }
  await db.query('INSERT INTO preferences(user_id,program_id,rank) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [u.id, pid, n + 1]);
  flash(req, 'ok', `Added as choice ${n + 1}.`);
  res.redirect(req.body.back === 'colleges' ? '/colleges' : '/preferences');
}));
router.post('/preferences/:pid/move', ah(async (req, res) => {
  const u = res.locals.currentUser;
  if (!canEditPrefs(u, res.locals.phase)) return res.redirect('/preferences');
  const pid = parseInt(req.params.pid), dir = req.body.dir === 'up' ? -1 : 1;
  await db.tx(async client => {
    const cur = (await client.query('SELECT rank FROM preferences WHERE user_id=$1 AND program_id=$2', [u.id, pid])).rows[0];
    if (!cur) return;
    const other = (await client.query('SELECT program_id FROM preferences WHERE user_id=$1 AND rank=$2', [u.id, cur.rank + dir])).rows[0];
    if (!other) return;
    await client.query('UPDATE preferences SET rank=$1 WHERE user_id=$2 AND program_id=$3', [cur.rank, u.id, other.program_id]);
    await client.query('UPDATE preferences SET rank=$1 WHERE user_id=$2 AND program_id=$3', [cur.rank + dir, u.id, pid]);
  });
  res.redirect('/preferences');
}));
router.post('/preferences/:pid/remove', ah(async (req, res) => {
  const u = res.locals.currentUser;
  if (!canEditPrefs(u, res.locals.phase)) return res.redirect('/preferences');
  await db.tx(async client => {
    await client.query('DELETE FROM preferences WHERE user_id=$1 AND program_id=$2', [u.id, parseInt(req.params.pid)]);
    await renumber(client, u.id);
  });
  res.redirect(req.body.back === 'colleges' ? '/colleges' : '/preferences');
}));
router.post('/preferences/lock', ah(async (req, res) => {
  const u = res.locals.currentUser;
  const st = await studentStatus(u);
  const err = res.locals.phase !== 'choice_filling' ? 'Choice filling is not open yet. You can lock once the counselling office opens it.'
    : !st.profileComplete ? 'Complete your profile first.'
    : !st.docsVerified ? 'All your documents must be verified before you can lock (SOP 2).'
    : st.prefCount === 0 ? 'Add at least one choice.' : null;
  if (err) { flash(req, 'bad', err); return res.redirect('/preferences'); }
  await db.query('UPDATE users SET prefs_locked=TRUE, locked_at=now() WHERE id=$1', [u.id]);
  await db.audit(appNo(u.id), 'lock_preferences', `${st.prefCount} choices`);
  flash(req, 'ok', 'Preferences locked. You will see your result here when Round 1 is published.');
  res.redirect('/preferences');
}));
router.post('/preferences/unlock', ah(async (req, res) => {
  const u = res.locals.currentUser;
  if (res.locals.phase !== 'choice_filling') { flash(req, 'warn', 'Choice filling is closed.'); return res.redirect('/preferences'); }
  await db.query('UPDATE users SET prefs_locked=FALSE, locked_at=NULL WHERE id=$1', [u.id]);
  flash(req, 'ok', 'Preferences unlocked. Remember to lock them again before Round 1.');
  res.redirect('/preferences');
}));

/* Allotment */
async function seatOf(uid, round) {
  return (await db.query(
    `SELECT a.*, p.name AS program, p.college_id, c.name AS college, c.city, c.state FROM allotments a
       JOIN programs p ON p.id=a.program_id JOIN colleges c ON c.id=p.college_id WHERE a.user_id=$1 AND a.round=$2`, [uid, round])).rows[0];
}
router.get('/allotment', ah(async (req, res) => {
  const u = res.locals.currentUser, phase = res.locals.phase;
  const r1 = await seatOf(u.id, 1), r2 = await seatOf(u.id, 2);
  const runs = (await db.query('SELECT * FROM round_runs ORDER BY round')).rows;
  const latest = runs.length ? runs[runs.length - 1].round : 0;
  const decision = (await db.query('SELECT * FROM decisions WHERE user_id=$1', [u.id])).rows[0];
  const payment = (await db.query('SELECT * FROM payments WHERE user_id=$1', [u.id])).rows[0];
  const prefs = await loadPrefs(u.id);
  const seat = latest === 2 ? r2 : r1;
  let explain = [];
  if (latest && u.prefs_locked) {
    const closing = {};
    for (const r of (await db.query('SELECT program_id, quota, MIN(score) AS c, COUNT(*)::int AS n FROM allotments WHERE round=$1 GROUP BY program_id, quota', [latest])).rows) closing[r.program_id + '|' + r.quota] = r;
    const progs = Object.fromEntries((await db.query('SELECT p.*, c.state FROM programs p JOIN colleges c ON c.id=p.college_id')).rows.map(p => [p.id, p]));
    const score = meritScore(u);
    const seatRank = seat ? seat.pref_rank : Infinity;
    explain = prefs.map(p => {
      const prog = progs[p.id];
      const parts = bucketsFor(u, prog).map(b => {
        const q = b.split('|')[1], cap = q === 'O' ? prog.seats_open : q === 'H' ? prog.seats_home : prog.seats_reserved, cl = closing[b];
        return { q, cap, close: cl ? cl.c : null, full: cl && cl.n >= cap };
      });
      let verdict, cls = '';
      if (p.rank === seatRank) { verdict = 'Allotted'; cls = 'ok'; }
      else if (p.rank > seatRank) verdict = 'Not needed (higher choice allotted)';
      else if (parts.some(x => x.close === score)) { verdict = 'Tie on score; lost on home-state / date-of-birth tie-breaker'; cls = 'warn'; }
      else { verdict = 'Closing score above yours'; cls = 'bad'; }
      return { ...p, parts, verdict, cls };
    });
  }
  let canFloat = false, canSlide = false;
  if (r1) { canFloat = r1.pref_rank > 1; canSlide = prefs.some(p => p.rank < r1.pref_rank && p.college_id === r1.college_id); }
  res.render('student/allotment', { title: 'Seat allotment', active: 'allotment', r1, r2, seat, latest, decision, payment, explain, canFloat, canSlide, score: meritScore(u) });
}));
router.post('/allotment/decision', ah(async (req, res) => {
  const u = res.locals.currentUser;
  if (res.locals.phase !== 'round1') { flash(req, 'warn', 'Seat decisions are closed.'); return res.redirect('/allotment'); }
  const r1 = await seatOf(u.id, 1);
  if (!r1) { flash(req, 'warn', 'You have no Round 1 seat to decide on.'); return res.redirect('/allotment'); }
  const d = req.body.decision;
  if (!['freeze', 'float', 'slide', 'withdraw'].includes(d)) { flash(req, 'bad', 'Choose an option.'); return res.redirect('/allotment'); }
  if (d === 'withdraw' && req.body.confirm !== 'yes') { flash(req, 'bad', 'Tick the confirmation box to withdraw.'); return res.redirect('/allotment'); }
  await db.query('INSERT INTO decisions(user_id,decision) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET decision=EXCLUDED.decision, decided_at=now()', [u.id, d]);
  await db.audit(appNo(u.id), 'seat_decision', d);
  const paid = (await db.query('SELECT 1 FROM payments WHERE user_id=$1', [u.id])).rows.length;
  if (d !== 'withdraw' && !paid) { flash(req, 'warn', `${d[0].toUpperCase() + d.slice(1)} recorded. Pay the seat acceptance fee to confirm it.`); return res.redirect('/pay'); }
  flash(req, 'ok', d === 'withdraw' ? 'You have withdrawn. Your seat will be offered to others in Round 2.' : `Decision updated to ${d}.`);
  res.redirect('/allotment');
}));

/* Seat acceptance fee (test-mode gateway; replace with Razorpay/Stripe for real money) */
async function payable(u, phase) {
  if (phase === 'round1') { const s = await seatOf(u.id, 1); const d = (await db.query('SELECT decision FROM decisions WHERE user_id=$1', [u.id])).rows[0]; return s && (!d || d.decision !== 'withdraw') ? s : null; }
  if (phase === 'final') return seatOf(u.id, 2);
  return null;
}
router.get('/pay', ah(async (req, res) => {
  const u = res.locals.currentUser;
  const payment = (await db.query('SELECT * FROM payments WHERE user_id=$1', [u.id])).rows[0];
  if (payment) { flash(req, 'ok', 'Your fee is already paid.'); return res.redirect('/allotment'); }
  const seat = await payable(u, res.locals.phase);
  if (!seat) { flash(req, 'warn', 'There is no seat to pay for right now.'); return res.redirect('/allotment'); }
  res.render('student/pay', { title: 'Pay seat acceptance fee', active: 'allotment', seat, fee: SEAT_FEE });
}));
router.post('/pay', ah(async (req, res) => {
  const u = res.locals.currentUser;
  const seat = await payable(u, res.locals.phase);
  if (!seat) { flash(req, 'warn', 'There is no seat to pay for right now.'); return res.redirect('/allotment'); }
  const ref = 'HDGPAY-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  await db.query('INSERT INTO payments(user_id,amount,ref) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING', [u.id, SEAT_FEE, ref]);
  if (res.locals.phase === 'round1') {
    // Paying without choosing keeps the seat: Float if a higher choice exists, otherwise Freeze.
    await db.query('INSERT INTO decisions(user_id,decision) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING', [u.id, seat.pref_rank > 1 ? 'float' : 'freeze']);
  }
  await db.audit(appNo(u.id), 'payment', ref);
  flash(req, 'ok', `Payment received. Reference ${ref}.`);
  res.redirect('/allotment');
}));

module.exports = router;
