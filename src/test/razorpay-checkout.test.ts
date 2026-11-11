import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const learnerHtml = readFileSync("public/technotrade.html", "utf8");
const learnerScript = learnerHtml.split("<script>")[1]?.split("// ---------- boot ----------")[0];
const adminHtml = readFileSync("public/admin.html", "utf8");
const adminScript = adminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

const flush = () => new Promise((r) => setTimeout(r, 5));

// ---------- learner-site harness (mirrors spin-wheel.test.ts) ----------

class MockRazorpay {
  static instances: MockRazorpay[] = [];
  static opened: Record<string, unknown>[] = [];
  options: any;
  constructor(options: any) {
    this.options = options;
    MockRazorpay.instances.push(this);
  }
  open() {
    MockRazorpay.opened.push(this.options);
  }
}

describe("Razorpay Checkout (learner site)", () => {
  let run: (code: string) => unknown;
  let paymentsRows: any[];
  let subscriptionInserts: any[];
  let openSpy: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  function makeLearnerClient() {
    const queryFor = (table: string) => {
      // Test-only mock: `any` keeps the chained Supabase-style query builder
      // type-clean (tsc flags dot access on Record<string, unknown>).
      const query: any = { __table: table };
      let inserted: Record<string, unknown> | null = null;
      let updated: Record<string, unknown> | null = null;
      let eqVal: unknown = null;
      query.select = vi.fn(() => query);
      query.eq = vi.fn((_col: string, val: unknown) => {
        eqVal = val;
        return query;
      });
      query.gte = vi.fn(() => query);
      query.lt = vi.fn(() => query);
      query.order = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.not = vi.fn(() => query);
      query.insert = vi.fn((payload: Record<string, unknown>) => {
        inserted = payload;
        if (table === "payments") paymentsRows.push(payload);
        if (table === "subscriptions") subscriptionInserts.push(payload);
        return query;
      });
      query.update = vi.fn((payload: Record<string, unknown>) => {
        updated = payload;
        return query;
      });
      query.maybeSingle = vi.fn(async () => {
        if (table === "payments") {
          return { data: paymentsRows.find((r) => r.id === eqVal) || null, error: null };
        }
        return { data: null, error: null };
      });
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const result =
          inserted || updated
            ? { data: inserted ? [inserted] : [], error: null }
            : table === "payments"
              ? { data: paymentsRows, error: null }
              : { data: [], error: null };
        return Promise.resolve(result).then(resolve, reject);
      };
      return query;
    };
    const channel: any = {};
    channel.on = vi.fn(() => channel);
    channel.subscribe = vi.fn(() => channel);
    return {
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
  }

  beforeEach(() => {
    paymentsRows = [];
    subscriptionInserts = [];
    MockRazorpay.instances = [];
    MockRazorpay.opened = [];
    openSpy = vi.fn();
    fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, activated: true }) }));
    document.body.innerHTML = learnerHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    window.open = openSpy as never;
    Object.assign(window, {
      supabase: { createClient: () => makeLearnerClient() },
      Razorpay: MockRazorpay,
      fetch: fetchSpy,
    });
    if (!learnerScript) throw new Error("Learner script missing");
    run = new Function(`${learnerScript}\nreturn code => eval(code);`)();
    run(
      "currentUser = {uid:'test',id:'test',displayName:'Learner',email:'learner@example.com'}; courses=mergeCourses([{id:'basics',title:'Trading Basics'}]); coursesLoaded=true;",
    );
  });

  function showPlans() {
    run("location.hash='#/plans'; render()");
  }

  it("opens Checkout with the discounted amount when a spin code is active", () => {
    run("paymentConfig={monthlyLink:'',yearlyLink:'',enabled:true,keyId:'rzp_test_abc'}; spinPct=40; spinCode='SPIN40';");
    showPlans();
    (document.querySelector('[data-buy="monthly"]') as HTMLButtonElement).click();
    expect(MockRazorpay.instances).toHaveLength(1);
    const opts = MockRazorpay.instances[0]!.options;
    expect(opts.key).toBe("rzp_test_abc");
    expect(opts.amount).toBe(120); // TEMP TEST PRICE: ₹2 minus 40% = ₹1.20, in paise
    expect(opts.currency).toBe("INR");
    expect(opts.description).toContain("SPIN40");
    expect(MockRazorpay.opened).toHaveLength(1);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("opens Checkout at full price when no spin code is active", () => {
    run("paymentConfig={monthlyLink:'',yearlyLink:'',enabled:true,keyId:'rzp_live_xyz'}; spinPct=0; spinCode='';");
    showPlans();
    (document.querySelector('[data-buy="yearly"]') as HTMLButtonElement).click();
    expect(MockRazorpay.instances[0]!.options.amount).toBe(300000);
    expect(MockRazorpay.instances[0]!.options.description).toBe("Yearly plan");
  });

  it("shows a clear message and opens nothing when no Key ID and no link are set", () => {
    run("paymentConfig={monthlyLink:'',yearlyLink:'',enabled:true,keyId:''}; spinPct=0; spinCode='';");
    showPlans();
    (document.querySelector('[data-buy="monthly"]') as HTMLButtonElement).click();
    expect(MockRazorpay.instances).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
    expect(document.querySelector("#view")?.textContent).toContain("aren't set up yet");
  });

  it("falls back to the payment link when no Key ID is set but a link exists", () => {
    run("paymentConfig={monthlyLink:'https://rzp.io/l/test-monthly',yearlyLink:'',enabled:true,keyId:''}; spinPct=0; spinCode='';");
    showPlans();
    (document.querySelector('[data-buy="monthly"]') as HTMLButtonElement).click();
    expect(MockRazorpay.instances).toHaveLength(0);
    expect(openSpy).toHaveBeenCalledWith("https://rzp.io/l/test-monthly", "_blank", "noopener");
  });

  it("records the payment and activates the plan after a successful Checkout", async () => {
    run("paymentConfig={monthlyLink:'',yearlyLink:'',enabled:true,keyId:'rzp_test_abc'}; spinPct=40; spinCode='SPIN40';");
    showPlans();
    (document.querySelector('[data-buy="monthly"]') as HTMLButtonElement).click();
    const handler = MockRazorpay.instances[0]!.options.handler as (r: unknown) => void;
    handler({ razorpay_payment_id: "pay_test123", razorpay_signature: "sig" });
    await flush();
    await flush();
    expect(paymentsRows).toEqual([
      { id: "pay_test123", user_id: "test", plan_id: "monthly", amount: 120, status: "captured" },
    ]);
    // The discounted payment activates the plan (amount check accepts the spin price).
    expect(subscriptionInserts).toHaveLength(1);
    expect(subscriptionInserts[0]!.plan_id).toBe("monthly");
    expect(subscriptionInserts[0]!.status).toBe("active");
    expect(run("access().hasActiveSubscription")).toBe(true);
    expect(document.querySelector("#view")?.textContent).toContain("now active");
  });

  it("checkMyPayment accepts a captured payment at the spin-discounted amount", async () => {
    paymentsRows.push({
      id: "pay_disc1",
      user_id: "test",
      plan_id: "yearly",
      amount: 180000, // ₹3,000 minus 40% = ₹1,800, in paise
      status: "captured",
      created_at: new Date().toISOString(),
    });
    run("spinPct=40; spinCode='SPIN40';");
    await run("checkMyPayment()");
    expect(subscriptionInserts).toHaveLength(1);
    expect(subscriptionInserts[0]!.plan_id).toBe("yearly");
  });

  it("verifyPaymentId accepts a captured payment at the spin-discounted amount", async () => {
    paymentsRows.push({
      id: "pay_disc2",
      user_id: "test",
      plan_id: "monthly",
      amount: 100, // TEMP TEST PRICE: ₹2 minus 50% = ₹1, in paise
      status: "captured",
      created_at: new Date().toISOString(),
    });
    run("spinPct=50; spinCode='SPIN50';");
    await run("verifyPaymentId('pay_disc2')");
    expect(subscriptionInserts).toHaveLength(1);
    expect(subscriptionInserts[0]!.plan_id).toBe("monthly");
  });
});

