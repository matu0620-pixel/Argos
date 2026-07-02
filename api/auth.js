// api/auth.js — ARGOS Equity Intelligence ログイン/ログアウト（Vercel Edge Function）
//   POST /api/auth        … user/pass を検証し、署名付き Cookie を発行して / へ
//   GET  /api/auth?logout … セッションを破棄して /login.html へ
// 認証情報は環境変数: EI_USER / EI_PASS / EI_SESSION_SECRET
// middleware.js と同じ HMAC-SHA256（Web Crypto）でトークンを発行する。
export const config = { runtime: "edge" };

const COOKIE = "ei_sess";
const TTL_MS = 12 * 60 * 60 * 1000; // 12時間
const enc = new TextEncoder();

function b64url(bytes) {
  const a = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str) { return b64url(enc.encode(str)); }

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(sig);
}
async function makeToken(secret, user) {
  const payload = b64urlStr(JSON.stringify({ u: user, exp: Date.now() + TTL_MS }));
  return payload + "." + (await hmac(secret, payload));
}

// タイミング非依存ではないが、HMAC/パスワード照合用途として許容。
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function redirect(location, cookie) {
  const headers = { Location: location };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

export default async function handler(request) {
  const url = new URL(request.url);
  const user = (process.env.EI_USER || "").trim();
  const pass = (process.env.EI_PASS || "").trim();
  // 署名鍵は任意。未設定なら user/pass から導出（middleware.js と同一ロジック）。
  const secret = (process.env.EI_SESSION_SECRET || "").trim() || (user + "|" + pass + "|argos-ei-v1");
  const secure = url.protocol === "https:";
  const base = `${COOKIE}=`;
  const attrs = `; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

  // ログアウト
  if (request.method === "GET" && (url.searchParams.has("logout"))) {
    return redirect("/login.html", `${base}; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 認証情報が未設定なら、そもそも保護していないので素通り
  if (!user || !pass) {
    return redirect("/");
  }

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return redirect("/login.html?err=1");
  }
  const inUser = String(form.get("user") || "");
  const inPass = String(form.get("pass") || "");

  if (safeEqual(inUser, user) && safeEqual(inPass, pass)) {
    const token = await makeToken(secret, user);
    const cookie = `${base}${token}${attrs}; Max-Age=${Math.floor(TTL_MS / 1000)}`;
    return redirect("/", cookie);
  }
  return redirect("/login.html?err=1");
}
