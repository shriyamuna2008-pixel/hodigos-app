const STATES = [
  'Andhra Pradesh', 'Bihar', 'Delhi', 'Gujarat', 'Haryana', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Odisha', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'West Bengal',
];

const DOC_TYPES = [
  { key: 'marksheet', name: 'Class 12 marksheet', hint: 'Board-issued, with seal and roll number' },
  { key: 'scorecard', name: 'Entrance exam scorecard', hint: 'Shows your percentile' },
  { key: 'id_proof', name: 'Photo ID proof', hint: 'Aadhaar, passport or school ID' },
  { key: 'domicile', name: 'Domicile (home state) certificate', hint: 'Used for home-state quota and tie-breaker' },
  { key: 'category', name: 'Category / reservation certificate', hint: 'Only for reserved category', onlyRes: true },
];

const QUOTAS = { O: 'Open (All India)', H: 'Home State', R: 'Reserved' };

// Counselling phases, in order.
const PHASES = {
  setup: 'Seat matrix setup',
  choice_filling: 'Choice filling open',
  round1: 'Round 1 results · seat decisions open',
  final: 'Final allotment published',
};
const PHASE_ORDER = ['setup', 'choice_filling', 'round1', 'final'];

const SEAT_FEE = 35000;
const MAX_PREFS = 30;

/** Composite merit score: 70% entrance percentile + 30% board %, two decimals. */
function meritScore(u) {
  if (u.entrance_pct == null || u.board_pct == null) return null;
  return Math.round((0.7 * Number(u.entrance_pct) + 0.3 * Number(u.board_pct)) * 100) / 100;
}
const appNo = id => 'HDG26-' + String(id).padStart(5, '0');
const inr = n => '₹' + Number(n).toLocaleString('en-IN');

module.exports = { STATES, DOC_TYPES, QUOTAS, PHASES, PHASE_ORDER, SEAT_FEE, MAX_PREFS, meritScore, appNo, inr };
