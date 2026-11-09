import { logoForSystem } from "./logos.js";
import { buildPairs } from "./aggregate.js";
// The 3D runs map. Systems sit on a ring in space; each workflow is an arc
// between the systems it touches, and a particle travels the arc at a rate
// proportional to that workflow's run volume. Colour is who built it, so the
// shape of the map answers "what is wired to what, how busy, and whose".

import * as THREE from "../vendor/three/three.module.js";

const RING_RADIUS = 9;
const RING_TILT = 0.42;
const NODE_SIZE = 1.55;

// Brand marks come from logos.js; null draws a lettered disc instead.
export function logoPathFor(tag) {
  return logoForSystem(tag);
}

// Sprite material with the logo drawn into a rounded disc, so an SVG and a PNG
// with a transparent background read the same against the dark scene.
function makeNodeSprite({ logoUrl, initials, color }) {
  const size = 160;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Disc with a soft rim.
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = "#181b22";
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = color;
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(NODE_SIZE, NODE_SIZE, 1);

  if (logoUrl) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Fit inside the disc, preserving aspect.
      const pad = size * 0.26;
      const box = size - pad * 2;
      const scale = Math.min(box / img.width, box / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      texture.needsUpdate = true;
    };
    img.onerror = () => {
      drawInitials(ctx, initials, size, color);
      texture.needsUpdate = true;
    };
    img.src = logoUrl;
  } else {
    drawInitials(ctx, initials, size, color);
    texture.needsUpdate = true;
  }

  return { sprite, canvas, texture, material };
}

