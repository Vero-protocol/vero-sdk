/**
 * Test-only helpers, exported via the `@vero-protocol/sdk/testing` subpath.
 *
 * Import from `@vero-protocol/sdk/testing`, never from the main entry point:
 * the main bundle deliberately does not include this module, so consumers'
 * production builds never pay for test fixtures.
 */
export * from './mock-server.js';
