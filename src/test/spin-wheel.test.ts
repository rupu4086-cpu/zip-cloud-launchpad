import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const learnerHtml = readFileSync("public/technotrade.html", "utf8");
const learnerScript = learnerHtml.split("<script>")[1]?.split("// ---------- boot ----------")[0];

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("Spin & Win wheel (learner site)", () => {
  let run: (code: string) => unknown;
  let spinRows: Record<string, unknown>[];
  let spinError: { message: string } | null;
  let insertError: { message: string } | null;
  let insertCalls: Record<string, unknown>[];
  let filterCalls: { op: string; col: string; val: unknown }[];

  function makeLearnerClient() {
    const queryFor = (table: string) => {
      // Test-only mock: `any` keeps the chained Supabase-style query builder
      // type-clean (tsc flags dot access on Record<string, unknown>).
      const query: any = { __table: table };
      let inserted = false;
      query.select = vi.fn(() => query);
      query.eq = vi.fn((col: string, val: unknown) => {
        filterCalls.push({ op: "eq", col, val });
        return query;
      });
      query.gte = vi.fn((col: string, val: unknown) => {
        filterCalls.push({ op: "gte", col, val });
        return query;
      });
      query.lt = vi.fn((col: string, val: unknown) => {
        filterCalls.push({ op: "lt", col, val });
        return query;
      });
      query.order = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.insert = vi.fn((payload: unknown) => {
        insertCalls.push(payload as Record<string, unknown>);
        inserted = true;
        return query;
      });
      query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const result = inserted
          ? { data: null, error: insertError }
          : table === "spin_plays"
            ? { data: spinError ? null : spinRows, error: spinError }
            : { data: [], error: null };
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
    spinRows = [];
    spinError = null;
    insertError = null;
    insertCalls = [];
    filterCalls = [];
    document.body.innerHTML = learnerHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    Object.assign(window, { supabase: { createClient: () => makeLearnerClient() } });
    if (!learnerScript) throw new Error("Learner script missing");
    run = new Function(`${learnerScript}\nreturn code => eval(code);`)();
    run(
      "currentUser = {uid:'test',id:'test',displayName:'Learner',email:'learner@example.com'}; courses=mergeCourses([{id:'basics',title:'Trading Basics'},{id:'crypto',title:'Crypto Trading'}]); coursesLoaded=true;",
    );
  });

  it("covers exactly one IST calendar day", () => {
    const r = run("istDayRange()") as { start: string; end: string };
    expect(Date.parse(r.end) - Date.parse(r.start)).toBe(86400000);
    const start = new Date(r.start);
    // 00:00 IST is 18:30 UTC the previous day.
    expect(start.getUTCHours()).toBe(18);
    expect(start.getUTCMinutes()).toBe(30);
    expect(run("istDateStr(new Date(Date.parse('" + r.start + "')))")).toBe(
      run("istDateStr(new Date())"),
    );
  });

  it("finds no spin today when the table has no row for the user", async () => {
    spinRows = [];
    await run("checkTodaySpin()");
    expect(run("spinToday")).toBeNull();
    expect(run("spinPct")).toBe(0);
    const gte = filterCalls.find((c) => c.op === "gte");
    const lt = filterCalls.find((c) => c.op === "lt");
    expect(gte?.col).toBe("spun_at");
    expect(lt?.col).toBe("spun_at");
    expect(gte?.val).toBe((run("istDayRange()") as { start: string }).start);
    expect(lt?.val).toBe((run("istDayRange()") as { end: string }).end);
    expect(filterCalls.some((c) => c.op === "eq" && c.col === "user_id" && c.val === "test")).toBe(
      true,
    );
  });

  it("disables the wheel and shows today's result when the user already spun", async () => {
    spinRows = [{ discount: 50, code: "SPIN50", spun_at: new Date().toISOString() }];
    run("location.hash='#/home'; render()");
    await flush();
    await flush();
    expect(run("spinToday")).toEqual({ discount: 50, code: "SPIN50" });
    expect(run("spinPct")).toBe(50);
    expect(run("spinCode")).toBe("SPIN50");
    expect((document.getElementById("spinBtn") as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("spinResult")?.textContent).toContain("You won 50% OFF");
    expect(document.getElementById("spinResult")?.textContent).toContain("SPIN50");
    expect(document.getElementById("spinResult")?.textContent).toContain("come back tomorrow");
  });

  it("leaves the wheel open when today's check fails", async () => {
    spinError = { message: "table missing" };
    await run("checkTodaySpin()");
    expect(run("spinToday")).toBeNull();
    expect(run("spinPct")).toBe(0);
  });

  it("records the spin, shows the result, then takes the user to Plans", async () => {
    vi.useFakeTimers();
    try {
      run("location.hash='#/home'; render()");
      await vi.advanceTimersByTimeAsync(0);
      await run("applySpinResult(40)");
      expect(insertCalls).toEqual([{ user_id: "test", discount: 40, code: "SPIN40" }]);
      expect(run("spinPct")).toBe(40);
      expect(run("spinCode")).toBe("SPIN40");
      expect(run("spinToday")).toEqual({ discount: 40, code: "SPIN40" });
      expect(document.getElementById("spinResult")?.textContent).toContain("You won 40% OFF");
      expect(document.getElementById("spinResult")?.textContent).toContain("SPIN40");
      // The result stays visible on the wheel card first; navigation follows.
      expect(location.hash).not.toBe("#/plans");
      await vi.advanceTimersByTimeAsync(1400);
      expect(location.hash).toBe("#/plans");
      // Plans shows the discount with the code banner.
      run("render()");
      expect(document.querySelector("#view")?.textContent).toContain("SPIN40");
      expect(document.querySelector("#view")?.textContent).toContain("₹600");
      expect(document.querySelector("#view")?.textContent).toContain("₹1,800");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies no discount and shows a retry message when the save fails", async () => {
    insertError = { message: "insert blocked" };
    run("location.hash='#/home'; render()");
    await flush();
    await flush();
    await run("applySpinResult(40)");
    expect(insertCalls).toEqual([{ user_id: "test", discount: 40, code: "SPIN40" }]);
    expect(run("spinPct")).toBe(0);
    expect(run("spinCode")).toBe("");
    expect(run("spinToday")).toBeNull();
    expect(document.getElementById("spinResult")?.textContent).toContain("try again");
    expect(location.hash).not.toBe("#/plans");
  });

  it("does not let an already-spun user spin again", () => {
    run("spinToday={discount:40,code:'SPIN40'}; spinPct=40; spinCode='SPIN40'; wheelAngle=123;");
    run("spinWheel()");
    expect(insertCalls).toHaveLength(0);
    expect(run("wheelAngle")).toBe(123);
  });

  it("spins the wheel end to end: animation finishes, save succeeds, user lands on Plans", async () => {
    vi.useFakeTimers();
    try {
      run("location.hash='#/home'; render()");
      await vi.advanceTimersByTimeAsync(0);
      run("spinWheel()");
      expect(run("wheelSpinning")).toBe(true);
      await vi.advanceTimersByTimeAsync(4600); // animation fallback timeout
      await vi.advanceTimersByTimeAsync(0); // flush the recordSpin microtasks
      expect(insertCalls).toHaveLength(1);
      const saved = insertCalls[0] as { user_id: unknown; discount: number; code: string };
      expect(saved.user_id).toBe("test");
      expect([40, 50]).toContain(saved.discount);
      expect(saved.code).toBe("SPIN" + saved.discount);
      expect(run("spinPct")).toBe(saved.discount);
      expect(location.hash).not.toBe("#/plans");
      await vi.advanceTimersByTimeAsync(1400);
      expect(location.hash).toBe("#/plans");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a fresh sign-in to Home but keeps deep links and returning sessions", () => {
    run("location.hash='#/courses'");
    run("landOnHomeAfterSignIn('SIGNED_IN')");
    expect(location.hash).toBe("#/home");
    run("location.hash='#/courses'");
    run("landOnHomeAfterSignIn('INITIAL_SESSION')");
    expect(location.hash).toBe("#/courses");
    run("location.hash='#/course/basics'");
    run("landOnHomeAfterSignIn('SIGNED_IN')");
    expect(location.hash).toBe("#/course/basics");
  });

  it("draws the wheel sharp on retina: backing store = CSS size x devicePixelRatio", () => {
    run("location.hash='#/home'; render()");
    const cv = document.getElementById("wheelCanvas") as HTMLCanvasElement;
    expect(cv).not.toBeNull();
    const fakeCtx: any = {};
    [
      "clearRect",
      "beginPath",
      "moveTo",
      "arc",
      "closePath",
      "fill",
      "stroke",
      "save",
      "translate",
      "rotate",
      "fillText",
      "restore",
    ].forEach((m) => {
      fakeCtx[m] = vi.fn();
    });
    fakeCtx.setTransform = vi.fn();
    vi.spyOn(cv, "getContext").mockReturnValue(
      fakeCtx as unknown as CanvasRenderingContext2D,
    );
    const rect = (w: number) =>
      ({
        width: w,
        height: w,
        top: 0,
        left: 0,
        right: w,
        bottom: w,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    const rectSpy = vi.spyOn(cv, "getBoundingClientRect").mockReturnValue(rect(280));
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    try {
      run("drawWheel()");
      expect(cv.width).toBe(560);
      expect(cv.height).toBe(560);
      expect(fakeCtx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
      // A wider display (resize) re-sizes the backing store.
      rectSpy.mockReturnValue(rect(296));
      window.dispatchEvent(new window.Event("resize"));
      expect(cv.width).toBe(592);
      expect(cv.height).toBe(592);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    }
  });
});

describe("Home parity with the preview", () => {
  let run: (code: string) => unknown;

  function makeLearnerClient() {
    const queryFor = (table: string) => {
      // Test-only mock: `any` keeps the chained Supabase-style query builder
      // type-clean (tsc flags dot access on Record<string, unknown>).
      const query: any = { __table: table };
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.gte = vi.fn(() => query);
      query.lt = vi.fn(() => query);
      query.order = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.insert = vi.fn(() => query);
      query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const result =
          table === "spin_plays" ? { data: [], error: null } : { data: [], error: null };
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

  const eightCourses =
    "courses=mergeCourses([{id:'basics',title:'Trading Basics'},{id:'technical-analysis',title:'Technical Analysis'},{id:'options',title:'Options Trading'},{id:'futures',title:'Futures Trading'},{id:'crypto',title:'Crypto Trading'},{id:'risk-management',title:'Risk Management'},{id:'big-trader-strategies',title:'Big Trader Strategies'},{id:'small-capital-growth',title:'$100 to $2000 — Real Math'}]); coursesLoaded=true;";

  beforeEach(() => {
    document.body.innerHTML = learnerHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    Object.assign(window, { supabase: { createClient: () => makeLearnerClient() } });
    if (!learnerScript) throw new Error("Learner script missing");
    run = new Function(`${learnerScript}\nreturn code => eval(code);`)();
    run(
      "currentUser = {uid:'test',id:'test',displayName:'Learner',email:'learner@example.com'}; " +
        eightCourses,
    );
  });

  it("shows the preview's exact spin card copy", () => {
    const html = run("homeCategories=null; renderHome()") as string;
    expect(html).toContain("Spin &amp; Win — 5% to 50% off");
    expect(html).toContain(
      "Spin once to receive a discount between 5% and 50%. It applies to the plans below — the Monthly plan and the Per-Course 1-Year plan.",
    );
    expect(html).toContain(
      "One spin per user · 5%–50% off · Valid on Monthly All-Access and Per-Course 1-Year plans",
    );
  });

  it("shows 5% to 50% on the wheel but only ever lands on 40 or 50", () => {
    expect(run("WHEEL_VALUES")).toEqual([5, 10, 20, 30, 40, 50]);
    expect(run("WHEEL_WEIGHTS")).toEqual([0, 0, 0, 0, 0.5, 0.5]);
  });

  it("shows the offer countdown on the wheel card", () => {
    run("homeCategories=null; location.hash='#/home'; render()");
    const el = document.getElementById("offerCountdown");
    expect(el).not.toBeNull();
    // Offer ends 20 Nov 2026 23:59 IST; while it is live the countdown shows days + hours + mins + secs.
    expect(el?.textContent).toMatch(/Offer ends in \d+d \d+h \d+m \d+s/);
  });

  it("renders categories as cards in a 2-column grid with descriptions and counts", () => {
    run(
      "homeCategories=[{label:'Stock Market',ids:['basics'],description:'Demat, orders, market timing — start from zero.'},{label:'Pro',ids:['big-trader-strategies','small-capital-growth'],description:'How big traders make profit + the $100 to $2000 math.'}]; location.hash='#/home'; render()",
    );
    const cards = document.querySelectorAll(".cat-card");
    expect(cards).toHaveLength(2);
    expect(document.querySelector(".cat-grid")).not.toBeNull();
    expect(document.querySelector(".chips")).toBeNull();
    expect(cards[0]?.textContent).toContain("Stock Market");
    expect(cards[0]?.textContent).toContain("Demat, orders, market timing — start from zero.");
    expect(cards[1]?.textContent).toContain("Pro");
    expect(cards[1]?.textContent).toContain("How big traders make profit + the $100 to $2000 math.");
    // Cards show icon + title + description only — no course count.
    expect(document.querySelectorAll(".cat-count")).toHaveLength(0);
    expect(cards[0]?.textContent).not.toContain("1 course");
    expect(cards[1]?.textContent).not.toContain("2 courses");
    expect(cards[0]?.querySelector("svg")).not.toBeNull();
  });

  it("falls back to the same 6 categories with the seeded descriptions", () => {
    run("homeCategories=null; location.hash='#/home'; render()");
    const cards = document.querySelectorAll(".cat-card");
    expect(cards).toHaveLength(6);
    const text = document.querySelector(".cat-grid")?.textContent || "";
    expect(text).toContain("Candles, trend lines, chart patterns, indicators.");
    expect(text).toContain("Options & Futures — Greeks, hedging, expiry strategies.");
    // No count on the cards; the count lives in the courses-section heading.
    expect(document.querySelectorAll(".cat-count")).toHaveLength(0);
    const head = [...document.querySelectorAll(".sechd")].find((el) =>
      el.textContent?.includes("live course"),
    );
    expect(head?.textContent).toContain("All Courses");
    expect(head?.textContent).toContain("8 live courses");
  });

  it("keeps the All Courses heading with 8 live courses", () => {
    run("homeCategories=null; location.hash='#/home'; render()");
    const head = [...document.querySelectorAll(".sechd")].find((el) =>
      el.textContent?.includes("All Courses"),
    );
    expect(head).not.toBeUndefined();
    expect(head?.textContent).toContain("8 live courses");
  });

  it("tapping a card filters the course list, tapping again clears it", () => {
    const courseHead = () =>
      [...document.querySelectorAll(".sechd")].find((el) =>
        el.textContent?.includes("live course"),
      );
    run("homeCategories=null; location.hash='#/home'; render()");
    expect(document.querySelectorAll("[data-course]")).toHaveLength(8);
    expect(courseHead()?.textContent).toContain("All Courses");
    expect(courseHead()?.textContent).toContain("8 live courses");
    (document.querySelector('[data-chip="Stock Market"]') as HTMLButtonElement).click();
    expect(document.querySelectorAll("[data-course]")).toHaveLength(1);
    expect(document.querySelector('[data-course="basics"]')).not.toBeNull();
    expect(courseHead()?.textContent).toContain("Stock Market");
    expect(courseHead()?.textContent).toContain("1 live course");
    (document.querySelector('[data-chip="Stock Market"]') as HTMLButtonElement).click();
    expect(document.querySelectorAll("[data-course]")).toHaveLength(8);
    expect(courseHead()?.textContent).toContain("All Courses");
    expect(courseHead()?.textContent).toContain("8 live courses");
  });

  it("shows the category name in the Courses tab heading while filtered", () => {
    const courseHead = () =>
      [...document.querySelectorAll(".sechd")].find((el) =>
        el.textContent?.includes("live course"),
      );
    run("homeCategories=null; location.hash='#/courses'; render()");
    expect(courseHead()?.textContent).toContain("All Courses");
    (document.querySelector('[data-chip="Charts"]') as HTMLButtonElement).click();
    expect(courseHead()?.textContent).toContain("Charts");
    expect(courseHead()?.textContent).toContain("1 live course");
    (document.querySelector('[data-chip="Charts"]') as HTMLButtonElement).click();
    expect(courseHead()?.textContent).toContain("All Courses");
    expect(courseHead()?.textContent).toContain("8 live courses");
  });

  it("keeps the phone layout inside 390px: grid uses minmax(0,1fr), wheel is capped", () => {
    const style = learnerHtml.split("<style>")[1]?.split("</style>")[0] ?? "";
    expect(style).toContain(".cat-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(style).toContain(".cat-card{min-width:0");
    expect(style).toContain(".wheel-wrap{position:relative;width:280px;max-width:76vw");
    expect(style).toContain(".cat-desc{");
    expect(style).toContain("-webkit-line-clamp:3");
  });
});
