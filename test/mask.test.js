// N8: obvious secrets are hidden before anything leaves the computer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mask } from '../src/mask.js'

// Every token below is fake. Prefixes are glued at run time so secret scanners do not flag the fixtures.
const P = { gh: 'gh' + 'p_', ghpat: 'github' + '_pat_', aws: 'AK' + 'IA', stripe: 'sk' + '_live_', slack: 'xo' + 'xb-' }

const hidden = (input, secret) => {
  const out = mask(input)
  assert.ok(!out.includes(secret), `"${secret}" still visible in: ${out}`)
  return out
}

test('N8: provider tokens keep the prefix, lose the value', () => {
  assert.equal(hidden('export OPENAI_API_KEY=sk-proj-abcdEFGH1234567890xyz', 'abcdEFGH1234567890xyz').includes('***'), true)
  hidden('curl -H "x-api-key: sk-ant-api03-AAAAbbbbCCCCdddd1234"', 'AAAAbbbbCCCCdddd1234')
  hidden(`git remote add o https://${P.gh}0123456789abcdefABCDEF0123456789abcd@github.com/x/y`, '0123456789abcdefABCDEF0123456789abcd')
  hidden(`token ${P.ghpat}11ABCDEFG0123456789_abcdefghijkl`, '11ABCDEFG0123456789_abcdefghijkl')
  hidden(`aws configure set aws_access_key_id ${P.aws}IOSFODNN7EXAMPLE`, 'IOSFODNN7EXAMPLE')
  hidden(`stripe ${P.stripe}00FakeKeyForTests1234`, '00FakeKeyForTests1234')
  hidden(`slack ${P.slack}1234-5678-abcdefghij`, '1234-5678-abcdefghij')
  hidden('key AIzaSyA1234567890abcdefghijklmnopqrstu', 'SyA1234567890abcdefghijklmnopqrstu')
})

test('N8: Authorization headers and JWTs', () => {
  hidden('curl -H "Authorization: Bearer abc.def.ghi-123456"', 'abc.def.ghi-123456')
  hidden('Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA==')
  hidden('t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV')
})

test('N8: password=, key: value, --password value, URL credentials, private keys', () => {
  hidden('mysql -u root password=hunter2', 'hunter2')
  hidden('PGPASSWORD=s3cr3t psql', 's3cr3t')
  hidden('{"api_key": "abc123xyz"}', 'abc123xyz')
  hidden('client_secret: Zx9_kk2-77', 'Zx9_kk2-77')
  hidden('mytool --password Pa55word! --user x', 'Pa55word!')
  hidden('mongodb+srv://app_user:N0tARealPass@cluster.example.net/db', 'N0tARealPass')
  hidden('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow')
})

test('N8: ordinary prose and commands stay readable', () => {
  for (const s of [
    'npm run test:e2e',
    'Fixed the auth flow and the token refresh',
    'git push origin main',
    'Enter your password to continue',
    'node -e "require(\'fs\').writeFileSync(\'a.txt\',\'1\')"',
  ]) assert.equal(mask(s), s)
})
