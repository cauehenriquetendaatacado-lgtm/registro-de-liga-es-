/* Código compartilhado pelo discador (index.html) e pelo dashboard (dashboard.html). */
(function () {
  "use strict";
  var cfg = window.APP_CONFIG || {};
  var cloud = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  var sb = cloud ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  var $ = function (id) { return document.getElementById(id); };
  var QN = { 1: "Sangria", 2: "Fechamento de caixa", 3: "Apoio de cópia" };
  var fmt = function (s) {
    s = Math.round(s);
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? h + "h " + m + "m " + r + "s" : m ? m + "m " + r + "s" : r + "s";
  };
  var clock = function (s) {
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m];
    });
  };

  var ls = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch (e) { return []; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* app usa {id,name,num,at,dur,ok,qual}; a tabela usa colunas por extenso */
  var toRow = function (c) {
    return { id: c.id, name: c.name || "", num: c.num, started_at: c.at, duration: c.dur,
             answered: !!c.ok, qualification: c.qual || null };
  };
  var fromRow = function (r) {
    return { id: Number(r.id), name: r.name || "", num: r.num, at: Number(r.started_at),
             dur: r.duration, ok: r.answered, qual: r.qualification || undefined };
  };

  var Store = {
    mode: cloud ? "cloud" : "local",
    /* devolve "cloud" (salva no Supabase), "queue" (sem conexão, guardada para enviar) ou "local" */
    save: async function (c) {
      if (!cloud) { var a = ls.get("calls"); a.unshift(c); ls.set("calls", a); return "local"; }
      try {
        var r = await sb.from("calls").insert(toRow(c));
        if (!r.error || r.error.code === "23505") return "cloud";
      } catch (e) {}
      var q = ls.get("fila"); q.push(c); ls.set("fila", q);
      return "queue";
    },
    flush: async function () {
      if (!cloud) return;
      var q = ls.get("fila"); if (!q.length) return;
      var left = [];
      for (var i = 0; i < q.length; i++) {
        try {
          var r = await sb.from("calls").insert(toRow(q[i]));
          if (r.error && r.error.code !== "23505") left.push(q[i]);
        } catch (e) { left.push(q[i]); }
      }
      ls.set("fila", left);
    },
    load: async function () {
      if (!cloud) return ls.get("calls");
      var r = await sb.from("calls").select("*").order("started_at", { ascending: false }).limit(5000);
      if (r.error) throw r.error;
      return r.data.map(fromRow);
    },
    remove: async function (id) {
      if (!cloud) { ls.set("calls", ls.get("calls").filter(function (c) { return c.id != id; })); return; }
      var r = await sb.from("calls").delete().eq("id", id);
      if (r.error) throw r.error;
    },
    /* chama cb(lista, erro) agora e a cada mudança na tabela */
    subscribe: function (cb) {
      var timer = null;
      var run = async function () {
        try { cb(await Store.load(), null); } catch (e) { cb(null, e); }
      };
      run();
      if (cloud) {
        sb.channel("calls-changes")
          .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, function () {
            clearTimeout(timer); timer = setTimeout(run, 300);
          }).subscribe();
        setInterval(run, 60000);
      }
    }
  };

  /* login por e-mail e senha (usuário criado no painel do Supabase) */
  var Auth = {
    entered: false,
    start: function (onIn) {
      var login = $("login"), main = $("main"), out = $("logout");
      if (!cloud) {
        main.classList.remove("hide");
        if (out) out.classList.add("hide");
        onIn();
        return;
      }
      var show = function () { main.classList.add("hide"); login.classList.remove("hide"); };
      var enter = function () {
        login.classList.add("hide"); main.classList.remove("hide");
        if (!Auth.entered) { Auth.entered = true; onIn(); }
      };
      sb.auth.getSession().then(function (r) { r.data.session ? enter() : show(); });
      sb.auth.onAuthStateChange(function (ev) {
        if (ev === "SIGNED_OUT") { Auth.entered = false; show(); }
      });
      $("loginForm").addEventListener("submit", async function (e) {
        e.preventDefault();
        $("loginErr").textContent = "";
        var r = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("pass").value });
        if (r.error) { $("loginErr").textContent = "E-mail ou senha incorretos."; return; }
        $("pass").value = "";
        enter();
      });
      if (out) out.onclick = function () { sb.auth.signOut(); };
    }
  };

  if ("serviceWorker" in navigator) {
    addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  window.App = { cloud: cloud, sb: sb, $: $, QN: QN, fmt: fmt, clock: clock, esc: esc, Store: Store, Auth: Auth };
})();
