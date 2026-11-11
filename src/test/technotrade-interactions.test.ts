import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync("public/technotrade.html", "utf8");
const script = html.split('<script>')[1]?.split('// ---------- boot ----------')[0];

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

describe("Hosted learner interactions", () => {
  let run: (code: string) => unknown;
  let client: ReturnType<typeof makeLearnerClient>["client"];
  beforeEach(() => {
    document.body.innerHTML = html.split('<body>')[1]?.split('<script>')[0] ?? '';
    window.scrollTo = vi.fn();
    client = makeLearnerClient().client;
    Object.assign(window, { supabase: { createClient: () => client } });
    if (!script) throw new Error("Learner script missing");
    run = new Function(`${script}\nreturn code => eval(code);`)();
    run("currentUser = {uid:'test',displayName:'Learner',email:'learner@example.com'}; courses=mergeCourses([{id:'basics',data:()=>({title:'Admin Course',order:1})}])");
  });

  it("keeps the Courses destination instead of redirecting to Home", () => {
    run("renderBottomNav('home')");
    document.querySelector<HTMLButtonElement>('[data-route="courses"]')?.click();
    expect(location.hash).toBe('#/courses');
  });

  it("shows only courses added in the Admin Dashboard", () => {
    expect(run("mergeCourses([]).length")).toBe(0);
    expect(run("mergeCourses([{id:'x',title:'One'}]).map(c=>c.title).join()")).toBe('One');
  });

  it("opens Notifications from the notification button", () => {
    expect(run("appBar()")).toContain("go('notifications')");
  });

  it("reuses the open course listener across refreshes", () => {
    run("bindDetail('basics'); bindDetail('basics');");
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.channel).toHaveBeenCalledWith("tt-lessons-basics");
  });

  it("shows a plain Buy button without the Already paid section", () => {
    run("location.hash='#/plans'; render()");
    expect(document.querySelector('[data-buy]')?.textContent).toBe('Buy');
    expect(document.getElementById('payIdInput')).toBeNull();
  });

  it("shows the Admin Panel entry only after the admin role loads", () => {
    expect(run("isAdmin=false; renderProfile()")).not.toContain('data-profile="admin"');
    expect(run("isAdmin=true; renderProfile()")).toContain('data-profile="admin"');
  });

  it("closes a dialog with Escape", () => {
    run("openModal('Remove download?')");
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
    expect(document.getElementById('modalBg')?.classList.contains('hide')).toBe(true);
  });

  describe("Email sign-up on the login page", () => {
    const flush = () => new Promise((r) => setTimeout(r, 5));

    function showLogin() {
      run("currentUser = null; location.hash='#/home'; render()");
      expect(document.getElementById("authEmail")).not.toBeNull();
    }

    function fillSignup(name: string, email: string, password: string) {
      (document.getElementById("toggleMode") as HTMLButtonElement).click();
      (document.getElementById("authName") as HTMLInputElement).value = name;
      (document.getElementById("authEmail") as HTMLInputElement).value = email;
      (document.getElementById("authPassword") as HTMLInputElement).value = password;
    }

    function signupButton() {
      return document.getElementById("emailBtn") as HTMLButtonElement;
    }

    function expectSigninMode() {
      expect(document.getElementById("signupNameBox")?.classList.contains("hide")).toBe(true);
      expect(signupButton().textContent).toBe("Sign in");
      expect(document.getElementById("toggleMode")?.textContent).toBe("Create a new account");
      expect(signupButton().disabled).toBe(false);
    }

    it("shows the confirmation message and switches to sign-in when sign-up returns no session", async () => {
      vi.mocked(client.auth.signUp).mockResolvedValue({ data: {}, error: null });
      showLogin();
      fillSignup("Rupu", "new@example.com", "secret123");
      signupButton().click();
      await flush();
      await flush();
      expect(document.querySelector("#authMsg .ok-box")?.textContent).toContain("Account created");
      expect(document.getElementById("authMsg")?.textContent).toContain("confirmation link");
      expect(document.getElementById("authMsg")?.textContent).toContain("new@example.com");
      expectSigninMode();
    });

    it("tells an already-registered email to sign in instead", async () => {
      vi.mocked(client.auth.signUp).mockResolvedValue({
        data: {},
        error: { message: "User already registered" },
      });
      showLogin();
      fillSignup("Rupu", "taken@example.com", "secret123");
      signupButton().click();
      await flush();
      await flush();
      expect(document.getElementById("authMsg")?.textContent).toContain(
        "This email already has an account — sign in instead.",
      );
      expectSigninMode();
    });

    it("leaves the signed-in flow alone when sign-up returns a session", async () => {
      vi.mocked(client.auth.signUp).mockResolvedValue({ data: {}, error: null });
      vi.mocked(client.auth.getSession).mockResolvedValue({
        data: { session: { user: { id: "u1", email: "new@example.com" } } },
        error: null,
      });
      showLogin();
      fillSignup("Rupu", "new@example.com", "secret123");
      signupButton().click();
      await flush();
      await flush();
      expect(document.getElementById("authMsg")?.textContent).toBe("");
      expect(signupButton().disabled).toBe(true);
    });
  });
});