process.env.NODE_ENV = 'test';
// Tests truncate tables, so they never use DATABASE_URL (which may point at real data).
const testUrl = process.env.TEST_DATABASE_URL ?? 'postgres://radar:radar@localhost:5432/radar_test';
if (!/test/i.test(new URL(testUrl).pathname)) {
  throw new Error(`Refusing to run tests against "${new URL(testUrl).pathname}": the test database name must contain "test".`);
}
process.env.DATABASE_URL = testUrl;
process.env.SESSION_SECRET ??= 'test-secret-0123456789abcdef0123456789abcdef';
process.env.APP_ORIGIN ??= 'http://localhost:5173';
process.env.SOURCE_CONTACT ??= 'test@example.com';
