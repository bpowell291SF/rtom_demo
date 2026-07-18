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
    const requestBody = {
      context: { ...context },
      personalizationPoints: personalizationPoints.map(pt => ({ id: pt.id, name: pt.name, decisionId: pt.decisionId })),
      ...(profile && { profile }),
      ...(executionFlags && executionFlags.length && { executionFlags })
    };
    const result = await callPersonalizationApi(requestBody);
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
    const { individualId, dataspace, personalizationPointName, personalizationPointId, anchorId, anchorType, requestUrl, enableDiagnostics } = req.body;
    if (!individualId || !dataspace) {
      return res.status(400).json({ success: false, error: 'individualId and dataspace are required' });
    }
    const point = {};
    if (personalizationPointId) point.id = personalizationPointId;
    if (personalizationPointName) point.name = personalizationPointName;
    if (Object.keys(point).length === 0) {
      return res.status(400).json({ success: false, error: 'Provide personalizationPointName or personalizationPointId' });
    }
    const requestBody = {
      context: { individualId, dataspace, ...(anchorId && { anchorId }), ...(anchorType && { anchorType }), ...(requestUrl && { requestUrl }) },
      personalizationPoints: [point],
      ...(enableDiagnostics && { executionFlags: ['EnableDiagnostics'] })
    };
    const result = await callPersonalizationApi(requestBody);
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
const DEFAULT_PERSONALIZATION_POINT = process.env.PERSONALIZATION_DEFAULT_POINT || 'Offer_Treatment_Personalization';

function unwrapTreatmentFields(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.ssot__Name__c || item.ssot__OfferHeadingText__c || item.ssot__OfferBodyText__c) {
    return item; // fields already live at the item root
  }
  const nested = item.Offer_Treatment || item.OfferTreatment || item.offer_treatment;
  if (Array.isArray(nested) && nested.length) return { ...item, ...nested[0] };
  if (nested && typeof nested === 'object') return { ...item, ...nested };
  return item;
}

function normalizeOfferTreatment(rawItem) {
  const item = unwrapTreatmentFields(rawItem);
  if (!item) return null;
  return {
    id: item.ssot__Id__c || item.personalizationContentId || null,
    contentId: item.personalizationContentId || null,
    name: item.ssot__Name__c || '',
    heading: item.ssot__OfferHeadingText__c || item.ssot__Name__c || '',
    body: item.ssot__OfferBodyText__c || '',
    imageUrl: item.ssot__ImageUrl__c || '',
    ctaText: item.ssot__CallToActionText__c || 'Learn More',
    ctaUrl: item.ssot__CallToActionUrl__c || '#',
    channelTypeId: item.ssot__EngagementChannelType__c || null,
    raw: item
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
    const rawItems = (result.personalizations && result.personalizations[0] && result.personalizations[0].data) || [];
    const offers = dedupeOffersById(rawItems.map(normalizeOfferTreatment).filter(Boolean));

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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
