/* NodeCore discovery tree viewer.
 *
 * Reads data/nodecore-discovery.json (produced by extract_hints.py) and lays
 * the hints out left-to-right by tier. In spoilers mode only discovered hints,
 * the hints they make available, and "???" placeholders for partly-unlocked
 * hints are drawn; clicking an available hint marks it discovered and reveals
 * whatever it unlocks next.
 */
(function () {
  "use strict";

  var DATA_URL = "data/nodecore-discovery.json";
  var CARD_W = 210, CARD_H = 56, GAP_X = 80, GAP_Y = 14, PAD = 28, HEAD = 34;
  var STORE_DISC = "nc-tree:discovered", STORE_SPOIL = "nc-tree:spoilers";

  var data, nodes = {}, parentEdges = {}, childEdges = {};
  var reqInfo = {};           // id -> [{key, providers:[edge], cycleOnly, world}]
  var discovered = new Set();
  var spoilers = true;
  var selected = null, focus = null, zoom = 1;
  var visState = {};          // id -> "done" | "open" | "locked" (only visible ids)
  var positions = {};         // id -> {x, y}
  var fresh = new Set();      // ids to animate on next render
  var contentSize = { w: 0, h: 0 };

  var $ = function (id) { return document.getElementById(id); };
  var viewport = $("viewport"), stage = $("stage"), canvas = $("canvas"), details = $("details");

  // ---------- storage (best effort) ----------
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  // ---------- helpers ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function modName(m) { return m.replace(/^nc_/, "").replace(/_/g, " "); }
  function hue(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  function keyKind(k) {
    if (/^toolcap:/.test(k)) return "toolcap";
    if (/^group:/.test(k)) return "group";
    if (/^[a-z0-9_]+:[a-z0-9_]+:/.test(k)) return "event";
    if (/^nc_[a-z0-9_]+:[a-z0-9_]+$/.test(k)) return "item";
    if (/:/.test(k)) return "event";
    return "craft";
  }
  function sourceUrl(node) {
    var m = /^(.*):(\d+)$/.exec(node.source);
    var base = data.meta.source_repo.replace(/\.git$/, "") + "/-/blob/" + data.meta.source_commit + "/";
    return m ? base + m[1] + "#L" + m[2] : base + node.source;
  }

  // ---------- graph logic ----------
  function buildIndex() {
    data.nodes.forEach(function (n) { nodes[n.id] = n; parentEdges[n.id] = []; childEdges[n.id] = []; });
    data.edges.forEach(function (e) {
      if (!nodes[e.from] || !nodes[e.to]) return;
      parentEdges[e.to].push(e);
      childEdges[e.from].push(e);
    });
    var world = data.world_provided_req_keys || {};
    data.nodes.forEach(function (n) {
      reqInfo[n.id] = n.reqs.keys.map(function (k) {
        var all = parentEdges[n.id].filter(function (e) { return e.via === k; });
        var live = all.filter(function (e) { return !e.closes_cycle; });
        return { key: k, providers: live, cycleOnly: all.length > 0 && live.length === 0, world: k in world };
      });
    });
  }

  // A key is met when any non-cycle provider is discovered. Keys whose only
  // providers close a cycle, or that the world simply hands you, are free.
  function keyMet(info) {
    if (info.providers.length) return info.providers.some(function (e) { return discovered.has(e.from); });
    return info.cycleOnly || info.world;
  }
  function isAvailable(id) {
    var n = nodes[id];
    if (n.reqs.op === "always") return true;
    var infos = reqInfo[id];
    return n.reqs.op === "or" ? infos.some(keyMet) : infos.every(keyMet);
  }
  function stateOf(id) {
    if (discovered.has(id)) return "done";
    if (isAvailable(id)) return "open";
    return "locked";
  }
  function computeVisibility() {
    visState = {};
    data.nodes.forEach(function (n) {
      var s = stateOf(n.id);
      if (!spoilers) { visState[n.id] = s; return; }
      if (s !== "locked") { visState[n.id] = s; return; }
      var teased = parentEdges[n.id].some(function (e) { return !e.closes_cycle && discovered.has(e.from); });
      if (teased) visState[n.id] = "locked";
    });
  }
  function walk(id, edgesOf, pick) {
    var out = new Set(), stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      edgesOf[cur].forEach(function (e) {
        if (e.closes_cycle) return;
        var nxt = pick(e);
        if (!out.has(nxt)) { out.add(nxt); stack.push(nxt); }
      });
    }
    return out;
  }
  function ancestors(id) { return walk(id, parentEdges, function (e) { return e.from; }); }
  function descendants(id) { return walk(id, childEdges, function (e) { return e.to; }); }
  function hiddenName(id) { return spoilers && visState[id] !== "done" && visState[id] !== "open"; }

  // ---------- layout ----------
  function layout(ids) {
    var byTier = {};
    ids.forEach(function (id) { (byTier[nodes[id].tier] = byTier[nodes[id].tier] || []).push(id); });
    var tiers = Object.keys(byTier).map(Number).sort(function (a, b) { return a - b; });
    var cols = tiers.map(function (t) {
      return byTier[t].sort(function (a, b) {
        return nodes[a].mod.localeCompare(nodes[b].mod) || nodes[a].text.localeCompare(nodes[b].text);
      });
    });
    var inSet = new Set(ids);
    // Barycentre sweeps to cut down edge crossings.
    function order(col, idx, edgesOf, pick) {
      var score = {};
      col.forEach(function (id, i) {
        var ns = edgesOf[id].filter(function (e) { return !e.closes_cycle && inSet.has(pick(e)); })
          .map(function (e) { return idx[pick(e)]; }).filter(function (v) { return v !== undefined; });
        score[id] = ns.length ? ns.reduce(function (a, b) { return a + b; }, 0) / ns.length : i;
      });
      col.sort(function (a, b) { return score[a] - score[b]; });
    }
    function indexOf() {
      var idx = {};
      cols.forEach(function (c) {
        var off = (maxRows - c.length) / 2;
        c.forEach(function (id, i) { idx[id] = i + off; });
      });
      return idx;
    }
    var maxRows = Math.max.apply(null, cols.map(function (c) { return c.length; }).concat([1]));
    for (var pass = 0; pass < 6; pass++) {
      for (var i = 1; i < cols.length; i++) order(cols[i], indexOf(), parentEdges, function (e) { return e.from; });
      for (var j = cols.length - 2; j >= 0; j--) order(cols[j], indexOf(), childEdges, function (e) { return e.to; });
    }
    positions = {};
    cols.forEach(function (c, ci) {
      var off = (maxRows - c.length) * (CARD_H + GAP_Y) / 2;
      c.forEach(function (id, ri) {
        positions[id] = { x: PAD + ci * (CARD_W + GAP_X), y: PAD + HEAD + off + ri * (CARD_H + GAP_Y) };
      });
    });
    contentSize = {
      w: PAD * 2 + cols.length * CARD_W + Math.max(0, cols.length - 1) * GAP_X,
      h: PAD * 2 + HEAD + maxRows * (CARD_H + GAP_Y) - GAP_Y
    };
    return tiers;
  }

  // ---------- rendering ----------
  function render() {
    computeVisibility();
    var ids = Object.keys(visState);
    if (focus && visState[focus]) {
      var keep = ancestors(focus); keep.add(focus);
      ids = ids.filter(function (id) { return keep.has(id); });
    } else if (focus) {
      focus = null;
    }
    $("focusBar").hidden = !focus;
    if (focus) $("focusName").textContent = hiddenName(focus) ? "???" : cap(nodes[focus].text);

    var tiers = layout(ids);
    var shown = new Set(ids);
    var html = [];
    var svg = ['<svg width="' + contentSize.w + '" height="' + contentSize.h + '">'];

    data.edges.forEach(function (e, i) {
      if (!shown.has(e.from) || !shown.has(e.to)) return;
      if (spoilers && !discovered.has(e.from)) return;
      // Loops back to earlier tiers would cross the whole map; they're listed in the details panel instead.
      if (e.closes_cycle) return;
      var a = positions[e.from], b = positions[e.to];
      var x1 = a.x + CARD_W, y1 = a.y + CARD_H / 2, x2 = b.x, y2 = b.y + CARD_H / 2;
      var dx = Math.max(30, (x2 - x1) / 2);
      var d = "M" + x1 + " " + y1 + "C" + (x1 + dx) + " " + y1 + " " + (x2 - dx) + " " + y2 + " " + x2 + " " + y2;
      var tip = hiddenName(e.to) ? "" : "via " + e.via + " (" + e.resolved_by + ")";
      svg.push('<path class="edge" data-from=""' + esc(e.from) +
        '" data-to="' + esc(e.to) + '" d="' + d + '"><title>' + esc(tip) + "</title></path>");
    });
    svg.push("</svg>");
    html.push(svg.join(""));

    tiers.forEach(function (t, ci) {
      html.push('<div class="tier-label" style="left:' + (PAD + ci * (CARD_W + GAP_X)) + "px;top:" + PAD +
        "px;width:" + CARD_W + 'px">Tier ' + t + "</div>");
    });

    ids.forEach(function (id) {
      var n = nodes[id], p = positions[id], s = visState[id], hide = hiddenName(id);
      var title = hide ? "???" : cap(n.text);
      var meta = hide ? "locked" : modName(n.mod) + (s === "open" && spoilers ? " · new" : "");
      var badge = s === "done" ? "✓" : s === "open" ? "●" : hide ? "🔒" : "";
      html.push('<button class="card ' + s + (fresh.has(id) ? " fresh" : "") + '" data-id="' + esc(id) +
        '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + CARD_W + "px;height:" + CARD_H +
        "px;--hue:" + hue(n.mod) + '" title="' + esc(hide ? "Locked — discover more to reveal" : cap(n.text)) + '">' +
        '<span class="t">' + esc(title) + '</span><span class="m">' + esc(meta) + "</span>" +
        (badge ? '<span class="badge" aria-hidden="true">' + badge + "</span>" : "") + "</button>");
    });

    canvas.innerHTML = html.join("");
    fresh.clear();
    applyZoom();
    if (selected && !shown.has(selected)) selected = null;
    highlight();
    renderDetails();
    $("progress").textContent = discovered.size + " / " + data.nodes.length + " discovered";
  }

  function highlight() {
    canvas.classList.toggle("has-sel", !!selected);
    var anc = selected ? ancestors(selected) : new Set();
    var desc = selected ? descendants(selected) : new Set();
    canvas.querySelectorAll(".card").forEach(function (el) {
      var id = el.getAttribute("data-id");
      el.classList.toggle("sel", id === selected);
      el.classList.toggle("anc", anc.has(id));
      el.classList.toggle("desc", desc.has(id));
    });
    canvas.querySelectorAll(".edge").forEach(function (el) {
      var f = el.getAttribute("data-from"), t = el.getAttribute("data-to");
      el.classList.toggle("hl-anc", !!selected && (t === selected || anc.has(t)) && anc.has(f));
      el.classList.toggle("hl-desc", !!selected && (f === selected || desc.has(f)) && desc.has(t));
    });
  }

  function nodeLink(id, extra) {
    var s = visState[id];
    if (!s) return '<span class="nlink locked"><span class="ic">?</span><span class="nt">??? (not yet revealed)</span></span>';
    var hide = hiddenName(id);
    var ic = s === "done" ? "✓" : s === "open" ? "●" : hide ? "🔒" : "○";
    return '<button class="nlink ' + s + '" data-go="' + esc(id) + '"><span class="ic">' + ic +
      '</span><span class="nt">' + esc(hide ? "???" : cap(nodes[id].text)) + "</span>" + (extra || "") + "</button>";
  }

  function keyNote(k) {
    var notes = [];
    if (/^group:/.test(k) && data.groups[k.slice(6)]) notes.push(data.groups[k.slice(6)]);
    var cur = data.curated_providers[k];
    if (cur && cur.note) notes.push(cur.note);
    if (data.craft_outputs[k]) notes.push("Produces " + data.craft_outputs[k].join(", "));
    return notes.length ? '<div class="note">' + esc(notes.join(" — ")) + "</div>" : "";
  }

  function renderIntro() {
    var m = data.meta;
    return (
      '<h2>How to use this</h2>' +
      '<p>Each card is one of NodeCore\'s in-game hints. Arrows point from a discovery to the ones it unlocks; ' +
      'tiers run left to right from the things you can do on day one.</p>' +
      (spoilers
        ? '<p><strong>Spoilers mode is on.</strong> You only see what you\'ve discovered and what\'s available next. ' +
          'Click a highlighted card once you\'ve done it in-game to reveal what it unlocks. ' +
          '<code>???</code> cards need more discoveries first.</p>'
        : '<p>Click any card to see what it needs and what it leads to. Turn on <strong>Spoilers mode</strong> to ' +
          'hide everything you haven\'t unlocked yet.</p>') +
      '<h3>Legend</h3><ul class="legend">' +
      '<li><span class="swatch done"></span>Discovered</li>' +
      '<li><span class="swatch open"></span>Available now</li>' +
      '<li><span class="swatch locked"></span>Locked (needs more)</li>' +
      '<li><span class="line anc"></span>Prerequisites of the selection</li>' +
      '<li><span class="line desc"></span>What the selection leads to</li>' +
      '</ul><p class="sub">A few steps loop back to earlier ones (e.g. chips pack back into cobble); those are marked ' +
      '<em>(loop)</em> in the details panel rather than drawn.</p>' +
      '<h3>About the data</h3><ul class="meta-list">' +
      "<li>" + m.hint_count + " hints · " + m.edge_count + " links · " + (m.max_tier + 1) + " tiers</li>" +
      '<li>From <a href="' + esc(m.source_repo.replace(/\.git$/, "")) + '">NodeCore</a> commit <code>' +
      esc(m.source_commit.slice(0, 7)) + "</code> (" + esc(m.source_date) + ")</li>" +
      '<li><a href="' + DATA_URL + '">Raw JSON</a></li></ul>'
    );
  }

  function renderDetails() {
    details.classList.toggle("collapsed", !selected);
    if (!selected) { details.innerHTML = renderIntro(); return; }
    var id = selected, n = nodes[id], s = visState[id] || stateOf(id), hide = hiddenName(id);
    var out = ['<button class="ghost small close" data-close>Close</button>'];
    var label = { done: "Discovered", open: "Available", locked: "Locked" }[s];
    out.push('<p><span class="pill ' + s + '">' + label + '</span><span class="pill">Tier ' + n.tier + "</span>" +
      (!hide && n.hidden ? '<span class="pill" title="NodeCore never lists this as an upcoming hint">secret</span>' : "") + "</p>");
    out.push("<h2>" + esc(hide ? "???" : cap(n.text)) + "</h2>");
    if (!hide) {
      out.push('<div class="sub">' + esc(modName(n.mod)) + ' · <a href="' + esc(sourceUrl(n)) +
        '" target="_blank" rel="noopener">' + esc(n.source) + "</a></div>");
    } else {
      out.push('<p class="sub">You haven\'t unlocked this yet. It needs the discoveries below.</p>');
    }

    out.push('<div class="actions">');
    if (s === "done") out.push('<button class="ghost" data-toggle>Mark as not discovered</button>');
    else if (s === "open") out.push('<button class="primary" data-toggle>I\'ve done this — mark discovered</button>');
    if (!hide) out.push('<button class="ghost" data-focus>' + (focus === id ? "Show everything" : "Show only what's needed") + "</button>");
    out.push("</div>");

    if (!hide) {
      out.push("<h3>Completed by " + (n.goal.keys.length > 1 ? '<span class="op">' + (n.goal.op === "and" ? "all" : "any") + "</span> of" : "") + "</h3><ul>");
      n.goal.keys.forEach(function (k) {
        out.push('<li class="req-key"><div class="k"><code>' + esc(k) + '</code><span class="kind">' + keyKind(k) + "</span></div>" + keyNote(k) + "</li>");
      });
      out.push("</ul>");
    }

    out.push("<h3>Requires</h3>");
    if (n.reqs.op === "always") {
      out.push("<p>Nothing — available from the very start.</p>");
    } else {
      out.push("<p>" + (reqInfo[id].length > 1 ? '<span class="op">' + (n.reqs.op === "and" ? "All" : "Any") + "</span> of these:" : "This:") + "</p><ul>");
      reqInfo[id].forEach(function (info) {
        var met = keyMet(info);
        if (hide && !met) {
          out.push('<li class="req-key"><div class="k"><code>???</code></div>' +
            '<div class="note">Needs a discovery you haven\'t made yet.</div></li>');
          return;
        }
        out.push('<li class="req-key"><div class="k">' + (met ? '<span title="met">✓</span>' : "") + "<code>" +
          esc(info.key) + '</code><span class="kind">' + keyKind(info.key) + "</span></div>" + keyNote(info.key));
        if (info.providers.length) {
          out.push('<ul class="providers">');
          info.providers.forEach(function (e) {
            out.push("<li>" + nodeLink(e.from, e.resolved_by === "implied" ? ' <span class="sub">(implied)</span>' : "") + "</li>");
          });
          out.push("</ul>");
        } else if (info.world) {
          out.push('<div class="note">Found just by playing — no hint teaches it.</div>');
        } else if (info.cycleOnly) {
          out.push('<div class="note">Only reachable through a loop; treated as free.</div>');
        } else {
          out.push('<div class="note">No hint grants this directly.</div>');
        }
        out.push("</li>");
      });
      out.push("</ul>");
    }

    if (!hide) {
      var kids = [], seen = new Set();
      childEdges[id].forEach(function (e) { if (!seen.has(e.to)) { seen.add(e.to); kids.push(e); } });
      out.push("<h3>Unlocks</h3>");
      if (!kids.length) out.push("<p class=\"sub\">Nothing further — this is an end point.</p>");
      else if (spoilers && s !== "done") out.push('<p class="sub">Discover this to see what it leads to.</p>');
      else {
        out.push("<ul>");
        kids.forEach(function (e) {
          out.push("<li>" + nodeLink(e.to, e.closes_cycle ? ' <span class="sub">(loop)</span>' : "") + "</li>");
        });
        out.push("</ul>");
      }
    }
    details.innerHTML = out.join("");
    details.scrollTop = 0;
  }

  // ---------- actions ----------
  function select(id, scroll) {
    selected = id;
    try { history.replaceState(null, "", id ? "#" + encodeURIComponent(id) : location.pathname + location.search); } catch (e) { /* ignore */ }
    highlight();
    renderDetails();
    if (id && scroll) scrollToNode(id);
  }

  function setDiscovered(id, on) {
    if (on) {
      discovered.add(id);
      var before = new Set(Object.keys(visState));
      computeVisibility();
      Object.keys(visState).forEach(function (k) { if (!before.has(k)) fresh.add(k); });
    } else {
      discovered.delete(id);
    }
    save(STORE_DISC, Array.from(discovered));
    render();
  }

  function scrollToNode(id) {
    var p = positions[id];
    if (!p) return;
    viewport.scrollTo({
      left: (p.x + CARD_W / 2) * zoom - viewport.clientWidth / 2,
      top: (p.y + CARD_H / 2) * zoom - viewport.clientHeight / 2,
      behavior: "smooth"
    });
  }

  function applyZoom() {
    canvas.style.transform = "scale(" + zoom + ")";
    canvas.style.width = contentSize.w + "px";
    canvas.style.height = contentSize.h + "px";
    stage.style.width = contentSize.w * zoom + "px";
    stage.style.height = contentSize.h * zoom + "px";
  }
  function setZoom(z, cx, cy) {
    z = Math.min(2, Math.max(0.2, z));
    cx = cx === undefined ? viewport.clientWidth / 2 : cx;
    cy = cy === undefined ? viewport.clientHeight / 2 : cy;
    var wx = (viewport.scrollLeft + cx) / zoom, wy = (viewport.scrollTop + cy) / zoom;
    zoom = z;
    applyZoom();
    viewport.scrollLeft = wx * zoom - cx;
    viewport.scrollTop = wy * zoom - cy;
  }
  function fit() {
    var z = Math.min(1, (viewport.clientWidth - 8) / contentSize.w, (viewport.clientHeight - 8) / contentSize.h);
    zoom = Math.max(0.2, z);
    applyZoom();
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }

  // ---------- search ----------
  var results = $("results"), search = $("search"), activeResult = 0, resultIds = [];
  function runSearch() {
    var q = search.value.trim().toLowerCase();
    if (!q) { results.hidden = true; return; }
    resultIds = Object.keys(visState).filter(function (id) {
      if (hiddenName(id)) return false;
      var n = nodes[id];
      if (n.text.toLowerCase().indexOf(q) >= 0 || n.mod.indexOf(q) >= 0) return true;
      return n.goal.keys.some(function (k) { return k.toLowerCase().indexOf(q) >= 0; });
    }).sort(function (a, b) { return nodes[a].tier - nodes[b].tier; }).slice(0, 15);
    activeResult = 0;
    results.innerHTML = resultIds.length
      ? resultIds.map(function (id, i) {
          return '<li><button data-go="' + esc(id) + '"' + (i === 0 ? ' class="active"' : "") + ">" +
            esc(cap(nodes[id].text)) + '<span class="r-meta">' + esc(modName(nodes[id].mod)) + " · T" + nodes[id].tier + "</span></button></li>";
        }).join("")
      : '<li class="empty">' + (spoilers ? "No matches among what you've unlocked" : "No matches") + "</li>";
    results.hidden = false;
  }
  function pickResult(id) {
    results.hidden = true;
    search.value = "";
    if (focus && id !== focus && !ancestors(focus).has(id)) { focus = null; render(); }
    select(id, true);
  }

  // ---------- events ----------
  function wire() {
    canvas.addEventListener("click", function (ev) {
      if (dragMoved) return;
      var card = ev.target.closest(".card");
      if (!card) { select(null); return; }
      var id = card.getAttribute("data-id");
      if (spoilers && visState[id] === "open") { selected = id; setDiscovered(id, true); select(id); return; }
      select(id === selected ? null : id);
    });
    details.addEventListener("click", function (ev) {
      var go = ev.target.closest("[data-go]");
      if (go) {
        var id = go.getAttribute("data-go");
        if (focus && !ancestors(focus).has(id) && id !== focus) { focus = null; render(); }
        select(id, true);
        return;
      }
      if (ev.target.closest("[data-toggle]")) { setDiscovered(selected, !discovered.has(selected)); return; }
      if (ev.target.closest("[data-focus]")) { focus = focus === selected ? null : selected; render(); if (selected) scrollToNode(selected); return; }
      if (ev.target.closest("[data-close]")) select(null);
    });
    $("focusClear").addEventListener("click", function () { focus = null; render(); if (selected) scrollToNode(selected); });

    var sp = $("spoilers");
    sp.checked = spoilers;
    sp.addEventListener("change", function () {
      spoilers = sp.checked;
      save(STORE_SPOIL, spoilers);
      render();
      if (selected) scrollToNode(selected);
    });
    $("reset").addEventListener("click", function () {
      if (!discovered.size || confirm("Forget all " + discovered.size + " discoveries?")) {
        discovered.clear();
        save(STORE_DISC, []);
        selected = null; focus = null;
        render();
      }
    });
    $("zoomIn").addEventListener("click", function () { setZoom(zoom * 1.2); });
    $("zoomOut").addEventListener("click", function () { setZoom(zoom / 1.2); });
    $("zoomFit").addEventListener("click", fit);
    viewport.addEventListener("wheel", function (ev) {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      var r = viewport.getBoundingClientRect();
      setZoom(zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });

    search.addEventListener("input", runSearch);
    search.addEventListener("keydown", function (ev) {
      var btns = results.querySelectorAll("button");
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (!btns.length) return;
        activeResult = (activeResult + (ev.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length;
        btns.forEach(function (b, i) { b.classList.toggle("active", i === activeResult); });
      } else if (ev.key === "Enter" && resultIds[activeResult]) {
        pickResult(resultIds[activeResult]);
      } else if (ev.key === "Escape") {
        results.hidden = true;
      }
    });
    results.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-go]");
      if (b) pickResult(b.getAttribute("data-go"));
    });
    document.addEventListener("click", function (ev) {
      if (!ev.target.closest(".search")) results.hidden = true;
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && document.activeElement !== search) select(null);
    });

    // Drag the background to pan.
    var drag = null, dragMoved = false;
    viewport.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0 || ev.pointerType === "touch") return;
      drag = { x: ev.clientX, y: ev.clientY, l: viewport.scrollLeft, t: viewport.scrollTop };
      dragMoved = false;
    });
    window.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 5) return;
      dragMoved = true;
      viewport.classList.add("dragging");
      viewport.scrollLeft = drag.l - dx;
      viewport.scrollTop = drag.t - dy;
    });
    window.addEventListener("pointerup", function () {
      drag = null;
      viewport.classList.remove("dragging");
      setTimeout(function () { dragMoved = false; }, 0);
    });
  }

  // ---------- boot ----------
  fetch(DATA_URL)
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (json) {
      data = json;
      buildIndex();
      discovered = new Set(load(STORE_DISC, []).filter(function (id) { return nodes[id]; }));
      spoilers = !!load(STORE_SPOIL, true);
      $("loading").remove();
      wire();
      render();
      var fromHash = decodeURIComponent(location.hash.slice(1));
      if (fromHash && visState[fromHash]) select(fromHash, true);
    })
    .catch(function (err) {
      var el = $("loading");
      el.classList.add("error");
      el.textContent = "Couldn't load " + DATA_URL + " (" + err.message + "). " +
        (location.protocol === "file:" ? "Browsers block this when opening the file directly — serve the folder, e.g. `python3 -m http.server`." : "");
    });
})();
