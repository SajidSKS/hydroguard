/**
 * HydroGuard Dashboard — app.js
 * MQTT WebSocket client, telemetry processing, valve/mode control
 * Thresholds based on WHO / IS 10500 standards
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   1. THRESHOLDS  (WHO / IS 10500)
   ═══════════════════════════════════════════════════════════ */
const THRESHOLDS = {
  turbidity: { warn: 1.0, fault: 5.0, max: 10.0 },
  tds:       { warn: 300, fault: 500, max: 1000  },
  ph:        { lo_warn: 6.8, lo_fault: 6.5, hi_warn: 8.2, hi_fault: 8.5, min: 0, max: 14 }
};

/* ═══════════════════════════════════════════════════════════
   2. STATE
   ═══════════════════════════════════════════════════════════ */
let mqttClient   = null;
let isConnected  = false;
let currentMode  = 'AUTO';
let currentValve = 'OPEN';
let currentState = 'NORMAL';
let msgCount     = 0;
let simInterval  = null;
let alarmShown   = false;
let uptimeStart  = Date.now();
let logEntries   = [];

let cfg = {
  host:     'rb12f81f.ala.eu-central-1.emqxsl.com',
  port:     8084,
  user:     '',
  pass:     '',
  topicTel: 'hydroguard/telemetry',
  topicCtrl:'hydroguard/control',
  deviceId: 'esp32-hydroguard-01'
};

/* ═══════════════════════════════════════════════════════════
   3. DOM
   ═══════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const dom = {
  sysTime:     $('sys-time'),
  lastMsgTime: $('last-msg-time'),
  connLed:     $('conn-led'),
  connLabel:   $('conn-label'),
  valTurb:     $('val-turbidity'),
  valTds:      $('val-tds'),
  valPh:       $('val-ph'),
  gaugeTurb:   $('gauge-turbidity'),
  gaugeTds:    $('gauge-tds'),
  gaugePh:     $('gauge-ph'),
  badgeTurb:   $('badge-turbidity'),
  badgeTds:    $('badge-tds'),
  badgePh:     $('badge-ph'),
  cardTurb:    $('card-turbidity'),
  cardTds:     $('card-tds'),
  cardPh:      $('card-ph'),
  stateDisplay:$('state-display'),
  stateSub:    $('state-sub'),
  faultRow:    $('fault-indicators'),
  fcTurb:      $('fc-turbidity'),
  fcTds:       $('fc-tds'),
  fcPh:        $('fc-ph'),
  valvePanel:  $('valve-panel'),
  valveLabel:  $('valve-state-label'),
  valveSvg:    $('valve-svg'),
  btnAuto:     $('btn-auto'),
  btnManual:   $('btn-manual'),
  modeStatus:  $('mode-status-text'),
  btnOpen:     $('btn-open-valve'),
  btnClose:    $('btn-close-valve'),
  manualWarn:  $('manual-only-warn'),
  diDevice:    $('di-device'),
  diBroker:    $('di-broker'),
  diTopic:     $('di-topic'),
  diMsgs:      $('di-msgs'),
  diUptime:    $('di-uptime'),
  sbConn:      $('sb-conn-text'),
  sbTopic:     $('sb-topic'),
  mqttLog:     $('mqtt-log-list'),
  alarmOverlay:$('alarm-overlay'),
};

/* ═══════════════════════════════════════════════════════════
   4. CLOCK
   ═══════════════════════════════════════════════════════════ */
function updateClock() {
  dom.sysTime.textContent = new Date().toTimeString().slice(0,8);
}
setInterval(updateClock, 1000);
updateClock();

setInterval(() => {
  const s = Math.floor((Date.now() - uptimeStart) / 1000);
  const h = String(Math.floor(s/3600)).padStart(2,'0');
  const m = String(Math.floor((s%3600)/60)).padStart(2,'0');
  const sec = String(s%60).padStart(2,'0');
  dom.diUptime.textContent = `${h}:${m}:${sec}`;
}, 1000);

