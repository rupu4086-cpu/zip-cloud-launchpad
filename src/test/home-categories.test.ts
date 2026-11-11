import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const learnerHtml = readFileSync("public/technotrade.html", "utf8");
const learnerScript = learnerHtml.split("<script>")[1]?.split("// ---------- boot ----------")[0];
const adminHtml = readFileSync("public/admin.html", "utf8");
const adminScript = adminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("Home categories (learner site)", () => {
  let run: (code: string) => unknown;
  let homeCatRows: Record<string, unknown>[];
  let homeCatError: { message: string } | null;

  function makeLearnerClient() {
    const queryFor = (table: string) => {
      // Test-only mock: `any` keeps the chained Supabase-style query builder
      // type-clean (tsc flags dot access on Record<string, unknown>).
      const query: any = { __table: table };
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.order = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const result =
          table === "home_categories"
            ? { data: homeCatError ? null : homeCatRows, error: homeCatError }
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
    homeCatRows = [];
    homeCatError = null;
    document.body.innerHTML = learnerHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    Object.assign(window, { supabase: { createClient: () => makeLearnerClient() } });
    if (!learnerScript) throw new Error("Learner script missing");
    run = new Function(`${learnerScript}\nreturn code => eval(code);`)();
    run(
      "currentUser = {uid:'test',displayName:'Learner',email:'learner@example.com'}; courses=mergeCourses([{id:'basics',title:'Trading Basics'},{id:'crypto',title:'Crypto Trading'}])",
    );
  });

  it("falls back to the static chips when home_categories is not loaded", () => {
    expect(run("homeCategories=null; activeChips().map(c=>c.label).join(',')")).toBe(
      "All,Stock Market,Charts,Derivatives,Crypto,Risk,Pro",
    );
  });

  it("uses admin-managed categories once they are set", () => {
    expect(
      run("homeCategories=[{label:'Swing',ids:['crypto']}]; activeChips().map(c=>c.label).join(',')"),
    ).toBe("All,Swing");
  });

  it("loads categories from Supabase and falls back when the table is empty", async () => {
    homeCatRows = [{ id: "r1", label: "Swing", course_ids: ["crypto"], sort_order: 1 }];
    await run("loadHomeCategories()");
    expect(run("homeCategories")).toEqual([{ label: "Swing", ids: ["crypto"], description: "" }]);
    homeCatRows = [];
    await run("loadHomeCategories()");
    expect(run("homeCategories")).toBe(null);
  });

  it("keeps the static chips when the categories fetch fails", async () => {
    homeCatError = { message: "boom" };
    await expect(run("loadHomeCategories()")).rejects.toThrow("boom");
    expect(run("homeCategories")).toBe(null);
    expect(run("activeChips().map(c=>c.label).join(',')")).toBe(
      "All,Stock Market,Charts,Derivatives,Crypto,Risk,Pro",
    );
  });

  it("filters courses by an admin-defined chip on Home", () => {
    const html = run(
      "homeCategories=[{label:'Swing',ids:['crypto']}]; homeChip='Swing'; coursesLoaded=true; renderHome()",
    ) as string;
    expect(html).toContain("Swing");
    expect(html).toContain("Crypto Trading");
    expect(html).toContain('data-course="crypto"');
    expect(html).not.toContain('data-course="basics"');
  });
});

