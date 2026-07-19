/**
 * RBC shared demo logic — used by index.html, offers.html, mortgages.html
 *
 * CONFIG YOU SHOULD CONFIRM / ADJUST:
 * - DATASPACE: sent as the "dataspace" context field. Currently 'default' —
 *   confirm this matches your org (README example used "Banking").
 *   Can also be overridden per call without editing this file by adding
 *   ?dataspace=Banking to the page URL.
 * - individualId: currently uses each persona's customerId (MDM-RBC-...).
 *   Confirm this is the correct value your Decisioning API expects for
 *   "individualId" (it may need to be a separate Salesforce Individual/
 *   Party Id instead — check a raw response's requestId/diagnostics if
 *   results look wrong).
 * - Personalization Point name: left unset here, so the server falls back
 *   to PERSONALIZATION_DEFAULT_POINT (env) or 'Offer_Treatment_Personalization'.
 *   Override per call with ?point=Your_Point_Name if needed.
 */

const RBC_CONFIG = {
  dataspace: 'default',
};

// TODO: replace with your 5 real personas if this list changes.
const PERSONAS = [
  { id: 'persona-1', name: 'Veronica Robles',   customerId: 'MDM-RBC-0000006194', segment: 'Young Professional' },
  { id: 'persona-2', name: 'Guillaume Bouchard', customerId: 'MDM-RBC-0000002186', segment: 'New Homeowner' },
  { id: 'persona-3', name: 'Benjamin Trevino',  customerId: 'MDM-RBC-0000004975', segment: 'Small Business Owner' },
  { id: 'persona-4', name: 'Elizabeth Barrett', customerId: 'MDM-RBC-0000001463', segment: 'Retiree' },
  { id: 'persona-5', name: 'Kevin Webb',        customerId: 'MDM-RBC-0000005392', segment: 'Student' },
];

// ---------------------------------------------------------------------
// Session state (persists across index.html / offers.html / mortgages.html
// navigations within the same browser tab — this is a real multi-page
// site, so sessionStorage is the right tool, unlike a single-page artifact).
// ---------------------------------------------------------------------
const STATE_KEY = 'rbc-demo-state';

function getState() {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore malformed state */ }
  return { personaId: PERSONAS[0].id, signedIn: false };
}

function setState(partial) {
  const next = { ...getState(), ...partial };
  sessionStorage.setItem(STATE_KEY, JSON.stringify(next));
  return next;
}

function currentPersona() {
  const state = getState();
  return PERSONAS.find(p => p.id === state.personaId) || PERSONAS[0];
}

// ---------------------------------------------------------------------
// API call — GET /api/offers (query params, credentials stay server-side)
// ---------------------------------------------------------------------
async function fetchOffers({ anchorType, anchorId, requestUrl } = {}) {
  const state = getState();
  const persona = currentPersona();

  if (!state.signedIn) {
    // Anonymous: no individualId to send. Depending on how your
    // Personalization Point / decision strategy is configured, an
    // anonymous request may return default/fallback content or nothing.
    // Adjust this branch once you confirm how your org handles anonymous
    // decisioning requests.
    return { offers: [], anonymous: true };
  }

  const params = new URLSearchParams({
    individualId: persona.customerId,
    dataspace: RBC_CONFIG.dataspace,
  });
  if (anchorType) params.set('anchorType', anchorType);
  if (anchorId) params.set('anchorId', anchorId);
  if (requestUrl) params.set('requestUrl', requestUrl);

  // Allow ?dataspace= / ?point= overrides from the page URL for quick testing
  // without editing this file.
  const pageParams = new URLSearchParams(window.location.search);
  if (pageParams.get('dataspace')) params.set('dataspace', pageParams.get('dataspace'));
  if (pageParams.get('point')) params.set('personalizationPointName', pageParams.get('point'));

  const res = await fetch('/api/offers?' + params.toString());
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Request failed');
  return { offers: data.offers || [], requestId: data.requestId, raw: data.raw, anonymous: false };
}

