import { useEffect, useMemo, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { resolveGraphStyle } from './graphStyles';
import { groupColor } from './buildGraph';
import { useCanvasTokens, FONT } from './canvasTokens';
import { attachPinchZoom, createGlide, keepInView, registerTestHook, sanitizePositions, watchCanvasSize, wheelFactor } from './canvasKit';

/**
 * Real three.js 3D node graph. Nodes are placed with the deterministic
 * spherical-tree layout, drawn as an InstancedMesh of low-poly spheres with
 * per-instance color and degree-based scale, and links as a single
 * LineSegments buffer. Drag orbits (yaw/pitch), wheel zooms, click selects.
 * Rendering is on-demand: frames are only produced during/shortly after
 * interaction, and the loop pauses while the tab is hidden.
 */
const CAM_DIST = 950; // fallback before the first layout
const FOV = 50;
const MAX_3D_NODES = 50000; // GPU instancing keeps this smooth
const LABEL_COUNT = 40; // sprite labels for the highest-degree nodes only
const LINK_OPACITY = 0.35;
const IDLE_MS = 2000; // keep the rAF loop alive this long after interaction
const AUTO_ROTATE_SPEED = 0.0022; // rad/frame — a slow, cinematic spin
// The usable part of the canvas (CSS px clear of the toolbar row, the replay
// strip and the legend): the selected node is kept inside it.
const DEFAULT_INSET = { top: 40, right: 40, bottom: 88, left: 40 };

/** Strip the alpha channel from an rgba() color (link opacity is constant here). */
function opaqueColor(color) {
  const m = /^rgba\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,[^)]+\)$/.exec(String(color).trim());
  return m ? `rgb(${m[1]},${m[2]},${m[3]})` : color;
}

/** Same node sizing rule as the 2D renderers. */
function nodeRadius(n) {
  return n.kind === 'broker' || n.kind === 'opcua-server' || n.kind === 'i3x-server'
    ? 10
    : 4 + Math.sqrt(n.degree || 0) * 1.6;
}

function truncateLabel(label) {
  const s = String(label ?? '');
  return s.length > 20 ? `${s.slice(0, 19)}…` : s;
}

