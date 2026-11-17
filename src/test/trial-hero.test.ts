import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const learnerHtml = readFileSync("public/technotrade.html", "utf8");
const learnerScript = learnerHtml.split("<script>")[1]?.split("// ---------- boot ----------")[0];

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("Trial hero + paywall (learner site)", () => {
  let run: (code: string) => unknown;
  let trialRow: Record<string, unknown> | null;
  let freeViewsRow: Record<string, unknown> | null;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let signInWithOtp: ReturnType<typeof vi.fn>;

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
      query.update = vi.fn(() => query);
      query.upsert = vi.fn(() => query);
      query.delete = vi.fn(() => query);
      query.maybeSingle = vi.fn(async () => {
        if (table === "trial_subscriptions") return { data: trialRow, error: null };
        if (table === "free_video_views") return { data: freeViewsRow, error: null };
        return { data: null, error: null };
      });
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      };
      return query;
    };
    const channel: any = {};
    channel.on = vi.fn(() => channel);
    channel.subscribe = vi.fn(() => channel);
    const client = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "tok_test" } },
          error: null,
        })),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
        signInWithOAuth: vi.fn(),
        signInWithPassword: vi.fn(),
        signUp: vi.fn(),
        signInWithOtp,
        verifyOtp: vi.fn(),
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
    trialRow = null;
    freeViewsRow = null;
    fetchSpy = vi.fn(async () => ({ status: 404, ok: false, json: async () => ({}) }));
    signInWithOtp = vi.fn(async () => ({ error: { message: "phone provider not configured" } }));
    document.body.innerHTML = learnerHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    Object.assign(window, {
      supabase: { createClient: () => makeLearnerClient() },
      fetch: fetchSpy,
    });
    localStorage.clear();
    sessionStorage.clear();
    location.hash = "#/home";
    if (!learnerScript) throw new Error("Learner script missing");
    run = new Function(`${learnerScript}\nreturn code => eval(code);`)();
    run(
      "currentUser = {uid:'test',id:'test',displayName:'Learner',email:'learner@example.com'}; " +
        eightCourses,
    );
  });

  it("keeps the IST day helpers: exactly one IST calendar day", () => {
    const r = run("istDayRange()") as { start: string; end: string };
    expect(Date.parse(r.end) - Date.parse(r.start)).toBe(86400000);
    const start = new Date(r.start);
    // 00:00 IST is 18:30 UTC the previous day.
    expect(start.getUTCHours()).toBe(18);
    expect(start.getUTCMinutes()).toBe(30);
  });

  it("guest home shows the trial hero with the exact paywall line", () => {
    const html = run("currentUser=null; location.hash='#/home'; renderHome()") as string;
    expect(html).toContain("Learn everything for ₹1");
    expect(html).toContain(
      "₹1 today. ₹399 will be charged automatically tomorrow — 1 month access, then it ends. No further charge.",
    );
    expect(html).toContain("Start ₹1 trial");
    expect(html).toContain("One trial per account. Payment via UPI or card.");
    // No removed system survives on Home.
    expect(html).not.toContain("Spin");
    expect(html).not.toContain("wheel");
    expect(html).not.toContain("Refer");
    expect(html).not.toContain("Wallet");
    expect(html).not.toContain("learning path");
  });

  it("trial-active hero shows the end date, time left and Continue learning", () => {
    const ends = Date.now() + 12 * 3600 * 1000;
    run(
      "trialStatus={id:'t1',status:'trial_active',trialEndsAtMs:" +
        ends +
        ",chargeAtMs:" +
        ends +
        ",chargePaymentId:null};",
    );
    const html = run("renderHome()") as string;
    expect(html).toContain("Trial active — keep learning");
    expect(html).toContain("Continue learning");
    expect(html).toContain("₹399 will be charged automatically then");
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain("Start ₹1 trial");
  });

  it("a failed trial never offers a second trial — Monthly nudge instead", () => {
    run("trialStatus={id:'t1',status:'charge_failed',trialEndsAtMs:0,chargeAtMs:0,chargePaymentId:null};");
    const html = run("renderHome()") as string;
    expect(html).toContain("didn't go through");
    expect(html).toContain("Monthly");
    expect(html).not.toContain("Start ₹1 trial");
  });

  it("trial access is time-boxed: active trial opens courses, Yearly-only stays locked", () => {
    const ends = Date.now() + 3600 * 1000;
    run(
      "trialStatus={id:'t1',status:'trial_active',trialEndsAtMs:" +
        ends +
        ",chargeAtMs:" +
        ends +
        ",chargePaymentId:null};",
    );
    expect(run("access().hasTrialAccess")).toBe(true);
    expect(run("access().hasAccess")).toBe(true);
    expect(run("access().planId")).toBe("monthly");
    expect(run("canOpenCourse('basics')")).toBe(true);
    expect(run("canOpenCourse('big-trader-strategies')")).toBe(false);
  });

  it("an expired trial grants no access", () => {
    const ends = Date.now() - 1000;
    run(
      "trialStatus={id:'t1',status:'trial_active',trialEndsAtMs:" +
        ends +
        ",chargeAtMs:" +
        ends +
        ",chargePaymentId:null};",
    );
    expect(run("access().hasTrialAccess")).toBe(false);
    expect(run("access().hasAccess")).toBe(false);
  });

  it("locked episode tap opens the paywall sheet with the exact charge line and a real charge date", async () => {
    // Quota exhausted, so the tap does not spend a free video.
    freeViewsRow = { videos_watched: 3 };
    run(
      "detailLessons={basics:[normalizeLesson({id:'l1',course_id:'basics',title:'Ep 1',video_url:'https://example.com/v.mp4',duration_sec:120,order:0}),normalizeLesson({id:'l2',course_id:'basics',title:'Ep 2',video_url:'https://example.com/v2.mp4',duration_sec:130,order:1})]};",
    );
    run("location.hash='#/course/basics'; render()");
    expect(document.querySelector('[data-lesson="l1"]')).not.toBeNull();
    (document.querySelector('[data-lesson="l1"]') as HTMLElement).click();
    await flush();
    await flush();
    const sheet = document.getElementById("paywallRoot")?.textContent || "";
    expect(sheet).toContain("Start learning for ₹1");
    expect(sheet).toContain(
      "₹1 today, ₹399 will be charged automatically tomorrow, 1 month access, then it ends — no further charge.",
    );
    expect(sheet).toMatch(/₹399 will be charged on \d{1,2} \w{3} \d{4}/);
    expect(sheet).toContain("Pay ₹1 and start");
    expect(document.querySelector(".paywall-sheet")?.getAttribute("role")).toBe("dialog");
    expect(document.querySelectorAll('.method-row input[type="radio"]')).toHaveLength(2);
    // Close returns focus and clears the sheet.
    (document.getElementById("paywallClose") as HTMLButtonElement).click();
    expect(document.getElementById("paywallRoot")?.textContent).toBe("");
  });

  it("trial start fails honestly when the edge function is not deployed (404)", async () => {
    run("openPaywall({reason:'hero'})");
    (document.getElementById("paywallCta") as HTMLButtonElement).click();
    await flush();
    await flush();
    await flush();
    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]![0] as string).toContain("/trial/create");
    expect(document.getElementById("paywallMsg")?.textContent).toContain("being set up");
    expect(run("access().hasAccess")).toBe(false);
    expect(run("trialStatus")).toBeNull();
  });

  it("guests browse home, courses, course detail and search without signing in", () => {
    run("currentUser=null; location.hash='#/home'; render()");
    expect(document.getElementById("authEmail")).toBeNull();
    expect(document.querySelector("#view")?.textContent).toContain("Learn everything for ₹1");
    run("location.hash='#/courses'; render()");
    expect(document.getElementById("authEmail")).toBeNull();
    expect(document.querySelector("#view")?.textContent).toContain("All Courses");
    run("location.hash='#/course/basics'; render()");
    expect(document.getElementById("authEmail")).toBeNull();
    expect(document.querySelector("#view")?.textContent).toContain("All Episodes");
    run("location.hash='#/search'; render()");
    expect(document.getElementById("authEmail")).toBeNull();
    expect(document.querySelector("#view")?.textContent).toContain("Trending searches");
  });

  it("guests hitting Plans or Profile get the login screen", () => {
    run("currentUser=null; location.hash='#/plans'; render()");
    expect(document.getElementById("authEmail")).not.toBeNull();
    run("location.hash='#/profile'; render()");
    expect(document.getElementById("authEmail")).not.toBeNull();
  });

  it("removed routes redirect to Home", () => {
    for (const route of ["#/refer", "#/wallet", "#/downloads"]) {
      run(`location.hash='${route}'; render()`);
      expect(location.hash).toBe("#/home");
    }
  });

  it("no spin, referral, wallet or download code remains in the learner script", () => {
    const script = learnerScript ?? "";
    for (const gone of [
      "spinPct",
      "spinWheel",
      "checkTodaySpin",
      "spin_plays",
      "renderRefer",
      "renderWallet",
      "maybeRewardReferral",
      "maybeAttributeReferral",
      "parseReferralCodeFromUrl",
      "referral_codes",
      "wallet_transactions",
      "startDownload",
      "renderDownloads",
      "loadWallet",
    ]) {
      expect(script).not.toContain(gone);
    }
    expect(learnerHtml).not.toContain(".wheel-card");
    expect(learnerHtml).not.toContain("wheelCanvas");
  });

  it("course tiles show no ratings or stars, and locked tiles carry a TRIAL badge", () => {
    run("lessonStats={basics:{count:5,totalDurationSec:780}};");
    const html = run("renderHome()") as string;
    expect(html).not.toContain("★");
    expect(html).not.toContain("ratings");
    expect(html).toContain("TRIAL");
    expect(html).toContain("5 episodes");
  });

  it("Plans shows the trial card on top and only the ₹399 Monthly card", () => {
    run("location.hash='#/plans'; render()");
    const text = document.querySelector("#view")?.textContent || "";
    expect(text).toContain("Learn everything for ₹1");
    expect(text).not.toContain("₹1,000");
    expect(text).not.toContain("₹3,000");
    expect(text).not.toContain("SPIN");
    expect(text).not.toContain("% off");
    // Trial card comes before the Monthly plan card in the DOM.
    const trialPos = text.indexOf("Learn everything for ₹1");
    const monthlyPos = text.indexOf("MONTHLY");
    expect(trialPos).toBeGreaterThan(-1);
    expect(monthlyPos).toBeGreaterThan(-1);
    expect(trialPos).toBeLessThan(monthlyPos);
    // Only the Monthly card is sold on Plans; Yearly stays in the system.
    expect(document.querySelector('[data-plancard="monthly"]')?.textContent).toContain("₹399");
    expect(document.querySelector('[data-plancard="yearly"]')).toBeNull();
  });

  it("Profile shows the name, Library + Subscriptions rows, and no Refer/Wallet rows", () => {
    run(
      "subscription=normalizeSubscription({id:'s1',user_id:'u1',plan_id:'monthly',status:'active',expires_at:new Date(Date.now()+86400000).toISOString(),created_at:new Date().toISOString()});",
    );
    run("location.hash='#/profile'; render()");
    const text = document.querySelector("#view")?.textContent || "";
    expect(text).toContain("Learner");
    expect(text).not.toContain("Wallet Balance");
    expect(document.querySelector('[data-profile="library"]')).not.toBeNull();
    expect(document.querySelector('[data-profile="subscriptions"]')).not.toBeNull();
    expect(document.querySelector('[data-profile="refer"]')).toBeNull();
    expect(document.querySelector('[data-profile="wallet"]')).toBeNull();
    expect(document.querySelector('[data-profile="downloads"]')).toBeNull();
    // Subscription card states the non-renewal fact.
    expect(text).toContain("Will not renew — no further charge after your access ends.");
  });

  it("Search screen shows trending searches and search-by-category", () => {
    run("location.hash='#/search'; render()");
    const text = document.querySelector("#view")?.textContent || "";
    expect(text).toContain("Trending searches");
    expect(text).toContain("Search by category");
    expect(document.querySelector('[data-trend="Options trading"]')).not.toBeNull();
  });

  it("Search finds courses and shows a no-results state with categories", () => {
    run("searchQuery='crypto'; location.hash='#/search'; render()");
    expect(document.querySelector('[data-course="crypto"]')).not.toBeNull();
    expect(document.querySelector('[data-course="basics"]')).toBeNull();
    run("searchQuery='zzzznope'; render()");
    expect(document.querySelector("#view")?.textContent).toContain("No courses found");
    expect(document.querySelector("#view")?.textContent).toContain("Search by category");
  });

  it("Library empty state is plain text with one action, never a dead end", () => {
    run("location.hash='#/library'; render()");
    const text = document.querySelector("#view")?.textContent || "";
    expect(text).toContain("Nothing saved yet");
    expect(text).toContain("Browse courses");
  });

  it("guest free quota starts at 3 and is consumed one video at a time", async () => {
    run("currentUser=null;");
    expect(run("guestFreeLeft()")).toBe(3);
    await run("consumeFreeView()");
    expect(run("guestFreeLeft()")).toBe(2);
  });

  it("player shows like, bookmark, share and speed controls when unlocked", () => {
    run(
      "subscription={planId:'monthly',status:'active',expiresAt:{toDate:()=>new Date(Date.now()+86400000)}};" +
        "detailLessons={basics:[normalizeLesson({id:'l1',course_id:'basics',title:'Ep 1',video_url:'https://example.com/v.mp4',duration_sec:120,order:0}),normalizeLesson({id:'l2',course_id:'basics',title:'Ep 2',video_url:'https://example.com/v2.mp4',duration_sec:130,order:1})]};",
    );
    run("location.hash='#/lesson/basics/l1'; render()");
    expect(document.getElementById("lessonVideo")).not.toBeNull();
    expect(document.getElementById("likeBtn")).not.toBeNull();
    expect(document.getElementById("bookmarkBtn")).not.toBeNull();
    expect(document.getElementById("shareLessonBtn")).not.toBeNull();
    expect(document.querySelectorAll("[data-speed]")).toHaveLength(4);
    expect(document.querySelector('[data-upnext="l2"]')).not.toBeNull();
    // Bookmarking saves the course to the library.
    (document.getElementById("bookmarkBtn") as HTMLButtonElement).click();
    expect(document.getElementById("bookmarkBtn")?.textContent).toContain("Saved");
    run("location.hash='#/library'; render()");
    expect(document.querySelector("#view")?.textContent).toContain("Trading Basics");
  });

  it("player locks a lesson with the trial CTA and a free-preview button", () => {
    run(
      "detailLessons={basics:[normalizeLesson({id:'l1',course_id:'basics',title:'Ep 1',video_url:'https://example.com/v.mp4',duration_sec:120,order:0})]};",
    );
    run("location.hash='#/lesson/basics/l1'; render()");
    expect(document.getElementById("lessonVideo")).toBeNull();
    expect(document.getElementById("lockedTrialBtn")).not.toBeNull();
    expect(document.getElementById("freePreviewBtn")).not.toBeNull();
  });

  it("login offers Mobile OTP as a second method and says honestly when it is not set up", async () => {
    run("currentUser=null; location.hash='#/profile'; render()");
    const phoneTab = document.querySelector('[data-method="phone"]') as HTMLButtonElement;
    expect(phoneTab).not.toBeNull();
    phoneTab.click();
    expect(document.getElementById("phoneAuthBox")?.classList.contains("hide")).toBe(false);
    expect(document.getElementById("emailAuthBox")?.classList.contains("hide")).toBe(true);
    (document.getElementById("authPhone") as HTMLInputElement).value = "9876543210";
    (document.getElementById("sendOtpBtn") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(signInWithOtp).toHaveBeenCalledWith({ phone: "+919876543210" });
    expect(document.getElementById("authMsg")?.textContent).toContain("not set up yet");
  });

  it("signup form has no referral code field and no ?ref= handling", () => {
    run("currentUser=null; location.hash='#/profile'; render()");
    expect(document.getElementById("authRefCode")).toBeNull();
    expect(document.getElementById("signupRefBox")).toBeNull();
  });
});

