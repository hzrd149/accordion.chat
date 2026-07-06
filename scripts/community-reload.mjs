// Create a community, reload, and confirm it is restored from the encrypted
// Community List (kind 13302) via the applesauce decryption cache.
import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  defaultViewport: { width: 1200, height: 800 },
});
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function clickText(text) {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")];
    (b.find((e) => e.textContent.trim() === t) || b.find((e) => e.textContent.includes(t))).click();
  }, text);
}
try {
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForSelector(".login-card");
  await clickText("Create a new identity");
  await page.waitForSelector(".app");
  await sleep(800);
  await clickText("Create a community");
  await page.waitForSelector(".modal input");
  await page.type(".modal input", "Persisted Community");
  const box = await page.$(".modal textarea");
  await box.click({ clickCount: 3 });
  await box.type("wss://relay.damus.io\nwss://nos.lol");
  await clickText("Create");
  await page.waitForFunction(() => document.querySelector(".rail-icon"), { timeout: 15000 });
  await sleep(4000); // allow the 13302 list to publish to the relay

  console.log("before reload: communities =", await page.$$eval(".rail-icon", (e) => e.length - 1));
  await page.reload({ waitUntil: "networkidle2" });
  // Wait for loadCommunityList to fetch + decrypt + restore the community
  await page.waitForFunction(() => document.querySelectorAll(".rail-icon").length > 1, { timeout: 20000 });
  await sleep(1000);
  const name = await page.evaluate(() => document.querySelector(".sidebar-header span")?.textContent);
  console.log("after reload: restored community =", JSON.stringify(name));
  console.log("page errors:", errors.length);
  if (name && name.includes("Persisted")) console.log("✅ Community restored from encrypted list after reload");
  else {
    console.log("❌ community not restored");
    process.exitCode = 1;
  }
} catch (e) {
  console.error("FAILED:", e.message, "| errors:", errors.slice(-5));
  process.exitCode = 1;
} finally {
  await browser.close();
}
