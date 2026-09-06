// ============================================================
// AMT API COMPATIBILITY ROUTES — v2.1.2
// Staking removed.
// Existing Pioneer accounts, balances, wallets and ledger intact.
// ============================================================


// ------------------------------------------------------------
// POST /api/users
// Frontend compatibility for Pi Login.
//
// IMPORTANT:
// - Pi UID remains the permanent account key.
// - Existing member is reused.
// - Existing AMT wallet is preserved.
// - If the miner has no wallet, one is created automatically.
// - No staking is used.
// ------------------------------------------------------------
app.post("/api/users", requireAuth, async (req, res, next) => {
  try {
    const member = await getAuthenticatedMember(req.piAccessToken);

    // Automatically create AMT wallet if the miner does not have one.
    // Existing wallet is preserved.
    const wallet = await ensureAmtWallet(member.id);

    const balanceResult = await pool.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS balance
      FROM amt_ledger
      WHERE member_id = $1
      `,
      [member.id]
    );

    res.json({
      ok: true,

      user: {
        id: member.id,
        pi_uid: member.pi_uid,
        username: member.username,
        kyc_status: member.kyc_status
      },

      wallet: {
        address: wallet.wallet_address,
        status: wallet.wallet_status
      },

      balance: Number(balanceResult.rows[0].balance || 0)
    });

  } catch (err) {
    next(err);
  }
});


// ------------------------------------------------------------
// GET /api/balance
// ------------------------------------------------------------
app.get("/api/balance", requireAuth, async (req, res, next) => {
  try {
    const member = await getAuthenticatedMember(req.piAccessToken);

    // Make sure every authenticated miner has an AMT wallet.
    const wallet = await ensureAmtWallet(member.id);

    const result = await pool.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS balance
      FROM amt_ledger
      WHERE member_id = $1
      `,
      [member.id]
    );

    res.json({
      ok: true,
      balance: Number(result.rows[0].balance || 0),
      wallet_address: wallet.wallet_address,
      wallet_status: wallet.wallet_status
    });

  } catch (err) {
    next(err);
  }
});