/* ═══════════════════════════════════════════════════════════
   5. LOG
   ═══════════════════════════════════════════════════════════ */
function addLog(text, type='info') {
  const ts = new Date().toTimeString().slice(0,8);
  logEntries.push({ ts, text, type });
  if (logEntries.length > 5) logEntries.shift();
  dom.mqttLog.innerHTML = logEntries.map(e =>
    `<div class="log-entry log-${e.type}">[${e.ts}] ${e.text}</div>`
  ).join('');
}

/* ═══════════════════════════════════════════════════════════
   6. CLASSIFICATION
   ═══════════════════════════════════════════════════════════ */
function classifyTurbidity(v) {
  if (v >= THRESHOLDS.turbidity.fault) return 'fault';
  if (v >= THRESHOLDS.turbidity.warn)  return 'warn';
  return 'normal';
}
function classifyTds(v) {
  if (v >= THRESHOLDS.tds.fault) return 'fault';
  if (v >= THRESHOLDS.tds.warn)  return 'warn';
  return 'normal';
}
function classifyPh(v) {
  const t = THRESHOLDS.ph;
  if (v < t.lo_fault || v > t.hi_fault) return 'fault';
  if (v < t.lo_warn  || v > t.hi_warn)  return 'warn';
  return 'normal';
}

function badgeLabel(cls) { return { normal:'NORMAL', warn:'WARNING', fault:'FAULT' }[cls]; }
function badgeClass(cls) { return { normal:'badge-normal', warn:'badge-warn', fault:'badge-fault' }[cls]; }
function cardClass(cls)  { return { normal:'s-normal', warn:'s-warning', fault:'s-fault' }[cls]; }

/* ═══════════════════════════════════════════════════════════
   7. GAUGE %
   ═══════════════════════════════════════════════════════════ */
function turbPct(v) { return Math.min(100, (v / THRESHOLDS.turbidity.max) * 100); }
function tdsPct(v)  { return Math.min(100, (v / THRESHOLDS.tds.max) * 100); }
function phPct(v)   { return Math.min(100, (v / THRESHOLDS.ph.max) * 100); }

/* ═══════════════════════════════════════════════════════════
   8. RENDER SENSOR
   ═══════════════════════════════════════════════════════════ */
function renderSensor(sensor, value) {
  let cls, display, pct, valEl, gaugeEl, badgeEl, cardEl;

  if (sensor === 'turbidity') {
    cls = classifyTurbidity(value);
    display = value.toFixed(2);
    pct = turbPct(value);
    valEl = dom.valTurb; gaugeEl = dom.gaugeTurb; badgeEl = dom.badgeTurb; cardEl = dom.cardTurb;
  } else if (sensor === 'tds') {
    cls = classifyTds(value);
    display = Math.round(value).toString();
    pct = tdsPct(value);
    valEl = dom.valTds; gaugeEl = dom.gaugeTds; badgeEl = dom.badgeTds; cardEl = dom.cardTds;
  } else {
    cls = classifyPh(value);
    display = value.toFixed(2);
    pct = phPct(value);
    valEl = dom.valPh; gaugeEl = dom.gaugePh; badgeEl = dom.badgePh; cardEl = dom.cardPh;
  }

  valEl.textContent = display;
  valEl.className = 'reading-value' + (cls === 'fault' ? ' fault' : cls === 'warn' ? ' warn' : '');

  gaugeEl.style.width = pct + '%';
  gaugeEl.className = 'gauge-fill' + (cls === 'fault' ? ' fault' : cls === 'warn' ? ' warn' : '');

  badgeEl.textContent = badgeLabel(cls);
  badgeEl.className = 'status-badge ' + badgeClass(cls);

  cardEl.className = 'xp-window sensor-panel ' + cardClass(cls);

  return cls;
}

/* ═══════════════════════════════════════════════════════════
   9. SYSTEM STATE
   ═══════════════════════════════════════════════════════════ */