describe("Home categories (admin panel)", () => {
  let run: (code: string) => unknown;
  let calls: { table: string; op: string; payload?: unknown; filter?: unknown }[];
  const catRows = [{ id: "c1", label: "Swing", course_ids: ["crypto"], sort_order: 1 }];
  const courseRows = [
    { id: "basics", title: "Trading Basics", order: 1 },
    { id: "crypto", title: "Crypto Trading", order: 2 },
  ];

  function makeAdminClient() {
    const queryFor = (table: string) => {
      // Test-only mock: `any` keeps the chained Supabase-style query builder
      // type-clean (tsc flags dot access on Record<string, unknown>).
      const query: any = { __table: table };
      query.select = vi.fn(() => query);
      query.eq = vi.fn((col: string, val: unknown) => {
        calls.push({ table, op: "eq", filter: { col, val } });
        return query;
      });
      query.order = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.not = vi.fn(() => query);
      query.insert = vi.fn((payload: unknown) => {
        calls.push({ table, op: "insert", payload });
        return query;
      });
      query.update = vi.fn((payload: unknown) => {
        calls.push({ table, op: "update", payload });
        return query;
      });
      query.delete = vi.fn(() => {
        calls.push({ table, op: "delete" });
        return query;
      });
      query.maybeSingle = vi.fn(async () =>
        table === "user_roles"
          ? { data: { role: "admin" }, error: null }
          : { data: null, error: null },
      );
      query.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const data =
          table === "home_categories" ? catRows : table === "courses" ? courseRows : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return query;
    };
    const channel: any = {};
    channel.on = vi.fn(() => channel);
    channel.subscribe = vi.fn(() => channel);
    const client = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "admin-id", email: "rupu4086@gmail.com" } },
          error: null,
        })),
        onAuthStateChange: vi.fn(),
        signInWithOAuth: vi.fn(),
        signInWithPassword: vi.fn(),
        resetPasswordForEmail: vi.fn(),
        signOut: vi.fn(),
      },
      from: vi.fn((table: string) => queryFor(table)),
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
    };
    return client;
  }

  beforeEach(async () => {
    calls = [];
    document.body.innerHTML = adminHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    Object.assign(window, { supabase: { createClient: () => makeAdminClient() } });
    if (!adminScript) throw new Error("Admin script missing");
    run = new Function(`${adminScript}\nreturn code => eval(code);`)();
    await flush();
    await flush();
  });

  it("shows a Categories tab and section for the admin", () => {
    expect(document.querySelector('button[data-tab="categories"]')).not.toBeNull();
    run("showTab('categories')");
    expect(
      document.querySelector('section[data-sec="categories"]')?.classList.contains("hide"),
    ).toBe(false);
    expect(
      document.querySelector('section[data-sec="dashboard"]')?.classList.contains("hide"),
    ).toBe(true);
  });

  it("lists categories with course counts and course checkboxes", () => {
    expect(document.getElementById("catList")?.textContent).toContain("Swing");
    expect(document.getElementById("catList")?.textContent).toContain("1 course");
    expect(document.getElementById("catCourseChecks")?.textContent).toContain("Trading Basics");
    expect(document.getElementById("catCourseChecks")?.textContent).toContain("Crypto Trading");
  });

  it("adds a category with the ticked courses", async () => {
    (document.getElementById("catLabel") as HTMLInputElement).value = "Momentum";
    (
      document.querySelector('input[data-cat-course="crypto"]') as HTMLInputElement
    ).checked = true;
    await run("saveCategory()");
    const insert = calls.find((c) => c.op === "insert" && c.table === "home_categories");
    expect(insert?.payload).toEqual({
      label: "Momentum",
      course_ids: ["crypto"],
      sort_order: 2,
    });
    expect(document.getElementById("catMsg")?.textContent).toContain("Category added");
  });

  it("rejects an empty or duplicate category name", async () => {
    (document.getElementById("catLabel") as HTMLInputElement).value = "  ";
    await run("saveCategory()");
    expect(document.getElementById("catMsg")?.textContent).toContain("Enter a category name");
    expect(calls.filter((c) => c.op === "insert" && c.table === "home_categories")).toHaveLength(0);
    (document.getElementById("catLabel") as HTMLInputElement).value = "swing";
    await run("saveCategory()");
    expect(document.getElementById("catMsg")?.textContent).toContain("already exists");
    expect(calls.filter((c) => c.op === "insert" && c.table === "home_categories")).toHaveLength(0);
  });

  it("deletes a category only after confirm", async () => {
    run("deleteCategory('c1','Swing')");
    expect(document.getElementById("modalBg")?.classList.contains("hide")).toBe(false);
    expect(document.getElementById("modalText")?.textContent).toContain("Swing");
    (document.getElementById("modalOk") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(calls.some((c) => c.op === "delete" && c.table === "home_categories")).toBe(true);
    expect(calls.some((c) => c.op === "eq" && (c.filter as { val: unknown })?.val === "c1")).toBe(
      true,
    );
    expect(document.getElementById("catMsg")?.textContent).toContain("Category deleted");
  });
});
