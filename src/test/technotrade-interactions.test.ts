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
    run("currentUser = {uid:'test',displayName:'Learner',email:'learner@example.com'}; courses=mergeCourses([])");
  });

  it("keeps the Courses destination instead of redirecting to Home", () => {
    run("renderBottomNav('home')");
    document.querySelector<HTMLButtonElement>('[data-route="courses"]')?.click();
    expect(location.hash).toBe('#/courses');
  });

  it("opens Notifications from the notification button", () => {
    expect(run("appBar()")).toContain("go('notifications')");
  });

  it("reuses the open course listener across refreshes", () => {
    run(`let listenerCount = 0; db = {collection:()=>({doc:()=>({collection:()=>({orderBy:()=>({onSnapshot:()=>{listenerCount++; return ()=>{};}})})})})}; bindDetail('basics'); bindDetail('basics');`);
    expect(run("listenerCount")).toBe(1);
  });

  it("preserves typed payment input during screen refresh", () => {
    run("location.hash='#/plans'; render(); document.getElementById('payIdInput').value='pay_user_input'; render()");
    expect(document.querySelector<HTMLInputElement>('#payIdInput')?.value).toBe('pay_user_input');
  });

  it("closes a dialog with Escape", () => {
    run("openModal('Remove download?')");
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
    expect(document.getElementById('modalBg')?.classList.contains('hide')).toBe(true);
  });
});