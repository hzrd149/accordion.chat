// Two-user voice end-to-end test: A creates a community + voice channel, invites
// B, both join the same call, and each confirms it sees TWO participants with
// the other rendered as a verified member (CORD-07 presence verification, §4)
// while connected to the live broker/SFU with E2EE. Needs `pnpm dev` + chrome.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = "http://localhost:5173";
const SHOTS = "/tmp/concord-voice-shots";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--window-size=1400,900",
  ],
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
// Select the voice channel (shows chat + pre-join panel), then click its Join
// button (the call is started from the top toolbar, not the sidebar row).
const joinVoice = async (page) => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".voice-channel .channel")].find((x) => x.textContent.includes("hangout"));
    if (!b) throw new Error("no voice channel row");
    b.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".call-prejoin button")].some((b) => /join/i.test(b.textContent)),
    { timeout: 8000 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll(".call-prejoin button")].find((b) => /join/i.test(b.textContent)).click();
  });
};
const callState = (page) =>
  page.evaluate(() => ({
    participants: document.querySelectorAll(".call-tile").length,
    verifiedTiles: [...document.querySelectorAll(".call-tile-name")].filter((n) => !n.classList.contains("unverified")).length,
    error: document.querySelector(".call-error")?.textContent ?? null,
  }));

let failed = false;
try {
  // ---- User A: community + voice channel + invite ----
  const A = await newUser();
  await A.page.waitForSelector(".login-card");
  await clickText(A.page, "Create a new identity");
  await A.page.waitForSelector(".app");
  await sleep(1000);
  await clickText(A.page, "Create a community");
  await A.page.waitForSelector(".modal input");
  await A.page.type(".modal input", "Voice E2E");
  const relayBox = await A.page.$(".modal textarea");
  await relayBox.click({ clickCount: 3 });
  await relayBox.type("wss://relay.damus.io\nwss://nos.lol");
  await clickText(A.page, "Create");
  await A.page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 });
  await sleep(2000);

  // Create a voice channel.
  await A.page.evaluate(() => document.querySelector(".channel-cat button").click());
  await A.page.waitForSelector(".modal");
  await A.page.type('.modal input[placeholder="new-channel"]', "hangout");
  await A.page.evaluate(() => document.querySelector("#voice").click());
  await clickText(A.page, "Create");
  await sleep(2000);

  await clickText(A.page, "Invite people", ".channel");
  await A.page.waitForFunction(() => document.querySelector(".invite-link")?.textContent?.length > 20, { timeout: 15000 });
  const link = await A.page.evaluate(() => document.querySelector(".invite-link").textContent);
  console.log("invite:", link.slice(0, 50) + "…");
  await A.page.keyboard.press("Escape").catch(() => {});
  await A.page.evaluate(() => document.querySelector(".modal-backdrop")?.click());

  // ---- User B: join via link ----
  const B = await newUser();
  await B.page.waitForSelector(".login-card");
  await clickText(B.page, "Create a new identity");
  await B.page.waitForSelector(".app");
  await sleep(1000);
  await clickText(B.page, "Join with a link").catch(() => clickText(B.page, "Join with an invite link"));
  await B.page.waitForSelector(".modal input");
  await B.page.type(".modal input", link);
  await clickText(B.page, "Join");
  await B.page.waitForFunction(
    () => [...document.querySelectorAll(".voice-channel")].some((r) => r.textContent.includes("hangout")),
    { timeout: 20000 },
  );
  console.log("B: sees the voice channel");
  await sleep(1500);

  // ---- Both join the call ----
  await joinVoice(A.page);
  console.log("A: joined call");
  await sleep(3000);
  await joinVoice(B.page);
  console.log("B: joined call");
  // Give presence heartbeats + SFU subscribe time to converge across both peers.
  await sleep(9000);

  const a = await callState(A.page);
  const b = await callState(B.page);
  await shot(A.page, "e2e-A-call");
  await shot(B.page, "e2e-B-call");
  console.log("A call state:", JSON.stringify(a));
  console.log("B call state:", JSON.stringify(b));

  if (a.error) throw new Error("A call error: " + a.error);
  if (b.error) throw new Error("B call error: " + b.error);
  if (a.participants < 2) throw new Error(`A sees ${a.participants} participants, expected 2`);
  if (b.participants < 2) throw new Error(`B sees ${b.participants} participants, expected 2`);
  // Each should verify the OTHER member's identity via presence (both tiles verified).
  if (a.verifiedTiles < 2) throw new Error(`A verified ${a.verifiedTiles} tiles, expected 2`);
  if (b.verifiedTiles < 2) throw new Error(`B verified ${b.verifiedTiles} tiles, expected 2`);

  console.log("\n🎉 TWO-USER VOICE E2E VERIFIED — both peers see each other, presence-verified");
  console.log("A errors:", A.errors.length, "B errors:", B.errors.length);
} catch (e) {
  console.error("VOICE E2E FAILED:", e.message);
  failed = true;
} finally {
  await sleep(500);
  await browser.close();
  process.exit(failed ? 1 : 0);
}
