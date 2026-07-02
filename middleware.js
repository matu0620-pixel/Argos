// middleware.js — ARGOS Equity Intelligence ログインゲート（Vercel Edge Middleware）
// EI_USER / EI_PASS / EI_SESSION_SECRET がすべて設定されている時だけ保護を有効化する。
//   - 未認証アクセスは /login.html へリダイレクト。
//   - いずれかが未設定なら従来どおり公開（ロックアウト防止）。
// 認証 Cookie は api/auth.js と同じ HMAC-SHA256（Web Crypto）で検証する。
import { next } from "@vercel/edge";

export const config = {
  // /api/auth・/api/bench-financials（ポータルBenchから利用・公開EDINETデータ）・ログイン画面・静的以外を保護対象にする
  matcher: ["/((?!api/auth|api/bench-financials|login\\.html|version\\.json|favicon\\.ico|robots\\.txt).*)"],
};

const COOKIE = "ei_sess";
const enc = new TextEncoder();

function fromb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function b64url(bytes) {
  const a = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(sig);
}
async function verify(secret, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const idx = token.indexOf(".");
  const p = token.slice(0, idx), s = token.slice(idx + 1);
  const expected = await hmac(secret, p);
  if (s !== expected) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(fromb64url(p)));
    if (!obj || typeof obj.exp !== "number" || Date.now() > obj.exp) return null;
    return obj;
  } catch (_) {
    return null;
  }
}
function getCookie(request, name) {
  const c = request.headers.get("cookie");
  if (!c) return null;
  for (const part of c.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export default async function middleware(request) {
  const user = (process.env.EI_USER || "").trim();
  const pass = (process.env.EI_PASS || "").trim();
  // 署名鍵は任意。未設定なら user/pass から導出するので EI_USER と EI_PASS の2つだけで保護が有効になる。
  const secret = (process.env.EI_SESSION_SECRET || "").trim() || (user + "|" + pass + "|argos-ei-v1");

  // EI_USER / EI_PASS が未設定なら保護しない（公開のまま）
  if (!user || !pass) return next();

  const token = getCookie(request, COOKIE);
  if (token && (await verify(secret, token))) return next();

  return Response.redirect(new URL("/login.html", request.url), 307);
}
