// Two users over a relay that REQUIRES NIP-42 AUTH to read. Proves the client
// auto-authenticates: without it, B could never read A's channel/messages.
import puppeteer from "puppeteer-core";
const RELAY = process.env.RELAY || "ws://localhost:7447";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"], defaultViewport: { width: 1300, height: 850 } });

async function mkUser() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  page.on("console", (m) => { const t = m.text(); if (/auth|relay|CLOSED|publish failed|NIP-42/i.test(t)) console.log("  page:", t.slice(0, 160)); });
  await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });
  return page;
}
const clickText = (page, t) => page.evaluate((t) => { const b = [...document.querySelectorAll("button")]; (b.find(e => e.textContent.trim() === t) || b.find(e => e.textContent.includes(t))).click(); }, t);
const waitText = (page, t, ms = 25000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: ms }, t);

try {
  // ---- A creates a community on the auth-required relay ----
  const A = await mkUser();
  await A.waitForSelector(".login-card"); await clickText(A, "Create a new identity");
  await A.waitForSelector(".app"); await sleep(600);
  await clickText(A, "Create a community"); await A.waitForSelector(".modal input");
  await A.type(".modal input", "AuthGated");
  const box = await A.$(".modal textarea");
  await box.click();
  await A.keyboard.down("Control"); await A.keyboard.press("A"); await A.keyboard.up("Control");
  await A.keyboard.press("Backspace");
  await box.type(RELAY);
  console.log("A relays set to:", await A.$eval(".modal textarea", (e) => e.value));
  await clickText(A, "Create");
  await A.waitForFunction(() => document.querySelector(".composer textarea"), { timeout: 15000 });
  await sleep(2500);
  const composer = await A.$(".composer textarea");
  await composer.type("If you can read this, auth worked."); await A.keyboard.press("Enter");
  await sleep(1500);
  await clickText(A, "Invite people", ".channel").catch(() => {});
  await A.waitForFunction(() => document.querySelector(".invite-link")?.textContent?.length > 20, { timeout: 15000 });
  const link = await A.evaluate(() => document.querySelector(".invite-link").textContent);
  console.log("invite via", RELAY);

  // ---- B joins fresh (no cache) — must AUTH to read anything ----
  const B = await mkUser();
  await B.waitForSelector(".login-card"); await clickText(B, "Create a new identity");
  await B.waitForSelector(".app"); await sleep(600);
  await clickText(B, "Join with a link").catch(() => clickText(B, "Join with an invite link"));
  await B.waitForSelector(".modal input"); await B.type(".modal input", link);
  await clickText(B, "Join");
  await B.waitForFunction(() => document.querySelector(".channel"), { timeout: 20000 });
  console.log("B: waiting to read A's message through the auth-gated relay…");
  await waitText(B, "auth worked");
  const channels = await B.$$eval(".channel", (els) => els.map((e) => e.textContent.trim()).filter((t) => !t.includes("Invite")));
  console.log("B sees channels:", channels);
  console.log("✅ B authenticated (NIP-42) and read the control plane + chat over the gated relay");
} catch (e) {
  console.error("❌ AUTH E2E FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
