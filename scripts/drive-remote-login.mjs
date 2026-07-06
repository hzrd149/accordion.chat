import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const APP_URL = process.env.URL || "http://localhost:5175";
const SHOTS = "/tmp/concord-shots";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=800,1000"],
  defaultViewport: { width: 800, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

async function clickText(text) {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button")].find((e) => e.textContent.trim().includes(t));
    if (!el) throw new Error("no button: " + t);
    el.click();
  }, text);
}
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` }).then(() => console.log("shot:", n));
const uriOf = () =>
  page.$eval("a[href^='nostrconnect://']", (a) => a.getAttribute("href")).catch(() => null);

await page.goto(APP_URL, { waitUntil: "networkidle2" });
await sleep(500);

// Enter remote signer — QR should show immediately (no menu)
await clickText("Sign in with remote signer");
await sleep(1500);
const uri1 = await uriOf();
console.log("QR shown immediately:", !!uri1);
const relaysFromUri = uri1 ? [...new URL(uri1).searchParams.getAll("relay")] : [];
console.log("default relays in URI:", relaysFromUri);
const qrRendered = await page.$eval("img[alt='QR code']", (img) => img.naturalWidth > 0).catch(() => false);
console.log("QR image rendered:", qrRendered);
const hasBunkerInput = await page
  .$$eval("input", (els) => els.some((e) => e.placeholder.startsWith("bunker")))
  .catch(() => false);
console.log("bunker input present on same screen:", hasBunkerInput);
await shot("remote-1-default");

// Customize relays
await clickText("Relays:");
await sleep(300);
await page.$eval("textarea", (el) => {
  el.value = "";
});
await page.type("textarea", "wss://relay.example.com\nfoo.relay.dev");
await clickText("Apply");
await sleep(1200);
const uri2 = await uriOf();
const relays2 = uri2 ? [...new URL(uri2).searchParams.getAll("relay")] : [];
console.log("relays after customize (note wss:// auto-prefixed):", relays2);
await shot("remote-2-customized");

console.log("\nconsole errors:", errors.length ? errors : "none");
await browser.close();