function renderSystemState(turbCls, tdsCls, phCls, valveState, sysMode) {
  const hasFault = [turbCls, tdsCls, phCls].includes('fault');
  const hasWarn  = [turbCls, tdsCls, phCls].includes('warn');
  const state = hasFault ? 'FAULT' : hasWarn ? 'WARNING' : 'NORMAL';
  currentState = state;

  dom.stateDisplay.textContent = state;
  dom.stateDisplay.className = 'state-text state-' + state.toLowerCase();

  const subs = {
    FAULT:   'Contamination detected — valve closing',
    WARNING: 'Parameter approaching threshold',
    NORMAL:  'All parameters within safe limits'
  };
  dom.stateSub.textContent = subs[state];

  if (hasFault || hasWarn) {
    dom.faultRow.classList.remove('hidden');
    dom.fcTurb.className = 'fault-chip' + (turbCls !== 'normal' ? ' active' : '');
    dom.fcTds.className  = 'fault-chip' + (tdsCls  !== 'normal' ? ' active' : '');
    dom.fcPh.className   = 'fault-chip' + (phCls   !== 'normal' ? ' active' : '');
  } else {
    dom.faultRow.classList.add('hidden');
  }

  if (state === 'FAULT' && !alarmShown) { alarmShown = true; showAlarm([turbCls, tdsCls, phCls]); }
  if (state !== 'FAULT') alarmShown = false;

  renderValve(valveState);
  renderMode(sysMode);
}

/* ═══════════════════════════════════════════════════════════
   10. VALVE & MODE
   ═══════════════════════════════════════════════════════════ */
function renderValve(state) {
  currentValve = state;
  const open = state === 'OPEN';
  dom.valveLabel.textContent = open ? '● OPEN' : '● CLOSED';
  dom.valveLabel.className = 'valve-label ' + (open ? 'valve-is-open' : 'valve-is-closed');
  dom.valveSvg.classList.toggle('valve-closed', !open);
}

function renderMode(mode) {
  currentMode = mode || currentMode;
  const auto = currentMode === 'AUTO';
  dom.btnAuto.className   = 'xp-btn mode-btn' + (auto  ? ' mode-active' : '');
  dom.btnManual.className = 'xp-btn mode-btn' + (!auto ? ' mode-active' : '');
  dom.modeStatus.textContent = auto ? 'Autonomous control active' : '⚠ Manual override engaged';
  dom.btnOpen.disabled  = auto;
  dom.btnClose.disabled = auto;
  if (auto) {
    dom.manualWarn.classList.remove('hidden');
  } else {
    dom.manualWarn.classList.add('hidden');
  }
}

/* ═══════════════════════════════════════════════════════════
   11. PROCESS TELEMETRY
   ═══════════════════════════════════════════════════════════ */
function processTelemetry(payload) {
  try {
    const d = (typeof payload === 'string') ? JSON.parse(payload) : payload;

    const turbCls = renderSensor('turbidity', Number(d.turbidity) || 0);
    const tdsCls  = renderSensor('tds',       Number(d.tds)       || 0);
    const phCls   = renderSensor('ph',        Number(d.ph)        || 7.0);

    const valve = d.valve_state || d.valve || currentValve;
    const mode  = d.system_mode || d.mode  || currentMode;
    renderSystemState(turbCls, tdsCls, phCls, valve, mode);

    const ts = new Date().toTimeString().slice(0,8);
    dom.lastMsgTime.textContent = ts;
    msgCount++;
    dom.diMsgs.textContent = msgCount;
    if (d.device_id) dom.diDevice.textContent = d.device_id;

    addLog(`RX | Turb: ${Number(d.turbidity).toFixed(1)} NTU, TDS: ${Math.round(d.tds)} ppm, pH: ${Number(d.ph).toFixed(2)}`, 'ok');
  } catch(e) {
    addLog('Parse error: ' + e.message, 'error');
  }
}

/* ═══════════════════════════════════════════════════════════
   12. MQTT
   ═══════════════════════════════════════════════════════════ */
