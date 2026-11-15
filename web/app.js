const state = {
  map: null,
  patientLatLng: null,
  patientMarker: null,
  ambulanceMarkers: [],
  hospitalMarkers: [],
  ambulanceRoute: null,
  hospitalRoute: null,
  animatedAmbulance: null,
  bookingStep: 1,
  isBooking: false,
  isSubmitting: false,
  bookingData: {
    emergencyType: "Stroke",
    ambulanceType: "ALS",
    hospitalType: "Government",
    priority: "High",
    patientCount: 1
  },
  hospitalOptions: [],
  latestDispatch: null
};

const ui = {
  locateBtn: document.getElementById("locateBtn"),
  resetBtn: document.getElementById("resetBtn"),
  sosBtn: document.getElementById("sosBtn"),
  bookBtn: document.getElementById("bookBtn"),
  closeBookingBtn: document.getElementById("closeBookingBtn"),
  mainActions: document.getElementById("mainActions"),
  activeMissionActions: document.getElementById("activeMissionActions"),
  activeMissionTitle: document.getElementById("activeMissionTitle"),
  activeMissionSubtext: document.getElementById("activeMissionSubtext"),
  requestSecondAmbBtn: document.getElementById("requestSecondAmbBtn"),
  duplicateModal: document.getElementById("duplicateModal"),
  modalAmbInfo: document.getElementById("modalAmbInfo"),
  modalDismissBtn: document.getElementById("modalDismissBtn"),
  modalConfirmBtn: document.getElementById("modalConfirmBtn"),
  bookingFlow: document.getElementById("bookingFlow"),
  bookingForm: document.getElementById("bookingForm"),
  prevStepBtn: document.getElementById("prevStepBtn"),
  nextStepBtn: document.getElementById("nextStepBtn"),
  reviewHospitalsBtn: document.getElementById("reviewHospitalsBtn"),
  hospitalSelection: document.getElementById("hospitalSelection"),
  hospitalCards: document.getElementById("hospitalCards"),
  sosResult: document.getElementById("sosResult"),
  statusCard: document.getElementById("statusCard"),
  statusModeBadge: document.getElementById("statusModeBadge"),
  statusHeadline: document.getElementById("statusHeadline"),
  assignedAmbulance: document.getElementById("assignedAmbulance"),
  assignedHospital: document.getElementById("assignedHospital"),
  routeDistance: document.getElementById("routeDistance"),
  routeEta: document.getElementById("routeEta"),
  statusSubtext: document.getElementById("statusSubtext"),
  addressInput: document.getElementById("addressInput"),
  landmarkInput: document.getElementById("landmarkInput"),
  patientCountInput: document.getElementById("patientCountInput"),
  priorityInput: document.getElementById("priorityInput")
};

function createMap() {
  const map = L.map("map", {
    zoomControl: false
  }).setView([28.5706, 77.3272], 12);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  map.on("click", (event) => {
    setPatientLocation(event.latlng, true);
  });

  state.map = map;
}

