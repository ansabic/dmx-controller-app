'use strict';

const ROLES = ['other', 'dim', 'r', 'g', 'b', 'w', 'a', 'uv', 'strobe', 'mode', 'speed'];
const ROLE_LABEL = { other: 'Other', dim: 'Dimmer', r: 'Red', g: 'Green', b: 'Blue', w: 'White',
  a: 'Amber', uv: 'UV', strobe: 'Strobe', mode: 'Mode', speed: 'Speed' };
const FX = [['none', 'Stop'], ['rainbow', 'Rainbow'], ['chase', 'Chase'],
  ['fade', 'Fade'], ['strobe', 'Strobe'], ['pulse', 'Pulse']];
const SWATCHES = ['#ff0000', '#ff7a00', '#ffd000', '#00ff00', '#00ffff', '#0000ff',
  '#ff00ff', '#ffffff', '#000000'];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = { ch: new Array(513).fill(0), pars: [], fx: {}, scenes: [], master: 255, blackout: false };
let selected = new Set(load('selected', [0, 1, 2, 3]));
let sceneMode = 'recall';
let cfgDirty = false;
const recentlySent = new Map();  // ch -> time, so echoes don't fight a finger on a slider

function load(key, def) { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } }
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

// ---------- connection: WebSocket when served by the ESP32, Bluetooth when hosted ----------
// Browsers only allow Bluetooth on https pages, and https pages can't open the ESP32's ws://.
const USE_BLE = location.protocol === 'https:' || location.hostname === 'localhost';
const BLE = {
  svc: '5b2d0001-6c9e-4b8a-9d3f-1a7e0d4c9b10',
  rx: '5b2d0002-6c9e-4b8a-9d3f-1a7e0d4c9b10',
  tx: '5b2d0003-6c9e-4b8a-9d3f-1a7e0d4c9b10',
};
const enc = new TextEncoder();

function setConnected(on) {
  $('#conn').classList.toggle('ok', on);
  $('#bleBtn').hidden = !USE_BLE || on;
}
function handleLine(line) {
  if (!line) return;
  try { onMessage(JSON.parse(line)); } catch (err) { console.warn('bad message', err); }
}

let ws;
function wsConnect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setConnected(true);
  ws.onclose = () => { setConnected(false); setTimeout(wsConnect, 1500); };
  ws.onmessage = (e) => handleLine(e.data);
}

let bleDev, bleRx, bleBuf = '', bleChain = Promise.resolve(), bleDecoder;
async function bleConnect(pick) {
  try {
    if (pick || !bleDev) {
      bleDev = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE.svc] }] });
      bleDev.ongattserverdisconnected = () => { setConnected(false); setTimeout(() => bleConnect(false), 1500); };
    }
    const gatt = await bleDev.gatt.connect();
    const svc = await gatt.getPrimaryService(BLE.svc);
    bleRx = await svc.getCharacteristic(BLE.rx);
    const tx = await svc.getCharacteristic(BLE.tx);
    bleBuf = '';
    bleDecoder = new TextDecoder();
    tx.oncharacteristicvaluechanged = (e) => {
      bleBuf += bleDecoder.decode(e.target.value, { stream: true });
      const lines = bleBuf.split('\n');
      bleBuf = lines.pop();
      lines.forEach(handleLine);
    };
    await tx.startNotifications();
    setConnected(true);
    send({ t: 'get' });
  } catch (err) {
    console.warn('Bluetooth', err);
    setConnected(false);
    // Lost link to a known controller: keep retrying quietly. A cancelled picker just stops.
    if (bleDev && !pick && err.name !== 'NotFoundError') setTimeout(() => bleConnect(false), 3000);
  }
}
function bleWrite(str) {
  const data = enc.encode(str + '\n');
  bleChain = bleChain.then(async () => {
    for (let i = 0; i < data.length; i += 180) await bleRx.writeValueWithoutResponse(data.slice(i, i + 180));
  }).catch((err) => console.warn('Bluetooth write', err));
}

function connect() {
  if (!USE_BLE) return wsConnect();
  $('#bleBtn').onclick = () => bleConnect(true);
  if (!navigator.bluetooth) {
    $('#bleBtn').textContent = 'No Bluetooth';
    $('#bleBtn').disabled = true;
    $('#status').textContent = 'This browser has no Web Bluetooth. Use Chrome on Android, ' +
      'or join the controller\'s WiFi and open http://dmx.local';
  }
  setConnected(false);
}
function send(obj) {
  const json = JSON.stringify(obj);
  if (USE_BLE) { if ($('#conn').classList.contains('ok')) bleWrite(json); }
  else if (ws && ws.readyState === 1) ws.send(json);
}
// Names are stored in 24-byte slots on the ESP32; trim by bytes so we never split a character.
function fitName(n) { while (enc.encode(n).length > 23) n = n.slice(0, -1); return n; }