// ------------------------------------------------------------
// POST /api/ledger/send
// Compatibility alias for AMT transfer.
// ------------------------------------------------------------
app.post("/api/ledger/send", requireAuth, async (req, res, next) => {
  const client = await pool.connect();

  try {
    const member = await getAuthenticatedMember(req.piAccessToken);

    const recipientAddress = String(
      req.body?.recipient_address ||
      req.body?.recipientWallet ||
      req.body?.wallet_address ||
      ""
    ).trim();

    const amount = Number(req.body?.amount);

    if (!recipientAddress) {
      throw new HttpError(
        400,
        "Recipient wallet address is required."
      );
    }

    if (!validAmount(amount)) {
      throw new HttpError(
        400,
        "Invalid AMT amount."
      );
    }

    if (amount <= 0) {
      throw new HttpError(
        400,
        "Amount must be greater than zero."
      );
    }

    await client.query("BEGIN");

    const senderResult = await client.query(
      `
      SELECT id
      FROM members
      WHERE id = $1
      FOR UPDATE
      `,
      [member.id]
    );

    if (!senderResult.rowCount) {
      throw new HttpError(
        404,
        "Member account not found."
      );
    }

    const recipientResult = await client.query(
      `
      SELECT member_id, wallet_address
      FROM amt_wallets
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1
      `,
      [recipientAddress]
    );

    if (!recipientResult.rowCount) {
      throw new HttpError(
        404,
        "Recipient AMT wallet not found."
      );
    }

    const recipientId =
      recipientResult.rows[0].member_id;

    if (Number(recipientId) === Number(member.id)) {
      throw new HttpError(
        400,
        "You cannot send AMT to your own wallet."
      );
    }

    const balanceResult = await client.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS balance
      FROM amt_ledger
      WHERE member_id = $1
      `,
      [member.id]
    );

    const balance =
      Number(balanceResult.rows[0].balance || 0);

    if (balance < amount) {
      throw new HttpError(
        400,
        "Insufficient AMT balance."
      );
    }

    const reference = makeReference("AMT");

    await client.query(
      `
      INSERT INTO amt_transfers
      (
        sender_member_id,
        recipient_member_id,
        amount,
        reference,
        status
      )
      VALUES ($1, $2, $3, $4, 'COMPLETED')
      `,
      [
        member.id,
        recipientId,
        amount,
        reference
      ]
    );

    await client.query(
      `
      INSERT INTO amt_ledger
      (
        member_id,
        amount,
        type,
        reference
      )
      VALUES
      ($1, $2, 'SEND', $3),
      ($4, $5, 'RECEIVE', $3)
      `,
      [
        member.id,
        -amount,
        reference,
        recipientId,
        amount
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "AMT transfer completed.",
      reference,
      amount,
      recipient_address: recipientAddress
    });

  } catch (err) {

    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    next(err);

  } finally {
    client.release();
  }
});


// ------------------------------------------------------------
// GET /api/referrals
// ------------------------------------------------------------
app.get("/api/referrals", requireAuth, async (req, res, next) => {
  try {
    const member =
      await getAuthenticatedMember(req.piAccessToken);

    const result = await pool.query(
      `
      SELECT
        r.id,
        r.referrer_member_id,
        r.referred_member_id,
        r.created_at,
        m.username
      FROM referrals r
      LEFT JOIN members m
        ON m.id = r.referred_member_id
      WHERE r.referrer_member_id = $1
      ORDER BY r.created_at DESC
      `,
      [member.id]
    );

    res.json({
      ok: true,
      referrals: result.rows,
      count: result.rowCount
    });

  } catch (err) {
    next(err);
  }
});


// ------------------------------------------------------------
// GET /api/security-circle
// ------------------------------------------------------------
app.get("/api/security-circle", requireAuth, async (req, res, next) => {
  try {
    const member =
      await getAuthenticatedMember(req.piAccessToken);

    const result = await pool.query(
      `
      SELECT
        sc.id,
        sc.member_id,
        sc.contact_member_id,
        sc.created_at,
        m.username
      FROM security_circle sc
      LEFT JOIN members m
        ON m.id = sc.contact_member_id
      WHERE sc.member_id = $1
      ORDER BY sc.created_at ASC
      `,
      [member.id]
    );

    res.json({
      ok: true,
      members: result.rows,
      count: result.rowCount,
      max: MAX_SECURITY_CIRCLE
    });

  } catch (err) {
    next(err);
  }
});


// ------------------------------------------------------------
// POST /api/profile/image
// ------------------------------------------------------------
app.post("/api/profile/image", requireAuth, async (req, res, next) => {
  try {
    const member =
      await getAuthenticatedMember(req.piAccessToken);

    const image =
      req.body?.image ||
      req.body?.image_url ||
      req.body?.profile_image ||
      "";

    if (!image) {
      throw new HttpError(
        400,
        "Profile image is required."
      );
    }

    await pool.query(
      `
      UPDATE members
      SET profile_image = $1,
          updated_at = NOW()
      WHERE id = $2
      `,
      [
        String(image),
        member.id
      ]
    );

    res.json({
      ok: true,
      message: "Profile image updated.",
      profile_image: String(image)
    });

  } catch (err) {
    next(err);
  }
});


// ------------------------------------------------------------
// DELETE /api/profile/image
// ------------------------------------------------------------
app.delete("/api/profile/image", requireAuth, async (req, res, next) => {
  try {
    const member =
      await getAuthenticatedMember(req.piAccessToken);

    await pool.query(
      `
      UPDATE members
      SET profile_image = NULL,
          updated_at = NOW()
      WHERE id = $1
      `,
      [member.id]
    );

    res.json({
      ok: true,
      message: "Profile image removed."
    });

  } catch (err) {
    next(err);
  }
});


// ============================================================
// END AMT API COMPATIBILITY ROUTES — v2.1.2
// STAKING REMOVED FROM THIS COMPATIBILITY LAYER
// ============================================================