function mqttConnect() {
  cfg.host     = $('cfg-host').value.trim()     || cfg.host;
  cfg.port     = parseInt($('cfg-port').value)  || cfg.port;
  cfg.user     = $('cfg-user') ? $('cfg-user').value.trim() : '';
  cfg.pass     = $('cfg-pass') ? $('cfg-pass').value.trim() : '';
  cfg.topicTel = $('cfg-topic-tel').value.trim()|| cfg.topicTel;
  cfg.topicCtrl= $('cfg-topic-ctrl').value.trim()|| cfg.topicCtrl;
  cfg.deviceId = $('cfg-device').value.trim()   || cfg.deviceId;

  if (mqttClient) { try { mqttClient.end(true); } catch(_){} }

  // Auto-detect protocol: wss (8884, 8084, 8081, 443) vs ws (8000, 8083, 8080, 80)
  const isPlain = [8000, 8083, 8080, 80].includes(cfg.port);
  const proto = isPlain ? 'ws' : 'wss';
  const url = `${proto}://${cfg.host}:${cfg.port}/mqtt`;
  const clientId = `hg-dash-${Math.random().toString(16).slice(2,8)}`;

  setConn('connecting');
  addLog('Connecting to ' + cfg.host + '...', 'info');
  dom.diBroker.textContent = cfg.host + ':' + cfg.port;
  dom.diTopic.textContent  = cfg.topicTel;
  dom.sbTopic.textContent  = 'Topic: ' + cfg.topicTel;

  const opts = {
    clientId, clean: true, reconnectPeriod: 4000, connectTimeout: 8000,
    will: { topic: cfg.topicTel + '/lwt', payload: JSON.stringify({ device_id: cfg.deviceId, status: 'offline' }), qos: 1, retain: true }
  };
  if (cfg.user) opts.username = cfg.user;
  if (cfg.pass) opts.password = cfg.pass;

  mqttClient = mqtt.connect(url, opts);

  mqttClient.on('connect', () => {
    isConnected = true; setConn('online');
    addLog('Connected — subscribing to ' + cfg.topicTel, 'ok');
    mqttClient.subscribe(cfg.topicTel, { qos: 1 }, err => {
      if (err) addLog('Subscribe error', 'error');
      else addLog('Subscribed OK', 'ok');
    });
  });
  mqttClient.on('message', (topic, msg) => {
    if (topic === cfg.topicTel) processTelemetry(msg.toString());
  });
  mqttClient.on('reconnect', () => { setConn('connecting'); addLog('Reconnecting...', 'warn'); });
  mqttClient.on('offline',   () => { isConnected = false; setConn('offline'); addLog('Broker offline', 'warn'); });
  mqttClient.on('error', err => { setConn('error'); addLog('Error: ' + err.message, 'error'); });

  toggleSettings();
}

function mqttDisconnect() {
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }
  isConnected = false; setConn('offline');
  addLog('Disconnected', 'warn');
  toggleSettings();
}

function setConn(state) {
  const map = {
    connecting: { led: '',       label: 'Connecting...', sb: '',      sbText: '◌ Connecting...' },
    online:     { led: 'online', label: 'Connected',     sb: 'online',sbText: '⬤ Connected' },
    offline:    { led: '',       label: 'Disconnected',  sb: '',      sbText: '⬤ Disconnected' },
    error:      { led: 'error',  label: 'Error',         sb: 'error', sbText: '⬤ Connection error' },
  };
  const s = map[state] || map.offline;
  dom.connLed.className = s.led;
  dom.connLabel.textContent = s.label;
  dom.sbConn.className = s.sb;
  dom.sbConn.textContent = s.sbText;
}

/* ═══════════════════════════════════════════════════════════
   13. COMMANDS
   ═══════════════════════════════════════════════════════════ */
function sendValveCmd(cmd) {
  if (currentMode !== 'MANUAL') return;
  const payload = JSON.stringify({ device_id: cfg.deviceId, timestamp: Math.floor(Date.now()/1000), command: 'VALVE', value: cmd });
  if (isConnected && mqttClient) {
    mqttClient.publish(cfg.topicCtrl, payload, { qos: 1 });
    addLog('TX valve: ' + cmd, 'ok');
  } else { addLog('Not connected — command queued', 'warn'); }
  renderValve(cmd);
}

