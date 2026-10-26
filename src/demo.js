/**
 * One-click demo data for presentations.
 *
 * mode "live"     – resets counselling, adds sample applicants and two demo students:
 *                   Ananya (documents waiting for review) and Rahul (fully verified).
 *                   Phase = setup, so you can show verify → freeze → lock → rounds live.
 * mode "finished" – same data, then freezes, locks, runs Round 1, records decisions
 *                   and payments, and runs Round 2. Every page has results to show.
 *
 * Demo students log in with password "demo1234".
 */
const bcrypt = require('bcryptjs');
const db = require('./db');
const { createSampleApplicants } = require('./seed');
const { runRound } = require('./allotment');
const { SEAT_FEE } = require('./constants');

const DEMO_PASSWORD = 'demo1234';
const DEMO_DOMAIN = '@demo.hodigos.in';

const STUDENTS = [
  { key: 'ananya', name: 'Ananya Rao', email: 'ananya' + DEMO_DOMAIN, phone: '9845012345', home: 'Karnataka', cat: 'GEN', board: 93.2, ent: 97.4, dob: '2007-03-12',
    prefs: [['Konkan', 'Computer'], ['Kaveri', 'Computer'], ['Yamuna', 'Computer'], ['Kaveri', 'AI'], ['Coromandel', 'Computer'], ['Kaveri', 'Electronics']] },
  { key: 'rahul', name: 'Rahul Verma', email: 'rahul' + DEMO_DOMAIN, phone: '9820098765', home: 'Maharashtra', cat: 'RES', board: 88.6, ent: 94.8, dob: '2007-08-02',
    prefs: [['Konkan', 'Computer'], ['Konkan', 'AI'], ['Deccan', 'Computer'], ['Konkan', 'Electronics'], ['Golconda', 'Computer'], ['Deccan', 'Electronics']] },
];

const DOCS = [
  ['marksheet', 'class12_marksheet.pdf', 'Class 12 Marksheet'],
  ['scorecard', 'entrance_scorecard.pdf', 'Entrance Exam Scorecard'],
  ['id_proof', 'aadhaar_card.pdf', 'Photo ID Proof'],
  ['domicile', 'domicile_certificate.pdf', 'Domicile Certificate'],
  ['category', 'category_certificate.pdf', 'Category Certificate'],
];

/** Build a small, valid one-page PDF that says what the document is. */
function samplePdf(title, name) {
  const esc = s => s.replace(/[()\\]/g, '\\$&');
  const text = `BT /F1 20 Tf 60 760 Td (${esc(title)}) Tj /F1 12 Tf 0 -30 Td (Name: ${esc(name)}) Tj 0 -18 Td (DEMO DOCUMENT - Hodigos sample data) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function findProgram(client, collegeWord, programWord) {
  const r = await client.query(
    `SELECT p.id FROM programs p JOIN colleges c ON c.id=p.college_id WHERE c.name ILIKE $1 AND p.name ILIKE $2 ORDER BY p.id LIMIT 1`,
    ['%' + collegeWord + '%', '%' + programWord + '%']);
  return r.rows[0] ? r.rows[0].id : null;
}

async function loadDemo(mode, actor) {
  // 1. Clean slate for counselling, remove old sample + demo accounts.
  await db.tx(async client => {
    for (const t of ['allotments', 'round_runs', 'decisions', 'payments']) await client.query(`DELETE FROM ${t}`);
    await client.query(`DELETE FROM users WHERE is_sample OR email LIKE $1`, ['%' + DEMO_DOMAIN]);
    await client.query("UPDATE users SET prefs_locked=FALSE, locked_at=NULL WHERE role='student'");
    await db.setSetting('phase', 'setup', client);
    await db.setSetting('frozen_at', null, client);
  });

  // 2. Competition.
  await createSampleApplicants(100);

  // 3. Demo students.
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const ids = {};
  await db.tx(async client => {
    for (const s of STUDENTS) {
      const u = await client.query(
        `INSERT INTO users(name,email,password_hash,role,phone,home_state,category,board_pct,entrance_pct,dob)
         VALUES($1,$2,$3,'student',$4,$5,$6,$7,$8,$9) RETURNING id`,
        [s.name, s.email, hash, s.phone, s.home, s.cat, s.board, s.ent, s.dob]);
      ids[s.key] = u.rows[0].id;
      const docStatus = s.key === 'rahul' || mode === 'finished' ? 'verified' : 'pending';
      for (const [type, file, title] of DOCS) {
        if (type === 'category' && s.cat !== 'RES') continue;
        const pdf = samplePdf(title, s.name);
        await client.query(
          `INSERT INTO documents(user_id,doc_type,filename,mimetype,size,data,status,reviewed_at)
           VALUES($1,$2,$3,'application/pdf',$4,$5,$6,$7)`,
          [u.rows[0].id, type, file, pdf.length, pdf, docStatus, docStatus === 'verified' ? new Date() : null]);
      }
      let rank = 0;
      for (const [c, p] of s.prefs) {
        const pid = await findProgram(client, c, p);
        if (pid) await client.query('INSERT INTO preferences(user_id,program_id,rank) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [u.rows[0].id, pid, ++rank]);
      }
    }
    await db.audit(actor, 'load_demo_data', mode === 'finished' ? 'finished demo (both rounds run)' : 'live demo (ready to present)', client);
  });

  if (mode !== 'finished') return { mode, ids };

  // 4. Finished: freeze, lock, Round 1, decisions + payments, Round 2.
  await db.tx(async client => {
    await db.setSetting('phase', 'choice_filling', client);
    await db.setSetting('frozen_at', new Date().toISOString(), client);
    await client.query('UPDATE users SET prefs_locked=TRUE, locked_at=now() WHERE id = ANY($1)', [Object.values(ids)]);
    await runRound(client, 1);

    const r1 = (await client.query(
      `SELECT a.user_id, a.pref_rank, u.is_sample FROM allotments a JOIN users u ON u.id=a.user_id WHERE a.round=1`)).rows;
    for (const a of r1) {
      let d;
      if (a.is_sample) {
        const x = Math.random();
        d = a.pref_rank === 1 ? 'freeze' : x < 0.12 ? 'withdraw' : x < 0.4 ? 'freeze' : x < 0.55 ? 'slide' : 'float';
      } else {
        d = a.pref_rank === 1 ? 'freeze' : 'float';   // demo students keep their seat and try for better
      }
      await client.query('INSERT INTO decisions(user_id,decision) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET decision=EXCLUDED.decision', [a.user_id, d]);
      if (d !== 'withdraw') {
        await client.query('INSERT INTO payments(user_id,amount,ref) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [a.user_id, SEAT_FEE, a.is_sample ? 'SAMPLE' : 'HDGPAY-DEMO' + a.user_id]);
      }
    }
    await db.setSetting('phase', 'round1', client);
    await db.audit(actor, 'run_round_1', 'demo data', client);
    await runRound(client, 2);
    await db.setSetting('phase', 'final', client);
    await db.audit(actor, 'run_round_2', 'demo data', client);
  });
  return { mode, ids };
}

module.exports = { loadDemo, DEMO_PASSWORD, DEMO_DOMAIN };
