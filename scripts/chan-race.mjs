import puppeteer from "puppeteer-core";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] , defaultViewport:{width:1200,height:800}});
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
const clickText = (t)=>page.evaluate((t)=>{const b=[...document.querySelectorAll("button")];(b.find(e=>e.textContent.trim()===t)||b.find(e=>e.textContent.includes(t))).click();},t);
const channels = () => page.$$eval(".channel", (els) => els.map((e) => e.textContent.trim()).filter((t) => !t.includes("Invite")));
try {
  await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });
  await page.waitForSelector(".login-card"); await clickText("Create a new identity");
  await page.waitForSelector(".app"); await sleep(600);
  await clickText("Create a community"); await page.waitForSelector(".modal input");
  await page.type(".modal input", "RaceTest");
  const box=await page.$(".modal textarea"); await box.click({clickCount:3}); await box.type("wss://relay.damus.io\nwss://nos.lol");
  await clickText("Create");
  await page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 }); await sleep(2500);
  await page.evaluate(() => document.querySelector(".channel-cat button")?.click());
  await page.waitForSelector(".modal input"); await page.type(".modal input", "quick");
  await clickText("Create");
  // reload almost immediately (300ms) — simulate fast user
  await sleep(300);
  console.log("channels right before reload:", await channels());
  await page.reload({ waitUntil: "networkidle2" });
  for (let i=0;i<8;i++){ await sleep(2500); console.log(`  t+${(i+1)*2.5}s:`, await channels()); }
} catch(e){ console.error("FAILED", e.message);} finally { await browser.close(); }
