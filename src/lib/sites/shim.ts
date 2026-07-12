/**
 * The `Sites` client shim injected into a BACKEND-ENABLED Site's served page
 * (see src/app/s/[slug]/route.ts). It gives the model-authored frontend a tiny,
 * safe wrapper over the same-origin data plane (/api/kv/*, /api/docs/*) so the
 * model writes `await Sites.docs.append('guestbook', {...})` instead of
 * hand-rolling fetch — the "LLM-safe shim" pattern.
 *
 * Injected ONLY when the Site is served on its own origin (subdomain) AND its
 * backend is enabled, so:
 *  - the calls are same-origin (the page and /api/* share <slug>.<SITES_DOMAIN>),
 *  - it is added at SERVE time (not in buildSiteSrcDoc), so it never leaks into
 *    in-app artifact previews, which reuse the same sandbox builders.
 *
 * The script is inline; the real-origin CSP allows `script-src 'unsafe-inline'`
 * and `connect-src 'self'`, so the shim runs and can reach the site's own API.
 */

const SITES_SHIM = `<script>
(function () {
  async function req(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    var res = await fetch(path, opts);
    if (!res.ok) {
      var detail = "";
      try { detail = (await res.json()).error || ""; } catch (e) {}
      throw new Error("Sites " + method + " " + path + " failed: " + res.status + " " + detail);
    }
    return res.json();
  }
  function enc(s) { return encodeURIComponent(String(s)); }
  window.Sites = {
    kv: {
      get: function (collection, key) {
        return req("GET", "/api/kv/" + enc(collection) + "/" + enc(key)).then(function (r) { return r.value; });
      },
      put: function (collection, key, value) {
        return req("PUT", "/api/kv/" + enc(collection) + "/" + enc(key), { value: value }).then(function () { return true; });
      },
      "delete": function (collection, key) {
        return req("DELETE", "/api/kv/" + enc(collection) + "/" + enc(key)).then(function (r) { return r.deleted; });
      }
    },
    docs: {
      append: function (collection, data) {
        return req("POST", "/api/docs/" + enc(collection), { data: data }).then(function (r) { return r.id; });
      },
      list: function (collection) {
        return req("GET", "/api/docs/" + enc(collection)).then(function (r) { return r.documents; });
      }
    },
    me: {
      id: function () {
        return req("GET", "/api/me").then(function (r) { return r.id; });
      },
      kv: {
        get: function (collection, key) {
          return req("GET", "/api/me/kv/" + enc(collection) + "/" + enc(key)).then(function (r) { return r.value; });
        },
        put: function (collection, key, value) {
          return req("PUT", "/api/me/kv/" + enc(collection) + "/" + enc(key), { value: value }).then(function () { return true; });
        },
        "delete": function (collection, key) {
          return req("DELETE", "/api/me/kv/" + enc(collection) + "/" + enc(key)).then(function (r) { return r.deleted; });
        }
      }
    },
    account: {
      current: function () {
        return req("GET", "/api/account").then(function (r) { return r.account; });
      },
      signup: function (username, password) {
        return req("POST", "/api/account/signup", { username: username, password: password }).then(function (r) { return r.username; });
      },
      login: function (username, password) {
        return req("POST", "/api/account/login", { username: username, password: password }).then(function (r) { return r.username; });
      },
      logout: function () {
        return req("POST", "/api/account/logout").then(function () { return true; });
      }
    },
    call: function (name, params) {
      return req("POST", "/api/call/" + enc(name), { params: params || {} }).then(function (r) { return r.body; });
    }
  };
})();
</script>`;

/**
 * Insert the shim into a served Site document, right after the opening <head>
 * (falling back to <body>, then prepend), so `window.Sites` is defined before the
 * page's own scripts run.
 */
export function injectSitesShim(html: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index != null) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + SITES_SHIM + html.slice(at);
  }
  const body = html.match(/<body[^>]*>/i);
  if (body && body.index != null) {
    const at = body.index + body[0].length;
    return html.slice(0, at) + SITES_SHIM + html.slice(at);
  }
  return SITES_SHIM + html;
}