// ---------- admin-panel harness (mirrors admin-panel.test.ts) ----------

describe("Razorpay Key ID (admin panel)", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeAdminClient>["client"];
  let updatePayload: Record<string, unknown> | null;
  let insertPayload: Record<string, unknown> | null;

  function makeAdminClient() {
    // Test-only mock: `any` keeps the chained Supabase-style query builder
    // type-clean (tsc flags dot access on Record<string, unknown>).
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.order = vi.fn(() => query);
    query.limit = vi.fn(() => query);
    query.not = vi.fn(() => query);
    query.update = vi.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      return query;
    });
    query.insert = vi.fn((payload: Record<string, unknown>) => {
      insertPayload = payload;
      return query;
    });
    query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve({ data: null, error: null }).then(resolve, reject);
    const client = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
        onAuthStateChange: vi.fn(),
        signInWithOAuth: vi.fn(),
        signInWithPassword: vi.fn(),
        resetPasswordForEmail: vi.fn(),
        signOut: vi.fn(),
      },
      from: vi.fn(() => query),
      channel: vi.fn(),
      removeChannel: vi.fn(),
    };
    return { client, query };
  }

  beforeEach(() => {
    updatePayload = null;
    insertPayload = null;
    document.body.innerHTML = adminHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    const mock = makeAdminClient();
    client = mock.client;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!adminScript) throw new Error("Admin script missing");
    run = new Function(`${adminScript}\nreturn code => eval(code);`)();
  });

  function setRazorpayFields(monthly: string, yearly: string, keyId: string) {
    (document.getElementById("rzMonthly") as HTMLInputElement).value = monthly;
    (document.getElementById("rzYearly") as HTMLInputElement).value = yearly;
    (document.getElementById("rzKeyId") as HTMLInputElement).value = keyId;
    (document.getElementById("rzEnabled") as HTMLInputElement).checked = true;
  }

  it("loads the saved Key ID into the field", async () => {
    const query = makeAdminClient().query;
    query.maybeSingle = vi.fn(async () => ({
      data: { monthly_link: "", yearly_link: "", key_id: "rzp_test_xyz", enabled: true },
      error: null,
    }));
    client.from.mockImplementation(() => query as never);
    await run("loadRazorpay()");
    expect((document.getElementById("rzKeyId") as HTMLInputElement).value).toBe("rzp_test_xyz");
    expect(document.getElementById("rzStatus")?.textContent).toContain("Key ID set");
  });

  it("rejects a Key ID that does not start with rzp_live_ or rzp_test_", async () => {
    setRazorpayFields("", "", "mysecret123");
    run("paymentConfigExists=true");
    await run("saveRazorpay()");
    expect(document.getElementById("rzMsg")?.textContent).toContain(
      "must start with rzp_live_ or rzp_test_",
    );
    expect(updatePayload).toBeNull();
    expect(insertPayload).toBeNull();
  });

  it("rejects a pasted Key Secret shaped value", async () => {
    setRazorpayFields("", "", "aB3dEf9xQw2rT7yU");
    run("paymentConfigExists=true");
    await run("saveRazorpay()");
    expect(document.getElementById("rzMsg")?.textContent).toContain("Never paste the Key Secret here");
    expect(updatePayload).toBeNull();
  });

  it("saves a valid live Key ID in the update payload", async () => {
    setRazorpayFields("", "", "rzp_live_abc123");
    run("paymentConfigExists=true");
    await run("saveRazorpay()");
    expect(updatePayload).toEqual({
      monthly_link: "",
      yearly_link: "",
      key_id: "rzp_live_abc123",
      enabled: true,
    });
  });
});
