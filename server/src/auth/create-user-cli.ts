/**
 * Creates (or resets the password of) an editor account.
 * Usage: npm run create-user -w server -- editor@example.com "Display Name"
 * The password is read from the RADAR_PASSWORD environment variable or prompted on stdin.
 */
import { createInterface } from 'node:readline/promises';
import { db, closeDb } from '../db/pool.js';
import { hashPassword } from './password.js';

const [email, displayName = 'Editor'] = process.argv.slice(2);
if (!email) {
  console.error('Usage: create-user <email> [display name]');
  process.exit(1);
}
let password = process.env.RADAR_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (min 12 chars): ');
  rl.close();
}
if (!password || password.length < 12) {
  console.error('Password must be at least 12 characters');
  process.exit(1);
}
await db().query(
  `INSERT INTO users(email, display_name, password_hash, role) VALUES ($1, $2, $3, 'admin')
   ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name`,
  [email.toLowerCase(), displayName, await hashPassword(password)],
);
console.log(`User ${email} is ready.`);
await closeDb();