function drawInitials(ctx, initials, size, color) {
  ctx.fillStyle = color;
  ctx.font = `600 ${Math.round(size * 0.34)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials || "?", size / 2, size / 2 + 2);
}

export function createMap(canvas, { onSelect } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x0b0d12, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b0d12, 22, 46);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
  camera.position.set(0, 13.5, 19);

  const group = new THREE.Group();
  scene.add(group);

  // Lighting is only for the arc tubes; sprites are unlit.
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(5, 12, 8);
  scene.add(key);

  const grid = new THREE.GridHelper(46, 46, 0x1e2430, 0x151a23);
  grid.position.y = -3.2;
  scene.add(grid);

  const nodeLayer = new THREE.Group();
  const edgeLayer = new THREE.Group();
  group.add(nodeLayer, edgeLayer);

  const nodes = new Map();
  const edges = [];
  const hitTubes = [];

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = null;
  let selectedId = null;

  const state = { azimuth: 0.6, elevation: RING_TILT, distance: 24, autoRotate: true };
  const target = { ...state };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // Positions a system on the ring by index, so the layout is stable across
  // reloads and a person can learn where their systems live.
  function ringPosition(index, total) {
    const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
    return new THREE.Vector3(
      Math.cos(angle) * RING_RADIUS,
      0,
      Math.sin(angle) * RING_RADIUS
    );
  }

  function clearScene() {
    for (const [, n] of nodes) {
      nodeLayer.remove(n.sprite);
      n.sprite.material.map.dispose();
      n.sprite.material.dispose();
    }
    for (const [, n] of nodes) if (n.stem) { nodeLayer.remove(n.stem); n.stem.geometry.dispose(); }
    nodes.clear();
    for (const edge of edges) {
      edgeLayer.remove(edge.line);
      edge.line.geometry.dispose();
      edge.line.material.dispose();
      edgeLayer.remove(edge.hit);
      edge.hit.geometry.dispose();
      edge.hit.material.dispose();
      edgeLayer.remove(edge.particles);
      edge.particles.geometry.dispose();
      edge.particles.material.dispose();
    }
    edges.length = 0;
    hitTubes.length = 0;
    hovered = null;
    selectedId = null;
  }

  // Builds the scene from the runs-map view model already produced server-side.
  function setData({ nodes: nodeData, edges: edgeData, builders }) {
    clearScene();
    const total = nodeData.length;

    nodeData.forEach((node, i) => {
      const pos = ringPosition(i, total);
      const { sprite } = makeNodeSprite({
        logoUrl: node.logoPath,
        initials: node.initials,
        color: node.color
      });
      sprite.position.copy(pos);
      sprite.userData = { kind: "node", ...node };
      nodeLayer.add(sprite);
      nodes.set(node.key, { sprite, data: node, position: pos, base: pos.clone() });

      // A stem down to the grid, so depth is readable.
      const stemGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(pos.x, pos.y, pos.z),
        new THREE.Vector3(pos.x, -3.2, pos.z)
      ]);
      const stem = new THREE.Line(
        stemGeo,
        new THREE.LineBasicMaterial({ color: 0x252c39, transparent: true, opacity: 0.85 })
      );
      nodeLayer.add(stem);
      nodes.get(node.key).stem = stem;
    });

    const builderColor = new Map((builders || []).map((b) => [b.name, b.color]));
    // One arc per pair of systems, carrying every workflow that connects them.
    const pairs = buildPairs(edgeData);
    const maxRuns = Math.max(1, ...pairs.map((p) => p.runs));

    for (const pair of pairs) {
      const a = nodes.get(systemKeyFor(pair.a));
      const b = nodes.get(systemKeyFor(pair.b));
      if (!a || !b) continue;

      const weight = pair.runs / maxRuns;
      const mid = a.position.clone().add(b.position).multiplyScalar(0.5);
      mid.y += 1.6 + weight * 4.2;
      const curve = new THREE.QuadraticBezierCurve3(a.position, mid, b.position);

      const color = new THREE.Color(builderColor.get(pair.owner) || "#5b7cfa");
      const radius = 0.035 + weight * 0.11;
      const geo = new THREE.TubeGeometry(curve, 40, radius, 6, false);
      const baseOpacity = 0.16 + weight * 0.42;
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: baseOpacity });
      const line = new THREE.Mesh(geo, mat);
      line.userData = { kind: "edge", pairKey: pair.key, pair, baseOpacity };
      edgeLayer.add(line);

      // A wider, invisible tube around the line so a thin arc is still easy to
      // hover and click. Raycasting hits it; it never draws.
      const hit = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 24, 0.32, 5, false),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hit.userData = { kind: "edge", pairKey: pair.key, pair };
      edgeLayer.add(hit);
      hitTubes.push(hit);

      // Particles: speed and count scale with volume.
      const particleGeo = new THREE.BufferGeometry();
      const count = Math.max(2, Math.min(14, Math.round(2 + weight * 10)));
      const positions = new Float32Array(count * 3);
      particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const particleMat = new THREE.PointsMaterial({
        color,
        size: 0.16 + weight * 0.16,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const particles = new THREE.Points(particleGeo, particleMat);
      edgeLayer.add(particles);

      edges.push({
        curve,
        line,
        hit,
        particles,
        offsets: Array.from({ length: count }, (_, k) => k / count),
        speed: 0.035 + weight * 0.22,
        weight
      });
    }
  }

  // The server sends human system labels; the node map is keyed by tag.
  const TAG_BY_LABEL = new Map();
  function registerTags(nodesData) {
    for (const n of nodesData) TAG_BY_LABEL.set(n.label, n.key);
  }
  function systemKeyFor(label) {
    return TAG_BY_LABEL.get(label) || label;
  }

  // Highlight one arc (by pair key) and dim the rest; null restores all.
  function paint(pairKey) {
    for (const edge of edges) {
      const on = !pairKey || edge.line.userData.pairKey === pairKey;
      edge.line.material.opacity = !pairKey ? edge.line.userData.baseOpacity : on ? 0.85 : 0.05;
      edge.particles.material.opacity = on ? 1 : 0.1;
    }
  }

  function setSelected(pairKey) {
    selectedId = pairKey;
    paint(pairKey);
  }

  function setHover(pairKey) {
    if (selectedId) return;
    paint(pairKey);
  }

  function onPointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // Systems win over arcs: a logo sits on top of the arcs that meet at it.
    const nodeHits = raycaster.intersectObjects([...nodeLayer.children].filter((c) => c.isSprite));
    const next = nodeHits.length ? nodeHits[0].object : (raycaster.intersectObjects(hitTubes)[0] || {}).object || null;
    if (next !== hovered) {
      if (hovered && hovered.isSprite) hovered.material.color.setHex(0xffffff);
      hovered = next;
      if (hovered && hovered.isSprite) hovered.material.color.setHex(0xbfd0ff);
      canvas.style.cursor = hovered ? "pointer" : "grab";
      const isEdge = hovered && hovered.userData.kind === "edge";
      setHover(isEdge ? hovered.userData.pairKey : null);
      if (onSelect) {
        onSelect(isEdge
          ? { kind: "hover", edge: hovered.userData.pair, clientX: event.clientX, clientY: event.clientY }
          : { kind: "hover", node: hovered ? hovered.userData : null });
      }
    } else if (hovered && hovered.userData.kind === "edge" && onSelect) {
      onSelect({ kind: "move", clientX: event.clientX, clientY: event.clientY });
    }
  }

  function onClick() {
    if (!onSelect) return;
    if (!hovered) return onSelect({ kind: "select", edge: null, node: null });
    if (hovered.userData.kind === "edge") {
      setSelected(hovered.userData.pairKey);
      onSelect({ kind: "select", edge: hovered.userData.pair });
    } else {
      onSelect({ kind: "select", node: hovered.userData });
    }
  }

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("click", onClick);

  // Drag to orbit, wheel to zoom. Deliberately simple: no controls library, so
  // there is nothing extra to vendor.
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    state.autoRotate = false;
    target.autoRotate = false;
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("pointerup", () => {
    dragging = false;
    canvas.style.cursor = hovered ? "pointer" : "grab";
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    target.azimuth -= (e.clientX - lastX) * 0.005;
    target.elevation = Math.max(0.08, Math.min(1.25, target.elevation + (e.clientY - lastY) * 0.004));
    lastX = e.clientX;
    lastY = e.clientY;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      target.distance = Math.max(13, Math.min(42, target.distance + e.deltaY * 0.02));
    },
    { passive: false }
  );

  const clock = new THREE.Clock();
  function animate() {
    const t = clock.getElapsedTime();

    if (target.autoRotate) target.azimuth += 0.0012;
    state.azimuth += (target.azimuth - state.azimuth) * 0.08;
    state.elevation += (target.elevation - state.elevation) * 0.08;
    state.distance += (target.distance - state.distance) * 0.08;

    const y = Math.sin(state.elevation) * state.distance;
    const r = Math.cos(state.elevation) * state.distance;
    camera.position.set(Math.cos(state.azimuth) * r, y, Math.sin(state.azimuth) * r);
    camera.lookAt(0, 0, 0);

    for (const edge of edges) {
      const attr = edge.particles.geometry.getAttribute("position");
      for (let i = 0; i < edge.offsets.length; i += 1) {
        const u = (edge.offsets[i] + t * edge.speed) % 1;
        const p = edge.curve.getPoint(u);
        attr.setXYZ(i, p.x, p.y, p.z);
      }
      attr.needsUpdate = true;
    }

    // Gentle bob so the ring is not a static ring.
    for (const [, node] of nodes) {
      node.sprite.position.y = node.base.y + Math.sin(t * 0.8 + node.base.x) * 0.13;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  animate();

  return {
    setData(data) {
      registerTags(data.nodes);
      setData(data);
    },
    setSelected,
    setHover,
    resetView() {
      target.azimuth = 0.6;
      target.elevation = RING_TILT;
      target.distance = 24;
      target.autoRotate = true;
    },
    dispose() {
      observer.disconnect();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("click", onClick);
      clearScene();
      renderer.dispose();
    }
  };
}
