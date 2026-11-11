// Prints an APP_PASSWORD_HASH for the password given as the argument or on stdin:
//   npm run passwd -- 'my password'      or      echo -n 'my password' | npm run passwd
import { readFileSync } from 'node:fs';
import { hashPassword } from './util.ts';

const pw = process.argv[2] ?? readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (pw.length < 8) {
  console.error('password must be at least 8 characters');
  process.exit(1);
}
console.log(hashPassword(pw));