/** Canvas-textured billboard label (halo + fill from the style's label colors). */
function makeLabelSprite(text, labelStyle) {
  const fontSize = 28;
  const pad = 10;
  const font = `500 ${fontSize}px ${FONT}`;
  const canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d');
  ctx.font = font;
  const w = Math.max(2, Math.ceil(ctx.measureText(text).width) + pad * 2);
  const h = fontSize + pad * 2;
  canvas.width = w;
  canvas.height = h;
  ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = labelStyle.halo;
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = labelStyle.color;
  ctx.fillText(text, w / 2, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.userData.text = text; // re-rasterised in place on a theme change
  const worldH = 15; // world units; perspective scales it with distance
  sprite.scale.set(worldH * (w / h), worldH, 1);
  return sprite;
}

/**
 * Camera distance that fits a sphere of `radius` (around the origin) in a
 * perspective view with vertical field of view `fovDeg` and the given aspect,
 * with a little margin. Exported for tests.
 */
export function fitDistance(radius, fovDeg, aspect) {
  const r = Math.max(Number.isFinite(radius) ? radius : 0, 10);
  const v = (fovDeg * Math.PI) / 360;
  const h = Math.atan(Math.tan(v) * (aspect > 0 ? aspect : 1));
  return (r / Math.sin(Math.min(v, h))) * 1.08;
}

function applySceneTheme(scene, ambient, dirLight, style) {
  scene.background = new THREE.Color(style.background);
  ambient.color.set(style.scene3d.ambient);
  ambient.intensity = style.scene3d.ambientIntensity;
  dirLight.color.set(style.scene3d.directional);
  dirLight.intensity = style.scene3d.directionalIntensity;
}

function positionLabel(sprite, n) {
  sprite.position.set(n.x, n.y + nodeRadius(n) + 10, n.z);
}

function disposeObject(obj) {
  if (obj.geometry) obj.geometry.dispose();
  const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
  for (const m of mats) {
    if (m.map) m.map.dispose();
    m.dispose();
  }
}

const ForceGraph3D = forwardRef(function ForceGraph3D(
  {
    data,
    styleId = 'standard',
    selectedId = null,
    onSelect,
    colorByProtocol = false,
    nodeScale = 1, // 0.5–2  point-size multiplier
    linkOpacity = LINK_OPACITY, // 0–0.8  link line opacity
    autoRotate = false, // gentle continuous spin
    beautify = false, // depth-graded colours + glow + auto-rotate
    inset = DEFAULT_INSET // clear of the floating overlays: where the selection is kept
  },
  ref
) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const threeRef = useRef(null); // { renderer, scene, camera, rotGroup, requestRender }
  const objsRef = useRef(null); // per-dataset scene objects (rebuilt when data/style change)
  const nodesRef = useRef([]);
  const byIdRef = useRef(new Map());
  const rotRef = useRef({ yaw: 0.6, pitch: -0.35 });
  const zoomRef = useRef(1);
  // Camera pan in its own x/y plane (world units). The orbit rotates the scene
  // group; panning moves the camera sideways, so a selected node that a docked
  // panel would cover can be brought back into the visible viewport.
  const panRef = useRef({ x: 0, y: 0 });
  const glideRef = useRef(null); // a pan glide in progress (createGlide), cancelled by user input
  const insetRef = useRef(inset);
  useEffect(() => {
    insetRef.current = inset;
  }, [inset]);
  const radiusRef = useRef(0); // bounding radius of the current layout (fits the camera)
  const selSpriteRef = useRef(null);
  const autoRotateRef = useRef(false); // read by the render loop each frame
  const nodeScaleRef = useRef(nodeScale); // keeps the selection ring hugging scaled nodes
  const onSelectRef = useRef(onSelect);
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const linkOpacityRef = useRef(linkOpacity); // initial opacity for a rebuilt scene (the look effect keeps it current)
  useEffect(() => {
    linkOpacityRef.current = linkOpacity;
  }, [linkOpacity]);
  onSelectRef.current = onSelect;

  // Theme-derived style (canvasTokens). The scene is built once per dataset; a
  // theme or style change updates materials, lights, background and label
  // textures IN PLACE (see the theme effect), keeping camera and selection.
  const tokens = useCanvasTokens();
  const style = useMemo(() => resolveGraphStyle(styleId, tokens), [styleId, tokens]);
  const styleRef = useRef(style);
  const colorFor = useCallback(
    (n) => (n.state ? tokens[n.state] || style.palette[0] : colorByProtocol && n.protocol ? style.protocol[n.protocol] || style.palette[0] : groupColor(n.group, style.palette)),
    [colorByProtocol, style, tokens]
  );
  const colorForRef = useRef(colorFor);

  const capped = data && data.nodes.length > MAX_3D_NODES;

  // Renderer / camera / controls — created once.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 20000);
    camera.position.set(0, 0, CAM_DIST);
    let frames = 0;
    // Distance that frames the whole layout at zoom 1 (the old fixed 950 put the
    // camera INSIDE a 6-level tree: you only ever saw a corner of it).
    const baseDist = () => (radiusRef.current ? fitDistance(radiusRef.current, FOV, camera.aspect) : CAM_DIST);
    const placeCamera = () => {
      const d = baseDist() / zoomRef.current;
      camera.position.set(panRef.current.x, panRef.current.y, d);
      const far = d + radiusRef.current * 2 + 100;
      if (Math.abs(camera.far - far) > 1) {
        camera.far = far;
        camera.updateProjectionMatrix();
      }
    };
    // Everything orbits by rotating this group; the camera only moves along z for zoom.
    const rotGroup = new THREE.Group();
    scene.add(rotGroup);
    // Light colours come from the style preset (set in the scene-build effect).
    const ambient = new THREE.AmbientLight(undefined, 0.9);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(undefined, 1.6);
    dirLight.position.set(0.5, 1, 2);
    scene.add(dirLight);
    const raycaster = new THREE.Raycaster();

    // On-demand render loop: run only while interacting (plus a short tail).
    let raf = 0;
    let lastActive = 0;
    const renderFrame = () => {
      const rot = rotRef.current;
      rotGroup.rotation.set(rot.pitch, rot.yaw, 0); // Rx(pitch) ∘ Ry(yaw), same as the old projection
      placeCamera();
      renderer.render(scene, camera);
      frames++;
    };
    const loop = () => {
      raf = 0;
      if (autoRotateRef.current) rotRef.current.yaw += AUTO_ROTATE_SPEED;
      const g = glideRef.current;
      if (g) {
        const { values, done } = g.step(performance.now());
        panRef.current = values;
        if (done) glideRef.current = null;
      }
      renderFrame();
      const interacting = performance.now() - lastActive < IDLE_MS;
      if ((interacting || autoRotateRef.current || glideRef.current) && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const requestRender = (sustain = false) => {
      if (sustain) lastActive = performance.now();
      if (!raf && !document.hidden) raf = requestAnimationFrame(loop);
    };

    // Where the selected node lands on screen (CSS px) and its drawn radius there.
    const tmpV = new THREE.Vector3();
    const selectedOnScreen = () => {
      const id = selectedIdRef.current;
      const n = id != null ? byIdRef.current.get(id) : null;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!n || !w || !h) return null;
      rotGroup.rotation.set(rotRef.current.pitch, rotRef.current.yaw, 0);
      rotGroup.updateMatrixWorld();
      placeCamera();
      camera.updateMatrixWorld();
      tmpV.set(n.x, n.y, n.z).applyMatrix4(rotGroup.matrixWorld);
      const depth = camera.position.z - tmpV.z; // camera looks down -z, unrotated
      if (!(depth > 1)) return null; // behind the camera
      const unitsPerPx = (2 * depth * Math.tan((FOV * Math.PI) / 360)) / h;
      tmpV.project(camera);
      return { id: n.id, sx: ((tmpV.x + 1) / 2) * w, sy: ((1 - tmpV.y) / 2) * h, r: (nodeRadius(n) * nodeScaleRef.current) / unitsPerPx, unitsPerPx, w, h };
    };
    // Keep the selection inside the visible viewport (canvas minus the overlay
    // insets): the least sideways camera move, as a short glide (instant with
    // reduced motion). Called when the canvas resizes (a details panel opening
    // narrows it) and when the selection changes. User input cancels the glide.
    const keepSelected = () => {
      const p = selectedOnScreen();
      if (!p) return;
      const { dx, dy } = keepInView(p.sx, p.sy, p.r + 10, { w: p.w, h: p.h }, insetRef.current);
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      // A screen move of (dx, dy) = the camera moving the other way: x right, world y up.
      const from = glideRef.current ? glideRef.current.to : panRef.current;
      const to = { x: from.x - dx * p.unitsPerPx, y: from.y + dy * p.unitsPerPx };
      glideRef.current = createGlide({ ...panRef.current }, to);
      requestRender(true);
    };

    // Container resize (incl. sidebar collapse) AND device-pixel-ratio changes.
    const unwatch = watchCanvasSize(wrap, ({ w: width, h: height, dpr }) => {
      if (!width || !height) return;
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderFrame(); // a resized canvas is cleared: paint synchronously
      keepSelected();
    });
    // three.js keeps its scene through a context loss; repaint once restored.
    const onRestored = () => requestRender();
    canvas.addEventListener('webglcontextrestored', onRestored);

    const onVisibility = () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else {
        requestRender();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Analytic ray-sphere picking in layout space — much faster than
    // raycasting 50k instanced sphere geometries triangle-by-triangle.
    const ndc = new THREE.Vector2();
    const sphere = new THREE.Sphere();
    const hitPoint = new THREE.Vector3();
    const invWorld = new THREE.Matrix4();
    const localRay = new THREE.Ray();
    const pick = (e) => {
      const objs = objsRef.current;
      if (!objs) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      placeCamera();
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      rotGroup.rotation.set(rotRef.current.pitch, rotRef.current.yaw, 0);
      rotGroup.updateMatrixWorld();
      invWorld.copy(rotGroup.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(invWorld);
      const { positions, radii } = objs;
      const scale = nodeScaleRef.current; // the DRAWN radius, so picking matches the point-size slider
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < radii.length; i++) {
        sphere.center.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        sphere.radius = radii[i] * scale + 1.5;
        if (localRay.intersectSphere(sphere, hitPoint)) {
          const d = hitPoint.distanceToSquared(localRay.origin);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      return best >= 0 ? nodesRef.current[best] : null;
    };

    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    let pinching = false;
    const unpinch = attachPinchZoom(
      canvas,
      (factor) => {
        zoomRef.current = Math.max(0.15, Math.min(6, zoomRef.current * factor));
        glideRef.current = null;
        moved = Infinity;
        requestRender(true);
      },
      (on) => {
        pinching = on;
      }
    );
    const onDown = (e) => {
      if (e.button > 0) return;
      e.preventDefault(); // no text selection / native touch scrolling while orbiting
      glideRef.current = null; // the user takes the camera
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (!dragging || pinching) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      const rot = rotRef.current;
      rot.yaw += dx * 0.008;
      rot.pitch = Math.max(-1.5, Math.min(1.5, rot.pitch + dy * 0.008));
      requestRender(true);
    };
    const onUp = (e) => {
      if (!dragging) return;
      canvas.style.cursor = 'grab';
      if (moved < 5 && !pinching) {
        const node = pick(e);
        if (node && onSelectRef.current) onSelectRef.current(node);
      }
      dragging = false;
    };
    const onWheel = (e) => {
      e.preventDefault();
      glideRef.current = null;
      zoomRef.current = Math.max(0.15, Math.min(6, zoomRef.current * wheelFactor(e)));
      requestRender(true);
    };
    canvas.style.cursor = 'grab';
    // Right-click a node to open its properties (suppress the native menu).
    const onContext = (e) => {
      const node = pick(e);
      if (node && onSelectRef.current) {
        e.preventDefault();
        onSelectRef.current(node);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);

    window.addEventListener('pointercancel', onUp);
    threeRef.current = { renderer, scene, camera, rotGroup, requestRender, ambient, dirLight, keepSelected };
    requestRender();

    const v = new THREE.Vector3();
    const unhook = registerTestHook('graph3d', {
      get selectedId() {
        return selectedIdRef.current ?? null;
      },
      get frames() {
        return frames;
      },
      get animating() {
        return raf !== 0;
      },
      get camera() {
        return { z: camera.position.z, far: camera.far, aspect: camera.aspect, radius: radiusRef.current, zoom: zoomRef.current };
      },
      /** Camera pan (world units) and whether a keep-in-view glide is running. */
      get pan() {
        return { ...panRef.current, gliding: Boolean(glideRef.current) };
      },
      /** The visible viewport: canvas minus the overlay insets (canvas-relative CSS px). */
      get viewport() {
        const i = insetRef.current;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        return { x0: i.left, y0: i.top, x1: w - i.right, y1: h - i.bottom };
      },
      /** The selected node on screen: { id, sx, sy, r } (canvas-relative CSS px) or null. */
      selectedScreen() {
        const p = selectedOnScreen();
        return p ? { id: p.id, sx: p.sx, sy: p.sy, r: p.r } : null;
      },
      /** Rotate and pan as a user drag would (test setup: put the selection somewhere). */
      setView({ yaw, pitch, pan } = {}) {
        glideRef.current = null;
        if (yaw != null) rotRef.current.yaw = yaw;
        if (pitch != null) rotRef.current.pitch = pitch;
        if (pan) panRef.current = { x: pan.x, y: pan.y };
        renderFrame();
      },
      get size() {
        return { w: canvas.clientWidth, h: canvas.clientHeight, bw: canvas.width, bh: canvas.height };
      },
      /** Screen positions (canvas-relative CSS px) of nodes in front of the camera. */
      nodes(limit = 500) {
        renderFrame();
        rotGroup.updateMatrixWorld();
        camera.updateMatrixWorld();
        const out = [];
        for (const n of nodesRef.current) {
          v.set(n.x, n.y, n.z).applyMatrix4(rotGroup.matrixWorld).project(camera);
          if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
          out.push({ id: n.id, sx: ((v.x + 1) / 2) * canvas.clientWidth, sy: ((1 - v.y) / 2) * canvas.clientHeight, depth: v.z });
          if (out.length >= limit) break;
        }
        return out;
      },
      get rotation() {
        return { ...rotRef.current };
      },
      /** The colour of the top-left corner (the scene background) as [r, g, b]. */
      bgPixel() {
        renderFrame();
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        gl.readPixels(1, gl.drawingBufferHeight - 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0], px[1], px[2]];
      },
      loseContext: () => renderer.forceContextLoss(),
      restoreContext: () => renderer.forceContextRestore(),
      /**
       * Paint now and read back pixels (the drawing buffer is not preserved
       * between frames). `points` are canvas-relative CSS px (e.g. from nodes());
       * default: an 8x8 grid. Returns how many distinct colours were seen.
       */
      sample(points = null) {
        renderFrame();
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        const seen = new Set();
        const sx = gl.drawingBufferWidth / (canvas.clientWidth || 1);
        const sy = gl.drawingBufferHeight / (canvas.clientHeight || 1);
        const pts = points || Array.from({ length: 64 }, (_, i) => ({ sx: ((i % 8) + 0.5) * (canvas.clientWidth / 8), sy: (Math.floor(i / 8) + 0.5) * (canvas.clientHeight / 8) }));
        pts.push({ sx: 2, sy: 2 }); // a background corner
        for (const p of pts) {
          gl.readPixels(Math.floor(p.sx * sx), Math.floor(gl.drawingBufferHeight - 1 - p.sy * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          seen.add(px.join(','));
        }
        return { distinct: seen.size, lost: gl.isContextLost() };
      }
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      unhook();
      unwatch();
      unpinch();
      window.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      threeRef.current = null;
      renderer.dispose();
      // Release the GL context once the canvas has really left the page (a
      // StrictMode re-mount reuses the same canvas), so repeated navigation never
      // hits the browser's live-context limit.
      setTimeout(() => {
        if (!canvas.isConnected) renderer.forceContextLoss();
      }, 0);
    };
  }, []);

  // Build the scene graph when data / style / coloring change.
  useEffect(() => {
    const three = threeRef.current;
    if (!three || !data) return undefined;

    const nodes = data.nodes.slice(0, MAX_3D_NODES).map((n) => ({ ...n }));
    const keep = new Set(nodes.map((n) => n.id));
    const links = data.links.filter((l) => keep.has(l.source) && keep.has(l.target)).map((l) => ({ ...l }));
    const maxDepth = sphericalTreeLayout(nodes, links);
    sanitizePositions(nodes, { minSep: 6, keys: ['x', 'y', 'z'] });
    let radius = 0;
    for (const n of nodes) radius = Math.max(radius, Math.hypot(n.x, n.y, n.z) + nodeRadius(n) * 2);
    radiusRef.current = radius;
    nodesRef.current = nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    byIdRef.current = byId;

    const { scene, rotGroup, requestRender, ambient, dirLight } = three;
    const style = styleRef.current;
    const colorFor = colorForRef.current;
    applySceneTheme(scene, ambient, dirLight, style);

    const group = new THREE.Group();

    // Nodes: one instanced low-poly sphere with per-instance color + scale.
    // Fewer triangles per instance as the graph grows: 11k x 12x8-segment spheres
    // is ~2M triangles per frame, and at that density a node is a few pixels anyway.
    const seg = nodes.length > 20000 ? [6, 4] : nodes.length > 4000 ? [8, 6] : [12, 8];
    const nodeGeo = new THREE.SphereGeometry(1, seg[0], seg[1]);
    const nodeMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(style.scene3d.nodeBase) });
    const nodeMesh = new THREE.InstancedMesh(nodeGeo, nodeMat, Math.max(1, nodes.length));
    nodeMesh.count = nodes.length;
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    const positions = new Float32Array(nodes.length * 3);
    const radii = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const r = nodeRadius(n);
      positions[i * 3] = n.x;
      positions[i * 3 + 1] = n.y;
      positions[i * 3 + 2] = n.z;
      radii[i] = r;
      pos.set(n.x, n.y, n.z);
      const s = r * nodeScaleRef.current;
      scl.set(s, s, s);
      nodeMesh.setMatrixAt(i, m4.compose(pos, quat, scl));
      nodeMesh.setColorAt(i, col.set(colorFor(n)));
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    group.add(nodeMesh);

    // Links: a single LineSegments buffer whose opacity/blending the look effects tune.
    let lineMat = null;
    if (links.length > 0) {
      const linePos = new Float32Array(links.length * 6);
      let j = 0;
      for (const l of links) {
        const a = byId.get(l.source);
        const b = byId.get(l.target);
        linePos[j++] = a.x;
        linePos[j++] = a.y;
        linePos[j++] = a.z;
        linePos[j++] = b.x;
        linePos[j++] = b.y;
        linePos[j++] = b.z;
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
      lineMat = new THREE.LineBasicMaterial({
        color: new THREE.Color(opaqueColor(style.link.color)),
        transparent: true,
        opacity: linkOpacityRef.current,
        depthWrite: false
      });
      group.add(new THREE.LineSegments(lineGeo, lineMat));
    }

    // Labels: sprites for the highest-degree nodes only (text is expensive).
    const labelGroup = new THREE.Group();
    // Labels scale with the layout so they stay readable when the camera is fit to a big tree.
    const labelScale = Math.max(1, radius / 450);
    const labeled = new Set();
    const byDegree = nodes.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, LABEL_COUNT);
    for (const n of byDegree) {
      if (!n.label) continue;
      const sprite = makeLabelSprite(truncateLabel(n.label), style.label);
      sprite.scale.multiplyScalar(labelScale);
      sprite.userData.scale = labelScale;
      positionLabel(sprite, n);
      labelGroup.add(sprite);
      labeled.add(n.id);
    }
    group.add(labelGroup);

    // Selection highlight: a wireframe shell scaled around the selected node.
    const highlight = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(style.selectedRing), wireframe: true, transparent: true, opacity: 0.9 })
    );
    highlight.visible = false;
    group.add(highlight);

    rotGroup.add(group);
    objsRef.current = { group, labelGroup, highlight, labeled, positions, radii, nodeMesh, nodeMat, lineMat, maxDepth };
    requestRender();

    return () => {
      rotGroup.remove(group);
      group.traverse(disposeObject);
      selSpriteRef.current = null;
      objsRef.current = null;
    };
  }, [data]);

  // Theme / style change: recolour the existing scene in place (no rebuild).
  useEffect(() => {
    styleRef.current = style;
    colorForRef.current = colorFor;
    const three = threeRef.current;
    if (!three) return;
    applySceneTheme(three.scene, three.ambient, three.dirLight, style);
    const objs = objsRef.current;
    if (objs) {
      objs.lineMat?.color.set(opaqueColor(style.link.color));
      objs.highlight.material.color.set(style.selectedRing);
      for (const sprite of objs.labelGroup.children) {
        const next = makeLabelSprite(sprite.userData.text, style.label);
        sprite.material.map?.dispose();
        sprite.material.map = next.material.map;
        sprite.material.needsUpdate = true;
        sprite.scale.copy(next.scale).multiplyScalar(sprite.userData.scale || 1);
        next.material.dispose();
      }
    }
    three.requestRender();
  }, [style, colorFor]);

  // Auto-rotate is driven by a ref the render loop reads; Beautify also spins.
  useEffect(() => {
    autoRotateRef.current = autoRotate || beautify;
    if (autoRotateRef.current) threeRef.current?.requestRender();
  }, [autoRotate, beautify]);

  // Node colours: depth-graded ramp when Beautify is on, else the group palette.
  useEffect(() => {
    const three = threeRef.current;
    const objs = objsRef.current;
    if (!three || !objs?.nodeMesh) return;
    const nodes = nodesRef.current;
    const { nodeMesh, maxDepth } = objs;
    const inner = new THREE.Color(style.linkHighlight);
    const outer = new THREE.Color(style.palette[6]);
    const c = new THREE.Color();
    for (let i = 0; i < nodes.length; i++) {
      if (beautify) {
        const t = maxDepth ? (nodes[i].depth || 0) / maxDepth : 0;
        c.copy(inner).lerp(outer, t);
      } else {
        c.set(colorFor(nodes[i]));
      }
      nodeMesh.setColorAt(i, c);
    }
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    three.requestRender();
  }, [beautify, data, style, colorFor]);

  // Link opacity + optional additive glow when Beautify is on (skip light styles).
  useEffect(() => {
    const three = threeRef.current;
    const lineMat = objsRef.current?.lineMat;
    if (!three || !lineMat) return;
    const glow = beautify && style.mode !== 'light'; // additive blending washes out on a light surface
    lineMat.opacity = beautify ? Math.max(linkOpacity, 0.5) : linkOpacity;
    lineMat.blending = glow ? THREE.AdditiveBlending : THREE.NormalBlending;
    lineMat.needsUpdate = true;
    three.requestRender();
  }, [linkOpacity, beautify, data, style]);

  // Point size: rescale every instance around its stored base radius.
  useEffect(() => {
    nodeScaleRef.current = nodeScale;
    const three = threeRef.current;
    const objs = objsRef.current;
    if (!three || !objs?.nodeMesh) return;
    const nodes = nodesRef.current;
    const { nodeMesh, radii } = objs;
    const m4 = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const s = radii[i] * nodeScale;
      pos.set(n.x, n.y, n.z);
      scl.set(s, s, s);
      nodeMesh.setMatrixAt(i, m4.compose(pos, quat, scl));
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    three.requestRender();
  }, [nodeScale, data]);

  // Apply selection: move the highlight shell and label the selected node.
  useEffect(() => {
    const three = threeRef.current;
    const objs = objsRef.current;
    if (!three || !objs) return;
    const { highlight, labelGroup, labeled } = objs;

    if (selSpriteRef.current) {
      labelGroup.remove(selSpriteRef.current);
      disposeObject(selSpriteRef.current);
      selSpriteRef.current = null;
    }

    const node = selectedId != null ? byIdRef.current.get(selectedId) : null;
    if (node) {
      highlight.visible = true;
      highlight.position.set(node.x, node.y, node.z);
      highlight.scale.setScalar(nodeRadius(node) * nodeScaleRef.current + 3);
      if (node.label && !labeled.has(node.id)) {
        const sprite = makeLabelSprite(truncateLabel(node.label), style.label);
        sprite.userData.scale = Math.max(1, radiusRef.current / 450);
        sprite.scale.multiplyScalar(sprite.userData.scale);
        positionLabel(sprite, node);
        labelGroup.add(sprite);
        selSpriteRef.current = sprite;
      }
    } else {
      highlight.visible = false;
    }
    three.requestRender();
  }, [selectedId, data, style, colorFor]);

  // A newly selected node that sits outside the visible viewport (or under the
  // details panel's edge) is brought back in, the same as on a resize.
  useEffect(() => {
    if (selectedId == null) return;
    threeRef.current?.keepSelected?.();
  }, [selectedId, data]);

  useImperativeHandle(ref, () => ({
    // Default angle, zoom 1 = the whole layout framed (camera distance is fit to it).
    resetView: () => {
      rotRef.current = { yaw: 0.6, pitch: -0.35 };
      zoomRef.current = 1;
      panRef.current = { x: 0, y: 0 };
      glideRef.current = null;
      if (threeRef.current) threeRef.current.requestRender();
    }
  }), []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="graph-canvas absolute left-0 top-0"
        data-testid="graph3d"
        style={{ touchAction: 'none', userSelect: 'none' }}
        role="img"
        aria-label="3D node graph. Use the Tree view for a keyboard-accessible list."
      />
      {capped && (
        <div role="status" className="pointer-events-none absolute bottom-16 right-4 max-w-xs rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted shadow-overlay">
          Showing the first {MAX_3D_NODES.toLocaleString()} nodes. Use the 2D graph or the tree for the full set.
        </div>
      )}
    </div>
  );
});

