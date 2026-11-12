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
