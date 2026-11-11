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
  query.upsert = vi.fn(async () => ({ error: null }));
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

describe("Push notifications (website half)", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeLearnerClient>["client"];
  let query: ReturnType<typeof makeLearnerClient>["query"];
  beforeEach(() => {
    document.body.innerHTML = html.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    const made = makeLearnerClient();
    client = made.client;
    query = made.query;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!script) throw new Error("Learner script missing");
    run = new Function(`${script}\nreturn code => eval(code);`)();
    run("currentUser = {uid:'test',id:'test',displayName:'Learner',email:'learner@example.com'}; courses=[]; coursesLoaded=false; subscription=null;");
    localStorage.clear();
  });

  afterEach(() => {
    delete (globalThis as any).Notification;
    try {
      delete (window.navigator as any).serviceWorker;
    } catch {
      /* already absent */
    }
    vi.restoreAllMocks();
  });

  it("decodes a base64url VAPID key to bytes", () => {
    expect(Array.from(run("urlBase64ToUint8Array('SGVsbG8')") as Uint8Array)).toEqual([72, 101, 108, 108, 111]);
    expect(Array.from(run("urlBase64ToUint8Array('__8')") as Uint8Array)).toEqual([255, 255]);
    const key = run("urlBase64ToUint8Array(VAPID_PUBLIC_KEY)") as Uint8Array;
    expect(key.length).toBe(65);
    expect(key[0]).toBe(4);
  });

  it("finds only the brand-new courses", () => {
    expect(run("findNewCourses([{id:'a'}], [{id:'a'},{id:'b'}])")).toEqual([{ id: "b" }]);
    expect(run("findNewCourses([], [{id:'a'}])")).toEqual([{ id: "a" }]);
    expect(run("findNewCourses([{id:'a'}], [{id:'a'}])")).toEqual([]);
  });

  describe("maybeAskNotificationPermission (once-only)", () => {
    function mockNotification(permission: string, result: string) {
      const requestPermission = vi.fn(async () => result);
      (globalThis as any).Notification = { permission, requestPermission };
      return requestPermission;
    }

    it("asks once when permission is still default, then never again", async () => {
      const ask = mockNotification("default", "granted");
      expect(await run("maybeAskNotificationPermission()")).toBe("granted");
      expect(ask).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("tt_web_notif_asked")).toBe("true");
      // Second call (e.g. next sign-in): no second prompt.
      expect(await run("maybeAskNotificationPermission()")).toBe("asked");
      expect(ask).toHaveBeenCalledTimes(1);
    });

    it("never re-prompts a user who denied", async () => {
      const ask = mockNotification("denied", "denied");
      expect(await run("maybeAskNotificationPermission()")).toBe("denied");
      expect(ask).not.toHaveBeenCalled();
      expect(localStorage.getItem("tt_web_notif_asked")).toBeNull();
    });

    it("does not prompt when the Settings toggle is off", async () => {
      const ask = mockNotification("default", "granted");
      run("store.setSettings({notificationsEnabled:false})");
      expect(await run("maybeAskNotificationPermission()")).toBe("off");
      expect(ask).not.toHaveBeenCalled();
    });

    it("reports unsupported when the browser has no Notification API", async () => {
      expect(await run("maybeAskNotificationPermission()")).toBe("unsupported");
    });
  });

  describe("savePushSubscription", () => {
    function mockServiceWorker(existing: any) {
      let lastOpts: any = null;
      const subscribe = vi.fn(async (opts: any) => {
        lastOpts = opts;
        return {
          endpoint: "https://push.example/abc",
          toJSON: () => ({ keys: { p256dh: "p256key", auth: "authkey" } }),
        };
      });
      const reg = {
        pushManager: {
          getSubscription: vi.fn(async () => existing),
          subscribe,
        },
      };
      Object.defineProperty(window.navigator, "serviceWorker", {
        value: { ready: Promise.resolve(reg) },
        configurable: true,
      });
      return { subscribe, reg, getOpts: () => lastOpts };
    }

    function grantPermission() {
      (globalThis as any).Notification = { permission: "granted", requestPermission: vi.fn() };
    }

    it("subscribes with the VAPID key and upserts the subscription", async () => {
      grantPermission();
      const { subscribe, getOpts } = mockServiceWorker(null);
      expect(await run("savePushSubscription()")).toBe(true);
      expect(subscribe).toHaveBeenCalledTimes(1);
      const opts = getOpts();
      expect(opts).not.toBeNull();
      expect(opts.userVisibleOnly).toBe(true);
      expect(opts.applicationServerKey).toBeInstanceOf(Uint8Array);
      expect(opts.applicationServerKey.length).toBe(65);
      expect(query.upsert).toHaveBeenCalledWith(
        { user_id: "test", endpoint: "https://push.example/abc", p256dh: "p256key", auth: "authkey" },
        { onConflict: "endpoint" },
      );
    });

    it("reuses an existing subscription instead of subscribing again", async () => {
      grantPermission();
      const existing = {
        endpoint: "https://push.example/existing",
        toJSON: () => ({ keys: { p256dh: "old-p256", auth: "old-auth" } }),
      };
      const { subscribe } = mockServiceWorker(existing);
      expect(await run("savePushSubscription()")).toBe(true);
      expect(subscribe).not.toHaveBeenCalled();
      expect(query.upsert).toHaveBeenCalledWith(
        { user_id: "test", endpoint: "https://push.example/existing", p256dh: "old-p256", auth: "old-auth" },
        { onConflict: "endpoint" },
      );
    });

    it("fails silently when permission is not granted", async () => {
      (globalThis as any).Notification = { permission: "default", requestPermission: vi.fn() };
      mockServiceWorker(null);
      expect(await run("savePushSubscription()")).toBe(false);
      expect(query.upsert).not.toHaveBeenCalled();
    });

    it("fails silently without a service worker", async () => {
      grantPermission();
      expect(await run("savePushSubscription()")).toBe(false);
      expect(query.upsert).not.toHaveBeenCalled();
    });
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