describe("Home parity with the preview (redesign)", () => {
  let run: (code: string) => unknown;

  function makeLearnerClient() {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.gte = vi.fn(() => query);
    query.lt = vi.fn(() => query);
    query.order = vi.fn(() => query);
    query.limit = vi.fn(() => query);
    query.insert = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
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
      from: vi.fn(() => query),
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
    localStorage.clear();
    sessionStorage.clear();
    location.hash = "#/home";
    if (!learnerScript) throw new Error("Learner script missing");
    run = new Function(`${learnerScript}\nreturn code => eval(code);`)();
    run(
      "currentUser = {uid:'test',id:'test',displayName:'Learner',email:'learner@example.com'}; " +
        eightCourses,
    );
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
    const courseIds = () =>
      new Set(
        [...document.querySelectorAll("[data-course]")].map(
          (el) => (el as HTMLElement).dataset["course"],
        ),
      );
    const courseHead = () =>
      [...document.querySelectorAll(".sechd")].find((el) =>
        el.textContent?.includes("live course"),
      );
    run("homeCategories=null; location.hash='#/home'; render()");
    expect(courseIds().size).toBe(8);
    expect(courseHead()?.textContent).toContain("All Courses");
    expect(courseHead()?.textContent).toContain("8 live courses");
    (document.querySelector('[data-chip="Stock Market"]') as HTMLButtonElement).click();
    expect(courseIds().size).toBe(1);
    expect(courseIds().has("basics")).toBe(true);
    expect(courseHead()?.textContent).toContain("Stock Market");
    expect(courseHead()?.textContent).toContain("1 live course");
    (document.querySelector('[data-chip="Stock Market"]') as HTMLButtonElement).click();
    expect(courseIds().size).toBe(8);
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

  it("keeps the phone layout inside 390px: grid uses minmax(0,1fr)", () => {
    const style = learnerHtml.split("<style>")[1]?.split("</style>")[0] ?? "";
    expect(style).toContain(".cat-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(style).toContain(".cat-card{min-width:0");
    expect(style).toContain(".cat-desc{");
    expect(style).toContain("-webkit-line-clamp:3");
  });
});
