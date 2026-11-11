import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync("public/technotrade.html", "utf8");
const script = html.split("<script>")[1]?.split("// ---------- boot ----------")[0];

function makeLearnerClient() {
  // Test-only mock: `any` keeps the chained Supabase-style query builder
  // type-clean (tsc flags dot access on Record<string, unknown>).
  const query: any = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
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
    from: vi.fn(() => query),
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return { client, query, channel };
}

describe("In-app notifications (new courses + admin notifications)", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeLearnerClient>["client"];
  beforeEach(() => {
    document.body.innerHTML = html.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    const made = makeLearnerClient();
    client = made.client;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!script) throw new Error("Learner script missing");
    run = new Function(`${script}\nreturn code => eval(code);`)();
    run("currentUser = {uid:'test',id:'test',displayName:'Learner',email:'learner@example.com'}; courses=[]; coursesLoaded=false; subscription=null;");
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has no Web Push prompt or subscription code left (feature paused)", () => {
    expect(html).not.toContain("maybeAskNotificationPermission");
    expect(html).not.toContain("savePushSubscription");
    expect(html).not.toContain("VAPID_PUBLIC_KEY");
    expect(html).not.toContain("requestPermission");
    expect(html).not.toContain("/sw.js");
  });

  it("finds only the brand-new courses", () => {
    expect(run("findNewCourses([{id:'a'}], [{id:'a'},{id:'b'}])")).toEqual([{ id: "b" }]);
    expect(run("findNewCourses([], [{id:'a'}])")).toEqual([{ id: "a" }]);
    expect(run("findNewCourses([{id:'a'}], [{id:'a'}])")).toEqual([]);
  });

  describe("new-course inbox alerts", () => {
    function mockCourses(rows: any[]) {
      const q: any = {};
      q.select = vi.fn(() => q);
      q.order = vi.fn(() => q);
      q.then = (resolve: any) => resolve({ data: rows, error: null });
      vi.mocked(client.from).mockImplementation(() => q);
    }

    it("adds an inbox item only for brand-new courses on live reload", async () => {
      run("render = () => {}; refreshLessonStats = () => {};");
      mockCourses([{ id: "basics", title: "Trading Basics", description: "d1", order: 1 }]);
      await run("loadCourses()");
      expect(run("store.inbox()")).toEqual([]);
      mockCourses([
        { id: "basics", title: "Trading Basics", description: "d1", order: 1 },
        { id: "futures", title: "Futures Trading", description: "d2", order: 2 },
      ]);
      await run("loadCourses()");
      const inbox = run("store.inbox()") as Array<{ title: string }>;
      expect(inbox.length).toBe(1);
      expect(inbox[0]!.title).toBe("New course: Futures Trading");
      await run("loadCourses()");
      expect((run("store.inbox()") as unknown[]).length).toBe(1);
    });
  });

  describe("admin notifications into the inbox", () => {
    function setActiveSub(planId: string) {
      run(
        "subscription = {status:'active', planId:'" +
          planId +
          "', expiresAt:{toDate: () => new Date(Date.now()+86400000)}};",
      );
    }

    it("records an 'all' notification once and ignores repeats", () => {
      const n = { id: "n1", title: "Hello", message: "World", audience: "all" };
      expect(run("noteAdminNotification(" + JSON.stringify(n) + ")")).toBe(true);
      expect(run("store.inbox()")).toHaveLength(1);
      expect(run("noteAdminNotification(" + JSON.stringify(n) + ")")).toBe(false);
      expect(run("store.inbox()")).toHaveLength(1);
    });

    it("only shows plan notifications to subscribers of that plan", () => {
      const monthly = { id: "n2", title: "M", message: "m", audience: "monthly" };
      expect(run("noteAdminNotification(" + JSON.stringify(monthly) + ")")).toBe(false);
      setActiveSub("monthly");
      expect(run("noteAdminNotification(" + JSON.stringify(monthly) + ")")).toBe(true);
      const yearly = { id: "n3", title: "Y", message: "y", audience: "yearly" };
      expect(run("noteAdminNotification(" + JSON.stringify(yearly) + ")")).toBe(false);
    });

    it("shows non_subscribed notifications only without an active subscription", () => {
      const n = { id: "n4", title: "N", message: "n", audience: "non_subscribed" };
      expect(run("noteAdminNotification(" + JSON.stringify(n) + ")")).toBe(true);
      setActiveSub("yearly");
      const n2 = { id: "n5", title: "N2", message: "n", audience: "non_subscribed" };
      expect(run("noteAdminNotification(" + JSON.stringify(n2) + ")")).toBe(false);
    });

    it("does not record when the Settings toggle is off", () => {
      run("store.setSettings({notificationsEnabled:false})");
      const n = { id: "n6", title: "H", message: "h", audience: "all" };
      expect(run("noteAdminNotification(" + JSON.stringify(n) + ")")).toBe(false);
      expect(run("store.inbox()")).toHaveLength(0);
    });

    it("loads queued admin notifications into the inbox", async () => {
      const rows = [
        { id: "a1", title: "New course live", message: "Check it out", audience: "all" },
        { id: "a2", title: "Members only", message: "For monthly", audience: "monthly" },
      ];
      const q: any = {};
      q.select = vi.fn(() => q);
      q.order = vi.fn(() => q);
      q.limit = vi.fn(() => q);
      q.then = (resolve: any) => resolve({ data: rows, error: null });
      vi.mocked(client.from).mockImplementation(() => q);
      await run("loadAdminNotifications()");
      const inbox = run("store.inbox()") as Array<{ title: string }>;
      expect(inbox.map((i) => i.title)).toEqual(["New course live"]);
    });
  });
});
