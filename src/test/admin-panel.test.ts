import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync("public/admin.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function makeClient() {
  // Test-only mock: `any` keeps the chained Supabase-style query builder
  // type-clean (tsc flags dot access on Record<string, unknown>).
  const query: any = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  const client = {
    auth: {
      getUser: vi.fn(async (): Promise<any> => ({ data: { user: null }, error: null })),
      onAuthStateChange: vi.fn(),
      signInWithOAuth: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn((_table: string) => query),
    // Default milestone check: no bonus. Milestone tests override it.
    rpc: vi.fn(async () => ({ data: false, error: null })),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  };
  return { client, query };
}

describe("Hosted admin panel", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeClient>["client"];

  beforeEach(() => {
    document.body.innerHTML = html.split("<body>")[1]?.split("<script>")[0] ?? "";
    const mock = makeClient();
    client = mock.client;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!script) throw new Error("Admin script missing");
    run = new Function(`${script}\nreturn code => eval(code);`)();
  });

  it("keeps a signed-in non-admin out of the panel", async () => {
    client.auth.getUser.mockResolvedValue({
      data: { user: { id: "learner-id", email: "learner@example.com" } },
      error: null,
    });
    await run("refreshAccess()");
    expect(document.getElementById("deniedCard")?.classList.contains("hide")).toBe(false);
    expect(document.getElementById("app")?.classList.contains("hide")).toBe(true);
  });

  it("saves only the course entered by the admin", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    client.from.mockImplementation((table: string) => {
      if (table === "courses") return { insert } as never;
      return makeClient().query as never;
    });
    run("loadCourses=async()=>{};loadDashboard=async()=>{};editingCourseId=null");
    (document.getElementById("cfId") as HTMLInputElement).value = "one-real-course";
    (document.getElementById("cfTitle") as HTMLInputElement).value = "My Real Course";
    (document.getElementById("cfDesc") as HTMLTextAreaElement).value = "Added by admin";
    (document.getElementById("cfOrder") as HTMLInputElement).value = "2";
    (document.getElementById("cfThumb") as HTMLInputElement).value = "";
    await run("saveCourse()");
    expect(insert).toHaveBeenCalledWith({
      id: "one-real-course",
      title: "My Real Course",
      description: "Added by admin",
      thumbnail_url: "",
      order: 2,
    });
  });

  it("grants a subscription by inserting when none exists", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    client.from.mockImplementation((table: string) => {
      if (table === "subscriptions") return {
        update: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn(async () => ({ data: [], error: null })) })) })),
        insert,
      } as never;
      return makeClient().query as never;
    });
    await run("createSubscription('user-1','monthly')");
    expect(insert).toHaveBeenCalledWith({
      user_id: "user-1",
      plan_id: "monthly",
      status: "active",
      expires_at: expect.any(String),
    });
  });

  it("grants a subscription by updating the existing row", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    client.from.mockImplementation((table: string) => {
      if (table === "subscriptions") return {
        update: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn(async () => ({ data: [{ user_id: "user-1" }], error: null })) })) })),
        insert,
      } as never;
      return makeClient().query as never;
    });
    await run("createSubscription('user-1','yearly')");
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("Admin Users tab", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeClient>["client"];

  const users = [
    { id: "11111111-2222-3333-4444-555555555555", email: "aasha@example.com", display_name: "Aasha" },
    { id: "99999999-8888-7777-6666-555555555555", email: "bikash@example.com", display_name: null },
  ];
  const subs = [
    { user_id: users[0]!.id, plan_id: "monthly", status: "active", expires_at: new Date(Date.now() + 86400000).toISOString() },
  ];

  function mockUsers(userData: unknown[], subData: unknown[]) {
    client.from.mockImplementation((table: string) => {
      if (table === "users") return { select: () => ({ order: async () => ({ data: userData, error: null }) }) } as never;
      if (table === "subscriptions") return { select: async () => ({ data: subData, error: null }) } as never;
      return makeClient().query as never;
    });
  }

  beforeEach(() => {
    document.body.innerHTML = html.split("<body>")[1]?.split("<script>")[0] ?? "";
    const mock = makeClient();
    client = mock.client;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!script) throw new Error("Admin script missing");
    run = new Function(`${script}\nreturn code => eval(code);`)();
  });

  it("lists every user with their full ID, email, name and subscription status", async () => {
    mockUsers(users, subs);
    await run("isAdmin=true");
    await run("loadUsers()");
    const list = document.getElementById("userList")?.innerHTML ?? "";
    expect(list).toContain("11111111-2222-3333-4444-555555555555");
    expect(list).toContain("99999999-8888-7777-6666-555555555555");
    expect(list).toContain("aasha@example.com");
    expect(list).toContain("bikash@example.com");
    expect(list).toContain("Aasha");
    expect(list).toContain("Active");
    expect(list).toContain("Monthly");
    expect(list).toContain("No subscription");
    expect(document.getElementById("userTotal")?.textContent).toBe("2 users");
    expect(document.querySelector('[data-tab="users"]')?.textContent).toBe("Users");
  });

  it("shows the Users section when its tab is opened", async () => {
    await run("showTab('users')");
    const section = document.querySelector('section[data-sec="users"]');
    expect(section?.classList.contains("hide")).toBe(false);
    expect(document.querySelector('section[data-sec="dashboard"]')?.classList.contains("hide")).toBe(true);
  });

  it("copies the full user ID when the copy button is used", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    mockUsers(users, subs);
    await run("isAdmin=true");
    await run("loadUsers()");
    const button = document.querySelector('[data-copy-user-id="11111111-2222-3333-4444-555555555555"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    await run("copyUserId(document.querySelector('[data-copy-user-id=\"11111111-2222-3333-4444-555555555555\"]'))");
    expect(writeText).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555");
    expect(button.textContent).toBe("Copied!");
  });

  it("narrows the list with the search box", async () => {
    mockUsers(users, subs);
    await run("isAdmin=true");
    await run("loadUsers()");
    (document.getElementById("userSearch") as HTMLInputElement).value = "bikash";
    await run("renderUsers()");
    const list = document.getElementById("userList")?.innerHTML ?? "";
    expect(list).toContain("bikash@example.com");
    expect(list).not.toContain("aasha@example.com");
    expect(document.getElementById("userTotal")?.textContent).toBe('1 user matching "bikash"');
  });

  it("shows an empty state, not a spinner, when there are no users", async () => {
    mockUsers([], []);
    await run("isAdmin=true");
    await run("loadUsers()");
    const list = document.getElementById("userList")?.innerHTML ?? "";
    expect(list).toContain("No users yet.");
    expect(list).not.toMatch(/loading/i);
  });
});

