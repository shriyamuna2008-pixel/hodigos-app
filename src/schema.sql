-- Hodigos database schema (PostgreSQL). Safe to run on every start.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'student',      -- 'student' | 'admin'
  phone         TEXT,
  home_state    TEXT,
  category      TEXT NOT NULL DEFAULT 'GEN',          -- 'GEN' | 'RES'
  board_pct     DOUBLE PRECISION,
  entrance_pct  DOUBLE PRECISION,
  dob           DATE,
  prefs_locked  BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at     TIMESTAMPTZ,
  is_sample     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS colleges (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  state       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'Government',
  description TEXT
);

CREATE TABLE IF NOT EXISTS programs (
  id             SERIAL PRIMARY KEY,
  college_id     INT NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  seats_open     INT NOT NULL DEFAULT 0,
  seats_home     INT NOT NULL DEFAULT 0,
  seats_reserved INT NOT NULL DEFAULT 0,
  UNIQUE (college_id, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mimetype    TEXT,
  size        INT,
  data        BYTEA,
  status      TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'verified' | 'rejected'
  note        TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (user_id, doc_type)
);

CREATE TABLE IF NOT EXISTS preferences (
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id INT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  rank       INT NOT NULL,
  PRIMARY KEY (user_id, program_id)
);

CREATE TABLE IF NOT EXISTS allotments (
  round      INT NOT NULL,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id INT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  quota      TEXT NOT NULL,                           -- 'O' | 'H' | 'R'
  score      DOUBLE PRECISION NOT NULL,
  pref_rank  INT NOT NULL,
  PRIMARY KEY (round, user_id)
);

CREATE TABLE IF NOT EXISTS decisions (
  user_id    INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  decision   TEXT NOT NULL,                           -- 'freeze' | 'float' | 'slide' | 'withdraw'
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  amount  INT NOT NULL,
  ref     TEXT NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS round_runs (
  round        INT PRIMARY KEY,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  participants INT NOT NULL,
  allotted     INT NOT NULL,
  hash         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id     SERIAL PRIMARY KEY,
  at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
