const db = require('./db');
const { DOC_TYPES, meritScore } = require('./constants');

/** Wrap async route handlers so errors reach the error middleware. */
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function flash(req, type, msg) { req.session.flash = { type, msg }; }

function requireStudent(req, res, next) {
  if (res.locals.currentUser && res.locals.currentUser.role === 'student') return next();
  flash(req, 'warn', 'Please log in to continue.');
  res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (res.locals.currentUser && res.locals.currentUser.role === 'admin') return next();
  res.redirect('/admin/login');
}

const requiredDocs = user => DOC_TYPES.filter(d => !d.onlyRes || user.category === 'RES');

/** Everything the student dashboard / checklist needs. */
async function studentStatus(user) {
  const docs = (await db.query('SELECT id, doc_type, filename, status, note, uploaded_at FROM documents WHERE user_id=$1', [user.id])).rows;
  const byType = Object.fromEntries(docs.map(d => [d.doc_type, d]));
  const req = requiredDocs(user);
  const prefCount = (await db.query('SELECT COUNT(*)::int AS n FROM preferences WHERE user_id=$1', [user.id])).rows[0].n;
  return {
    score: meritScore(user),
    profileComplete: !!(user.name && user.home_state && user.board_pct != null && user.entrance_pct != null && user.dob),
    docs: byType,
    requiredDocs: req,
    docsUploaded: req.every(d => byType[d.key]),
    docsVerified: req.every(d => byType[d.key] && byType[d.key].status === 'verified'),
    docsRejected: req.filter(d => byType[d.key] && byType[d.key].status === 'rejected').length,
    prefCount,
  };
}

module.exports = { ah, flash, requireStudent, requireAdmin, studentStatus, requiredDocs };
