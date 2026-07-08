// --- Data Models ---

// All potential routes a user can track.
const allRoutes = [
  { id: 't-1', type: 'train', name: '1 Train', lineClass: 'bg-red-500 text-white', desc: 'Broadway - 7 Ave Local' },
  { id: 't-a', type: 'train', name: 'A Train', lineClass: 'bg-blue-600 text-white', desc: '8 Ave Express' },
  { id: 't-c', type: 'train', name: 'C Train', lineClass: 'bg-blue-600 text-white', desc: '8 Ave Local' },
  { id: 't-d', type: 'train', name: 'D Train', lineClass: 'bg-orange-500 text-white', desc: '6 Ave Express' },
  { id: 'b-bx15', type: 'bus', name: 'Bx15', lineClass: 'bg-cyan-600 text-white', desc: '125th St / Willis Ave' },
  { id: 'b-m100', type: 'bus', name: 'M100', lineClass: 'bg-cyan-600 text-white', desc: 'Amsterdam Ave' },
];

// Routes with no live MTA subway feed backing them (buses require a
// separately keyed MTA Bus Time subscription) fall back to this estimate
// so the UI still has something reasonable to show, clearly labeled.
const busFallbackStatus = {
  'b-bx15': { status: 'Estimated', crowd: 55, note: 'Live bus data requires an MTA Bus Time API key - showing a typical estimate.', arrivals: [], source: 'estimate' },
  'b-m100': { status: 'Estimated', crowd: 25, note: 'Live bus data requires an MTA Bus Time API key - showing a typical estimate.', arrivals: [], source: 'estimate' },
};

// Micro break database.
const microBreaks = [
  { name: 'Taszo Espresso Bar', loc: 'Near 145th St', desc: 'Quiet, good Wi-Fi. Perfect for letting 1 train crowds pass.', status: 'Quiet' },
  { name: 'St. Nicholas Park', loc: '135th to 141st', desc: 'Take a scenic walk instead of standing on a packed platform.', status: 'Outdoors' },
  { name: 'The Chipped Cup', loc: 'Broadway & 148th', desc: 'Cozy backyard open. Good spot to wait out delays.', status: 'Moderate' },
];

// State: Routes the user is currently subscribed to.
let userSubscriptions = ['t-1', 't-a', 'b-bx15'];

// Live status keyed by route id, refreshed from the backend on a timer.
let liveStatus = { ...busFallbackStatus };

const POLL_INTERVAL_MS = 20_000;
let pollTimer = null;

// --- Live data fetching ---

async function refreshLiveStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error(`status ${response.status}`);
    const payload = await response.json();

    liveStatus = { ...busFallbackStatus, ...payload.routes };
    setConnectionState('connected');
    renderSubscriptions();
  } catch (err) {
    setConnectionState('error');
    // Keep showing the last known data instead of clearing the UI.
    console.error('Failed to refresh live MTA status:', err);
  }
}

function setConnectionState(state) {
  const dot = document.getElementById('connection-dot');
  const label = document.getElementById('connection-label');
  const lastUpdated = document.getElementById('last-updated');
  if (!dot || !label) return;

  if (state === 'connected') {
    dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
    label.textContent = 'Live MTA data connected';
    if (lastUpdated) lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } else if (state === 'error') {
    dot.className = 'w-2 h-2 rounded-full bg-rose-500';
    label.textContent = 'MTA feed unreachable - retrying';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-slate-300';
    label.textContent = 'Connecting to MTA feed\u2026';
  }
}

// --- Core UI Functions ---

function statusColorClasses(status) {
  if (status.source === 'error') return { text: 'text-slate-400', bar: 'bg-slate-300', node: 'status-unknown' };
  if (status.status === 'Severe Delays') return { text: 'text-rose-500', bar: 'bg-rose-500', node: 'status-delayed' };
  if (status.status === 'Moderate Delays' || status.status === 'Crowded' || status.status === 'Estimated') {
    return { text: 'text-amber-500', bar: 'bg-amber-400', node: 'status-crowded' };
  }
  return { text: 'text-emerald-500', bar: 'bg-emerald-400', node: 'status-good' };
}

function trainIconSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h0"/><path d="M16 15h0"/></svg>';
}

function busIconSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/></svg>';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderSubscriptions() {
  const listEl = document.getElementById('subscriptions-list');
  listEl.innerHTML = '';

  if (userSubscriptions.length === 0) {
    listEl.innerHTML = '<div class="text-center py-6 text-slate-500 text-sm">No routes monitored. Click \'+\' to add.</div>';
    updateStressScore();
    return;
  }

  userSubscriptions.forEach((id) => {
    const route = allRoutes.find((r) => r.id === id);
    const status = liveStatus[id] || { status: 'Loading\u2026', crowd: 0, note: '', arrivals: [], source: 'loading' };
    const colors = statusColorClasses(status);
    const icon = route.type === 'train' ? trainIconSvg() : busIconSvg();
    const crowdPct = status.crowd == null ? 0 : status.crowd;

    const nextArrival = status.arrivals && status.arrivals.length
      ? `Next train in ${status.arrivals[0].minutesAway} min`
      : '';

    const html = `
      <div class="border border-slate-200 rounded-xl p-3 hover:border-slate-300 transition-colors bg-white group relative">
        <button onclick="toggleSubscription('${id}')" class="absolute top-3 right-3 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity" aria-label="Remove route">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>

        <div class="flex items-center gap-3 mb-2">
          <div class="w-8 h-8 rounded-full ${route.lineClass} flex items-center justify-center shrink-0">${icon}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <h4 class="font-bold text-slate-800 text-sm truncate">${escapeHtml(route.name)}</h4>
              <span class="text-xs font-semibold ${colors.text} whitespace-nowrap">${escapeHtml(status.status)}</span>
            </div>
            <p class="text-xs text-slate-500 truncate">${escapeHtml(route.desc)}${nextArrival ? ' &middot; ' + nextArrival : ''}</p>
          </div>
        </div>

        <div class="mt-3">
          <div class="flex justify-between text-[10px] text-slate-500 mb-1 font-medium">
            <span>Live Crowding Estimate</span>
            <span>${status.crowd == null ? '\u2013' : status.crowd + '%'} Capacity</span>
          </div>
          <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div class="${colors.bar} h-1.5 rounded-full transition-all duration-500" style="width: ${crowdPct}%"></div>
          </div>
          ${status.note ? `<p class="text-xs mt-2 text-slate-600 bg-slate-50 p-1.5 rounded border border-slate-100"><span class="font-semibold">Update:</span> ${escapeHtml(status.note)}</p>` : ''}
        </div>
      </div>`;
    listEl.insertAdjacentHTML('beforeend', html);
  });

  updateStressScore();
  updateMapVisuals();
}

function renderAvailableRoutes() {
  const listEl = document.getElementById('available-routes-list');
  listEl.innerHTML = '';

  allRoutes.forEach((route) => {
    const isSubbed = userSubscriptions.includes(route.id);

    const html = `
      <div class="flex items-center justify-between p-3 border border-slate-100 rounded-xl hover:bg-slate-50 transition-colors cursor-pointer" onclick="toggleSubscription('${route.id}')">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-full ${route.lineClass} flex items-center justify-center text-sm font-bold shadow-sm">${route.name.split(' ')[0]}</div>
          <div>
            <h4 class="font-bold text-slate-800 text-sm">${escapeHtml(route.name)}</h4>
            <p class="text-xs text-slate-500">${escapeHtml(route.desc)}</p>
          </div>
        </div>
        <div class="w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${isSubbed ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 text-transparent'}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
      </div>`;
    listEl.insertAdjacentHTML('beforeend', html);
  });
}

function toggleSubscription(id) {
  if (userSubscriptions.includes(id)) {
    userSubscriptions = userSubscriptions.filter((subId) => subId !== id);
  } else {
    userSubscriptions.push(id);
  }
  renderSubscriptions();
  renderAvailableRoutes(); // Update modal UI if open
}

function updateStressScore() {
  // Combines live crowding + delay signal from the MTA feed across the
  // routes the student is subscribed to into a single 0-100 score.
  if (userSubscriptions.length === 0) {
    setStressMeter(0, '\u2013', 'Add routes to see your stress score.', 'text-slate-400');
    document.getElementById('guardian-rec').innerText = 'Add a route to get a live, data-driven recommendation.';
    return;
  }

  let totalCrowd = 0;
  let knownCount = 0;
  let severeCount = 0;

  userSubscriptions.forEach((id) => {
    const status = liveStatus[id];
    if (!status || status.crowd == null) return;
    totalCrowd += status.crowd;
    knownCount += 1;
    if (status.status === 'Severe Delays') severeCount += 1;
    if (status.status === 'Moderate Delays') severeCount += 0.5;
  });

  if (knownCount === 0) {
    setStressMeter(0, '\u2013', 'Waiting for live MTA data\u2026', 'text-slate-400');
    return;
  }

  const baseScore = totalCrowd / knownCount;
  const finalScore = Math.min(100, Math.round(baseScore + severeCount * 20));

  let desc = '';
  let colorClass = 'text-emerald-500';
  let recText = 'Your standard commute looks smooth. Stick to your usual route.';

  if (finalScore > 75) {
    colorClass = 'text-rose-500';
    desc = 'High stress conditions. Severe delays detected.';
    recText = 'Consider an alternate line, or take a micro-break until conditions improve.';
    cycleMicroBreaks();
  } else if (finalScore > 40) {
    colorClass = 'text-amber-500';
    desc = 'Moderate crowding and delays on your lines.';
    recText = 'Check for a less-crowded alternate line before you head out.';
  } else {
    desc = 'Smooth sailing. Low crowd levels.';
  }

  setStressMeter(finalScore, finalScore.toString(), desc, colorClass);
  document.getElementById('guardian-rec').innerText = recText;
}