describe("Admin subscriptions queries (no created_at column)", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeClient>["client"];

  beforeEach(() => {
    document.body.innerHTML = html.split("<body>")[1]?.split("<script>")[0] ?? "";
    const mock = makeClient();
    client = mock.client;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!script) throw new Error("Admin script missing");
    run = new Function(`${script}\nreturn code => eval(code);`)();
  });

  it("never selects or orders subscriptions by created_at (the column does not exist)", () => {
    expect(script).not.toContain('select("user_id,plan_id,created_at")');
    const subQueries = [...(script ?? "").matchAll(/from\("subscriptions"\)\.select\("([^"]*)"\)/g)];
    expect(subQueries.length).toBeGreaterThan(0);
    for (const [, cols] of subQueries) expect(cols).not.toContain("created_at");
    const subOrders = [...(script ?? "").matchAll(/from\("subscriptions"\)\.select\("[^"]*"\)\.order\("([^"]*)"/g)];
    for (const [, col] of subOrders) expect(col).not.toBe("created_at");
    expect(script).toContain('select("user_id,plan_id,status,expires_at")');
  });

  it("loads the Referrals tab when subscription rows have no created_at field", async () => {
    const userId = "11111111-2222-3333-4444-555555555555";
    const referrerId = "99999999-8888-7777-6666-555555555555";
    const refs = [
      { id: "ref-1", code: "QHL8LFM8", referrer_id: referrerId, referred_id: userId, status: "pending", reward_amount_paise: 0, created_at: "2026-11-12T00:00:00Z" },
    ];
    const subs = [
      { user_id: userId, plan_id: "monthly", status: "active", expires_at: new Date(Date.now() + 30 * 86400000).toISOString() },
    ];
    const selectSubs = vi.fn(() => ({ order: async () => ({ data: subs, error: null }) }));
    const chain = (data: unknown[]) => {
      const q: any = {
        order: () => ({ limit: async () => ({ data, error: null }) }),
        limit: async () => ({ data, error: null }),
      };
      q.eq = () => q;
      return q;
    };
    client.from.mockImplementation((table: string) => {
      if (table === "referrals") return { select: () => chain(refs) } as never;
      if (table === "wallet_transactions") return { select: () => chain([]) } as never;
      if (table === "users") return {
        select: async () => ({
          data: [
            { id: userId, email: "aasha@example.com", display_name: "Aasha" },
            { id: referrerId, email: "rupu@example.com", display_name: "Rupu" },
          ],
          error: null,
        }),
      } as never;
      if (table === "subscriptions") return { select: selectSubs } as never;
      return makeClient().query as never;
    });
    await run("isAdmin=true");
    await run("loadReferrals()");
    expect(selectSubs).toHaveBeenCalledWith("user_id,plan_id,status,expires_at");
    expect(document.getElementById("referralTotals")?.innerHTML ?? "").toContain("Referrals: 1");
    const list = document.getElementById("referralList")?.innerHTML ?? "";
    expect(list).toContain("Monthly");
    expect(list).toContain("Mark rewarded");
    expect(document.getElementById("referralMsg")?.textContent ?? "").not.toContain("Could not load subscriptions");
  });

  it("shows the live plan when a user has both an expired and an active subscription row", async () => {
    const userId = "11111111-2222-3333-4444-555555555555";
    const users = [{ id: userId, email: "aasha@example.com", display_name: "Aasha" }];
    const subs = [
      { user_id: userId, plan_id: "yearly", status: "expired", expires_at: new Date(Date.now() - 86400000).toISOString() },
      { user_id: userId, plan_id: "monthly", status: "active", expires_at: new Date(Date.now() + 30 * 86400000).toISOString() },
    ];
    client.from.mockImplementation((table: string) => {
      if (table === "users") return { select: () => ({ order: async () => ({ data: users, error: null }) }) } as never;
      if (table === "subscriptions") return { select: async () => ({ data: subs, error: null }) } as never;
      return makeClient().query as never;
    });
    await run("isAdmin=true");
    await run("loadUsers()");
    const list = document.getElementById("userList")?.innerHTML ?? "";
    expect(list).toContain("Active");
    expect(list).toContain("Monthly");
    expect(list).not.toContain("No subscription");
  });

  it("loads Dashboard totals when subscription rows have no created_at field", async () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();
    const result = (data: unknown[]) => ({ data, error: null });
    const chain = (data: unknown[]) => ({ order: () => ({ limit: async () => result(data) }) });
    client.from.mockImplementation((table: string) => {
      if (table === "courses") return { select: async () => result([{}, {}, {}]) } as never;
      if (table === "lessons") return { select: async () => result([{}, {}]) } as never;
      if (table === "users") return { select: async () => result([{}, {}]) } as never;
      if (table === "subscriptions") return {
        select: async () => result([
          { user_id: "u1", status: "active", expires_at: future },
          { user_id: "u2", status: "active", expires_at: past },
          { user_id: "u3", status: "cancelled", expires_at: future },
        ]),
      } as never;
      if (table === "payments") return {
        select: () => chain([{ id: "pay_1", amount: 100000, plan_id: "monthly", status: "captured", created_at: "2026-11-12T00:00:00Z" }]),
      } as never;
      return makeClient().query as never;
    });
    await run("loadDashboard()");
    expect(document.getElementById("cCourses")?.textContent).toBe("3");
    expect(document.getElementById("cLessons")?.textContent).toBe("2");
    expect(document.getElementById("cUsers")?.textContent).toBe("2");
    expect(document.getElementById("cSubs")?.textContent).toBe("1");
    expect(document.getElementById("cPending")?.textContent).toBe("1");
    expect(document.getElementById("globalMsg")?.textContent ?? "").not.toContain("Dashboard failed");
  });
});

