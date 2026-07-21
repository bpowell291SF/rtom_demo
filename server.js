/**
 * Salesforce Personalization Services – Decisioning API
 * @see https://developer.salesforce.com/docs/marketing/einstein-personalization/guide/decisioning-api-reference.html
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

const PERSONALIZATION_CONFIG = {
  baseUrl: (process.env.PERSONALIZATION_BASE_URL || process.env.SALESFORCE_INSTANCE_URL || '').replace(/\/$/, ''),
  tokenEndpoint: process.env.SALESFORCE_TOKEN_ENDPOINT ||
    (process.env.SALESFORCE_INSTANCE_URL ? `${process.env.SALESFORCE_INSTANCE_URL.replace(/\/$/, '')}/services/oauth2/token` : null) ||
    'https://login.salesforce.com/services/oauth2/token',
  clientId: process.env.SALESFORCE_CLIENT_ID || process.env.SALESFORCE_CONSUMER_KEY || '',
  clientSecret: process.env.SALESFORCE_CLIENT_SECRET || process.env.SALESFORCE_CONSUMER_SECRET || '',
  staticAccessToken: process.env.PERSONALIZATION_ACCESS_TOKEN || ''
};

let oauthAccessToken = null;
let tokenExpiry = null;

// D360/CDP token — exchanged from the SF org token
let d360AccessToken = null;
let d360TokenExpiry = null;

function getD360AccessToken() {
  return new Promise((resolve, reject) => {
    if (d360AccessToken && d360TokenExpiry && Date.now() < d360TokenExpiry) {
      return resolve(d360AccessToken);
    }
    // Step 1: get SF org token, then exchange for D360 token
    getValidAccessToken().then((sfToken) => {
      // D360 token exchange happens on the SF org instance URL, not the tenant endpoint
      const orgBase = PERSONALIZATION_CONFIG.tokenEndpoint.replace(/\/services\/oauth2\/token.*$/, '');
      const tokenUrl = new URL('/services/a360/token', orgBase);
      const body = new URLSearchParams({
        grant_type: 'urn:salesforce:grant-type:external:cdp',
        subject_token: sfToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
      }).toString();
      const isHttps = tokenUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      const options = {
        hostname: tokenUrl.hostname,
        port: tokenUrl.port || (isHttps ? 443 : 80),
        path: tokenUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300 && parsed.access_token) {
              d360AccessToken = parsed.access_token;
              d360TokenExpiry = Date.now() + ((parsed.expires_in || 1800) * 1000) - 60000;
              resolve(d360AccessToken);
            } else {
              reject(new Error(parsed.error_description || parsed.error || `D360 token exchange failed: ${res.statusCode} ${data}`));
            }
          } catch (e) { reject(new Error(`Parse D360 token: ${e.message} — ${data}`)); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    }).catch(reject);
  });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getValidAccessToken() {
  return new Promise((resolve, reject) => {
    if (PERSONALIZATION_CONFIG.staticAccessToken) {
      resolve(PERSONALIZATION_CONFIG.staticAccessToken);
      return;
    }

    if (!PERSONALIZATION_CONFIG.clientId || !PERSONALIZATION_CONFIG.clientSecret) {
      reject(new Error('Set SALESFORCE_CLIENT_ID/SECRET (or CONSUMER_KEY/SECRET), or PERSONALIZATION_ACCESS_TOKEN'));
      return;
    }

    if (oauthAccessToken && tokenExpiry && Date.now() < tokenExpiry) {
      resolve(oauthAccessToken);
      return;
    }

    const tokenRequestData = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: PERSONALIZATION_CONFIG.clientId,
      client_secret: PERSONALIZATION_CONFIG.clientSecret
    }).toString();

    const parsedUrl = new URL(PERSONALIZATION_CONFIG.tokenEndpoint);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(tokenRequestData)
      }
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && response.access_token) {
            oauthAccessToken = response.access_token;
            tokenExpiry = Date.now() + ((response.expires_in || 3600) * 1000) - 60000;
            resolve(oauthAccessToken);
          } else {
            reject(new Error(response.error_description || response.error || `Token request failed: ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse token response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(tokenRequestData);
    req.end();
  });
}

// Builds the correct Personalization API request body using the
// dynamicContextVariables + persnlPointName format.
const MDM_TO_UNIFIED = {
  'MDM-RBC-0000006194': '038ea41f2fe02902d874764a2d258da2',
  'MDM-RBC-0000002186': 'e0a32d05fd40da491ab6ef5eca3d68e3',
  'MDM-RBC-0000004975': '38a2c923f8b8bb1c0eadc92263779627',
  'MDM-RBC-0000001463': 'a433e720860d53f81126250a444969c7',
  'MDM-RBC-0000005392': '8485a4fd8c90d30f7a999a82d461dd05',
};

function buildPersnlBody({ individualId, dataspace, channelId, categoryId, pointName, executionFlags }) {
  const unifiedIndividualId = MDM_TO_UNIFIED[individualId];
  return {
    context: {
      individualId,
      ...(unifiedIndividualId && { unifiedIndividualId }),
      ...(dataspace && { dataspace }),
      ...(channelId && { Channel: channelId }),
      ...(categoryId && { Category: categoryId })
    },
    personalizationPoints: [{ name: pointName || DEFAULT_PERSONALIZATION_POINT }],
    ...(executionFlags && executionFlags.length && { executionFlags })
  };
}

function callPersonalizationApi(requestBody) {
  return new Promise((resolve, reject) => {
    if (!PERSONALIZATION_CONFIG.baseUrl) {
      reject(new Error('PERSONALIZATION_BASE_URL (or SALESFORCE_INSTANCE_URL) must be set'));
      return;
    }

    getValidAccessToken()
      .then((accessToken) => {
        const url = new URL('/personalization/decisions', PERSONALIZATION_CONFIG.baseUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const body = JSON.stringify(requestBody);
        const options = {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'Content-Length': Buffer.byteLength(body)
          }
        };
        const req = lib.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = data ? JSON.parse(data) : {};
              if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
              else reject(new Error(parsed.message || parsed.description || data || `HTTP ${res.statusCode}`));
            } catch (e) {
              reject(new Error(data || e.message));
            }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      })
      .catch(reject);
  });
}

app.get('/api/health', (req, res) => {
  const hasOauth = !!(PERSONALIZATION_CONFIG.clientId && PERSONALIZATION_CONFIG.clientSecret);
  const hasStaticToken = !!PERSONALIZATION_CONFIG.staticAccessToken;
  res.json({
    status: 'ok',
    service: 'Salesforce Personalization',
    configured: !!(PERSONALIZATION_CONFIG.baseUrl && (hasOauth || hasStaticToken)),
    authMode: hasStaticToken ? 'static_token' : (hasOauth ? 'oauth_client_credentials' : 'not_configured'),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/personalization/decisions', async (req, res) => {
  try {
    const { context, personalizationPoints, profile, executionFlags } = req.body;
    if (!context || !personalizationPoints || !Array.isArray(personalizationPoints)) {
      return res.status(400).json({
        success: false,
        error: 'Request body must include context and personalizationPoints (array)'
      });
    }
    const { individualId, dataspace, channelId, categoryId } = context;
    const requestBody = buildPersnlBody({
      individualId, dataspace, channelId, categoryId,
      pointName: personalizationPoints[0]?.name,
      executionFlags
    });
    const result = await callPersonalizationApi(requestBody);
    writeDeliveryEvent(result, requestBody.context?.Channel, requestBody.context?.individualId);
    res.json({
      success: true,
      requestId: result.requestId,
      personalizations: result.personalizations || [],
      diagnostics: result.diagnostics
    });
  } catch (error) {
    console.error('Personalization API error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/personalization/request', async (req, res) => {
  try {
    const { individualId, dataspace, personalizationPointName, channelId, categoryId, enableDiagnostics } = req.body;
    if (!individualId) {
      return res.status(400).json({ success: false, error: 'individualId is required' });
    }
    const requestBody = buildPersnlBody({
      individualId,
      dataspace: dataspace || DEFAULT_DATASPACE,
      channelId, categoryId,
      pointName: personalizationPointName,
      executionFlags: enableDiagnostics ? ['EnableDiagnostics'] : []
    });
    const result = await callPersonalizationApi(requestBody);
    writeDeliveryEvent(result, requestBody.context?.Channel, requestBody.context?.individualId);
    res.json({
      success: true,
      requestId: result.requestId,
      personalizations: result.personalizations || [],
      diagnostics: result.diagnostics
    });
  } catch (error) {
    console.error('Personalization request error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * ---------------------------------------------------------------------
 * Offer/Treatment normalization + GET /api/offers
 *
 * Real Decisioning API responses for this org return items shaped like
 * the ssot__*__c fields on the Offer_Treatment object (Name, heading,
 * body text, image URL, CTA text/URL, engagement channel type, id).
 * Some responses may nest these fields under a child object/array
 * (e.g. item.Offer_Treatment) rather than at the item root — unwrapTreatmentFields
 * handles both shapes defensively.
 *
 * NOTE: ssot__OutputText__c / ssot__OutputFormatType__c are intentionally
 * IGNORED here. That field has been observed to contain stale/mismatched
 * pre-rendered HTML from earlier content testing, not reliable live
 * markup. We build our own card markup client-side from the structured
 * fields instead, which also avoids HTML-escaping issues entirely.
 * ---------------------------------------------------------------------
 */
