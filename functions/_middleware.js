// Private-use gate for the whole site (static files + /api/*).
// Requires two Pages secrets: SITE_PASSWORD and SESSION_SECRET.

const COOKIE = "fn_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30; // 30 days
const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function passwordMatches(input, expected) {
  // Compare HMACs of both values so length never leaks and comparison is constant-time.
  const a = await hmac("pw-compare", input);
  const b = await hmac("pw-compare", expected);
  return safeEqual(a, b);
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function makeToken(secret) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  return `${exp}.${await hmac(secret, exp)}`;
}

async function validToken(token, secret) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sig, await hmac(secret, exp));
}

const baseHeaders = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store",
};

function loginPage(error) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Private — Franchise Navigator</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f8fafc; font-family: 'Segoe UI', system-ui, sans-serif; color: #0f172a; padding: 16px; }
  form { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 28px; width: 100%; max-width: 360px; box-shadow: 0 4px 24px rgba(15,23,42,.06); }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p { font-size: 13px; color: #475569; margin-bottom: 18px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 15px; margin-bottom: 12px; }
  input:focus { outline: 2px solid #0f172a; outline-offset: 1px; }
  button { width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: #0f172a; color: #fff; font-size: 15px; cursor: pointer; }
  .err { color: #b91c1c; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
<form method="POST" action="/__login">
  <h1>Franchise Navigator</h1>
  <p>Private access only.</p>
  ${error ? '<div class="err">Incorrect password.</div>' : ""}
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required />
  <button type="submit">Enter</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...baseHeaders },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!env.SITE_PASSWORD || !env.SESSION_SECRET) {
    return new Response("Server is missing SITE_PASSWORD or SESSION_SECRET", {
      status: 500, headers: baseHeaders,
    });
  }

  // Login submit
  if (url.pathname === "/__login" && request.method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403, headers: baseHeaders });

    let password = "";
    try { password = String((await request.formData()).get("password") || ""); } catch {}

    if (password && await passwordMatches(password, env.SITE_PASSWORD)) {
      const token = await makeToken(env.SESSION_SECRET);
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
          ...baseHeaders,
        },
      });
    }
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return loginPage(true);
  }

  // Logout
  if (url.pathname === "/__logout") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
        ...baseHeaders,
      },
    });
  }

  // Authenticated → pass through
  if (await validToken(getCookie(request, COOKIE), env.SESSION_SECRET)) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    if (url.pathname.startsWith("/api/")) out.headers.set("Cache-Control", "no-store");
    return out;
  }

  // Not authenticated
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...baseHeaders },
    });
  }
  return loginPage(false);
}