// At most one message per key every 40 ms, always delivering the latest value.
const throttles = new Map();
function sendThrottled(key, obj) {
  let t = throttles.get(key);
  if (!t) throttles.set(key, t = { last: 0, pending: null, timer: 0 });
  t.pending = obj;
  const wait = 40 - (Date.now() - t.last);
  if (wait <= 0) flush(t);
  else if (!t.timer) t.timer = setTimeout(() => flush(t), wait);
}
function flush(t) { clearTimeout(t.timer); t.timer = 0; t.last = Date.now(); send(t.pending); }

function onMessage(m) {
  switch (m.t) {
    case 'state':
      state.ch = [0, ...m.ch];
      Object.assign(state, { pars: m.pars, fx: m.fx, scenes: m.scenes, master: m.master, blackout: m.blackout });
      renderParCards(); renderFaders(); renderScenes(); renderFx();
      if (!cfgDirty) renderSettings();
      refresh();
      break;
    case 'chs': {
      const now = Date.now();
      for (const [c, v] of m.d) if (!(now - (recentlySent.get(c) || 0) < 600)) state.ch[c] = v;
      refresh();
      break;
    }
    case 'out':
      state.master = m.master; state.blackout = m.blackout; refresh();
      break;
    case 'fx':
      state.fx = m.fx; renderFx();
      break;
    case 'stat':
      $('#status').textContent = `IP ${m.ip}\nDMX ${m.fps} fps\nWiFi ${m.rssi} dBm\n` +
        `Free heap ${(m.heap / 1024).toFixed(0)} kB\nPhones on WiFi ${m.clients}, on Bluetooth ${m.ble}\n` +
        `Connected via ${USE_BLE ? 'Bluetooth' : 'WiFi'}`;
      break;
  }
}

// ---------- channel helpers ----------
function parCh(p, role) {
  const par = state.pars[p];
  if (!par) return 0;
  const i = par.roles.indexOf(role);
  return i < 0 ? 0 : par.addr + i;
}
function setLocal(c, v) { if (c >= 1 && c <= 512) { state.ch[c] = v; recentlySent.set(c, Date.now()); } }
function setCh(c, v) { setLocal(c, v); sendThrottled('ch' + c, { t: 'ch', c, v }); refresh(); }
function setPars(pars, set, key) {
  if (!pars.length) return;
  for (const p of pars) for (const [role, v] of Object.entries(set)) setLocal(parCh(p, role), v);
  sendThrottled(key, { t: 'par', i: pars, set });
  refresh();
}
const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
function parRgb(p) { return ['r', 'g', 'b'].map((r) => state.ch[parCh(p, r)] || 0); }
function roleLabel(c) {
  for (let p = 0; p < state.pars.length; p++) {
    const par = state.pars[p], i = c - par.addr;
    if (i >= 0 && i < par.roles.length) return `${par.name} · ${ROLE_LABEL[par.roles[i]]}`;
  }
  return '';
}

// Push state into every bound control.
function refresh() {
  for (const el of $$('input[data-ch]')) {
    const v = state.ch[+el.dataset.ch];
    if (+el.value !== v) el.value = v;
    const out = el.nextElementSibling;
    if (out && out.tagName === 'OUTPUT') out.textContent = v;
  }
  state.pars.forEach((_, p) => {
    const rgb = parRgb(p), dim = parCh(p, 'dim') ? state.ch[parCh(p, 'dim')] / 255 : 1;
    const sw = $(`#par${p} .swatch`);
    if (sw) sw.style.background = hex(rgb.map((v) => Math.round(v * dim)));
    const ci = $(`#par${p} input[type=color]`);
    if (ci && !ci.matches(':focus')) ci.value = hex(rgb);
  });
  $('#master').value = state.master;
  $('#blackout').classList.toggle('on', state.blackout);
}

function slider(label, ch) {
  return `<label class="slider"><span>${label}</span>` +
    `<input type="range" min="0" max="255" data-ch="${ch}"><output></output></label>`;
}

