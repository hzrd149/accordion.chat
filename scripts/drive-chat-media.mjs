import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = process.env.URL || "http://localhost:5173";
const SHOTS = "/tmp/concord-shots";
mkdirSync(SHOTS, { recursive: true });

// A real 4x4 green PNG to attach.
const PNG = "/tmp/concord-shots/attach.png";
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
  await page.type(".modal input", "Media Chat HQ");
  await clickText("Create");
  await page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 });
  await sleep(1000);

  // Point the community's Blossom list at the local mock server.
  await page.click('button[title="Community settings"]');
  await page.waitForSelector(".modal", { timeout: 5000 });
  const blossomBox = await page.evaluateHandle(() => {
    const l = [...document.querySelectorAll(".field label")].find((x) => x.textContent.includes("Blossom"));
    return l.parentElement.querySelector("textarea");
  });
  await blossomBox.click({ clickCount: 3 });
  await blossomBox.type("http://localhost:3999/");
  await clickText("Save changes");
  await sleep(1000);
  // Close the settings modal (click backdrop).
  await page.evaluate(() => document.querySelector(".modal-backdrop")?.click());
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);

  // Attach an image via the composer's hidden file input, then send.
  await page.waitForSelector(".composer .box input[type=file]", { timeout: 5000 });
  const fileInput = await page.$(".composer .box input[type=file]");
  await fileInput.uploadFile(PNG);
  await page.waitForSelector(".attach-chip", { timeout: 5000 });
  await shot("chat-01-attached");
  await page.type(".composer textarea", "here is an encrypted pic");
  await clickText("Send");
  console.log("sent; waiting for decrypted <img> to render…");

  // The message should render a decrypted inline image.
  await page.waitForFunction(
    () => document.querySelector(".messages .msg-text img.attachment"),
    { timeout: 45000 },
  );
  await sleep(500);
  await shot("chat-02-rendered");

  const imgOk = await page.evaluate(() => {
    const img = document.querySelector(".messages .msg-text img.attachment");
    return !!img && img.src.startsWith("blob:") && img.naturalWidth > 0;
  });
  const textOk = await page.evaluate(() =>
    [...document.querySelectorAll(".messages .msg-text")].some((n) => n.textContent.includes("encrypted pic")));

  console.log("decrypted <img> rendered (blob:, naturalWidth>0):", imgOk);
  console.log("caption text preserved:", textOk);
  console.log("page errors:", errors.filter((e) => !e.includes("404") && !e.includes("WebSocket")));
  if (!imgOk) throw new Error("decrypted attachment image did not render");
  console.log("RESULT: PASS");
} catch (e) {
  console.error("RESULT: FAIL —", e.message);
  await shot("chat-99-fail");
  console.log("errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