function ambulanceIcon(color) {
  return L.divIcon({
    className: "custom-icon",
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 6px 16px rgba(15,23,42,0.25);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function patientIcon() {
  return L.divIcon({
    className: "custom-icon",
    html: '<div style="width:20px;height:20px;border-radius:50%;background:#0f172a;border:4px solid white;box-shadow:0 6px 16px rgba(15,23,42,0.25);"></div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
}

function hospitalIcon() {
  return L.divIcon({ className: 'hospital-blue-icon', html: '+', iconSize: [30, 30], iconAnchor: [15, 15] });
}

function setPatientLocation(latlng, panToMarker) {
  state.patientLatLng = latlng;
  if (!state.patientMarker) {
    state.patientMarker = L.marker(latlng, { icon: patientIcon() }).addTo(state.map);
  } else {
    state.patientMarker.setLatLng(latlng);
  }

  state.patientMarker.bindPopup("Patient location").openPopup();
  if (panToMarker) {
    state.map.panTo(latlng);
  }

  ui.statusCard.classList.remove("hidden");
  ui.statusSubtext.textContent = "Patient location selected. You can trigger SOS or continue with ambulance booking.";
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function loadBootstrapData() {
  const data = await fetchJson("/api/bootstrap");
  renderAmbulances(data.ambulances);
  renderHospitals(data.hospitals);
}

function renderAmbulances(ambulances) {
  state.ambulanceMarkers.forEach((marker) => marker.remove());
  state.ambulanceMarkers = ambulances.map((ambulance) => {
    const marker = L.marker([ambulance.lat, ambulance.lon], {
      icon: ambulanceIcon(ambulance.available ? "#16a34a" : "#dc2626")
    }).addTo(state.map);
    marker.ambulanceMeta = ambulance;
    marker.bindPopup(`${ambulance.id}<br>${ambulance.type}<br>${ambulance.available ? "Available" : "Busy"}`);
    return marker;
  });
}

function renderHospitals(hospitals) {
  state.hospitalMarkers.forEach((marker) => marker.remove());
  state.hospitalMarkers = hospitals.map((hospital) => {
    const marker = L.marker([hospital.lat, hospital.lon], { icon: hospitalIcon() }).addTo(state.map);
    marker.bindPopup(`<strong>${hospital.name}</strong><br>${hospital.type || 'Hospital'}`);
    return marker;
  });
}

function clearRoutes() {
  if (state.ambulanceRoute) {
    state.map.removeLayer(state.ambulanceRoute);
    state.ambulanceRoute = null;
  }
  if (state.hospitalRoute) {
    state.map.removeLayer(state.hospitalRoute);
    state.hospitalRoute = null;
  }
  if (state.animatedAmbulance) {
    state.map.removeLayer(state.animatedAmbulance);
    state.animatedAmbulance = null;
  }
}

let patientEventSource = null;
let patientPollingTimer = null;

function connectPatientEventStream(dispatchId) {
  if (patientEventSource) {
    patientEventSource.close();
    patientEventSource = null;
  }
  if (patientPollingTimer) {
    clearInterval(patientPollingTimer);
    patientPollingTimer = null;
  }

  patientEventSource = new EventSource('/api/stream/events?dispatchId=' + encodeURIComponent(dispatchId));

  patientEventSource.addEventListener('TELEMETRY_UPDATE', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (state.animatedAmbulance && data.latitude && data.longitude) {
        state.animatedAmbulance.setLatLng([data.latitude, data.longitude]);
      }
      ui.statusHeadline.textContent = "Ambulance En Route (Live Tracking)";
      if (data.speed_kmh) {
        ui.statusSubtext.textContent = `Ambulance is moving at ${data.speed_kmh} km/h toward destination.`;
      }
    } catch (err) {}
  });

  patientEventSource.addEventListener('STATUS_UPDATE', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.status === 'ACCEPTED') {
        ui.statusHeadline.textContent = "Ambulance En Route";
        ui.statusSubtext.textContent = "Paramedic team has accepted and is navigating to you.";
      } else if (data.status === 'REACHED_PATIENT') {
        ui.statusHeadline.textContent = "Ambulance Arrived at Scene";
        ui.statusSubtext.textContent = "Paramedics are on-site providing emergency stabilization.";
      } else if (data.status === 'COMPLETED') {
        ui.statusHeadline.textContent = "Patient Admitted to Hospital";
        ui.statusSubtext.textContent = "Emergency mission successfully completed.";
        try {
          localStorage.removeItem('medway_active_dispatch_id');
          sessionStorage.removeItem('medway_active_dispatch_id');
        } catch (e) {}
        state.latestDispatch = null;
        renderActionBar();
        if (patientEventSource) {
          patientEventSource.close();
          patientEventSource = null;
        }
      }
    } catch (err) {}
  });

  patientPollingTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/dispatch/${dispatchId}/telemetry`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.ambulance && state.animatedAmbulance) {
        state.animatedAmbulance.setLatLng([data.ambulance.lat, data.ambulance.lon]);
      }
      if (data.status === 'COMPLETED') {
        try {
          localStorage.removeItem('medway_active_dispatch_id');
          sessionStorage.removeItem('medway_active_dispatch_id');
        } catch (e) {}
        state.latestDispatch = null;
        renderActionBar();
        clearInterval(patientPollingTimer);
        patientPollingTimer = null;
      }
    } catch (err) {}
  }, 30000); // 30s lazy heartbeat fallback (SSE handles real-time telemetry updates)
}

function drawDispatch(dispatch) {
  clearRoutes();
  state.latestDispatch = dispatch;

  if (dispatch.dispatch_id) {
    try {
      localStorage.setItem('medway_active_dispatch_id', String(dispatch.dispatch_id));
      sessionStorage.setItem('medway_active_dispatch_id', String(dispatch.dispatch_id));
    } catch (e) {}
  }

  const ambulancePoints = dispatch.route.ambulanceToPatient.map((point) => [point.lat, point.lon]);
  const hospitalPoints = dispatch.route.patientToHospital.map((point) => [point.lat, point.lon]);

  state.ambulanceRoute = L.polyline(ambulancePoints, {
    color: "#10b981",
    weight: 6,
    opacity: 0.9
  }).addTo(state.map);

  state.hospitalRoute = L.polyline(hospitalPoints, {
    color: "#2563eb",
    weight: 6,
    opacity: 0.95
  }).addTo(state.map);

  const bounds = L.featureGroup([state.ambulanceRoute, state.hospitalRoute, state.patientMarker]).getBounds().pad(0.18);
  state.map.fitBounds(bounds);

  highlightAssignedAmbulance(dispatch.ambulance);

  // Place active animated ambulance marker on map
  if (state.animatedAmbulance) {
    state.map.removeLayer(state.animatedAmbulance);
  }
  state.animatedAmbulance = L.marker([dispatch.ambulance.lat, dispatch.ambulance.lon], {
    icon: ambulanceIcon("#0284c7"),
    zIndexOffset: 1000
  }).addTo(state.map);

  updateStatus(dispatch);
  renderActionBar();

  if (dispatch.dispatch_id) {
    connectPatientEventStream(dispatch.dispatch_id);
  }
}

function highlightAssignedAmbulance(assignedAmbulance) {
  state.ambulanceMarkers.forEach((marker) => {
    const latlng = marker.getLatLng();
    const isAssigned =
      Math.abs(latlng.lat - assignedAmbulance.lat) < 0.00001 &&
      Math.abs(latlng.lng - assignedAmbulance.lon) < 0.00001;

    const markerColor = isAssigned
      ? "#0ea5e9"
      : marker.ambulanceMeta && marker.ambulanceMeta.available
        ? "#16a34a"
        : "#dc2626";

    marker.setIcon(ambulanceIcon(markerColor));
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function updateStatus(dispatch) {
  ui.statusCard.classList.remove("hidden");
  ui.statusModeBadge.textContent = dispatch.mode;
  ui.statusHeadline.textContent = dispatch.mode === "SOS" ? "Emergency team assigned" : "Booking confirmed";
  ui.assignedAmbulance.textContent = dispatch.ambulance.id;
  ui.assignedHospital.textContent = dispatch.hospital.name;
  ui.routeDistance.textContent = `${dispatch.metrics.distanceKm} km`;
  ui.routeEta.textContent = `${dispatch.metrics.etaMinutes} min`;
  ui.statusSubtext.textContent = `${dispatch.ambulance.type} ambulance is arriving in ${dispatch.ambulance.etaMinutes} mins. Route to ${dispatch.hospital.name} is now active.`;

  ui.sosResult.classList.remove("hidden");
  ui.sosResult.innerHTML = `
    <div class="result-grid">
      <div class="result-tile">
        <span>Assigned Ambulance ID</span>
        <strong>${escapeHtml(dispatch.ambulance.id)}</strong>
      </div>
      <div class="result-tile">
        <span>Hospital Name</span>
        <strong>${escapeHtml(dispatch.hospital.name)}</strong>
      </div>
      <div class="result-tile">
        <span>Distance</span>
        <strong>${escapeHtml(dispatch.metrics.distanceKm)} km</strong>
      </div>
      <div class="result-tile">
        <span>Estimated Time</span>
        <strong>${escapeHtml(dispatch.metrics.etaMinutes)} mins</strong>
      </div>
    </div>
  `;
}

function renderActionBar() {
  const hasActiveMission = state.latestDispatch && state.latestDispatch.status !== 'COMPLETED';

  if (hasActiveMission) {
    ui.mainActions.classList.add("hidden");
    ui.bookingFlow.classList.add("hidden");
    ui.hospitalSelection.classList.add("hidden");
    ui.closeBookingBtn.classList.add("hidden");
    if (ui.activeMissionActions) {
      ui.activeMissionActions.classList.remove("hidden");
      if (ui.activeMissionTitle) {
        const ambNum = state.latestDispatch.ambulance?.vehicle_number || state.latestDispatch.ambulance?.id || 'Vehicle';
        ui.activeMissionTitle.textContent = `Ambulance ${ambNum} En Route`;
      }
      if (ui.activeMissionSubtext) {
        const eta = state.latestDispatch.amb_eta_minutes || state.latestDispatch.metrics?.etaMinutes || 2;
        ui.activeMissionSubtext.textContent = `Active emergency mission #${state.latestDispatch.dispatch_id || ''}. Paramedics arriving in ~${eta} mins.`;
      }
    }
  } else if (state.isBooking) {
    ui.mainActions.classList.add("hidden");
    if (ui.activeMissionActions) ui.activeMissionActions.classList.add("hidden");
    ui.bookingFlow.classList.remove("hidden");
    ui.closeBookingBtn.classList.remove("hidden");
  } else {
    if (ui.activeMissionActions) ui.activeMissionActions.classList.add("hidden");
    ui.bookingFlow.classList.add("hidden");
    ui.closeBookingBtn.classList.add("hidden");
    ui.hospitalSelection.classList.add("hidden");
    ui.mainActions.classList.remove("hidden");
  }
}

