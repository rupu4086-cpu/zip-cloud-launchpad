import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const siteHtml = readFileSync("public/technotrade.html", "utf8");
const siteScript = siteHtml.split("<script>")[1]?.split("// ---------- boot ----------")[0];
const adminHtml = readFileSync("public/admin.html", "utf8");
const adminScript = adminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function makeSiteClient() {
  // Test-only mock: `any` keeps the chained Supabase-style query builder
  // type-clean (tsc flags dot access on Record<string, unknown>).
  const query: any = {};
  let result: any = { data: [], error: null };
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.insert = vi.fn(async () => ({ error: null }));
  query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  // Awaiting the chained query resolves the configured result.
  query.then = (resolve: any) => Promise.resolve(result).then(resolve);
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
  return { client, query, channel, setResult: (next: any) => { result = next; } };
}

describe("Support chat — learner website", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeSiteClient>["client"];
  let query: ReturnType<typeof makeSiteClient>["query"];
  let setResult: ReturnType<typeof makeSiteClient>["setResult"];

  beforeEach(() => {
    document.body.innerHTML = siteHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    const made = makeSiteClient();
    client = made.client;
    query = made.query;
    setResult = made.setResult;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!siteScript) throw new Error("Learner script missing");
    run = new Function(`${siteScript}\nreturn code => eval(code);`)();
    run("currentUser = {uid:'u1',id:'u1',displayName:'Learner',email:'learner@example.com'}; isAdmin = false; courses=[]; coursesLoaded=false; subscription=null; supportMessages=null;");
    localStorage.clear();
  });

  it("shows no support email anywhere on user-facing surfaces", () => {
    expect(siteHtml).not.toContain("rupu4086@gmail.com");
    expect(siteHtml).not.toContain("mailto:");
    expect(siteHtml).not.toContain("SUPPORT_EMAIL");
  });

  it("profile shows Chat with us and no email in the footer", () => {
    const html = run("renderProfile()") as string;
    expect(html).toContain("Chat with us");
    expect(html).not.toContain("rupu4086@gmail.com");
    expect(html).toContain("TechnoTrade Academy · Website v");
  });

  it("settings links to the in-app chat instead of email", () => {
    const html = run("renderSettings()") as string;
    expect(html).toContain('href="#/help"');
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("rupu4086@gmail.com");
  });

  it("routes Help & Support to the chat view, not an email app", () => {
    expect(siteScript).toContain('r.name === "help"');
    expect(siteScript).toContain("renderSupportChat()");
    expect(siteScript).not.toContain("mailto:");
  });

  it("normalizes support message rows", () => {
    const row = run("supportMessageRow({id:'m1',user_id:'u1',sender:'admin',message:'Hello',created_at:'2026-11-11T10:00:00.000Z'})") as any;
    expect(row).toEqual({
      id: "m1",
      userId: "u1",
      sender: "admin",
      message: "Hello",
      createdAtMs: Date.parse("2026-11-11T10:00:00.000Z"),
    });
  });

  it("loads only the signed-in user's own messages", async () => {
    setResult({
      data: [{ id: "m1", user_id: "u1", sender: "user", message: "Hi", created_at: "2026-11-11T10:00:00.000Z" }],
      error: null,
    });
    await run("loadSupportMessages()");
    expect(query.eq).toHaveBeenCalledWith("user_id", "u1");
    expect(run("supportMessages")).toEqual([
      { id: "m1", userId: "u1", sender: "user", message: "Hi", createdAtMs: Date.parse("2026-11-11T10:00:00.000Z") },
    ]);
  });

  it("renders user messages on the right and admin replies on the left", () => {
    run("supportMessages = [{id:'m1',userId:'u1',sender:'user',message:'Need help',createdAtMs:1000},{id:'m2',userId:'u1',sender:'admin',message:'Sure, tell me',createdAtMs:2000}];");
    const html = run("renderSupportChat()") as string;
    expect(html).toContain('chat-msg mine">Need help');
    expect(html).toContain('chat-msg theirs">Sure, tell me');
    expect(html).toContain('id="supportInput"');
    expect(html).toContain('id="supportSendBtn"');
  });

  it("escapes message text and shows the empty state with no messages", () => {
    run("supportMessages = [{id:'m1',userId:'u1',sender:'user',message:'<b>bold</b>',createdAtMs:1000}];");
    const html = run("renderSupportChat()") as string;
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    run("supportMessages = [];");
    expect(run("renderSupportChat()") as string).toContain("No messages yet");
  });

  it("sends a message as the signed-in user and clears the input", async () => {
    location.hash = "#/help";
    run("supportMessages = [];");
    document.getElementById("view")!.innerHTML = run("renderSupportChat()") as string;
    (document.getElementById("supportInput") as HTMLInputElement).value = "  Hello admin  ";
    setResult({ data: [], error: null });
    await run("sendSupportMessage()");
    expect(query.insert).toHaveBeenCalledWith({ user_id: "u1", sender: "user", message: "Hello admin" });
    expect((document.getElementById("supportInput") as HTMLInputElement).value).toBe("");
  });

  it("does not send a blank message", async () => {
    run("supportMessages = [];");
    document.getElementById("view")!.innerHTML = run("renderSupportChat()") as string;
    (document.getElementById("supportInput") as HTMLInputElement).value = "   ";
    await run("sendSupportMessage()");
    expect(query.insert).not.toHaveBeenCalled();
  });

  it("subscribes to new support messages for live replies", () => {
    expect(siteScript).toContain('table: "support_messages"');
  });
});

