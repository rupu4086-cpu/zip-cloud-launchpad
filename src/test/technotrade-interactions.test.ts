import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync("public/technotrade.html", "utf8");
const script = html.split('<script>')[1]?.split('// ---------- boot ----------')[0];

describe("Hosted learner interactions", () => {
  let run: (code: string) => unknown;
  beforeEach(() => {
    document.body.innerHTML = html.split('<body>')[1]?.split('<script>')[0] ?? '';
    window.scrollTo = vi.fn();
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
    expect(run("mergeCourses([{id:'x',data:()=>({title:'One'})}]).map(c=>c.title).join()")).toBe('One');
  });

  it("opens Notifications from the notification button", () => {
    expect(run("appBar()")).toContain("go('notifications')");
  });

  it("reuses the open course listener across refreshes", () => {
    const count = run(`let listenerCount = 0; db = {collection:()=>({doc:()=>({collection:()=>({orderBy:()=>({onSnapshot:()=>{listenerCount++; return ()=>{};}})})})})}; bindDetail('basics'); bindDetail('basics'); listenerCount;`);
    expect(count).toBe(1);
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
});