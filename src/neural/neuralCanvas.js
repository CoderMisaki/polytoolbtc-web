/* neuralCanvas.js â realtime ANIMAL BRAIN MAP for the Animal Neural Lab.
 *
 * Monochrome "platinum instrument" edition: no hue anywhere, only luminance.
 * Eight agent cards in a strict grid (4x2 on desktop, 2x4 on narrow screens)
 * plus a META BRAIN summary bar. Each card answers four questions at a glance:
 *
 *   - WHO is speaking?      full agent name + role, never clipped by lines
 *   - HOW SURE are they?    confidence % printed as a number
 *   - WHICH WAY?            â² LONG / â¼ SHORT / â NEUTRAL (glyph, not colour)
 *   - HOW BUSY?             activation bar + breathing neuron badge + pulses
 *
 * Everything drawn is real engine state (`AnimalNeuralSystem.getSnapshot()`).
 *
 * Layout rules (anti-overlap):
 *   - every card has its own translucent background + hairline border, so
 *     synapse lines can never show through text;
 *   - synapse edges are drawn first (behind cards), center-to-edge;
 *   - the grid reflows structurally: 4 columns on wide canvases, 2 columns
 *     on narrow ones, and the canvas CSS height follows the layout;
 *   - text is measured and truncated with an ellipsis before it can overflow.
 *
 * Motion thesis (one authored idea): a breathing platinum neuron badge.
 * Values glide via per-frame lerp (never jump); neuron satellites orbit with
 * individual phase/radius/speed; synaptic pulses travel as short light
 * streaks. `prefers-reduced-motion` freezes movement but keeps live values.
 *
 * Performance rules:
 *   - exactly ONE requestAnimationFrame loop, guarded by `S.rafId`;
 *   - the loop idles when the tab is hidden, the canvas is offscreen, or
 *     there is no engine data; frame rate capped at ~30fps;
 *   - ONE pre-rendered radial glow sprite reused for every halo/particle â
 *     zero per-frame gradients;
 *   - engine snapshot read at most every SNAPSHOT_INTERVAL_MS;
 *   - devicePixelRatio capped at 2; backing store resized only on real change.
 *
 * Classic script: window.NeuralCanvas in browsers, module.exports in Node.
 */
