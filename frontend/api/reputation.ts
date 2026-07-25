// Explicit Vercel Function entrypoint.
// The shared Express application keeps routing, middleware, and SSE behavior
// identical between local development and Vercel.
export { default, maxDuration } from "../server.js";
