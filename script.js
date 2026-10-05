import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js";
import { FilesetResolver, HandLandmarker, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#sceneCanvas");
const video = $("#webcam");
const landmarkCanvas = $("#landmarkCanvas");
const landmarkContext = landmarkCanvas.getContext("2d");
const ui = {
  cameraButton: $("#cameraButton"),
  cameraButtonLabel: $("#cameraButtonLabel"),
  cameraHint: $("#cameraHint"),
  cameraPreview: $("#cameraPreview"),
  cameraPlaceholder: $("#cameraPlaceholder"),
  sceneStatus: $("#sceneStatus"),
  trackingStatus: $("#trackingStatus"),
  connectionPill: $("#connectionPill"),
  sceneLabel: $("#sceneCenterLabel"),
  sceneLoading: $("#sceneLoading"),
  effectName: $("#effectName"),
  state: $(".scene-state"),
  toast: $("#toast"),
  recordingBadge: $("#recordingBadge"),
  recordButton: $("#recordButton"),
  recordLabel: $("#recordLabel"),
};

const themes = {
  cyber: { accent: 0x70ddff, secondary: 0x517bff, background: 0x090e19 },
  gold: { accent: 0xffc86c, secondary: 0xff7e53, background: 0x17110b },
  "sci-fi": { accent: 0xc19aff, secondary: 0x61d6ff, background: 0x100c1d },
};
const gestures = {
  open: { title: "ГАЛАКТИКА", sound: 392 },
  heart: { title: "ЖАРКЫРАГАН ЖҮРӨК", sound: 523.25 },
  peace: { title: "I LOVE YOU", sound: 659.25 },
  point: { title: "ПЛАНЕТА", sound: 440 },
  fist: { title: "КАРА ТУҢГУЮК", sound: 164.81 },
  magic: { title: "СЫЙКЫРДУУ ФЕЙЕРВЕРК", sound: 783.99 },
};
const PARTICLE_COUNT = 3200;
const positions = new Float32Array(PARTICLE_COUNT * 3);
const targets = new Float32Array(PARTICLE_COUNT * 3);
const colors = new Float32Array(PARTICLE_COUNT * 3);
const seed = new Float32Array(PARTICLE_COUNT);
let renderer;
let scene;
let camera;
let points;
let geometry;
let material;
let trail;
let faceMask;
let blackHole;
let handLandmarker;
let faceLandmarker;
let cameraStream;
let recorder;
let recordedChunks = [];
let audioContext;
let audioEnabled = true;
let currentGesture = "";
let currentTheme = "cyber";
let trackingReady = false;
let forceRepel = false;
let faceVisible = false;
let lastVideoTime = -1;
let lastSoundAt = 0;
let lastFingerPoint = null;
let lastTrailAt = 0;
let toastTimeout;
let fireworksUntil = 0;
let fireworkOrigin = new THREE.Vector3();
const trailPoints = [];
const pointerWorld = new THREE.Vector3();
const tmpColor = new THREE.Color();

function createScene() {
  scene = new THREE.Scene();
  scene.background = null;
  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
  camera.position.set(0, 0, 11);
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const sizes = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    seed[i] = Math.random();
    sizes[i] = 1.2 + Math.random() * 2.8;
  }
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: { uPixelRatio: { value: renderer.getPixelRatio() }, uTime: { value: 0 } },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      uniform float uPixelRatio;
      uniform float uTime;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uPixelRatio * (34.0 / max(1.0, -mvPosition.z));
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        if (d > 0.5) discard;
        float glow = exp(-d * 9.0) * (1.0 - smoothstep(0.05, 0.5, d));
        gl_FragColor = vec4(vColor, glow);
      }
    `,
  });
  points = new THREE.Points(geometry, material);
  scene.add(points);

  const trailGeometry = new THREE.BufferGeometry();
  const trailPositions = new Float32Array(110 * 3);
  trailGeometry.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
  trailGeometry.setDrawRange(0, 0);
  const trailMaterial = new THREE.LineBasicMaterial({ color: themes[currentTheme].accent, transparent: true, opacity: 0.78 });
  trail = new THREE.Line(trailGeometry, trailMaterial);
  scene.add(trail);
  faceMask = createFaceMask();
  scene.add(faceMask);
  blackHole = createBlackHole();
  scene.add(blackHole);
  setTheme(currentTheme);
  setGesture("open", false);
  window.addEventListener("resize", resizeScene);
  resizeScene();
  animate();
  ui.sceneLoading.classList.add("hidden");
}

function createBlackHole() {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.48, 32, 24),
    new THREE.MeshBasicMaterial({ color: 0x010207 }),
  );
  group.add(core);
  const disk = new THREE.Mesh(
    new THREE.TorusGeometry(0.72, 0.075, 8, 72),
    new THREE.MeshBasicMaterial({
      color: themes[currentTheme].accent,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
    }),
  );
  disk.rotation.x = 1.12;
  group.add(disk);
  const outerDisk = new THREE.Mesh(
    new THREE.TorusGeometry(0.98, 0.018, 6, 72),
    new THREE.MeshBasicMaterial({
      color: themes[currentTheme].secondary,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
    }),
  );
  outerDisk.rotation.x = 1.12;
  group.add(outerDisk);
  group.visible = false;
  return group;
}

function createFaceMask() {
  const group = new THREE.Group();
  const neon = new THREE.MeshBasicMaterial({
    color: themes[currentTheme].accent,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
  });
  const ringGeometry = new THREE.TorusGeometry(0.23, 0.025, 8, 36);
  for (const x of [-0.26, 0.26]) {
    const lens = new THREE.Mesh(ringGeometry, neon);
    lens.position.set(x, 0, 0);
    group.add(lens);
  }
  const tube = (coordinates, radius = 0.018) => {
    const curve = new THREE.CatmullRomCurve3(coordinates.map(([x, y]) => new THREE.Vector3(x, y, 0)));
    return new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 6, false), neon);
  };
  group.add(tube([[-0.05, 0.02], [0, 0.08], [0.05, 0.02]]));
  group.add(tube([[-0.48, 0.02], [-0.58, 0.27], [-0.56, 0.65], [-0.4, 0.74], [-0.3, 0.36]]));
  group.add(tube([[0.3, 0.36], [0.4, 0.74], [0.56, 0.65], [0.58, 0.27], [0.48, 0.02]]));
  group.visible = false;
  return group;
}

function resizeScene() {
  if (!renderer) return;
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
}

function updateFaceMask(face, visible) {
  if (!faceMask) return;
  faceMask.visible = Boolean(face && visible);
  if (!faceMask.visible) return;
  const leftEye = face[33];
  const rightEye = face[263];
  const nose = face[1];
  const eyeWidth = distance2D(leftEye, rightEye) * 9.3;
  faceMask.position.set((0.5 - nose.x) * 9.3, (0.5 - nose.y) * 5.8, 0.9);
  faceMask.scale.setScalar(THREE.MathUtils.clamp(eyeWidth / 0.52, 0.65, 2.2));
  faceMask.rotation.z = Math.atan2(-(rightEye.y - leftEye.y), -(rightEye.x - leftEye.x));
}

function setTheme(theme) {
  currentTheme = theme;
  document.body.dataset.theme = theme;
  if (!scene) return;
  const palette = themes[theme];
  scene.background = null;
  if (trail) trail.material.color.setHex(palette.accent);
  if (faceMask) faceMask.traverse((child) => {
    if (child.isMesh) child.material.color.setHex(palette.accent);
  });
  if (blackHole) {
    blackHole.children[1].material.color.setHex(palette.accent);
    blackHole.children[2].material.color.setHex(palette.secondary);
  }
  updateColors();
}

function updateColors() {
  if (!geometry) return;
  const palette = themes[currentTheme];
  const colorA = new THREE.Color(currentGesture === "heart" ? 0xff315f : palette.accent);
  const colorB = new THREE.Color(currentGesture === "heart" ? 0xff9bcb : palette.secondary);
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const blend = seed[i];
    tmpColor.copy(colorA).lerp(colorB, blend * 0.72);
    const offset = i * 3;
    colors[offset] = tmpColor.r;
    colors[offset + 1] = tmpColor.g;
    colors[offset + 2] = tmpColor.b;
  }
  geometry.attributes.color.needsUpdate = true;
}

function heartPoint(index) {
  const angle = Math.random() * Math.PI * 2;
  const x = 16 * Math.pow(Math.sin(angle), 3);
  const y = 13 * Math.cos(angle) - 5 * Math.cos(2 * angle) - 2 * Math.cos(3 * angle) - Math.cos(4 * angle);
  const fill = Math.sqrt(Math.random());
  return [x * fill * 0.115, (y * fill - 1.8) * 0.115, (Math.random() - 0.5) * 0.48];
}

function textPoints() {
  const textCanvas = document.createElement("canvas");
  textCanvas.width = 440;
  textCanvas.height = 190;
  const ctx = textCanvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, 440, 190);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.font = "800 73px Arial, sans-serif";
  ctx.fillText("I LOVE", 220, 72);
  ctx.font = "800 81px Arial, sans-serif";
  ctx.fillText("YOU", 220, 151);
  const pixels = ctx.getImageData(0, 0, 440, 190).data;
  const available = [];
  for (let y = 0; y < 190; y += 2) {
    for (let x = 0; x < 440; x += 2) {
      if (pixels[(y * 440 + x) * 4 + 3] > 20) available.push([x, y]);
    }
  }
  return Array.from({ length: PARTICLE_COUNT }, () => {
    const [x, y] = available[Math.floor(Math.random() * available.length)];
    return [(x - 220) * 0.014, (94 - y) * 0.014, (Math.random() - 0.5) * 0.3];
  });
}

function buildTargets(gesture) {
  const phrasePoints = gesture === "peace" ? textPoints() : null;
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const index = i * 3;
    let x = 0;
    let y = 0;
    let z = 0;
    const random = seed[i];

    if (gesture === "heart") {
      [x, y, z] = heartPoint(i);
    } else if (gesture === "peace") {
      [x, y, z] = phrasePoints[i];
    } else if (gesture === "point") {
      const phi = Math.acos(2 * random - 1);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      x = 1.16 * Math.sin(phi) * Math.cos(theta);
      y = 1.16 * Math.cos(phi);
      z = 1.16 * Math.sin(phi) * Math.sin(theta);
      if (i % 17 === 0) {
        const angle = random * Math.PI * 2;
        x = Math.cos(angle) * (1.78 + Math.random() * 0.05);
        y = Math.sin(angle) * (0.54 + Math.random() * 0.08);
        z = Math.sin(angle * 2) * 0.18;
      }
    } else if (gesture === "fist") {
      const radius = Math.pow(random, 0.6) * 0.55;
      const angle = Math.random() * Math.PI * 2;
      const vertical = Math.random() * 2 - 1;
      x = radius * Math.sqrt(1 - vertical * vertical) * Math.cos(angle);
      y = radius * vertical;
      z = radius * Math.sqrt(1 - vertical * vertical) * Math.sin(angle);
    } else if (gesture === "magic" && performance.now() < fireworksUntil) {
      const direction = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const radius = Math.pow(Math.random(), 0.42) * (1.4 + Math.random() * 2);
      x = fireworkOrigin.x + direction.x * radius;
      y = fireworkOrigin.y + direction.y * radius;
      z = direction.z * radius;
    } else {
      const arm = i % 4;
      const radius = 0.25 + Math.pow(random, 0.74) * 4.25;
      const angle = (arm * Math.PI * 0.5) + radius * 1.35 + (Math.random() - 0.5) * 0.72;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius * 0.58;
      z = (Math.random() - 0.5) * (0.3 + radius * 0.24);
      if (random > 0.965) {
        x = (Math.random() - 0.5) * 10;
        y = (Math.random() - 0.5) * 6;
        z = (Math.random() - 0.5) * 3;
      }
    }
    targets[index] = x;
    targets[index + 1] = y;
    targets[index + 2] = z;
  }
  geometry.attributes.position.needsUpdate = true;
}

function setGesture(gesture, playSound = true) {
  if (!gestures[gesture] || gesture === currentGesture) return;
  currentGesture = gesture;
  buildTargets(gesture);
  updateColors();
  if (blackHole) blackHole.visible = gesture === "fist";
  ui.effectName.textContent = gestures[gesture].title;
  document.querySelectorAll(".gesture-row").forEach((row) => {
    row.classList.toggle("active", row.dataset.gesture === gesture);
  });
  if (gesture === "magic") {
    fireworksUntil = performance.now() + 1750;
    fireworkOrigin.copy(pointerWorld);
    buildTargets(gesture);
  }
  if (playSound) playNote(gestures[gesture].sound);
}

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now() * 0.001;
  material.uniforms.uTime.value = time;
  const current = geometry.attributes.position.array;
  const isBurst = currentGesture === "magic" && performance.now() < fireworksUntil;
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const offset = i * 3;
    let tx = targets[offset];
    let ty = targets[offset + 1];
    let tz = targets[offset + 2];
    if (currentGesture === "magic" && !isBurst) {
      tx = Math.cos(time + seed[i] * 12) * (1 + seed[i] * 2);
      ty = Math.sin(time * 1.3 + seed[i] * 15) * (0.7 + seed[i]);
      tz = Math.sin(time + seed[i] * 7) * 0.8;
    }
    if (trackingReady && currentGesture !== "fist" && !isBurst) {
      const dx = current[offset] - pointerWorld.x;
      const dy = current[offset + 1] - pointerWorld.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < 1.45) {
        const distance = Math.sqrt(distanceSq) + 0.001;
        const strength = (1.45 - distanceSq) * 0.32;
        const direction = forceRepel ? 1 : -1;
        tx += (dx / distance) * strength * direction;
        ty += (dy / distance) * strength * direction;
      }
    }
    const ease = currentGesture === "fist" ? 0.075 : isBurst ? 0.045 : 0.055;
    current[offset] += (tx - current[offset]) * ease;
    current[offset + 1] += (ty - current[offset + 1]) * ease;
    current[offset + 2] += (tz - current[offset + 2]) * ease;
  }
  geometry.attributes.position.needsUpdate = true;
  points.rotation.y = Math.sin(time * 0.15) * 0.16;
  points.rotation.x = Math.sin(time * 0.19) * 0.07;
  points.scale.setScalar(1 + Math.sin(time * 0.8) * 0.018);
  if (blackHole) {
    blackHole.rotation.y = time * 0.32;
    blackHole.rotation.z = Math.sin(time * 0.4) * 0.08;
    blackHole.scale.setScalar(1 + Math.sin(time * 1.6) * 0.035);
  }
  updateTrail();
  renderer.render(scene, camera);
}

function updateTrail() {
  const attribute = trail.geometry.attributes.position;
  const array = attribute.array;
  const visible = trailPoints.slice(-110);
  for (let i = 0; i < visible.length; i += 1) {
    array[i * 3] = visible[i].x;
    array[i * 3 + 1] = visible[i].y;
    array[i * 3 + 2] = visible[i].z;
  }
  trail.geometry.setDrawRange(0, visible.length);
  attribute.needsUpdate = true;
}

function playNote(frequency) {
  if (!audioEnabled || !audioContext) return;
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.045, now + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.36);
}

async function initializeTrackers() {
  ui.cameraHint.textContent = "AI моделдер жүктөлүүдө — биринчи жолу бир аз убакыт талап кылынышы мүмкүн.";
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const options = {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.5,
  };
  try {
    handLandmarker = await HandLandmarker.createFromOptions(vision, options);
  } catch (error) {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "CPU" },
    });
  }
  const faceOptions = {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  try {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, faceOptions);
  } catch (error) {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      ...faceOptions,
      baseOptions: { ...faceOptions.baseOptions, delegate: "CPU" },
    });
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Камера үчүн HTTPS же localhost керек. Сайтты localhost аркылуу ачыңыз.");
    ui.cameraHint.textContent = "Бул браузерде камера жок же коопсуз байланыш талап кылынат.";
    return;
  }
  ui.cameraButton.disabled = true;
  ui.cameraButtonLabel.textContent = "КАМЕРА КОШУЛУУДА…";
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = cameraStream;
    await video.play();
    ui.cameraPreview.classList.add("camera-on");
    video.classList.add("ready");
    landmarkCanvas.width = 640;
    landmarkCanvas.height = 360;
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    await initializeTrackers();
    trackingReady = true;
    ui.sceneLabel.classList.add("hidden");
    ui.sceneStatus.textContent = "КОЛДУ КӨРСӨТ";
    ui.state.classList.add("live");
    ui.trackingStatus.textContent = "AI TRACKING ON";
    ui.connectionPill.classList.add("online");
    ui.connectionPill.innerHTML = "<i></i> ONLINE";
    ui.cameraButtonLabel.textContent = "КАМЕРАНЫ ӨЧҮРҮҮ";
    ui.cameraButton.disabled = false;
    ui.cameraHint.textContent = "Колуңду камерага көрсөт. Манжаңдын учунда шлейф пайда болот.";
    requestAnimationFrame(detectFrame);
  } catch (error) {
    stopStream();
    ui.cameraButton.disabled = false;
    ui.cameraButtonLabel.textContent = "КАМЕРАНЫ ИШТЕТҮҮ";
    const message = error.name === "NotAllowedError"
      ? "Камерага уруксат берилген жок. Браузердин уруксаттарын текшериңиз."
      : error.name === "NotFoundError"
        ? "Камера табылган жок. Камераны туташтырып кайра аракет кылыңыз."
        : `Камера же AI моделин иштетүү мүмкүн болбоду: ${error.message}`;
    ui.cameraHint.textContent = message;
    ui.sceneStatus.textContent = "КАМЕРАГА ТУТАШУУ ЖОК";
    showToast(message);
  }
}

function stopStream() {
  trackingReady = false;
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  video.srcObject = null;
  video.classList.remove("ready");
  ui.cameraPreview.classList.remove("camera-on");
  landmarkContext.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height);
  if (handLandmarker) {
    handLandmarker.close();
    handLandmarker = null;
  }
  if (faceLandmarker) {
    faceLandmarker.close();
    faceLandmarker = null;
  }
  faceVisible = false;
  setGesture("open", false);
  ui.sceneLabel.classList.remove("hidden");
  ui.sceneStatus.textContent = "КАМЕРА КҮТҮЛҮҮДӨ";
  ui.state.classList.remove("live");
  ui.trackingStatus.textContent = "КАМЕРА КҮТҮЛҮҮДӨ";
  ui.connectionPill.classList.remove("online");
  ui.connectionPill.innerHTML = "<i></i> OFFLINE";
  ui.cameraButtonLabel.textContent = "КАМЕРАНЫ ИШТЕТҮҮ";
  ui.cameraHint.textContent = "Камерага уруксат бер. Жакшы жарыкта алаканыңды көрсөт.";
}

function detectFrame() {
  if (!trackingReady || video.readyState < 2) {
    if (trackingReady) requestAnimationFrame(detectFrame);
    return;
  }
  const now = performance.now();
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const handResult = handLandmarker.detectForVideo(video, now);
    const faceResult = faceLandmarker.detectForVideo(video, now);
    const landmarks = handResult.landmarks?.[0];
    const face = faceResult.faceLandmarks?.[0];
    drawLandmarks(landmarks, face);
    if (landmarks) {
      const normalized = landmarks[8];
      pointerWorld.set((0.5 - normalized.x) * 9.3, (0.5 - normalized.y) * 5.8, 0);
      detectTrail(landmarks[8], now);
      const gesture = classifyGesture(landmarks, face);
      setGesture(gesture);
      const closeToFace = face && distance2D(landmarks[0], face[1]) < 0.2;
      if (closeToFace !== faceVisible) {
        faceVisible = closeToFace;
        if (faceVisible) showToast("Неон маска активдүү ✨");
      }
      updateFaceMask(face, faceVisible);
      if (lastFingerPoint && distance2D(landmarks[8], lastFingerPoint) > 0.018 && now - lastSoundAt > 135) {
        playNote(330 + Math.min(500, distance2D(landmarks[8], lastFingerPoint) * 2400));
        lastSoundAt = now;
      }
      lastFingerPoint = { x: normalized.x, y: normalized.y };
      ui.sceneStatus.textContent = faceVisible ? "NEON FACE FILTER ON" : `${gestures[gesture].title} ACTIVE`;
      ui.sceneLabel.classList.add("hidden");
      ui.trackingStatus.textContent = "КОЛ ТАБЫЛДЫ";
    } else {
      lastFingerPoint = null;
      updateFaceMask(face, false);
      ui.sceneStatus.textContent = "КОЛУҢДУ КӨРСӨТ";
      ui.trackingStatus.textContent = face ? "БЕТ ТАБЫЛДЫ · КОЛ КҮТҮЛҮҮДӨ" : "КОЛ КҮТҮЛҮҮДӨ";
    }
  }
  requestAnimationFrame(detectFrame);
}

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function classifyGesture(hand, face) {
  const up = {
    index: hand[8].y < hand[6].y,
    middle: hand[12].y < hand[10].y,
    ring: hand[16].y < hand[14].y,
    pinky: hand[20].y < hand[18].y,
  };
  const thumbOpen = distance2D(hand[4], hand[5]) > 0.115;
  const pinch = distance2D(hand[4], hand[8]) < 0.075;
  const curled = !up.middle && !up.ring && !up.pinky;
  if (pinch && curled) return "heart";
  if (up.index && up.middle && !up.ring && !up.pinky) {
    const touchingFace = face && [hand[8], hand[12]].some((tip) =>
      [face[10], face[13]].some((feature) => distance2D(tip, feature) < 0.15),
    );
    return touchingFace ? "magic" : "peace";
  }
  if (up.index && !up.middle && !up.ring && !up.pinky) return "point";
  if (up.index && up.middle && up.ring && up.pinky && thumbOpen) return "open";
  if (!up.index && !up.middle && !up.ring && !up.pinky) return "fist";
  return currentGesture;
}

function drawLandmarks(hand, face) {
  const width = landmarkCanvas.width;
  const height = landmarkCanvas.height;
  landmarkContext.clearRect(0, 0, width, height);
  if (face && faceVisible) {
    const points = [face[10], face[33], face[263], face[152]];
    landmarkContext.strokeStyle = "rgba(112, 221, 255, .76)";
    landmarkContext.lineWidth = 2.5;
    landmarkContext.shadowColor = "#70ddff";
    landmarkContext.shadowBlur = 12;
    landmarkContext.beginPath();
    landmarkContext.ellipse(points[0].x * width, (points[0].y + points[3].y) * height * 0.5, Math.abs(points[2].x - points[1].x) * width * 0.62, Math.abs(points[3].y - points[0].y) * height * 0.59, 0, 0, Math.PI * 2);
    landmarkContext.stroke();
    landmarkContext.beginPath();
    landmarkContext.moveTo(points[1].x * width, points[1].y * height);
    landmarkContext.lineTo(points[2].x * width, points[2].y * height);
    landmarkContext.stroke();
    landmarkContext.shadowBlur = 0;
  }
  if (!hand) return;
  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15],
    [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];
  landmarkContext.strokeStyle = "rgba(112, 221, 255, .67)";
  landmarkContext.lineWidth = 1.6;
  landmarkContext.shadowColor = "#70ddff";
  landmarkContext.shadowBlur = 7;
  for (const [start, end] of connections) {
    landmarkContext.beginPath();
    landmarkContext.moveTo(hand[start].x * width, hand[start].y * height);
    landmarkContext.lineTo(hand[end].x * width, hand[end].y * height);
    landmarkContext.stroke();
  }
  landmarkContext.fillStyle = "#d5f8ff";
  for (const id of [4, 8, 12, 16, 20]) {
    landmarkContext.beginPath();
    landmarkContext.arc(hand[id].x * width, hand[id].y * height, 3.2, 0, Math.PI * 2);
    landmarkContext.fill();
  }
  landmarkContext.shadowBlur = 0;
}

function detectTrail(point, now) {
  if (now - lastTrailAt < 35) return;
  lastTrailAt = now;
  trailPoints.push(new THREE.Vector3((0.5 - point.x) * 9.3, (0.5 - point.y) * 5.8, 0.15));
  if (trailPoints.length > 110) trailPoints.shift();
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => ui.toast.classList.remove("visible"), 3100);
}

function saveScreenshot() {
  renderer.render(scene, camera);
  canvas.toBlob((blob) => {
    if (!blob) {
      showToast("PNG сүрөтүн түзүү мүмкүн болгон жок.");
      return;
    }
    downloadBlob(blob, `nebula-${Date.now()}.png`);
    showToast("PNG сүрөтү сакталды.");
  }, "image/png");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleRecording() {
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  if (!canvas.captureStream || !window.MediaRecorder) {
    showToast("Бул браузер экран жаздырууну колдобойт.");
    return;
  }
  const stream = canvas.captureStream(30);
  const mimeType = ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"]
    .find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    showToast("Бул браузерде видео формат табылган жок.");
    return;
  }
  recordedChunks = [];
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    showToast(`Видео жазууну баштоо мүмкүн болбоду: ${error.message}`);
    return;
  }
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) recordedChunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    const isMp4 = recorder.mimeType.includes("mp4");
    const blob = new Blob(recordedChunks, { type: recorder.mimeType });
    downloadBlob(blob, `nebula-${Date.now()}.${isMp4 ? "mp4" : "webm"}`);
    stream.getTracks().forEach((track) => track.stop());
    ui.recordingBadge.classList.remove("visible");
    ui.recordButton.classList.remove("recording");
    ui.recordLabel.textContent = "ЖАЗУУ";
    ui.recordButton.title = "Видео жазууну баштоо";
    showToast(isMp4 ? "MP4 видео сакталды." : "Бул браузер MP4 колдобойт — WEBM видео сакталды.");
  });
  recorder.start(250);
  ui.recordingBadge.classList.add("visible");
  ui.recordButton.classList.add("recording");
  ui.recordLabel.textContent = "ТОКТОТ";
  ui.recordButton.title = "Видео жазууну токтотуу";
  showToast("3D көрүнүш жазылып жатат.");
}

function bindEvents() {
  ui.cameraButton.addEventListener("click", () => {
    if (cameraStream) stopStream();
    else startCamera();
  });
  $("#screenshotButton").addEventListener("click", saveScreenshot);
  ui.recordButton.addEventListener("click", toggleRecording);
  $("#soundToggle").addEventListener("click", (event) => {
    audioEnabled = !audioEnabled;
    event.currentTarget.setAttribute("aria-pressed", String(audioEnabled));
    event.currentTarget.setAttribute("aria-label", audioEnabled ? "Үндү өчүрүү" : "Үндү күйгүзүү");
    if (audioEnabled && audioContext?.state === "suspended") audioContext.resume();
    showToast(audioEnabled ? "Синтезатор күйгүзүлдү." : "Үн өчүрүлдү.");
  });
  $("#forceToggle").addEventListener("click", (event) => {
    forceRepel = !forceRepel;
    event.currentTarget.setAttribute("aria-pressed", String(forceRepel));
    event.currentTarget.lastElementChild.textContent = forceRepel ? "МАНЖАДАН ТҮРТҮҮ" : "МАНЖАГА ТАРТУУ";
  });
  document.querySelectorAll(".theme-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".theme-button").forEach((item) => item.classList.toggle("selected", item === button));
      setTheme(button.dataset.theme);
    });
  });
  window.addEventListener("beforeunload", () => {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  });
}

createScene();
bindEvents();
