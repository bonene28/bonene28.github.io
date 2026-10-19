/* =========================================================
DAILY SPIN (3 spins per UTC day · real AMT ledger credit)
Paste this AFTER the /api/daily/claim block in server.js
Requires: requireAuth, pool, getBalance, makeReference, utcDateString
========================================================= */

const SPIN_PRIZES = [5, 10, 25, 50, 100, 250, 500, 1000];
const SPIN_MAX_PER_DAY = 3;
/* Weighted: higher weight = more common. Jackpot (1000) is rare. */
const SPIN_WEIGHTS = [28, 24, 18, 12, 8, 5, 3, 2];

function pickSpinPrize() {
  const total = SPIN_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < SPIN_WEIGHTS.length; i++) {
    r -= SPIN_WEIGHTS[i];
    if (r <= 0) return SPIN_PRIZES[i];
  }
  return SPIN_PRIZES[0];
}

function secondsUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0
    )
  );
  return Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

async function ensureDailySpinTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_spins (
      id BIGSERIAL PRIMARY KEY,
      member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      spin_day DATE NOT NULL,
      spins_used INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (member_id, spin_day)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_spins_member ON daily_spins(member_id);
  `);
}
ensureDailySpinTable().catch((err) =>
  console.error("Daily spins table init:", err.message)
);

app.get("/api/spin/status", requireAuth, async (req, res) => {
  try {
    await ensureDailySpinTable();
    const day = utcDateString();

    const row = await pool.query(
      `SELECT spins_used FROM daily_spins
       WHERE member_id = $1 AND spin_day = $2
       LIMIT 1`,
      [req.member.id, day]
    );

    const used = Number(row.rows[0]?.spins_used || 0);
    const spinsLeft = Math.max(0, SPIN_MAX_PER_DAY - used);

    res.json({
      ok: true,
      spinsLeft,
      spinsUsed: used,
      maxSpins: SPIN_MAX_PER_DAY,
      secondsUntilReset: spinsLeft <= 0 ? secondsUntilNextUtcMidnight() : 0,
      prizes: SPIN_PRIZES
    });
  } catch (e) {
    console.error("SPIN STATUS ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Unable to load spin status."
    });
  }
});

app.post("/api/spin/claim", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureDailySpinTable();
    await client.query("BEGIN");
    await client.query(
      `SELECT id FROM members WHERE id = $1 FOR UPDATE`,
      [req.member.id]
    );

    const day = utcDateString();

    const existing = await client.query(
      `SELECT spins_used FROM daily_spins
       WHERE member_id = $1 AND spin_day = $2
       LIMIT 1
       FOR UPDATE`,
      [req.member.id, day]
    );

    let used = Number(existing.rows[0]?.spins_used || 0);
    if (used >= SPIN_MAX_PER_DAY) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "No spins left today. Resets at UTC midnight.",
        spinsLeft: 0,
        maxSpins: SPIN_MAX_PER_DAY
      });
    }

    const amount = pickSpinPrize();
    const reference = makeReference("AMT-SPIN");

    if (existing.rows.length) {
      await client.query(
        `UPDATE daily_spins
         SET spins_used = spins_used + 1, updated_at = NOW()
         WHERE member_id = $1 AND spin_day = $2`,
        [req.member.id, day]
      );
    } else {
      await client.query(
        `INSERT INTO daily_spins (member_id, spin_day, spins_used)
         VALUES ($1, $2, 1)`,
        [req.member.id, day]
      );
    }

    /* Real AMT credit to application ledger */
    await client.query(
      `INSERT INTO amt_ledger (member_id, amount, type, reference)
       VALUES ($1, $2, 'DAILY_SPIN', $3)`,
      [req.member.id, amount, reference]
    );

    used += 1;
    const spinsLeft = Math.max(0, SPIN_MAX_PER_DAY - used);

    await client.query("COMMIT");

    const balance = await getBalance(req.member.id);
    const jackpot = amount >= 1000;

    res.json({
      ok: true,
      amount,
      prize: amount,
      spinsLeft,
      spinsUsed: used,
      maxSpins: SPIN_MAX_PER_DAY,
      reference,
      balance,
      message: jackpot
        ? "JACKPOT! +" + amount + " AMT"
        : "Spin +" + amount + " AMT"
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error("SPIN CLAIM ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Unable to spin. " + (e.message || "")
    });
  } finally {
    client.release();
  }
});
