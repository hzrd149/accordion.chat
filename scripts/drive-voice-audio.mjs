// Voice AUDIO-DECODE probe. Two users join the same Concord call over live
// armada.buzz, then each MEASURES the remote participant's decoded audio via a
// Web Audio AnalyserNode tapped off the <audio> element RoomAudioRenderer
// attaches. Chrome's fake audio device emits a periodic tone, so a healthy E2EE
// decode shows real spectral energy with a tonal peak; a broken decrypt shows
// either silence (frames fail the GCM auth tag → dropped) or a flat noise floor
// (frames decode to garbage). This is what the roster-only drivers can't see.
//
// Caveat: both browsers run THIS build, so this proves SAME-VERSION E2EE decode.
// A cross-version mismatch (our client vs a real armada web client) can't be
// reproduced here — that's the whole reason we pin livekit-client to armada's.
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
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1400,900",
  ],
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
      const el = els.find((e) => e.textContent.trim() === t) || els.find((e) => e.textContent.trim().includes(t));
      if (!el) throw new Error("no element: " + t);
      el.click();
    },
    text,
    sel,
  );
}
const joinVoice = async (page) => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".voice-channel .channel")].find((x) => x.textContent.includes("hangout"));
    if (!b) throw new Error("no voice channel row");
    b.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".call-prejoin button")].some((b) => /join/i.test(b.textContent)),
    { timeout: 8000 },
  );
  await page.evaluate(() => {
    [...document.querySelectorAll(".call-prejoin button")].find((b) => /join/i.test(b.textContent)).click();
  });
};

// Tap every <audio> element that RoomAudioRenderer attached a remote track to,
// run ~2s of its signal through an AnalyserNode, and summarize the spectrum.
//   peakDb   — loudest frequency bin (dBFS). Silence ≈ -100/-Inf; a real tone
//              sits well above the noise floor (> ~-55 dB with fake media).
//   flatness — spectral flatness (geo mean / arith mean of linear power):
//              ~1.0 = flat broadband noise (garbled decode), near 0 = tonal
//              (clean decode of the fake tone).
//   rms      — time-domain RMS of the played signal (0 = silent).
async function measureRemoteAudio(page) {
  return await page.evaluate(async () => {
    const audios = [...document.querySelectorAll("audio")].filter((a) => a.srcObject);
    if (!audios.length) return { error: "no <audio> element with a srcObject (no remote audio attached)" };
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    const out = [];
    for (const el of audios) {
      const stream = el.srcObject;
      const tracks = stream.getAudioTracks?.() ?? [];
      if (!tracks.length) continue;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      src.connect(analyser);
      const freq = new Float32Array(analyser.frequencyBinCount);
      const time = new Uint8Array(analyser.fftSize);
      let peakDb = -Infinity;
      let peakRms = 0;
      // Snapshot spectra over ~2s; keep the frame with the most energy so a
      // gated/periodic fake tone isn't measured during its silent gap.
      let best = null;
      const start = performance.now();
      await new Promise((res) => {
        const tick = () => {
          analyser.getFloatFrequencyData(freq);
          analyser.getByteTimeDomainData(time);
          let localPeak = -Infinity;
          for (let i = 1; i < freq.length; i++) if (freq[i] > localPeak) localPeak = freq[i];
          let sumSq = 0;
          for (let i = 0; i < time.length; i++) {
            const v = (time[i] - 128) / 128;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / time.length);
          if (localPeak > peakDb) peakDb = localPeak;
          if (rms > peakRms) peakRms = rms;
          if (!best || localPeak > best.peak) best = { peak: localPeak, freq: Float32Array.from(freq) };
          if (performance.now() - start > 2000) return res();
          requestAnimationFrame(tick);
        };
        tick();
      });
      // Spectral flatness on the most-energetic snapshot.
      const lin = [...best.freq].slice(1).map((db) => Math.pow(10, db / 10));
      const arith = lin.reduce((a, b) => a + b, 0) / lin.length;
      const geo = Math.exp(lin.map((v) => Math.log(v + 1e-12)).reduce((a, b) => a + b, 0) / lin.length);
      out.push({
        trackMuted: tracks[0].muted,
        readyState: tracks[0].readyState,
        peakDb: Math.round(peakDb * 10) / 10,
        rms: Math.round(peakRms * 1000) / 1000,
        flatness: Math.round((geo / arith) * 1000) / 1000,
      });
    }
    await ctx.close();
    return { count: out.length, tracks: out };
  });
}