const DEFAULT_DATASPACE = process.env.PERSONALIZATION_DEFAULT_DATASPACE || 'default';
const DEFAULT_PERSONALIZATION_POINT = process.env.PERSONALIZATION_DEFAULT_POINT || 'Borealis_Ranked_Offers_2';

/**
 * Real payload shape (confirmed from a live example): each item in
 * personalizations[i].data[] is an Offer, with rendering fields (heading,
 * body, image, CTA) nested one level down under ssot__OfferTreatment__dlm.
 * The Offer and its Treatment each have their OWN ssot__Id__c — these are
 * different identifiers (Offer ID vs Treatment ID) and must not be
 * conflated. OfferId used for ChannelDeliveryEvent/OfferFeedbackEvent
 * logging should always be the OFFER-level id, to stay consistent with
 * writeDeliveryEvent() (which reads the raw item's root ssot__Id__c directly).
 */
function normalizeOfferTreatment(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;

  const treatment =
    rawItem.ssot__OfferTreatment__dlm ||
    rawItem.Offer_Treatment ||
    rawItem.OfferTreatment ||
    rawItem.offer_treatment ||
    rawItem; // fallback: fields already flat at root (older/alternate shape)

  const offerId = rawItem.ssot__Id__c || null;          // Offer ID (root level — use for OfferId in events)
  const treatmentId = treatment.ssot__Id__c || null;     // Treatment ID (distinct — do NOT use as OfferId)
  const offerName = rawItem.ssot__Name__c || '';         // e.g. "RRSP Acquisition"
  const productCategoryId = (rawItem.ssot__OfferProductCategory__dlm && rawItem.ssot__OfferProductCategory__dlm.ssot__ProductCategoryId__c) || null;

  return {
    id: offerId,
    treatmentId,
    productCategoryId,
    contentId: rawItem.personalizationContentId || null,
    name: offerName || treatment.ssot__Name__c || '',
    heading: treatment.ssot__OfferHeadingText__c || offerName || '',
    body: treatment.ssot__OfferBodyText__c || rawItem.ssot__Description__c || '',
    imageUrl: treatment.ssot__ImageUrl__c || '',
    ctaText: treatment.ssot__CallToActionText__c || 'Learn More',
    ctaUrl: treatment.ssot__CallToActionUrl__c || '#',
    channelTypeId: treatment.ssot__EngagementChannelType__c || null,
    raw: rawItem
  };
}

