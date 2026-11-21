// rowing-call 3D scene: a dusk river and a procedural chundan vallam (snake boat).
// three.js r160 is vendored at /public/vendor/three.module.min.js — no other
// libraries, no external assets, no network. Usage:
//   const scene = createScene(canvas);
//   scene.setStrokeRate(spm); scene.flash('speed_up'); scene.setResult('obeyed');
//   scene.dispose();
// When WebGL is unavailable the same API is backed by a clean SVG illustration.

import * as THREE from '/public/vendor/three.module.min.js';

const BG = 0x0a0a0a;
const WARM = 0xe0a030;                          // the one warm signal colour
const OLIVE = 0x464a39;
const WOOD = 0x33271a;
const RESULT_TINT = { obeyed: 0x5fd068, not_obeyed: 0xe0604f, not_sure: 0xe0a030 };
const FLASH_TINT = { start: 0x5fd068, speed_up: 0xe0a030, slow_down: 0x9fb08a,
  ready: 0xd8d5c8, hold: 0xe0604f, stop: 0xe0604f };

const OARS = 20;        // oar pairs
const LEN = 36;         // hull length
const BEAM = 1.45;      // half beam amidships
const STALE_MS = 3000;  // no strokes this long -> glide to rest

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (v) => { const x = clamp01(v); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));

export function createScene(canvas) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch { renderer = null; }
  return renderer ? webgl(canvas, renderer, reduced) : fallback2d(canvas, reduced);
}

// ---------- hull loft ----------
// s = 0 at the raised prow (-X, direction of travel), s = 1 at the hooded stern.
const halfW = (s) => BEAM * Math.pow(Math.sin(Math.PI * clamp01(s)), 0.55) + 0.04;
const sheerY = (s) => 1.55 + 3.4 * Math.pow(1 - smooth(s / 0.16), 2)
  + 6.6 * Math.pow(smooth((s - 0.8) / 0.2), 1.7);
const keelY = (s) => -0.55 * Math.pow(Math.sin(Math.PI * clamp01(s)), 0.8) - 0.03;

function buildHull() {
  const S = 60, K = 9;
  const pos = [], idx = [];
  for (let i = 0; i <= S; i += 1) {
    const s = i / S, x = (s - 0.5) * LEN, w = halfW(s);
    const top = sheerY(s), bot = keelY(s);
    for (let j = 0; j < K; j += 1) {
      const u = (j / (K - 1)) * 2 - 1;
      pos.push(x, bot + (top - bot) * Math.pow(Math.abs(u), 1.8), u * w);
    }
  }
  for (let i = 0; i < S; i += 1) {
    for (let j = 0; j < K - 1; j += 1) {
      const a = i * K + j, b = a + K;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    color: WOOD, roughness: 0.92, metalness: 0.05, side: THREE.DoubleSide }));
}

function buildBoat() {
  const boat = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9 });
  const trim = new THREE.MeshStandardMaterial({ color: OLIVE, roughness: 0.7, emissive: 0x14140c });
  boat.add(buildHull());

  const deck = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.16, 2.4), wood);
  deck.position.set(-1.5, 1.62, 0);
  boat.add(deck);
  const sternDeck = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.16, 2.1), wood);
  sternDeck.position.set(14.2, 3.0, 0);
  boat.add(sternDeck);

  // strongly upturned, hooded stern: an arc rising from the tip and curling forward
  const hood = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.3, 8, 22, Math.PI * 0.9), trim);
  hood.position.set(18.6, 9.5, 0);
  hood.rotation.z = Math.PI * 0.55;
  boat.add(hood);
  const finial = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.5, 8), trim);
  finial.position.set(18.1, 11.9, 0);
  finial.rotation.z = 0.35;
  boat.add(finial);
  // raised prow: a smaller curl forward
  const prow = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.15, 6, 16, Math.PI * 0.8), trim);
  prow.position.set(-18.3, 4.6, 0);
  prow.rotation.z = -0.55;
  boat.add(prow);

  // rowers: instanced capsules seated along the gunwales
  const rowers = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.26, 0.72, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x2e3226, roughness: 1 }), OARS * 2);
  const d = new THREE.Object3D();
  let n = 0;
  for (let i = 0; i < OARS; i += 1) {
    const s = 0.13 + (i / (OARS - 1)) * 0.72;
    for (const side of [1, -1]) {
      d.position.set((s - 0.5) * LEN - 0.5, sheerY(s) + 0.28, side * 0.52);
      d.rotation.set(-0.15, 0, 0);
      d.updateMatrix();
      rowers.setMatrixAt(n, d.matrix);
      n += 1;
    }
  }
  boat.add(rowers);

  // oars: 20 pairs on gunwale pivots; each animates dip + sweep in local space
  const shaftG = new THREE.CylinderGeometry(0.05, 0.065, 5.4, 6).rotateX(Math.PI / 2).translate(0, 0, 2.6);
  const bladeG = new THREE.BoxGeometry(0.6, 0.07, 1.6).translate(0, 0, 5.4);
  const oarM = new THREE.MeshStandardMaterial({ color: 0x4a3b24, roughness: 0.85 });
  const oars = [];
  for (let i = 0; i < OARS; i += 1) {
    const s = 0.13 + (i / (OARS - 1)) * 0.72;
    for (const side of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set((s - 0.5) * LEN, sheerY(s) + 0.12, side * (halfW(s) + 0.08));
      pivot.rotation.y = side > 0 ? 0 : Math.PI; // both oars animate identically in local space
      const oar = new THREE.Group();
      oar.add(new THREE.Mesh(shaftG, oarM), new THREE.Mesh(bladeG, oarM));
      pivot.add(oar);
      boat.add(pivot);
      oars.push({ oar, side, phase: i * 0.09 });
    }
  }

  // stern lantern: the result glow
  const lampMat = new THREE.MeshBasicMaterial({ color: WARM });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), lampMat);
  lamp.position.set(14.2, 4.7, 0);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), wood);
  pole.position.set(14.2, 3.9, 0);
  const light = new THREE.PointLight(WARM, 1.4, 30, 2);
  light.position.copy(lamp.position);
  boat.add(pole, lamp, light);
  return { boat, oars, lampMat, light };
}

