// Two-user end-to-end test over real relays: create → invite → join → chat.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = "http://localhost:5173";
const SHOTS = "/tmp/concord-shots";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
});

async function newUser() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
  return { ctx, page, errors };
}
async function clickText(page, text, sel = "button") {
  await page.evaluate(
    (t, s) => {
      const els = [...document.querySelectorAll(s)];
      const el = els.find((e) => e.textContent.trim() === t) || els.find((e) => e.textContent.trim().includes(t));
      if (!el) throw new Error("no element: " + t);
      el.click();
    },
    text,
    sel,
  );
}
const shot = (page, n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
async function waitForText(page, text, timeout = 25000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

try {
  // ---- User A: create community + message + invite ----
  const A = await newUser();
  await A.page.waitForSelector(".login-card");
  await clickText(A.page, "Create a new identity");
  await A.page.waitForSelector(".app");
  await sleep(1000);
  await clickText(A.page, "Create a community");
  await A.page.waitForSelector(".modal input");
  await A.page.type(".modal input", "Relay Test");
  // Use a single reliable relay
  const relayBox = await A.page.$(".modal textarea");
  await relayBox.click({ clickCount: 3 });
  await relayBox.type("wss://relay.damus.io\nwss://nos.lol");
  await clickText(A.page, "Create");
  await A.page.waitForFunction(() => document.querySelector(".composer textarea"), { timeout: 15000 });
  await sleep(2000); // let relay subscription establish

  const composerA = await A.page.$(".composer textarea");
  await composerA.type("Hello from user A over a real relay!");
  await A.page.keyboard.press("Enter");
  await sleep(1500);

  await clickText(A.page, "Invite people", ".channel");
  await A.page.waitForFunction(() => document.querySelector(".invite-link")?.textContent?.length > 20, { timeout: 15000 });
  const link = await A.page.evaluate(() => document.querySelector(".invite-link").textContent);
  console.log("invite:", link.slice(0, 60) + "…");
  await shot(A.page, "e2e-A-created");

  // ---- User B: join via link ----
  const B = await newUser();
  await B.page.waitForSelector(".login-card");
  await clickText(B.page, "Create a new identity");
  await B.page.waitForSelector(".app");
  await sleep(1000);
  await clickText(B.page, "Join with a link").catch(async () => {
    await clickText(B.page, "Join with an invite link");
  });
  await B.page.waitForSelector(".modal input");
  await B.page.type(".modal input", link);
  await clickText(B.page, "Join");

  // B should see the community and A's message
  await B.page.waitForFunction(() => document.querySelector(".channel"), { timeout: 20000 });
  await sleep(2000);
  console.log("B: waiting for A's message to arrive over relay…");
  await waitForText(B.page, "Hello from user A");
  console.log("✅ User B received User A's message over the relay!");
  await shot(B.page, "e2e-B-joined");

  // B replies
  const composerB = await B.page.$(".composer textarea");
  await composerB.type("Hi A, user B here — I can read the encrypted channel!");
  await B.page.keyboard.press("Enter");
  await sleep(2000);

  // A should receive B's reply
  console.log("A: waiting for B's reply over relay…");
  await waitForText(A.page, "user B here");
  console.log("✅ User A received User B's reply over the relay!");
  await shot(A.page, "e2e-A-received");

  // Verify B shows up as a member for A
  const members = await A.page.evaluate(() => document.querySelector(".members").innerText);
  console.log("A member panel:\n" + members.split("\n").slice(0, 6).join(" | "));

  console.log("\n🎉 TWO-USER END-TO-END CHAT VERIFIED");
  console.log("A errors:", A.errors.length, "B errors:", B.errors.length);
} catch (e) {
  console.error("E2E FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await sleep(500);
  await browser.close();
}