function setStressMeter(value, text, desc, colorClass) {
  const meterFill = document.getElementById('stress-meter-fill');
  const scoreText = document.getElementById('stress-score-text');
  const descText = document.getElementById('stress-description');

  // SVG stroke-dasharray max is 100.
  meterFill.setAttribute('stroke-dasharray', `${value}, 100`);
  meterFill.setAttribute('class', `transition-all duration-1000 ease-out ${colorClass}`);

  scoreText.innerText = text;
  descText.innerText = desc;
  descText.className = `text-sm font-medium ${colorClass}`;
}

function updateMapVisuals() {
  // Colors each map node to match the live status of its route, when the
  // user is tracking it; otherwise it stays a neutral gray.
  ['t-1', 't-a', 'b-bx15'].forEach((id) => {
    const node = document.getElementById(`node-${id}`);
    if (!node) return;

    node.classList.remove('status-good', 'status-crowded', 'status-delayed', 'status-unknown', 'node-pulse');

    if (!userSubscriptions.includes(id) || !liveStatus[id]) {
      node.classList.add('status-unknown');
      return;
    }

    const colors = statusColorClasses(liveStatus[id]);
    node.classList.add(colors.node);
    if (liveStatus[id].status === 'Severe Delays') node.classList.add('node-pulse');
  });

  const dNode = document.getElementById('node-t-d');
  if (dNode) {
    dNode.classList.remove('status-good', 'status-crowded', 'status-delayed', 'status-unknown', 'node-pulse');
    if (userSubscriptions.includes('t-d') && liveStatus['t-d']) {
      const colors = statusColorClasses(liveStatus['t-d']);
      dNode.classList.add(colors.node);
      if (liveStatus['t-d'].status === 'Severe Delays') dNode.classList.add('node-pulse');
    } else {
      dNode.classList.add('status-unknown');
    }
  }
}

function cycleMicroBreaks() {
  const breakItem = microBreaks[Math.floor(Math.random() * microBreaks.length)];
  const card = document.getElementById('micro-break-card');

  card.innerHTML = `
    <div class="flex justify-between items-start mb-1">
      <h4 class="font-semibold text-white">${escapeHtml(breakItem.name)}</h4>
      <span class="text-xs bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/30">${escapeHtml(breakItem.status)}</span>
    </div>
    <p class="text-xs text-slate-300 mb-2">${escapeHtml(breakItem.desc)} (${escapeHtml(breakItem.loc)})</p>
    <button class="w-full py-1.5 bg-white/10 hover:bg-white/20 rounded text-xs font-medium transition-colors border border-white/10">
      Route Me Here Instead
    </button>`;
}

// --- Modal Logic ---

function openModal(id) {
  const modal = document.getElementById(id);
  const content = modal.children[1];

  modal.classList.remove('hidden');
  // Trigger reflow so the transition applies.
  void modal.offsetWidth;

  modal.classList.remove('opacity-0');
  content.classList.remove('scale-95');

  if (id === 'add-route-modal') renderAvailableRoutes();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  const content = modal.children[1];

  modal.classList.add('opacity-0');
  content.classList.add('scale-95');

  setTimeout(() => {
    modal.classList.add('hidden');
  }, 200); // Matches duration-200
}

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
  const studentForm = document.getElementById('student-verify-form');
  if (studentForm) {
    studentForm.addEventListener('submit', (event) => {
      event.preventDefault();
      alert('Verification email sent to CCNY address!');
      closeModal('subscription-modal');
    });
  }

  const subscribeBtn = document.getElementById('subscribe-btn');
  if (subscribeBtn) {
    subscribeBtn.addEventListener('click', () => {
      alert('Redirecting to Stripe checkout...');
    });
  }

  renderSubscriptions();
  cycleMicroBreaks();
  refreshLiveStatus();

  pollTimer = setInterval(refreshLiveStatus, POLL_INTERVAL_MS);
});
