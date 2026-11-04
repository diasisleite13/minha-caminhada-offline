const $ = id => document.getElementById(id);
const STORAGE_KEY = "minha-caminhada-historico-v2";
const LEGACY_KEY = "minha-caminhada-historico-v1";
const ACTIVE_KEY = "minha-caminhada-sessao-v1";
const DB_NAME = "minha-caminhada-dados-v2";
const DB_VERSION = 1;
const GPS_CONFIG = { maxAccuracy: 50, minDistance: 3, maxDistanceThreshold: 8, maxSpeed: 8, maxInterval: 120 };

let map = null, route = null, marker = null, onlineLayer = null, offlineLayer = null;
let watchId = null, timer = null, points = [], distanceMeters = 0;
let startedAt = null, elapsedBeforePause = 0, running = false, paused = false;
let movementAnchor = null, deferredInstallPrompt = null, dbPromise = null;
let sessionSaveQueue = Promise.resolve();

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("data")) db.createObjectStore("data");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function dbGet(key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction("data", "readonly").objectStore("data").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function dbSet(key, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction("data", "readwrite");
    tx.objectStore("data").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function dbDelete(key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction("data", "readwrite");
    tx.objectStore("data").delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function readStorage(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key) || "[]");
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
    const key = item.id ?? `${item.date}-${item.distance}-${item.duration}`;
    unique.set(String(key), item);
  });

  return [...unique.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function saveHistory(history) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch (error) {
    alert("Não foi possível salvar o histórico. Exporte os dados e libere espaço no aparelho.");
    throw error;
  }
}

function haversine(a, b) {
  const R = 6371000;
  const rad = v => v * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lng - a.lng);
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(value));
}

function formatDistance(meters) {
  return meters < 1000
    ? { value: Math.round(meters), unit: "m" }
    : { value: (meters / 1000).toFixed(2).replace(".", ","), unit: "km" };
}

function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
}

function getElapsed() {
  if (!startedAt || paused) return elapsedBeforePause;
  return elapsedBeforePause + Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function updateStats() {
  const formatted = formatDistance(distanceMeters);
  const km = distanceMeters / 1000;
  const seconds = getElapsed();

  $("distance").textContent = formatted.value;
  $("distanceUnit").textContent = formatted.unit;
  $("time").textContent = formatTime(seconds);

  const speed = seconds > 0 ? km / (seconds / 3600) : 0;
  $("speed").textContent = speed.toFixed(1).replace(".", ",") + " km/h";

  if (distanceMeters >= 10 && km > 0) {
    const pace = Math.floor(seconds / km);
    $("pace").textContent = `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, "0")} /km`;
  } else {
    $("pace").textContent = "--:-- /km";
  }
}

function updatePerformance() {
  const history = loadHistory();

  const totalDistance = history.reduce(
    (s, i) => s + Math.max(0, Number(i.distance) || 0), 0
  );

  const totalTime = history.reduce(
    (s, i) => s + Math.max(0, Number(i.duration) || 0), 0
  );

  const totalKm = totalDistance / 1000;
  const averageSpeed = totalTime > 0 ? totalKm / (totalTime / 3600) : 0;

  const record = history.reduce(
    (best, item) => (Number(item.distance) || 0) > (Number(best?.distance) || 0) ? item : best,
    null
  );

  $("performanceDistance").textContent = totalKm.toFixed(2).replace(".", ",") + " km";
  $("performanceTime").textContent = formatTime(totalTime);
  $("performanceSpeed").textContent = averageSpeed.toFixed(1).replace(".", ",") + " km/h";
  $("performanceRecord").textContent =
    (record ? Number(record.distance) / 1000 : 0).toFixed(2).replace(".", ",") + " km";

  $("performanceRecordDate").textContent = record
    ? "Conquistado em " + new Date(record.date).toLocaleDateString("pt-BR")
    : "Nenhuma caminhada registrada";
}

function setMapNotice(message) {
  $("mapNotice").textContent = message;
}

function initMap() {
  if (!window.L) {
    setMapNotice("Biblioteca do mapa indisponível. Conecte-se à internet uma vez para carregar os arquivos do aplicativo.");
    return;
  }

  map = L.map("map").setView([-5.8, -36.5], 6);

  onlineLayer = L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      maxZoom: 19
    }
  );

  onlineLayer.addTo(map);

  route = L.polyline([], {
    color: "#168653",
    weight: 5,
    opacity: .9,
    lineJoin: "round"
  }).addTo(map);

  setTimeout(() => map.invalidateSize(), 300);
  loadOfflineMap();
}

