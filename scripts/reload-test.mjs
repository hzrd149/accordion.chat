// Verify the active account (and thus session) survives a page reload.
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

async function clickText(text) {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === t) ||
      [...document.querySelectorAll("button")].find((e) => e.textContent.includes(t));
    el.click();
  }, text);
}

try {
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForSelector(".login-card");
  await clickText("Create a new identity");
  await page.waitForSelector(".app");
  await sleep(800);
  const pubBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("concord:accounts") || "[]")[0]?.pubkey);
  const activeBefore = await page.evaluate(() => localStorage.getItem("concord:active"));
  console.log("after login: accounts stored =", !!pubBefore, "| active stored =", !!activeBefore);

  // Reload the page
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(1500);
  const loginVisible = await page.$(".login-card");
  const appVisible = await page.$(".app");
  const pubAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("concord:accounts") || "[]")[0]?.pubkey);
  const activeAfter = await page.evaluate(() => localStorage.getItem("concord:active"));

  console.log("after reload: login screen =", !!loginVisible, "| app shell =", !!appVisible);
  console.log("after reload: accounts stored =", !!pubAfter, "| active stored =", !!activeAfter);
  console.log("pubkey preserved =", pubBefore && pubBefore === pubAfter);

  if (loginVisible || !appVisible || pubBefore !== pubAfter) {
    console.log("❌ SESSION NOT RESTORED");
    process.exitCode = 1;
  } else {
    console.log("✅ Active account restored across reload — stays logged in");
  }
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