function dedupeOffersById(offers) {
  const seen = new Set();
  return offers.filter(o => {
    const key = o.id || o.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------
// Category filtering — inferred from a real payload sample: two genuinely
// mortgage-related offers ("First Time Home Buyer with FHSA", "New Mortgage
// Touchpoint") shared ssot__OfferProductCategory__dlm.ssot__ProductCategoryId__c
// = 0ZGHu000000TJEQOA4. This is a REASONABLE INFERENCE FROM A SMALL SAMPLE,
// not a confirmed mapping from your org — please verify this ID against your
// actual Product Category records (or the full offer catalog) and correct
// via the MORTGAGE_PRODUCT_CATEGORY_IDS env var if it's wrong or incomplete
// (comma-separated if there's more than one).
// ---------------------------------------------------------------------
const MORTGAGE_CATEGORY_IDS = (process.env.MORTGAGE_PRODUCT_CATEGORY_IDS || '0ZGHu000000TJEQOA4')
  .split(',').map(s => s.trim()).filter(Boolean);

// Maps anchorType -> allowed category IDs. Only Mortgages is filtered today;
// add more entries here if other pages need the same treatment.
const ANCHOR_CATEGORY_FILTERS = {
  Mortgages: MORTGAGE_CATEGORY_IDS,
};

// GET /api/offers?individualId=...&dataspace=...&anchorType=Offers&requestUrl=...
// Query-param GET wrapper around the same OAuth + Decisioning API call used
// by /api/personalization/request. Returns pre-normalized offer objects
// (see normalizeOfferTreatment) in addition to the raw API response.
app.get('/api/offers', async (req, res) => {
  try {
    const {
      individualId,
      dataspace,
      personalizationPointName,
      personalizationPointId,
      anchorId,
      anchorType,
      requestUrl,
      categoryId,
      enableDiagnostics
    } = req.query;

    if (!individualId) {
      return res.status(400).json({ success: false, error: 'individualId query param is required' });
    }

    const point = {};
    if (personalizationPointId) point.id = personalizationPointId;
    if (personalizationPointName || !personalizationPointId) point.name = personalizationPointName || DEFAULT_PERSONALIZATION_POINT;

    const requestBody = {
      context: {
        individualId,
        dataspace: dataspace || DEFAULT_DATASPACE,
        ...(anchorId && { anchorId }),
        ...(anchorType && { anchorType }),
        ...(requestUrl && { requestUrl })
      },
      personalizationPoints: [point],
      ...(enableDiagnostics === 'true' && { executionFlags: ['EnableDiagnostics'] })
    };

    const result = await callPersonalizationApi(requestBody);
    let rawItems = (result.personalizations && result.personalizations[0] && result.personalizations[0].data) || [];

    // Explicit ?categoryId=... (comma-separated) overrides the anchorType-based
    // default; otherwise fall back to ANCHOR_CATEGORY_FILTERS[anchorType].
    const explicitCategoryIds = categoryId ? categoryId.split(',').map(s => s.trim()).filter(Boolean) : null;
    const filterCategoryIds = explicitCategoryIds || ANCHOR_CATEGORY_FILTERS[anchorType] || null;

    if (filterCategoryIds && filterCategoryIds.length) {
      rawItems = rawItems.filter(item => {
        const catId = item.ssot__OfferProductCategory__dlm && item.ssot__OfferProductCategory__dlm.ssot__ProductCategoryId__c;
        return catId && filterCategoryIds.includes(catId);
      });
      // Keep result.personalizations in sync so writeDeliveryEvent (below)
      // only logs offers actually shown after filtering, not the full
      // unfiltered set Salesforce originally returned.
      if (result.personalizations && result.personalizations[0]) {
        result.personalizations[0].data = rawItems;
      }
    }

    const offers = dedupeOffersById(rawItems.map(normalizeOfferTreatment).filter(Boolean));

    // Log offer views (ChannelDeliveryEvent) — same helper already used by
    // /api/personalization/decisions and /api/personalization/request, just
    // not previously wired into this route. ChannelCode here is the page
    // context (Home/Offers/Mortgages) via anchorType, not a literal channel
    // type like Web/Email/Mobile — see note in chat if that should change.
    writeDeliveryEvent(result, anchorType, individualId);

    res.json({
      success: true,
      requestId: result.requestId,
      offers,
      diagnostics: result.diagnostics,
      raw: result // full untouched response, handy for debugging field mappings
    });
  } catch (error) {
    console.error('GET /api/offers error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Config for the Interactions Web SDK demo page (no secrets — CDN URL is public per connector).
 * @see https://developer.salesforce.com/docs/marketing/einstein-personalization/guide/integrate-salesforce-interactions-sdk.html
 */
function normalizeInteractionsSdkMode(raw) {
  let s = String(raw || '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s.toLowerCase();
}

app.get('/api/personalization/interactions-config', (req, res) => {
  const points = (process.env.INTERACTIONS_PERSONALIZATION_POINTS || 'Offer_Treatment')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cdnUrl = (process.env.INTERACTIONS_SDK_CDN_URL || '').trim();
  const modeEnv = normalizeInteractionsSdkMode(process.env.INTERACTIONS_SDK_MODE);
  const sdkMode =
    modeEnv === 'beacon' || modeEnv === 'standalone'
      ? modeEnv
      : /\/beacon\//i.test(cdnUrl)
        ? 'beacon'
        : 'standalone';
  const identityDelayRaw = parseInt(process.env.INTERACTIONS_IDENTITY_DELAY_MS || '2000', 10);
  const identityDelayMs = Number.isFinite(identityDelayRaw)
    ? Math.min(30000, Math.max(0, identityDelayRaw))
    : 2000;
  const testIndividualId = (process.env.INTERACTIONS_TEST_INDIVIDUAL_ID || '').trim() || null;
  const identityKey = (process.env.INTERACTIONS_IDENTITY_KEY || 'CRMId').trim() || 'CRMId';

  res.json({
    cdnUrl,
    sdkMode,
    dataspace: (process.env.INTERACTIONS_DATASPACE || 'default').trim(),
    personalizationPoints: points.length ? points : ['Offer_Treatment_Personalization'],
    cookieDomain: (process.env.INTERACTIONS_COOKIE_DOMAIN || '').trim() || null,
    skipPersonalizationFetch: process.env.INTERACTIONS_SKIP_PERSONALIZATION_FETCH === 'true',
    testIndividualId,
    identityKey,
    identityDelayMs
  });
});

app.get('/test-site', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test-site.html'));
});

app.get('/interactions-sdk', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'interactions-sdk.html'));
});

app.get('/ads-carousel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ads-carousel.html'));
});

app.get('/ads-carousel-variables', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ads-carousel-variables.html'));
});