(function NeuralCanvasUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.NeuralCanvas = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildNeuralCanvas(root) {
    'use strict';

    const FRAME_BUDGET_MS = 33;        // ~30 fps cap
    const SNAPSHOT_INTERVAL_MS = 500;  // engine reads, not per frame
    const MAX_PULSES_PER_EDGE = 2;
    const MAX_DPR = 2;
    const NEURONS_PER_NODE = 4;
    const TAU = 6.283185307179586;

    // Monochrome platinum system: luminance only, no hue.
    const INK = '244, 244, 245';   // platinum text / cores
    const MUTED = '161, 161, 170'; // zinc-400 secondary text
    const FAINT = '82, 82, 91';    // zinc-600 hairlines on dark
    const CARD_BG = '12, 12, 14';  // card fill

    const AGENTS = [
        { id: 'chimpanzee', name: 'CHIMPANZEE', role: 'Pola & Strategi' },
        { id: 'raven',      name: 'RAVEN',      role: 'Taktik & Jebakan' },
        { id: 'dolphin',    name: 'DOLPHIN',    role: 'Sentimen Massa' },
        { id: 'elephant',   name: 'ELEPHANT',   role: 'Memori Historis' },
        { id: 'eagle',      name: 'EAGLE',      role: 'Struktur Besar' },
        { id: 'owl',        name: 'OWL',        role: 'Observasi Tenang' },
        { id: 'dragonfly',  name: 'DRAGONFLY',  role: 'Refleks Cepat' },
        { id: 'octopus',    name: 'OCTOPUS',    role: 'Fusi Adaptif' }
    ];

    const S = {
        canvas: null,
        ctx: null,
        rafId: null,
        running: false,
        started: false,
        disposed: false,
        visible: true,
        pageVisible: true,
        lastFrameAt: 0,
        lastSnapshotAt: 0,
        width: 0,
        height: 0,
        dpr: 1,
        cols: 4,
        rows: 2,
        compact: false,
        nodes: [],          // { id, x, y, w, h, activation, confidence, neurons, bias, ok, _dAct, _dConf, _dBias, phase }
        nodeIndex: {},
        meta: null,
        edges: [],          // { from, to, weight, activation, nextPulseAt }
        edgeKey: '',
        pulses: [],         // pooled particles
        freePulses: [],
        intensity: 0,
        metaDecision: 'â',
        listeners: [],
        observer: null,
        resizeObserver: null,
        resizeQueued: false,
        glowSprite: null,   // pre-rendered radial glow (white)
        reducedMotion: false
    };

    function doc() {
        return (typeof document !== 'undefined') ? document : null;
    }

    function system() {
        if (root && root.AnimalNeuralSystem) return root.AnimalNeuralSystem;
        if (typeof AnimalNeuralSystem !== 'undefined') return AnimalNeuralSystem;
        return null;
    }

    function clamp01(v) {
        if (!Number.isFinite(v)) return 0;
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    // Pre-rendered radial glow sprite: drawn with drawImage + globalAlpha,
    // so no gradient is ever created per frame.
    function ensureGlowSprite() {
        if (S.glowSprite) return S.glowSprite;
        const d = doc();
        if (!d || typeof d.createElement !== 'function') return null;
        const size = 64;
        const c = d.createElement('canvas');
        c.width = size;
        c.height = size;
const g = typeof c.getContext === 'function' ? c.getContext('2d') : null;
        if (!g) return null;
        const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
        grad.addColorStop(0.25, 'rgba(255, 255, 255, 0.5)');
        grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.12)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);
        S.glowSprite = c;
        return c;
    }

    function drawGlow(x, y, radius, alpha) {
        const sprite = S.glowSprite || ensureGlowSprite();
        const ctx = S.ctx;
        if (!sprite || !ctx || !(alpha > 0.003) || !(radius > 0.3)) return;
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
        ctx.globalAlpha = 1;
    }

    // --------------------------------------------------------------- layout

    function buildLayout() {
        const w = S.width;
        if (!(w > 0)) return false;

        // Structural reflow: 4 columns on wide, 2 on narrow. The canvas CSS
        // height follows the layout so cards never get crushed.
        const wide = w >= 600;
        const cols = wide ? 4 : 2;
        const rows = Math.ceil(AGENTS.length / cols);
        const gap = wide ? 8 : 6;
        const pad = wide ? 8 : 6;
        const cardH = wide ? 88 : 64;
        const metaH = wide ? 54 : 50;
        const needH = pad + rows * cardH + (rows - 1) * gap + gap + metaH + pad;

        const canvas = S.canvas;
        if (canvas && canvas.style) {
            const curH = parseFloat(canvas.style.height) || 0;
            if (Math.abs(curH - needH) > 1) canvas.style.height = needH + 'px';
        }

        S.cols = cols;
        S.rows = rows;
        S.compact = !wide;
        S.nodes = [];
        S.nodeIndex = {};
        S.edges = [];

        const gridW = w - pad * 2;
        const cardW = (gridW - gap * (cols - 1)) / cols;

        AGENTS.forEach(function (agent, i) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            S.nodes.push({
                id: agent.id,
                name: agent.name,
                role: agent.role,
                x: pad + col * (cardW + gap) + cardW / 2,
                y: pad + row * (cardH + gap) + cardH / 2,
                w: cardW,
                h: cardH,
                activation: 0,
                confidence: 0,
                bias: 0,
                ok: false,
                neurons: new Float32Array(NEURONS_PER_NODE),
                _dAct: 0,
                _dConf: 0,
                _dBias: 0,
                phase: (i * 0.785) % TAU
            });
            S.nodeIndex[agent.id] = S.nodes[S.nodes.length - 1];
        });

        S.meta = {
            id: 'meta',
            name: 'META BRAIN',
            x: w / 2,
            y: pad + rows * cardH + (rows - 1) * gap + gap + metaH / 2,
            w: gridW,
            h: metaH,
            activation: 0,
            confidence: 0,
            bias: 0,
            ok: false,
            neurons: new Float32Array(NEURONS_PER_NODE),
            _dAct: 0,
            _dConf: 0,
            _dBias: 0,
            phase: 0
        };
        S.nodeIndex.meta = S.meta;

        for (let i = 0; i < S.pulses.length; i++) S.freePulses.push(S.pulses[i]);
        S.pulses = [];
        S.edgeKey = '';

        return true;
    }

    function ensureEdges(synapses) {
        let key = '';
        for (let i = 0; i < synapses.length; i++) {
            key += synapses[i].source + '>' + synapses[i].target + ';';
        }
        if (key === S.edgeKey) return;
        S.edgeKey = key;
        S.edges = [];
        for (let i = 0; i < synapses.length; i++) {
            const s = synapses[i];
            const from = S.nodeIndex[s.source];
            const to = S.nodeIndex[s.target];
            if (!from || !to) continue;
            S.edges.push({
                from: from,
                to: to,
                weight: clamp01(s.weight),
                activation: 0,
                nextPulseAt: 0
            });
        }
    }

    // ------------------------------------------------------------- snapshot

    function readSnapshot(nowMs) {
        const sys = system();
        if (!sys || typeof sys.getSnapshot !== 'function') return false;
        let snap;
        try { snap = sys.getSnapshot(); } catch (e) { return false; }
        if (!snap) return false;

        S.lastSnapshotAt = nowMs;

        const agents = snap.agents || {};
        const neurons = snap.neurons || {};
        let activitySum = 0;
        let activityCount = 0;

        for (let i = 0; i < S.nodes.length; i++) {
            const node = S.nodes[i];
            const r = agents[node.id];
            node.ok = !!(r && r.ok);
            // Targets only â the draw loop lerps displayed values toward these.
            node.activation = r && Number.isFinite(r.activation) ? clamp01(r.activation) : 0;
            node.confidence = r && Number.isFinite(r.confidence) ? clamp01(r.confidence) : 0;
            node.bias = r && Number.isFinite(r.bias) ? Math.max(-1, Math.min(1, r.bias)) : 0;
            activitySum += node.activation;
            activityCount++;

            const nv = neurons[node.id] || {};
            const keys = Object.keys(nv);
            for (let k = 0; k < NEURONS_PER_NODE; k++) {
                const key = keys.length > 0 ? keys[k % keys.length] : null;
                const v = key !== null ? Math.abs(Number(nv[key]) || 0) : node.activation;
                node.neurons[k] = clamp01(v);
            }
        }

        if (snap.meta) {
            S.meta.ok = true;
            S.meta.confidence = clamp01(snap.meta.confidence);
            S.meta.bias = Math.max(-1, Math.min(1, Number(snap.meta.consensus) || 0));
            S.meta.activation = clamp01(Math.abs(S.meta.bias) * 0.6 + S.meta.confidence * 0.4);
            S.metaDecision = String(snap.meta.decision || 'â');
            for (let k = 0; k < NEURONS_PER_NODE; k++) {
                S.meta.neurons[k] = S.meta.activation;
            }
        } else {
            S.meta.ok = false;
            S.meta.activation = 0;
            S.metaDecision = 'â';
        }

        const synapses = Array.isArray(snap.synapses) ? snap.synapses : [];
        ensureEdges(synapses);
        const byKey = {};
        for (let i = 0; i < synapses.length; i++) {
            byKey[synapses[i].source + '>' + synapses[i].target] = synapses[i];
        }
        for (let i = 0; i < S.edges.length; i++) {
            const e = S.edges[i];
            const s = byKey[e.from.id + '>' + e.to.id];
            e.weight = s && Number.isFinite(s.weight) ? clamp01(s.weight) : e.weight;
            e.activation = s && Number.isFinite(s.activation)
                ? Math.max(-1, Math.min(1, s.activation)) : 0;
        }

        const avgActivity = activityCount > 0 ? activitySum / activityCount : 0;
        const quality = Number.isFinite(snap.dataQuality) ? clamp01(snap.dataQuality) : 0.5;
        S.intensity = clamp01(avgActivity * 0.6 + quality * 0.25 + S.meta.activation * 0.15);
        return true;
    }

    // --------------------------------------------------------------- pulses

    function spawnPulse(edge, nowMs) {
        let p = S.freePulses.pop();
        if (!p) p = { t: 0, speed: 0, strength: 0, edge: null };
        p.edge = edge;
        p.t = 0;
        p.speed = 0.00055 + edge.weight * 0.0009;
        p.strength = clamp01(0.25 + Math.abs(edge.activation) * 1.6 + S.intensity * 0.3);
        S.pulses.push(p);
        edge.nextPulseAt = nowMs + (260 + Math.random() * 520) * (1.6 - edge.weight);
    }

    function updatePulses(dtMs, nowMs) {
        const budget = Math.min(S.edges.length * MAX_PULSES_PER_EDGE, 48);
        for (let i = 0; i < S.edges.length; i++) {
            const e = S.edges[i];
            if (nowMs >= e.nextPulseAt) {
                let count = 0;
                for (let j = 0; j < S.pulses.length; j++) {
                    if (S.pulses[j].edge === e) count++;
                }
                if (count < MAX_PULSES_PER_EDGE && S.pulses.length < budget) spawnPulse(e, nowMs);
                else e.nextPulseAt = nowMs + 400;
            }
        }
        for (let i = S.pulses.length - 1; i >= 0; i--) {
            const p = S.pulses[i];
            p.t += p.speed * dtMs;
            if (p.t >= 1) {
                S.pulses.splice(i, 1);
                S.freePulses.push(p);
            }
        }
    }

    // ----------------------------------------------------------------- draw

    function resizeIfNeeded() {
        const canvas = S.canvas;
        if (!canvas) return false;
        const rectW = canvas.clientWidth || 0;
        const rectH = canvas.clientHeight || 0;
        if (!(rectW > 0 && rectH > 0)) return false;
        const dpr = Math.min(MAX_DPR, (root && root.devicePixelRatio) || 1);
        const bw = Math.round(rectW * dpr);
        const bh = Math.round(rectH * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
        }
        if (S.width !== rectW || S.height !== rectH || S.dpr !== dpr) {
            S.width = rectW;
            S.height = rectH;
            S.dpr = dpr;
            if (!buildLayout()) return false;
        }
        return true;
    }

    function roundRect(ctx, x, y, w, h, r) {
        const radius = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + w - radius, y);
        ctx.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
        ctx.lineTo(x + w, y + h - radius);
        ctx.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
        ctx.lineTo(x + radius, y + h);
        ctx.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
        ctx.lineTo(x, y + radius);
        ctx.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
        ctx.closePath();
    }

    function fitText(ctx, text, maxW) {
        if (!ctx || typeof ctx.measureText !== 'function') return text;
        const measure = (s) => { try { const m = ctx.measureText(s); return m && typeof m.width === 'number' ? m.width : maxW + 1; } catch (_) { return maxW + 1; } };
            if (measure(text) <= maxW) return text;
        let t = text;
        while (t.length > 1 && measure(t + 'â¦') > maxW) {
            t = t.slice(0, -1);
        }
        return t + 'â¦';
    }

    function dirGlyph(bias) {
        return bias > 0.12 ? 'â²' : (bias < -0.12 ? 'â¼' : 'â');
    }

    function dirWord(bias) {
        return bias > 0.12 ? 'LONG' : (bias < -0.12 ? 'SHORT' : 'NETRAL');
    }

    // Glide displayed values toward snapshot targets â buttery, never jumpy.
    function easeNode(node, dtMs) {
        const t = S.reducedMotion ? 1 : Math.min(1, dtMs / 220);
        node._dAct = lerp(node._dAct, node.activation, t);
        node._dConf = lerp(node._dConf, node.confidence, t);
        node._dBias = lerp(node._dBias, node.bias, t);
    }

    function drawNodeCard(node, nowMs, dtMs) {
        const ctx = S.ctx;
        const x = node.x - node.w / 2;
        const y = node.y - node.h / 2;
        easeNode(node, dtMs);
        const act = node._dAct;
        const conf = node._dConf;
        const bias = node._dBias;
        const dim = node.ok ? 1 : 0.38;
        const compact = S.compact;

        // Card body: translucent + hairline so synapse lines never show through text.
        ctx.fillStyle = 'rgba(' + CARD_BG + ', 0.88)';
        roundRect(ctx, x, y, node.w, node.h, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(' + INK + ', ' + (0.07 + act * 0.10 * dim).toFixed(3) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();

        // ---- neuron badge: breathing halo + activation ring + platinum core
        const bx = x + (compact ? 20 : 24);
        const by = y + (compact ? 20 : 24);
        const breathe = S.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(nowMs / 900 + node.phase);
        const eased = breathe * breathe * (3 - 2 * breathe); // smoothstep
        drawGlow(bx, by, 16 + act * 10 + eased * 4, (0.10 + act * 0.30) * dim);

        // Activation ring (thin instrument arc).
        ctx.strokeStyle = 'rgba(' + INK + ', ' + (0.55 * dim).toFixed(3) + ')';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(bx, by, 11, -Math.PI / 2, -Math.PI / 2 + TAU * act);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(' + INK + ', ' + (0.12 * dim).toFixed(3) + ')';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(bx, by, 11, -Math.PI / 2 + TAU * act, -Math.PI / 2 + TAU);
        ctx.stroke();

        // Core.
        ctx.fillStyle = 'rgba(' + INK + ', ' + (0.35 + act * 0.6 * dim).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(bx, by, 3.4, 0, TAU);
        ctx.fill();

        // Neuron satellites: individual phase / radius / speed, glow + core.
        for (let k = 0; k < NEURONS_PER_NODE; k++) {
            const v = node.neurons[k];
            const speed = S.reducedMotion ? 0 : (0.00035 + k * 0.00007);
            const angle = (TAU * k) / NEURONS_PER_NODE + node.phase + nowMs * speed;
            const radius = 16 + v * 3 + Math.sin(nowMs / 1100 + k * 1.7 + node.phase) * 1.2;
            const nx = bx + Math.cos(angle) * radius;
            const ny = by + Math.sin(angle) * radius;
            const a = (0.12 + v * 0.75) * dim;
            drawGlow(nx, ny, 5 + v * 4, a * 0.55);
            ctx.fillStyle = 'rgba(' + INK + ', ' + a.toFixed(3) + ')';
            ctx.beginPath();
            ctx.arc(nx, ny, 0.9 + v * 1.4, 0, TAU);
            ctx.fill();
        }

        // ---- text block: name / role (left), direction / confidence (right)
        const tx = bx + 22;
        const rightX = x + node.w - 8;
        const nameSize = compact ? 8 : 8.5;
        const roleSize = compact ? 6.5 : 7;

        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(' + INK + ', ' + (0.95 * dim).toFixed(3) + ')';
        ctx.font = '700 ' + nameSize + 'px Inter, system-ui, sans-serif';
        const maxNameW = Math.max(20, rightX - 44 - tx);
        ctx.fillText(fitText(ctx, node.name, maxNameW), tx, y + (compact ? 17 : 20));

        ctx.fillStyle = 'rgba(' + MUTED + ', ' + (0.9 * dim).toFixed(3) + ')';
        ctx.font = roleSize + 'px Inter, system-ui, sans-serif';
        const maxRoleW = Math.max(20, rightX - tx);
        ctx.fillText(fitText(ctx, node.role, maxRoleW), tx, y + (compact ? 28 : 32));

        // Direction: glyph + word, right-aligned, clear of the name.
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(' + INK + ', ' + (0.92 * dim).toFixed(3) + ')';
        ctx.font = '700 ' + (compact ? 8 : 8.5) + 'px Inter, system-ui, sans-serif';
        ctx.fillText(dirGlyph(bias) + ' ' + dirWord(bias), rightX, y + (compact ? 17 : 20));
        ctx.fillStyle = 'rgba(' + MUTED + ', ' + (0.85 * dim).toFixed(3) + ')';
        ctx.font = (compact ? 6.5 : 7) + 'px Inter, system-ui, sans-serif';
        ctx.fillText(Math.round(conf * 100) + '%', rightX, y + (compact ? 28 : 32));

        // ---- activation bar (bottom), confidence tick inside it
        const barX = x + 8;
        const barW = node.w - 16;
        const barY = y + node.h - 10;
        ctx.fillStyle = 'rgba(' + INK + ', 0.10)';
        roundRect(ctx, barX, barY, barW, 3, 1.5);
        ctx.fill();
        if (act > 0.01) {
            ctx.fillStyle = 'rgba(' + INK + ', ' + (0.75 * dim).toFixed(3) + ')';
            roundRect(ctx, barX, barY, Math.max(2, barW * act), 3, 1.5);
            ctx.fill();
        }
        const confX = barX + barW * conf;
        ctx.fillStyle = 'rgba(' + INK + ', ' + (0.9 * dim).toFixed(3) + ')';
        ctx.fillRect(Math.max(barX, Math.min(confX, barX + barW - 1)), barY - 1.5, 1.4, 6);
    }

    function drawMetaBar(nowMs, dtMs) {
        const ctx = S.ctx;
        const m = S.meta;
        if (!m) return;
        easeNode(m, dtMs);
        const x = m.x - m.w / 2;
        const y = m.y - m.h / 2;
        const act = m._dAct;
        const bias = m._dBias;
        const decision = S.metaDecision || 'â';

        // Panel: same card language as the agents, full width.
        ctx.fillStyle = 'rgba(' + CARD_BG + ', 0.88)';
        roundRect(ctx, x, y, m.w, m.h, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(' + INK + ', ' + (0.08 + act * 0.12).toFixed(3) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();

        const compact = S.compact;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(' + MUTED + ', 0.95)';
        ctx.font = '700 ' + (compact ? 8 : 8.5) + 'px Inter, system-ui, sans-serif';
        ctx.fillText('META BRAIN â', x + 10, y + (compact ? 18 : 20));
        ctx.fillStyle = 'rgba(' + INK + ', 0.98)';
        ctx.fillText(dirGlyph(bias) + ' ' + decision, x + (compact ? 92 : 100), y + (compact ? 18 : 20));
        ctx.fillStyle = 'rgba(' + MUTED + ', 0.9)';
        ctx.font = (compact ? 6.5 : 7) + 'px Inter, system-ui, sans-serif';
        ctx.fillText('confidence ' + Math.round(m.confidence * 100) + '%', x + (compact ? 170 : 184), y + (compact ? 18 : 20));

        // Consensus bar: full-short (left) â full-long (right), center tick.
        const barX = x + 10;
        const barW = m.w - 20;
        const barY = y + m.h - 12;
        ctx.fillStyle = 'rgba(' + INK + ', 0.10)';
        roundRect(ctx, barX, barY, barW, 4, 2);
        ctx.fill();
        const midX = barX + barW / 2;
        const biasW = (barW / 2) * Math.abs(bias);
        if (biasW > 1) {
            const shimmer = S.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(nowMs / 700);
            ctx.fillStyle = 'rgba(' + INK + ', ' + (0.45 + shimmer * 0.25).toFixed(3) + ')';
            roundRect(ctx, bias >= 0 ? midX : midX - biasW, barY, Math.max(2, biasW), 4, 2);
            ctx.fill();
        }
        ctx.fillStyle = 'rgba(' + INK + ', 0.55)';
        ctx.fillRect(midX - 0.75, barY - 1.5, 1.5, 7);
    }

    // Point on the border of a node's rect facing another point (so edges
    // never start/end underneath card text).
    function edgePoint(node, tx, ty) {
        const hw = node.w / 2;
        const hh = node.h / 2;
        const dx = tx - node.x;
        const dy = ty - node.y;
        if (dx === 0 && dy === 0) return { x: node.x, y: node.y };
        const sx = hw / Math.abs(dx || 1e-6);
        const sy = hh / Math.abs(dy || 1e-6);
        const s = Math.min(sx, sy);
        return { x: node.x + dx * s, y: node.y + dy * s };
    }

    function draw(nowMs, dtMs) {
        const ctx = S.ctx;
        if (!ctx) return;
        ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
        ctx.clearRect(0, 0, S.width, S.height);

        // --- synapses (behind the cards; edge-to-edge so no line crosses text)
        for (let i = 0; i < S.edges.length; i++) {
            const e = S.edges[i];
            const strength = clamp01(e.weight * (0.3 + Math.abs(e.activation) * 1.2) + S.intensity * 0.15);
            const a = edgePoint(e.from, e.to.x, e.to.y);
            const b = edgePoint(e.to, e.from.x, e.from.y);
            ctx.strokeStyle = 'rgba(' + INK + ', ' + (0.05 + strength * 0.16).toFixed(3) + ')';
            ctx.lineWidth = 0.6 + strength * 1.1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            // Gentle curve: control point lifted perpendicular for an organic feel.
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const bow = Math.min(18, len * 0.08);
            ctx.quadraticCurveTo(mx - dy / len * bow, my + dx / len * bow, b.x, b.y);
            ctx.stroke();
        }

        // --- travelling signals: short light streaks with a glowing head
        for (let i = 0; i < S.pulses.length; i++) {
            const p = S.pulses[i];
            const e = p.edge;
            if (!e) continue;
            const a = edgePoint(e.from, e.to.x, e.to.y);
            const b = edgePoint(e.to, e.from.x, e.from.y);
            const x = a.x + (b.x - a.x) * p.t;
            const y = a.y + (b.y - a.y) * p.t;
            const fade = Math.sin(Math.PI * p.t);
            const alpha = (0.2 + p.strength * 0.7 * fade);
            // Streak tail along the direction of travel.
            const tx = x - (b.x - a.x) * 0.06;
            const ty = y - (b.y - a.y) * 0.06;
            ctx.strokeStyle = 'rgba(' + INK + ', ' + (alpha * 0.5).toFixed(3) + ')';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(x, y);
            ctx.stroke();
            drawGlow(x, y, 4 + p.strength * 5, alpha * 0.8);
            ctx.fillStyle = 'rgba(' + INK + ', ' + alpha.toFixed(3) + ')';
            ctx.beginPath();
            ctx.arc(x, y, 1 + p.strength * 1.4, 0, TAU);
            ctx.fill();
        }

        // --- agent cards
        for (let i = 0; i < S.nodes.length; i++) {
            drawNodeCard(S.nodes[i], nowMs, dtMs);
        }

        // --- meta brain
        drawMetaBar(nowMs, dtMs);
    }

    function frame(nowMs) {
        S.rafId = null;
        if (!S.running || S.disposed) return;

        if (!S.pageVisible || !S.visible) {
            S.running = false;
            return;
        }

        const dt = nowMs - S.lastFrameAt;
        if (dt >= FRAME_BUDGET_MS) {
            const dtMs = Math.min(100, dt || FRAME_BUDGET_MS);
            S.lastFrameAt = nowMs;
            try {
                if (resizeIfNeeded()) {
                    if (nowMs - S.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) readSnapshot(nowMs);
                    if (!S.reducedMotion) updatePulses(dtMs, nowMs);
                    draw(nowMs, dtMs);
                }
            } catch (e) {
                console.warn('NeuralCanvas frame failed; stopping.', e);
                stop();
            }
        }
        S.rafId = (root && root.requestAnimationFrame ? root.requestAnimationFrame : requestAnimationFrame)(frame);
    }

    function start() {
        if (S.disposed || S.running) return false;
        const d = doc();
        if (!d || typeof d.getElementById !== 'function') return false;
        if (!S.started) {
            S.canvas = d.getElementById('neural-canvas');
            if (!S.canvas || typeof S.canvas.getContext !== 'function') return false;
            S.ctx = S.canvas.getContext('2d');
            if (!S.ctx) return false;
            S.started = true;
            try {
                const mq = typeof root !== 'undefined' && root.matchMedia
                    ? root.matchMedia('(prefers-reduced-motion: reduce)')
                    : (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null);
                S.reducedMotion = !!(mq && mq.matches);
            } catch (e) { S.reducedMotion = false; }
            ensureGlowSprite();
            bindLifecycle();
        }
        S.running = true;
        S.lastFrameAt = 0;
        S.rafId = (root && root.requestAnimationFrame ? root.requestAnimationFrame : requestAnimationFrame)(frame);
        return true;
    }

    function stop() {
        S.running = false;
        if (S.rafId !== null) {
            const cancel = (root && root.cancelAnimationFrame) ? root.cancelAnimationFrame : (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);
            if (cancel) { try { cancel(S.rafId); } catch (e) { /* noop */ } }
            S.rafId = null;
        }
        for (let i = 0; i < S.pulses.length; i++) S.freePulses.push(S.pulses[i]);
        S.pulses = [];
    }

    /** Full teardown: cancels the loop and removes every listener/observer. */
    function dispose() {
        stop();
        S.disposed = true;
        for (let i = 0; i < S.listeners.length; i++) {
            const l = S.listeners[i];
            try { l.target.removeEventListener(l.type, l.fn); } catch (e) { /* noop */ }
        }
        S.listeners = [];
        try { if (S.observer && S.observer.disconnect) S.observer.disconnect(); } catch (e) { /* noop */ }
        try { if (S.resizeObserver && S.resizeObserver.disconnect) S.resizeObserver.disconnect(); } catch (e) { /* noop */ }
        S.observer = null;
        S.resizeObserver = null;
        S.ctx = null;
        S.canvas = null;
        S.started = false;
        S.nodes = [];
        S.edges = [];
        S.edgeKey = '';
        S.freePulses = [];
        S.glowSprite = null;
    }

    function on(target, type, fn, options) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, fn, options);
        S.listeners.push({ target: target, type: type, fn: fn });
    }

    function bindLifecycle() {
        const d = doc();
        if (!d) return;

        const onVisibility = () => {
            S.pageVisible = !(d.hidden === true);
            if (S.pageVisible) start();
            else stop();
        };
        on(d, 'visibilitychange', onVisibility);
        S.pageVisible = !(d.hidden === true);

        const IO = (root && root.IntersectionObserver) || (typeof IntersectionObserver !== 'undefined' ? IntersectionObserver : null);
        if (IO && S.canvas) {
            try {
                S.observer = new IO((entries) => {
                    for (let i = 0; i < entries.length; i++) {
                        if (entries[i].target === S.canvas) S.visible = entries[i].isIntersecting !== false;
                    }
                    if (S.visible) start();
                }, { threshold: 0.01 });
                S.observer.observe(S.canvas);
            } catch (e) { S.observer = null; }
        }

        const RO = (root && root.ResizeObserver) || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
        if (RO && S.canvas) {
            try {
                S.resizeObserver = new RO(() => {
                    if (S.resizeQueued) return;
                    S.resizeQueued = true;
                    const raf = (root && root.requestAnimationFrame) ? root.requestAnimationFrame : (fn) => setTimeout(fn, 16);
                    raf(() => { S.resizeQueued = false; resizeIfNeeded(); });
                });
                S.resizeObserver.observe(S.canvas);
            } catch (e) { S.resizeObserver = null; }
        }

        if (root && typeof root.addEventListener === 'function') {
            on(root, 'pagehide', dispose, { once: true });
        }
    }

    return {
        start: start,
        stop: stop,
        dispose: dispose,
        isRunning: function () { return S.running; },
        AGENTS: AGENTS,
        // exposed for tests
        _state: S,
        _readSnapshot: readSnapshot,
        _buildLayout: buildLayout,
        _resizeIfNeeded: resizeIfNeeded
    };
});
