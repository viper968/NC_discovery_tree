// The node web: a force-directed graph (d3-force) laid out in rings by
// tier, so day-one things sit in the middle and the tree grows outward.
// Pan and zoom with the mouse or touch, drag nodes about, click to select.
// d3 comes from cdnjs as a global (see index.html).

const RING = 70;           // least distance between tier rings
const MIN_ARC = 30;        // least room along a ring for each node on it
const QUIET = 0.02;        // alpha below which a layout counts as settled

const radius = (n) => 6 + Math.min(14, Math.sqrt(n.weight || 0) * 2.4);

export class WebView {
  /**
   * `el`: the element to fill. `on.click(id)`, `on.background()`.
   */
  constructor(el, on) {
    const d3 = window.d3;
    this.d3 = d3;
    this.on = on;
    this.memory = new Map();       // layout key -> Map(id -> {x, y})
    this.key = null;
    this.nodes = [];
    this.links = [];
    this.byId = new Map();
    this.hl = { selected: null, anc: new Set(), desc: new Set() };

    this.svg = d3.select(el).append('svg').attr('class', 'web');
    const defs = this.svg.append('defs');
    for (const [id, cls] of [['arrow', 'arrow'], ['arrow-anc', 'arrow anc'], ['arrow-desc', 'arrow desc']]) {
      defs.append('marker').attr('id', id).attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0)
        .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-4L8,0L0,4').attr('class', cls);
    }
    this.root = this.svg.append('g');
    this.ringLayer = this.root.append('g').attr('class', 'rings');
    this.linkLayer = this.root.append('g').attr('class', 'links');
    this.nodeLayer = this.root.append('g').attr('class', 'nodes');

    this.zoom = d3.zoom().scaleExtent([0.05, 4]).on('zoom', (ev) => {
      this.root.attr('transform', ev.transform);
      this.svg.classed('near', ev.transform.k >= 0.9).classed('far', ev.transform.k < 0.45);
      // labels keep a readable size on screen however far out
      this.svg.style('--inv', String(1 / ev.transform.k));
    });
    this.svg.call(this.zoom).on('dblclick.zoom', null);
    this.svg.on('click', (ev) => { if (ev.target === this.svg.node()) on.background(); });

