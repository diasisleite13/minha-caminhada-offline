
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

function formatDistance(meters) {
  return meters < 1000
    ? { value: Math.round(meters), unit: "m" }
    : {
        value: (meters / 1000).toFixed(2).replace(".", ","),
        unit: "km"
      };
}

function getElapsed() {
  if (!startedAt || paused) return elapsedBeforePause;

  return elapsedBeforePause +
    Math.floor((Date.now() - startedAt) / 1000);
}

function updateStats() {
  const formatted = formatDistance(distanceMeters);

  $("distance").textContent = formatted.value;
  $("distance").nextElementSibling.textContent = formatted.unit;

  const km = distanceMeters / 1000;
  const seconds = getElapsed();

  $("time").textContent = formatTime(seconds);

  const speed = seconds > 0 ? km / (seconds / 3600) : 0;

  $("speed").textContent =
    speed.toFixed(1).replace(".", ",") + " km/h";

  const pace = km > 0 ? Math.floor(seconds / km) : 0;

  $("pace").textContent = km > 0
    ? `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, "0")} /km`
    : "--:-- /km";
}

/* MAPA */

function initMap() {
  if (!window.L) {
    $("mapNotice").textContent =
      "Mapa indisponível. GPS e histórico continuam disponíveis.";
    return;
  }

  map = L.map("map").setView([-5.8, -36.5], 6);

  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    }
  ).addTo(map);

  route = L.polyline([], {
    color: "#168653",
    weight: 5
  }).addTo(map);
}

function drawRoute() {
  if (!map || !route || !points.length) return;

  route.setLatLngs(points.map(p => [p.lat, p.lng]));

  if (points.length > 1) {
    map.fitBounds(route.getBounds(), {
      padding: [30, 30]
    });
  }
}

/* GPS COM PROTEÇÃO CONTRA SALTOS */

function addPosition(position) {
  if (!running || paused) return;

  const accuracy = position.coords.accuracy;

  if (!Number.isFinite(accuracy) || accuracy > 15) {
    $("gpsStatus").textContent = "GPS aguardando precisão";
    return;
  }

  const current = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy,
    timestamp: position.timestamp
  };

  // Primeira posição serve apenas como referência.
  if (!lastPoint) {
    lastPoint = current;
    points.push(current);

    if (map) {
      map.setView([current.lat, current.lng], 17);
      marker = L.marker([current.lat, current.lng]).addTo(map);
    }

    $("gpsStatus").textContent = "GPS conectado";
    $("gpsStatus").classList.add("active");

    saveActiveSession();
    return;
  }

  const delta = haversine(lastPoint, current);

  const elapsed =
    (current.timestamp - lastPoint.timestamp) / 1000;

  if (elapsed < 2) return;

  // Velocidade impossível para uma caminhada.
  const speed = delta / elapsed;

  if (speed > 2.5) {
    return;
  }

  // Considera a margem de erro dos dois sinais GPS.
  const minimumMovement = Math.max(
    6,
    (accuracy + lastPoint.accuracy) * 0.75
  );

  // Pequenas oscilações não são contabilizadas.
  if (delta < minimumMovement) {
    return;
  }

  if (delta > 15) {
    return;
  }

  distanceMeters += delta;

  lastPoint = current;
  points.push(current);

  if (marker && map) {
    marker.setLatLng([current.lat, current.lng]);
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
    return;
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
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  $("gpsStatus").textContent = "GPS pausado";
  $("gpsStatus").classList.remove("active");
}

/* SESSÃO */

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

function setControls() {
  $("startBtn").disabled = running;
  $("pauseBtn").disabled = !running;
  $("finishBtn").disabled = !running;

  $("pauseBtn").textContent =
    paused ? "▶ Continuar" : "Ⅱ Pausar";
}

function startWalk() {
  if (running) return;

  // Começa sempre uma sessão limpa.
  points = [];
  distanceMeters = 0;
  elapsedBeforePause = 0;
  lastPoint = null;
  startedAt = Date.now();

  paused = false;
  running = true;

  localStorage.removeItem(ACTIVE_KEY);

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

/* HISTÓRICO */

function renderHistory() {
  const history = loadHistory();

  $("totalWalks").textContent = history.length;

  const total = history.reduce(
    (sum, item) => sum + item.distance, 0
  );

  const formatted = formatDistance(total);

  $("totalKm").textContent =
    formatted.value + " " + formatted.unit;

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

    const d = formatDistance(item.distance);

    distance.className = "history-distance";
    distance.textContent = d.value + " " + d.unit;

    info.append(date, details);
    row.append(info, distance);
    container.append(row);
  });
}

/* EXPORTAÇÃO */

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

/* INSTALAÇÃO */

let deferredInstallPrompt = null;

const installButton = $("installBtn");
const installMessage = $("installMessage");

function updateInstallButton() {
  const installed =
    window.matchMedia("(display-mode: standalone)").matches;

  if (installed) {
    installButton.textContent = "✓ APLICATIVO INSTALADO";
    installButton.disabled = true;
    installMessage.textContent = "Aplicativo instalado!";
  }
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    installMessage.textContent =
      "Instalação não liberada pelo Chrome. Verifique o menu do navegador.";
    return;
  }

  deferredInstallPrompt.prompt();

  const result = await deferredInstallPrompt.userChoice;

  installMessage.textContent =
    result.outcome === "accepted"
      ? "Instalação solicitada!"
      : "Instalação cancelada.";

  deferredInstallPrompt = null;
});

window.addEventListener("appinstalled", updateInstallButton);

/* INICIALIZAÇÃO */

$("startBtn").addEventListener("click", startWalk);
$("pauseBtn").addEventListener("click", pauseWalk);
$("finishBtn").addEventListener("click", finishWalk);
$("exportBtn").addEventListener("click", exportData);
$("locateBtn").addEventListener("click", locateUser);

initMap();
renderHistory();
updateStats();
updateInstallButton();

// Não recupera sessões antigas com distâncias incorretas.
localStorage.removeItem(ACTIVE_KEY);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js")
    .catch(error => console.error(error));
}
