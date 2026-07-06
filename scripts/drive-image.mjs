import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = "http://localhost:5173";
const SHOTS = "/tmp/concord-shots";
mkdirSync(SHOTS, { recursive: true });

// A real 4x4 red PNG on disk to feed the file input.
const PNG = "/tmp/concord-shots/icon.png";
writeFileSync(PNG, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR42mNk+M9QzzCEwSgAA6UBB2+RmZ0AAAAASUVORK5CYII=",
  "base64"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1500,950"],
  defaultViewport: { width: 1500, height: 950 },
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
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
  await sleep(1500);
  await clickText("Create a community");
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.type(".modal input", "Image Test HQ");
  await clickText("Create");
  await page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 });
  await sleep(1000);

  // Open community settings (Overview tab)
  await page.click('button[title="Community settings"]');
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.waitForSelector(".image-preview.icon", { timeout: 5000 });
  await shot("img-01-settings");

  // Upload icon via the hidden file input inside the icon ImageField.
  const iconInput = await page.evaluateHandle(() => {
    const field = document.querySelector(".image-field.icon");
    return field.querySelector('input[type="file"]');
  });
  await iconInput.uploadFile(PNG);
  console.log("uploading icon…");

  // Wait for the icon preview <img> to appear (upload + fold + decrypt done).
  await page.waitForFunction(
    () => document.querySelector(".image-preview.icon img"),
    { timeout: 45000 },
  );
  await shot("img-02-icon-uploaded");

  // Upload a banner too.
  const bannerInput = await page.evaluateHandle(() => {
    const field = document.querySelector(".image-field.banner");
    return field.querySelector('input[type="file"]');
  });
  await bannerInput.uploadFile(PNG);
  await page.waitForFunction(
    () => document.querySelector(".image-preview.banner img"),
    { timeout: 45000 },
  );
  await shot("img-03-banner-uploaded");

  // Close modal, verify rail icon + sidebar banner render as images.
  await page.evaluate(() => document.querySelector(".modal-backdrop, .modal")?.dispatchEvent(new MouseEvent("mousedown")));
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);
  const railHasImg = await page.evaluate(() => !!document.querySelector(".rail-icon img"));
  const bannerShown = await page.evaluate(() => !!document.querySelector(".sidebar-banner"));
  await shot("img-04-final");

  console.log("rail icon is <img>:", railHasImg);
  console.log("sidebar banner shown:", bannerShown);
  console.log("errors:", errors.length ? errors : "none");
  if (!railHasImg) throw new Error("rail icon did not render as image");
  console.log("RESULT: PASS");
} catch (e) {
  console.error("RESULT: FAIL —", e.message);
  await shot("img-99-fail");
  console.log("errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