function drawRoute() {
  if (!map || !route || !points.length) return;
  route.setLatLngs(points.map(p => [p.lat, p.lng]));
  // Não reajusta o zoom a cada ponto: evita tremedeira e consumo desnecessário.
}

function updateGPSMarker(current) {
  if (!map || !window.L) return;

  const pos = [current.lat, current.lng];

  if (!marker) {
    marker = L.marker(pos).addTo(map);
  } else {
    marker.setLatLng(pos);
  }

  if (!map.getBounds().contains(pos)) {
    map.panTo(pos, { animate: false });
  }
}

function gpsError(error) {
  const messages = {
    1: "Permissão de localização negada. Autorize o GPS nas configurações do navegador.",
    2: "Sinal GPS indisponível. Vá para um local aberto.",
    3: "Tempo esgotado buscando GPS. Continuando a tentar."
  };

  $("gpsStatus").textContent = messages[error.code] || "Erro no GPS";
}

function resetGPSFilter() {
  movementAnchor = null;
}

function startGPS() {
  if (!navigator.geolocation) {
    alert("Seu navegador não disponibiliza GPS.");
    return;
  }

  if (!window.isSecureContext) {
    alert("O GPS precisa de HTTPS ou localhost.");
    return;
  }

  stopGPS();
  $("gpsStatus").textContent = "Buscando GPS...";

  watchId = navigator.geolocation.watchPosition(
    addPosition,
    gpsError,
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
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

function addPosition(position) {
  if (!running || paused) return;

  const accuracy = position.coords.accuracy;

  const current = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy,
    timestamp: position.timestamp || Date.now()
  };

  if (
    !Number.isFinite(current.lat) ||
    !Number.isFinite(current.lng) ||
    !Number.isFinite(accuracy) ||
    accuracy < 0 ||
    Math.abs(current.lat) > 90 ||
    Math.abs(current.lng) > 180
  ) return;

  updateGPSMarker(current);

  if (accuracy > GPS_CONFIG.maxAccuracy) {
    $("gpsStatus").textContent = "GPS conectado - aguardando precisão";
    return;
  }

  $("gpsStatus").textContent = "GPS conectado";

  if (!movementAnchor) {
    movementAnchor = current;
    points.push(current);
    drawRoute();
    saveActiveSession();
    return;
  }

  const elapsed = (current.timestamp - movementAnchor.timestamp) / 1000;

  if (elapsed <= 0) return;

  if (elapsed > GPS_CONFIG.maxInterval) {
    movementAnchor = current;
    return;
  }

  const delta = haversine(movementAnchor, current);

  const threshold = Math.max(
    GPS_CONFIG.minDistance,
    Math.min(
      GPS_CONFIG.maxDistanceThreshold,
      (accuracy + movementAnchor.accuracy) * 0.15
    )
  );

  if (delta < threshold) return;

  const speed = delta / elapsed;

  if (speed > GPS_CONFIG.maxSpeed) {
    movementAnchor = current;
    return;
  }

  distanceMeters += delta;
  movementAnchor = current;
  points.push(current);

  drawRoute();
  updateStats();
  saveActiveSession();
}

function saveActiveSession() {
  if (!running) return Promise.resolve();

  const session = {
    points: points.map(point => ({ ...point })),
    distanceMeters,
    startedAt,
    elapsedBeforePause,
    paused,
    updatedAt: Date.now()
  };

  // Serializa as gravações para evitar que uma gravação antiga termine depois da mais recente.
  sessionSaveQueue = sessionSaveQueue
    .then(() => dbSet("active-session", session))
    .catch(error => {
      console.error("Erro ao salvar sessão:", error);
    });

  return sessionSaveQueue;
}

function setControls() {
  $("startBtn").disabled = running;
  $("pauseBtn").disabled = !running;
  $("finishBtn").disabled = !running;
  $("pauseBtn").textContent = paused ? "▶ Continuar" : "Ⅱ Pausar";
}

function startWalk() {
  if (running) return;

  if (!navigator.geolocation) {
    alert("Seu aparelho não possui suporte ao GPS.");
    return;
  }

  if (!window.isSecureContext) {
    alert("Abra o aplicativo pelo endereço HTTPS.");
    return;
  }

  points = [];
  distanceMeters = 0;
  elapsedBeforePause = 0;
  startedAt = Date.now();
  running = true;
  paused = false;
  resetGPSFilter();

  if (route) route.setLatLngs([]);
  if (marker && map) map.removeLayer(marker);
  marker = null;
  if (map) map.invalidateSize();

  startGPS();

  clearInterval(timer);
  timer = setInterval(updateStats, 1000);

  setControls();
  updateStats();
  saveActiveSession();

  setMapNotice("Caminhada em andamento. O GPS pode ser afetado pelas regras de economia de bateria do Android.");
}

function pauseWalk() {
  if (!running) return;

  if (!paused) {
    elapsedBeforePause = getElapsed();
    startedAt = null;
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
  saveActiveSession();
}

async function finishWalk() {
  if (!running) return;

  const elapsed = getElapsed();

  const record = {
    id: Date.now(),
    date: new Date().toISOString(),
    distance: distanceMeters,
    duration: elapsed,
    points: points.map(point => ({ ...point }))
  };

  running = false;
  paused = false;
  stopGPS();
  clearInterval(timer);
  timer = null;

  let saved = false;

  try {
    if (record.distance >= 5) {
      const history = loadHistory();
      history.unshift(record);
      saveHistory(history);
      saved = true;
    }

    await sessionSaveQueue;
    await dbDelete("active-session");
    localStorage.removeItem(ACTIVE_KEY);
  } catch (error) {
    console.error("Não foi possível concluir o salvamento:", error);
    alert("A caminhada foi encerrada, mas não foi possível salvar o histórico. Verifique o espaço disponível no aparelho e exporte os dados existentes.");
  }

  points = [];
  distanceMeters = 0;
  elapsedBeforePause = 0;
  startedAt = null;
  resetGPSFilter();

  if (route) route.setLatLngs([]);
  if (marker && map) map.removeLayer(marker);
  marker = null;

  $("gpsStatus").textContent = "GPS desligado";
  setControls();
  updateStats();
  renderHistory();

  if (saved) {
    alert("Caminhada salva com sucesso!");
  } else if (record.distance < 5) {
    alert("Caminhada muito curta para ser salva.");
  }
}

function renderHistory() {
  const history = loadHistory();

  $("totalWalks").textContent = history.length;

  const total = history.reduce(
    (s, i) => s + (Number(i.distance) || 0), 0
  );

  const formattedTotal = formatDistance(total);
  $("totalKm").textContent = formattedTotal.value + " " + formattedTotal.unit;

  const container = $("history");

  if (!history.length) {
    container.innerHTML = '<p class="empty">Suas caminhadas aparecerão aqui.</p>';
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

    date.textContent = new Date(item.date).toLocaleDateString("pt-BR");
    details.textContent = "Tempo: " + formatTime(Number(item.duration) || 0);

    const formatted = formatDistance(Number(item.distance) || 0);
    distance.className = "history-distance";
    distance.textContent = formatted.value + " " + formatted.unit;

    info.append(date, details);
    row.append(info, distance);
    container.append(row);
  });

  updatePerformance();
}

async function clearAllRecords() {
  const message = "Deseja excluir DEFINITIVAMENTE todas as caminhadas salvas e qualquer sessão não finalizada? O mapa offline instalado será mantido.";

  if (!confirm(message)) return;

  const button = $("clearRecordsBtn");
  button.disabled = true;

  try {
    // Interrompe também uma caminhada em andamento para que ela não seja gravada novamente.
    running = false;
    paused = false;
    stopGPS();
    clearInterval(timer);
    timer = null;

    await sessionSaveQueue;
    await dbDelete("active-session");

    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(ACTIVE_KEY);

    points = [];
    distanceMeters = 0;
    elapsedBeforePause = 0;
    startedAt = null;
    resetGPSFilter();

    if (route) route.setLatLngs([]);
    if (marker && map) map.removeLayer(marker);
    marker = null;

    $("gpsStatus").textContent = "GPS desligado";

    setControls();
    updateStats();
    renderHistory();

    alert("Todos os registros de caminhada foram excluídos. O mapa offline foi preservado.");
  } catch (error) {
    console.error("Erro ao excluir registros:", error);
    alert("Não foi possível excluir todos os registros. Tente novamente.");
  } finally {
    button.disabled = false;
  }
}

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    walks: loadHistory()
  };

  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
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
        map.setView([current.lat, current.lng], 17);
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