export default ForceGraph3D;

// Deterministic 3D spherical-tree layout: nodes fill nested depth shells, each
// owning a solid-angle patch (φ×θ) split among its children — so children sit
// near their parent and the whole structure is legible from any rotation.
function sphericalTreeLayout(nodes, links) {
  const childrenOf = new Map();
  const hasParent = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const l of links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
    hasParent.add(l.target);
  }
  const R = 150;

  const place = (id, phi0, phi1, theta0, theta1, depth, splitPhi, guard) => {
    const n = byId.get(id);
    if (!n || guard.has(id)) return;
    guard.add(id);
    n.depth = depth;
    const phi = (phi0 + phi1) / 2;
    const theta = (theta0 + theta1) / 2;
    const radius = depth * R;
    const sinT = Math.sin(theta);
    n.x = radius * sinT * Math.cos(phi);
    n.y = radius * Math.cos(theta);
    n.z = radius * sinT * Math.sin(phi);

    const kids = childrenOf.get(id) || [];
    if (kids.length === 0) return;
    for (let i = 0; i < kids.length; i++) {
      const f0 = i / kids.length;
      const f1 = (i + 1) / kids.length;
      if (splitPhi) {
        place(kids[i], phi0 + (phi1 - phi0) * f0, phi0 + (phi1 - phi0) * f1, theta0, theta1, depth + 1, false, guard);
      } else {
        place(kids[i], phi0, phi1, theta0 + (theta1 - theta0) * f0, theta0 + (theta1 - theta0) * f1, depth + 1, true, guard);
      }
    }
  };

  const roots = nodes.filter((n) => !hasParent.has(n.id));
  const guard = new Set();
  for (let i = 0; i < roots.length; i++) {
    const f0 = i / roots.length;
    const f1 = (i + 1) / roots.length;
    // Root shell starts one level out so the root isn't at the exact origin
    place(roots[i].id, f0 * 2 * Math.PI, f1 * 2 * Math.PI, 0.15, Math.PI - 0.15, 1, true, guard);
  }
  // Place any orphans (cycles) at the origin shell
  for (const n of nodes) {
    if (n.x === undefined) {
      n.x = 0;
      n.y = 0;
      n.z = 0;
      n.depth = 0;
    }
  }
  let maxDepth = 0;
  for (const n of nodes) {
    if (n.depth > maxDepth) maxDepth = n.depth;
  }
  return maxDepth;
}
