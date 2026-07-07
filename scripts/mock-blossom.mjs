// Minimal BUD-02 Blossom server for E2E testing. Accepts any authed PUT /upload,
// stores ciphertext by sha256, serves GET/HEAD /<sha256>. CORS wide open.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = process.env.PORT || 3999;
const store = new Map(); // sha256 -> { bytes, type }

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

const server = createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const hash = url.pathname.slice(1);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "PUT" && url.pathname === "/upload") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    const sha = createHash("sha256").update(bytes).digest("hex");
    store.set(sha, { bytes, type: req.headers["content-type"] || "application/octet-stream" });
    const body = JSON.stringify({
      url: `http://localhost:${PORT}/${sha}`, sha256: sha, size: bytes.length,
      type: store.get(sha).type, uploaded: Math.floor(Date.now() / 1000),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    console.log(`stored ${sha} (${bytes.length} bytes)`);
    return res.end(body);
  }

  if ((req.method === "GET" || req.method === "HEAD") && store.has(hash)) {
    const { bytes, type } = store.get(hash);
    res.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length });
    return res.end(req.method === "HEAD" ? undefined : bytes);
  }
  res.writeHead(404); res.end("not found");
});
server.listen(PORT, () => console.log(`mock blossom on http://localhost:${PORT}`));
