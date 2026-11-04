
const $ = id => document.getElementById(id);

const STORAGE_KEY = "minha-caminhada-historico-v1";
const ACTIVE_KEY = "minha-caminhada-sessao-v1";

let map;
let route;
let marker;
let watchId = null;
let points = [];
let distanceMeters = 0;
let startedAt = null;
let elapsedBeforePause = 0;
let timer = null;
let running = false;
let paused = false;
let lastPoint = null;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

function saveActiveSession() {
  if (!startedAt) return;

  localStorage.setItem(ACTIVE_KEY, JSON.stringify({
    points,
    distanceMeters,
    startedAt,
    elapsedBeforePause,
    running,
    paused
  }));
}

function haversine(a, b) {
  const R = 6371000;
  const rad = x => x * Math.PI / 180;

  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lng - a.lng);

  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) *
    Math.cos(rad(b.lat)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(value));
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  return [h, m, s]
    .map(n => String(n).padStart(2, "0"))
    .join(":");
}

function getElapsed() {
  if (!startedAt || paused) return elapsedBeforePause;

  return elapsedBeforePause +
    Math.floor((Date.now() - startedAt) / 1000);
}

function updateStats() {
  const km = distanceMeters / 1000;
  const seconds = getElapsed();

  $("distance").textContent = km.toFixed(2).replace(".", ",");
  $("time").textContent = formatTime(seconds);

  const speed = seconds > 0 ? km / (seconds / 3600) : 0;

  $("speed").textContent =
    speed.toFixed(1).replace(".", ",") + " km/h";

  const pace = km > 0 ? Math.floor(seconds / km) : 0;

  $("pace").textContent = km > 0
    ? `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, "0")} /km`
    : "--:-- /km";
}

function initMap() {
  if (!window.L) {
    $("mapNotice").textContent =
      "Mapa indisponível. O GPS e o histórico continuam disponíveis.";
    return;
  }

  map = L.map("map").setView([-5.8, -36.5], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  }).addTo(map);

  route = L.polyline([], {
    color: "#168653",
    weight: 5
  }).addTo(map);
}

function drawRoute() {
  if (!map || !route || !points.length) return;

  route.setLatLngs(points.map(p => [p.lat, p.lng]));

  if (points.length > 1) {
    map.fitBounds(route.getBounds(), { padding: [30, 30] });
  }
}

function addPosition(position) {
  if (!running || paused) return;

  const accuracy = position.coords.accuracy;

  if (accuracy > 35) return;

  const current = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy,
    timestamp: position.timestamp
  };

  if (lastPoint) {
    const delta = haversine(lastPoint, current);

    if (delta < 3 || delta > 100) return;

    distanceMeters += delta;
  }

  points.push(current);
  lastPoint = current;

  if (map) {
    if (!marker) {
      marker = L.marker([current.lat, current.lng]).addTo(map);
    } else {
      marker.setLatLng([current.lat, current.lng]);
    }
  }

  $("gpsStatus").textContent = "GPS conectado";
  $("gpsStatus").classList.add("active");

  drawRoute();
  updateStats();
  saveActiveSession();
}

function gpsError(error) {
  const messages = {
    1: "Permissão de localização negada.",
    2: "Sinal GPS indisponível.",
    3: "Tempo esgotado ao buscar GPS."
  };

  $("gpsStatus").textContent =
    messages[error.code] || "Erro no GPS";

  $("gpsStatus").classList.remove("active");
}

function startGPS() {
  if (!navigator.geolocation) {
    alert("GPS não disponível neste navegador.");
    return false;
  }

  if (!window.isSecureContext) {
    alert("O GPS exige uma conexão HTTPS.");
    return false;
  }

  watchId = navigator.geolocation.watchPosition(
    addPosition,
    gpsError,
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    }
  );

  $("gpsStatus").textContent = "Buscando GPS...";
  return true;
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  $("gpsStatus").textContent = "GPS pausado";
  $("gpsStatus").classList.remove("active");
}

function setControls() {
  $("startBtn").disabled = running;
  $("pauseBtn").disabled = !running;
  $("finishBtn").disabled = !running;

  $("pauseBtn").textContent =
    paused ? "▶ Continuar" : "Ⅱ Pausar";
}

function startWalk() {
  if (running) return;

  points = [];
  distanceMeters = 0;
  elapsedBeforePause = 0;
  lastPoint = null;
  startedAt = Date.now();

  paused = false;
  running = true;

  if (route) route.setLatLngs([]);

  if (marker && map) map.removeLayer(marker);
  marker = null;

  startGPS();

  timer = setInterval(updateStats, 1000);

  setControls();
  updateStats();
  saveActiveSession();
}

function pauseWalk() {
  if (!running) return;

  if (!paused) {
    elapsedBeforePause = getElapsed();
    paused = true;
    stopGPS();
  } else {
    paused = false;
    startedAt = Date.now();
    startGPS();
  }

  saveActiveSession();
  setControls();
  updateStats();
}

