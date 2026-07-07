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

  // Selecting the voice channel shows its chat + a pre-join panel WITHOUT joining.
  await page.evaluate(() => {
    [...document.querySelectorAll(".voice-channel .channel")].find((b) => b.textContent.includes("hangout")).click();
  });
  await sleep(1500);
  await shot("03-voice-selected");
  const preState = await page.evaluate(() => ({
    prejoin: !!document.querySelector(".call-prejoin"),
    joinBtn: !!(
      [...document.querySelectorAll(".call-prejoin button")].find((b) => /join/i.test(b.textContent))
    ),
    composer: !!document.querySelector(".composer textarea"),
    inCall: !!document.querySelector(".call-surface"),
  }));
  console.log("pre-join state:", JSON.stringify(preState));
  if (!preState.prejoin) throw new Error("pre-join panel did not render on select");
  if (!preState.joinBtn) throw new Error("no Join button in the pre-join toolbar");
  if (!preState.composer) throw new Error("chat composer not shown for the voice channel");
  if (preState.inCall) throw new Error("joined without clicking Join");

  // Click Join — resolves the default broker, mints a token, connects to the SFU
  // with E2EE, and announces presence over the channel.
  await page.evaluate(() => {
    [...document.querySelectorAll(".call-prejoin button")].find((b) => /join/i.test(b.textContent)).click();
  });
  await sleep(7000);
  await shot("04-in-call");
  const state = await page.evaluate(() => {
    const surface = document.querySelector(".call-surface");
    const chat = document.querySelector(".composer");
    // Call surface should sit ABOVE the chat composer in the document.
    const above = surface && chat
      ? surface.getBoundingClientRect().top < chat.getBoundingClientRect().top
      : false;
    return {
      callSurface: !!surface,
      surfaceAboveChat: above,
      error: document.querySelector(".call-status-error")?.textContent ?? null,
      participants: document.querySelectorAll(".call-tile").length,
      rosterMembers: document.querySelectorAll(".voice-roster .voice-member").length,
      callBarButtons: document.querySelectorAll(".call-bar .call-btn").length,
      lucideIcons: document.querySelectorAll(".call-bar .call-btn svg.lucide").length,
      composerStillShown: !!chat,
    };
  });
  console.log("in-call state:", JSON.stringify(state));

  if (state.error) throw new Error("call surfaced an error: " + state.error);
  if (!state.callSurface) throw new Error("call surface did not render after join");
  if (!state.composerStillShown) throw new Error("chat disappeared when the call started");
  if (!state.surfaceAboveChat) throw new Error("call surface is not above the chat");
  if (state.participants < 1) throw new Error("no participant tile after join");
  if (state.rosterMembers < 1) throw new Error("own presence not in the sidebar roster");
  if (state.callBarButtons !== 4) throw new Error("expected 4 call-bar buttons");
  if (state.lucideIcons < 4) throw new Error("call-bar buttons are not using lucide icons");

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
