import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync("public/admin.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function makeClient() {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
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
    document.getElementById<HTMLInputElement>("cfId")!.value = "one-real-course";
    document.getElementById<HTMLInputElement>("cfTitle")!.value = "My Real Course";
    document.getElementById<HTMLTextAreaElement>("cfDesc")!.value = "Added by admin";
    document.getElementById<HTMLInputElement>("cfOrder")!.value = "2";
    document.getElementById<HTMLInputElement>("cfThumb")!.value = "";
    await run("saveCourse()");
    expect(insert).toHaveBeenCalledWith({
      id: "one-real-course",
      title: "My Real Course",
      description: "Added by admin",
      thumbnail_url: "",
      order: 2,
    });
  });
});
