// Two-user end-to-end test of channel read markers over real relays.
//
// The scenario the unread badge exists for: B is looking at #general while A
// talks in #random. B's sidebar should show a count on #random, and opening it
// should clear the count.
//
// Selectors here are text- and structure-based on purpose — the older drivers
// key off .app/.composer/.channel classes that no longer exist in the source.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const URL = process.env.URL || "http://localhost:5173";
const SHOTS = "/tmp/concord-shots";
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1400,900"],
  defaultViewport: { width: 1400, height: 900 },
});

async function newUser() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
  return { ctx, page, errors };
}

async function clickText(page, text, sel = "button") {
  await page.evaluate(
    (t, s) => {
      const els = [...document.querySelectorAll(s)];
      const el =
        els.find((e) => e.textContent.trim() === t) || els.find((e) => e.textContent.trim().includes(t));
      if (!el) throw new Error(`no element ${s} with text: ${t}`);
      el.click();
    },
    text,
    sel,
  );
}

const shot = (page, n) => page.screenshot({ path: `${SHOTS}/${n}.png` });

/** Wait for a channel to be open and writable. Dumps the screen on timeout —
 *  a bare "selector not found" says nothing about which step actually stalled. */
async function composer(page, who = "?") {
  try {
    return await page.waitForSelector(".composer-textarea", { timeout: 25000 });
  } catch (e) {
    await shot(page, `unread-FAIL-${who}`);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
    throw new Error(`${who}: no composer after 25s. Screen said:\n${text}`);
  }
}

/** The sidebar row for a channel, as { name, badge } — badge null when absent. */
function readSidebar(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-channel-row]")];
    return rows.map((r) => ({
      name: r.getAttribute("data-channel-row"),
      badge: r.querySelector("[data-unread-badge]")?.textContent?.trim() ?? null,
      mention: r.querySelector("[data-unread-badge]")?.getAttribute("data-mention") === "true",
    }));
  });
}

