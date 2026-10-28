import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import transport from '../desktop/native-http.cjs';

// Synthetic test-only identity; it grants no access to any real notebook or service.
const key = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDLJB1mPfDLEbDt\n7Zp2uPquEq+TtEO4VDVj9wdTBQiC9J2tSufWZvJDLf7OYeTqWfpINPPSt1ggpfrE\np5eK+TFHNFN4z2owrY6mk1saR0NsQt/2zeGY1pFozkXxL5k9WH4w2uwzS8BhMuOT\nuFkv9Mn2blbpI0h+OnSGJ9zTWuNRBYcjn8orfATHfI4vS5c8fbS9F/50P39ojGJk\nWE9wA0RPUXEIFvok8LbKzArb9i37Us/P5NCF4vbmT66cf7p0Rxv9t65bliUMb07F\ng+p6l77eF0WecDA+AxhQHU9YiNFExRLKLVUNjE/2dsALRLwKSUIMxBnPcHA4emKh\nk2uV8WQ5AgMBAAECggEAWCyEYFEpeBNlP1kfb0HqeW1d7ZhUvqk6hXn/oV7xa1o/\nKK13RR5pMJTB4ZYnVTuaAgaOANwZMg6pcvulsSpp49TIGIu7NYbYAOC8LgNZth+u\n9AM4VW1pL1s9i6tT8gc7uvwDg15xkh8THhbqC4FOupr5OXfZqwS3eFXMKadtPMiJ\n//fmqjfY2DvgCa0eNmbwPlvE3QiihuBwsrWBjnCsRWqkRJ6TzqVaH/WcouPdGX09\nZb1y6hz3ME9YVnsg58pKlDu39nEIZzhRzqgNtP7JiN9on+Mrauj71+gTNBdSK5I3\n69qLZclziWoXBC4gCvn8RfeKcdxnbVi5Wkj3DF7y0wKBgQDk9lZfrdYm1jpGTDFD\n6dWf/ybCn+YM/zfm8/0ni4gRf9/T/Ya/FXGMxAmguE19PPUGghdZnDHT2uK0vkd5\n/kQqUFIjb314CdlWaZ127+W8bmr7UJe+SsLQ6GQM/bS6LMKdd2qY7RwvQLDnKixi\nuV9WPcuNTbvmo0/bN4K0DdV0BwKBgQDjITAj3gozPM507ITto5hpbqKsAO/LRDQX\nxQ5d0lPWgfgcj0hfHnF299GBcpVPdkPXnPG7AYFbTA3g6z359feMLGbb+4IASIbZ\n2xycU45vUDv6d9s21AiB9wVjYYPIO8PYa0HZMjVlJZWI6Ju5UNLRStXKJzDtqF6P\nuHuXFyrVvwKBgGrphAeFWrwjyG5O4ao+pBvjvquekoN7IRVc1NcEVnMlbNTGS4cq\nci0y1PQRW02hiyCQ2mpjfvjX+og/WYzjZ90CSHh3dPT6VFv/USHaf0HvpVDYnyKi\nMjnuadmPFjbg87cnrcTe4wxFftVSYgtvV88jZ8sBgz39ACryzrtYwlU9AoGBAJRW\nboxeTacdBXGTr1VMzRO+r/tKOVI13xfPGQzpetvT0mlEou2MgmpCe8/hN+bHxJMi\n6zVJTGSGDWJiAP4pSF2B+kOdxU/ODlRmKA9o+tN0QVfZw4/RdyT6YciAPYMelU/Y\n7Q6fHgRLQZhC4sFrKeSKzYnTgr8UgX237O/Gr7EdAoGBAJOfcOfSR3hhaxRO86Z+\nJhS0lf3ScftaHtfIdVDxuSKmcwhhplN+fMaHjdcdCTlJo92H8O9UCcpzXMErIXhI\nzGARThlxPYECfc6LB+d+w+fKXRo+kXMqpLea86pwIbVUDC+O5C5/CEi51u0Y9sIq\nSgmRx3pbnRPhPaMO7qYkXJOz\n-----END PRIVATE KEY-----\n";
const cert = "-----BEGIN CERTIFICATE-----\nMIIDJzCCAg+gAwIBAgIUBNJc0jGYOBBF1NJuI3w1YH4rc44wDQYJKoZIhvcNAQEL\nBQAwIjEgMB4GA1UEAwwXc3ludGhldGljLW5vdGVtYXJrLXRlc3QwIBcNMjYxMDE5\nMDkxNzQ3WhgPMjEyNjA5MjUwOTE3NDdaMCIxIDAeBgNVBAMMF3N5bnRoZXRpYy1u\nb3RlbWFyay10ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyyQd\nZj3wyxGw7e2adrj6rhKvk7RDuFQ1Y/cHUwUIgvSdrUrn1mbyQy3+zmHk6ln6SDTz\n0rdYIKX6xKeXivkxRzRTeM9qMK2OppNbGkdDbELf9s3hmNaRaM5F8S+ZPVh+MNrs\nM0vAYTLjk7hZL/TJ9m5W6SNIfjp0hifc01rjUQWHI5/KK3wEx3yOL0uXPH20vRf+\ndD9/aIxiZFhPcANET1FxCBb6JPC2yswK2/Yt+1LPz+TQheL25k+unH+6dEcb/beu\nW5YlDG9OxYPqepe+3hdFnnAwPgMYUB1PWIjRRMUSyi1VDYxP9nbAC0S8CklCDMQZ\nz3BwOHpioZNrlfFkOQIDAQABo1MwUTAdBgNVHQ4EFgQUNTysSM9dIIyx9dgpmTMT\n2D0OUlcwHwYDVR0jBBgwFoAUNTysSM9dIIyx9dgpmTMT2D0OUlcwDwYDVR0TAQH/\nBAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAV7FqbxA9hgzlF/midZXDCj71vGeO\nnv4XXHKeAJ4Z2QvQA8PuRKn4qi5lWLqy5B3/LaK5o/VK0YZH79U+MTxqyrGzKTas\n8TdrLSJjsUYWhtbHjq9f1gPELrkA/XDXBtlqaghLh1RXJq/nQ8R1dpAwY+cz/yFN\nIM6jc2BV0KsrEqPtiYlKmE74Fb3gnTTT6tRWYDdAVCTDdHvtrTNjTUqGYqJ0Qd7w\n6FUOyFauAprIARjTep70396CG6uXMyh+0VqNR/mQAEoRqUtjbX/uhuVzgMj/jzpv\nhaL6hAiMX4mhSGMIC2hitpaejbtqF/moMX0yUD+vVc6e0syifMTp/82Wzg==\n-----END CERTIFICATE-----\n";
const raw = new X509Certificate(cert).raw;
const fingerprint = createHash('sha256').update(raw).digest('hex');
const token = Buffer.alloc(32, 7).toString('base64url');
const vault = 'abcdef01-2345-6789-abcd-0123456789ab';
const note = '12345678-1234-5678-abcd-0123456789ab';
const { request, validate, privateHost, verifyPinnedCertificate, MAX_BODY, MAX_RESPONSE } = transport;
async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `${server instanceof https.Server ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}

test('desktop transport accepts only structured bounded NoteMark API operations', () => {
  for (const host of ['localhost', '127.0.0.1', '10.2.3.4', '192.168.1.4', '172.16.0.1', '172.31.255.255', '[::1]']) assert.equal(privateHost(host), true);
  for (const host of ['192.168.1.999', '172.32.0.1', '10.evil.com', 'example.com', '127.1', '2130706433', '010.200.1.1']) assert.equal(privateHost(host), false);
  assert.ok(validate({ url: 'https://notes.example.com/sync/api/health', method: 'GET' }));
  assert.ok(validate({ url: `http://127.0.0.1/api/vaults/${vault}/notes/${note}`, method: 'PUT', body: '{}' }));
  for (const url of ['http://example.com/api/health', 'file:///api/health', 'https://u:p@example.com/api/health', 'http://127.0.0.1/api/health?', 'http://127.0.0.1/api/health#', 'http://127.0.0.1/api/../api/health', 'http://127.0.0.1/api/%2e%2e/api/health', 'http://127.1/api/health', 'http://010.200.1.1/api/health', 'http://localhost/private', 'http://localhost\\@example.com/api/health'])
    assert.throws(() => validate({ url, method: 'GET' }), undefined, url);
  for (const args of [{ method: 'DELETE' }, { method: 'POST' }, { token: 'bad\r\nHeader: value' }, { token: null }, { body: 'x' }, { body: '😀'.repeat(MAX_BODY / 4 + 1) }, { fingerprint: null }, { fingerprint: 'f'.repeat(64) }])
    assert.throws(() => validate({ url: 'http://localhost/api/health', method: 'GET', ...args }));
  assert.throws(() => validate({ url: 'https://example.com/api/health', method: 'GET', fingerprint }));
  assert.throws(() => validate({ url: 'https://127.0.0.1/api/health', method: 'GET', fingerprint: 'f'.repeat(63) }));
});