function showDuplicateModal() {
  if (!ui.duplicateModal) return;
  const ambId = state.latestDispatch?.ambulance?.vehicle_number || state.latestDispatch?.ambulance?.id || 'Assigned Ambulance';
  const hospName = state.latestDispatch?.hospital?.name || 'Assigned Hospital';
  if (ui.modalAmbInfo) {
    ui.modalAmbInfo.textContent = `${ambId} (Destination: ${hospName})`;
  }
  ui.duplicateModal.classList.remove("hidden");
}

function hideDuplicateModal() {
  if (ui.duplicateModal) {
    ui.duplicateModal.classList.add("hidden");
  }
}

function openBookingFlow() {
  if (state.latestDispatch && state.latestDispatch.status !== 'COMPLETED') {
    showDuplicateModal();
    return;
  }
  state.isBooking = true;
  ui.sosResult.classList.add("hidden");
  renderActionBar();
  updateStepUI();
}

function closeBookingFlow() {
  state.isBooking = false;
  renderActionBar();
}

function updateStepUI() {
  document.querySelectorAll(".step").forEach((stepElement) => {
    const stepValue = Number(stepElement.dataset.step);
    stepElement.classList.toggle("active", stepValue === state.bookingStep);
    stepElement.classList.toggle("completed", stepValue < state.bookingStep);
  });

  document.querySelectorAll(".step-panel").forEach((panel) => {
    panel.classList.toggle("active", Number(panel.dataset.panel) === state.bookingStep);
  });

  ui.prevStepBtn.classList.toggle("hidden", state.bookingStep === 1);
  ui.nextStepBtn.classList.toggle("hidden", state.bookingStep === 5);
  ui.reviewHospitalsBtn.classList.toggle("hidden", state.bookingStep !== 5);
}

