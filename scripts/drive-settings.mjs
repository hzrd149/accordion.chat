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
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1500,950"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` }).then(() => console.log("shot:", n));
async function clickText(text, sel = "button") {
  await page.evaluate((t, s) => {
    const els = [...document.querySelectorAll(s)];
    const el = els.find((e) => e.textContent.trim() === t) || els.find((e) => e.textContent.trim().includes(t));
    if (!el) throw new Error("no element with text: " + t);
    el.click();
  }, text, sel);
}

try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector(".login-card", { timeout: 15000 });
  await clickText("Create a new identity");
  await page.waitForSelector(".app", { timeout: 15000 });
  await sleep(1200);

  // Open settings from the rail gear.
  await page.click(".settings-gear");
  await page.waitForSelector(".settings", { timeout: 5000 });
  await sleep(400);
  await shot("s01-profile");

  // Fill in a couple of profile fields and save.
  await page.type('.settings-page input[placeholder="satoshi"]', "concordtester");
  await page.type('.settings-page textarea', "Testing the new settings view.");
  await clickText("Save profile");
  await sleep(1500);
  await shot("s02-profile-saved");
  const savedOk = await page.evaluate(() => !!document.querySelector(".settings-saved"));
  console.log("profile saved indicator:", savedOk);

  // Walk each nav page and exercise the relay editors.
  const pages = ["Relays", "DM Inbox Relays", "Blossom Servers", "Indexer Relays"];
  for (const p of pages) {
    await clickText(p, ".settings-nav-item");
    await sleep(300);
    const value = p === "Blossom Servers" ? "blossom.band" : "relay.damus.io";
    const input = await page.$(".relay-add input");
    await input.type(value);
    await clickText("Add", ".relay-add .btn");
    await sleep(1500);
    const count = await page.$$eval(".relay-row", (rows) => rows.length);
    console.log(`page "${p}": ${count} row(s) after add`);
    await shot(`s-${p.replace(/\s+/g, "-").toLowerCase()}`);
  }

  // Close.
  await page.click(".settings-close");
  await sleep(300);
  const closed = await page.evaluate(() => !document.querySelector(".settings"));
  console.log("settings closed:", closed);

  console.log("\nCONSOLE ERRORS (" + errors.length + "):");
  for (const e of errors.slice(0, 25)) console.log("  -", e.slice(0, 200));
} catch (e) {
  console.error("DRIVE FAILED:", e.message);
  await shot("s99-failure");
  console.log("recent errors:", errors.slice(-10));
  process.exitCode = 1;
} finally {
  await browser.close();
}