test('desktop transport forwards controlled JSON headers and preserves HTTP status', async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }); res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  const address = await listen(t, server);
  assert.deepEqual(await request({ url: address + '/api/vaults', method: 'POST', token, body: '{"id":"synthetic"}', headers: { Cookie: 'ignored', Authorization: 'ignored' } }), { status: 201, data: { ok: true } });
  assert.equal(seen[0].headers.authorization, 'Bearer ' + token);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].body, '{"id":"synthetic"}');
});

test('desktop transport rejects redirects, oversized replies and non-object JSON', async t => {
  let mode = 'redirect';
  const server = http.createServer((_req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://example.com/api/health' }); res.end(); }
    else if (mode === 'size') { res.writeHead(200, { 'Content-Length': String(MAX_RESPONSE + 1) }); res.end('{}'); }
    else { res.end(mode); }
  });
  const address = await listen(t, server), args = { url: address + '/api/health', method: 'GET' };
  await assert.rejects(request(args), /redirects/);
  mode = 'size'; await assert.rejects(request(args), /too large/);
  for (mode of ['not-json', 'null', '[]']) await assert.rejects(request(args), /not a NoteMark sync server/);
});

test('pinned local HTTPS verifies the exact leaf before sending credentials and never relaxes other TLS requests', async t => {
  const received = [];
  const server = https.createServer({ key, cert }, (req, res) => { received.push(req.headers.authorization); req.resume(); req.on('end', () => res.end('{"ok":true,"protocol":1}')); });
  const address = await listen(t, server);
  const args = { url: address + '/api/vaults', method: 'POST', token, body: '{"encrypted":"synthetic"}' };
  await assert.rejects(request(args));
  await assert.rejects(request({ ...args, fingerprint: '0'.repeat(64) }), /certificate changed/);
  assert.equal(received.length, 0, 'HTTP credentials/body must wait for the pin check');
  assert.deepEqual(await request({ ...args, fingerprint: fingerprint.toUpperCase() }), { status: 200, data: { ok: true, protocol: 1 } });
  assert.deepEqual(received, ['Bearer ' + token]);
  await assert.rejects(request(args));
  await assert.rejects(request({ ...args, fingerprint: '1'.repeat(64) }), /certificate changed/);
  assert.equal(received.length, 1);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

test('pinned certificates require valid dates as well as a matching SHA256', () => {
  const leaf = new X509Certificate(cert);
  verifyPinnedCertificate(raw, fingerprint, Date.parse(leaf.validFrom) + 1000);
  assert.throws(() => verifyPinnedCertificate(raw, fingerprint, Date.parse(leaf.validFrom) - 1), /not valid yet/);
  assert.throws(() => verifyPinnedCertificate(raw, fingerprint, Date.parse(leaf.validTo) + 1), /expired/);
  assert.throws(() => verifyPinnedCertificate(raw, 'f'.repeat(64)), /certificate changed/);
});
