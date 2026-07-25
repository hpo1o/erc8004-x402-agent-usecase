// Explicit Vercel Function entrypoint.
// Generated deployment URLs may be protected and return HTML to server calls.
// Vercel exposes the public production domain in every deployment.
if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
  process.env.VERCEL_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL;
}

// The shared Express application keeps routing, middleware, and SSE behavior
// identical between local development and Vercel.
export { default, maxDuration } from "../server.js";
