process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgres://radar:radar@localhost:5432/radar_test';
process.env.SESSION_SECRET ??= 'test-secret-0123456789abcdef0123456789abcdef';
process.env.APP_ORIGIN ??= 'http://localhost:5173';
process.env.SOURCE_CONTACT ??= 'test@example.com';