describe("Admin milestone bonus — ₹5,000 at 50 rewarded referrals", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeClient>["client"];

  beforeEach(() => {
    document.body.innerHTML = html.split("<body>")[1]?.split("<script>")[0] ?? "";
    const mock = makeClient();
    client = mock.client;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!script) throw new Error("Admin script missing");
    run = new Function(`${script}\nreturn code => eval(code);`)();
  });

  function mockRewardTables() {
    client.from.mockImplementation((table: string) => {
      if (table === "referrals") return {
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      } as never;
      if (table === "wallet_transactions") return {
        insert: vi.fn(async () => ({ error: null })),
      } as never;
      return makeClient().query as never;
    });
  }

  function seedPending() {
    run(`referralRows = [{id:'ref-1', code:'QHL8LFM8', referrer_id:'ref-user', referred_id:'buyer-user', status:'pending', reward_amount_paise:0, created_at:'2026-11-12T00:00:00Z'}];
      referralSubs = {'buyer-user': {user_id:'buyer-user', plan_id:'monthly', status:'active', expires_at:'2026-12-12T00:00:00Z'}};
      referralUsers = {'ref-user': {id:'ref-user', email:'ref@example.com', display_name:'Ref'}, 'buyer-user': {id:'buyer-user', email:'buyer@example.com', display_name:'Buyer'}};
      loadReferrals = async () => {};`);
  }

  it("calls the milestone check and reports the bonus when it pays", async () => {
    mockRewardTables();
    seedPending();
    client.rpc.mockResolvedValue({ data: true, error: null });
    await run("markReferralRewarded('ref-1')");
    expect(client.rpc).toHaveBeenCalledWith("check_referral_milestone", { p_referrer_id: "ref-user", p_referral_id: "ref-1" });
    expect(document.getElementById("referralMsg")?.textContent ?? "").toContain("Milestone bonus ₹5,000");
  });

  it("still rewards without the bonus when the milestone check says no", async () => {
    mockRewardTables();
    seedPending();
    client.rpc.mockResolvedValue({ data: false, error: null });
    await run("markReferralRewarded('ref-1')");
    expect(client.rpc).toHaveBeenCalledWith("check_referral_milestone", { p_referrer_id: "ref-user", p_referral_id: "ref-1" });
    const msg = document.getElementById("referralMsg")?.textContent ?? "";
    expect(msg).toContain("Rewarded ₹200");
    expect(msg).not.toContain("Milestone bonus");
  });
});
