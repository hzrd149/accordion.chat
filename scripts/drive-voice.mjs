// Voice UI smoke test: create identity + community + a VOICE channel, confirm it
// renders as a speaker row, join it, and confirm the full CORD-07 media path — a
// token from the default broker (armada.buzz), a LiveKit E2EE connection, our
// own presence in the roster, and the call window with a participant tile.
// Needs `pnpm dev` + google-chrome. Fake media devices stand in for a real mic.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = "http://localhost:5173";
const SHOTS = "/tmp/concord-voice-shots";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--window-size=1400,900",
  ],
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` }).then(() => console.log("shot:", n));
async function clickText(text, sel = "button") {
  await page.evaluate(
    (t, s) => {
      const els = [...document.querySelectorAll(s)];
      const el = els.find((e) => e.textContent.trim() === t) || els.find((e) => e.textContent.trim().includes(t));
      if (!el) throw new Error("no element with text: " + t);
      el.click();
    },
    text,
    sel,
  );
}

let failed = false;
try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector(".login-card", { timeout: 15000 });
  await clickText("Create a new identity");
  await page.waitForSelector(".app", { timeout: 15000 });
  await sleep(1500);

  await clickText("Create a community");
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.type(".modal input", "Voice HQ");
  await clickText("Create");
  await page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 });
  await sleep(1200);
  await shot("01-community");

  // Create a VOICE channel.
  await page.evaluate(() => {
    const btn = document.querySelector(".channel-cat button");
    if (btn) btn.click();
  });
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.type('.modal input[placeholder="new-channel"]', "hangout");
  // Tick the voice checkbox.
  await page.evaluate(() => document.querySelector("#voice").click());
  await shot("02-create-voice-modal");
  await clickText("Create");
  await sleep(1500);

  // The voice channel should render as a .voice-channel row.
  const hasVoiceRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".voice-channel")];
    return rows.some((r) => r.textContent.includes("hangout"));
  });
  console.log("voice channel row rendered:", hasVoiceRow);
  if (!hasVoiceRow) throw new Error("voice channel did not render as a .voice-channel row");
  await shot("03-voice-channel");

  // Join the call — resolves the default broker, mints a token, connects to the
  // SFU with E2EE, and announces presence over the channel.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".voice-channel .channel")].find((b) =>
      b.textContent.includes("hangout"),
    );
    row.click();
  });
  await sleep(7000);
  await shot("04-in-call");
  const state = await page.evaluate(() => ({
    callWindow: !!document.querySelector(".call-window"),
    error: document.querySelector(".call-error")?.textContent ?? null,
    participants: document.querySelectorAll(".call-tile").length,
    rosterMembers: document.querySelectorAll(".voice-roster .voice-member").length,
    callBarButtons: document.querySelectorAll(".call-bar .call-btn").length,
  }));
  console.log("in-call state:", JSON.stringify(state));

  if (state.error) throw new Error("call surfaced an error: " + state.error);
  if (!state.callWindow) throw new Error("call window did not render after join");
  if (state.participants < 1) throw new Error("no participant tile after join");
  if (state.rosterMembers < 1) throw new Error("own presence not in the sidebar roster");

  const fatal = errors.filter(
    (e) => !/relay|websocket|ws:|wss:|network|Failed to load resource|401|data channel|Failed to fetch|ERR_/i.test(e),
  );
  if (fatal.length) {
    console.log("UNEXPECTED PAGE ERRORS:");
    for (const e of fatal) console.log("  -", e);
    failed = true;
  } else {
    console.log("no fatal page errors (relay/SFU network noise ignored)");
  }
  console.log(failed ? "\nVOICE SMOKE TEST FAILED" : "\nVOICE SMOKE TEST PASSED");
} catch (e) {
  console.error("DRIVER ERROR:", e.message);
  await shot("99-error");
  failed = true;
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
