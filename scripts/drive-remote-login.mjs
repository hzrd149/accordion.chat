import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = process.env.URL || "http://localhost:5175";
const SHOTS = "/tmp/concord-shots";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=800,900"],
  defaultViewport: { width: 800, height: 900 },
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

await page.goto(URL, { waitUntil: "networkidle2" });
await sleep(500);
await shot("login-main");

// Remote signer menu
await clickText("Sign in with remote signer");
await sleep(300);
await shot("remote-menu");

// Bunker view
await clickText("Paste a bunker");
await sleep(300);
await shot("bunker");
const hasBunkerInput = await page.$eval("input", (el) => el.placeholder).catch(() => null);
console.log("bunker input placeholder:", hasBunkerInput);

// Back to menu, then QR flow
await clickText("Back");
await sleep(300);
await clickText("Scan QR");
await sleep(1500); // wait for signer construction + QR render

// Read the nostrconnect:// URI from the QR link href
const uri = await page.$eval("a[href^='nostrconnect://']", (a) => a.getAttribute("href")).catch(() => null);
console.log("nostrconnect URI present:", !!uri);
if (uri) console.log("URI head:", uri.slice(0, 120));
const qrRendered = await page.$eval("img[alt='QR code']", (img) => img.naturalWidth > 0).catch(() => false);
console.log("QR image rendered:", qrRendered);
await shot("connect-qr");

console.log("\nconsole errors:", errors.length ? errors : "none");
await browser.close();