    this.sim = d3.forceSimulation()
      .force('link', d3.forceLink().id((n) => n.id).distance(55).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-220).distanceMax(700))
      .force('collide', d3.forceCollide().radius((n) => radius(n) + 8))
      // a gentle pull by tier: early things drift to the middle, later ones outward
      .force('ring', d3.forceRadial((n) => this.radii[n.ring] || 0, 0, 0).strength(0.06))
      // (things with no links would otherwise be pushed off to the edges)
      .force('x', d3.forceX(0).strength((n) => (n.deg ? 0.02 : 0.15)))
      .force('y', d3.forceY(0).strength((n) => (n.deg ? 0.02 : 0.15)))
      .alphaDecay(0.035)
      .on('tick', () => this.draw());
    this.sim.stop();
    this.radii = [0];
  }

  /** Ring radii: evenly spaced, but each big enough to hold its nodes. */
  ringRadii(nodes) {
    const count = [];
    for (const n of nodes) count[n.ring] = (count[n.ring] || 0) + 1;
    const radii = [];
    let r = 0;
    for (let i = 0; i < count.length; i++) {
      r = Math.max(i === 0 ? RING * 0.8 : r + RING, ((count[i] || 0) * MIN_ARC) / (2 * Math.PI));
      radii[i] = r;
    }
    return radii;
  }

  /**
   * A first layout as a radial tree: every node hangs off its earliest
   * source, so each branch gets its own slice of the circle.
   */
  seed(nodes, links) {
    const d3 = this.d3;
    const ids = new Set(nodes.map((n) => n.id));
    const parent = new Map();
    for (const l of links) {
      if (!ids.has(l.source) || parent.has(l.target)) continue;
      parent.set(l.target, l.source);
    }
    // break any loop so the hierarchy is a tree
    for (const n of nodes) {
      const seen = new Set([n.id]);
      for (let p = parent.get(n.id); p !== undefined; p = parent.get(p)) {
        if (seen.has(p)) { parent.delete(n.id); break; }
        seen.add(p);
      }
    }
    const rows = [{ id: '\u0000root' }, ...nodes.map((n) => ({ id: n.id, parent: parent.get(n.id) ?? '\u0000root' }))];
    const root = d3.stratify().id((r) => r.id).parentId((r) => r.parent)(rows);
    // each branch gets a slice of the circle in proportion to how much is
    // on it (not just its tips, or a pile of loose ends would take it all),
    // and big branches alternate with small ones so the rings fill evenly
    root.sum(() => 1);
    const slice = (h, a0, a1) => {
      h.angle = (a0 + a1) / 2;
      if (!h.children) return;
      const kids = [...h.children].sort((a, b) => b.value - a.value || String(a.id).localeCompare(b.id));
      const order = [];
      kids.forEach((k, i) => (i % 2 ? order.push(k) : order.unshift(k)));
      const total = order.reduce((t, k) => t + k.value, 0);
      let a = a0;
      for (const k of order) {
        const span = ((a1 - a0) * k.value) / total;
        slice(k, a, a + span);
        a += span;
      }
    };
    slice(root, 0, 2 * Math.PI);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const linked = new Set(links.flatMap((l) => [l.source, l.target]));
    const cloud = Math.sqrt(nodes.length) * 30;
    for (const h of root.descendants()) {
      const n = byId.get(h.id);
      if (!n) continue;
      if (!linked.has(n.id)) {
        // loose things: a scatter for the forces to settle, not an arc
        const a = Math.random() * 2 * Math.PI, r = cloud * Math.sqrt(Math.random());
        n.x = Math.cos(a) * r;
        n.y = Math.sin(a) * r;
        continue;
      }
      const r = this.radii[n.ring] || 0;
      n.x = Math.cos(h.angle - Math.PI / 2) * r;
      n.y = Math.sin(h.angle - Math.PI / 2) * r;
    }
  }

  /**
   * Show `nodes` ([{id, label, sub, state, ring, weight, hue, fresh,
   * mystery}]) joined by `links` ([{source, target}]). Positions are kept
   * per `key`, so switching trees and back keeps each one's shape.
   */
  update(key, nodes, links, rings) {
    const d3 = this.d3;
    if (key !== this.key) {
      if (this.key) this.remember();
      this.key = key;
    }
    const mem = this.memory.get(key) || new Map();
    this.radii = this.ringRadii(nodes);
    const old = this.byId;
    const fresh = [];
    this.byId = new Map();
    for (const n of nodes) {
      const prev = old.get(n.id) || mem.get(n.id);
      if (prev) { n.x = prev.x; n.y = prev.y; } else fresh.push(n);
      this.byId.set(n.id, n);
    }
    // place what is new beside something it is linked to, else on its ring
    for (const n of fresh) {
      const l = links.find((x) => (x.target === n.id && this.byId.get(x.source)?.x !== undefined)
        || (x.source === n.id && this.byId.get(x.target)?.x !== undefined));
      const near = l && this.byId.get(l.target === n.id ? l.source : l.target);
      if (near && near.x !== undefined) {
        n.x = near.x + (Math.random() - 0.5) * 40;
        n.y = near.y + (Math.random() - 0.5) * 40;
      } else {
        const a = Math.random() * Math.PI * 2;
        n.x = Math.cos(a) * (this.radii[n.ring] || 0);
        n.y = Math.sin(a) * (this.radii[n.ring] || 0);
      }
    }
    this.nodes = nodes;
    this.links = links.map((l) => ({ ...l }));
    const deg = new Map();
    for (const l of links) { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); }
    for (const n of nodes) n.deg = deg.get(n.id) || 0;

    // tier rings, faintly, behind everything
    const ring = this.ringLayer.selectAll('g.ring').data(rings, (r) => r.ring);
    ring.exit().remove();
    const ringIn = ring.enter().append('g').attr('class', 'ring');
    ringIn.append('circle');
    ringIn.append('text');
    ringIn.merge(ring).select('circle').attr('r', (r) => Math.max(1, this.radii[r.ring] || 0));
    ringIn.merge(ring).select('text').attr('y', (r) => -(this.radii[r.ring] || 0) - 8).text((r) => r.label);

    const lkey = (l) => `${l.source.id ?? l.source}>${l.target.id ?? l.target}`;
    const link = this.linkLayer.selectAll('line').data(this.links, lkey);
    link.exit().remove();
    this.linkSel = link.enter().append('line').merge(link)
      .attr('data-from', (l) => l.source).attr('data-to', (l) => l.target);

    const node = this.nodeLayer.selectAll('g.node').data(nodes, (n) => n.id);
    node.exit().remove();
    const nodeIn = node.enter().append('g').attr('class', 'node')
      .on('click', (ev, n) => { ev.stopPropagation(); this.on.click(n.id); })
      .call(d3.drag()
        .on('start', (ev, n) => { if (!ev.active) this.sim.alphaTarget(0.15).restart(); n.fx = n.x; n.fy = n.y; })
        .on('drag', (ev, n) => { n.fx = ev.x; n.fy = ev.y; })
        .on('end', (ev, n) => { if (!ev.active) this.sim.alphaTarget(0); n.fx = null; n.fy = null; }));
    nodeIn.append('circle').attr('class', 'halo');
    nodeIn.append('circle').attr('class', 'dot');
    nodeIn.append('text').attr('class', 'mark');
    nodeIn.append('text').attr('class', 'label');
    nodeIn.append('title');
    this.nodeSel = nodeIn.merge(node)
      .attr('class', (n) => `node ${n.state}${n.mystery ? ' mystery' : ''}${n.weight >= 6 ? ' big' : ''}${n.fresh ? ' fresh' : ''}`)
      .attr('data-id', (n) => n.id)
      .style('--hue', (n) => n.hue);
    this.nodeSel.select('circle.halo').attr('r', (n) => radius(n) + 4);
    this.nodeSel.select('circle.dot').attr('r', radius);
    this.nodeSel.select('text.mark').attr('dy', '0.35em')
      .text((n) => (n.state === 'done' ? '✓' : n.mystery ? '?' : ''));
    this.nodeSel.select('text.label').attr('y', (n) => radius(n) + 3).attr('dy', '0.9em').text((n) => n.label);
    this.nodeSel.select('title').text((n) => (n.mystery ? 'Locked — discover more to reveal' : `${n.label}${n.sub ? ` (${n.sub})` : ''}`));

    this.sim.nodes(nodes);
    this.sim.force('link').links(this.links);
    // strengths depend on links, so have them re-read
    this.sim.force('x').strength((n) => (n.deg ? 0.02 : 0.15));
    this.sim.force('y').strength((n) => (n.deg ? 0.02 : 0.15));
    if (!old.size && fresh.length === nodes.length) {
      // a whole new layout: seed it as a radial tree, settle it out of sight, then show it
      this.seed(nodes, links);
      this.sim.alpha(0.6);
      for (let i = 0; i < 300 && this.sim.alpha() > QUIET; i++) this.sim.tick();
      this.draw();
      this.sim.alpha(0.05).restart();
      return 'new';
    }
    this.sim.alpha(fresh.length ? Math.min(0.6, 0.15 + fresh.length / 40) : 0.08).restart();
    this.draw();
    return 'updated';
  }

  remember() {
    const m = new Map();
    for (const n of this.nodes) m.set(n.id, { x: n.x, y: n.y });
    this.memory.set(this.key, m);
    this.byId = new Map();
  }

  draw() {
    if (!this.linkSel) return;
    this.linkSel.each((l, i, els) => {
      const s = l.source, t = l.target;
      if (s.x === undefined || t.x === undefined) return;
      const dx = t.x - s.x, dy = t.y - s.y;
      const len = Math.hypot(dx, dy) || 1;
      const rs = radius(s) + 2, rt = radius(t) + 4;
      els[i].setAttribute('x1', s.x + (dx / len) * rs);
      els[i].setAttribute('y1', s.y + (dy / len) * rs);
      els[i].setAttribute('x2', t.x - (dx / len) * rt);
      els[i].setAttribute('y2', t.y - (dy / len) * rt);
    });
    this.nodeSel.attr('transform', (n) => `translate(${n.x},${n.y})`);
  }

  /** Light up the selection, the quickest way to it and what it leads to. */
  highlight({ selected, anc, desc }) {
    this.hl = { selected, anc, desc };
    this.svg.classed('has-sel', !!selected);
    const kids = new Set(this.links.filter((l) => l.source.id === selected).map((l) => l.target.id));
    this.nodeSel.classed('sel', (n) => n.id === selected)
      .classed('anc', (n) => anc.has(n.id))
      .classed('desc', (n) => desc.has(n.id))
      .classed('kid', (n) => kids.has(n.id));
    this.linkSel
      .classed('hl-anc', (l) => !!selected && (l.target.id === selected || anc.has(l.target.id)) && anc.has(l.source.id))
      .classed('hl-desc', (l) => !!selected && (l.source.id === selected || desc.has(l.source.id)) && desc.has(l.target.id))
      .attr('marker-end', function () {
        return this.classList.contains('hl-anc') ? 'url(#arrow-anc)' : this.classList.contains('hl-desc') ? 'url(#arrow-desc)' : 'url(#arrow)';
      });
    // bring the lit-up part to the front
    this.nodeSel.filter((n) => n.id === selected || anc.has(n.id) || desc.has(n.id)).raise();
  }

  size() {
    const r = this.svg.node().getBoundingClientRect();
    return { w: r.width || 800, h: r.height || 600 };
  }

  /** Pan (and zoom in a little, if far out) to a node. */
  focusOn(id) {
    const n = this.byId.get(id);
    if (!n) return;
    const { w, h } = this.size();
    const k = Math.max(this.d3.zoomTransform(this.svg.node()).k, 1);
    this.svg.transition().duration(600)
      .call(this.zoom.transform, this.d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-n.x, -n.y));
  }

  /** Zoom to show every node. */
  fit(animate = true) {
    if (!this.nodes.length) return;
    const xs = this.nodes.map((n) => n.x), ys = this.nodes.map((n) => n.y);
    const x0 = Math.min(...xs) - 40, x1 = Math.max(...xs) + 40, y0 = Math.min(...ys) - 40, y1 = Math.max(...ys) + 40;
    const { w, h } = this.size();
    const k = Math.min(2, Math.max(0.05, Math.min(w / (x1 - x0), h / (y1 - y0))));
    const t = this.d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    (animate ? this.svg.transition().duration(500) : this.svg).call(this.zoom.transform, t);
  }

  zoomBy(f) {
    this.svg.transition().duration(250).call(this.zoom.scaleBy, f);
  }
}
