# ADR-026: Territory Map Rendering and Infrastructure

## Context
We need to render the signed-in user's territory on a map. MapLibre was chosen as our mapping SDK, relying on a vector tile endpoint (GET /v1/territories/tiles/{z}/{x}/{y}.mvt) that returns all active territories.

## Decisions

### 1. No Base Map Provider
We are rendering territories over a plain background. We deliberately chose not to include Mapbox, Google Maps, or any keyed tile service. Adopting a base map requires an account and API keys, which has not yet been agreed upon. A full base map is a later product decision.

### 2. Tile Authentication
The MapLibre SDK does not automatically attach bearer tokens to tile requests. We installed an OkHttp interceptor via HttpRequestUtil.setOkHttpClient to intercept and attach the Authorization: Bearer <DEV_JWT> header to all outgoing tile requests.

### 3. JWT Payload Decoding
The client extracts the user ID (sub) by decoding the JWT payload directly, without verifying its signature. This is safe because:
- The client never trusts this ID for authoritative operations.
- Signature verification is solely the server's responsibility.
- Shipping the JWT secret to the client would compromise the entire backend's security boundary.

### 4. 16 KB Page Requirement
Modern Android emulators and devices (API 37+) utilize 16 KB memory pages. MapLibre Android was chosen specifically because versions 11.2.0 and later contain native libraries compiled with 16 KB page alignment.

### 5. iOS Pending Hardware
iOS implementation for the map rendering is explicitly recorded as pending, due to the lack of available Mac hardware for compilation.