async function restoreActiveSession() {
  try {
    let session = await dbGet("active-session");

    if (!session) {
      const legacy = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "null");
      if (legacy) session = legacy;
    }

    if (!session || !Array.isArray(session.points)) return;

    const recover = confirm("Existe uma caminhada não finalizada. Deseja recuperar?");

    if (!recover) {
      await dbDelete("active-session");
      localStorage.removeItem(ACTIVE_KEY);
      return;
    }

    points = session.points;
    distanceMeters = Number(session.distanceMeters) || 0;
    elapsedBeforePause = Number(session.elapsedBeforePause) || 0;

    // Corrige o tempo perdido quando o aplicativo foi fechado ou suspenso durante a caminhada.
    if (!session.paused && session.startedAt) {
      elapsedBeforePause += Math.max(
        0,
        Math.floor((Date.now() - Number(session.startedAt)) / 1000)
      );
    }

    startedAt = null;
    paused = true;
    running = true;
    resetGPSFilter();

    if (route) {
      route.setLatLngs(points.map(p => [p.lat, p.lng]));
    }

    if (points.length && map) {
      const last = points[points.length - 1];
      map.setView([last.lat, last.lng], 17);
      updateGPSMarker(last);
    }

    setControls();
    updateStats();
    $("gpsStatus").textContent = "Caminhada recuperada - pausada";
    timer = setInterval(updateStats, 1000);

    await saveActiveSession();
  } catch (error) {
    console.error("Erro ao recuperar caminhada:", error);
  }
}

