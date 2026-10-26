const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');
const { STATES } = require('./constants');

// Starter seat matrix. Names are fictional; edit or replace them from the admin portal.
const COLLEGES = [
  ['Konkan Institute of Technology', 'Mumbai', 'Maharashtra', 'Government'],
  ['Yamuna Institute of Technology', 'New Delhi', 'Delhi', 'Government'],
  ['Kaveri Institute of Technology', 'Bengaluru', 'Karnataka', 'Government'],
  ['Coromandel Institute of Technology', 'Chennai', 'Tamil Nadu', 'Government'],
  ['Golconda Institute of Technology', 'Hyderabad', 'Telangana', 'Government'],
  ['Hooghly Institute of Technology', 'Kolkata', 'West Bengal', 'Government'],
  ['Deccan College of Engineering', 'Pune', 'Maharashtra', 'Private'],
  ['Aravalli Institute of Technology', 'Jaipur', 'Rajasthan', 'Government'],
];
const PROGRAMS = [
  ['Computer Science & Engineering', 3, 2, 1],
  ['Electronics & Communication', 2, 2, 1],
  ['Mechanical Engineering', 2, 1, 1],
];

async function seed() {
  const c = await db.query('SELECT COUNT(*)::int AS n FROM colleges');
  if (c.rows[0].n === 0) {
    for (const [i, [name, city, state, type]] of COLLEGES.entries()) {
      const r = await db.query('INSERT INTO colleges(name,city,state,type) VALUES($1,$2,$3,$4) RETURNING id', [name, city, state, type]);
      const progs = i < 3 ? [...PROGRAMS, ['AI & Data Science', 2, 1, 1]] : PROGRAMS;
      for (const [pn, o, h, rs] of progs) {
        await db.query('INSERT INTO programs(college_id,name,seats_open,seats_home,seats_reserved) VALUES($1,$2,$3,$4,$5)', [r.rows[0].id, pn, o, h, rs]);
      }
    }
    console.log('Seeded starter colleges and programs.');
  }
  if (!(await db.getSetting('phase'))) await db.setSetting('phase', 'setup');

  const email = (process.env.ADMIN_EMAIL || 'admin@hodigos.in').toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || 'admin123';
  const a = await db.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!a.rows.length) {
    await db.query("INSERT INTO users(name,email,password_hash,role) VALUES('Counselling Admin',$1,$2,'admin')", [email, bcrypt.hashSync(pass, 10)]);
    console.log(`Created admin account ${email}${process.env.ADMIN_PASSWORD ? '' : ' (default password admin123 – set ADMIN_PASSWORD in production)'}`);
  }
}

/** Create N sample applicants with verified documents and locked preferences (for testing competition). */
async function createSampleApplicants(n) {
  const progs = (await db.query('SELECT p.id, p.name, p.college_id, c.state FROM programs p JOIN colleges c ON c.id=p.college_id ORDER BY p.college_id, p.id')).rows;
  if (!progs.length) return 0;
  const collegeIds = [...new Set(progs.map(p => p.college_id))];
  const states = [...new Set(progs.map(p => p.state))];
  const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 8); // nobody can log in as a sample
  const rnd = Math.random;
  const pop = name => /computer/i.test(name) ? 3 : /ai|data/i.test(name) ? 2.5 : /electronic/i.test(name) ? 2 : 1;
  const tag = Date.now().toString(36);
  await db.tx(async client => {
    for (let i = 0; i < n; i++) {
      const home = rnd() < 0.8 ? states[Math.floor(rnd() * states.length)] : STATES[Math.floor(rnd() * STATES.length)];
      const cat = rnd() < 0.25 ? 'RES' : 'GEN';
      const ent = Math.round((100 - Math.abs((rnd() + rnd() + rnd() - 1.5) * 26)) * 100) / 100;
      const board = Math.round((60 + rnd() * 39) * 10) / 10;
      const dob = new Date(2007, Math.floor(rnd() * 24), 1 + Math.floor(rnd() * 28));
      const u = await client.query(
        `INSERT INTO users(name,email,password_hash,role,home_state,category,board_pct,entrance_pct,dob,prefs_locked,locked_at,is_sample)
         VALUES($1,$2,$3,'student',$4,$5,$6,$7,$8,TRUE,now(),TRUE) RETURNING id`,
        [`Sample applicant ${i + 1}`, `sample-${tag}-${i + 1}@sample.hodigos`, hash, home, cat, board, Math.min(100, ent), dob]);
      const uid = u.rows[0].id;
      for (const t of ['marksheet', 'scorecard', 'id_proof', 'domicile'].concat(cat === 'RES' ? ['category'] : [])) {
        await client.query("INSERT INTO documents(user_id,doc_type,filename,status,reviewed_at) VALUES($1,$2,'sample-record','verified',now())", [uid, t]);
      }
      // weighted preference list: earlier colleges and CS/AI are more popular, home state preferred
      const scored = progs.map(p => ({ id: p.id, w: pop(p.name) / Math.pow(collegeIds.indexOf(p.college_id) + 1, 0.7) * (p.state === home ? 1.6 : 1) * (0.6 + rnd() * 0.8) }));
      scored.sort((a, b) => b.w - a.w);
      const k = 4 + Math.floor(rnd() * 6);
      for (const [r, p] of scored.slice(0, k).entries()) {
        await client.query('INSERT INTO preferences(user_id,program_id,rank) VALUES($1,$2,$3)', [uid, p.id, r + 1]);
      }
    }
  });
  return n;
}

module.exports = { seed, createSampleApplicants };
