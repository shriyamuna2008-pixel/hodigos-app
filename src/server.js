const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./db');
const { seed } = require('./seed');
const C = require('./constants');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1); // Render sits behind a proxy

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({
  name: 'hodigos',
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  maxAge: 8 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: isProd,
}));

// Load the logged-in user, current phase and one-time flash message for every page.
app.use(async (req, res, next) => {
  try {
    res.locals.C = C;
    res.locals.path = req.path;
    res.locals.flash = req.session.flash || null;
    req.session.flash = null;
    res.locals.phase = (await db.getSetting('phase', 'setup')) || 'setup';
    res.locals.currentUser = null;
    if (req.session.uid) {
      const r = await db.query('SELECT * FROM users WHERE id=$1', [req.session.uid]);
      res.locals.currentUser = r.rows[0] || null;
      if (!r.rows[0]) req.session.uid = null;
    }
    next();
  } catch (e) { next(e); }
});

app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/student'));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.', area: req.path.startsWith('/admin') ? 'admin' : 'student' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: isProd ? 'The server hit an error. Try again, and contact the counselling office if it keeps happening.' : err.message, area: req.path.startsWith('/admin') ? 'admin' : 'student' });
});

(async () => {
  try {
    await db.init();
    await seed();
    app.listen(PORT, () => console.log(`Hodigos running on http://localhost:${PORT}  (admin: /admin)`));
  } catch (e) {
    console.error('Could not start. Is DATABASE_URL set and the database reachable?\n', e.message);
    process.exit(1);
  }
})();