function setMode(mode) {
  currentMode = mode;
  renderMode(mode);
  const payload = JSON.stringify({ device_id: cfg.deviceId, timestamp: Math.floor(Date.now()/1000), command: 'MODE', value: mode });
  if (isConnected && mqttClient) {
    mqttClient.publish(cfg.topicCtrl, payload, { qos: 1 });
    addLog('TX mode: ' + mode, 'ok');
  } else { addLog('Mode: ' + mode + ' (offline)', 'warn'); }
}

/* ═══════════════════════════════════════════════════════════
   14. ALARM
   ═══════════════════════════════════════════════════════════ */
function showAlarm(clsArr) {
  const sensors = ['Turbidity','TDS','pH'];
  const faulty = sensors.filter((_,i) => clsArr[i] === 'fault').join(', ');
  $('alarm-text').textContent = 'Fault on: ' + (faulty || 'unknown') + '. Valve may close automatically.';
  dom.alarmOverlay.classList.remove('hidden');
}
function dismissAlarm() { dom.alarmOverlay.classList.add('hidden'); }

/* ═══════════════════════════════════════════════════════════
   15. SETTINGS
   ═══════════════════════════════════════════════════════════ */
function toggleSettings() { $('settings-panel').classList.toggle('hidden'); }

/* ═══════════════════════════════════════════════════════════
   16. SIMULATION
   ═══════════════════════════════════════════════════════════ */
let simStep = 0;
const SIM_DATA = [
  { turbidity:0.4, tds:120, ph:7.2, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:0.6, tds:145, ph:7.4, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:0.8, tds:188, ph:7.1, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:1.2, tds:220, ph:7.0, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:2.5, tds:260, ph:6.9, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:4.2, tds:310, ph:6.8, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:6.8, tds:520, ph:8.7, valve_state:'CLOSED',system_mode:'AUTO'   },
  { turbidity:7.2, tds:580, ph:9.1, valve_state:'CLOSED',system_mode:'AUTO'   },
  { turbidity:7.0, tds:560, ph:8.9, valve_state:'OPEN',  system_mode:'MANUAL' },
  { turbidity:6.5, tds:490, ph:8.5, valve_state:'OPEN',  system_mode:'MANUAL' },
  { turbidity:3.2, tds:380, ph:7.8, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:1.5, tds:280, ph:7.4, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:0.7, tds:190, ph:7.2, valve_state:'OPEN',  system_mode:'AUTO'   },
  { turbidity:0.4, tds:140, ph:7.1, valve_state:'OPEN',  system_mode:'AUTO'   },
];

function simTick() {
  const s = SIM_DATA[simStep % SIM_DATA.length];
  const j = v => v + (Math.random() - 0.5) * v * 0.05;
  processTelemetry({
    device_id: cfg.deviceId,
    timestamp: Math.floor(Date.now()/1000),
    turbidity: parseFloat(j(s.turbidity).toFixed(2)),
    tds:       Math.round(j(s.tds)),
    ph:        parseFloat(j(s.ph).toFixed(2)),
    valve_state: s.valve_state,
    system_mode: s.system_mode,
  });
  simStep++;
}

function toggleSimulation(on) {
  if (on) {
    simStep = 0;
    addLog('Simulation started', 'warn');
    simTick();
    simInterval = setInterval(simTick, 2200);
  } else {
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    addLog('Simulation stopped', 'info');
  }
}

/* ═══════════════════════════════════════════════════════════
   17. INIT
   ═══════════════════════════════════════════════════════════ */
(function init() {
  renderValve('OPEN');
  renderMode('AUTO');
  setConn('offline');
  addLog('HydroGuard ready. Open Settings to connect.', 'info');
  dom.diDevice.textContent = cfg.deviceId;
  dom.diBroker.textContent = cfg.host + ':' + cfg.port;
})();