async function login(page) {
  await page.waitForFunction(() => document.body.innerText.includes("Create a new identity"), {
    timeout: 20000,
  });
  await clickText(page, "Create a new identity");
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : `\n   expected ${JSON.stringify(expected)}\n   actual   ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

try {
  // ---- User A: identity + community ----
  const A = await newUser();
  await login(A.page);
  await sleep(1000);
  await clickText(A.page, "Create a community");
  await A.page.waitForSelector(".modal input");
  await A.page.type(".modal input", "Unread Test");
  const relayBox = await A.page.$(".modal textarea");
  await relayBox.click({ clickCount: 3 });
  await relayBox.type("wss://relay.damus.io\nwss://nos.lol");
  await clickText(A.page, "Create");
  await composer(A.page, "A");
  await sleep(2500); // let the relay subscription establish

  // ---- A: a second channel to be unread in ----
  await clickText(A.page, "", '[title="Create channel"]');
  await A.page.waitForSelector(".modal input");
  await A.page.type(".modal input", "random");
  await clickText(A.page, "Create");
  await sleep(2500);
  await shot(A.page, "unread-A-channels");

  const aChannels = (await readSidebar(A.page)).map((c) => c.name);
  console.log("A channels:", aChannels.join(", "));
  if (!aChannels.includes("random")) throw new Error("second channel was not created");

  // ---- A: invite ----
  await clickText(A.page, "Invite people");
  await A.page.waitForFunction(
    () => document.querySelector(".modal-box .font-mono")?.textContent?.length > 20,
    { timeout: 20000 },
  );
  const link = await A.page.evaluate(() => document.querySelector(".modal-box .font-mono").textContent);
  console.log("invite:", link.slice(0, 50) + "…");
  await A.page.keyboard.press("Escape");

  // ---- User B: join ----
  const B = await newUser();
  await login(B.page);
  await sleep(1000);
  await clickText(B.page, "Join with a link").catch(() => clickText(B.page, "Join with an invite link"));
  await B.page.waitForSelector(".modal input");
  await B.page.type(".modal input", link);
  // The confirm button only appears once the invite preview resolves, and it is
  // labelled "Join <community>" — matching a bare "Join" would hit the
  // still-mounted "Join with a link" button instead.
  await B.page.waitForFunction(
    () => [...document.querySelectorAll(".modal-box button")].some((b) => b.textContent.trim() === "Join Unread Test"),
    { timeout: 25000 },
  );
  await clickText(B.page, "Join Unread Test", ".modal-box button");
  await composer(B.page, "B");
  await sleep(4000);

  const bChannels = (await readSidebar(B.page)).map((c) => c.name);
  console.log("B channels:", bChannels.join(", "));

  // Park B in #general explicitly. Channel order is not creation order, and the
  // app auto-selects channels[0] — which is #random here, the very channel A is
  // about to post to, so relying on the default would test nothing.
  await clickText(B.page, "general", "[data-channel-row]");
  await composer(B.page, "B");
  await sleep(1500);
  const bViewing = await B.page.evaluate(
    () => document.querySelector(".composer-textarea")?.placeholder ?? "",
  );
  console.log("B is viewing:", bViewing);
  if (!bViewing.includes("general")) throw new Error(`B failed to open #general (composer says "${bViewing}")`);

  // B has just joined and is sitting in the first channel. The community
  // baseline should have marked everything read: no badges anywhere.
  check(
    "B: no unread immediately after join (baseline suppresses history)",
    (await readSidebar(B.page)).filter((c) => c.badge).map((c) => c.name),
    [],
  );
  await shot(B.page, "unread-B-joined");

  // ---- A talks in #random while B watches #general ----
  await clickText(A.page, "random", "[data-channel-row]");
  await composer(A.page, "A");
  await sleep(1500);
  for (const msg of ["unread one", "unread two", "unread three"]) {
    const c = await A.page.$(".composer-textarea");
    await c.type(msg);
    await A.page.keyboard.press("Enter");
    await sleep(900);
  }
  console.log("A sent 3 messages to #random");
  await sleep(6000); // relay round-trip to B

  const bAfter = await readSidebar(B.page);
  console.log("B sidebar:", JSON.stringify(bAfter));
  console.log("B read-state:", await B.page.evaluate(() =>
    JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("accordion:read")))),
  ));
  console.log("B now:", Date.now());
  check(
    "B: #random shows 3 unread",
    bAfter.find((c) => c.name === "random")?.badge,
    "3",
  );
  check(
    "B: the channel B is viewing stays read",
    bAfter.filter((c) => c.name !== "random" && c.badge).map((c) => c.name),
    [],
  );
  await shot(B.page, "unread-B-badge");

  // ---- B opens #random: the badge clears ----
  await clickText(B.page, "random", "[data-channel-row]");
  await composer(B.page, "B");
  await sleep(2500);
  // Distinguishes "B never got the messages" from "B got them but didn't count
  // them" — without this the badge checks pass vacuously on an empty channel.
  const bSees = await B.page.evaluate(() => document.body.innerText.includes("unread one"));
  check("B: actually received A's messages in #random", bSees, true);
  const bCleared = await readSidebar(B.page);
  console.log("B sidebar after open:", JSON.stringify(bCleared));
  check(
    "B: opening #random clears its badge",
    bCleared.filter((c) => c.badge).map((c) => c.name),
    [],
  );
  await shot(B.page, "unread-B-cleared");

  // ---- The cursor must survive a reload ----
  await B.page.reload({ waitUntil: "networkidle2" });
  await composer(B.page, "B");
  await sleep(5000);
  const bReloaded = await readSidebar(B.page);
  console.log("B sidebar after reload:", JSON.stringify(bReloaded));
  check(
    "B: read state survives a reload (no badge resurrection)",
    bReloaded.filter((c) => c.badge).map((c) => c.name),
    [],
  );
  await shot(B.page, "unread-B-reloaded");

  console.log("\nA errors:", A.errors.length, "B errors:", B.errors.length);
  if (A.errors.length) console.log("A:", A.errors.slice(0, 3));
  if (B.errors.length) console.log("B:", B.errors.slice(0, 3));
  console.log(failures === 0 ? "\n🎉 READ MARKERS VERIFIED" : `\n💥 ${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
} catch (e) {
  console.error("DRIVER FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await sleep(500);
  await browser.close();
}