function requirePatientLocation() {
  if (state.patientLatLng) {
    return true;
  }
  window.alert("Select the patient location on the map or use your current location first.");
  return false;
}

async function triggerSOS(forceNewDispatch = false) {
  if (!requirePatientLocation()) {
    return;
  }

  // Active Mission Guard: If mission is already active and user didn't explicitly confirm, show modal
  if (!forceNewDispatch && state.latestDispatch && state.latestDispatch.status !== 'COMPLETED') {
    showDuplicateModal();
    return;
  }

  if (state.isSubmitting) {
    return; // Prevent in-flight double taps
  }

  state.isSubmitting = true;
  const originalText = ui.sosBtn.textContent;
  ui.sosBtn.textContent = "🚨 Contacting Paramedics...";
  ui.sosBtn.disabled = true;

  try {
    const url = `/api/sos?lat=${state.patientLatLng.lat}&lon=${state.patientLatLng.lng}&priority=Critical${forceNewDispatch ? '&forceNewDispatch=true' : ''}`;
    const dispatch = await fetchJson(url);
    drawDispatch(dispatch);
    renderActionBar();
  } catch (error) {
    window.alert(error.message);
  } finally {
    state.isSubmitting = false;
    ui.sosBtn.textContent = originalText;
    ui.sosBtn.disabled = false;
    hideDuplicateModal();
  }
}

