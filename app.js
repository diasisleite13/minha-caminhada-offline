
const $ = id => document.getElementById(id);

// HISTÓRICO
const STORAGE_KEY = "minha-caminhada-historico-v2";
const LEGACY_KEY = "minha-caminhada-historico-v1";

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

let deferredInstallPrompt = null;

// CONFIGURAÇÕES GPS
const GPS_CONFIG = {
  maxAccuracy: 50,
  minDistance: 4,
  maxDistanceThreshold: 8,
  minSpeed: 0.35,
  maxSpeed: 3.2,
  maxInterval: 30
};

/* HISTÓRICO */

function readStorage(key) {
  try {
    const data = JSON.parse(
      localStorage.getItem(key) || "[]"
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function loadHistory() {
  const current = readStorage(STORAGE_KEY);
  const legacy = readStorage(LEGACY_KEY);

  const unique = new Map();

  [...legacy, ...current].forEach(item => {
    if (!item || typeof item !== "object") return;

    const key = item.id ??
      `${item.date}-${item.distance}-${item.duration}`;

    unique.set(String(key), item);
  });

  return [...unique.values()].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );
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

/* ESTATÍSTICAS DA CAMINHADA */

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

/* PAINEL DE DESEMPENHO */

function updatePerformance() {
  const history = loadHistory();

  const totalDistance = history.reduce(
    (sum, item) =>
      sum + Math.max(0, Number(item.distance) || 0),
    0
  );

  const totalTime = history.reduce(
    (sum, item) =>
      sum + Math.max(0, Number(item.duration) || 0),
    0
  );

  const totalKm = totalDistance / 1000;

  const averageSpeed = totalTime > 0
    ? totalKm / (totalTime / 3600)
    : 0;

  const record = history.reduce(
    (best, item) => {
      const distance = Number(item.distance) || 0;

      return distance > (Number(best?.distance) || 0)
        ? item
        : best;
    },
    null
  );

  const recordDistance = record
    ? Math.max(0, Number(record.distance) || 0) / 1000
    : 0;

  $("performanceDistance").textContent =
    totalKm.toFixed(2).replace(".", ",") + " km";

  $("performanceTime").textContent =
    formatTime(totalTime);

  $("performanceSpeed").textContent =
    averageSpeed.toFixed(1).replace(".", ",") + " km/h";

  $("performanceRecord").textContent =
    recordDistance.toFixed(2).replace(".", ",") + " km";

  $("performanceRecordDate").textContent =
    record
      ? "Conquistado em " +
        new Date(record.date).toLocaleDateString("pt-BR")
      : "Nenhuma caminhada registrada";
}

/* MAPA */

function initMap() {
  if (!window.L) {
    $("mapNotice").textContent =
      "Mapa indisponível. GPS e histórico continuam funcionando.";
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
    points.map(point => [
      point.lat,
      point.lng
    ])
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
}

/*
  ATUALIZAÇÃO VISUAL DO GPS

  O marcador acompanha a localização recebida.
  Mesmo quando não existe deslocamento suficiente
  para somar quilômetros, ele continua atualizado.
*/

function updateGPSMarker(current) {
  if (!map || !window.L) return;

  const position = [
    current.lat,
    current.lng
  ];

  if (!marker) {
    marker = L.marker(position).addTo(map);
  } else {
    marker.setLatLng(position);
  }

  if (!map.getBounds().contains(position)) {
    map.panTo(position);
  }
}

/*
  INICIAR LEITURA GPS
*/

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
      timeout: 30000
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
  RECEBER POSIÇÃO GPS

  1. Atualiza o marcador.
  2. Verifica a precisão.
  3. Confirma deslocamento.
  4. Calcula a distância.
  5. Atualiza o percurso.
*/

function addPosition(position) {
  if (!running || paused) return;

  const accuracy = position.coords.accuracy;

  const current = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy,
    timestamp: position.timestamp
  };

  // Primeiro atualiza o marcador visual.
  updateGPSMarker(current);

  $("gpsStatus").textContent = "GPS conectado";

  // Não soma posição sem precisão mínima.
  if (
    !Number.isFinite(accuracy) ||
    accuracy > GPS_CONFIG.maxAccuracy
  ) {
    $("gpsStatus").textContent =
      "GPS conectado - aguardando precisão";

    return;
  }

  // Primeira posição serve como referência.
  if (!movementAnchor) {
    movementAnchor = current;
    lastPoint = current;

    return;
  }

  const elapsed =
    (current.timestamp - movementAnchor.timestamp) / 1000;

  // Evita leituras repetidas ou muito antigas.
  if (elapsed <= 0) return;

  if (elapsed > GPS_CONFIG.maxInterval) {
    movementAnchor = current;
    lastPoint = current;
    return;
  }

  const delta = haversine(
    movementAnchor,
    current
  );

  /*
    O limite não cresce exageradamente com a
    precisão informada pelo aparelho.
  */

  const threshold = Math.max(
    GPS_CONFIG.minDistance,
    Math.min(
      GPS_CONFIG.maxDistanceThreshold,
      (accuracy + movementAnchor.accuracy) * 0.2
    )
  );

  // Pequenos movimentos e oscilações não contam.
  // Mantém a referência anterior para acumular
  // o deslocamento real ao longo das leituras.
  if (delta < threshold) {
    return;
  }

  const speed = delta / elapsed;

  // Rejeita saltos GPS e movimentos incompatíveis.
  if (
    speed < GPS_CONFIG.minSpeed ||
    speed > GPS_CONFIG.maxSpeed
  ) {
    movementAnchor = current;
    lastPoint = current;
    return;
  }

  // Movimento confirmado.
  distanceMeters += delta;

  points.push(current);

  movementAnchor = current;
  lastPoint = current;

  $("gpsStatus").textContent = "GPS conectado";

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

    $("gpsStatus").textContent =
      "Caminhada pausada";

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
    (sum, item) =>
      sum + (Number(item.distance) || 0),
    0
  );

  const formattedTotal = formatDistance(total);

  $("totalKm").textContent =
    formattedTotal.value + " " + formattedTotal.unit;

  const container = $("history");

  if (!history.length) {
    container.innerHTML =
      '<p class="empty">Suas caminhadas aparecerão aqui.</p>';

    updatePerformance();
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
      "Tempo: " + formatTime(
        Number(item.duration) || 0
      );

    const formatted = formatDistance(
      Number(item.distance) || 0
    );

    distance.className = "history-distance";

    distance.textContent =
      formatted.value + " " + formatted.unit;

    info.append(date, details);
    row.append(info, distance);

    container.append(row);
  });

  updatePerformance();
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

  document.body.appendChild(link);

  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/* LOCALIZAÇÃO */

function locateUser() {
  if (!navigator.geolocation) {
    alert("GPS indisponível.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    position => {
      const current = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };

      if (map) {
        map.setView([
          current.lat,
          current.lng
        ], 17);

        updateGPSMarker(current);
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
updatePerformance();
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