// A decode is "healthy" if a remote track carries real energy with a tonal
// (non-flat) spectrum. Silence (peak ≈ noise floor / rms ≈ 0) means frames were
// dropped; a flat high-energy spectrum means they decoded to garbage.
function verdict(m) {
  if (m.error) return { ok: false, why: m.error };
  const live = m.tracks.filter((t) => t.readyState === "live");
  if (!live.length) return { ok: false, why: "no live remote audio track" };
  const tonal = live.find((t) => t.peakDb > -60 && t.rms > 0.003 && t.flatness < 0.5);
  if (tonal) return { ok: true, why: `tonal decode (peak ${tonal.peakDb}dB, rms ${tonal.rms}, flatness ${tonal.flatness})` };
  const energetic = live.find((t) => t.peakDb > -60 && t.rms > 0.003);
  if (energetic) return { ok: false, why: `energy but FLAT spectrum → garbled decode (flatness ${energetic.flatness})` };
  return { ok: false, why: `silent remote audio → frames dropped (peak ${live[0].peakDb}dB, rms ${live[0].rms})` };
}

let failed = false;
try {
  const A = await newUser();
  await A.page.waitForSelector(".login-card");
  await clickText(A.page, "Create a new identity");
  await A.page.waitForSelector(".app");
  await sleep(1000);
  await clickText(A.page, "Create a community");
  await A.page.waitForSelector(".modal input");
  await A.page.type(".modal input", "Voice Audio");
  const relayBox = await A.page.$(".modal textarea");
  await relayBox.click({ clickCount: 3 });
  await relayBox.type("wss://relay.damus.io\nwss://nos.lol");
  await clickText(A.page, "Create");
  await A.page.waitForFunction(() => document.querySelector(".channel"), { timeout: 15000 });
  await sleep(2000);

  await A.page.evaluate(() => document.querySelector(".channel-cat button").click());
  await A.page.waitForSelector(".modal");
  await A.page.type('.modal input[placeholder="new-channel"]', "hangout");
  await A.page.evaluate(() => document.querySelector("#voice").click());
  await clickText(A.page, "Create");
  await sleep(2000);

  await clickText(A.page, "Invite people", ".channel");
  await A.page.waitForFunction(() => document.querySelector(".invite-link")?.textContent?.length > 20, { timeout: 15000 });
  const link = await A.page.evaluate(() => document.querySelector(".invite-link").textContent);
  console.log("invite:", link.slice(0, 40) + "…");
  await A.page.evaluate(() => document.querySelector(".modal-backdrop")?.click());

  const B = await newUser();
  await B.page.waitForSelector(".login-card");
  await clickText(B.page, "Create a new identity");
  await B.page.waitForSelector(".app");
  await sleep(1000);
  await clickText(B.page, "Join with a link").catch(() => clickText(B.page, "Join with an invite link"));
  await B.page.waitForSelector(".modal input");
  await B.page.type(".modal input", link);
  await clickText(B.page, "Join");
  await B.page.waitForFunction(
    () => [...document.querySelectorAll(".voice-channel")].some((r) => r.textContent.includes("hangout")),
    { timeout: 20000 },
  );
  await sleep(1500);

  await joinVoice(A.page);
  console.log("A: joined");
  await sleep(3000);
  await joinVoice(B.page);
  console.log("B: joined");
  // Let both subscribe to each other's mic track + the tone get flowing.
  await sleep(11000);

  const mA = await measureRemoteAudio(A.page);
  const mB = await measureRemoteAudio(B.page);
  console.log("A hears B:", JSON.stringify(mA));
  console.log("B hears A:", JSON.stringify(mB));
  const vA = verdict(mA);
  const vB = verdict(mB);
  console.log("A verdict:", vA.ok ? "OK" : "FAIL", "—", vA.why);
  console.log("B verdict:", vB.ok ? "OK" : "FAIL", "—", vB.why);

  if (!vA.ok || !vB.ok) {
    failed = true;
    console.log("\nAUDIO DECODE FAILED");
  } else {
    console.log("\n🔊 AUDIO DECODE VERIFIED — both peers decode the other's live E2EE audio");
  }
} catch (e) {
  console.error("DRIVER ERROR:", e.message);
  failed = true;
} finally {
  await sleep(500);
  await browser.close();
  process.exit(failed ? 1 : 0);
}