async function fetchHospitalOptions() {
  if (!requirePatientLocation()) {
    return;
  }

  state.bookingData.priority = ui.priorityInput.value;
  state.bookingData.patientCount = Number(ui.patientCountInput.value);
  state.bookingData.address = ui.addressInput.value.trim();
  state.bookingData.landmark = ui.landmarkInput.value.trim();

  try {
    const params = new URLSearchParams({
      lat: state.patientLatLng.lat,
      lon: state.patientLatLng.lng,
      priority: state.bookingData.priority || 'High',
      emergencyType: state.bookingData.emergencyType || '',
      ambulanceType: state.bookingData.ambulanceType || '',
      hospitalType: state.bookingData.hospitalType || ''
    });

    const data = await fetchJson(`/api/hospitals?${params.toString()}`);
    state.hospitalOptions = data.options;
    renderHospitalCards();
  } catch (error) {
    window.alert(error.message);
  }
}

function renderHospitalCards() {
  ui.hospitalSelection.classList.remove("hidden");
  ui.hospitalCards.innerHTML = state.hospitalOptions.map((hospital, index) => {
    const isSelected = index === 0;
    const badgeText = hospital.isRecommended
      ? "⭐ Best Clinical Match"
      : (hospital.triageRecommendation || "Alternative Option");

    const bedsCount = (hospital.availableBeds !== undefined && hospital.availableBeds !== null) ? hospital.availableBeds : 0;
    const icuCount = (hospital.availableIcuBeds !== undefined && hospital.availableIcuBeds !== null) ? hospital.availableIcuBeds : 0;
    const bedColor = bedsCount > 0 ? "var(--green)" : "#ef4444";

    const capsBadge = (hospital.capabilities && hospital.capabilities.length > 0)
      ? hospital.capabilities.slice(0, 3).join(" • ")
      : "General Emergency Care";

    return `
      <button class="hospital-card ${isSelected ? "selected" : ""}" type="button" data-hospital-id="${escapeHtml(hospital.id)}">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">
          <h4 style="margin:0; font-size:1.02rem;">${escapeHtml(hospital.name)}</h4>
          <span class="selection-badge" style="font-size:0.75rem; padding:3px 8px; white-space:nowrap; background:${isSelected ? 'rgba(37,99,235,0.12)' : 'rgba(148,163,184,0.15)'}; color:${isSelected ? 'var(--blue)' : 'var(--text)'};">${escapeHtml(badgeText)}</span>
        </div>
        <p style="font-size:0.82rem; color:var(--muted); margin:4px 0;">🏥 ${escapeHtml(hospital.type || 'Hospital')} • ${escapeHtml(capsBadge)}</p>
        <p style="font-size:0.85rem; color:${bedColor}; font-weight:600; margin:4px 0;">
          🛏️ ${bedsCount} beds (${icuCount} ICU)
        </p>
        <div class="hospital-meta" style="margin-top:10px;">
          <strong>📍 ${escapeHtml(hospital.distanceKm)} km</strong>
          <strong>⏱️ ${escapeHtml(hospital.etaMinutes)} min</strong>
        </div>
      </button>
    `;
  }).join("");

  ui.hospitalCards.querySelectorAll(".hospital-card").forEach((card) => {
    card.addEventListener("click", async () => {
      ui.hospitalCards.querySelectorAll(".hospital-card").forEach((item) => item.classList.remove("selected"));
      card.classList.add("selected");
      await confirmBooking(card.dataset.hospitalId);
    });
  });
}