function makeAdminClient() {
  const query: any = {};
  let result: any = { data: [], error: null };
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.insert = vi.fn(async () => ({ error: null }));
  query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  query.then = (resolve: any) => Promise.resolve(result).then(resolve);
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
  return { client, query, setResult: (next: any) => { result = next; } };
}

describe("Support chat — admin panel", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeAdminClient>["client"];
  let query: ReturnType<typeof makeAdminClient>["query"];
  let setResult: ReturnType<typeof makeAdminClient>["setResult"];

  beforeEach(async () => {
    document.body.innerHTML = adminHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    (Element.prototype as any).scrollIntoView = vi.fn();
    const mock = makeAdminClient();
    client = mock.client;
    query = mock.query;
    setResult = mock.setResult;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!adminScript) throw new Error("Admin script missing");
    run = new Function(`${adminScript}\nreturn code => eval(code);`)();
    // The script's top-level refreshAccess() finishes asynchronously and
    // resets isAdmin=false; let it settle first, then grant admin for tests.
    await new Promise((resolve) => setTimeout(resolve, 0));
    run("isAdmin = true;");
  });

  it("adds a Support tab to the panel", () => {
    expect(run("TABS") as unknown[][]).toContainEqual(["support", "Support"]);
    expect(document.getElementById("tabs")?.innerHTML).toContain("Support");
    run("showTab('support')");
    expect(document.querySelector('section[data-sec="support"]')?.classList.contains("hide")).toBe(false);
  });

  it("groups messages into conversations, newest first", () => {
    const rows = [
      { id: "1", user_id: "u1", sender: "user", message: "first", created_at: "2026-11-11T10:00:00.000Z" },
      { id: "2", user_id: "u2", sender: "user", message: "hello", created_at: "2026-11-11T11:00:00.000Z" },
      { id: "3", user_id: "u1", sender: "user", message: "second", created_at: "2026-11-11T12:00:00.000Z" },
    ];
    const convs = run("groupSupportConversations(" + JSON.stringify(rows) + ")") as any[];
    expect(convs.map((c) => c.userId)).toEqual(["u1", "u2"]);
    expect(convs[0].last.message).toBe("second");
    expect(convs[0].unread).toBe(2);
    expect(convs[1].unread).toBe(1);
  });

  it("counts unread as user messages after the last admin reply", () => {
    const rows = [
      { id: "1", user_id: "u1", sender: "user", message: "a", created_at: "2026-11-11T10:00:00.000Z" },
      { id: "2", user_id: "u1", sender: "admin", message: "b", created_at: "2026-11-11T10:30:00.000Z" },
      { id: "3", user_id: "u1", sender: "user", message: "c", created_at: "2026-11-11T11:00:00.000Z" },
      { id: "4", user_id: "u1", sender: "user", message: "d", created_at: "2026-11-11T11:30:00.000Z" },
    ];
    const convs = run("groupSupportConversations(" + JSON.stringify(rows) + ")") as any[];
    expect(convs).toHaveLength(1);
    expect(convs[0].unread).toBe(2);
  });

  it("lists conversations with the learner's email and unread count", async () => {
    client.from.mockImplementation((table: string) => {
      if (table === "support_messages") {
        setResult({
          data: [{ id: "1", user_id: "u1", sender: "user", message: "Need help", created_at: "2026-11-11T10:00:00.000Z" }],
          error: null,
        });
      } else if (table === "users") {
        setResult({ data: [{ id: "u1", email: "learner@example.com", display_name: "Learner" }], error: null });
      }
      return query as never;
    });
    await run("loadSupport()");
    const html = document.getElementById("supportList")?.innerHTML ?? "";
    expect(html).toContain("Learner");
    expect(html).toContain("Need help");
    expect(html).toContain("1 new");
  });

  it("opens a thread with admin replies on the right", async () => {
    client.from.mockImplementation((table: string) => {
      if (table === "support_messages") {
        setResult({
          data: [
            { id: "1", user_id: "u1", sender: "user", message: "Hi", created_at: "2026-11-11T10:00:00.000Z" },
            { id: "2", user_id: "u1", sender: "admin", message: "Hello", created_at: "2026-11-11T10:05:00.000Z" },
          ],
          error: null,
        });
      } else if (table === "users") {
        setResult({ data: [{ id: "u1", email: "learner@example.com", display_name: "Learner" }], error: null });
      }
      return query as never;
    });
    await run("loadSupport()");
    run("openSupportThread('u1')");
    const html = document.getElementById("supportThread")?.innerHTML ?? "";
    expect(html).toContain('chat-msg theirs">Hi');
    expect(html).toContain('chat-msg mine">Hello');
    expect(document.getElementById("supportThreadBox")?.classList.contains("hide")).toBe(false);
  });

  it("sends a reply as admin and clears the box", async () => {
    run("supportOpenUserId = 'u1'; supportRows = [];");
    (document.getElementById("supportReply") as HTMLTextAreaElement).value = "  On it  ";
    setResult({ data: [], error: null });
    // loadSupport() after the send re-reads both tables; keep results empty.
    await run("sendSupportReply()");
    expect(query.insert).toHaveBeenCalledWith({ user_id: "u1", sender: "admin", message: "On it" });
    expect((document.getElementById("supportReply") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not send a blank reply", async () => {
    run("supportOpenUserId = 'u1';");
    (document.getElementById("supportReply") as HTMLTextAreaElement).value = "   ";
    await run("sendSupportReply()");
    expect(query.insert).not.toHaveBeenCalled();
  });
});
