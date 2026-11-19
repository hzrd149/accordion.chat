import { describe, expect, it } from "vitest";
import { debugReport, diagnosticsSnapshot, errorText, toClipboard } from "../src/helpers/community-debug-report";

const SECRET = "ab".repeat(32);

describe("community debug report", () => {
  it("replaces secret material fields with fingerprints", () => {
    const out = debugReport("cid", {
      raw_material: { community_root: SECRET, control_root: SECRET, channels: [{ id: "c1", key: SECRET, held: [{ epoch: 0, key: SECRET }] }] },
      invite: { token: SECRET, signer_sk: SECRET },
      bytes: new Uint8Array(32),
    });
    expect(out).not.toContain(SECRET);
    expect(out).toContain("fp:");
    expect(out).toContain("<32 bytes>");
    expect(JSON.parse(out).community_id).toBe("cid");
  });

  it("keeps public diagnostic scope ids and serializes errors", () => {
    const log = diagnosticsSnapshot("cid", [
      { at: 0, kind: "background", d: { stage: "plane-publish", plane: "control", key: "chan1", error: new Error("boom", { cause: "relay down" }) } },
    ] as never);
    const out = JSON.parse(toClipboard(log));
    expect(out[0]).toMatchObject({ scope_id: "chan1", plane: "control", error: "Error: boom (cause: relay down)" });
  });

  it("formats unknown errors", () => {
    expect(errorText(undefined)).toBeUndefined();
    expect(errorText("x")).toBe("x");
    expect(errorText({ code: 1 })).toContain('"code": 1');
  });
});