function finishWalk() {
  if (!running) return;

  const elapsed = getElapsed();

  running = false;
  paused = false;

  stopGPS();
  clearInterval(timer);
  timer = null;

  const record = {
    id: Date.now(),
    date: new Date().toISOString(),
    distance: distanceMeters,
    duration: elapsed,
    points: [...points]
  };

  if (record.distance >= 5) {
    const history = loadHistory();
    history.unshift(record);
    saveHistory(history);
  }

  localStorage.removeItem(ACTIVE_KEY);

  points = [];
  distanceMeters = 0;
  elapsedBeforePause = 0;
  startedAt = null;
  lastPoint = null;

  setControls();
  updateStats();
  renderHistory();

  alert(
    record.distance >= 5
      ? "Caminhada salva com sucesso!"
      : "Caminhada muito curta para ser salva."
  );
}

function renderHistory() {
  const history = loadHistory();

  $("totalWalks").textContent = history.length;

  const total = history.reduce(
    (sum, item) => sum + item.distance, 0
  );

  $("totalKm").textContent =
    (total / 1000).toFixed(2).replace(".", ",") + " km";

  const container = $("history");

  if (!history.length) {
    container.innerHTML =
      '<p class="empty">Suas caminhadas aparecerão aqui.</p>';
    return;
  }

  container.replaceChildren();

  history.forEach(item => {
    const row = document.createElement("div");
    row.className = "history-item";

    const info = document.createElement("div");
    const date = document.createElement("strong");
    const details = document.createElement("small");
    const distance = document.createElement("span");

    date.textContent =
      new Date(item.date).toLocaleDateString("pt-BR");

    details.textContent =
      "Tempo: " + formatTime(item.duration);

    distance.className = "history-distance";
    distance.textContent =
      (item.distance / 1000).toFixed(2).replace(".", ",") + " km";

    info.append(date, details);
    row.append(info, distance);
    container.append(row);
  });
}

function exportData() {
  const blob = new Blob(
    [JSON.stringify(loadHistory(), null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "minhas-caminhadas.json";
  link.click();

  URL.revokeObjectURL(url);
}

function locateUser() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    position => {
      if (map) {
        map.setView([
          position.coords.latitude,
          position.coords.longitude
        ], 17);
      }
    },
    gpsError,
    { enableHighAccuracy: true, timeout: 20000 }
  );
}

function restoreSession() {
  try {
    const session = JSON.parse(localStorage.getItem(ACTIVE_KEY));

    if (!session) return;

    if (confirm("Existe uma caminhada não finalizada. Deseja recuperá-la?")) {
      points = session.points || [];
      distanceMeters = session.distanceMeters || 0;
      startedAt = session.startedAt;
      elapsedBeforePause = session.elapsedBeforePause || 0;

      paused = true;
      running = true;

      if (route) {
        route.setLatLngs(points.map(p => [p.lat, p.lng]));
      }

      setControls();
      updateStats();
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  } catch {
    localStorage.removeItem(ACTIVE_KEY);
  }
}

/* INSTALAÇÃO PWA */

let deferredInstallPrompt = null;

const installButton = $("installBtn");
const installMessage = $("installMessage");

function isInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
}

function updateInstallButton() {
  if (isInstalled()) {
    installButton.textContent = "✓ APLICATIVO INSTALADO";
    installButton.disabled = true;
    installMessage.textContent =
      "Você já está usando o aplicativo instalado.";
  }
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;

  installButton.textContent = "📲 INSTALAR APLICATIVO";
  installMessage.textContent = "Toque para instalar no seu Android.";
});

installButton.addEventListener("click", async () => {
  if (isInstalled()) {
    installMessage.textContent = "O aplicativo já está instalado.";
    return;
  }

  if (!deferredInstallPrompt) {
    installMessage.textContent =
      "O Chrome ainda não liberou a instalação. " +
      "Verifique se o site está em HTTPS e se o manifesto e o Service Worker foram carregados. " +
      "Você também pode usar Adicionar à tela inicial no menu do Chrome.";

    return;
  }

  deferredInstallPrompt.prompt();

  const result = await deferredInstallPrompt.userChoice;

  if (result.outcome === "accepted") {
    installMessage.textContent = "Instalação solicitada.";
  } else {
    installMessage.textContent = "Instalação cancelada.";
  }

  deferredInstallPrompt = null;
});

window.addEventListener("appinstalled", () => {
  updateInstallButton();
  installMessage.textContent = "Aplicativo instalado com sucesso!";
});

$("startBtn").addEventListener("click", startWalk);
$("pauseBtn").addEventListener("click", pauseWalk);
$("finishBtn").addEventListener("click", finishWalk);
$("exportBtn").addEventListener("click", exportData);
$("locateBtn").addEventListener("click", locateUser);

initMap();
renderHistory();
restoreSession();
updateInstallButton();

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js")
    .catch(error => console.error("Service Worker:", error));
}