/* MAPA REGIONAL PMTILES: o arquivo é guardado no IndexedDB e servido pelo Service Worker com suporte a HTTP Range. */

async function installMapBlob(blob, name) {
  if (!blob || !blob.size) {
    throw new Error("Arquivo de mapa vazio.");
  }

  if (blob.size > 1500 * 1024 * 1024) {
    throw new Error("O arquivo ultrapassa o limite de 1,5 GB definido para este aparelho.");
  }

  const signature = await blob.slice(0, 7).text();

  if (signature !== "PMTiles") {
    throw new Error("O arquivo não parece ser um pacote PMTiles válido.");
  }

  await dbSet("offline-map", {
    blob,
    name: name || "mapa-regional.pmtiles",
    size: blob.size,
    savedAt: Date.now()
  });

  await waitForServiceWorkerControl();
  await activateOfflineMap();
}

async function waitForServiceWorkerControl() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

  try {
    await navigator.serviceWorker.ready;

    if (navigator.serviceWorker.controller) return;

    await Promise.race([
      new Promise(resolve =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })
      ),
      new Promise(resolve => setTimeout(resolve, 4000))
    ]);
  } catch (error) {
    console.warn("Service Worker ainda não controla esta página:", error);
  }
}

async function activateOfflineMap() {
  const data = await dbGet("offline-map");

  if (!data) {
    updateOfflineMapStatus();
    return false;
  }

  if (!window.protomapsL || !window.pmtiles) {
    $("offlineMapStatus").textContent = "Mapa salvo, mas as bibliotecas PMTiles ainda não foram carregadas. Conecte-se uma vez e reabra o aplicativo.";
    return false;
  }

  try {
    if (offlineLayer && map) {
      map.removeLayer(offlineLayer);
    }

    offlineLayer = protomapsL.leafletLayer({
      url: "./offline-map/current.pmtiles",
      flavor: "light",
      lang: "pt",
      attribution: "© OpenStreetMap contributors"
    });

    offlineLayer.addTo(map);

    if (onlineLayer && map) {
      map.removeLayer(onlineLayer);
    }

    $("offlineMapStatus").textContent =
      `Mapa regional instalado: ${data.name} (${(data.size / 1024 / 1024).toFixed(1)} MB). Ele será usado sem internet.`;

    setMapNotice("Mapa regional offline ativo. Créditos dos dados: © OpenStreetMap contributors, conforme a licença do pacote.");

    return true;
  } catch (error) {
    console.error(error);
    $("offlineMapStatus").textContent = "O arquivo foi guardado, mas não abriu. Confirme se é um PMTiles vetorial compatível com Protomaps.";
    return false;
  }
}

async function loadOfflineMap() {
  try {
    const data = await dbGet("offline-map");

    if (data) {
      await activateOfflineMap();
    } else {
      updateOfflineMapStatus();
    }
  } catch (error) {
    console.error(error);
    $("offlineMapStatus").textContent = "Não foi possível consultar o armazenamento de mapas.";
  }
}

async function updateOfflineMapStatus() {
  try {
    const data = await dbGet("offline-map");

    $("offlineMapStatus").textContent = data
      ? `Mapa instalado: ${data.name} (${(data.size / 1024 / 1024).toFixed(1)} MB).`
      : "Nenhum mapa regional instalado.";
  } catch {
    $("offlineMapStatus").textContent = "Armazenamento offline indisponível neste navegador.";
  }
}

