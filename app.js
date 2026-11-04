
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

/* FORMATAÇÃO AUTOMÁTICA DE METROS E KM */

function formatDistance(meters) {
  if (meters < 1000) {
    return {
      value: Math.round(meters).toString(),
      unit: "m"
    };
  }

  return {
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
  const distance = formatDistance(distanceMeters);

  $("distance").textContent = distance.value;
  $("distance").nextElementSibling.textContent = distance.unit;

  const km = distanceMeters / 1000;
  const seconds = getElapsed();

  $("time").textContent = formatTime(seconds);

  const speed = seconds > 0
    ? km / (seconds / 3600)
    : 0;

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

  route.setLatLngs(
    points.map(p => [p.lat, p.lng])
  );

  if (points.length > 1) {
    map.fitBounds(route.getBounds(), {
      padding: [30, 30]
    });
  }
}

/* GPS COM FILTRO DE MOVIMENTO */

function addPosition(position) {
  if (!running || paused) return;

  const accuracy = position.coords.accuracy;

  // Ignora posições com precisão muito baixa.
  if (accuracy > 20) return;

  const current = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy,
    timestamp: position.timestamp
  };

  if (lastPoint) {
    const delta = haversine(lastPoint, current);

    const elapsedSeconds =
      (current.timestamp - lastPoint.timestamp) / 1000;

    if (elapsedSeconds <= 0) return;

    // Ignora oscilações pequenas do GPS.
    if (delta < 3) return;

    // Ignora saltos impossíveis para uma caminhada.
    if (delta / elapsedSeconds > 3) return;

    // Evita saltos muito grandes.
    if (delta > 25) return;

    distanceMeters += delta;
  }

  points.push(current);
  lastPoint = current;

  if (map) {
    if (!marker) {
      marker = L.marker([
        current.lat,
        current.lng
      ]).addTo(map);
    } else {
      marker.setLatLng([
        current.lat,
        current.lng
      ]);
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
    alert("O GPS exige conexão HTTPS.");
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

/* CONTROLES */

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

  if (marker && map) {
    map.removeLayer(marker);
  }

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
    (sum, item) => sum + item.distance,
    0
  );

  const totalFormatted = formatDistance(total);

  $("totalKm").textContent =
    totalFormatted.value + " " + totalFormatted.unit;

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

    const formatted = formatDistance(item.distance);

    distance.className = "history-distance";
    distance.textContent =
      formatted.value + " " + formatted.unit;

    info.append(date, details);
    row.append(info, distance);
    container.append(row);
  });
}

/* EXPORTAR */

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

/* LOCALIZAÇÃO */

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
    {
      enableHighAccuracy: true,
      timeout: 20000
    }
  );
}

/* RECUPERAR CAMINHADA */

function restoreSession() {
  try {
    const session = JSON.parse(
      localStorage.getItem(ACTIVE_KEY)
    );

    if (!session) return;

    if (confirm(
      "Existe uma caminhada não finalizada. Deseja recuperá-la?"
    )) {
      points = session.points || [];
      distanceMeters = session.distanceMeters || 0;
      startedAt = session.startedAt;
      elapsedBeforePause = session.elapsedBeforePause || 0;

      paused = true;
      running = true;

      if (route) {
        route.setLatLngs(
          points.map(p => [p.lat, p.lng])
        );
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

/* INSTALAÇÃO */

let deferredInstallPrompt = null;

const installButton = $("installBtn");
const installMessage = $("installMessage");

function updateInstallButton() {
  const installed =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  if (installed) {
    installButton.textContent = "✓ APLICATIVO INSTALADO";
    installButton.disabled = true;
    installMessage.textContent =
      "Você já está usando o aplicativo instalado.";
  }
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    installMessage.textContent =
      "A instalação ainda não está disponível. " +
      "Use o menu do Chrome para verificar a opção Instalar aplicativo.";

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

window.addEventListener("appinstalled", () => {
  updateInstallButton();
  installMessage.textContent = "Aplicativo instalado!";
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
    .catch(error => console.error(error));
}
