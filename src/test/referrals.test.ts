import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const siteHtml = readFileSync("public/technotrade.html", "utf8");
const siteScript = siteHtml.split("<script>")[1]?.split("// ---------- boot ----------")[0];
const adminHtml = readFileSync("public/admin.html", "utf8");
const adminScript = adminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const resetHtml = readFileSync("public/reset-password.html", "utf8");

type Row = any;

// In-memory Supabase mock: tables behave like the real ones for the
// queries the referral/wallet code makes (select/eq/order/limit,
// maybeSingle, insert with unique checks, update with a pending guard).
function makeDb(): any {
  return {
    referral_codes: [] as Row[],
    referrals: [] as Row[],
    wallet_transactions: [] as Row[],
    // Test-only instrumentation: __failSelect forces select/insert/then
    // errors for the named tables; __selects counts select() calls per
    // table (used to prove the Refer view stops re-loading its code).
    __selects: {} as Record<string, number>,
    __failSelect: null as Set<string> | null,
  };
}

class Query {
  private filters: [string, any][] = [];
  private patch: Row | null = null;
  private limitN: number | null = null;
  constructor(private db: Record<string, Row[]>, private table: string) {}
  private shouldFail() { return !!(this.db as any).__failSelect?.has(this.table); }
  select() {
    (this.db as any).__selects[this.table] = (((this.db as any).__selects[this.table] ?? 0) + 1);
    return this;
  }
  eq(col: string, val: any) { this.filters.push([col, val]); return this; }
  order() { return this; }
  limit(n: number) { this.limitN = n; return this; }
  private rows() { return this.db[this.table] ?? []; }
  private filtered() {
    let rows = this.rows().filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows;
  }
  async maybeSingle() {
    if (this.shouldFail()) return { data: null, error: { message: "denied" } };
    const rows = this.filtered();
    return { data: rows[0] ?? null, error: null };
  }
  async insert(row: Row) {
    if (this.shouldFail()) return { data: null, error: { message: "denied" } };
    if (this.table === "referral_codes" && this.rows().some((r) => r.code === row.code || r.user_id === row.user_id)) {
      return { data: null, error: { message: "duplicate key" } };
    }
    if (this.table === "referrals" && this.rows().some((r) => r.referred_id === row.referred_id)) {
      return { data: null, error: { message: "duplicate key" } };
    }
    if (
      this.table === "wallet_transactions" &&
      row.kind === "referral_credit" &&
      row.referral_id &&
      this.rows().some((r) => r.kind === "referral_credit" && r.referral_id === row.referral_id)
    ) {
      return { data: null, error: { message: "duplicate key" } };
    }
    const saved = { id: `id-${this.rows().length + 1}`, created_at: new Date().toISOString(), ...row };
    this.rows().push(saved);
    return { data: [saved], error: null };
  }
  update(patch: Row) { this.patch = patch; return this; }
  then(resolve: any, reject: any) {
    try {
      if (this.shouldFail()) {
        return Promise.resolve({ data: null, error: { message: "denied" } }).then(resolve, reject);
      }
      if (this.patch) {
        const matched = this.rows().filter((r) => this.filters.every(([c, v]) => r[c] === v));
        matched.forEach((r) => Object.assign(r, this.patch));
        return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: this.filtered(), error: null }).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).then(resolve, reject);
    }
  }
}