// ---------- Pars tab ----------
function renderParCards() {
  $('#parCards').innerHTML = state.pars.map((par, p) => {
    const extra = par.roles.map((r, i) => [r, par.addr + i])
      .filter(([r]) => !['r', 'g', 'b', 'dim'].includes(r));
    const dim = parCh(p, 'dim');
    return `<div class="card par" id="par${p}">
      <div class="row head">
        <label class="name"><input type="checkbox" data-sel="${p}" ${selected.has(p) ? 'checked' : ''}>
          <span class="swatch"></span><h2>${esc(par.name)}</h2></label>
        <span class="addr">ch ${par.addr}–${par.addr + par.roles.length - 1}</span>
      </div>
      <div class="row"><span>Color</span><input type="color" data-par="${p}"></div>
      ${dim ? slider('Dimmer', dim) : ''}
      ${extra.length ? `<details><summary>More channels</summary>
        ${extra.map(([r, c]) => slider(ROLE_LABEL[r], c)).join('')}</details>` : ''}
    </div>`;
  }).join('');
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`); }

$('#parCards').addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.par !== undefined) {
    const [r, g, b] = rgbOf(el.value);
    setPars([+el.dataset.par], { r, g, b }, 'col' + el.dataset.par);
  }
});
$('#parCards').addEventListener('change', (e) => {
  if (e.target.dataset.sel === undefined) return;
  const p = +e.target.dataset.sel;
  e.target.checked ? selected.add(p) : selected.delete(p);
  store('selected', [...selected]);
});
document.addEventListener('input', (e) => {
  if (e.target.dataset.ch !== undefined) setCh(+e.target.dataset.ch, +e.target.value);
});

function selectedPars() { return [...selected].filter((p) => p < state.pars.length).sort(); }
function setSelection(all) {
  selected = new Set(all ? state.pars.map((_, i) => i) : []);
  store('selected', [...selected]);
  $$('[data-sel]').forEach((el) => { el.checked = selected.has(+el.dataset.sel); });
}
$('#selAll').onclick = () => setSelection(true);
$('#selNone').onclick = () => setSelection(false);

$('#groupSwatches').innerHTML = SWATCHES.map((c) =>
  `<button style="background:${c}" data-color="${c}" aria-label="${c}"></button>`).join('');
$('#groupSwatches').onclick = (e) => {
  const c = e.target.dataset.color;
  if (!c) return;
  const [r, g, b] = rgbOf(c);
  const pars = selectedPars();
  setPars(pars, { r, g, b }, 'grpCol');
  // Turn on the dimmer of pars that are at zero so a tap always lights them.
  const dark = pars.filter((p) => parCh(p, 'dim') && !state.ch[parCh(p, 'dim')]);
  if (c !== '#000000') setPars(dark, { dim: 255 }, 'grpDimOn');
  $('#groupColor').value = c;
};
$('#groupColor').oninput = (e) => {
  const [r, g, b] = rgbOf(e.target.value);
  setPars(selectedPars(), { r, g, b }, 'grpCol');
};
$('#groupDim').oninput = (e) => setPars(selectedPars(), { dim: +e.target.value }, 'grpDim');
$('#groupWhite').oninput = (e) => setPars(selectedPars(), { w: +e.target.value }, 'grpW');
$('#groupStrobe').oninput = (e) => setPars(selectedPars(), { strobe: +e.target.value }, 'grpStrobe');
$('#reset').onclick = () => confirm('Set every channel to 0 and stop effects?') && send({ t: 'reset' });

// ---------- header ----------
$('#master').oninput = (e) => { state.master = +e.target.value; sendThrottled('master', { t: 'master', v: state.master }); };
$('#blackout').onclick = () => send({ t: 'blackout', on: !state.blackout });
$$('nav button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
function showTab(name) {
  $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
  store('tab', name);
}
showTab(load('tab', 'pars'));

// ---------- Effects tab ----------
$('#fxButtons').innerHTML = FX.map(([id, label]) => `<button data-fx="${id}">${label}</button>`).join('');
$('#fxButtons').onclick = (e) => e.target.dataset.fx && send({ t: 'fx', type: e.target.dataset.fx });
$('#fxSpeed').oninput = (e) => sendThrottled('fxS', { t: 'fx', speed: +e.target.value });
$('#fxIntensity').oninput = (e) => sendThrottled('fxI', { t: 'fx', intensity: +e.target.value });
$('#fxC1').oninput = (e) => sendThrottled('fxC1', { t: 'fx', c1: rgbOf(e.target.value) });
$('#fxC2').oninput = (e) => sendThrottled('fxC2', { t: 'fx', c2: rgbOf(e.target.value) });
$('#fxMask').onchange = () => {
  const mask = $$('#fxMask input').reduce((m, el, i) => m | (el.checked ? 1 << i : 0), 0);
  send({ t: 'fx', mask });
};
function renderFx() {
  const fx = state.fx;
  $$('#fxButtons button').forEach((b) => b.classList.toggle('on', b.dataset.fx === fx.type && fx.type !== 'none'));
  $('#fxSpeed').value = fx.speed;
  $('#fxIntensity').value = fx.intensity;
  $('#fxC1').value = hex(fx.c1);
  $('#fxC2').value = hex(fx.c2);
  $('#fxMask').innerHTML = state.pars.map((par, i) =>
    `<label><input type="checkbox" ${fx.mask & (1 << i) ? 'checked' : ''}> ${i + 1}</label>`).join('');
}

// ---------- Scenes tab ----------
$('#sceneMode').onclick = (e) => {
  if (!e.target.dataset.mode) return;
  sceneMode = e.target.dataset.mode;
  $$('#sceneMode button').forEach((b) => b.classList.toggle('on', b === e.target));
};
$('#fade').value = load('fade', 0);
const fadeLabel = () => { $('#fadeVal').textContent = ($('#fade').value / 10).toFixed(1) + 's'; };
$('#fade').oninput = () => { fadeLabel(); store('fade', +$('#fade').value); };
fadeLabel();
function renderScenes() {
  $('#sceneGrid').innerHTML = state.scenes.map((name, id) =>
    `<button data-id="${id}" class="${name ? '' : 'empty'}">${name ? esc(name) : '+ ' + (id + 1)}</button>`).join('');
}
$('#sceneGrid').onclick = (e) => {
  const id = e.target.dataset.id;
  if (id === undefined) return;
  const name = state.scenes[id];
  if (sceneMode === 'recall') {
    if (name) send({ t: 'scene', op: 'recall', id: +id, fade: $('#fade').value * 100 });
  } else if (sceneMode === 'save') {
    const n = prompt('Scene name', name || `Scene ${+id + 1}`);
    if (n !== null) send({ t: 'scene', op: 'save', id: +id, name: fitName(n) });
  } else if (name && confirm(`Delete "${name}"?`)) {
    send({ t: 'scene', op: 'delete', id: +id });
  }
};

// ---------- Faders tab ----------
let pageStart = load('pageStart', 1);
function renderFaders() {
  pageStart = Math.min(Math.max(1, pageStart), 497);
  $('#pgStart').value = pageStart;
  store('pageStart', pageStart);
  let html = '';
  for (let c = pageStart; c < pageStart + 16; c++) {
    html += `<label class="slider fader"><span>${c}<small>${esc(roleLabel(c))}</small></span>` +
      `<input type="range" min="0" max="255" data-ch="${c}"><output></output></label>`;
  }
  $('#faders').innerHTML = html;
  refresh();
}
$('#pgPrev').onclick = () => { pageStart -= 16; renderFaders(); };
$('#pgNext').onclick = () => { pageStart += 16; renderFaders(); };
$('#pgStart').onchange = (e) => { pageStart = +e.target.value || 1; renderFaders(); };

// ---------- Setup tab ----------
function renderSettings() {
  $('#cfgPars').innerHTML = state.pars.map((par, p) => `<div class="card" data-cfg="${p}">
      <div class="row"><input type="text" class="cfgName" maxlength="23" value="${esc(par.name)}"></div>
      <div class="row">
        <label>Address <input type="number" class="cfgAddr" min="1" max="512" value="${par.addr}"></label>
        <label>Channels <input type="number" class="cfgN" min="1" max="16" value="${par.roles.length}"></label>
      </div>
      <div class="roles">${rolesHtml(par.roles)}</div>
    </div>`).join('');
}
function rolesHtml(roles) {
  return roles.map((r, i) => `<label>ch ${i + 1}<select>${
    ROLES.map((o) => `<option value="${o}" ${o === r ? 'selected' : ''}>${ROLE_LABEL[o]}</option>`).join('')
  }</select></label>`).join('');
}
$('#cfgPars').addEventListener('input', () => { cfgDirty = true; });
$('#cfgPars').addEventListener('change', (e) => {
  if (!e.target.classList.contains('cfgN')) return;
  // Grow/shrink the role list in place, keeping what was already chosen.
  const card = e.target.closest('[data-cfg]');
  const roles = $$('select', card).map((s) => s.value);
  const n = Math.min(16, Math.max(1, +e.target.value || 1));
  while (roles.length < n) roles.push('other');
  roles.length = n;
  $('.roles', card).innerHTML = rolesHtml(roles);
});
$('#cfgSave').onclick = () => {
  const pars = $$('#cfgPars [data-cfg]').map((card) => ({
    name: fitName($('.cfgName', card).value),
    addr: Math.min(512, Math.max(1, +$('.cfgAddr', card).value || 1)),
    roles: $$('select', card).map((s) => s.value),
  }));
  cfgDirty = false;
  send({ t: 'cfg', pars });
};

connect();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js');