// ---------------------------------------------------------------------
// Rendering: header chrome (nav sign-in button, status banner, persona select)
// ---------------------------------------------------------------------
function renderHeaderChrome() {
  const state = getState();
  const persona = currentPersona();

  const personaSelect = document.getElementById('persona-select');
  if (personaSelect && !personaSelect.dataset.populated) {
    PERSONAS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.customerId}) — ${p.segment}`;
      personaSelect.appendChild(opt);
    });
    personaSelect.dataset.populated = 'true';
  }
  if (personaSelect) personaSelect.value = state.personaId;

  const authStatus = document.getElementById('auth-status');
  if (authStatus) {
    authStatus.textContent = state.signedIn
      ? `Signed in: ${persona.name} (${persona.customerId})`
      : 'Anonymous';
  }

  const signInBtn = document.getElementById('sign-in-btn');
  const signOutBtn = document.getElementById('sign-out-btn');
  if (signInBtn) signInBtn.classList.toggle('hidden', state.signedIn);
  if (signOutBtn) signOutBtn.classList.toggle('hidden', !state.signedIn);

  const headerSignInBtn = document.getElementById('header-signin-btn');
  if (headerSignInBtn) headerSignInBtn.textContent = state.signedIn ? persona.name.split(' ')[0] : 'Sign In';

  const bannerText = document.getElementById('status-banner-text');
  if (bannerText) {
    bannerText.textContent = state.signedIn
      ? `Welcome back, ${persona.name}. Here are offers picked for you.`
      : "You're browsing as a guest — sign in to see offers tailored to your accounts.";
  }
}

function wireHeaderControls(onChange) {
  const personaSelect = document.getElementById('persona-select');
  const signInBtn = document.getElementById('sign-in-btn');
  const signOutBtn = document.getElementById('sign-out-btn');
  const headerSignInBtn = document.getElementById('header-signin-btn');

  if (personaSelect) {
    personaSelect.addEventListener('change', () => {
      setState({ personaId: personaSelect.value, signedIn: false }); // switching persona resets to anonymous
      renderHeaderChrome();
      if (onChange) onChange();
    });
  }
  function doSignIn() { setState({ signedIn: true }); renderHeaderChrome(); if (onChange) onChange(); }
  function doSignOut() { setState({ signedIn: false }); renderHeaderChrome(); if (onChange) onChange(); }

  if (signInBtn) signInBtn.addEventListener('click', doSignIn);
  if (signOutBtn) signOutBtn.addEventListener('click', doSignOut);
  if (headerSignInBtn) headerSignInBtn.addEventListener('click', () => {
    getState().signedIn ? doSignOut() : doSignIn();
  });
}

// ---------------------------------------------------------------------
// Rendering: offer cards (built from real, structured API fields only —
// never from ssot__OutputText__c)
// ---------------------------------------------------------------------
function renderSkeleton(containerEl, count) {
  containerEl.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const s = document.createElement('div');
    s.className = 'skeleton';
    containerEl.appendChild(s);
  }
}

function renderStateMessage(containerEl, message, isError) {
  containerEl.innerHTML = `<div class="state-message${isError ? ' error' : ''}">${message}</div>`;
}

function renderOfferCards(containerEl, offers) {
  containerEl.innerHTML = '';
  offers.forEach(offer => {
    const card = document.createElement('div');
    card.className = 'offer-card';
    const imageBlock = offer.imageUrl
      ? `<img src="${offer.imageUrl}" alt="${offer.heading || offer.name}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'fallback-icon\\'>🏦</div>'">`
      : `<div class="fallback-icon">🏦</div>`;
    card.innerHTML = `
      <div class="offer-card-image">${imageBlock}</div>
      <div class="offer-card-body">
        <h3>${offer.heading || offer.name}</h3>
        <p class="offer-card-summary">${offer.body}</p>
        <button type="button" class="btn btn-primary quick-view-btn" data-offer-id="${offer.id}">${offer.ctaText || 'View Details'}</button>
      </div>`;
    containerEl.appendChild(card);
  });

  containerEl.querySelectorAll('.quick-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const offer = offers.find(o => String(o.id) === btn.dataset.offerId);
      if (offer) openQuickView(offer);
    });
  });
}

// ---------------------------------------------------------------------
// Offer feedback — 4 responses, logged server-side (POST /api/offers/feedback),
// then the customer lands on offerslog.html?response=... which shows a
// confirmation message. Link-based (not AJAX-only) so this also works from
// a static channel like email, where there's no JS to run.
// ---------------------------------------------------------------------
const FEEDBACK_OPTIONS = [
  { value: 'interested',      label: 'Interested' },
  { value: 'not_interested',  label: 'Not Interested' },
  { value: 'need_more_info',  label: 'Need More Information' },
  { value: 'maybe_later',     label: 'Maybe Later' },
];

function buildOfferLogUrl(offer, responseValue, channel) {
  const persona = currentPersona();
  const state = getState();
  const params = new URLSearchParams({
    response: responseValue,
    offerId: offer.id || '',
    contentId: offer.contentId || '',
    individualId: state.signedIn ? persona.customerId : '',
    dataspace: RBC_CONFIG.dataspace,
    channel: channel || 'unknown',
    offerName: offer.heading || offer.name || '',
  });
  return '/offerslog.html?' + params.toString();
}


function ensureModalMounted() {
  if (document.getElementById('rbc-modal-backdrop')) return;
  const div = document.createElement('div');
  div.id = 'rbc-modal-backdrop';
  div.className = 'modal-backdrop';
  div.innerHTML = `
    <div class="modal-panel">
      <div class="modal-panel-inner">
        <button class="modal-close" id="rbc-modal-close" aria-label="Close">&times;</button>
        <div class="modal-image" id="rbc-modal-image"></div>
        <div class="modal-body">
          <h3 id="rbc-modal-heading"></h3>
          <p id="rbc-modal-body"></p>
          <a id="rbc-modal-cta" class="btn btn-primary" target="_blank" rel="noopener">Learn More</a>
          <div class="modal-feedback">
            <p class="modal-feedback-label">What do you think of this offer?</p>
            <div class="modal-feedback-buttons" id="rbc-modal-feedback"></div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(div);
  div.addEventListener('click', (e) => { if (e.target === div) closeQuickView(); });
  document.getElementById('rbc-modal-close').addEventListener('click', closeQuickView);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeQuickView(); });
}

function openQuickView(offer) {
  ensureModalMounted();
  document.getElementById('rbc-modal-image').innerHTML = offer.imageUrl
    ? `<img src="${offer.imageUrl}" alt="${offer.heading}">`
    : '';
  document.getElementById('rbc-modal-heading').textContent = offer.heading || offer.name;
  document.getElementById('rbc-modal-body').textContent = offer.body;
  const cta = document.getElementById('rbc-modal-cta');
  cta.textContent = offer.ctaText || 'Learn More';
  cta.href = offer.ctaUrl || '#';

  const channel = getState().channel || 'unknown';
  const feedbackEl = document.getElementById('rbc-modal-feedback');
  feedbackEl.innerHTML = FEEDBACK_OPTIONS.map(opt =>
    `<a href="${buildOfferLogUrl(offer, opt.value, channel)}" class="btn btn-outline feedback-btn">${opt.label}</a>`
  ).join('');

  document.getElementById('rbc-modal-backdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeQuickView() {
  const el = document.getElementById('rbc-modal-backdrop');
  if (el) el.classList.remove('open');
  document.body.style.overflow = '';
}