async function confirmBooking(hospitalId) {
  if (state.isSubmitting) return;
  state.isSubmitting = true;

  try {
    const payload = {
      lat: state.patientLatLng.lat,
      lon: state.patientLatLng.lng,
      hospitalId,
      priority: state.bookingData.priority,
      address: state.bookingData.address,
      landmark: state.bookingData.landmark,
      emergencyType: state.bookingData.emergencyType,
      ambulanceType: state.bookingData.ambulanceType,
      hospitalType: state.bookingData.hospitalType,
      patientCount: state.bookingData.patientCount
    };

    const dispatch = await fetchJson("/api/book", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    drawDispatch(dispatch);
    state.isBooking = false;
    renderActionBar();
    ui.sosResult.classList.remove("hidden");
  } catch (error) {
    window.alert(error.message);
  } finally {
    state.isSubmitting = false;
  }
}

function resetApp() {
  clearRoutes();
  sessionStorage.removeItem('medway_active_dispatch_id');
  state.hospitalOptions = [];
  state.latestDispatch = null;
  state.isBooking = false;
  state.isSubmitting = false;
  if (state.patientMarker) {
    state.map.removeLayer(state.patientMarker);
    state.patientMarker = null;
  }
  state.patientLatLng = null;
  ui.bookingForm.reset();
  ui.priorityInput.value = "High";
  ui.patientCountInput.value = "1";
  state.bookingStep = 1;
  resetChoiceCards();
  renderActionBar();
  updateStepUI();
  ui.sosResult.classList.add("hidden");
  ui.statusCard.classList.add("hidden");
  ui.statusHeadline.textContent = "Awaiting action";
  ui.assignedAmbulance.textContent = "--";
  ui.assignedHospital.textContent = "--";
  ui.routeDistance.textContent = "--";
  ui.routeEta.textContent = "--";
  ui.statusSubtext.textContent = "Select a location on the map or use your current location to start.";
  loadBootstrapData().catch(() => {});
}

function bindChoiceCards() {
  document.querySelectorAll(".choice-card").forEach((button) => {
    button.addEventListener("click", () => {
      const container = button.parentElement;
      container.querySelectorAll(".choice-card").forEach((item) => item.classList.remove("selected"));
      button.classList.add("selected");
      state.bookingData[button.dataset.field] = button.dataset.value;
    });
  });
}

function resetChoiceCards() {
  document.querySelectorAll(".choice-grid").forEach((group) => {
    const cards = group.querySelectorAll(".choice-card");
    cards.forEach((card, index) => {
      card.classList.toggle("selected", index === 0);
      if (index === 0) {
        state.bookingData[card.dataset.field] = card.dataset.value;
      }
    });
  });
}

function bindEvents() {
  ui.locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      window.alert("Geolocation is not supported in this browser.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
        setPatientLocation(latlng, true);
      },
      () => {
        window.alert("Unable to fetch your location.");
      }
    );
  });

  ui.resetBtn.addEventListener("click", resetApp);
  ui.sosBtn.addEventListener("click", () => triggerSOS(false));
  ui.bookBtn.addEventListener("click", openBookingFlow);
  ui.closeBookingBtn.addEventListener("click", closeBookingFlow);

  if (ui.requestSecondAmbBtn) {
    ui.requestSecondAmbBtn.addEventListener("click", () => {
      showDuplicateModal();
    });
  }

  if (ui.modalDismissBtn) {
    ui.modalDismissBtn.addEventListener("click", () => {
      hideDuplicateModal();
    });
  }

  if (ui.modalConfirmBtn) {
    ui.modalConfirmBtn.addEventListener("click", async () => {
      await triggerSOS(true);
    });
  }

  ui.prevStepBtn.addEventListener("click", () => {
    state.bookingStep = Math.max(1, state.bookingStep - 1);
    updateStepUI();
  });

  ui.nextStepBtn.addEventListener("click", () => {
    state.bookingStep = Math.min(5, state.bookingStep + 1);
    updateStepUI();
  });

  ui.bookingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await fetchHospitalOptions();
  });

  bindChoiceCards();
}

async function init() {
  createMap();
  bindEvents();
  renderActionBar();
  updateStepUI();
  await loadBootstrapData();

  // Restore Active Mission Session (if page reloaded while ambulance en route)
  let savedDispatchId = null;
  try {
    savedDispatchId = localStorage.getItem('medway_active_dispatch_id') || sessionStorage.getItem('medway_active_dispatch_id');
  } catch (e) {}

  if (savedDispatchId) {
    try {
      const res = await fetch(`/api/dispatch/${encodeURIComponent(savedDispatchId)}/telemetry`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.status !== 'COMPLETED' && data.ambulance && data.patient) {
          setPatientLocation(L.latLng(data.patient.lat, data.patient.lon), false);
          drawDispatch(data);
        } else {
          try {
            localStorage.removeItem('medway_active_dispatch_id');
            sessionStorage.removeItem('medway_active_dispatch_id');
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('Failed to restore active dispatch session:', e);
    }
  }
}

init().catch((error) => {
  ui.statusCard.classList.remove("hidden");
  ui.statusHeadline.textContent = "Backend connection failed";
  ui.statusSubtext.textContent = error.message;
});