function setMapProgress(value) {
  $("mapProgress").hidden = false;
  $("mapProgressFill").style.width = Math.max(0, Math.min(100, value)) + "%";
}

async function downloadMapFromUrl() {
  const url = $("mapUrl").value.trim();

  if (!url) {
    alert("Cole o link direto de um arquivo .pmtiles.");
    return;
  }

  if (!/^https:\/\//i.test(url)) {
    alert("Use um link HTTPS.");
    return;
  }

  const button = $("downloadMapBtn");
  button.disabled = true;
  $("offlineMapStatus").textContent = "Baixando arquivo do fornecedor...";
  setMapProgress(5);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("O servidor respondeu HTTP " + response.status + ".");
    }

    const blob = await response.blob();

    if (!blob.size) {
      throw new Error("O servidor enviou um arquivo vazio.");
    }

    setMapProgress(75);

    const name = decodeURIComponent(
      url.split("/").pop().split("?")[0]
    ) || "mapa-regional.pmtiles";

    await installMapBlob(blob, name);

    setMapProgress(100);

    $("offlineMapStatus").textContent =
      `Download concluído: ${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB).`;

  } catch (error) {
    $("offlineMapStatus").textContent =
      "Falha no download: " + error.message + ". O servidor precisa permitir acesso CORS.";
  } finally {
    button.disabled = false;
    setTimeout(() => {
      $("mapProgress").hidden = true;
    }, 1500);
  }
}

async function importMapFile(file) {
  if (!file) return;

  const button = $("importMapBtn");
  button.disabled = true;

  $("offlineMapStatus").textContent = "Importando mapa para o armazenamento do aparelho...";
  setMapProgress(30);

  try {
    await installMapBlob(file, file.name);

    setMapProgress(100);

    $("offlineMapStatus").textContent =
      `Mapa importado: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB).`;

  } catch (error) {
    $("offlineMapStatus").textContent = "Não foi possível importar: " + error.message;
  } finally {
    button.disabled = false;

    setTimeout(() => {
      $("mapProgress").hidden = true;
    }, 1500);
  }
}

async function removeOfflineMap() {
  if (!confirm("Deseja remover o mapa regional salvo neste aparelho?")) return;

  await dbDelete("offline-map");

  if (offlineLayer && map) {
    map.removeLayer(offlineLayer);
  }

  offlineLayer = null;

  if (onlineLayer && map) {
    onlineLayer.addTo(map);
  }

  updateOfflineMapStatus();
  setMapNotice("Mapa regional removido. O mapa de ruas online precisa de internet.");
}

const installButton = $("installBtn");
const installMessage = $("installMessage");

function updateInstallButton() {
  const installed =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  if (installed) {
    installButton.textContent = "✓ APLICATIVO INSTALADO";
    installButton.disabled = true;
    installMessage.textContent = "Você já está usando o aplicativo instalado.";
  }
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.disabled = false;
  installMessage.textContent = "Aplicativo pronto para instalação.";
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    installMessage.textContent = "Abra o menu do Chrome e escolha Adicionar à tela inicial.";
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
  installMessage.textContent = "Aplicativo instalado com sucesso!";
});

$("startBtn").addEventListener("click", startWalk);
$("pauseBtn").addEventListener("click", pauseWalk);
$("finishBtn").addEventListener("click", finishWalk);
$("exportBtn").addEventListener("click", exportData);
$("locateBtn").addEventListener("click", locateUser);
$("clearRecordsBtn").addEventListener("click", clearAllRecords);

$("downloadMapBtn").addEventListener("click", downloadMapFromUrl);
$("importMapBtn").addEventListener("click", () => $("mapFile").click());
$("mapFile").addEventListener("change", event => importMapFile(event.target.files[0]));
$("removeMapBtn").addEventListener("click", removeOfflineMap);
$("checkMapBtn").addEventListener("click", updateOfflineMapStatus);

initMap();
renderHistory();
updateStats();
updatePerformance();
updateInstallButton();
restoreActiveSession();

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("./sw.js")
      .catch(error => console.error("Erro no Service Worker:", error))
  );
}

// Aviso honesto: navegador pode suspender GPS em segundo plano conforme fabricante/Android.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && running && !paused) {
    console.info("Aplicativo em segundo plano: o Android pode limitar a localização.");
  }
});
