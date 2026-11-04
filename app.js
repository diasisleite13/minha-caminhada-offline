const $ = id => document.getElementById(id);

const STORAGE_KEY = "minha-caminhada-historico-v2";

let map = null;
let route = null;
let marker = null;

let watchId = null;
let timer = null;

let points = [];
let distanceMeters = 0;

let startedAt = null;
let elapsedBeforePause = 0;

let running = false;
let paused = false;

let lastPoint = null;
let movementAnchor = null;
let movementSamples = [];

let deferredInstallPrompt = null;

/* CONFIGURAÇÕES GPS */

const GPS_CONFIG = {
  maxAccuracy: 20,
  minDistance: 10,
  minSpeed: 0.5,
  maxSpeed: 2.2,
  requiredSamples: 3,
  minConfirmationTime: 5,
  maxInterval: 20
};

/* HISTÓRICO */

function loadHistory() {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "[]"
    );
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(history)
  );
}

/* DISTÂNCIA */

function haversine(a, b) {
  const R = 6371000;

  const rad = value => value * Math.PI / 180;

  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lng - a.lng);

  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) *
    Math.cos(rad(b.lat)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(
    Math.sqrt(value)
  );
}

function formatDistance(meters) {
  if (meters < 1000) {
    return {
      value: Math.round(meters),
      unit: "m"
    };
  }

  return {
    value: (meters / 1000)
      .toFixed(2)
      .replace(".", ","),
    unit: "km"
  };
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  return [h, m, s]
    .map(n => String(n).padStart(2, "0"))
    .join(":");
}

/* CRONÔMETRO */

function getElapsed() {
  if (!startedAt || paused) {
    return elapsedBeforePause;
  }

  return elapsedBeforePause +
    Math.floor((Date.now() - startedAt) / 1000);
}

/* ESTATÍSTICAS */

function updateStats() {
  const formatted = formatDistance(distanceMeters);

  $("distance").textContent = formatted.value;
  $("distanceUnit").textContent = formatted.unit;

  const km = distanceMeters / 1000;
  const seconds = getElapsed();

  $("time").textContent = formatTime(seconds);

  const speed = seconds > 0
    ? km / (seconds / 3600)
    : 0;

  $("speed").textContent =
    speed.toFixed(1).replace(".", ",") + " km/h";

  if (distanceMeters >= 10 && km > 0) {
    const pace = Math.floor(seconds / km);

    $("pace").textContent =
      `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, "0")} /km`;
  } else {
    $("pace").textContent = "--:-- /km";
  }
}

/* MAPA */

function initMap() {
  if (!window.L) {
    $("mapNotice").textContent =
      "Mapa indisponível sem internet. O GPS continua funcionando.";
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
    weight: 5,
    lineJoin: "round"
  }).addTo(map);
}

function drawRoute() {
  if (!map || !route || points.length === 0) return;

  route.setLatLngs(
    points.map(p => [p.lat, p.lng])
  );

  if (points.length > 1) {
    map.fitBounds(route.getBounds(), {
      padding: [30, 30]
    });
  }
}

/* GPS */

function gpsError(error) {
  const messages = {
    1: "Permissão de localização negada.",
    2: "Sinal GPS indisponível.",
    3: "Tempo esgotado buscando GPS."
  };

  $("gpsStatus").textContent =
    messages[error.code] || "Erro no GPS";
}

function resetGPSFilter() {
  lastPoint = null;
  movementAnchor = null;
  movementSamples = [];
}

function startGPS() {
  if (!navigator.geolocation) {
    alert("Seu navegador não disponibiliza GPS.");
    return;
  }

  if (!window.isSecureContext) {
    alert("O GPS precisa de uma conexão HTTPS.");
    return;
  }

  stopGPS();

  $("gpsStatus").textContent = "Buscando GPS...";

  watchId = navigator.geolocation.watchPosition(
    addPosition,
    gpsError,
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    }
  );
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

/*
  FILTRO GPS

  Não registra uma posição isolada.

  Exige:
  - Precisão adequada.
  - Deslocamento mínimo.
  - Velocidade compatível com caminhada.
  - Três leituras consecutivas.
  - Confirmação ao longo do tempo.

  O objetivo é reduzir os falsos quilômetros
  causados pela oscilação do GPS parado.
*/

