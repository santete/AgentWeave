// Gateway
export { GatewayServer } from "./gateway";
export type { GatewayConfig } from "./gateway";

// Server (advanced usage)
export { AWOCPServer } from "./server";
export type { AWOCPServerConfig, ClientConnection, InterceptHandler, EventHandler } from "./server";

// REST API
export { RestApi } from "./rest-api";
export type { RestApiConfig } from "./rest-api";

// Auth
export { verifyAuth, signJWT, verifyJWT, issueToken } from "./auth";
export type { AuthConfig, Role, JWTPayload } from "./auth";