// stroke pose: dip = blade down angle, sweep = fore(-) to aft(+) angle
function pose(p) {
  if (p < 0.15) return { dip: lerp(0.12, 0.55, p / 0.15), sweep: lerp(-0.42, -0.38, p / 0.15) };
  if (p < 0.55) return { dip: 0.55, sweep: lerp(-0.38, 0.42, (p - 0.15) / 0.4) };
  if (p < 0.7) return { dip: lerp(0.55, 0.1, (p - 0.55) / 0.15), sweep: 0.42 };
  const q = (p - 0.7) / 0.3;
  return { dip: lerp(0.1, 0.12, q), sweep: lerp(0.42, -0.42, q * q * (3 - 2 * q)) };
}

function webgl(canvas, renderer, reduced) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(BG, 1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(BG, 0.015);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1200);
  camera.position.set(3, 7.6, 33);
  camera.lookAt(1, 3.0, 0);
  scene.add(new THREE.HemisphereLight(0x4a4b3e, 0x070706, 1.05));
  const sun = new THREE.DirectionalLight(0xd08a3a, 1.15);
  sun.position.set(-50, 15, -35);
  scene.add(sun);

  const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 24, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vP;
      void main(){
        float h = normalize(vP).y;
        vec3 col = mix(vec3(0.13,0.085,0.04), vec3(0.028,0.030,0.028), smoothstep(-0.03,0.45,h));
        col += vec3(0.42,0.20,0.05) * pow(max(0.0, 1.0 - abs(h + 0.01)), 14.0) * 0.55;
        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
  scene.add(sky);

  const waterU = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uDrift: { value: 0 },
    uTint: { value: new THREE.Color(WARM) }, uTintAmt: { value: 0 },
  }]);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(1100, 1100, 150, 150).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({ uniforms: waterU, fog: true,
      vertexShader: `#include <fog_pars_vertex>
        uniform float uTime; uniform float uDrift;
        varying vec3 vN; varying vec3 vW;
        float wv(vec2 p){
          p.x += uDrift;
          return sin(p.x*0.10 + uTime*0.8)*0.24 + sin(p.y*0.14 - uTime*0.6)*0.18 + sin((p.x+p.y)*0.21 + uTime*1.15)*0.09;
        }
        void main(){
          vec3 pos = position;
          float e = 0.8, h0 = wv(pos.xz);
          pos.y = h0;
          vN = normalize(vec3(-(wv(pos.xz+vec2(e,0.))-h0)/e, 1.0, -(wv(pos.xz+vec2(0.,e))-h0)/e));
          vec4 wp = modelMatrix * vec4(pos, 1.0);
          vW = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `#include <fog_pars_fragment>
        uniform vec3 uTint; uniform float uTintAmt;
        varying vec3 vN; varying vec3 vW;
        void main(){
          vec3 n = normalize(vN);
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
          vec3 col = vec3(0.024,0.028,0.022) + vec3(0.30,0.19,0.08) * fres * 0.5;
          vec3 L = normalize(vec3(-0.55, 0.28, -0.45));
          col += vec3(0.95,0.60,0.28) * pow(max(dot(reflect(-L, n), V), 0.0), 70.0) * 0.5;
          col += uTint * uTintAmt;
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    }));
  scene.add(water);

  const wakeU = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uIntensity: { value: 0 }, uTint: { value: new THREE.Color(0x8a8a72) },
  }]);
  const wake = new THREE.Mesh(
    new THREE.PlaneGeometry(85, 14, 48, 6).rotateX(-Math.PI / 2).translate(56, 0.35, 0),
    new THREE.ShaderMaterial({ uniforms: wakeU, fog: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `#include <fog_pars_vertex>
        varying vec2 vUv;
        void main(){
          vUv = uv;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `#include <fog_pars_fragment>
        uniform float uTime; uniform float uIntensity; uniform vec3 uTint;
        varying vec2 vUv;
        void main(){
          float edge = abs(vUv.y * 2.0 - 1.0);
          float dist = vUv.x;
          float streak = 0.6 + 0.4 * sin(vUv.y * 34.0 + sin(vUv.x * 26.0 - uTime * 2.2) * 2.4 + uTime * 1.3);
          float armLine = 0.12 + dist * 0.72;                  // V arms widen with distance
          float arms = 1.0 - smoothstep(0.0, 0.16, abs(edge - armLine));
          float churn = (1.0 - smoothstep(0.0, 0.4, dist)) * (1.0 - smoothstep(armLine * 0.6, armLine, edge));
          float fade = (1.0 - smoothstep(0.88, 1.0, edge)) * pow(1.0 - dist, 1.3);
          float a = uIntensity * fade * (arms + churn * 0.9) * streak;
          gl_FragColor = vec4(uTint * 1.25 + vec3(0.12, 0.13, 0.10), a);
          #include <fog_fragment>
        }`,
    }));
  scene.add(wake);

  const { boat, oars, lampMat, light } = buildBoat();
  scene.add(boat);

  // expanding ripple rings triggered by flash()
  const rings = [];
  for (let i = 0; i < 3; i += 1) {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: WARM, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    r.position.set(0, 0.5, 0);
    scene.add(r);
    rings.push({ mesh: r, t: Infinity });
  }

  const st = { targetSpm: 0, spm: 0, speed: 0, phase: 0, lastSpmT: 0,
    pulse: 0, ringIx: 0, tint: new THREE.Color(WARM), tintTarget: new THREE.Color(WARM),
    tintAmt: 0, tintAmtTarget: 0 };
  const clock = new THREE.Clock();
  let raf = 0, dead = false;

  function frame() {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    if (performance.now() - st.lastSpmT > STALE_MS) st.targetSpm = 0;
    const k = reduced ? 0.3 : 1;
    st.spm = damp(st.spm, st.targetSpm, 1.6, dt);
    st.speed = damp(st.speed, st.spm * 0.05 * k, 0.8, dt);
    st.phase += dt * (st.spm / 60) * (reduced ? 0.5 : 1);
    waterU.uTime.value += dt * k;
    waterU.uDrift.value += st.speed * dt * 3.0;
    wakeU.uTime.value = waterU.uTime.value;
    wakeU.uIntensity.value = damp(wakeU.uIntensity.value, Math.min(1, st.speed * 0.9), 1.2, dt);
    st.tint.lerp(st.tintTarget, 1 - Math.exp(-1.5 * dt));
    st.tintAmt = damp(st.tintAmt, st.tintAmtTarget, 1.5, dt);
    wakeU.uTint.value.copy(st.tint).lerp(new THREE.Color(0x8a8a72), 0.45);
    waterU.uTint.value.copy(st.tint);
    waterU.uTintAmt.value = st.tintAmt * 0.05;
    st.pulse = Math.max(0, st.pulse - dt * 1.4);
    light.intensity = 1.4 + st.pulse * 5;
    lampMat.color.copy(st.tint).multiplyScalar(1 + st.pulse * 0.8);
    light.color.copy(st.tint);
    lampMat.needsUpdate = true;
    for (const { oar, side, phase } of oars) {
      const p = ((st.phase + phase) % 1 + 1) % 1;
      const q = pose(p);
      oar.rotation.x = q.dip * Math.min(1, st.spm / 12 + (st.speed > 0.02 ? 1 : 0));
      oar.rotation.y = q.sweep * side;
    }
    boat.position.y = Math.sin(t * 0.7) * 0.09 * k * Math.min(1, st.spm / 30 + 0.15);
    boat.rotation.z = Math.sin(t * 0.5 + 1) * 0.012 * k;
    boat.rotation.x = -0.01 * st.speed + Math.sin(t * 0.6) * 0.006 * k;
    for (const r of rings) {
      if (r.t > 1.4) { r.mesh.material.opacity = 0; continue; }
      r.t += dt * 0.9;
      const q = clamp01(r.t / 1.4);
      r.mesh.scale.setScalar(1 + q * 16);
      r.mesh.material.opacity = (1 - q) * 0.55;
    }
    renderer.render(scene, camera);
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const onVis = () => {
    if (document.hidden) { cancelAnimationFrame(raf); clock.getDelta(); }
    else if (!dead) { clock.getDelta(); raf = requestAnimationFrame(frame); }
  };
  document.addEventListener('visibilitychange', onVis);
  frame();

  return {
    setStrokeRate(spm) {
      if (Number.isFinite(spm)) { st.targetSpm = Math.min(140, Math.max(0, spm)); st.lastSpmT = performance.now(); }
    },
    flash(type) {
      st.pulse = 1;
      const c = FLASH_TINT[type];
      const ring = rings[st.ringIx % rings.length];
      st.ringIx += 1;
      ring.t = 0;
      ring.mesh.material.color.set(c === undefined ? WARM : c);
      ring.mesh.position.set(type === 'stop' || type === 'hold' ? 8 : 0, 0.5, 0);
    },
    setResult(outcome) {
      st.tintTarget.set(RESULT_TINT[outcome] === undefined ? WARM : RESULT_TINT[outcome]);
      st.tintAmtTarget = outcome ? 1 : 0;
    },
    dispose() {
      dead = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      ro.disconnect();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      });
      renderer.dispose();
    },
  };
}

// ---------- 2D fallback (no WebGL): a clean SVG snake boat, same API ----------
function fallback2d(canvas, reduced) {
  canvas.style.display = 'none';
  const el = document.createElement('div');
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Illustration of a snake boat rowing at dusk');
  el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:linear-gradient(#0a0a0a 55%,#14120c 56%,#0a0a0a);overflow:hidden';
  const oars = [];
  for (let i = 0; i < 20; i += 1) oars.push(`<line class="fo" x1="${150 + i * 45}" y1="218" x2="${132 + i * 45}" y2="262" stroke="#4a3b24" stroke-width="5" stroke-linecap="round"/>`);
  el.innerHTML = `<svg viewBox="0 0 1050 400" style="width:min(90vw,1100px);height:auto" aria-hidden="true">
    <defs><linearGradient id="dsk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a0a0a"/><stop offset="0.6" stop-color="#241a0c"/><stop offset="1" stop-color="#0a0a0a"/></linearGradient></defs>
    <rect width="1050" height="400" fill="url(#dsk)"/>
    <rect y="250" width="1050" height="150" fill="#0b0d09"/>
    <path d="M60 250 Q30 190 70 160 Q60 200 95 235 L120 250" fill="none" stroke="#464a39" stroke-width="10" stroke-linecap="round"/>
    <path d="M70 250 L980 250 Q1010 250 1005 210 Q1030 260 985 272 L95 272 Q75 262 70 250 Z" fill="#261c11"/>
    <rect x="380" y="242" width="200" height="8" fill="#342a1c"/>
    ${oars.join('')}
    <circle class="fl" cx="960" cy="196" r="7" fill="#e0a030"/>
    <rect x="957" y="200" width="5" height="42" fill="#342a1c"/>
    <text x="525" y="360" fill="#a9ab9f" font-family="system-ui,sans-serif" font-size="17" text-anchor="middle">3D view needs WebGL — showing an illustration</text>
  </svg>`;
  canvas.insertAdjacentElement('afterend', el);
  const lines = [...el.querySelectorAll('.fo')];
  const lamp = el.querySelector('.fl');
  let spm = 0, phase = 0, raf = 0, dead = false, last = performance.now();
  const tick = (now) => {
    if (dead) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (now - lastSpm > STALE_MS) spm = 0;
    phase += dt * (spm / 60) * (reduced ? 0.4 : 1);
    lines.forEach((ln, i) => {
      const a = Math.sin((phase + i * 0.09) * Math.PI * 2) * 9;
      ln.setAttribute('transform', `rotate(${a.toFixed(2)} ${150 + i * 45} 218)`);
    });
  };
  let lastSpm = performance.now();
  const onVis = () => { if (document.hidden) cancelAnimationFrame(raf); else if (!dead) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(tick);
  return {
    setStrokeRate(v) { if (Number.isFinite(v)) { spm = Math.min(140, Math.max(0, v)); lastSpm = performance.now(); } },
    flash(type) { if (lamp) lamp.setAttribute('fill', `#${(FLASH_TINT[type] ?? WARM).toString(16).padStart(6, '0')}`); },
    setResult(o) { if (lamp) lamp.setAttribute('fill', `#${(RESULT_TINT[o] ?? WARM).toString(16).padStart(6, '0')}`); },
    dispose() { dead = true; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); el.remove(); canvas.style.display = ''; },
  };
}
