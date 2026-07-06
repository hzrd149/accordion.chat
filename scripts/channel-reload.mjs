// Repro: create a channel, reload, see whether channels survive.
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
page.on("console", (m) => { if (m.text().includes("[dbg]")) console.log("PAGE:", m.text()); });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
async function clickText(text) {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")];
    (b.find((e) => e.textContent.trim() === t) || b.find((e) => e.textContent.includes(t))).click();
  }, text);
}
const channels = () => page.$$eval(".channel", (els) => els.map((e) => e.textContent.trim()).filter((t) => !t.includes("Invite")));

try {
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForSelector(".login-card");
  await clickText("Create a new identity");
  await page.waitForSelector(".app");
  await sleep(800);
  await clickText("Create a community");
  await page.waitForSelector(".modal input");
  await page.type(".modal input", "ChanTest");
  const box = await page.$(".modal textarea");
  await box.click({ clickCount: 3 });
  await box.type("wss://relay.damus.io\nwss://nos.lol");
  await clickText("Create");
  await page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 });
  await sleep(2000);

  // create a channel
  await page.evaluate(() => document.querySelector(".channel-cat button")?.click());
  await page.waitForSelector(".modal input");
  await page.type(".modal input", "random");
  await clickText("Create");
  await sleep(3000);
  console.log("before reload channels:", await channels());

  await page.reload({ waitUntil: "networkidle2" });
  console.log("reloaded, polling channels for 20s…");
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const c = await channels();
    console.log(`  t+${(i + 1) * 2}s:`, c);
  }
} catch (e) {
  console.error("FAILED:", e.message);
} finally {
  await browser.close();
}