function addPosition(position) {
  if (!running || paused) return;

  const accuracy = position.coords.accuracy;

  if (
    !Number.isFinite(accuracy) ||
    accuracy > GPS_CONFIG.maxAccuracy
  ) {
    $("gpsStatus").textContent =
      "Aguardando GPS preciso...";
    return;
  }

  const current = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy,
    timestamp: position.timestamp
  };

  if (!movementAnchor) {
    movementAnchor = current;
    lastPoint = current;

    if (map) {
      map.setView(
        [current.lat, current.lng],
        17
      );

      if (marker) {
        map.removeLayer(marker);
      }

      marker = L.marker([
        current.lat,
        current.lng
      ]).addTo(map);
    }

    $("gpsStatus").textContent = "GPS conectado";
    return;
  }

  const delta = haversine(
    movementAnchor,
    current
  );

  const elapsed =
    (current.timestamp - movementAnchor.timestamp) / 1000;

  if (
    elapsed < 1 ||
    elapsed > GPS_CONFIG.maxInterval
  ) {
    resetGPSFilter();
    return;
  }

  const threshold = Math.max(
    GPS_CONFIG.minDistance,
    (accuracy + movementAnchor.accuracy) * 1.2
  );

  // Ainda não existe movimento suficiente.
  if (delta < threshold) {
    movementSamples = [];

    lastPoint = current;

    $("gpsStatus").textContent =
      "Aguardando movimento...";

    return;
  }

  const speed = delta / elapsed;

  if (
    speed < GPS_CONFIG.minSpeed ||
    speed > GPS_CONFIG.maxSpeed
  ) {
    movementSamples = [];

    $("gpsStatus").textContent =
      "Verificando deslocamento...";

    return;
  }

  movementSamples.push(current);

  if (
    movementSamples.length <
    GPS_CONFIG.requiredSamples
  ) {
    return;
  }

  const confirmed =
    movementSamples[movementSamples.length - 1];

  const totalDelta = haversine(
    movementAnchor,
    confirmed
  );

  const totalTime =
    (confirmed.timestamp - movementAnchor.timestamp) / 1000;

  const confirmedSpeed = totalDelta / totalTime;

  if (
    totalDelta < threshold ||
    totalTime < GPS_CONFIG.minConfirmationTime ||
    confirmedSpeed < GPS_CONFIG.minSpeed ||
    confirmedSpeed > GPS_CONFIG.maxSpeed
  ) {
    movementSamples = [];
    return;
  }

  // Movimento confirmado.
  distanceMeters += totalDelta;

  points.push(confirmed);

  movementAnchor = confirmed;
  lastPoint = confirmed;
  movementSamples = [];

  if (marker && map) {
    marker.setLatLng([
      confirmed.lat,
      confirmed.lng
    ]);
  }

  $("gpsStatus").textContent =
    "GPS conectado - movimento registrado";

  drawRoute();
  updateStats();
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

  if (!navigator.geolocation) {
    alert("Seu aparelho não possui suporte ao GPS.");
    return;
  }

  if (!window.isSecureContext) {
    alert("Abra o aplicativo pelo endereço HTTPS do GitHub Pages.");
    return;
  }

  points = [];
  distanceMeters = 0;
  elapsedBeforePause = 0;

  startedAt = Date.now();

  running = true;
  paused = false;

  resetGPSFilter();

  if (route) {
    route.setLatLngs([]);
  }

  if (marker && map) {
    map.removeLayer(marker);
  }

  marker = null;

  startGPS();

  clearInterval(timer);

  timer = setInterval(updateStats, 1000);

  setControls();
  updateStats();
}

function pauseWalk() {
  if (!running) return;

  if (!paused) {
    elapsedBeforePause = getElapsed();

    paused = true;

    stopGPS();
    resetGPSFilter();

    $("gpsStatus").textContent = "Caminhada pausada";

  } else {
    paused = false;
    startedAt = Date.now();

    resetGPSFilter();
    startGPS();
  }

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

  points = [];
  distanceMeters = 0;
  elapsedBeforePause = 0;
  startedAt = null;

  resetGPSFilter();

  if (route) {
    route.setLatLngs([]);
  }

  if (marker && map) {
    map.removeLayer(marker);
  }

  marker = null;

  $("gpsStatus").textContent = "GPS desligado";

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

  const formattedTotal = formatDistance(total);

  $("totalKm").textContent =
    formattedTotal.value + " " + formattedTotal.unit;

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

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* LOCALIZAÇÃO */

function locateUser() {
  if (!navigator.geolocation) {
    alert("GPS indisponível.");
    return;
  }

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
      maximumAge: 0,
      timeout: 20000
    }
  );
}

/* INSTALAÇÃO ANDROID */

const installButton = $("installBtn");
const installMessage = $("installMessage");

function updateInstallButton() {
  const installed =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  if (installed) {
    installButton.textContent =
      "✓ APLICATIVO INSTALADO";

    installButton.disabled = true;

    installMessage.textContent =
      "Você já está usando o aplicativo instalado.";
  }
}

window.addEventListener(
  "beforeinstallprompt",
  event => {
    event.preventDefault();

    deferredInstallPrompt = event;

    installButton.disabled = false;

    installMessage.textContent =
      "Aplicativo pronto para instalação.";
  }
);

installButton.addEventListener(
  "click",
  async () => {
    if (!deferredInstallPrompt) {
      installMessage.textContent =
        "Abra o menu do Chrome e escolha Adicionar à tela inicial ou Instalar aplicativo.";

      return;
    }

    deferredInstallPrompt.prompt();

    const result =
      await deferredInstallPrompt.userChoice;

    installMessage.textContent =
      result.outcome === "accepted"
        ? "Instalação solicitada!"
        : "Instalação cancelada.";

    deferredInstallPrompt = null;
  }
);

window.addEventListener("appinstalled", () => {
  updateInstallButton();

  installMessage.textContent =
    "Aplicativo instalado com sucesso!";
});

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

/* SERVICE WORKER */

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .catch(error => {
        console.error(
          "Erro no Service Worker:",
          error
        );
      });
  });
}
