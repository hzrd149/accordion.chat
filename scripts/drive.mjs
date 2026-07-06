import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = "http://localhost:5173";
const SHOTS = "/tmp/concord-shots";
import { mkdirSync } from "node:fs";
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
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  console.log("shot:", name);
}
async function clickText(text, sel = "button") {
  await page.evaluate(
    (t, s) => {
      const els = [...document.querySelectorAll(s)];
      const exact = els.find((e) => e.textContent.trim() === t);
      const el = exact || els.find((e) => e.textContent.trim().includes(t));
      if (!el) throw new Error("no element with text: " + t);
      el.click();
    },
    text,
    sel,
  );
}

try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector(".login-card", { timeout: 15000 });
  await shot("01-login");

  // Create a new identity
  await clickText("Create a new identity");
  await page.waitForSelector(".app", { timeout: 15000 });
  await sleep(1500); // start() runs, may try relays
  await shot("02-empty");

  // Create a community
  await clickText("Create a community");
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.type('.modal input', "Applesauce HQ");
  await shot("03-create-modal");
  await clickText("Create");
  // wait for community rail + general channel
  await page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 });
  await sleep(1200);
  await shot("04-community");

  // Send a message
  const composer = await page.$(".composer textarea");
  if (composer) {
    await composer.type("Hello Concord! First message on the encrypted control plane 🎉");
    await page.keyboard.press("Enter");
    await sleep(800);
    await composer.type("Reactions and replies work too.");
    await page.keyboard.press("Enter");
    await sleep(1000);
  }
  await shot("05-messages");

  // Open community settings (admin) -> roles tab
  await clickText("⚙", "button");
  await page.waitForSelector(".tabs", { timeout: 5000 });
  await clickText("Roles", ".tabs button");
  await sleep(400);
  await page.type('.modal input[placeholder="Moderator"]', "Moderator");
  await shot("06-roles");
  // close modal
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => document.querySelector(".modal-backdrop")?.click());
  await sleep(400);

  // Create a channel
  await clickText("+", ".channel-cat button").catch(async () => {
    // fallback: the + might be the sidebar header
  });
  await sleep(300);
  const chModal = await page.$(".modal input");
  if (chModal) {
    await chModal.type("random");
    await clickText("Create");
    await sleep(800);
  }
  await shot("07-second-channel");

  // Open invite modal
  await clickText("Invite people", ".channel").catch(() => {});
  await sleep(1000);
  await shot("08-invite");
  const inviteLink = await page.evaluate(() => document.querySelector(".invite-link")?.textContent || "");
  console.log("INVITE_LINK:", inviteLink.slice(0, 80) + "…");

  console.log("\nCONSOLE ERRORS (" + errors.length + "):");
  for (const e of errors.slice(0, 20)) console.log("  -", e.slice(0, 200));
} catch (e) {
  console.error("DRIVE FAILED:", e.message);
  await shot("99-failure");
  console.log("recent errors:", errors.slice(-10));
  process.exitCode = 1;
} finally {
  await browser.close();
}