function makeSiteClient(db: any) {
  const channel: any = {};
  channel.on = vi.fn(() => channel);
  channel.subscribe = vi.fn(() => channel);
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      getSession: vi.fn(async (): Promise<any> => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
      signInWithOAuth: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn((table: string) => new Query(db, table)),
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return client;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

describe("Referrals & wallet — logo served from R2", () => {
  const R2_LOGO = "https://drive.google.com/thumbnail?id=1Ls9hChLg7Cxry-v9ClJGWLjJ-rNu8Cvz&sz=w1000";
  it("all logo references point at the R2 public URL", () => {
    expect(siteHtml).toContain(R2_LOGO);
    expect(siteHtml).not.toContain("/technotrade-logo.png?v=1");
    expect(siteHtml).not.toContain('src="/technotrade-logo.png"');
    expect(adminHtml).toContain(R2_LOGO);
    expect(adminHtml).not.toContain("/technotrade-logo.png?v=1");
    expect(adminHtml).not.toContain('src="/technotrade-logo.png"');
    expect(resetHtml).toContain(R2_LOGO);
    expect(resetHtml).not.toContain("/technotrade-logo.png?v=1");
    expect(resetHtml).not.toContain('src="/technotrade-logo.png"');
  });
});

describe("Referrals & wallet — learner website", () => {
  let run: (code: string) => unknown;
  let db: any;

  beforeEach(() => {
    document.body.innerHTML = siteHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    db = makeDb();
    const client = makeSiteClient(db);
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!siteScript) throw new Error("Learner script missing");
    run = new Function(`${siteScript}\nreturn code => eval(code);`)();
    run("currentUser = {uid:'u1',id:'u1',displayName:'Learner',email:'learner@example.com'}; isAdmin = false; courses=[]; coursesLoaded=false; subscription=null; supportMessages=null; myReferralCode=null; myReferralCodeLoaded=false; myReferrals=null; walletTxns=null;");
    localStorage.clear();
    sessionStorage.clear();
    location.hash = "#/home";
  });

  it("generates 8-char uppercase referral codes", () => {
    const a = run("generateReferralCode()") as string;
    const b = run("generateReferralCode()") as string;
    expect(a).toMatch(/^[A-Z0-9]{8}$/);
    expect(b).toMatch(/^[A-Z0-9]{8}$/);
    expect(a).not.toBe(b);
  });

  it("parses ?ref= from the URL and rejects junk", () => {
    expect(run("parseReferralCodeFromUrl('?ref=abc123')")).toBe("ABC123");
    expect(run("parseReferralCodeFromUrl('?ref=ABC12345&x=1')")).toBe("ABC12345");
    expect(run("parseReferralCodeFromUrl('')")).toBe("");
    expect(run("parseReferralCodeFromUrl('?foo=bar')")).toBe("");
    expect(run("parseReferralCodeFromUrl('?ref=ab')")).toBe("");
    expect(run("parseReferralCodeFromUrl('?ref=ABC-123')")).toBe("");
  });

  it("builds the referral link with the code", () => {
    expect(run("referralLink('ABC12345')")).toBe(
      "https://technoacademy.online/technotrade.html?ref=ABC12345",
    );
  });

  it("rewards ₹150 for Monthly and ₹500 for Yearly", () => {
    expect(run("referralRewardForPlan('monthly')")).toBe(15000);
    expect(run("referralRewardForPlan('yearly')")).toBe(50000);
    expect(run("referralRewardForPlan('bogus')")).toBe(15000);
  });

  it("validates UPI IDs", () => {
    expect(run("isValidUpiId('rupu@okhdfcbank')")).toBe(true);
    expect(run("isValidUpiId('name.surname@paytm')")).toBe(true);
    expect(run("isValidUpiId('noatsign')")).toBe(false);
    expect(run("isValidUpiId('a@b')")).toBe(false);
    expect(run("isValidUpiId('')")).toBe(false);
    expect(run("isValidUpiId('name@')")).toBe(false);
  });

  it("computes the balance with requested withdrawals reserved and rejected ignored", () => {
    const balance = run(`walletBalancePaise([
      {kind:'referral_credit', amountPaise:5000, status:'completed'},
      {kind:'referral_credit', amountPaise:10000, status:'completed'},
      {kind:'withdrawal', amountPaise:-10000, status:'requested'},
      {kind:'withdrawal', amountPaise:-5000, status:'paid'},
      {kind:'withdrawal', amountPaise:-20000, status:'rejected'},
    ])`);
    expect(balance).toBe(0);
    expect(run(`walletTotalEarnedPaise([
      {kind:'referral_credit', amountPaise:5000, status:'completed'},
      {kind:'referral_credit', amountPaise:10000, status:'completed'},
      {kind:'withdrawal', amountPaise:-10000, status:'requested'},
    ])`)).toBe(15000);
  });

  it("signup form has the referral code field in signup mode", () => {
    const html = run("renderLogin()") as string;
    expect(html).toContain('id="authRefCode"');
    expect(html).toContain('id="signupRefBox"');
    expect(html).toContain("Referral code (optional)");
    // Referral code field is LAST in the signup form: Name -> Email -> Password -> Referral code -> Create account.
    const refIdx = html.indexOf('id="signupRefBox"');
    expect(refIdx).toBeGreaterThan(html.indexOf('id="authPassword"'));
    expect(refIdx).toBeLessThan(html.indexOf('id="emailBtn"'));
    expect(siteScript).toContain("prefillReferralCode");
    expect(siteScript).toContain('sessionStorage.getItem("tt_ref_code")');
  });

  it("profile links Refer & Earn and Wallet, and the router serves both", () => {
    const html = run("renderProfile()") as string;
    expect(html).toContain("Refer & Earn");
    expect(html).toContain("Wallet");
    expect(siteScript).toContain('r.name === "refer"');
    expect(siteScript).toContain("renderRefer()");
    expect(siteScript).toContain('r.name === "wallet"');
    expect(siteScript).toContain("renderWallet()");
  });

  it("rejects attribution for an unknown code", async () => {
    const ok = await run("maybeAttributeReferral('NOPE1234')");
    expect(ok).toBe(false);
    expect(db.referrals).toHaveLength(0);
  });

  it("blocks self-referral", async () => {
    db.referral_codes.push({ user_id: "u1", code: "SELFCODE" });
    const ok = await run("maybeAttributeReferral('SELFCODE')");
    expect(ok).toBe(false);
    expect(db.referrals).toHaveLength(0);
  });

  it("attributes a valid code once, and only once", async () => {
    db.referral_codes.push({ user_id: "ref1", code: "ABC12345" });
    expect(await run("maybeAttributeReferral('abc12345')")).toBe(true);
    expect(db.referrals).toHaveLength(1);
    expect(db.referrals[0]).toMatchObject({
      code: "ABC12345",
      referrer_id: "ref1",
      referred_id: "u1",
      status: "pending",
    });
    expect(await run("maybeAttributeReferral('ABC12345')")).toBe(false);
    expect(db.referrals).toHaveLength(1);
  });

  it("rewards the referrer once on first purchase — ₹150 Monthly, ₹500 Yearly", async () => {
    db.referrals.push({
      id: "r1", code: "ABC12345", referrer_id: "ref1", referred_id: "u1",
      status: "pending", created_at: new Date().toISOString(),
    });
    await run("maybeRewardReferral('u1', 'monthly')");
    expect(db.referrals[0].status).toBe("rewarded");
    expect(db.referrals[0].reward_amount_paise).toBe(15000);
    expect(db.wallet_transactions).toHaveLength(1);
    expect(db.wallet_transactions[0]).toMatchObject({
      user_id: "ref1", referral_id: "r1", kind: "referral_credit",
      amount_paise: 15000, status: "completed",
    });
    // Second call (e.g. checkout success + manual verify) must not double-pay.
    await run("maybeRewardReferral('u1', 'yearly')");
    expect(db.wallet_transactions).toHaveLength(1);
    expect(db.referrals[0].reward_amount_paise).toBe(15000);
  });

  it("rewards ₹500 for a Yearly first purchase", async () => {
    db.referrals.push({
      id: "r1", code: "ABC12345", referrer_id: "ref1", referred_id: "u1",
      status: "pending", created_at: new Date().toISOString(),
    });
    await run("maybeRewardReferral('u1', 'yearly')");
    expect(db.referrals[0].reward_amount_paise).toBe(50000);
    expect(db.wallet_transactions[0].amount_paise).toBe(50000);
  });

  it("does nothing when there is no pending referral", async () => {
    await run("maybeRewardReferral('u1', 'monthly')");
    expect(db.wallet_transactions).toHaveLength(0);
  });

  it("hooks the reward into subscription activation", () => {
    expect(siteScript).toContain("maybeRewardReferral(record.userId, record.planId)");
  });

  it("Refer & Earn shows the code, link and copy buttons", async () => {
    run("myReferralCode = 'ABC12345'; myReferrals = [{id:'r1', code:'ABC12345', referrerId:'ref1', referredId:'u1', status:'rewarded', rewardPaise:15000, createdAtMs:1000}];");
    const html = run("renderRefer()") as string;
    expect(html).toContain("ABC12345");
    expect(html).toContain("https://technoacademy.online/technotrade.html?ref=ABC12345");
    expect(html).toContain('id="copyRefLinkBtn"');
    expect(html).toContain('id="copyRefCodeBtn"');
    expect(html).toContain("₹150");
    expect(html).toContain("₹500");
  });

  it("Refer & Earn always shows the copy buttons, disabled until the code loads", () => {
    run("myReferralCode = null; myReferrals = [];");
    const html = run("renderRefer()") as string;
    expect(html).toContain('id="copyRefLinkBtn"');
    expect(html).toContain('id="copyRefCodeBtn"');
    expect(html).toContain("Generating your link");
    expect(html).toContain("disabled");
    expect(siteScript).toContain('toast("Copied!")');
  });

  it("generates and saves a code lazily on first Refer open", async () => {
    expect(await run("ensureReferralCode()")).toMatch(/^[A-Z0-9]{8}$/);
    expect(db.referral_codes).toHaveLength(1);
    expect(db.referral_codes[0].user_id).toBe("u1");
    // Second call reuses the saved code, no duplicate row.
    const again = await run("ensureReferralCode()");
    expect(again).toBe(db.referral_codes[0].code);
    expect(db.referral_codes).toHaveLength(1);
  });

  it("Profile header shows the wallet balance instead of the name", () => {
    run(`walletTxns = [{id:'t1', userId:'u1', kind:'referral_credit', amountPaise:15000, status:'completed', upiId:'', createdAtMs:1000}];`);
    const html = run("renderProfile()") as string;
    expect(html).toContain("Wallet Balance");
    expect(html).toContain("₹150.00");
    expect(html).toContain("learner@example.com");
    expect(html).not.toContain("Learner");
    expect(html).toContain("Refer & Earn");
    expect(html).toContain("Wallet");
  });

  it("Profile header shows a placeholder while the wallet is loading, never a wrong ₹0.00", () => {
    // beforeEach leaves walletTxns null (not loaded yet).
    const html = run("renderProfile()") as string;
    expect(html).toContain("Wallet Balance");
    expect(html).toContain("…");
    expect(html).not.toContain("₹0.00");
    expect(html).not.toContain("Learner");
  });

  it("Refer & Earn resolves the code from an existing row and enables Copy on first open (regression: stuck Generating…)", async () => {
    // Mirrors the live case: the referral_codes row already exists.
    db.referral_codes.push({ user_id: "u1", code: "QHL8LFM8", created_at: new Date().toISOString() });
    location.hash = "#/refer";
    run("render()");
    await flush();
    const html = document.getElementById("view")!.innerHTML;
    expect(html).toContain("QHL8LFM8");
    expect(html).toContain("https://technoacademy.online/technotrade.html?ref=QHL8LFM8");
    expect(html).not.toContain("Generating your link");
    expect(html).not.toContain("Loading referrals");
    expect(html).toContain("No referrals yet");
    expect((document.getElementById("copyRefLinkBtn") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("copyRefCodeBtn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("re-rendering Refer & Earn does not re-trigger the code load (regression: infinite render loop)", async () => {
    db.referral_codes.push({ user_id: "u1", code: "QHL8LFM8", created_at: new Date().toISOString() });
    location.hash = "#/refer";
    run("render()");
    await flush();
    // One select: the first load found the existing row.
    expect(db.__selects["referral_codes"]).toBe(1);
    run("render()");
    run("render()");
    run("render()");
    await flush();
    expect(db.__selects["referral_codes"]).toBe(1);
    expect(document.getElementById("view")!.innerHTML).toContain("QHL8LFM8");
  });

  it("a failed referrals load shows the empty state, not a permanent Loading…", async () => {
    db.__failSelect = new Set(["referrals"]);
    location.hash = "#/refer";
    run("render()");
    await flush();
    const html = document.getElementById("view")!.innerHTML;
    expect(html).not.toContain("Loading referrals");
    expect(html).toContain("No referrals yet");
  });

  it("a failed code load shows a retry instead of hanging on Generating…", async () => {
    db.__failSelect = new Set(["referral_codes"]);
    location.hash = "#/refer";
    run("render()");
    await flush();
    const html = document.getElementById("view")!.innerHTML;
    expect(html).toContain("Couldn't generate your link");
    expect(html).not.toContain("Generating your link");
    expect(document.getElementById("retryRefCodeBtn")).not.toBeNull();
    // Retrying re-attempts the load without hanging.
    (document.getElementById("retryRefCodeBtn") as HTMLButtonElement).click();
    await flush();
    expect(document.getElementById("view")!.innerHTML).toContain("Couldn't generate your link");
  });

  it("back arrow returns to Profile from Refer & Earn and Wallet", async () => {
    location.hash = "#/refer";
    run("render()");
    await flush();
    (document.querySelector(".backbtn") as HTMLButtonElement).click();
    expect(location.hash).toBe("#/profile");
    run("render()");
    expect(document.getElementById("view")!.innerHTML).toContain("Wallet Balance");
    location.hash = "#/wallet";
    run("render()");
    await flush();
    (document.querySelector(".backbtn") as HTMLButtonElement).click();
    expect(location.hash).toBe("#/profile");
  });

  it("Wallet shows the balance, the form and the transaction list", () => {
    run(`walletTxns = [
      {id:'t1', userId:'u1', kind:'referral_credit', amountPaise:5000, status:'completed', upiId:'', createdAtMs:1000},
      {id:'t2', userId:'u1', kind:'withdrawal', amountPaise:-10000, status:'requested', upiId:'learner@okhdfcbank', createdAtMs:2000},
      {id:'t3', userId:'u1', kind:'withdrawal', amountPaise:-5000, status:'paid', upiId:'learner@okhdfcbank', createdAtMs:3000},
      {id:'t4', userId:'u1', kind:'withdrawal', amountPaise:-2000, status:'rejected', upiId:'learner@okhdfcbank', createdAtMs:4000},
    ];`);
    const html = run("renderWallet()") as string;
    expect(html).toContain("Wallet Balance");
    expect(html).toContain('sub-card wallet-balance');
    expect(html).toContain('wallet-ic');
    expect(html).toContain('id="walletWithdrawBtn"');
    expect(html).toContain("Withdraw ↗");
    expect(html).toContain("-₹100.00");
    expect(html).toContain("-₹100");
    expect(html).toContain("learner@okhdfcbank");
    expect(html).toContain('id="withdrawUpi"');
    expect(html).toContain('id="withdrawAmount"');
    expect(html).toContain('id="withdrawBtn"');
    expect(html).not.toContain("Minimum withdrawal");
    expect(html).toContain("Status: Earned");
    expect(html).toContain("Status: Pending");
    expect(html).toContain("Status: Complete");
    expect(html).toContain("Status: Rejected");
  });

  it("Wallet has an explicit Withdrawal history section for referral money", () => {
    // This is the referral-money history Rupu asked for — NOT the Razorpay
    // "Payment history" row on Profile. Credits show as Earned ₹150/₹500
    // with the plan (and the friend's code when known); withdrawals show
    // their Pending/Complete/Rejected status with the UPI ID and date.
    run(`myReferrals = [{id:'r1', code:'ABCD1234', referrerId:'u1', referredId:'u2', status:'rewarded', rewardPaise:15000, createdAtMs:1000}];
      walletTxns = [
      {id:'t1', userId:'u1', kind:'referral_credit', amountPaise:15000, status:'completed', upiId:'', referralId:'r1', createdAtMs:1000},
      {id:'t2', userId:'u1', kind:'referral_credit', amountPaise:50000, status:'completed', upiId:'', referralId:'', createdAtMs:2000},
      {id:'t3', userId:'u1', kind:'withdrawal', amountPaise:-5000, status:'requested', upiId:'learner@okhdfcbank', createdAtMs:3000},
      {id:'t4', userId:'u1', kind:'withdrawal', amountPaise:-10000, status:'paid', upiId:'learner@okhdfcbank', createdAtMs:4000},
      {id:'t5', userId:'u1', kind:'withdrawal', amountPaise:-2000, status:'rejected', upiId:'learner@okhdfcbank', createdAtMs:5000},
    ];`);
    const html = run("renderWallet()") as string;
    expect(html).toContain("Withdrawal history");
    expect(html).toContain("Your referral earnings and UPI withdrawals");
    expect(html).not.toContain("Razorpay");
    expect(html).toContain("Earned ₹150");
    expect(html).toContain("Monthly plan");
    expect(html).toContain("Code: ABCD1234");
    expect(html).toContain("Earned ₹500");
    expect(html).toContain("Yearly plan");
    expect(html).toContain("Status: Earned");
    expect(html).toContain("Status: Pending");
    expect(html).toContain("Status: Complete");
    expect(html).toContain("Status: Rejected");
    expect(html).toContain("learner@okhdfcbank");
  });

  it("Wallet empty history shows No withdrawals yet, not a permanent Loading…", () => {
    run(`walletTxns = [];`);
    const html = run("renderWallet()") as string;
    expect(html).toContain("Withdrawal history");
    expect(html).toContain("No withdrawals yet");
    expect(html).not.toContain("Loading transactions");
  });

  it("a failed wallet load shows the empty state, not a permanent Loading…", async () => {
    db.__failSelect = new Set(["wallet_transactions"]);
    location.hash = "#/wallet";
    run("render()");
    await flush();
    const html = document.getElementById("view")!.innerHTML;
    expect(html).toContain("Withdrawal history");
    expect(html).toContain("No withdrawals yet");
    expect(html).not.toContain("Loading transactions");
  });

  it("re-rendering Wallet does not re-trigger the wallet load (audit: no render loop)", async () => {
    // Mirrors the Refer & Earn loop regression: bindWallet must load once,
    // and the re-render loadWallet triggers must not fetch again.
    db.wallet_transactions.push({ id: "t1", user_id: "u1", kind: "referral_credit", amount_paise: 15000, status: "completed", upi_id: "", created_at: new Date().toISOString() });
    location.hash = "#/wallet";
    run("render()");
    await flush();
    expect(db.__selects["wallet_transactions"]).toBe(1);
    run("render()");
    run("render()");
    run("render()");
    await flush();
    expect(db.__selects["wallet_transactions"]).toBe(1);
    expect(document.getElementById("view")!.innerHTML).toContain("Withdrawal history");
    expect(document.getElementById("view")!.innerHTML).toContain("Earned ₹150");
  });

  it("Wallet Withdraw button jumps to the form and focuses the UPI field", () => {
    run(`walletTxns = [{id:'t1', userId:'u1', kind:'referral_credit', amountPaise:5000, status:'completed', upiId:'', createdAtMs:1000}];`);
    document.body.innerHTML = run("renderWallet()") as string;
    run("bindWallet()");
    (document.getElementById("walletWithdrawBtn") as HTMLButtonElement).click();
    expect(document.activeElement?.id).toBe("withdrawUpi");
    expect(run("fmtRs2(0)")).toBe("₹0.00");
    expect(run("fmtRs2(15000)")).toBe("₹150.00");
  });

  it("withdrawal validation: bad UPI, zero amount, above balance", async () => {
    run(`walletTxns = [{id:'t1', userId:'u1', kind:'referral_credit', amountPaise:15000, status:'completed', upiId:'', createdAtMs:1000}];`);
    document.body.innerHTML = run("renderWallet()") as string;
    run("bindWallet()");
    const setForm = (upi: string, amount: string) => {
      (document.getElementById("withdrawUpi") as HTMLInputElement).value = upi;
      (document.getElementById("withdrawAmount") as HTMLInputElement).value = amount;
    };
    setForm("not-an-upi", "150");
    await run("requestWithdrawal()");
    expect(document.getElementById("withdrawMsg")?.textContent).toContain("valid UPI ID");
    setForm("learner@okhdfcbank", "0");
    await run("requestWithdrawal()");
    expect(document.getElementById("withdrawMsg")?.textContent).toContain("more than ₹0");
    setForm("learner@okhdfcbank", "200");
    await run("requestWithdrawal()");
    expect(document.getElementById("withdrawMsg")?.textContent).toContain("more than your available balance");
    expect(db.wallet_transactions).toHaveLength(0);
  });

  it("a valid withdrawal inserts a requested row reserving the amount", async () => {
    // The ₹150 credit must exist in the DB too: requestWithdrawal reloads
    // the wallet from the DB after inserting, so the balance check reads it.
    db.wallet_transactions.push({ id: "t1", user_id: "u1", kind: "referral_credit", amount_paise: 15000, status: "completed", upi_id: "", created_at: new Date().toISOString() });
    run(`walletTxns = [{id:'t1', userId:'u1', kind:'referral_credit', amountPaise:15000, status:'completed', upiId:'', createdAtMs:1000}];`);
    document.body.innerHTML = run("renderWallet()") as string;
    run("bindWallet()");
    (document.getElementById("withdrawUpi") as HTMLInputElement).value = "learner@okhdfcbank";
    (document.getElementById("withdrawAmount") as HTMLInputElement).value = "50";
    await run("requestWithdrawal()");
    await tick();
    expect(db.wallet_transactions).toHaveLength(2);
    expect(db.wallet_transactions[1]).toMatchObject({
      user_id: "u1", kind: "withdrawal", amount_paise: -5000,
      status: "requested", upi_id: "learner@okhdfcbank",
    });
    // The requested amount is now reserved: available balance drops to ₹100.
    expect(run("walletBalancePaise(walletTxns)")).toBe(10000);
  });
});

// Referral/wallet admin coverage lives in the admin-panel describe below.
describe("Referrals & wallet — admin panel", () => {
  it("has a Referrals tab with totals, referrals and withdrawals", () => {
    expect(adminHtml).toContain('["referrals","Referrals"]');
    expect(adminHtml).toContain('data-sec="referrals"');
    expect(adminHtml).toContain('id="referralList"');
    expect(adminHtml).toContain('id="withdrawalList"');
    expect(adminHtml).toContain('id="referralTotals"');
    expect(adminScript).toContain("loadReferrals()");
    expect(adminScript).toContain("markWithdrawalPaid");
    expect(adminScript).toContain("markWithdrawalRejected");
    expect(adminScript).toContain("markReferralRewarded");
    expect(adminScript).toContain("reloadAll()");
    expect(adminScript).toContain('data-withdraw-pay');
    expect(adminScript).toContain('data-withdraw-reject');
  });

  it("admin actions only touch requested rows", () => {
    expect(adminScript).toContain('.update({status:"paid"}).eq("id",id).eq("status","requested")');
    expect(adminScript).toContain('.update({status:"rejected"}).eq("id",id).eq("status","requested")');
    expect(adminScript).toContain('.update({status:"rewarded",reward_amount_paise:reward}).eq("id",id).eq("status","pending")');
  });
});
