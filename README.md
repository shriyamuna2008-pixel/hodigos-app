# Hodigos – Guide to College (AdmissionPrefAllot)

A centralized college admission and seat-allotment portal. Students register, upload documents, rank colleges across all states and get one seat from a single national merit list. Ties on merit go to the applicant from the college's **home state**. Counselling admins manage the seat matrix, verify documents and run the rounds.

Built with **Node.js + Express + EJS + PostgreSQL**. No front-end build step.

---

## The two portals

| Student portal (`/`) | Admin portal (`/admin`) |
|---|---|
| Register / log in | Separate admin login |
| Profile: marks, home state, category, DOB | Dashboard with next-step guidance |
| Browse colleges, seats and closing scores | Add/edit colleges, programs and seats per quota |
| Upload documents (PDF/JPG/PNG, 2 MB) | Review documents: verify or reject with a reason |
| Rank preferences, lock when choice filling opens | Freeze seat matrix → open choice filling |
| Round 1 result + Freeze / Float / Slide / Withdraw | Run Round 1 and Round 2 |
| Pay seat acceptance fee (test mode) | Results, closing scores, CSV download, SHA-256 result hash |
| Final allotment + "how my seat was decided" | Audit log of every action |

## The full process

1. **Setup** – Admin edits the seat matrix. Students register, fill their profile, upload documents and draft preferences.
2. **Admin verifies documents.** Rejected documents show the reason to the student, who re-uploads.
3. **Admin freezes the seat matrix** (SOP 1). Choice filling opens.
4. **Students lock preferences.** Only allowed when the profile is complete and every document is verified (SOP 2).
5. **Admin runs Round 1.**
6. **Students decide** – Freeze, Float, Slide or Withdraw – and pay the seat fee. No decision + fee = seat cancelled.
7. **Admin runs Round 2 (final).** Withdrawn/cancelled seats are re-offered and Float/Slide upgrades processed. Float/Slide students never lose their current seat.
8. **Results** – final list, closing scores, CSV export.

### Allotment rules (`src/allotment.js`)
- Merit score = 0.7 × entrance percentile + 0.3 × board %.
- Each program has Open, Home State and Reserved seats.
- Matching uses student-proposing deferred acceptance (Gale–Shapley), which is deterministic and fair.
- Tie-breakers, in order: home state of the college → older date of birth → earlier application.
- A conflict check (SOP 4) aborts the round if any seat would be over-filled, and every result is hashed (SHA-256) so it can be audited.

---

## Deploy on Render (free)

1. Put this folder in a **GitHub repository** (push the files; `node_modules` is ignored).
2. On [render.com](https://render.com) click **New → Blueprint** and pick the repository.
3. Render reads `render.yaml` and creates:
   - a **web service** `hodigos`
   - a **PostgreSQL database** `hodigos-db`
4. When asked, type an **ADMIN_PASSWORD** (this is the admin login password).
5. Click **Apply**. After the build finishes, open the URL Render gives you.
   - Student site: `https://<your-app>.onrender.com/`
   - Admin site: `https://<your-app>.onrender.com/admin` → log in as `admin@hodigos.in` with your password.

Tables and starter colleges are created automatically on first start.

**Manual setup instead of Blueprint:** create a PostgreSQL database on Render, then a Web Service with build command `npm install`, start command `npm start`, and environment variables `DATABASE_URL` (the database's *Internal Database URL*), `SESSION_SECRET` (any long random text), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NODE_ENV=production`.

> Free Render web services sleep after ~15 minutes idle, so the first visit can take ~30 seconds. Free Render databases expire after a limited period; upgrade or recreate if needed.

## Run locally

Requirements: Node.js 18+ and PostgreSQL.

```bash
npm install
createdb hodigos                       # or create it in pgAdmin
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/hodigos
npm start                              # http://localhost:3000
```
Default admin (local only): `admin@hodigos.in` / `admin123` unless you set `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Trying it quickly
1. Admin → **Counselling rounds** → *Add sample applicants* (e.g. 60). They come with verified documents and locked preferences so the rounds have competition.
2. Register a student, fill the profile, upload 4 documents.
3. Admin → **Applicants** → open the student → verify documents.
4. Admin → **Counselling rounds** → *Freeze & open choice filling*.
5. Student → **Preferences** → add choices → *Lock*.
6. Admin → *Run Round 1*. Student → **Seat allotment** → choose an option → pay.
7. Admin → *Run Round 2*. Check **Results** and download the CSV.
8. *Reset counselling* to run it again.

## Project structure
```
src/
  server.js        Express app, sessions, startup
  db.js            PostgreSQL pool, settings, audit helper
  schema.sql       Tables (created automatically)
  seed.js          Starter colleges, admin account, sample applicants
  allotment.js     Seat allotment engine
  constants.js     States, document types, phases, merit formula
  helpers.js       Auth guards, student checklist
  routes/student.js
  routes/admin.js
views/student/*.ejs   Student pages
views/admin/*.ejs     Admin pages
public/style.css
render.yaml           Render Blueprint
```

## Notes and limits
- Payments run in **test mode** (no money moves). Connect Razorpay/Stripe in `routes/student.js` (`/pay`) for real fees.
- Uploaded files are stored in PostgreSQL (2 MB limit each), so they survive Render restarts.
- College names in the starter data are fictional; replace them from the admin portal.
- Passwords are hashed with bcrypt; sessions are signed cookies (`SESSION_SECRET`).
