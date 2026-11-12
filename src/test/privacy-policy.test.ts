import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const siteHtml = readFileSync("public/technotrade.html", "utf8");
const siteScript = siteHtml.split("<script>")[1]?.split("// ---------- boot ----------")[0];
const policyHtml = readFileSync("public/privacy-policy.html", "utf8");

describe("Privacy policy — sign-up page link", () => {
  let run: (code: string) => unknown;

  beforeEach(() => {
    document.body.innerHTML = siteHtml.split("<body>")[1]?.split("<script>")[0] ?? "";
    window.scrollTo = vi.fn();
    Object.assign(window, { supabase: { createClient: () => ({}) } });
    if (!siteScript) throw new Error("Learner script missing");
    run = new Function(`${siteScript}\nreturn code => eval(code);`)();
  });

  it("sign-up page links to the Privacy Policy in a new tab", () => {
    const html = run("renderLogin()") as string;
    expect(html).toContain('href="/privacy-policy.html"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain("Privacy Policy");
    // The line sits under the form (after the sign-in/create-account button),
    // and the auth markup is shared, so it shows in both signup and signin modes.
    expect(html.indexOf("privacy-policy.html")).toBeGreaterThan(html.indexOf('id="emailBtn"'));
    expect(html.indexOf("privacy-policy.html")).toBeGreaterThan(html.indexOf('id="resetPw"'));
  });

  it("sign-up form fields and order are unchanged", () => {
    const html = run("renderLogin()") as string;
    // Name -> Email -> Password -> Referral code (last) -> Create account.
    const nameIdx = html.indexOf('id="signupNameBox"');
    const emailIdx = html.indexOf('id="authEmail"');
    const pwIdx = html.indexOf('id="authPassword"');
    const refIdx = html.indexOf('id="signupRefBox"');
    const btnIdx = html.indexOf('id="emailBtn"');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeGreaterThan(nameIdx);
    expect(pwIdx).toBeGreaterThan(emailIdx);
    expect(refIdx).toBeGreaterThan(pwIdx);
    expect(btnIdx).toBeGreaterThan(refIdx);
    expect(html).toContain("Continue with Google");
  });
});

describe("Privacy policy — page content", () => {
  it("says we teach for learning purposes only, not investment advice", () => {
    expect(policyHtml).toContain("learning purposes only");
    expect(policyHtml).toContain("Nothing on this website is investment advice");
    expect(policyHtml).toContain("provides trading");
    expect(policyHtml).toContain("education");
    expect(policyHtml).toContain("Trading involves risk");
    expect(policyHtml).toContain("not recommendations to buy or sell any security");
  });

  it("is dated 12 November 2026, links back to the site, and names the contact", () => {
    expect(policyHtml).toContain("12 November 2026");
    expect(policyHtml).toContain('href="/technotrade.html"');
    expect(policyHtml).toContain("rupu4086@gmail.com");
    expect(policyHtml).toContain("<title>Privacy Policy");
  });
});
