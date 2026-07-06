import puppeteer from "puppeteer-core";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"], defaultViewport:{width:1200,height:800}});
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
page.on("pageerror", (e)=>console.log("PAGEERROR:", e.message));
const clickText = (t)=>page.evaluate((t)=>{const b=[...document.querySelectorAll("button")];(b.find(e=>e.textContent.trim()===t)||b.find(e=>e.textContent.includes(t))).click();},t);
const channels = () => page.$$eval(".channel", (els) => els.map((e) => e.textContent.trim()).filter((t) => !t.includes("Invite")));
try {
  await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });
  await page.waitForSelector(".login-card"); await clickText("Create a new identity");
  await page.waitForSelector(".app"); await sleep(600);
  await clickText("Create a community"); await page.waitForSelector(".modal input");
  await page.type(".modal input", "CacheTest");
  const box=await page.$(".modal textarea"); await box.click({clickCount:3});
  // UNREACHABLE relay — channels can only survive reload via the local cache
  await box.type("wss://relay.example.invalid");
  await clickText("Create");
  await page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 }); await sleep(1500);
  await page.evaluate(() => document.querySelector(".channel-cat button")?.click());
  await page.waitForSelector(".modal input"); await page.type(".modal input", "secret-plans");
  await clickText("Create");
  await sleep(1500);
  // create a second channel too
  await page.evaluate(() => document.querySelector(".channel-cat button")?.click());
  await page.waitForSelector(".modal input"); await page.type(".modal input", "off-topic");
  await clickText("Create");
  await sleep(1500);
  console.log("before reload:", await channels());
  const cacheKeys = await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("concord:cache")));
  console.log("cache keys present:", cacheKeys.length);

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(1500); // near-instant from cache, no relay involved
  console.log("after reload (cache only, bad relay):", await channels());
  const ok = (await channels()).length >= 3;
  console.log(ok ? "✅ channels survived reload purely from local cache" : "❌ channels lost");
  if (!ok) process.exitCode = 1;
} catch(e){ console.error("FAILED", e.message); process.exitCode=1; } finally { await browser.close(); }
