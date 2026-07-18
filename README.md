# RTOM Retail Banking - Salesforce Personalization

Web app and backend services for **Salesforce Personalization** (Decisioning API) – request personalized content from Data Cloud.

- [Salesforce Help – Personalization](https://help.salesforce.com/s/articleView?id=mktg.mc_persnl.htm&type=5)
- [Decisioning API – Request personalization](https://developer.salesforce.com/docs/marketing/einstein-personalization/guide/decisioning-api-request-personalization.html)
- [Decisioning API reference](https://developer.salesforce.com/docs/marketing/einstein-personalization/guide/decisioning-api-reference.html)

## What’s included

- **Backend (Node/Express)**  
  - `POST /api/personalization/decisions` – full Decisioning API body (context + personalizationPoints).  
  - `POST /api/personalization/request` – simplified body (individualId, dataspace, personalization point name or id, optional anchor/URL/diagnostics).  
  - `GET /api/health` – health and config check.

- **Web page**  
  - Form: Individual ID, Dataspace, Personalization point (name or ID), optional Anchor ID/Type, Request URL, Enable diagnostics.  
  - Calls `/api/personalization/request` and shows response (requestId, personalizations, raw JSON).

- **Interactions Web SDK demo** (`/interactions-sdk`)  
  - Loads the Salesforce Interactions SDK from `INTERACTIONS_SDK_CDN_URL` (from your [website connector Integration Guide](https://developer.salesforce.com/docs/marketing/einstein-personalization/guide/integrate-salesforce-interactions-sdk.html)), initializes consent + dataspace, registers an inline sitemap with content zones, calls `Personalization.fetch`, and demonstrates `sendEvent` for click-style catalog interactions.  
  - Config JSON: `GET /api/personalization/interactions-config` (dataspace, points, cookie domain; no secrets).  
  - Help: [Web Personalization Manager](https://help.salesforce.com/s/articleView?id=mktg.persnl_web_personalization_manager.htm&type=5).

## Setup

1. **Install dependencies**
   ```bash
   cd Salesforce-Personalization
   npm install
   ```

2. **Configure environment**
   - Copy `.env.example` to `.env`.
   - Set **PERSONALIZATION_BASE_URL** (Data Cloud tenant endpoint, no trailing slash).
   - Preferred auth (OAuth2 Client Credentials, like `Football-Throw-Game`):
     - **SALESFORCE_CLIENT_ID**
     - **SALESFORCE_CLIENT_SECRET**
     - Optional: **SALESFORCE_TOKEN_ENDPOINT** (otherwise defaults to `https://login.salesforce.com/services/oauth2/token`)
   - Optional fallback auth:
     - **PERSONALIZATION_ACCESS_TOKEN** (static bearer token)
   - Optional: **PORT** (default `3001`).

3. **Run**
   ```bash
   npm start
   ```
   Open `http://localhost:3001`.

## API usage

### Simplified: `POST /api/personalization/request`

```json
{
  "individualId": "001xx000001AbC",
  "dataspace": "Banking",
  "personalizationPointName": "Homepage_Offers",
  "anchorId": "optional",
  "anchorType": "optional",
  "requestUrl": "https://bank.example/offers",
  "enableDiagnostics": false
}
```

Either `personalizationPointName` or `personalizationPointId` is required.

### Full: `POST /api/personalization/decisions`

Full [Decisioning API](https://developer.salesforce.com/docs/marketing/einstein-personalization/guide/decisioning-api-request-personalization.html) shape: **context** (required), **personalizationPoints** (required array), optional **profile**, **executionFlags**.


## Deployment

See GITHUB-HEROKU-AUTODEPLOY.md for GitHub-connected Heroku auto-deploy setup.


## Deploy Test Page

Use `/test-site` to verify GitHub -> Heroku auto-deploy is live.
It fetches `/api/health` and shows a build marker (`RTOM-DEPLOY-TEST-v1`).
