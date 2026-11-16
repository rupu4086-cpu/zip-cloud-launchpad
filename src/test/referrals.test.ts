import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const siteHtml = readFileSync("public/technotrade.html", "utf8");
const siteScript = siteHtml.split("<script>")[1]?.split("// ---------- boot ----------")[0];
const adminHtml = readFileSync("public/admin.html", "utf8");
const adminScript = adminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const resetHtml = readFileSync("public/reset-password.html", "utf8");

// The referral system, wallet, spin wheel and downloads were REMOVED
// ENTIRELY (redirect 2026-11-16). The tests below pin the removal: no code,
// no route and no UI for them may come back, and the Rs.1 trial fee can
// never activate a plan.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

describe("Removed systems — learner website", () => {
  let run: (code: string) => unknown;
  let paymentsRows: any[];
  let subscriptionInserts: any[];

  function makeLearnerClient() {
    const queryFor = (table: string) => {
      // Test-only mock: `any` keeps the chained Supabase-style query builder
      // type-clean (tsc flags dot access on Record<string, unknown>).
      const query: any = { __table: table };
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.order = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.insert = vi.fn((payload: any) => {
        if (table === "subscriptions") subscriptionInserts.push(payload);
        return query;
      });
      query.update = vi.fn(() => query);
      query.upsert = vi.fn(() => query);
      query.delete = vi.fn(() => query);
      query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const result =
          table === "payments" ? { data: paymentsRows, error: null } : { data: [], error: null };
        return Promise.resolve(result).then(resolve, reject);
      };
      return query;
    };
    const channel: any = {};
    channel.on = vi.fn(() => channel);
    channel.subscribe = vi.fn(() => channel);
    const client = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
        getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
        signInWithOAuth: vi.fn(),
        signInWithPassword: vi.fn(),
        signUp: vi.fn(),
        resetPasswordForEmail: vi.fn(),
        signOut: vi.fn(),
      },
      from: vi.fn((table: string) => queryFor(table)),
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    };
    return client;
  }

  beforeEach(() => {
    paymentsRows = [];
    subscriptionInserts = [];
    document.body.innerHTML = siteHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    Object.assign(window, { supabase: { createClient: () => makeLearnerClient() } });
    localStorage.clear();
    sessionStorage.clear();
    location.hash = "#/home";
    if (!siteScript) throw new Error("Learner script missing");
    run = new Function(`${siteScript}\nreturn code => eval(code);`)();
    run(
      "currentUser = {uid:'u1',id:'u1',displayName:'Learner',email:'learner@example.com'}; isAdmin = false; courses=[]; coursesLoaded=true; subscription=null; trialStatus=null;",
    );
  });

  it("no spin, referral, wallet or download code remains in the learner script", () => {
    const script = siteScript ?? "";
    for (const gone of [
      "spinPct",
      "spinWheel",
      "spinPricePaise",
      "checkTodaySpin",
      "spin_plays",
      "WHEEL_VALUES",
      "renderRefer",
      "renderWallet",
      "maybeRewardReferral",
      "maybeAttributeReferral",
      "parseReferralCodeFromUrl",
      "generateReferralCode",
      "referralLink",
      "referral_codes",
      "wallet_transactions",
      "walletBalancePaise",
      "requestWithdrawal",
      "startDownload",
      "renderDownloads",
      "loadWallet",
      "tt_ref_code",
      "MILESTONE_REFERRALS",
    ]) {
      expect(script).not.toContain(gone);
    }
  });

  it("no spin, learning-path, teaser or wallet CSS remains", () => {
    const style = siteHtml.split("<style>")[1]?.split("</style>")[0] ?? "";
    for (const gone of [
      ".wheel-card",
      ".wheel-spin",
      ".spin-result",
      ".offer-countdown",
      ".path-card",
      ".teaser",
      ".wallet-balance",
    ]) {
      expect(style).not.toContain(gone);
    }
  });

  it("Profile shows the name and Library/Subscriptions rows, never Refer/Wallet/Downloads", () => {
    run("location.hash='#/profile'; render()");
    const text = document.querySelector("#view")?.textContent || "";
    expect(text).toContain("Learner");
    expect(text).not.toContain("Wallet Balance");
    expect(document.querySelector('[data-profile="library"]')).not.toBeNull();
    expect(document.querySelector('[data-profile="subscriptions"]')).not.toBeNull();
    expect(document.querySelector('[data-profile="refer"]')).toBeNull();
    expect(document.querySelector('[data-profile="wallet"]')).toBeNull();
    expect(document.querySelector('[data-profile="downloads"]')).toBeNull();
  });

  it("removed routes redirect to Home", () => {
    for (const route of ["#/refer", "#/wallet", "#/downloads"]) {
      run(`location.hash='${route}'; render()`);
      expect(location.hash).toBe("#/home");
    }
  });

  it("signup form has no referral code field", () => {
    run("currentUser=null; location.hash='#/profile'; render()");
    expect(document.getElementById("authRefCode")).toBeNull();
    expect(document.getElementById("signupRefBox")).toBeNull();
  });

  it("checkMyPayment never activates on a Rs.1 trial-fee row", async () => {
    paymentsRows.push({
      id: "pay_trial1",
      user_id: "u1",
      plan_id: "monthly",
      amount: 100,
      status: "captured",
      kind: "trial_fee",
      created_at: new Date().toISOString(),
    });
    await run("checkMyPayment()");
    await flush();
    expect(subscriptionInserts).toHaveLength(0);
    expect(run("access().hasActiveSubscription")).toBe(false);
  });

  it("Payment history labels trial fee and trial charge, with no wallet rows", () => {
    run(
      "paymentHistory=[normalizePayment({id:'pay_fee',user_id:'u1',plan_id:'monthly',amount:100,status:'captured',kind:'trial_fee',created_at:'2026-11-16T10:00:00Z'}),normalizePayment({id:'pay_charge',user_id:'u1',plan_id:'monthly',amount:39900,status:'captured',kind:'trial_charge',created_at:'2026-11-17T10:00:00Z'})];",
    );
    run("location.hash='#/payments'; render()");
    const text = document.querySelector("#view")?.textContent || "";
    expect(text).toContain("Trial fee — ₹1");
    expect(text).toContain("Trial charge — ₹399");
    expect(text).not.toContain("Earned");
    expect(text).not.toContain("withdrawal");
  });

  it("My Subscriptions shows the trial status and the will-not-renew note", () => {
    run(
      "trialStatus={id:'t1',status:'charge_pending',trialEndsAtMs:0,chargeAtMs:0,chargePaymentId:null};",
    );
    run("location.hash='#/subscriptions'; render()");
    const text = document.querySelector("#view")?.textContent || "";
    expect(text).toContain("Trial ended — charge retrying");
    expect(text).toContain("Will not renew — no further charge after your access ends.");
    expect(text).not.toContain("Cancel");
  });
});

describe("Removed systems — admin panel", () => {
  it("has no Referrals tab, section or referral/wallet actions", () => {
    expect(adminHtml).not.toContain('["referrals","Referrals"]');
    expect(adminHtml).not.toContain('data-sec="referrals"');
    expect(adminHtml).not.toContain('id="referralList"');
    expect(adminHtml).not.toContain('id="withdrawalList"');
    expect(adminHtml).not.toContain('id="referralTotals"');
    for (const gone of [
      "loadReferrals",
      "markWithdrawalPaid",
      "markWithdrawalRejected",
      "markReferralRewarded",
      "maybeRewardMilestone",
      "check_referral_milestone",
      "referral_codes",
      "wallet_transactions",
      "data-withdraw-pay",
      "data-withdraw-reject",
    ]) {
      expect(adminScript).not.toContain(gone);
    }
    // The other tabs still load.
    expect(adminScript).toContain("reloadAll()");
  });
});