app.get('/xero-accounting-software', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'xero-accounting-software.html'));
});

app.get('/offers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'offers.html'));
});

app.get('/mortgages', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mortgages.html'));
});

app.get('/console', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'console.html'));
});

app.get('/offerslog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'offerslog.html'));
});

app.get('/viewlog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewlog.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// RTOM Demo
// ─────────────────────────────────────────────────────────────────────────────

const DC_INGEST_CONFIG = {
  baseUrl: (process.env.DC_INGEST_BASE_URL || PERSONALIZATION_CONFIG.baseUrl || '').replace(/\/$/, ''),
  sourceApiName: process.env.DC_INGEST_SOURCE_API_NAME || '',
  defaultObjectApiName: process.env.DC_INGEST_OBJECT_API_NAME || '',
  tokenEndpoint: process.env.DC_INGEST_TOKEN_ENDPOINT ||
    process.env.SALESFORCE_TOKEN_ENDPOINT ||
    'https://login.salesforce.com/services/oauth2/token',
  clientId: process.env.DC_INGEST_CLIENT_ID || process.env.SALESFORCE_CLIENT_ID || '',
  clientSecret: process.env.DC_INGEST_CLIENT_SECRET || process.env.SALESFORCE_CLIENT_SECRET || ''
};

let ingestAccessToken = null;
let ingestTokenExpiry = null;

function getIngestAccessToken() {
  // IMPORTANT: the Data Cloud Ingestion API requires a CDP-exchanged token
  // (the same kind getD360AccessToken() produces for ChannelDeliveryEvent),
  // NOT a plain Salesforce org access token. When this function's ingest
  // credentials match the Decisioning API's credentials (the common case —
  // DC_INGEST_CLIENT_ID/DC_INGEST_TOKEN_ENDPOINT not separately set), reuse
  // getD360AccessToken() to get a properly-exchanged token, rather than
  // returning the raw org token via getValidAccessToken(). Sending a plain
  // org token to the ingest host is very likely why OfferFeedbackEvent
  // calls were failing with an empty-body HTTP 400 while ChannelDeliveryEvent
  // (which already used getD360AccessToken()) worked.
  const usesSameCredentialsAsDecisioningApi =
    DC_INGEST_CONFIG.clientId === PERSONALIZATION_CONFIG.clientId &&
    DC_INGEST_CONFIG.tokenEndpoint === PERSONALIZATION_CONFIG.tokenEndpoint;

  if (usesSameCredentialsAsDecisioningApi) {
    return getD360AccessToken();
  }

  // NOTE: this branch (distinct DC_INGEST_CLIENT_ID/SECRET configured) does
  // NOT currently perform the CDP token exchange either — it returns a plain
  // org token from these separate credentials. If you ever actually set
  // DC_INGEST_CLIENT_ID to a different connected app, this branch will need
  // the same two-step exchange added (org token -> POST .../services/a360/token)
  // before it will work against the Ingestion API. Flagging this now so it's
  // not a surprise later; not fixed here since it's not your current config.
  return new Promise((resolve, reject) => {
    if (!DC_INGEST_CONFIG.clientId || !DC_INGEST_CONFIG.clientSecret) {
      reject(new Error('DC_INGEST_CLIENT_ID/SECRET not configured'));
      return;
    }
    if (ingestAccessToken && ingestTokenExpiry && Date.now() < ingestTokenExpiry) {
      return resolve(ingestAccessToken);
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: DC_INGEST_CONFIG.clientId,
      client_secret: DC_INGEST_CONFIG.clientSecret
    }).toString();

    const parsedUrl = new URL(DC_INGEST_CONFIG.tokenEndpoint);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.access_token) {
            ingestAccessToken = parsed.access_token;
            ingestTokenExpiry = Date.now() + ((parsed.expires_in || 3600) * 1000) - 60000;
            resolve(ingestAccessToken);
          } else {
            reject(new Error(parsed.error_description || parsed.error || `Token ${res.statusCode}`));
          }
        } catch (e) { reject(new Error(`Parse token: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callIngestApi(objectApiName, records) {
  return new Promise((resolve, reject) => {
    if (!DC_INGEST_CONFIG.baseUrl || !DC_INGEST_CONFIG.sourceApiName) {
      reject(new Error('DC_INGEST_BASE_URL and DC_INGEST_SOURCE_API_NAME must be configured'));
      return;
    }
    getIngestAccessToken().then((token) => {
      const path_ = `/api/v1/ingest/sources/${DC_INGEST_CONFIG.sourceApiName}/${objectApiName}`;
      const url = new URL(path_, DC_INGEST_CONFIG.baseUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const bodyStr = JSON.stringify({ data: records });
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      };
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`callIngestApi(${objectApiName}) failed:`, {
              statusCode: res.statusCode,
              headers: res.headers,
              body: data,
              requestPath: path_,
              requestBody: bodyStr
            });
          }
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
            else reject(new Error(parsed.message || parsed.error_description || data || `HTTP ${res.statusCode} (empty response body — see server log for headers/request details)`));
          } catch (e) { reject(new Error(data || e.message)); }
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    }).catch(reject);
  });
}

/**
 * ---------------------------------------------------------------------
 * Data Cloud Query API (read-only) — separate from the Ingestion API
 * above, which only writes. Reads use POST {baseUrl}/api/v2/query with
 * a raw SQL body, authenticated with the same CDP-exchanged token
 * (getD360AccessToken) used for ingestion.
 *
 * REQUIRES: the connected app also needs the "cdp_query_api" OAuth scope
 * (separate from "cdp_ingest_api", which was added earlier for writes) —
 * you will very likely see the same "requested scope is not allowed"
 * error again until that's added too.
 *
 * REQUIRES: DC_QUERY_OFFER_FEEDBACK_TABLE must be set to the EXACT DLO/DMO
 * name for OfferFeedbackEvent as shown in Data Cloud Setup > Data Explorer
 * (or the Data Streams tab) — Salesforce often truncates/suffixes long
 * object API names, so this is deliberately left unset by default rather
 * than guessing at "ActionChannelDelivery_OfferFeed..." plus whatever
 * suffix (e.g. __dll) your org actually assigned.
 * ---------------------------------------------------------------------
 */
const DC_QUERY_CONFIG = {
  baseUrl: (process.env.DC_QUERY_BASE_URL || DC_INGEST_CONFIG.baseUrl || '').replace(/\/$/, ''),
  offerFeedbackTable: process.env.DC_QUERY_OFFER_FEEDBACK_TABLE || ''
};

function queryDataCloud(sql) {
  return new Promise((resolve, reject) => {
    if (!DC_QUERY_CONFIG.baseUrl) {
      reject(new Error('DC_QUERY_BASE_URL (or DC_INGEST_BASE_URL/PERSONALIZATION_BASE_URL) must be configured'));
      return;
    }
    getD360AccessToken().then((token) => {
      const url = new URL('/api/v2/query', DC_QUERY_CONFIG.baseUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;
      const bodyStr = JSON.stringify({ sql });
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      };
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error('queryDataCloud failed:', { statusCode: res.statusCode, headers: res.headers, body: data, sql });
          }
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
            else reject(new Error(parsed.message || parsed.error_description || data || `HTTP ${res.statusCode}`));
          } catch (e) { reject(new Error(data || e.message)); }
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    }).catch(reject);
  });
}

// Query API V2 returns rows as positional value arrays (e.g. [["a","b"]]),
// with column names/order given separately in a metadata object keyed by
// column name, each entry carrying a placeInOrder index. This converts
// that into plain keyed row objects — { ColumnName: value, ... } — so
// consumers (like viewlog.html) can just read row.ColumnName directly.
function queryRowsToObjects(result) {
  const metadata = result.metadata || {};
  const columns = Object.keys(metadata).sort(
    (a, b) => (metadata[a].placeInOrder || 0) - (metadata[b].placeInOrder || 0)
  );
  const rawRows = result.data || result.rows || [];
  return rawRows.map(row => {
    if (!Array.isArray(row)) return row; // already an object — leave as-is
    const obj = {};
    columns.forEach((col, idx) => { obj[col] = row[idx]; });
    return obj;
  });
}

// GET /api/offers/feedback-log — reads back recent OfferFeedbackEvent rows
// for viewlog.html. Read-only; does not modify anything.
app.get('/api/offers/feedback-log', async (req, res) => {
  try {
    if (!DC_QUERY_CONFIG.offerFeedbackTable) {
      return res.status(400).json({
        success: false,
        error: 'DC_QUERY_OFFER_FEEDBACK_TABLE is not configured. Set it to the exact DLO/DMO name for OfferFeedbackEvent from Data Cloud Setup > Data Explorer.'
      });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    // DLO columns get a __c suffix appended to custom/ingested fields (even
    // though the Ingestion API schema declares them without it) — aliased
    // back to the plain names here so viewlog.html doesn't need to change.
    const sql = `SELECT IndividualId__c AS IndividualId, OfferId__c AS OfferId, Feedback__c AS Feedback, FeedbackReason__c AS FeedbackReason, ChannelCode__c AS ChannelCode, FeedbackEventId__c AS FeedbackEventId, PersonalizationDecisionId__c AS PersonalizationDecisionId, FeedbackTimestamp__c AS FeedbackTimestamp FROM ${DC_QUERY_CONFIG.offerFeedbackTable} ORDER BY FeedbackTimestamp__c DESC LIMIT ${limit}`;
    const result = await queryDataCloud(sql);
    res.json({ success: true, rows: queryRowsToObjects(result), raw: result });
  } catch (error) {
    console.error('GET /api/offers/feedback-log error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Write a ChannelDeliveryEvent record to Data Cloud after each decision
const DELIVERY_SOURCE = process.env.DC_DELIVERY_SOURCE_API_NAME || process.env.DC_INGEST_SOURCE_API_NAME || '';
const DELIVERY_OBJECT = 'ChannelDeliveryEvent';

function writeDeliveryEvent(result, channelId, individualId) {
  const baseUrl = DC_INGEST_CONFIG.baseUrl || PERSONALIZATION_CONFIG.baseUrl;
  if (!DELIVERY_SOURCE || !baseUrl) return;

  const now = new Date().toISOString();
  const records = [];
  for (const p of (result.personalizations || [])) {
    const offers = p.data && p.data.length ? p.data : [{}];
    for (const offer of offers) {
      const contentId = offer.personalizationContentId || '';
      records.push({
        DeliveryEventId: contentId || `${result.requestId || ''}-${p.personalizationId || ''}`.slice(0, 255),
        PersonalizationDecisionId: result.requestId || '',
        ChannelCode: channelId || '',
        OfferId: offer.ssot__Id__c || '',
        IndividualId: individualId || '',
        DeliveryTimestamp: now,
        LastModified: now
      });
    }
  }
  const uniqueRecords = records.filter((r, i, arr) =>
    r.DeliveryEventId && arr.findIndex(x => x.DeliveryEventId === r.DeliveryEventId) === i
  );

  if (!uniqueRecords.length) return;

  // Use D360 token and call ingest directly with the delivery source
  getD360AccessToken().then(token => {
    const url = new URL(`/api/v1/ingest/sources/${DELIVERY_SOURCE}/${DELIVERY_OBJECT}`, baseUrl);
    const bodyStr = JSON.stringify({ data: uniqueRecords });
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };
    const req = lib.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`writeDeliveryEvent: ${uniqueRecords.length} record(s) ingested → ${res.statusCode}`);
        } else {
          console.error(`writeDeliveryEvent: HTTP ${res.statusCode} — ${d.slice(0, 200)}`);
        }
      });
    });
    req.on('error', err => console.error('writeDeliveryEvent request error:', err.message));
    req.write(bodyStr);
    req.end();
  }).catch(err => console.error('writeDeliveryEvent token error:', err.message));
}

/**
 * ---------------------------------------------------------------------
 * OfferFeedbackEvent — logs a customer's response to an offer (Interested /
 * Not Interested / Need More Information / Maybe Later) via the Ingestion
 * API, using the same generic callIngestApi(objectApiName, records) helper
 * already used elsewhere in this file (unlike writeDeliveryEvent, which
 * duplicates the raw HTTP call directly — this reuses the existing helper
 * since it's exactly what it's for).
 *
 * Schema: schemas/OfferFeedbackEvent.yaml
 * ---------------------------------------------------------------------
 */
function writeFeedbackEvent({ decisionId, offerId, individualId, channelId, feedback, feedbackReason }) {
  const now = new Date().toISOString();
  const feedbackEventId = `${offerId || 'unknown'}-${feedback}-${Date.now()}`.slice(0, 255);
  const record = {
    FeedbackEventId: feedbackEventId,
    PersonalizationDecisionId: decisionId || '',
    OfferId: offerId || '',
    IndividualId: individualId || '',
    ChannelCode: channelId || '',
    Feedback: feedback || '',
    FeedbackReason: feedbackReason || '',
    FeedbackTimestamp: now,
    LastModified: now
  };
  return callIngestApi('OfferFeedbackEvent', [record]).then(() => record);
}

const VALID_FEEDBACK_RESPONSES = ['Interested', 'Not Interested', 'Need More Information', 'Maybe Later'];

// POST /api/offers/feedback — called by offerslog.html after a feedback
// link is clicked in the offer modal.
app.post('/api/offers/feedback', async (req, res) => {
  try {
    const { individualId, decisionId, offerId, channelId, response, feedbackReason } = req.body;

    if (!response || !VALID_FEEDBACK_RESPONSES.includes(response)) {
      return res.status(400).json({ success: false, error: `response must be one of: ${VALID_FEEDBACK_RESPONSES.join(', ')}` });
    }
    if (!offerId) {
      return res.status(400).json({ success: false, error: 'offerId is required' });
    }

    const record = await writeFeedbackEvent({
      decisionId, offerId, individualId, channelId, feedback: response, feedbackReason
    });

    res.json({ success: true, logged: record });
  } catch (error) {
    console.error('POST /api/offers/feedback error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Frontend config for RTOM page
app.get('/api/rtom/config', (req, res) => {
  const points = (process.env.RTOM_PERSONALIZATION_POINTS || process.env.PERSONALIZATION_DEFAULT_POINT || 'Offer_Treatment')
    .split(',').map(s => s.trim()).filter(Boolean);
  const eventObjects = (process.env.DC_INGEST_EVENT_OBJECTS || process.env.DC_INGEST_OBJECT_API_NAME || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  res.json({
    defaultDataspace: process.env.PERSONALIZATION_DEFAULT_DATASPACE || 'default',
    personalizationPoints: points,
    simulationMdmIds: [
      process.env.RTOM_SIM_MDM_ID_1 || 'MDM-RBC-0000006194',
      process.env.RTOM_SIM_MDM_ID_2 || 'MDM-RBC-0000001463'
    ],
    ingestConfigured: !!(DC_INGEST_CONFIG.baseUrl && DC_INGEST_CONFIG.sourceApiName),
    ingestSourceApiName: DC_INGEST_CONFIG.sourceApiName,
    eventObjects: eventObjects.length ? eventObjects : (DC_INGEST_CONFIG.defaultObjectApiName ? [DC_INGEST_CONFIG.defaultObjectApiName] : [])
  });
});

// Proxy ingest call to Data Cloud Streaming Ingestion API
app.post('/api/rtom/ingest', async (req, res) => {
  try {
    const { objectApiName, records } = req.body;
    if (!objectApiName || !Array.isArray(records) || !records.length) {
      return res.status(400).json({ success: false, error: 'objectApiName and records[] are required' });
    }
    const result = await callIngestApi(objectApiName, records);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Ingest API error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Dual-ID simulation — calls decisioning API for two individuals in parallel
app.post('/api/rtom/simulate', async (req, res) => {
  try {
    const { mdmId1, mdmId2, dataspace, personalizationPointName, channelId, categoryId } = req.body;
    if (!mdmId1 || !mdmId2) {
      return res.status(400).json({ success: false, error: 'mdmId1 and mdmId2 are required' });
    }

    const makeBody = (individualId) => buildPersnlBody({
      individualId,
      dataspace: dataspace || DEFAULT_DATASPACE,
      channelId, categoryId,
      pointName: personalizationPointName,
      executionFlags: ['EnableDiagnostics']
    });

    const [result1, result2] = await Promise.all([
      callPersonalizationApi(makeBody(mdmId1)).then(r => { writeDeliveryEvent(r, channelId, mdmId1); return r; }),
      callPersonalizationApi(makeBody(mdmId2)).then(r => { writeDeliveryEvent(r, channelId, mdmId2); return r; })
    ]);

    const toSim = (mdmId, result) => {
      const rawItems = (result.personalizations?.[0]?.data) || [];
      const offers = dedupeOffersById(rawItems.map(normalizeOfferTreatment).filter(Boolean));
      return { mdmId, offers, diagnostics: result.diagnostics, requestId: result.requestId };
    };

    res.json({ success: true, sim1: toSim(mdmId1, result1), sim2: toSim(mdmId2, result2) });
  } catch (error) {
    console.error('Simulate error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/rtom', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rtom.html'));
});

app.get('/simulator', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'simulator.html'));
});

// Data Cloud Profile API — fetch data graph for an individual
app.get('/api/profile', async (req, res) => {
  const { individualId, graph } = req.query;
  if (!individualId) return res.status(400).json({ success: false, error: 'individualId is required' });

  try {
    const token = await getD360AccessToken();
    const graphName = graph || process.env.DC_DATA_GRAPH_NAME || 'RTDG4';
    // Use unified individual ID if available (data graph is keyed on unified ID)
    const resolvedId = MDM_TO_UNIFIED[individualId] || individualId;
    const url = new URL(`/api/v1/dataGraph/${encodeURIComponent(graphName)}/${encodeURIComponent(resolvedId)}`, PERSONALIZATION_CONFIG.baseUrl);

    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    };

    const raw = await new Promise((resolve, reject) => {
      const req2 = lib.request(options, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try {
            const parsed = d ? JSON.parse(d) : {};
            if (r.statusCode >= 200 && r.statusCode < 300) resolve(parsed);
            else reject(new Error(parsed.message || parsed.error || `HTTP ${r.statusCode}: ${d}`));
          } catch (e) { reject(new Error(d || e.message)); }
        });
      });
      req2.on('error', reject);
      req2.end();
    });

    // Data graph API wraps the profile in data[0].json_blob__c as a JSON string
    let data = raw;
    if (raw.data && Array.isArray(raw.data) && raw.data[0]?.json_blob__c) {
      try { data = JSON.parse(raw.data[0].json_blob__c); } catch (e) { data = raw; }
    }

    res.json({ success: true, individualId, graph: graphName, data });
  } catch (error) {
    console.error('Profile API error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log('\nSalesforce Personalization – Decisioning API');
  console.log(`Server: http://localhost:${PORT}`);
  const hasOauth = !!(PERSONALIZATION_CONFIG.clientId && PERSONALIZATION_CONFIG.clientSecret);
  const hasStaticToken = !!PERSONALIZATION_CONFIG.staticAccessToken;
  if (!PERSONALIZATION_CONFIG.baseUrl || (!hasOauth && !hasStaticToken)) {
    console.warn('Set PERSONALIZATION_BASE_URL and either OAuth client credentials or PERSONALIZATION_ACCESS_TOKEN in .env');
  } else if (hasOauth) {
    console.log(`OAuth token endpoint: ${PERSONALIZATION_CONFIG.tokenEndpoint}`);
  }
});

module.exports = app;
